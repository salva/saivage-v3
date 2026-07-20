import { EventBus, type Subscription, type SubscriptionOptions } from '../../events/index.js';
import { cardRecordSchema, type CardNotification, type CardRecord, type RuntimeState, type RuntimeStatus } from '../../schemas/index.js';
import { PROJECT_CARD_ID } from '../../cards/project-card.js';
import { acceptsCardNotifications, canCancelCardStatus } from '../../cards/status-api.js';
import { CardActor, type CardActorDeps, type CardCancellationResult } from './card-actor.js';
import { toPublicCardActorState } from '../../schemas/actor-vocabulary.js';
import type { ExecutingLlmSnapshot } from './executing-llm-snapshot.js';
import type { ActorRuntimeReadModel } from '../../application/read-models/actor-runtime-read-model.js';
import type { RuntimeControlMechanics, RuntimeLaunchPlan } from '../../application/runtime-control-service.js';
import type { NotifyCardResult, StartProjectResult, StopProjectResult } from '../runtime-api.js';
import { RuntimeGate } from '../runtime-gate.js';
import { ActiveCardLeaf } from '../active-card-leaf.js';
import { selectLinkedRunningChain } from '../running-card-chain.js';
import type { LLMProviderPort, CompactorPort } from './llm-actor.js';
import type { AutonomousCompactionPolicy } from './compaction/compactor.js';
import type { SummarizerProviderPort } from './compaction/summarizer.js';
import type { CardService } from '../../cards/card-service.js';
import type { RuntimeInterventionBinding } from '../../application/intervention-readiness.js';
import type { ProcessRunner } from '../process-runner.js';
import type { PromptTemplateRegistry } from '../../utils/prompt-api.js';
import type { ConversationFileContext } from '../../persistence/conversation-file.js';
import type { AppLogContext } from '../../persistence/app-log.js';
import type { ReadModelChanges } from '../../application/read-model-changes.js';
import type { McpToolInvocationPort } from '../../mcp/mcp-manager.js';
import { RuntimeContainmentError, RuntimeStoppedInterruption, isRuntimeStoppedInterruption, type RuntimeStopOperation } from './runtime-stopped-interruption.js';
import type { RuntimeProcessIdentity } from '../lock.js';
import { cardProcessEntryForStatus, type CompiledCardProcesses, type CardProcessEntry } from '../card-process/card-process-config.js';
import type { ProcessPromptRegistry } from '../card-process/process-prompt-registry.js';
import { stabilizeRoleSession } from './conversation-recovery.js';
import { TERMINAL_RESULT_TOOL_NAME } from '../../contracts/result-envelope.js';
import { executorActorId, plannerActorId, reviewerActorId } from './ids.js';
import type { ProcessRole } from '../card-process/card-process-config.js';

export interface ProjectRootCardReader { read(cardId: string): { id: string; type: string } | null }

export interface SupervisorRuntimeApiOptions {
  projectRoot: string; eventBus?: EventBus; now?: () => string; rootCards?: ProjectRootCardReader;
  actorStore: CardService; interventionBinding: RuntimeInterventionBinding; provider: LLMProviderPort;
  conversations: ConversationFileContext; appLogs: AppLogContext; readModelChanges: ReadModelChanges;
  compactor: CompactorPort; compactionConfig: AutonomousCompactionPolicy; summarizerProvider: SummarizerProviderPort;
  processRunner: ProcessRunner; promptTemplates: PromptTemplateRegistry;
  cardProcesses: CompiledCardProcesses; processPrompts: ProcessPromptRegistry;
  runtimeGate?: RuntimeGate; mcpToolInvocation: McpToolInvocationPort;
  processIdentity: RuntimeProcessIdentity;
}

interface SupervisorLaunchPlan extends RuntimeLaunchPlan { readonly root: CardRecord; readonly entry: CardProcessEntry; readonly alreadyStabilizedRoles: ReadonlySet<ProcessRole> }

