import { randomUUID } from 'node:crypto';
import { cardRecordSchema, type CardNotification, type CardRecord, type RuntimeState, type RuntimeStatus } from '../../schemas/index.js';
import { PROJECT_CARD_ID } from '../../cards/project-card.js';
import { acceptsCardNotifications, canCancelCardStatus } from '../../cards/status-api.js';
import { CardActivationOwner, type CardActivationCaller, type CardCancellationResult, type CardProcessorActor, type PlannerChildControlPort } from './card-activation-owner.js';
import { CardProcessActor } from './card-process-actor.js';
import { toPublicCardActorState } from '../../schemas/actor-vocabulary.js';
import type { ExecutingLlmSnapshot } from './executing-llm-snapshot.js';
import type { ChildInvocationLease } from './child-invocation-wait.js';
import type { ActorRuntimeReadModel } from '../../application/read-models/actor-runtime-read-model.js';
import type { RuntimeControlMechanics, RuntimeLaunchPlan } from '../../application/runtime-control-service.js';
import type { NotifyCardResult, StartProjectResult, StopProjectResult } from '../runtime-api.js';
import { RuntimeGate } from '../runtime-gate.js';
import { selectLinkedRunningChain } from '../running-card-chain.js';
import type { LLMProviderPort, CompactorPort } from './llm-actor.js';
import type { AutonomousCompactionPolicy } from './compaction/compactor.js';
import type { SummarizerProviderPort } from './compaction/summarizer.js';
import type { CardService } from '../../cards/card-service.js';
import type { RuntimeInterventionBinding } from '../../application/intervention-readiness.js';
import type { ProcessRunner } from '../process-runner.js';
import type { ManagedProcessScope } from '../managed-process-group-registry.js';
import type { PromptTemplateRegistry } from '../../utils/prompt-api.js';
import type { ConversationFileContext } from '../../persistence/conversation-file.js';
import type { FreshnessEffects } from '../../application/freshness-effects.js';
import type { McpToolInvocationPort } from '../../mcp/mcp-manager.js';
import { RuntimeContainmentError, RuntimeStoppedInterruption } from './runtime-stopped-interruption.js';
import type { RuntimeProcessIdentity } from '../lock.js';
import { cardProcessEntryForStatus, type CompiledCardProcesses, type CardProcessEntry, type ProcessRole } from '../card-process/card-process-config.js';
import type { ProcessPromptRegistry } from '../card-process/process-prompt-registry.js';
import { stabilizeRoleSession } from './conversation-recovery.js';
import { TERMINAL_RESULT_TOOL_NAME } from '../../contracts/result-envelope.js';
import { executorActorId, plannerActorId, reviewerActorId } from './ids.js';
import { cardParentId } from '../../schemas/card-id.js';
import { deferred, type Deferred } from './deferred.js';
import { AppLogPublicationError } from '../../persistence/app-log.js';

export interface SupervisorRuntimeApiOptions {
  projectRoot: string; now?: () => string;
  actorStore: CardService; interventionBinding: RuntimeInterventionBinding; provider: LLMProviderPort;
  conversations: ConversationFileContext; freshness: Pick<FreshnessEffects, 'runtimeChanged' | 'agentsChanged' | 'conversationChanged'>;
  compactor: CompactorPort; compactionConfig: AutonomousCompactionPolicy; summarizerProvider: SummarizerProviderPort;
  processRunner: ProcessRunner; runtimeProcessRootScope: ManagedProcessScope; promptTemplates: PromptTemplateRegistry;
  cardProcesses: CompiledCardProcesses; processPrompts: ProcessPromptRegistry;
  runtimeGate?: RuntimeGate; mcpToolInvocation: McpToolInvocationPort;
  processIdentity: RuntimeProcessIdentity;
}

interface SupervisorLaunchPlan extends RuntimeLaunchPlan { readonly owner: CardActivationOwner; readonly runIdentity: object }
type ContainmentRecord = { owner: 'stop' | 'application_close'; interruption: RuntimeStoppedInterruption; settlement: Deferred<void>; task: Promise<void> | null; stopResult: Promise<StopProjectResult> | null };

export class SupervisorRuntimeApi implements RuntimeControlMechanics {
  private readonly behavior: Omit<SupervisorRuntimeApiOptions, 'processRunner' | 'runtimeProcessRootScope'>;
  readonly #processRunner: ProcessRunner;
  readonly #runtimeProcessRootScope: ManagedProcessScope;
  private readonly now: () => string;
  private readonly runtimeGate: RuntimeGate;
  private readonly activationOwners = new Map<string, CardActivationOwner>();
  private currentCardId: string | null = null;
  private started = false;
  private status: RuntimeStatus = 'stopped';
  private preparedLaunch: SupervisorLaunchPlan | null = null;
  private runIdentity: object | null = null;
  private applicationAdmissionOpen = true;
  private containment: ContainmentRecord | null = null;
  private inOwnershipTransition = false;

