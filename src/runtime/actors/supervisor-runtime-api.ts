import { randomUUID } from 'node:crypto';
import { cardAgentSessionId, cardRecordSchema, type CardNotification, type CardRecord, type RuntimeState, type RuntimeStatus } from '../../schemas/index.js';
import { PROJECT_CARD_ID } from '../../cards/project-card.js';
import { acceptsCardNotifications, canCancelCardStatus } from '../../cards/status-api.js';
import { CardActivationOwner, type CardActivationCaller, type CardCancellationResult, type PlannerChildControlPort } from './card-activation-owner.js';
import { CardProcessActor } from './card-process-actor.js';
import { toPublicCardActorState } from '../../schemas/actor-vocabulary.js';
import type { ExecutingLlmSnapshot } from './executing-llm-snapshot.js';
import type { ChildInvocationLease } from './child-invocation-wait.js';
import type { ActorRuntimeReadModel } from '../../application/read-models/actor-runtime-read-model.js';
import type { NotifyCardResult, RuntimeApi, StartProjectResult, StopProjectResult } from '../runtime-api.js';
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
import { RuntimeStoppedInterruption } from './runtime-stopped-interruption.js';
import type { RuntimeProcessIdentity } from '../lock.js';
import { cardProcessEntryForStatus, type CompiledRuntimeWorkflows, type CardProcessEntry } from '../card-process/card-process-config.js';
import type { ProcessPromptRegistry } from '../card-process/process-prompt-registry.js';
import { stabilizeAgentSession } from './conversation-recovery.js';
import { TERMINAL_RESULT_TOOL_NAME } from '../../contracts/result-envelope.js';
import { cardParentId } from '../../schemas/card-id.js';
import { deferred } from './deferred.js';
import { AppLogPublicationError } from '../../persistence/app-log.js';
import { RecordAcceptanceOutcomeUnknown } from './agent-node-execution.js';

export interface SupervisorRuntimeApiOptions {
  projectRoot: string; now?: () => string;
  actorStore: CardService; interventionBinding: RuntimeInterventionBinding; provider: LLMProviderPort;
  conversations: ConversationFileContext; freshness: Pick<FreshnessEffects, 'runtimeChanged' | 'agentsChanged' | 'conversationChanged'>;
  compactor: CompactorPort; compactionConfig: AutonomousCompactionPolicy; summarizerProvider: SummarizerProviderPort;
  processRunner: ProcessRunner; runtimeProcessRootScope: ManagedProcessScope; promptTemplates: PromptTemplateRegistry;
  workflows: CompiledRuntimeWorkflows; processPrompts: ProcessPromptRegistry;
  runtimeGate?: RuntimeGate; mcpToolInvocation: McpToolInvocationPort;
  processIdentity: RuntimeProcessIdentity;
}

declare const supervisorLaunchPlanBrand: unique symbol;
interface SupervisorLaunchPlan { readonly [supervisorLaunchPlanBrand]: never; readonly owner: CardActivationOwner; readonly runIdentity: object }
interface RuntimeHalt {
  readonly interruption: RuntimeStoppedInterruption;
  readonly owners: readonly CardActivationOwner[];
  readonly promise: Promise<void>;
}