export class SupervisorRuntimeApi implements RuntimeControlMechanics {
  private readonly eventBus: EventBus;
  private readonly now: () => string;
  private readonly runtimeGate: RuntimeGate;
  private readonly cardActors = new Map<string, CardActor>();
  private readonly liveCardActors = new Map<string, CardActor>();
  private readonly currentness: ActiveCardLeaf;
  private started = false;
  private status: RuntimeStatus = 'stopped';
  private preparedLaunch: SupervisorLaunchPlan | null = null;
  private runIdentity: object | null = null;
  private stopSettlement: Promise<StopProjectResult> | null = null;
  private closingInterruption: RuntimeStoppedInterruption | null = null;

  constructor(private readonly options: SupervisorRuntimeApiOptions) {
    this.eventBus = options.eventBus ?? new EventBus();
    this.now = options.now ?? (() => new Date().toISOString());
    this.runtimeGate = options.runtimeGate ?? new RuntimeGate();
    this.currentness = new ActiveCardLeaf(() => this.runtimeProjectionChanged());
  }

  async start(): Promise<void> {
    if (this.started) return;
    const root = this.options.actorStore.read(PROJECT_CARD_ID);
    if (!root) throw new Error(`Root card record '${PROJECT_CARD_ID}' is missing.`);
    cardRecordSchema.parse(root);
    this.runtimeGate.close();
    this.started = true;
    this.status = 'stopped';
    this.options.interventionBinding.markStoppedReady();
  }

  closeApplicationAdmission(): void {
    this.runtimeGate.close();
    for (const actor of this.liveCardActors.values()) actor.closeForApplicationStop();
  }

  async cleanupForApplicationStop(): Promise<void> {
    this.closeApplicationAdmission();
    let termination: Promise<import('../process-runner.js').ProcessStopReport>;
    try { termination = this.options.processRunner.terminateOwnedRoot('runtime', this.options.processRunner.runtimeRootScope, 'application stopping'); }
    catch (error) { termination = Promise.reject(error); }
    const joins = [...this.liveCardActors.values()].map((actor) => actor.joinForApplicationStop());
    const settlements = await Promise.allSettled([termination, ...joins]);
    const terminationSettlement = settlements[0]!;
    if (terminationSettlement.status === 'rejected') throw terminationSettlement.reason;
    if (settlements.some((settlement) => settlement.status === 'rejected') || terminationSettlement.value.failed.length !== 0) throw new Error('Runtime application cleanup failed.');
  }

  stopProject(): Promise<StopProjectResult> {
    if (this.status === 'stopped') return Promise.resolve({ status: 'stopped', contained: false });
    if (this.status === 'closing') return Promise.reject(new RuntimeControlConflictError());
    const identity = this.runIdentity;
    if (!identity) return Promise.reject(new Error(`Installed runtime in '${this.status}' has no instance identity.`));
    this.status = 'closing';
    this.runtimeGate.close();
    this.options.interventionBinding.markNotReady();
    const interruption = new RuntimeStoppedInterruption();
    this.closingInterruption = interruption;
    this.runtimeProjectionChanged();
    const failures: Array<{ component: string }> = [];
    const operation: RuntimeStopOperation = {
      interruption,
      reportContainmentFailure: (component) => { failures.push({ component }); },
    };
    const owners = [...this.liveCardActors.values()];
    const ownerIds = new Set(owners.map((owner) => owner.cardId));
    if (ownerIds.size !== owners.length) throw new Error('Runtime owner map contains duplicate card ownership.');
    const ownerSettlements = owners.map((owner) => owner.stop(operation));
    let processSettlement: Promise<void>;
    try {
      processSettlement = this.options.processRunner.terminateScopeTree({ rootScope: this.options.processRunner.runtimeRootScope, categories: ['runtime_card'], reason: 'runtime stop', graceMs: 5000 }).then((report) => {
        if (report.failed.length !== 0) operation.reportContainmentFailure('runtime-process-scope', report);
      }, (error) => { operation.reportContainmentFailure('runtime-process-scope', error); });
    } catch (error) {
      operation.reportContainmentFailure('runtime-process-scope', error);
      processSettlement = Promise.resolve();
    }
    const settlement = (async (): Promise<StopProjectResult> => {
      const joined = await Promise.allSettled([...ownerSettlements, processSettlement]);
      joined.forEach((result, index) => { if (result.status === 'rejected') operation.reportContainmentFailure(index < owners.length ? `card:${owners[index]!.cardId}` : 'runtime-process-scope', result.reason); });
      if (this.runIdentity !== identity) throw new Error('Runtime identity changed during project stop.');
      if (failures.length !== 0) throw new RuntimeContainmentError(failures);
      this.runIdentity = null;
      this.liveCardActors.clear();
      this.cardActors.clear();
      this.status = 'stopped';
      this.options.interventionBinding.markStoppedReady();
      this.currentness.clear();
      return { status: 'stopped', contained: true };
    })();
    const tracked = settlement.finally(() => { if (this.stopSettlement === tracked) this.stopSettlement = null; });
    this.stopSettlement = tracked;
    return tracked;
  }