  constructor(options: SupervisorRuntimeApiOptions) {
    const { processRunner, runtimeProcessRootScope, ...behavior } = options;
    this.#processRunner = processRunner;
    this.#runtimeProcessRootScope = runtimeProcessRootScope;
    this.behavior = behavior;
    this.now = behavior.now ?? (() => new Date().toISOString());
    this.runtimeGate = behavior.runtimeGate ?? new RuntimeGate();
  }

  async start(): Promise<void> {
    if (this.started) return;
    const root = this.behavior.actorStore.read(PROJECT_CARD_ID);
    if (!root) throw new Error(`Root card record '${PROJECT_CARD_ID}' is missing.`);
    cardRecordSchema.parse(root);
    this.runtimeGate.close();
    this.ownershipTransition(false, () => { this.started = true; this.status = 'stopped'; this.behavior.interventionBinding.markStoppedReady(); });
  }

  closeApplicationAdmission(): void {
    if (!this.applicationAdmissionOpen) return;
    this.applicationAdmissionOpen = false;
    if (!this.runIdentity) return;
    this.claimContainment('application_close');
  }

  cleanupForApplicationStop(): Promise<void> {
    this.closeApplicationAdmission();
    const record = this.containment;
    if (!record) {
      let termination: Promise<import('../process-runner.js').ProcessStopReport>;
      try { termination = this.#processRunner.terminateScopeTree({ rootScope: this.#runtimeProcessRootScope, categories: ['runtime_card'], reason: 'application stopping', graceMs: 5000 }); }
      catch (error) { termination = Promise.reject(error); }
      return termination.then((report) => { if (report.failed.length) throw new Error('Runtime application cleanup failed.'); });
    }
    if (record.owner !== 'application_close') return record.stopResult!.then(() => undefined);
    this.startContainment(record);
    return record.settlement.promise.catch((error) => { throw new Error('Runtime application cleanup failed.', { cause: error }); });
  }

  stopProject(): Promise<StopProjectResult> {
    if (!this.runIdentity) return Promise.resolve({ status: 'stopped', contained: false });
    const existing = this.containment;
    if (existing) {
      if (existing.owner === 'stop') return existing.stopResult!;
      return existing.settlement.promise.then<StopProjectResult>(() => { throw new RuntimeControlConflictError('Runtime is closing for application shutdown.'); });
    }
    const record = this.claimContainment('stop');
    this.startContainment(record);
    return record.stopResult!;
  }

  async beginStartProject(): Promise<{ accepted: false; result: StartProjectResult } | { accepted: true; launch: RuntimeLaunchPlan }> {
    await this.start();
    if (!this.applicationAdmissionOpen) return { accepted: false, result: this.startRejected('Application is closing.') };
    if (this.status !== 'stopped' || this.runIdentity || this.preparedLaunch) return { accepted: false, result: this.startRejected(`Cannot start runtime from '${this.status}'.`) };

    const runningChain = selectLinkedRunningChain(this.behavior.actorStore);
    const root = runningChain[0] ?? this.behavior.actorStore.read(PROJECT_CARD_ID);
    if (!root || root.id !== PROJECT_CARD_ID || root.type !== 'project') throw new Error(`Root card record '${PROJECT_CARD_ID}' is missing.`);
    const entry = runningChain.length > 0 ? 'STOPPED' : cardProcessEntryForStatus(root.lifecycle.status);
    if (entry === null) throw new Error(`Project card in status '${root.lifecycle.status}' cannot start.`);
    const stabilized = runningChain.length > 0 ? new Set(eligibleRoles(root)) : new Set<ProcessRole>();
    const runIdentity = {};
    const owner = this.createOwner(root, entry, { kind: 'root' }, 'prepared_root', undefined, stabilized);
    const launch = Object.freeze({ owner, runIdentity }) as SupervisorLaunchPlan;
    this.ownershipTransition(true, () => {
      this.runIdentity = runIdentity;
      this.preparedLaunch = launch;
      this.status = 'starting';
      this.currentCardId = PROJECT_CARD_ID;
      this.activationOwners.set(PROJECT_CARD_ID, owner);
      this.behavior.interventionBinding.markNotReady();
    });

    if (runningChain.length > 0) {
      for (const card of [...runningChain].reverse()) {
        this.requirePreparation(owner, runIdentity);
        for (const role of eligibleRoles(card)) {
         if (!this.publish(owner, () => { stabilizeRoleSession({ projectRoot: this.behavior.projectRoot, sessionId: sessionForRecovery(role, card.id), conversations: this.behavior.conversations, terminalToolNames: new Set([TERMINAL_RESULT_TOOL_NAME]) }); return true; })) return await owner.settlement.promise.then(() => { throw new Error('Prepared root unexpectedly settled.'); });
        }
      }
      for (const card of [...runningChain].reverse()) {
        this.requirePreparation(owner, runIdentity);
         if (!this.publish(owner, () => this.behavior.actorStore.stopRunningForRecovery(card.id))) return await owner.settlement.promise.then(() => { throw new Error('Prepared root unexpectedly settled.'); });
      }
    }
    this.requirePreparation(owner, runIdentity);
    const running = this.publish(owner, () => root.lifecycle.status === 'stopped' || runningChain.length > 0
       ? this.behavior.actorStore.activateStopped(PROJECT_CARD_ID)
       : this.behavior.actorStore.setStatus(PROJECT_CARD_ID, 'running'));
    if (!running) return await owner.settlement.promise.then(() => { throw new Error('Prepared root unexpectedly settled.'); });
    this.ownershipTransition(true, () => { this.requireOwner(owner); owner.phase = 'active'; owner.cachedStatus = 'running'; });
    return { accepted: true, launch };
  }

  launchStartedProject(launchBase: RuntimeLaunchPlan): RuntimeState {
    const launch = launchBase as SupervisorLaunchPlan;
    if (launch !== this.preparedLaunch) throw new Error('Runtime launch plan is foreign, stale, or already consumed.');
    const owner = launch.owner;
    this.requireOwner(owner);
    if (owner.phase !== 'active' || owner.terminalWinner !== 'open' || owner.containmentOwner !== 'none' || this.status !== 'starting' || !this.applicationAdmissionOpen) throw new Error('Prepared runtime launch is no longer admissible.');
    this.ownershipTransition(true, () => { this.preparedLaunch = null; this.status = 'running'; });
    if (owner.containmentOwner !== 'none' || this.getStatus().status !== 'running' || !this.applicationAdmissionOpen) throw this.containment?.interruption ?? new Error('Prepared runtime launch lost admission during invalidation.');
    this.runtimeGate.open();
    this.activateProcessor(owner);
    return this.runtimeState()!;
  }

  pause(): void {
    if (this.status !== 'running' || !this.runIdentity) throw new Error(`Cannot pause runtime from '${this.status}'.`);
    const identity = this.runIdentity;
    this.ownershipTransition(true, () => { this.status = 'pausing'; this.behavior.interventionBinding.markNotReady(); });
    this.runtimeGate.requestPause(() => {
      if (this.runIdentity !== identity || this.status !== 'pausing' || !this.activationOwners.has(PROJECT_CARD_ID)) return;
      this.ownershipTransition(true, () => { this.status = 'paused'; this.behavior.interventionBinding.markPausedReady(); });
    });
  }

  resume(): void {
    if (this.status !== 'paused' || !this.runIdentity) throw new Error(`Cannot resume runtime from '${this.status}'.`);
    const identity = this.runIdentity;
    this.runtimeGate.open();
    this.ownershipTransition(true, () => {
      if (this.runIdentity !== identity || this.status !== 'paused') throw new Error('Paused runtime identity changed while resuming.');
      this.status = 'running';
      this.behavior.interventionBinding.markNotReady();
    });
  }

  notifyCard(cardId: string, notification: CardNotification): NotifyCardResult {
    const card = this.behavior.actorStore.read(cardId);
    if (!card) return { ok: false, reason: 'missing_card', cardId };
    if (!acceptsCardNotifications(card.lifecycle.status)) return { ok: false, reason: 'terminal_card', cardId, status: card.lifecycle.status as 'done' | 'failed' | 'cancelled' };
    this.behavior.actorStore.enqueueNotification(cardId, notification);
    return { ok: true, notificationId: notification.id };
  }

  cancelCard(cardId: string, reason: string): Promise<CardCancellationResult> { return this.cancelOwnedOrStored(cardId, reason, null); }
  getStatus() { return { status: this.status, currentCardId: this.currentCardId, pid: this.behavior.processIdentity.pid, startedAt: this.behavior.processIdentity.startedAt }; }
  getRuntimeState(): RuntimeState | null { return this.runtimeState(); }
  getActorRuntimeReadModel(): ActorRuntimeReadModel {
    const cards = [...this.activationOwners.values()].map((owner) => ({ cardId: owner.cardId, actorState: toPublicCardActorState(owner.cachedStatus), processState: owner.processPosition() }));
    return { pauseMode: this.status === 'running' ? 'running' : this.status === 'paused' ? 'paused' : 'idle', cards };
  }
  captureAutonomousExecutingLlmSnapshots(): readonly ExecutingLlmSnapshot[] { return [...this.activationOwners.values()].flatMap((owner) => { const value = owner.processor.executingLlmSnapshot(); return value ? [value] : []; }); }

  private boundParentControl(parentCardId: string, activationId: string): PlannerChildControlPort {
    const requireParent = (): CardActivationOwner => {
      const parent = this.activationOwners.get(parentCardId);
      if (!parent || parent.activationId !== activationId || parent.phase !== 'active' || parent.containmentOwner !== 'none') throw new Error(`Parent activation '${parentCardId}' is no longer active.`);
      return parent;
    };
    return Object.freeze({
      activateChild: ({ childCardId, invocation }: { childCardId: string; invocation: ChildInvocationLease }) => { const parent = requireParent(); return this.activateChild(parent, childCardId, invocation); },
      cancelChild: ({ childCardId, reason }: { childCardId: string; reason: string }) => { requireParent(); return this.cancelOwnedOrStored(childCardId, reason, parentCardId); },
    });
  }

  private activateChild(parent: CardActivationOwner, childCardId: string, lease: ChildInvocationLease): Promise<import('../../contracts/tool-api.js').CardActivationOutcome> {
    if (cardParentId(childCardId) !== parent.cardId) return this.rejectLease(lease, new Error(`Planner can activate only immediate children of '${parent.cardId}'.`));
    const snapshot = parent.processor.executingLlmSnapshot();
    if (!snapshot || lease.identity.sessionId !== snapshot.sessionId || lease.identity.toolName !== 'activate_card' || lease.childCardId !== childCardId) throw new Error('Child invocation lease identity does not match parent activation.');
    const existing = this.activationOwners.get(childCardId);
    if (existing) {
      if (existing.parentRelationship?.parentCardId === parent.cardId && existing.parentRelationship.invocation === lease && (existing.phase === 'active' || existing.phase === 'settling' || existing.phase === 'settled_contained')) return lease.activation;
      throw new Error(`Child '${childCardId}' already has a different activation owner.`);
    }
    const admission = this.behavior.actorStore.readActivationAdmission(childCardId);
    if (!admission) return this.rejectLease(lease, new Error(`Child card '${childCardId}' not found.`));
    if (cardParentId(admission.child.id) !== parent.cardId) return this.rejectLease(lease, new Error(`Planner can activate only immediate children of '${parent.cardId}'.`));
    const incomplete = admission.dependencies.filter(({ status }) => status !== 'done');
    if (incomplete.length) return this.rejectLease(lease, new Error(`Child card '${childCardId}' has incomplete dependencies: ${incomplete.map(({ id, status }) => `${id} (${status})`).join(', ')}.`));
    const entry = cardProcessEntryForStatus(admission.child.lifecycle.status);
    if (entry === null) return this.rejectLease(lease, new Error(`Card '${childCardId}' in status '${admission.child.lifecycle.status}' is not activatable.`));
    const relationship = Object.freeze({ parentCardId: parent.cardId, childCardId, invocation: lease });
    const owner = this.createOwner(admission.child, entry, { kind: 'parent', cardId: parent.cardId, sessionId: lease.identity.sessionId }, 'child_admission', relationship);
    this.ownershipTransition(false, () => {
      this.activationOwners.set(childCardId, owner); parent.childCardId = childCardId; lease.markAdmitted();
    });
    const running = this.publish(owner, () => admission.child.lifecycle.status === 'stopped' ? this.behavior.actorStore.activateStopped(childCardId) : this.behavior.actorStore.setStatus(childCardId, 'running'));
    if (!running) return lease.activation;
    if (owner.containmentOwner !== 'none') return lease.activation;
    this.ownershipTransition(true, () => { this.requireOwner(owner); owner.phase = 'active'; owner.cachedStatus = 'running'; this.currentCardId = childCardId; }, lease.identity.sessionId);
    this.activateProcessor(owner);
    return lease.activation;
  }

  private rejectLease(lease: ChildInvocationLease, error: Error): Promise<never> {
    lease.markRejected(); lease.deliverInterruption(error); return lease.activation as Promise<never>;
  }

  private createOwner(card: CardRecord, entry: CardProcessEntry, caller: CardActivationCaller, phase: 'prepared_root' | 'child_admission', relationship?: CardActivationOwner['parentRelationship'], stabilized?: ReadonlySet<ProcessRole>): CardActivationOwner {
    const activationId = randomUUID();
    const parentControl = this.boundParentControl(card.id, activationId);
    const process = card.type === 'project' || card.type === 'goal' ? this.behavior.cardProcesses.planning : this.behavior.cardProcesses.terminal;
    const processor = new CardProcessActor({ projectRoot: this.behavior.projectRoot, cardId: card.id, process, processPrompts: this.behavior.processPrompts, store: this.behavior.actorStore, parentControl, notifyCard: (id, notification) => this.notifyCard(id, notification), provider: this.behavior.provider, conversations: this.behavior.conversations, processRunner: this.#processRunner, runtimeProcessRootScope: this.#runtimeProcessRootScope, promptTemplates: this.behavior.promptTemplates, runtimeProjectionChanged: () => this.ownershipInvalidated(), gate: this.runtimeGate, mcpToolInvocation: this.behavior.mcpToolInvocation, compactor: this.behavior.compactor, compactionConfig: this.behavior.compactionConfig, summarizerProvider: this.behavior.summarizerProvider });
    processor.start();
    return new CardActivationOwner({ card, store: this.behavior.actorStore, processor, activationId, entry, caller, phase, parentRelationship: relationship ?? undefined, alreadyStabilizedRoles: stabilized as ReadonlySet<'planner' | 'reviewer' | 'executor'> | undefined });
  }

  private activateProcessor(owner: CardActivationOwner): void {
    this.requireOwner(owner);
    if (owner.processorActivated || owner.phase !== 'active' || owner.containmentOwner !== 'none') return;
    owner.processorActivated = true;
    const input = { activationId: owner.activationId, card: this.requireKnownCard(owner), caller: owner.caller, entry: owner.entry, alreadyStabilizedRoles: owner.alreadyStabilizedRoles, notificationDelivery: { selectNotifications: () => this.requireKnownCard(owner).pending_notifications, removeNotifications: (ids: readonly string[]) => owner.store.removeNotifications(owner.cardId, [...ids]) }, claimResult: () => this.claimResult(owner) };
    void owner.processor.activate(input, owner.abortController.signal).then((outcome) => this.settleResult(owner, outcome), (error) => {
      if (owner.terminalWinner === 'cancel' || owner.containmentOwner !== 'none') return;
      if (error instanceof AppLogPublicationError) {
        void this.containProcessorPublicationFailure(owner, error).catch((cleanupError) => { owner.retainedLocalFailure ??= cleanupError; });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      void this.settleResult(owner, { status: 'failed', summary: message, result: { kind: 'failed', summary: message } });
    });
  }

  private async containProcessorPublicationFailure(owner: CardActivationOwner, error: AppLogPublicationError): Promise<void> {
    if (this.activationOwners.get(owner.cardId) !== owner) return;
    owner.retainedPublicationFailure = error;
    let lease: ChildInvocationLease | null = null;
    this.ownershipTransition(false, () => {
      owner.phase = 'publication_unknown';
      lease = owner.parentRelationship?.invocation ?? null;
      if (lease && (lease.phase() === 'admitted' || lease.phase() === 'settling')) lease.markPublicationUnknown();
      this.status = 'error';
      this.runtimeGate.close();
      this.behavior.interventionBinding.markNotReady();
    });
    try {
      owner.processor.suppressContinuationAndPrepareJoin(error);
    } catch (cleanupError) { owner.retainedLocalFailure ??= cleanupError; }
    try { await this.joinProcessor(owner); }
    catch (cleanupError) { owner.retainedLocalFailure ??= cleanupError; }
    if (!owner.parentRelationship) {
      owner.settlement.reject(error);
      return;
    }
    const relationship = owner.parentRelationship;
    this.ownershipTransition(false, () => {
      if (this.activationOwners.get(owner.cardId) !== owner) return;
      const parent = this.activationOwners.get(relationship.parentCardId);
      if (parent?.childCardId === owner.cardId) parent.childCardId = null;
      this.activationOwners.delete(owner.cardId);
      this.currentCardId = relationship.parentCardId;
      if (relationship.invocation.phase() !== 'contained') relationship.invocation.markContained();
    });
    owner.settlement.reject(error);
    relationship.invocation.deliverInterruption(error);
  }

  private claimResult(owner: CardActivationOwner): void {
    this.requireOwner(owner);
    owner.abortController.signal.throwIfAborted();
    if (owner.terminalWinner !== 'open') throw new Error(`Card '${owner.cardId}' terminal winner is '${owner.terminalWinner}'.`);
    owner.terminalWinner = 'result';
  }

  private async settleResult(owner: CardActivationOwner, outcome: Exclude<import('../../contracts/tool-api.js').CardActivationOutcome, { status: 'cancelled' }>): Promise<void> {
    if (this.activationOwners.get(owner.cardId) !== owner) return;
    if (owner.terminalWinner === 'cancel') return;
    this.ownershipTransition(true, () => {
      if (owner.terminalWinner === 'open') owner.terminalWinner = 'result';
      if (owner.terminalWinner !== 'result') throw new Error(`Card '${owner.cardId}' cannot settle result from '${owner.terminalWinner}'.`);
      owner.phase = 'settling';
      if (owner.parentRelationship?.invocation.phase() === 'admitted') owner.parentRelationship.invocation.markSettling();
    }, owner.parentRelationship?.invocation.identity.sessionId);
    const committed = this.publish(owner, () => owner.store.commitActivationOutcome(owner.cardId, outcome, this.now()));
    if (!committed) return;
    owner.cachedStatus = committed.lifecycle.status;
    owner.processor.suppressContinuationAndPrepareJoin(new Error('Activation settled.'));
    try { await this.joinProcessor(owner); } catch (error) { this.retainLocalFailure(owner, error); return; }
    if (owner.containmentOwner !== 'none') { this.ownershipTransition(true, () => { owner.phase = 'settled_contained'; }); return; }
    if (owner.cardId === PROJECT_CARD_ID) {
      const chain = selectLinkedRunningChain(this.behavior.actorStore);
      if (chain.length !== 0) throw new Error('Natural root settlement retained a durable running chain.');
      this.releaseRootNaturally(owner, outcome);
    } else this.releaseChildNaturally(owner, outcome);
  }

  private releaseChildNaturally(owner: CardActivationOwner, outcome: import('../../contracts/tool-api.js').CardActivationOutcome): void {
    const relationship = owner.parentRelationship!; const lease = relationship.invocation;
    this.ownershipTransition(true, () => {
      this.requireOwner(owner); const parent = this.activationOwners.get(relationship.parentCardId); if (!parent || parent.childCardId !== owner.cardId) throw new Error('Parent relationship changed before child release.');
      this.activationOwners.delete(owner.cardId); parent.childCardId = null; this.currentCardId = parent.cardId; lease.markReleased();
    }, lease.identity.sessionId);
    owner.settlement.resolve(outcome); lease.deliverOutcome(outcome);
  }

  private releaseRootNaturally(owner: CardActivationOwner, outcome: Exclude<import('../../contracts/tool-api.js').CardActivationOutcome, { status: 'cancelled' }>): void {
    if (this.status !== 'running' && this.status !== 'pausing' && this.status !== 'paused') throw new Error(`Root cannot naturally release from '${this.status}'.`);
    this.ownershipTransition(true, () => {
      this.runtimeGate.completeRun(); this.activationOwners.delete(PROJECT_CARD_ID); this.preparedLaunch = null; this.runIdentity = null; this.currentCardId = null; this.status = 'stopped'; this.behavior.interventionBinding.markStoppedReady();
    });
    owner.settlement.resolve(outcome);
  }

  private async cancelOwnedOrStored(cardId: string, reason: string, expectedParent: string | null): Promise<CardCancellationResult> {
    if (expectedParent !== null && cardParentId(cardId) !== expectedParent) throw new Error(`cancel_card can target only immediate children of '${expectedParent}'.`);
    const owner = this.activationOwners.get(cardId);
    if (owner) {
      if (owner.phase === 'child_admission' || owner.phase === 'publication_unknown') throw new Error(`Card '${cardId}' cannot be cancelled while activation publication is unresolved.`);
      const suffix: CardActivationOwner[] = []; let current: CardActivationOwner | undefined = owner;
      while (current) { suffix.push(current); current = current.childCardId ? this.activationOwners.get(current.childCardId) : undefined; if (suffix.at(-1)!.childCardId && !current) throw new Error('Owned child relationship has no owner.'); }
      const cancelReason = { reason, cancelled_at: this.now() };
      for (const item of suffix) {
        if (item.terminalWinner === 'result') { await item.settlement.promise; throw new Error(`Card '${item.cardId}' result already claimed the activation.`); }
        if (item.terminalWinner === 'open') { this.ownershipTransition(true, () => { item.terminalWinner = 'cancel'; item.phase = 'settling'; item.cancellationReason = cancelReason; if (item.parentRelationship?.invocation.phase() === 'admitted') item.parentRelationship.invocation.markSettling(); }); item.abortController.abort(new Error(reason)); item.processor.disposeActivation(new Error(reason)); }
      }
      const cancelled: string[] = [];
      for (const item of [...suffix].reverse()) { const result = await this.settleCancellation(item); for (const id of result.cancelled_card_ids) if (!cancelled.includes(id)) cancelled.push(id); }
      return { card_id: cardId, status: 'cancelled', cancelled_card_ids: cancelled };
    }
    const card = this.behavior.actorStore.read(cardId);
    if (!card) throw new Error(`Card '${cardId}' not found.`);
    if (!canCancelCardStatus(card.lifecycle.status)) throw new Error(`Card '${cardId}' in status '${card.lifecycle.status}' cannot be cancelled.`);
    if (card.lifecycle.status === 'running') throw new Error(`Running card '${cardId}' has no activation owner.`);
    const cancelled: string[] = []; await this.cancelNonrunningSubtree(cardId, cancelled); return { card_id: cardId, status: 'cancelled', cancelled_card_ids: cancelled };
  }

  private settleCancellation(owner: CardActivationOwner): Promise<CardCancellationResult> {
    if (owner.cancellationSettlement) return owner.cancellationSettlement;
    owner.cancellationSettlement = (async () => {
      try { await this.joinProcessor(owner); } catch (error) { this.retainLocalFailure(owner, error); throw error; }
      const cancelledDescendants: string[] = [];
      for (const childId of this.behavior.actorStore.listChildren(owner.cardId)) {
        if (!this.activationOwners.has(childId)) await this.cancelNonrunningSubtree(childId, cancelledDescendants);
      }
      const written = this.publish(owner, () => owner.store.setStatus(owner.cardId, 'cancelled'));
      if (!written) return await owner.settlement.promise as never;
      owner.cachedStatus = 'cancelled';
      const outcome = { status: 'cancelled' as const, summary: owner.cancellationReason!.reason };
      if (owner.containmentOwner !== 'none') { this.ownershipTransition(true, () => { owner.phase = 'settled_contained'; }); return { card_id: owner.cardId, status: 'cancelled', cancelled_card_ids: [...cancelledDescendants, owner.cardId] }; }
      if (owner.cardId === PROJECT_CARD_ID) this.releaseRootNaturally(owner, outcome as never); else this.releaseChildNaturally(owner, outcome);
      return { card_id: owner.cardId, status: 'cancelled', cancelled_card_ids: [...cancelledDescendants, owner.cardId] };
    })();
    return owner.cancellationSettlement;
  }

  private claimContainment(kind: 'stop' | 'application_close'): ContainmentRecord {
    if (this.containment) return this.containment;
    const interruption = new RuntimeStoppedInterruption();
    const record: ContainmentRecord = { owner: kind, interruption, settlement: deferred<void>(), task: null, stopResult: null };
    if (kind === 'stop') record.stopResult = record.settlement.promise.then<StopProjectResult>(() => ({ status: 'stopped', contained: true }));
    const leases: ChildInvocationLease[] = [];
    const interruptedOwners: CardActivationOwner[] = [];
    this.ownershipTransition(true, () => {
      if (kind === 'application_close') this.applicationAdmissionOpen = false;
      this.containment = record; this.status = 'closing'; this.runtimeGate.close(); this.behavior.interventionBinding.markNotReady();
      for (const owner of this.activationOwners.values()) { owner.containmentOwner = kind; interruptedOwners.push(owner); const lease = owner.parentRelationship?.invocation; if (lease && lease.phase() !== 'contained') { lease.markContained(); leases.push(lease); } }
    });
    for (const lease of leases) lease.deliverInterruption(interruption);
    for (const owner of interruptedOwners) owner.settlement.reject(interruption);
    if (kind === 'application_close') this.startContainment(record);
    return record;
  }

  private startContainment(record: ContainmentRecord): void {
    if (record.task) return;
    record.task = this.performContainment(record);
  }

  private async performContainment(record: ContainmentRecord): Promise<void> {
    const failures: Array<{ component: string }> = [];
    const owners = [...this.activationOwners.values()];
    for (const owner of owners) {
      try {
        if (owner.terminalWinner === 'result') owner.processor.suppressContinuationAndPrepareJoin(record.interruption);
        else if (owner.terminalWinner === 'open') { owner.abortController.abort(record.interruption); owner.processor.disposeActivation(record.interruption); }
      } catch { failures.push({ component: `card:${owner.cardId}:interrupt` }); }
    }
    const joins = owners.map(async (owner) => { try { await owner.publicationTask; await this.joinProcessor(owner); } catch { failures.push({ component: `card:${owner.cardId}:join` }); } });
    let processTask: Promise<void>;
    try {
      const pending = this.#processRunner.terminateScopeTree({ rootScope: this.#runtimeProcessRootScope, categories: ['runtime_card'], reason: record.owner === 'stop' ? 'runtime stop' : 'application stopping', graceMs: 5000 });
      processTask = pending.then((report) => { if (report.failed.length) failures.push({ component: 'runtime-process-scope' }); }, () => { failures.push({ component: 'runtime-process-scope' }); });
    } catch { failures.push({ component: 'runtime-process-scope' }); processTask = Promise.resolve(); }
    await Promise.all([...joins, processTask]);
    if (this.containment !== record) throw new Error('Containment ownership changed during settlement.');
    if (failures.length) {
      this.ownershipTransition(true, () => { this.status = 'error'; this.behavior.interventionBinding.markNotReady(); });
      record.settlement.reject(new RuntimeContainmentError(failures)); return;
    }
    if (record.owner === 'stop') {
      const sessions = owners.flatMap((owner) => owner.parentRelationship ? [owner.parentRelationship.invocation.identity.sessionId] : []);
      this.ownershipTransition(true, () => {
        this.runtimeGate.completeRun(); for (const owner of owners) { const lease = owner.parentRelationship?.invocation; if (lease?.phase() === 'contained' && !(owner.retainedPublicationFailure instanceof AppLogPublicationError)) lease.markReleased(); }
        this.activationOwners.clear(); this.preparedLaunch = null; this.runIdentity = null; this.currentCardId = null; this.containment = null; this.status = 'stopped'; this.behavior.interventionBinding.markStoppedReady();
      }, sessions[0]);
    }
    record.settlement.resolve();
  }

  private publish<T>(owner: CardActivationOwner, write: () => T): T | null {
    const completion = deferred<void>(); owner.publicationTask = completion.promise;
    try {
      const result = write(); completion.resolve();
      if (owner.containmentOwner !== 'none') return null;
      return result;
    } catch (error) {
      owner.retainedPublicationFailure = error;
      this.ownershipTransition(true, () => { owner.phase = 'publication_unknown'; if (owner.parentRelationship && owner.parentRelationship.invocation.phase() !== 'contained') owner.parentRelationship.invocation.markPublicationUnknown(); if (owner.containmentOwner === 'none') { this.status = 'error'; this.runtimeGate.close(); this.behavior.interventionBinding.markNotReady(); } }, owner.parentRelationship?.invocation.identity.sessionId);
      completion.resolve(); return null;
    }
  }

  private joinProcessor(owner: CardActivationOwner): Promise<readonly import('./invocation-lifecycle.js').InvocationJoinOutcome[]> { owner.processorJoin ??= owner.processor.joinActivation(); return owner.processorJoin; }
  private retainLocalFailure(owner: CardActivationOwner, error: unknown): void { owner.retainedLocalFailure ??= error; this.ownershipTransition(true, () => { this.status = 'error'; this.behavior.interventionBinding.markNotReady(); }); }
  private requirePreparation(owner: CardActivationOwner, identity: object): void { if (this.runIdentity !== identity || this.activationOwners.get(PROJECT_CARD_ID) !== owner || owner.phase !== 'prepared_root' || owner.terminalWinner !== 'open' || owner.containmentOwner !== 'none' || !this.applicationAdmissionOpen) throw new Error('Root preparation authority is no longer current.'); }
  private requireOwner(owner: CardActivationOwner): void { if (this.activationOwners.get(owner.cardId) !== owner) throw new Error(`Card '${owner.cardId}' activation owner is no longer current.`); }
  private requireKnownCard(owner: CardActivationOwner): CardRecord { const card = owner.store.read(owner.cardId); if (!card) throw new Error(`Card '${owner.cardId}' not found.`); return card; }
  private startRejected(error: string): StartProjectResult { return { runtime: this.runtimeState(), status: this.status, started: false, stopped: this.status === 'stopped', error }; }
  private runtimeState(): RuntimeState | null { if (!this.runIdentity) return null; if (!this.currentCardId) throw new Error('Active runtime has no current card.'); return { status: this.status, project_id: 'project', pid: this.behavior.processIdentity.pid, started_at: this.behavior.processIdentity.startedAt, current_card_id: this.currentCardId, updated_at: this.now() }; }

  private ownershipTransition(invalidate: boolean, mutate: () => void, conversationSessionId?: import('../../schemas/index.js').ConversationSessionId): void {
    if (this.inOwnershipTransition) throw new Error('Nested ownership transition is forbidden.');
    this.inOwnershipTransition = true;
    try { mutate(); this.assertOwnershipInvariants(); } finally { this.inOwnershipTransition = false; }
    if (invalidate) this.ownershipInvalidated(conversationSessionId);
  }

  private assertOwnershipInvariants(): void {
    let roots = 0;
    for (const [id, owner] of this.activationOwners) {
      if (id !== owner.cardId) throw new Error('Activation owner map key mismatch.');
      if (!owner.parentRelationship) roots += 1;
      if (owner.parentRelationship) { const relationship = owner.parentRelationship; const parent = this.activationOwners.get(relationship.parentCardId); if (!parent || parent.childCardId !== id || relationship.childCardId !== id) throw new Error('Activation relationship is not bidirectionally owned.'); const lease = relationship.invocation; if (lease.childCardId !== id || lease.relationship.childCardId !== id || lease.relationship.sessionId !== lease.identity.sessionId || lease.relationship.sourceInputId !== lease.identity.sourceInputId || lease.relationship.toolCallId !== lease.identity.toolCallId || lease.relationship.toolName !== lease.identity.toolName) throw new Error('Activation relationship lease identity mismatch.'); }
      if (owner.childCardId) { const child = this.activationOwners.get(owner.childCardId); if (!child || child.parentRelationship?.parentCardId !== id) throw new Error('Activation child relationship is incomplete.'); }
      if (owner.phase === 'child_admission' && owner.terminalWinner !== 'open') throw new Error('Child admission cannot have a terminal winner.');
      if (owner.phase === 'settled_contained' && (owner.terminalWinner === 'open' || owner.containmentOwner === 'none')) throw new Error('Settled-contained owner lacks terminal or containment authority.');
    }
    if (roots > 1) throw new Error('Runtime has more than one root activation owner.');
    const readiness = this.behavior.interventionBinding.interventionReadiness();
    if (this.status === 'stopped' && readiness !== 'stopped') throw new Error('Stopped runtime is not intervention-ready.');
    if (this.status === 'paused' && readiness !== 'paused') throw new Error('Paused runtime readiness disagrees.');
    if (this.status !== 'stopped' && this.status !== 'paused' && readiness !== 'not_ready') throw new Error(`Runtime '${this.status}' must not be intervention-ready.`);
    if (this.status === 'stopped' && (this.runIdentity || this.currentCardId || this.activationOwners.size || this.preparedLaunch || this.containment)) throw new Error('Stopped runtime retains ownership state.');
    if (this.runIdentity && !this.currentCardId) throw new Error('Active runtime has no current card.');
  }

  private ownershipInvalidated(sessionId?: import('../../schemas/index.js').ConversationSessionId): void { this.behavior.freshness.runtimeChanged(); this.behavior.freshness.agentsChanged(); if (sessionId) this.behavior.freshness.conversationChanged(sessionId); }
  private async cancelNonrunningSubtree(cardId: string, cancelled: string[]): Promise<void> { const owner = this.activationOwners.get(cardId); if (owner) { const result = await this.cancelOwnedOrStored(cardId, 'ancestor cancelled', null); cancelled.push(...result.cancelled_card_ids); return; } const card = this.behavior.actorStore.read(cardId); if (!card || !canCancelCardStatus(card.lifecycle.status)) return; if (card.lifecycle.status === 'running') throw new Error(`Running card '${cardId}' has no activation owner.`); for (const childId of this.behavior.actorStore.listChildren(cardId)) await this.cancelNonrunningSubtree(childId, cancelled); this.behavior.actorStore.setStatus(cardId, 'cancelled'); cancelled.push(cardId); }
}

export function createSupervisorRuntimeApi(options: SupervisorRuntimeApiOptions): RuntimeControlMechanics { return new SupervisorRuntimeApi(options); }
export class RuntimeControlConflictError extends Error { readonly code = 'runtime_control_conflict'; constructor(message = 'Runtime control conflicts with an in-flight project stop.') { super(message); } }
function eligibleRoles(card: CardRecord): readonly ProcessRole[] { return card.type === 'project' || card.type === 'goal' ? ['planner', 'reviewer'] : ['executor']; }
function sessionForRecovery(role: ProcessRole, cardId: string) { return role === 'planner' ? plannerActorId(cardId) : role === 'reviewer' ? reviewerActorId(cardId) : executorActorId(cardId); }
