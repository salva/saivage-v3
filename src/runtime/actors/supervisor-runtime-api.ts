import { EventBus, type Subscription, type SubscriptionOptions } from '../../events/index.js';
import { cardRecordSchema, type CardNotification, type CardRecord, type RuntimeState, type RuntimeStatus } from '../../schemas/index.js';
import { PROJECT_CARD_ID } from '../../cards/project-card.js';
import { CardActor, type CardActorDeps, type CardCancellationResult } from './card-actor.js';
import { BaseMainLLMCardProcessorActor } from './base-main-llm-card-processor-actor.js';
import { parseLlmActorId } from './ids.js';
import { toPublicAgentPhase, toPublicCardActorState } from '../../schemas/actor-vocabulary.js';
import type { ActorRuntimeReadModel } from '../../application/read-models/actor-runtime-read-model.js';
import type { RuntimeControlMechanics } from '../../application/runtime-control-service.js';
import type { NotifyCardResult, RuntimeCommandSource, StartProjectResult, StopProjectResult } from '../runtime-api.js';
import { RuntimeGate } from '../runtime-gate.js';
import { ActiveCardLeaf } from '../active-card-leaf.js';
import { selectRunningCardChain } from '../running-card-chain.js';
import { createConversationChangePublisher } from './conversation-publisher.js';
import type { LLMProviderPort, CompactorPort } from './llm-actor.js';
import type { CompactionConfig } from './compaction/compactor.js';
import type { CardService } from '../../cards/card-service.js';
import type { RuntimeInterventionBinding } from '../../application/intervention-readiness.js';
import type { ProcessRunner } from '../process-runner.js';
import type { PromptTemplateRegistry } from '../../utils/prompt-api.js';
import type { ConversationFileContext } from '../../persistence/conversation-file.js';
import type { AppLogContext } from '../../persistence/app-log.js';
import type { ReadModelChanges } from '../../application/read-model-changes.js';
import type { McpToolInvocationPort } from '../../mcp/mcp-manager.js';
import { RuntimeContainmentError, RuntimeStoppedInterruption, isRuntimeStoppedInterruption, type RuntimeStopOperation } from './runtime-stopped-interruption.js';

export interface ProjectRootCardReader { read(cardId: string): { id: string; type: string } | null }

export interface SupervisorRuntimeApiOptions {
  projectRoot: string; eventBus?: EventBus; now?: () => string; rootCards?: ProjectRootCardReader;
  actorStore: CardService; interventionBinding: RuntimeInterventionBinding; provider: LLMProviderPort;
  conversations: ConversationFileContext; appLogs: AppLogContext; readModelChanges: ReadModelChanges;
  compactor?: CompactorPort; compactionConfig?: CompactionConfig; summarizerProvider?: LLMProviderPort;
  processRunner: ProcessRunner; promptTemplates: PromptTemplateRegistry;
  runtimeGate?: RuntimeGate; mcpManagerProvider?: () => McpToolInvocationPort | undefined;
}

export class SupervisorRuntimeApi implements RuntimeControlMechanics {
  private readonly eventBus: EventBus;
  private readonly now: () => string;
  private readonly runtimeGate: RuntimeGate;
  private readonly cardActors = new Map<string, CardActor>();
  private readonly liveCardActors = new Map<string, CardActor>();
  private readonly currentness = new ActiveCardLeaf();
  private started = false;
  private status: RuntimeStatus = 'stopped';
  private currentCardId: string | null = null;
  private preparedLeaf: CardRecord | null = null;
  private runIdentity: object | null = null;
  private stopSettlement: Promise<StopProjectResult> | null = null;
  private closingInterruption: RuntimeStoppedInterruption | null = null;