  async beginStartProject(): Promise<{ accepted: false; result: StartProjectResult } | { accepted: true; launch: RuntimeLaunchPlan }> {
    await this.start();
    if (this.status !== 'stopped') return { accepted: false, result: { runtime: this.runtimeState(), status: this.status, started: false, stopped: false, error: `Cannot start runtime from '${this.status}'.` } };
    let chain = selectLinkedRunningChain(this.options.actorStore);
    let entry: CardProcessEntry = 'STOPPED';
    let alreadyStabilizedRoles: ReadonlySet<ProcessRole> = new Set();
    if (chain.length > 0) {
      const recoveryChain = chain;
      for (const card of [...recoveryChain].reverse()) {
        for (const role of eligibleRoles(card)) {
          stabilizeRoleSession({ projectRoot: this.options.projectRoot, sessionId: sessionForRecovery(role, card.id), conversations: this.options.conversations, terminalToolNames: new Set([TERMINAL_RESULT_TOOL_NAME]) });
        }
      }
      for (const card of [...recoveryChain].reverse()) this.options.actorStore.stopRunningForRecovery(card.id);
      alreadyStabilizedRoles = new Set(eligibleRoles(recoveryChain[0]!));
      this.options.actorStore.activateStopped(recoveryChain[0]!.id);
      chain = selectLinkedRunningChain(this.options.actorStore);
    } else {
      const root = this.options.actorStore.read(PROJECT_CARD_ID);
      if (!root) throw new Error(`Root card record '${PROJECT_CARD_ID}' is missing.`);
      const freshEntry = cardProcessEntryForStatus(root.lifecycle.status);
      if (freshEntry === null) throw new Error(`Project card in status '${root.lifecycle.status}' cannot start.`);
      entry = freshEntry;
      if (root.lifecycle.status === 'stopped') this.options.actorStore.activateStopped(PROJECT_CARD_ID); else this.options.actorStore.setStatus(PROJECT_CARD_ID, 'running');
      chain = selectLinkedRunningChain(this.options.actorStore);
    }
    const root = requireProjectOnlyLaunchChain(chain, 'Runtime preparation');
    const launch = Object.freeze({ root, entry, alreadyStabilizedRoles }) as unknown as SupervisorLaunchPlan;
    this.preparedLaunch = launch;
    return { accepted: true, launch };
  }