export class SupervisorRuntimeApi implements RuntimeApi {
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
  private halt: RuntimeHalt | null = null;
  private applicationCleanupTask: Promise<void> | null = null;
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
    if (!this.runIdentity && !this.halt) { this.applicationAdmissionOpen = false; return; }
    this.applicationCleanupTask = this.beginHalt('application_close');
  }

  cleanupForApplicationStop(): Promise<void> {
    this.closeApplicationAdmission();
    if (!this.applicationCleanupTask) {
      let termination: Promise<import('../process-runner.js').ProcessStopReport>;
      try { termination = this.#processRunner.terminateScopeTree({ rootScope: this.#runtimeProcessRootScope, categories: ['runtime_card'], reason: 'application stopping', graceMs: 5000 }); }
      catch (error) { termination = Promise.reject(error); }
      return termination.then((report) => { if (report.failed.length) throw new Error('Runtime application cleanup failed.'); });
    }
    return this.applicationCleanupTask.catch((error) => { throw new Error('Runtime application cleanup failed.', { cause: error }); });
  }

  stopProject(): Promise<StopProjectResult> {
    if (!this.runIdentity && !this.halt) return Promise.resolve({ status: 'stopped', contained: false });
    return this.beginHalt('stop').then<StopProjectResult>(() => ({ status: 'stopped', contained: true }));
  }

  async startProject(): Promise<StartProjectResult> {
    const prepared = await this.beginStartProject();
    if (!prepared.accepted) return prepared.result;
    const runtime = this.launchStartedProject(prepared.launch);
    return { runtime, status: runtime.status, started: true, stopped: false };
  }

  private async beginStartProject(): Promise<{ accepted: false; result: StartProjectResult } | { accepted: true; launch: SupervisorLaunchPlan }> {
    await this.start();
    if (!this.applicationAdmissionOpen) return { accepted: false, result: this.startRejected('Application is closing.') };
    if (this.status !== 'stopped' || this.runIdentity || this.preparedLaunch) return { accepted: false, result: this.startRejected(`Cannot start runtime from '${this.status}'.`) };

    const runningChain = selectLinkedRunningChain(this.behavior.actorStore);
    const root = runningChain[0] ?? this.behavior.actorStore.read(PROJECT_CARD_ID);
    if (!root || root.id !== PROJECT_CARD_ID || root.type !== 'project') throw new Error(`Root card record '${PROJECT_CARD_ID}' is missing.`);
    const entry = runningChain.length > 0 ? 'STOPPED' : cardProcessEntryForStatus(root.lifecycle.status);
    if (entry === null) throw new Error(`Project card in status '${root.lifecycle.status}' cannot start.`);
    const stabilized = runningChain.length > 0 ? new Set(eligibleAgents(this.behavior.workflows, root)) : new Set<import('../../schemas/index.js').AgentName>();
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
        for (const agentName of eligibleAgents(this.behavior.workflows, card)) {
          if (!this.publish(owner, () => { stabilizeAgentSession({ sessionId: cardAgentSessionId(agentName, card.id), conversations: this.behavior.conversations, terminalToolNames: new Set([TERMINAL_RESULT_TOOL_NAME]) }); return true; })) return await owner.settlement.promise.then(() => { throw new Error('Prepared root unexpectedly settled.'); });
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

  private launchStartedProject(launch: SupervisorLaunchPlan): RuntimeState {
    if (launch !== this.preparedLaunch) throw new Error('Runtime launch plan is foreign, stale, or already consumed.');
    const owner = launch.owner;
    this.requireOwner(owner);
    if (this.halt) throw this.halt.interruption;
    if (owner.phase !== 'active' || owner.terminalWinner !== 'open' || this.status !== 'starting' || !this.applicationAdmissionOpen) throw new Error('Prepared runtime launch is no longer admissible.');
    this.ownershipTransition(true, () => { this.preparedLaunch = null; this.status = 'running'; });
    const postTransitionHalt = this.halt as RuntimeHalt | null;
    if (postTransitionHalt?.owners.includes(owner)) throw postTransitionHalt.interruption;
    if (this.getStatus().status !== 'running' || !this.applicationAdmissionOpen) throw new Error('Prepared runtime launch lost admission during invalidation.');
    this.runtimeGate.open();
    this.activateProcessor(owner);
    return this.runtimeState()!;
  }

  pause(): void {
    if (this.halt) throw this.halt.interruption;
    if (this.status !== 'running' || !this.runIdentity) throw new Error(`Cannot pause runtime from '${this.status}'.`);
    const identity = this.runIdentity;
    this.ownershipTransition(true, () => { this.status = 'pausing'; this.behavior.interventionBinding.markNotReady(); });
    this.runtimeGate.requestPause(() => {
      if (this.halt) return;
      if (this.runIdentity !== identity || this.status !== 'pausing' || !this.activationOwners.has(PROJECT_CARD_ID)) return;
      this.ownershipTransition(true, () => { this.status = 'paused'; this.behavior.interventionBinding.markPausedReady(); });
    });
  }

  resume(): void {
    if (this.halt) throw this.halt.interruption;
    if (this.status !== 'paused' || !this.runIdentity) throw new Error(`Cannot resume runtime from '${this.status}'.`);
    const identity = this.runIdentity;
    this.runtimeGate.open();
    this.ownershipTransition(true, () => {
      if (this.halt) throw this.halt.interruption;
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
    const cards = [...this.activationOwners.values()].map((owner) => ({ cardId: owner.cardId, actorState: toPublicCardActorState(owner.cachedStatus), processState: owner.processor.processPosition() }));
    return { pauseMode: this.status === 'running' ? 'running' : this.status === 'paused' ? 'paused' : 'idle', cards };
  }
  captureAutonomousExecutingLlmSnapshots(): readonly ExecutingLlmSnapshot[] { return [...this.activationOwners.values()].flatMap((owner) => { const value = owner.processor.executingLlmSnapshot(); return value ? [value] : []; }); }

  private boundParentControl(parentCardId: string, activationId: string): PlannerChildControlPort {
    const requireParent = (): CardActivationOwner => {
      const parent = this.activationOwners.get(parentCardId);
      if (parent?.activationId === activationId && this.halt?.owners.includes(parent)) throw this.halt.interruption;
      if (!parent || parent.activationId !== activationId || parent.phase !== 'active' || this.halt) throw new Error(`Parent activation '${parentCardId}' is no longer active.`);
      return parent;
    };
    return Object.freeze({
      activateChild: ({ childCardId, invocation }: { childCardId: string; invocation: ChildInvocationLease }) => {
        try { return this.activateChild(requireParent(), childCardId, invocation); }
        catch (error) {
          const halt = this.halt;
          if (halt && error === halt.interruption) return this.rejectLease(invocation, halt.interruption);
          throw error;
        }
      },
      cancelChild: ({ childCardId, reason }: { childCardId: string; reason: string }) => { requireParent(); return this.cancelOwnedOrStored(childCardId, reason, parentCardId); },
    });
  }

  private activateChild(parent: CardActivationOwner, childCardId: string, lease: ChildInvocationLease): Promise<import('../../contracts/tool-api.js').CardActivationOutcome> {
    if (this.halt?.owners.includes(parent)) return this.interruptLease(lease, this.halt.interruption);
    this.requireOwnerAuthority(parent);
    if (cardParentId(childCardId) !== parent.cardId) return this.rejectLease(lease, new Error(`Planner can activate only immediate children of '${parent.cardId}'.`));
    const snapshot = parent.processor.executingLlmSnapshot();
    if (!snapshot || lease.identity.sessionId !== snapshot.sessionId || lease.identity.toolName !== 'activate_card' || lease.childCardId !== childCardId) throw new Error('Child invocation lease identity does not match parent activation.');
    this.requireOwnerAuthority(parent);
    const existing = this.activationOwners.get(childCardId);
    if (existing) {
      if (existing.parentRelationship?.parentCardId === parent.cardId && existing.parentRelationship.invocation === lease && (existing.phase === 'active' || existing.phase === 'settling')) return lease.activation;
      throw new Error(`Child '${childCardId}' already has a different activation owner.`);
    }
    this.requireOwnerAuthority(parent);
    const admission = this.behavior.actorStore.readActivationAdmission(childCardId);
    if (!admission) return this.rejectLease(lease, new Error(`Child card '${childCardId}' not found.`));
    if (cardParentId(admission.child.id) !== parent.cardId) return this.rejectLease(lease, new Error(`Planner can activate only immediate children of '${parent.cardId}'.`));
    const incomplete = admission.dependencies.filter(({ status }) => status !== 'done');
    if (incomplete.length) return this.rejectLease(lease, new Error(`Child card '${childCardId}' has incomplete dependencies: ${incomplete.map(({ id, status }) => `${id} (${status})`).join(', ')}.`));
    const entry = cardProcessEntryForStatus(admission.child.lifecycle.status);
    if (entry === null) return this.rejectLease(lease, new Error(`Card '${childCardId}' in status '${admission.child.lifecycle.status}' is not activatable.`));
    const relationship = Object.freeze({ parentCardId: parent.cardId, invocation: lease });
    const owner = this.createOwner(admission.child, entry, { kind: 'parent', cardId: parent.cardId, sessionId: lease.identity.sessionId }, 'child_admission', relationship);
    this.ownershipTransition(false, () => {
      this.requireOwnerAuthority(parent);
      this.activationOwners.set(childCardId, owner); parent.childCardId = childCardId; lease.markAdmitted();
    });
    const running = this.publish(owner, () => admission.child.lifecycle.status === 'stopped' ? this.behavior.actorStore.activateStopped(childCardId) : this.behavior.actorStore.setStatus(childCardId, 'running'));
    if (!running) return lease.activation;
    if (this.halt?.owners.includes(owner)) return lease.activation;
    this.ownershipTransition(true, () => { this.requireOwnerAuthority(owner); owner.phase = 'active'; owner.cachedStatus = 'running'; this.currentCardId = childCardId; }, lease.identity.sessionId);
    if (this.halt?.owners.includes(owner)) return lease.activation;
    this.activateProcessor(owner);
    return lease.activation;
  }

  private rejectLease(lease: ChildInvocationLease, error: Error): Promise<never> {
    lease.markRejected(); lease.deliverInterruption(error); return lease.activation as Promise<never>;
  }

  private interruptLease(lease: ChildInvocationLease, interruption: RuntimeStoppedInterruption): Promise<import('../../contracts/tool-api.js').CardActivationOutcome> {
    if (lease.phase() === 'reserved') return this.rejectLease(lease, interruption);
    if (lease.phase() === 'admitted' || lease.phase() === 'settling') lease.interrupt(interruption);
    return lease.activation;
  }

  private createOwner(card: CardRecord, entry: CardProcessEntry, caller: CardActivationCaller, phase: 'prepared_root' | 'child_admission', relationship?: CardActivationOwner['parentRelationship'], stabilized?: ReadonlySet<import('../../schemas/index.js').AgentName>): CardActivationOwner {
    const activationId = randomUUID();
    const parentControl = this.boundParentControl(card.id, activationId);
    const process = this.behavior.workflows.cardTypes.get(card.type);
    if (!process) throw new Error(`No compiled workflow for card type '${card.type}'.`);
    const processor = new CardProcessActor({ projectRoot: this.behavior.projectRoot, cardId: card.id, process, candidateChains:this.behavior.workflows.candidateChains,processPrompts: this.behavior.processPrompts, store: this.behavior.actorStore, parentControl, notifyCard: (id, notification) => this.notifyCard(id, notification), provider: this.behavior.provider, conversations: this.behavior.conversations, processRunner: this.#processRunner, runtimeProcessRootScope: this.#runtimeProcessRootScope, promptTemplates: this.behavior.promptTemplates, runtimeProjectionChanged: () => this.ownershipInvalidated(), onActorMainFailure: (error) => this.onProcessorActorMainFailure(card.id, activationId, error), gate: this.runtimeGate, mcpToolInvocation: this.behavior.mcpToolInvocation, compactor: this.behavior.compactor, compactionConfig: this.behavior.compactionConfig, summarizerProvider: this.behavior.summarizerProvider });
    processor.start();
    return new CardActivationOwner({ card, store: this.behavior.actorStore, processor, activationId, entry, caller, phase, parentRelationship: relationship ?? undefined, alreadyStabilizedAgents: stabilized });
  }

  private activateProcessor(owner: CardActivationOwner): void {
    this.requireOwnerAuthority(owner);
    if (owner.phase !== 'active') return;
    const input = { activationId: owner.activationId, card: this.requireKnownCard(owner), caller: owner.caller, entry: owner.entry, alreadyStabilizedAgents: owner.alreadyStabilizedAgents, notificationDelivery: { selectNotifications: () => { this.requireOwnerAuthority(owner); return this.requireKnownCard(owner).pending_notifications; }, removeNotifications: (ids: readonly string[]) => { this.requireOwnerAuthority(owner); owner.store.removeNotifications(owner.cardId, [...ids]); } }, claimResult: () => this.claimResult(owner) };
    void owner.processor.activate(input, owner.abortController.signal).then((outcome) => this.settleResult(owner, outcome), (error) => {
      if (this.halt?.owners.includes(owner) || owner.terminalWinner === 'cancel') return;
      if (error instanceof AppLogPublicationError || error instanceof RecordAcceptanceOutcomeUnknown) {
        void this.beginHalt('publication_failure', owner, error).catch(() => undefined);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      void this.settleResult(owner, { status: 'failed', summary: message, result: { kind: 'runtime-failure', summary: message } });
    });
  }

  private onProcessorActorMainFailure(cardId: string, activationId: string, error: unknown): void {
    const owner = this.activationOwners.get(cardId);
    const halt = this.halt;
    if (halt) {
      if (!owner || owner.activationId !== activationId || !halt.owners.includes(owner)) throw new Error(`Card '${cardId}' actor-main failure has no owner in the current runtime halt.`);
      void halt.promise.catch(() => undefined);
      return;
    }
    if (!owner || owner.activationId !== activationId) throw new Error(`Card '${cardId}' actor-main failure owner is no longer current.`);
    void this.beginHalt('runtime_failure').catch(() => undefined);
  }

  private claimResult(owner: CardActivationOwner): void {
    this.requireOwnerAuthority(owner);
    owner.abortController.signal.throwIfAborted();
    if (owner.terminalWinner !== 'open') throw new Error(`Card '${owner.cardId}' terminal winner is '${owner.terminalWinner}'.`);
    owner.terminalWinner = 'result';
  }

  private async settleResult(owner: CardActivationOwner, outcome: Exclude<import('../../contracts/tool-api.js').CardActivationOutcome, { status: 'cancelled' }>): Promise<void> {
    if (this.halt?.owners.includes(owner)) return;
    this.requireOwnerAuthority(owner);
    if (owner.terminalWinner === 'cancel') return;
    this.ownershipTransition(true, () => {
      this.requireOwnerAuthority(owner);
      if (owner.terminalWinner === 'open') owner.terminalWinner = 'result';
      if (owner.terminalWinner !== 'result') throw new Error(`Card '${owner.cardId}' cannot settle result from '${owner.terminalWinner}'.`);
      owner.phase = 'settling';
      if (owner.parentRelationship?.invocation.phase() === 'admitted') owner.parentRelationship.invocation.markSettling();
    }, owner.parentRelationship?.invocation.identity.sessionId);
    const committed = this.publish(owner, () => owner.store.commitActivationOutcome(owner.cardId, outcome, this.now()));
    if (!committed) return;
    if (this.halt?.owners.includes(owner)) return;
    this.requireOwnerAuthority(owner);
    owner.cachedStatus = committed.lifecycle.status;
    owner.processor.suppressContinuationAndPrepareJoin(new Error('Activation settled.'));
    try { await owner.processor.joinActivation(); } catch { void this.beginHalt('runtime_failure').catch(() => undefined); return; }
    if (this.halt?.owners.includes(owner)) return;
    this.requireOwnerAuthority(owner);
    if (owner.cardId === PROJECT_CARD_ID) {
      const chain = selectLinkedRunningChain(this.behavior.actorStore);
      if (chain.length !== 0) throw new Error('Natural root settlement retained a durable running chain.');
      this.releaseRootNaturally(owner, outcome);
    } else this.releaseChildNaturally(owner, outcome);
  }

  private releaseChildNaturally(owner: CardActivationOwner, outcome: import('../../contracts/tool-api.js').CardActivationOutcome): void {
    const relationship = owner.parentRelationship!; const lease = relationship.invocation;
    this.ownershipTransition(true, () => {
      this.requireOwnerAuthority(owner); const parent = this.activationOwners.get(relationship.parentCardId); if (!parent || parent.childCardId !== owner.cardId) throw new Error('Parent relationship changed before child release.');
      this.activationOwners.delete(owner.cardId); parent.childCardId = null; this.currentCardId = parent.cardId; lease.markReleased();
    }, lease.identity.sessionId);
    owner.settlement.resolve(outcome); lease.deliverOutcome(outcome);
  }

  private releaseRootNaturally(owner: CardActivationOwner, outcome: Exclude<import('../../contracts/tool-api.js').CardActivationOutcome, { status: 'cancelled' }>): void {
    this.requireOwnerAuthority(owner);
    if (this.status !== 'running' && this.status !== 'pausing' && this.status !== 'paused') throw new Error(`Root cannot naturally release from '${this.status}'.`);
    this.ownershipTransition(true, () => {
      this.requireOwnerAuthority(owner);
      this.runtimeGate.completeRun(); this.activationOwners.delete(PROJECT_CARD_ID); this.preparedLaunch = null; this.runIdentity = null; this.currentCardId = null; this.status = 'stopped'; this.behavior.interventionBinding.markStoppedReady();
    });
    owner.settlement.resolve(outcome);
  }

  private async cancelOwnedOrStored(cardId: string, reason: string, expectedParent: string | null): Promise<CardCancellationResult> {
    if (this.halt) throw this.halt.interruption;
    if (expectedParent !== null && cardParentId(cardId) !== expectedParent) throw new Error(`cancel_card can target only immediate children of '${expectedParent}'.`);
    const owner = this.activationOwners.get(cardId);
    if (owner) {
      this.requireOwnerAuthority(owner);
      if (owner.phase === 'child_admission') throw new Error(`Card '${cardId}' cannot be cancelled while activation publication is unresolved.`);
      const suffix: CardActivationOwner[] = []; let current: CardActivationOwner | undefined = owner;
      while (current) { suffix.push(current); current = current.childCardId ? this.activationOwners.get(current.childCardId) : undefined; if (suffix.at(-1)!.childCardId && !current) throw new Error('Owned child relationship has no owner.'); }
      const cancelReason = { reason, cancelled_at: this.now() };
      for (const item of suffix) {
        this.requireOwnerAuthority(item);
        if (item.terminalWinner === 'result') { await item.settlement.promise; this.requireOwnerAuthority(item); throw new Error(`Card '${item.cardId}' result already claimed the activation.`); }
        if (item.terminalWinner === 'open') { this.ownershipTransition(true, () => { this.requireOwnerAuthority(item); item.terminalWinner = 'cancel'; item.phase = 'settling'; item.cancellationReason = cancelReason; if (item.parentRelationship?.invocation.phase() === 'admitted') item.parentRelationship.invocation.markSettling(); }); item.abortController.abort(new Error(reason)); item.processor.disposeActivation(new Error(reason)); }
      }
      const cancelled: string[] = [];
      const settlementOrder = [...suffix].reverse();
      for (const [index, item] of settlementOrder.entries()) { const result = await this.settleCancellation(item); if (index + 1 < settlementOrder.length) this.requireOwnerAuthority(owner); for (const id of result.cancelled_card_ids) if (!cancelled.includes(id)) cancelled.push(id); }
      return { card_id: cardId, status: 'cancelled', cancelled_card_ids: cancelled };
    }
    const card = this.behavior.actorStore.read(cardId);
    if (!card) throw new Error(`Card '${cardId}' not found.`);
    if (!canCancelCardStatus(card.lifecycle.status)) throw new Error(`Card '${cardId}' in status '${card.lifecycle.status}' cannot be cancelled.`);
    if (card.lifecycle.status === 'running') throw new Error(`Running card '${cardId}' has no activation owner.`);
    const cancelled: string[] = []; await this.cancelNonrunningSubtree(cardId, cancelled); const halt = this.halt as RuntimeHalt | null; if (halt) throw halt.interruption; return { card_id: cardId, status: 'cancelled', cancelled_card_ids: cancelled };
  }

  private settleCancellation(owner: CardActivationOwner): Promise<CardCancellationResult> {
    if (owner.cancellationSettlement) return owner.cancellationSettlement;
    owner.cancellationSettlement = (async () => {
      this.requireOwnerAuthority(owner);
      try { await owner.processor.joinActivation(); } catch (error) { void this.beginHalt('runtime_failure').catch(() => undefined); throw error; }
      this.requireOwnerAuthority(owner);
      const cancelledDescendants: string[] = [];
      for (const childId of this.behavior.actorStore.listChildren(owner.cardId)) {
        this.requireOwnerAuthority(owner);
        if (!this.activationOwners.has(childId)) await this.cancelNonrunningSubtree(childId, cancelledDescendants, owner);
        this.requireOwnerAuthority(owner);
      }
      this.requireOwnerAuthority(owner);
      const written = this.publish(owner, () => owner.store.setStatus(owner.cardId, 'cancelled'));
      if (!written) return await owner.settlement.promise as never;
      this.requireOwnerAuthority(owner);
      owner.cachedStatus = 'cancelled';
      const outcome = { status: 'cancelled' as const, summary: owner.cancellationReason!.reason };
      if (owner.cardId === PROJECT_CARD_ID) this.releaseRootNaturally(owner, outcome as never); else this.releaseChildNaturally(owner, outcome);
      return { card_id: owner.cardId, status: 'cancelled', cancelled_card_ids: [...cancelledDescendants, owner.cardId] };
    })();
    return owner.cancellationSettlement;
  }

  private beginHalt(trigger: 'stop' | 'application_close' | 'publication_failure' | 'runtime_failure', publicationOwner?: CardActivationOwner, publicationFailure?: Error): Promise<void> {
    if (this.halt) {
      if (trigger === 'application_close') this.ownershipTransition(false, () => { this.applicationAdmissionOpen = false; });
      return this.halt.promise;
    }
    if (!this.runIdentity) throw new Error('Cannot halt a runtime without a run identity.');
    if (publicationOwner && this.activationOwners.get(publicationOwner.cardId) !== publicationOwner) throw new Error(`Card '${publicationOwner.cardId}' publication owner is no longer current.`);

    const owners = Object.freeze([...this.activationOwners.values()]);
    const interruption = new RuntimeStoppedInterruption();
    const settlement = deferred<void>();
    const halt: RuntimeHalt = Object.freeze({ interruption, owners, promise: settlement.promise });
    let firstFailure: unknown;
    let hasFailure = false;
    const retainFirst = (error: unknown): void => { if (!hasFailure) { hasFailure = true; firstFailure = error; } };

    this.ownershipTransition(true, () => {
      if (trigger === 'application_close') this.applicationAdmissionOpen = false;
      this.halt = halt;
      this.status = 'closing';
      this.runtimeGate.close();
      this.behavior.interventionBinding.markNotReady();
      this.preparedLaunch = null;
    });

    for (const owner of owners) {
      const lease = owner.parentRelationship?.invocation;
      if (lease && (lease.phase() === 'admitted' || lease.phase() === 'settling')) {
        try { lease.interrupt(interruption); } catch (error) { retainFirst(error); }
      }
      owner.settlement.reject(owner === publicationOwner && publicationFailure !== undefined ? publicationFailure : interruption);
    }
    for (const owner of owners) {
      try { owner.abortController.abort(interruption); } catch (error) { retainFirst(error); }
      try { owner.processor.disposeActivation(interruption); } catch (error) { retainFirst(error); }
    }

    const joins = owners.map((owner) => {
      try { return owner.processor.joinActivation(); }
      catch (error) { return Promise.reject(error); }
    });
    let processTermination: Promise<void>;
    try {
      processTermination = this.#processRunner.terminateScopeTree({
        rootScope: this.#runtimeProcessRootScope,
        categories: ['runtime_card'],
        reason: trigger === 'application_close' ? 'application stopping' : 'runtime stop',
        graceMs: 5000,
      }).then((report) => { if (report.failed.length !== 0) throw new Error('Runtime process-scope termination failed.'); });
    } catch (error) { processTermination = Promise.reject(error); }

    void Promise.allSettled([...joins, processTermination]).then((results) => {
      for (const result of results) if (result.status === 'rejected') retainFirst(result.reason);
      if (hasFailure) {
        try {
          this.ownershipTransition(true, () => {
            if (this.halt !== halt) throw new Error('Runtime halt identity changed during failed settlement.');
            this.status = 'error';
            this.behavior.interventionBinding.markNotReady();
          });
        } catch (error) {
          if (this.halt === halt) {
            this.status = 'error';
            this.behavior.interventionBinding.markNotReady();
          }
          retainFirst(error);
        }
        settlement.reject(firstFailure);
        return;
      }
      try {
        this.ownershipTransition(true, () => {
          if (this.halt !== halt) throw new Error('Runtime halt identity changed during settlement.');
          const currentOwners = [...this.activationOwners.values()];
          if (currentOwners.length !== owners.length || currentOwners.some((owner, index) => owner !== owners[index])) throw new Error('Runtime halt owner graph changed during settlement.');
          this.runtimeGate.completeRun();
          this.activationOwners.clear();
          this.preparedLaunch = null;
          this.runIdentity = null;
          this.currentCardId = null;
          this.halt = null;
          this.status = 'stopped';
          this.behavior.interventionBinding.markStoppedReady();
        });
        settlement.resolve();
      } catch (error) {
        if (this.halt === halt) {
          this.status = 'error';
          this.behavior.interventionBinding.markNotReady();
        }
        settlement.reject(error);
      }
    });
    return halt.promise;
  }

  private publish<T>(owner: CardActivationOwner, write: () => T): T | null {
    this.requireOwnerAuthority(owner);
    try {
      const result = write();
      if (this.halt?.owners.includes(owner)) return null;
      this.requireOwnerAuthority(owner);
      return result;
    } catch (error) {
      void this.beginHalt('publication_failure', owner, error as Error).catch(() => undefined);
      return null;
    }
  }

  private requirePreparation(owner: CardActivationOwner, identity: object): void { if (this.halt?.owners.includes(owner)) throw this.halt.interruption; if (this.runIdentity !== identity || this.activationOwners.get(PROJECT_CARD_ID) !== owner || owner.phase !== 'prepared_root' || owner.terminalWinner !== 'open' || this.halt || !this.applicationAdmissionOpen) throw new Error('Root preparation authority is no longer current.'); }
  private requireOwner(owner: CardActivationOwner): void { if (this.activationOwners.get(owner.cardId) !== owner) throw new Error(`Card '${owner.cardId}' activation owner is no longer current.`); }
  private requireOwnerAuthority(owner: CardActivationOwner): void {
    if (this.halt?.owners.includes(owner)) throw this.halt.interruption;
    this.requireOwner(owner);
    if (this.halt) throw new Error(`Card '${owner.cardId}' is outside the frozen runtime halt graph.`);
  }
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
      if (owner.parentRelationship) { const relationship = owner.parentRelationship; const parent = this.activationOwners.get(relationship.parentCardId); if (!parent || parent.childCardId !== id || owner.cardId !== relationship.invocation.childCardId) throw new Error('Activation relationship is not bidirectionally owned.'); const lease = relationship.invocation; if (lease.relationship.childCardId !== id || lease.relationship.sessionId !== lease.identity.sessionId || lease.relationship.sourceInputId !== lease.identity.sourceInputId || lease.relationship.toolCallId !== lease.identity.toolCallId || lease.relationship.toolName !== lease.identity.toolName) throw new Error('Activation relationship lease identity mismatch.'); }
      if (owner.childCardId) { const child = this.activationOwners.get(owner.childCardId); if (!child || child.parentRelationship?.parentCardId !== id) throw new Error('Activation child relationship is incomplete.'); }
      if (owner.phase === 'child_admission' && owner.terminalWinner !== 'open') throw new Error('Child admission cannot have a terminal winner.');
    }
    if (roots > 1) throw new Error('Runtime has more than one root activation owner.');
    const readiness = this.behavior.interventionBinding.interventionReadiness();
    if (this.status === 'stopped' && readiness !== 'stopped') throw new Error('Stopped runtime is not intervention-ready.');
    if (this.status === 'paused' && readiness !== 'paused') throw new Error('Paused runtime readiness disagrees.');
    if (this.status !== 'stopped' && this.status !== 'paused' && readiness !== 'not_ready') throw new Error(`Runtime '${this.status}' must not be intervention-ready.`);
    if (this.status === 'stopped' && (this.runIdentity || this.currentCardId || this.activationOwners.size || this.preparedLaunch || this.halt)) throw new Error('Stopped runtime retains ownership state.');
    if (this.runIdentity && !this.currentCardId) throw new Error('Active runtime has no current card.');
    if (this.halt && (this.status !== 'closing' && this.status !== 'error')) throw new Error('Runtime halt requires closing or error status.');
    if (this.halt && this.halt.owners.some((owner) => this.activationOwners.get(owner.cardId) !== owner)) throw new Error('Runtime halt owner graph is not installed.');
  }

  private ownershipInvalidated(sessionId?: import('../../schemas/index.js').ConversationSessionId): void { this.behavior.freshness.runtimeChanged(); this.behavior.freshness.agentsChanged(); if (sessionId) this.behavior.freshness.conversationChanged(sessionId); }
  private async cancelNonrunningSubtree(cardId: string, cancelled: string[], authority?: CardActivationOwner): Promise<void> { if (authority) this.requireOwnerAuthority(authority); else if (this.halt) throw this.halt.interruption; const owner = this.activationOwners.get(cardId); if (owner) { const result = await this.cancelOwnedOrStored(cardId, 'ancestor cancelled', null); if (authority) this.requireOwnerAuthority(authority); cancelled.push(...result.cancelled_card_ids); return; } const card = this.behavior.actorStore.read(cardId); if (!card || !canCancelCardStatus(card.lifecycle.status)) return; if (card.lifecycle.status === 'running') throw new Error(`Running card '${cardId}' has no activation owner.`); for (const childId of this.behavior.actorStore.listChildren(cardId)) { await this.cancelNonrunningSubtree(childId, cancelled, authority); if (authority) this.requireOwnerAuthority(authority); else if (this.halt) throw this.halt.interruption; } if (authority) this.requireOwnerAuthority(authority); else if (this.halt) throw this.halt.interruption; this.behavior.actorStore.setStatus(cardId, 'cancelled'); cancelled.push(cardId); }
}

export function createSupervisorRuntimeApi(options: SupervisorRuntimeApiOptions): SupervisorRuntimeApi { return new SupervisorRuntimeApi(options); }
function eligibleAgents(workflows: CompiledRuntimeWorkflows, card: CardRecord): readonly import('../../schemas/index.js').AgentName[] { const workflow=workflows.cardTypes.get(card.type);if(!workflow)throw new Error(`No compiled workflow for '${card.type}'.`);return [...new Set([...workflow.nodes.values()].map((node)=>node.agent.name))]; }