  constructor(private readonly options: SupervisorRuntimeApiOptions) {
    this.eventBus = options.eventBus ?? new EventBus();
    this.now = options.now ?? (() => new Date().toISOString());
    this.runtimeGate = options.runtimeGate ?? new RuntimeGate();
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
      this.currentness.clear();
      this.currentCardId = null;
      this.status = 'stopped';
      this.options.interventionBinding.markStoppedReady();
      return { status: 'stopped', contained: true };
    })();
    const tracked = settlement.finally(() => { if (this.stopSettlement === tracked) this.stopSettlement = null; });
    this.stopSettlement = tracked;
    return tracked;
  }

  async beginStartProject(_source: RuntimeCommandSource = 'operator'): Promise<{ accepted: false; result: StartProjectResult } | { accepted: true; state: RuntimeState }> {
    await this.start();
    if (this.status !== 'stopped') return { accepted: false, result: { runtime: this.runtimeState(), status: this.status, started: false, stopped: false, error: `Cannot start runtime from '${this.status}'.` } };
    const chain = selectRunningCardChain(this.options.actorStore.list());
    let leaf = chain.at(-1) ?? this.options.actorStore.read(PROJECT_CARD_ID)!;
    if (chain.length === 0) leaf = this.options.actorStore.setStatus(PROJECT_CARD_ID, 'running');
    this.preparedLeaf = leaf;
    const at = this.now();
    return { accepted: true, state: runtimeState(at, leaf) };
  }

  launchStartedProject(_state: RuntimeState): void {
    const leaf = this.preparedLeaf;
    if (!leaf) throw new Error('Runtime launch has no prepared restart leaf.');
    this.preparedLeaf = null;
    const chain = selectRunningCardChain(this.options.actorStore.list());
    this.currentness.startChain(chain.map((card) => card.id));
    this.currentCardId = leaf.id;
    this.status = 'running';
    this.runtimeGate.open();
    this.options.interventionBinding.markNotReady();
    const identity = {};
    this.runIdentity = identity;
    this.installRunningChain(identity, chain);
  }

  beginPause(): { patch: Partial<RuntimeState>; settled: boolean } {
    if (this.status !== 'running') throw new Error(`Cannot pause runtime from '${this.status}'.`);
    this.status = 'pausing';
    this.runtimeGate.requestPause(() => {
      if (this.status !== 'pausing') return;
      this.status = 'paused';
      this.options.interventionBinding.markPausedReady();
    });
    return { patch: { status: this.runtimeGate.isParked ? 'paused' : 'pausing', updated_at: this.now() }, settled: this.runtimeGate.isParked };
  }

  beginResume(current: RuntimeState): RuntimeState {
    if (this.status !== 'paused') throw new Error(`Cannot resume runtime from '${this.status}'.`);
    this.status = 'running';
    return { ...current, status: 'running', updated_at: this.now() };
  }
  finishResume(): void { this.runtimeGate.open(); this.options.interventionBinding.markNotReady(); }

  notifyCard(cardId: string, notification: CardNotification): NotifyCardResult {
    const card = this.options.actorStore.read(cardId);
    if (!card) return { ok: false, reason: 'missing_card', cardId };
    if (card.status === 'done' || card.status === 'failed' || card.status === 'cancelled') return { ok: false, reason: 'terminal_card', cardId, status: card.status };
    this.options.actorStore.enqueueNotification(cardId, notification);
    return { ok: true, notificationId: notification.id };
  }

  async cancelCard(cardId: string, reason: string): Promise<CardCancellationResult> {
    const card = this.options.actorStore.read(cardId);
    if (!card) throw new Error(`Card '${cardId}' not found.`);
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
    if (card.status === 'running') throw new Error(`Running card '${cardId}' has no live activation owner.`);
    const cancelled: string[] = [];
    await this.cancelNonrunningSubtree(cardId, cancelled);
    return { card_id: cardId, status: 'cancelled', cancelled_card_ids: cancelled };
  }

  private stopInterruptionForClosedRuntime(): RuntimeStoppedInterruption {
    if (!this.closingInterruption) throw new Error('Closed runtime has no Stop interruption identity.');
    return this.closingInterruption;
  }

  subscribe(options: SubscriptionOptions): Subscription { return this.eventBus.subscribe(options); }
  getStatus() { return { status: this.status, currentCardId: this.currentCardId, goalCount: this.currentCardId ? 1 : 0, lastTickAt: null }; }
  getRuntimeState(): RuntimeState | null { return this.runtimeState(); }
  getActorRuntimeReadModel(): ActorRuntimeReadModel {
    const cards = [...this.cardActors.values()].flatMap((actor) => { const card = this.options.actorStore.read(actor.cardId); return card ? [{ cardId: actor.cardId, actorState: toPublicCardActorState(card.status) }] : []; });
    const agents = [...this.cardActors.values()].flatMap((actor) => actor.processor instanceof BaseMainLLMCardProcessorActor ? actor.processor.listLlmActors().map((agent) => { const identity = parseLlmActorId(agent.agentId); return { agentId: agent.agentId, role: identity.role, cardId: identity.cardId, phase: toPublicAgentPhase(agent.state()) }; }) : []);
    return { pauseMode: this.status === 'running' ? 'running' : this.status === 'paused' ? 'paused' : 'idle', activeWork: 'none', cards, agents, diagnostics: [] };
  }

  private runtimeState(): RuntimeState | null { return this.runIdentity && this.currentCardId ? runtimeState(this.now(), this.options.actorStore.read(this.currentCardId)!, this.status) : null; }
  private launchLeaf(identity: object, leaf: CardRecord): void {
    const actor = this.cardActor(leaf.id);
    const caller = leaf.parent === null ? { kind: 'root' as const } : { kind: 'parent' as const, cardId: leaf.parent };
    void actor.restartRunning(caller).then(() => this.continueRunningChain(identity), (error) => { if (isRuntimeStoppedInterruption(error)) return; this.finishRun(identity); });
  }
  private installRunningChain(identity: object, chain: readonly CardRecord[]): void {
    if (chain.length === 0) throw new Error('Runtime launch requires a running chain.');
    const actors = chain.map((card, index) => {
      if (this.cardActors.has(card.id) || this.liveCardActors.has(card.id)) throw new Error(`Card '${card.id}' already has runtime ownership.`);
      return CardActor.fromCard({ card, deps: this.cardActorDeps(), deferRunningRecovery: index < chain.length - 1 });
    });
    const leaf = actors.at(-1)!;
    const leafCard = chain.at(-1)!;
    const leafCaller = leafCard.parent === null ? { kind: 'root' as const } : { kind: 'parent' as const, cardId: leafCard.parent };
    const leafSettlement = leaf.prepareRunning(leafCaller);
    let rootSettlement = leafSettlement;
    for (let index = actors.length - 2; index >= 0; index -= 1) {
      const actor = actors[index]!;
      const card = chain[index]!;
      const caller = card.parent === null ? { kind: 'root' as const } : { kind: 'parent' as const, cardId: card.parent };
      rootSettlement = actor.installStructuralWait(actors[index + 1]!, caller);
    }
    if (this.liveCardActors.size !== chain.length || chain.some((card) => !this.liveCardActors.has(card.id))) throw new Error('Runtime running-chain ownership installation is incomplete.');
    void rootSettlement.then(() => this.continueRunningChain(identity), (error) => { if (isRuntimeStoppedInterruption(error)) return; this.finishRun(identity); });
    leaf.startPreparedProcessor();
  }
  private continueRunningChain(identity: object): void {
    if (this.runIdentity !== identity || this.status === 'closing') return;
    const chain = selectRunningCardChain(this.options.actorStore.list());
    const leaf = chain.at(-1);
    if (!leaf) { this.finishRun(identity); return; }
    this.currentness.clear();
    this.currentness.startChain(chain.map((card) => card.id));
    this.currentCardId = leaf.id;
    this.launchLeaf(identity, leaf);
  }
  private finishRun(identity: object): void { if (this.runIdentity !== identity || this.status === 'closing') return; this.runIdentity = null; this.currentCardId = null; this.currentness.clear(); this.status = 'stopped'; this.options.interventionBinding.markStoppedReady(); }
  private cardActor(cardId: string): CardActor { const existing = this.cardActors.get(cardId); if (existing) return existing; const card = this.options.actorStore.read(cardId); if (!card) throw new Error(`Card '${cardId}' not found.`); return CardActor.fromCard({ card, deps: this.cardActorDeps() }); }
  private releaseSettledActor(actor: CardActor): void {
    if (this.liveCardActors.get(actor.cardId) !== actor || this.cardActors.get(actor.cardId) !== actor) throw new Error(`Card '${actor.cardId}' settled actor ownership changed unexpectedly.`);
    this.liveCardActors.delete(actor.cardId);
    this.cardActors.delete(actor.cardId);
  }
  private cardActorDeps(): CardActorDeps { return { projectRoot: this.options.projectRoot, storeForCard: () => this.options.actorStore.cards(), currentness: this.currentness, provider: this.options.provider, compactor: this.options.compactor, compactionConfig: this.options.compactionConfig, summarizerProvider: this.options.summarizerProvider, gate: this.runtimeGate, processRunner: this.options.processRunner, promptTemplates: this.options.promptTemplates, mcpManagerProvider: this.options.mcpManagerProvider, notifyCard: (cardId, notification) => this.notifyCard(cardId, notification), cancelCard: (cardId, reason) => this.cancelCard(cardId, reason), lookup: this.cardActors, liveLookup: this.liveCardActors, releaseSettledActor: (actor) => this.releaseSettledActor(actor), conversationPublisher: createConversationChangePublisher(this.eventBus), conversations: this.options.conversations, appLogs: this.options.appLogs, isRuntimeClosing: () => this.status === 'closing' }; }

  private async cancelNonrunningSubtree(cardId: string, cancelled: string[]): Promise<void> {
    const card = this.options.actorStore.read(cardId);
    if (!card || card.status === 'done' || card.status === 'cancelled') return;
    const live = this.liveCardActors.get(cardId);
    if (live) { const result = await live.cancel({ reason: 'ancestor cancelled', cancelled_at: this.now() }); cancelled.push(...result.cancelled_card_ids); return; }
    if (card.status === 'running') throw new Error(`Running card '${cardId}' has no live activation owner.`);
    for (const childId of this.options.actorStore.listChildren(cardId)) await this.cancelNonrunningSubtree(childId, cancelled);
    this.options.actorStore.setStatus(cardId, 'cancelled');
    cancelled.push(cardId);
  }
}

function runtimeState(at: string, card: CardRecord, status: RuntimeStatus = 'starting'): RuntimeState { const activeStatus = status === 'error' || status === 'stopped' ? 'starting' : status; return { status, project_id: 'project', pid: process.pid, started_at: at, active_card_run: { card_id: card.id, card_type: card.type, ownership: { kind: 'direct', source: 'project_root' }, runtime_status: activeStatus, phase: card.type === 'project' || card.type === 'goal' ? 'planner' : 'executor', caller_session_id: null, caller_tool_call_id: null, planner_session_id: null, executor_session_id: null, reviewer_session_id: null, started_at: at, last_turn_at: at }, updated_at: at, last_tick_at: null }; }
export function createSupervisorRuntimeApi(options: SupervisorRuntimeApiOptions): RuntimeControlMechanics { return new SupervisorRuntimeApi(options); }

export class RuntimeControlConflictError extends Error {
  readonly code = 'runtime_control_conflict';
  constructor() { super('Runtime control conflicts with an in-flight project stop.'); }
}