  launchStartedProject(launch: RuntimeLaunchPlan): RuntimeState {
    const prepared = this.preparedLaunch;
    if (!prepared || launch !== prepared) throw new Error('Runtime launch plan is foreign, stale, or already consumed.');
    this.preparedLaunch = null;
    const chain = selectLinkedRunningChain(this.options.actorStore);
    const root = requireProjectOnlyLaunchChain(chain, 'Prepared runtime launch');
    if (root.id !== prepared.root.id) throw new Error('Prepared runtime root changed before launch.');
    const installed = this.installProjectRoot(root, prepared.entry, prepared.alreadyStabilizedRoles);
    const identity = {};
    this.runIdentity = identity;
    this.status = 'running';
    this.runtimeGate.open();
    this.options.interventionBinding.markNotReady();
    this.currentness.setChain([PROJECT_CARD_ID]);
    void installed.rootSettlement.then(() => this.completeNaturalRoot(identity), (error) => this.handleRootRejection(identity, error));
    installed.root.startPreparedRootProcessor();
    const state = this.runtimeState();
    if (!state) throw new Error('Runtime launch completed without an authoritative state projection.');
    return state;
  }

  beginPause(): { settled: boolean } {
    if (this.status !== 'running') throw new Error(`Cannot pause runtime from '${this.status}'.`);
    this.status = 'pausing';
    this.runtimeGate.requestPause(() => {
      if (this.status !== 'pausing') return;
      this.status = 'paused';
      this.options.interventionBinding.markPausedReady();
      this.runtimeProjectionChanged();
    });
    if (this.status === 'pausing') this.runtimeProjectionChanged();
    return { settled: this.runtimeGate.isParked };
  }

  beginResume(): void {
    if (this.status !== 'paused') throw new Error(`Cannot resume runtime from '${this.status}'.`);
    this.status = 'running';
  }
  finishResume(): void { this.runtimeGate.open(); this.options.interventionBinding.markNotReady(); this.runtimeProjectionChanged(); }

  notifyCard(cardId: string, notification: CardNotification): NotifyCardResult {
    const card = this.options.actorStore.read(cardId);
    if (!card) return { ok: false, reason: 'missing_card', cardId };
    if (!acceptsCardNotifications(card.lifecycle.status)) return { ok: false, reason: 'terminal_card', cardId, status: card.lifecycle.status as 'done' | 'failed' | 'cancelled' };
    this.options.actorStore.enqueueNotification(cardId, notification);
    return { ok: true, notificationId: notification.id };
  }

  async cancelCard(cardId: string, reason: string): Promise<CardCancellationResult> {
    const card = this.options.actorStore.read(cardId);
    if (!card) throw new Error(`Card '${cardId}' not found.`);
    if (!canCancelCardStatus(card.lifecycle.status)) throw new Error(`Card '${cardId}' in status '${card.lifecycle.status}' cannot be cancelled.`);
    const capturedIdentity = this.runIdentity;
    const live = this.liveCardActors.get(cardId);
    if (live) {
      const suffix: CardActor[] = [];
      let owner: CardActor | undefined = live;
      while (owner) {
        suffix.push(owner);
        const childId: string | null = owner.structuralChildId;
        owner = childId === null ? undefined : this.liveCardActors.get(childId);
        if (childId !== null && !owner) throw new Error(`Running card '${childId}' has no live activation owner.`);
      }
      if (suffix.some((actor) => !actor.canClaimCancellation())) {
        const winner = suffix.find((actor) => !actor.canClaimCancellation())!;
        await winner.awaitSettlement();
        if (this.runIdentity !== capturedIdentity || this.status === 'closing') throw this.stopInterruptionForClosedRuntime();
        return this.cancelCard(cardId, reason);
      }
      const cancelReason = { reason, cancelled_at: this.now() };
      for (const actor of suffix) actor.claimCancellation(cancelReason);
      const cancelledIds: string[] = [];
      for (const actor of [...suffix].reverse()) {
        const result = await actor.settleClaimedCancellation();
        cancelledIds.push(...result.cancelled_card_ids.filter((id) => !cancelledIds.includes(id)));
      }
      return { card_id: cardId, status: 'cancelled', cancelled_card_ids: cancelledIds };
    }
    if (card.lifecycle.status === 'running') throw new Error(`Running card '${cardId}' has no live activation owner.`);
    const cancelled: string[] = [];
    await this.cancelNonrunningSubtree(cardId, cancelled);
    return { card_id: cardId, status: 'cancelled', cancelled_card_ids: cancelled };
  }

  private stopInterruptionForClosedRuntime(): RuntimeStoppedInterruption {
    if (!this.closingInterruption) throw new Error('Closed runtime has no Stop interruption identity.');
    return this.closingInterruption;
  }

  subscribe(options: SubscriptionOptions): Subscription { return this.eventBus.subscribe(options); }
  getStatus() { return { status: this.status, currentCardId: this.currentness.activeCardId(), pid: this.options.processIdentity.pid, startedAt: this.options.processIdentity.startedAt }; }
  getRuntimeState(): RuntimeState | null { return this.runtimeState(); }
  getActorRuntimeReadModel(): ActorRuntimeReadModel {
    const cards = [...this.cardActors.values()].flatMap((actor) => { const card = this.options.actorStore.read(actor.cardId); return card ? [{ cardId: actor.cardId, actorState: toPublicCardActorState(card.lifecycle.status), processState: actor.processor?.processPosition() ?? null }] : []; });
    return { pauseMode: this.status === 'running' ? 'running' : this.status === 'paused' ? 'paused' : 'idle', cards };
  }
  captureAutonomousExecutingLlmSnapshots(): readonly ExecutingLlmSnapshot[] {
    return [...this.cardActors.values()].flatMap((actor) => {
      const snapshot = actor.processor?.executingLlmSnapshot() ?? null;
      return snapshot ? [snapshot] : [];
    });
  }

  private runtimeState(): RuntimeState | null {
    const currentCardId = this.currentness.activeCardId();
    if (Boolean(this.runIdentity) !== Boolean(currentCardId)) throw new Error('Runtime identity and active leaf presence disagree.');
    if (!this.runIdentity || !currentCardId) return null;
    return { status: this.status, project_id: 'project', pid: this.options.processIdentity.pid, started_at: this.options.processIdentity.startedAt, current_card_id: currentCardId, updated_at: this.now() };
  }
  private installProjectRoot(rootCard: CardRecord, entry: CardProcessEntry, alreadyStabilizedRoles: ReadonlySet<ProcessRole>): { readonly rootSettlement: Promise<unknown>; readonly root: CardActor } {
    if (rootCard.id !== PROJECT_CARD_ID || rootCard.type !== 'project' || rootCard.lifecycle.status !== 'running') throw new Error('Runtime launch requires the running project root.');
    if (this.cardActors.size !== 0 || this.liveCardActors.size !== 0) throw new Error('Runtime project-root ownership installation requires empty owner maps.');
    const root = CardActor.fromCard({ card: rootCard, deps: this.cardActorDeps(), deferProcessorStart: true });
    const rootSettlement = root.prepareRootRunning(entry, alreadyStabilizedRoles);
    if ([...this.cardActors].length !== 1 || this.cardActors.get(PROJECT_CARD_ID) !== root || [...this.liveCardActors].length !== 1 || this.liveCardActors.get(PROJECT_CARD_ID) !== root) throw new Error('Runtime project-root ownership installation is incomplete.');
    return { rootSettlement, root };
  }
  private completeNaturalRoot(identity: object): void {
    if (this.runIdentity !== identity || this.status === 'closing') return;
    if (this.cardActors.size !== 0 || this.liveCardActors.size !== 0) throw new Error('Natural root settlement retained runtime ownership.');
    const chain = selectLinkedRunningChain(this.options.actorStore);
    if (chain.length !== 0) throw new Error('Natural root settlement retained a durable running chain.');
    this.finishRun(identity);
  }
  private finishRun(identity: object): void { if (this.runIdentity !== identity || this.status === 'closing') return; this.runIdentity = null; this.status = 'stopped'; this.options.interventionBinding.markStoppedReady(); this.currentness.clear(); }
  private handleRootRejection(identity: object, error: unknown): void {
    if (isRuntimeStoppedInterruption(error)) return;
    this.finishRun(identity);
  }
  private releaseSettledActor(actor: CardActor): void {
    if (this.liveCardActors.get(actor.cardId) !== actor || this.cardActors.get(actor.cardId) !== actor) throw new Error(`Card '${actor.cardId}' settled actor ownership changed unexpectedly.`);
    this.liveCardActors.delete(actor.cardId);
    this.cardActors.delete(actor.cardId);
    this.runtimeProjectionChanged();
  }
  private cardActorDeps(): CardActorDeps { return { projectRoot: this.options.projectRoot, storeForCard: () => this.options.actorStore, currentness: this.currentness, provider: this.options.provider, compactor: this.options.compactor, compactionConfig: this.options.compactionConfig, summarizerProvider: this.options.summarizerProvider, gate: this.runtimeGate, processRunner: this.options.processRunner, promptTemplates: this.options.promptTemplates, cardProcesses: this.options.cardProcesses, processPrompts: this.options.processPrompts, mcpToolInvocation: this.options.mcpToolInvocation, notifyCard: (cardId, notification) => this.notifyCard(cardId, notification), cancelCard: (cardId, reason) => this.cancelCard(cardId, reason), lookup: this.cardActors, liveLookup: this.liveCardActors, runtimeProjectionChanged: () => this.runtimeProjectionChanged(), releaseSettledActor: (actor) => this.releaseSettledActor(actor), conversations: this.options.conversations, appLogs: this.options.appLogs, isRuntimeClosing: () => this.status === 'closing' }; }

  private runtimeProjectionChanged(): void { this.options.readModelChanges.runtimeChanged(); this.options.readModelChanges.agentsChanged(); }

  private async cancelNonrunningSubtree(cardId: string, cancelled: string[]): Promise<void> {
    const card = this.options.actorStore.read(cardId);
    if (!card || !canCancelCardStatus(card.lifecycle.status)) return;
    const live = this.liveCardActors.get(cardId);
    if (live) { const result = await live.cancel({ reason: 'ancestor cancelled', cancelled_at: this.now() }); cancelled.push(...result.cancelled_card_ids); return; }
    if (card.lifecycle.status === 'running') throw new Error(`Running card '${cardId}' has no live activation owner.`);
    for (const childId of this.options.actorStore.listChildren(cardId)) await this.cancelNonrunningSubtree(childId, cancelled);
    this.options.actorStore.setStatus(cardId, 'cancelled');
    cancelled.push(cardId);
  }
}

export function createSupervisorRuntimeApi(options: SupervisorRuntimeApiOptions): RuntimeControlMechanics { return new SupervisorRuntimeApi(options); }

export class RuntimeControlConflictError extends Error {
  readonly code = 'runtime_control_conflict';
  constructor(message = 'Runtime control conflicts with an in-flight project stop.') { super(message); }
}

function eligibleRoles(card: CardRecord): readonly ProcessRole[] {
  return card.type === 'project' || card.type === 'goal' ? ['planner', 'reviewer'] : ['executor'];
}

function sessionForRecovery(role: ProcessRole, cardId: string) {
  return role === 'planner' ? plannerActorId(cardId) : role === 'reviewer' ? reviewerActorId(cardId) : executorActorId(cardId);
}

function requireProjectOnlyLaunchChain(chain: readonly CardRecord[], context: string): CardRecord {
  if (chain.length !== 1) throw new Error(`${context} did not produce exactly one running project card.`);
  const root = chain[0]!;
  if (root.id !== PROJECT_CARD_ID || root.type !== 'project' || root.lifecycle.status !== 'running') throw new Error(`${context} did not produce exactly one running project card.`);
  return root;
}
