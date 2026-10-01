import { randomUUID } from 'node:crypto';
import { cardAgentSessionId, type CardNotification, type CardRecord, type ConversationSessionId, type RuntimeState, type RuntimeStatus } from '../../schemas/index.js';
import { PROJECT_CARD_ID } from '../../cards/store-api.js';
import { acceptsCardNotifications, canCancelCardStatus } from '../../cards/status-api.js';
import { CardActivationOwner, type CardCancellationResult, type PlannerChildControlPort, type PlannerChildReopenResult } from './card-activation-owner.js';
import { CardProcessActor } from './card-process-actor.js';
import { toPublicCardActorState } from '../../schemas/index.js';
import type { ChildInvocationLease } from './child-invocation-wait.js';
import type { ActorRuntimeReadModel } from '../../application/index.js';
import type { NotificationSubmissionPort, NotificationSubmissionResult, NotifyCardResult, RuntimeApi, StartProjectResult, StopProjectResult } from '../runtime-api.js';
import { RuntimeGate } from '../runtime-gate.js';
import { selectLinkedRunningChain } from '../running-card-chain.js';
import type { LLMProviderPort, CompactorPort } from './llm-actor.js';
import type { AutonomousCompactionPolicy } from './compaction/compactor.js';
import type { SummarizerProviderPort } from './compaction/summarizer.js';
import type { CardService } from '../../cards/store-api.js';
import type { InterventionReadinessFacet } from '../../application/index.js';
import type { ProcessRunner } from '../process-runner.js';
import type { ManagedProcessScope } from '../managed-process-group-registry.js';
import type { PromptTemplateRegistry } from '../../utils/prompt-api.js';
import type { ExecutingLlmSnapshot } from './executing-llm-snapshot.js';
import type { ConversationFileContext } from '../../persistence/session-api.js';
import type { FreshnessEffects } from '../../application/index.js';
import type { McpToolInvocationPort } from '../../mcp/manager-api.js';
import { RuntimeStoppedInterruption } from './runtime-stopped-interruption.js';
import type { RuntimeProcessIdentity } from '../lock.js';
import { AnalystInterventionNotReadyError } from '../../application/index.js';
import { cardProcessEntryForStatus, type CompiledRuntimeWorkflows, type CardProcessEntry } from '../card-process/card-process-config.js';
import { stabilizeAgentSession } from './conversation-recovery.js';
import { TERMINAL_RESULT_TOOL_NAME } from '../../contracts/index.js';
import { cardParentId } from '../../schemas/index.js';
import { deferred } from './deferred.js';
import { PublicationOutcomeUnknownError, type ApplicationFatalPort } from '../../contracts/index.js';
import type { NotificationUrgency } from '../../contracts/index.js';
import { CardInterruptedError } from './card-interrupted-error.js';

interface SupervisorRuntimeApiOptions {
  projectRoot: string; now?: () => string;
  actorStore: CardService; provider: LLMProviderPort;
  conversations: ConversationFileContext; freshness: Pick<FreshnessEffects, 'runtimeChanged' | 'agentMembershipChanged'>;
  compactor: CompactorPort; compactionConfig: AutonomousCompactionPolicy; summarizerProvider: SummarizerProviderPort;
  processRunner: ProcessRunner; runtimeProcessRootScope: ManagedProcessScope; promptTemplates: PromptTemplateRegistry;
  workflows: CompiledRuntimeWorkflows;
  runtimeGate: RuntimeGate; mcpToolInvocation: McpToolInvocationPort;
  processIdentity: RuntimeProcessIdentity;
  fatalPort: ApplicationFatalPort;
  runtimeStatusChanged?(status:RuntimeStatus):void;
}

declare const supervisorLaunchPlanBrand: unique symbol;
interface SupervisorLaunchPlan { readonly [supervisorLaunchPlanBrand]: never; readonly owner: CardActivationOwner; readonly runIdentity: object }
interface RuntimeHalt {
  readonly trigger: 'stop' | 'application_close' | 'publication_failure' | 'runtime_failure';
  readonly interruption: RuntimeStoppedInterruption;
  readonly owners: readonly CardActivationOwner[];
  readonly promise: Promise<void>;
  readonly failure?: Error;
}

type InterruptedOwnerSettlement = Readonly<{ kind: 'completed' }> | Readonly<{ kind: 'taken_over'; halt: RuntimeHalt }>;

interface UrgentNodeCapture { readonly boundary: CardActivationOwner; readonly ordinal: number; readonly suffix: readonly CardActivationOwner[]; readonly leases: readonly ChildInvocationLease[]; readonly replaceRoot: boolean }
interface UrgentSelection {
  readonly capture: UrgentNodeCapture | null;
  readonly notices: readonly { readonly cardId: string; readonly childId: string; readonly childStatus: string }[];
  readonly conflictedOwner: boolean;
}

type SupervisorStatus = RuntimeStatus | 'uninitialized';

class SupervisorRuntimeApi implements RuntimeApi, InterventionReadinessFacet {
  private readonly behavior: Omit<SupervisorRuntimeApiOptions, 'processRunner' | 'runtimeProcessRootScope'>;
  readonly #processRunner: ProcessRunner;
  readonly #runtimeProcessRootScope: ManagedProcessScope;
  private readonly now: () => string;
  private readonly runtimeGate: RuntimeGate;
  private readonly activationOwners = new Map<string, CardActivationOwner>();
  private currentCardId: string | null = null;
  private status: SupervisorStatus = 'uninitialized';
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
    this.runtimeGate = behavior.runtimeGate;
  }

  async start(): Promise<void> {
    if (this.status !== 'uninitialized') return;
    this.runtimeGate.close();
    this.assertOwnershipInvariants();
    let runningChain: readonly CardRecord[];
    try { runningChain = selectLinkedRunningChain(this.behavior.actorStore); }
    catch (error) {
      throw new Error('Startup interrupted-card settlement: linked-chain selection failed.', { cause: error });
    }
    this.settleInterruptedRunningChain(runningChain, (write, operation) => {
      try { write(); return true; }
      catch (error) {
        if (error instanceof PublicationOutcomeUnknownError) this.behavior.fatalPort.publicationOutcomeUnknown(error);
        throw new Error(`Startup interrupted-card settlement: ${operation} failed.`, { cause: error });
      }
    });
    this.status = 'stopped';
    this.behavior.runtimeStatusChanged?.('stopped');
  }

  private settleInterruptedRunningChain(chain: readonly CardRecord[], publish: (write: () => void, operation: string) => boolean): boolean {
    // True means the operation completed and this caller still authorizes progression.
    // Startup returns true or throws; prepared Run may return false after failure or halt takeover.
    for (const card of [...chain].reverse()) {
      for (const agentName of eligibleAgents(this.behavior.workflows, card)) {
        const sessionId = cardAgentSessionId(agentName, card.id);
        if (!publish(() => { stabilizeAgentSession({ sessionId, conversations: this.behavior.conversations, terminalToolNames: new Set([TERMINAL_RESULT_TOOL_NAME]) }); }, `configured session '${sessionId}'`)) return false;
      }
      if (!publish(() => { this.behavior.actorStore.stopRunning(card.id); }, `card '${card.id}' stopped publication`)) return false;
    }
    return true;
  }

  assertInterventionReady(): void {
    const status = this.status;
    switch (status) {
      case 'stopped':
      case 'paused':
        return;
      case 'uninitialized':
      case 'starting':
      case 'running':
      case 'pausing':
      case 'closing':
      case 'error':
        throw new AnalystInterventionNotReadyError();
    }
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
      try { termination = this.#processRunner.terminateScopeTree({ rootScope: this.#runtimeProcessRootScope, categories: ['runtime_card'], reason: 'application stopping' }); }
      catch (error) { termination = Promise.reject(error); }
      return termination.then((report) => { if (report.failed.length) throw new Error('Runtime application cleanup failed.'); });
    }
    return this.applicationCleanupTask.catch((error) => { throw new Error('Runtime application cleanup failed.', { cause: error }); });
  }

  stopProject(): Promise<StopProjectResult> {
    if (!this.runIdentity && !this.halt) {
      const status = this.publicRuntimeStatus();
      if (status !== 'stopped') throw new Error(`Inactive runtime has unexpected '${status}' status.`);
      return Promise.resolve({ status, contained: false });
    }
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
    const runIdentity = {};
    const owner = this.createOwner(root, entry, 'prepared_root');
    const launch = Object.freeze({ owner, runIdentity }) as SupervisorLaunchPlan;
    this.ownershipTransition(true, () => {
      this.runIdentity = runIdentity;
      this.preparedLaunch = launch;
      this.status = 'starting';
      this.currentCardId = PROJECT_CARD_ID;
      this.activationOwners.set(PROJECT_CARD_ID, owner);
    });

    if (!this.settleInterruptedRunningChain(runningChain, (write) => {
      this.requirePreparation(owner, runIdentity);
      return this.publish(owner, () => { write(); return true; }) !== null;
    })) return await owner.settlement.promise.then(() => { throw new Error('Prepared root unexpectedly settled.'); });
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
    this.ownershipTransition(true, () => { this.status = 'pausing'; });
    this.runtimeGate.requestPause(() => {
      if (this.halt) return;
      if (this.runIdentity !== identity || this.status !== 'pausing' || !this.activationOwners.has(PROJECT_CARD_ID)) return;
      this.ownershipTransition(true, () => { this.status = 'paused'; });
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
    });
  }

  notifyCard(cardId: string, notification: CardNotification): NotifyCardResult {
    const card = this.behavior.actorStore.read(cardId);
    if (!card) return { ok: false, reason: 'missing_card', cardId };
    if (!acceptsCardNotifications(card.lifecycle.status)) return { ok: false, reason: 'terminal_card', cardId, status: card.lifecycle.status as 'done' | 'failed' | 'cancelled' };
    const owner = this.activationOwners.get(cardId);
    if (owner && owner.terminalWinner !== 'open') return { ok: false, reason: 'activation_closed', cardId };
    this.behavior.actorStore.enqueueNotification(cardId, notification);
    return { ok: true, notificationId: notification.id };
  }

  submitNotification(cardId: string, notification: CardNotification, urgency: NotificationUrgency, signal?: AbortSignal): Promise<NotificationSubmissionResult> {
    return this.submitNotificationWithAdmission(cardId, notification, urgency, signal, () => null);
  }

  private async submitNotificationWithAdmission(cardId: string, notification: CardNotification, urgency: NotificationUrgency, signal: AbortSignal | undefined, admitCaller: () => CardActivationOwner | null): Promise<NotificationSubmissionResult> {
    const submittingOwner = admitCaller();
    const targetCard = this.behavior.actorStore.read(cardId);
    if (!targetCard) return { queued: false, reason: 'missing_card', cardId };
    const selection = urgency === 'urgent' ? this.selectUrgentRoute(cardId) : null;
    if (submittingOwner && (this.activationOwners.get(submittingOwner.cardId) !== submittingOwner || submittingOwner.phase !== 'active' || submittingOwner.terminalWinner !== 'open'))
      throw new Error('Notification caller ownership changed before enqueue.');
    let queued: NotifyCardResult;
    try {
      queued = this.notifyCard(cardId, notification);
    } catch (error) {
      if (error instanceof PublicationOutcomeUnknownError) this.behavior.fatalPort.publicationOutcomeUnknown(error);
      throw error;
    }
    if (!queued.ok) {
      const { ok: _ok, ...denied } = queued;
      return { ...denied, queued: false };
    }
    if (selection === null) return { queued: true, cardId, notificationId: queued.notificationId, interruption: { status: 'not_requested' } };
    for (const notice of selection.notices) {
      const parentNote = { id: randomUUID(), content: `Urgent notification '${notification.id}' for descendant '${cardId}' needs attention through immediate child '${notice.childId}' (currently ${notice.childStatus}). Consider ordinary child activation${notice.childStatus === 'done' || notice.childStatus === 'failed' ? ' after discretionary reopening if appropriate' : ''}; the workflow may decline.`, created_at: this.now(), source: 'supervisor' };
      try { this.notifyCard(notice.cardId, parentNote); }
      catch (error) { if (error instanceof PublicationOutcomeUnknownError) this.behavior.fatalPort.publicationOutcomeUnknown(error); throw error; }
    }
    const capture = selection.capture;
    if (!capture) return { queued: true, cardId, notificationId: queued.notificationId, interruption: selection.conflictedOwner ? { status: 'suppressed', reason: 'stale_owner', stopped_card_ids: [] } : { status: 'not_applicable' } };
    if (signal?.aborted) return { queued: true, cardId, notificationId: queued.notificationId, interruption: { status: 'suppressed', reason: 'cancelled', stopped_card_ids: [] } };
    if (this.status !== 'running' || !this.applicationAdmissionOpen || this.halt)
      return { queued: true, cardId, notificationId: queued.notificationId, interruption: { status: 'suppressed', reason: 'runtime_ineligible', stopped_card_ids: [] } };
    if (!this.urgentNodeIsCurrent(capture))
      return { queued: true, cardId, notificationId: queued.notificationId, interruption: { status: 'suppressed', reason: 'stale_owner', stopped_card_ids: [] } };
    const boundary = capture.boundary;
    const interruption = new CardInterruptedError(`Interrupted current node after urgent notification '${notification.id}' for '${cardId}'.`);
    const completion = deferred<void>();
    void completion.promise.catch(() => undefined);
    const completed: string[] = [];
    let takenOver = false;
    try {
      // Install node/suffix winners and the same settlement before cancellation or invalidation.
      // Supervisor owns tree authority; the processor owns captured retiring node resources.
      this.ownershipTransition(false, () => {
        if (!this.urgentNodeIsCurrent(capture)) throw new Error('Urgent notification ownership changed during interruption claim.');
        if (capture.replaceRoot) { boundary.terminalWinner = 'interrupt'; boundary.phase = 'settling'; }
        else boundary.processor.claimNodeInterruption(capture.ordinal, completion.promise, interruption);
        boundary.urgentSettlement = completion.promise;
        for (const owner of capture.suffix) {
          owner.terminalWinner = 'interrupt';
          owner.phase = 'settling';
          owner.parentRelationship!.invocation.markSettling();
        }
      });
    } catch (error) {
      void this.beginHalt('runtime_failure').catch(() => undefined);
      throw error;
    }
    const task = (async () => {
      try {
        for (const owner of capture.suffix) owner.processor.interruptActivationGracefully(interruption);
        if (capture.replaceRoot) boundary.processor.interruptActivationGracefully(interruption);
        else boundary.processor.interruptClaimedNodeGracefully();
        this.ownershipInvalidated();
        for (const owner of [...capture.suffix].reverse()) {
          const result = await this.settleInterruptedOwner(owner, interruption);
          if (result.kind === 'taken_over') {
            if (result.halt.trigger !== 'stop' && result.halt.trigger !== 'application_close') throw result.halt.failure ?? result.halt.interruption;
            takenOver = true;
            completion.resolve();
            return;
          }
          completed.push(owner.cardId);
        }
        if (capture.replaceRoot) {
          const rootResult = await this.settleInterruptedOwner(boundary, interruption);
          if (rootResult.kind === 'taken_over') {
            if (rootResult.halt.trigger !== 'stop' && rootResult.halt.trigger !== 'application_close') throw rootResult.halt.failure ?? rootResult.halt.interruption;
            takenOver = true;
            completion.resolve();
            return;
          }
          completed.push(PROJECT_CARD_ID);
          if (!this.replaceInterruptedRoot(boundary, completion.promise)) { takenOver = true; completion.resolve(); return; }
        } else {
          // Never join the surviving activation/current guarded task: it awaits completion below.
          await boundary.processor.joinInterruptedNode();
          if (this.haltFor(boundary)) takenOver = true;
          else this.requireOwnerAuthority(boundary);
        }
        completion.resolve();
      } catch (error) {
        if (error instanceof PublicationOutcomeUnknownError) this.behavior.fatalPort.publicationOutcomeUnknown(error);
        void this.beginHalt('runtime_failure').catch(() => undefined);
        completion.reject(error);
      } finally {
        boundary.urgentSettlement = null;
        const currentRoot = this.activationOwners.get(PROJECT_CARD_ID);
        if (currentRoot?.urgentSettlement === completion.promise) currentRoot.urgentSettlement = null;
      }
    })();
    void task.catch((error) => { completion.reject(error); void this.beginHalt('runtime_failure').catch(() => undefined); });
    if (submittingOwner === boundary || (submittingOwner && capture.suffix.includes(submittingOwner))) return { queued: true, cardId, notificationId: queued.notificationId, interruption: { status: 'pending_tool_settlement' } };
    await completion.promise;
    return { queued: true, cardId, notificationId: queued.notificationId, interruption: takenOver ? { status: 'suppressed', reason: 'runtime_ineligible', stopped_card_ids: completed } : { status: 'interrupted', stopped_card_ids: completed } };
  }

  cancelCard(cardId: string, reason: string): Promise<CardCancellationResult> { return this.cancelOwnedOrStored(cardId, reason, null); }
  getStatus() { return { status: this.publicRuntimeStatus(), currentCardId: this.currentCardId, pid: this.behavior.processIdentity.pid, startedAt: this.behavior.processIdentity.startedAt }; }
  getRuntimeState(): RuntimeState | null { return this.runtimeState(); }
  captureAutonomousExecutingLlmSnapshots(): ReadonlyMap<ConversationSessionId, ExecutingLlmSnapshot> {
    const snapshots = new Map<ConversationSessionId, ExecutingLlmSnapshot>();
    for (const owner of this.activationOwners.values()) {
      const snapshot = owner.processor.executingLlmSnapshot();
      if (snapshot) snapshots.set(snapshot.sessionId, snapshot);
    }
    return snapshots;
  }
  getActorRuntimeReadModel(): ActorRuntimeReadModel {
    const cards = [...this.activationOwners.values()].map((owner) => ({ cardId: owner.cardId, actorState: toPublicCardActorState(owner.cachedStatus), processState: owner.processor.processPosition() }));
    return { pauseMode: this.status === 'running' ? 'running' : this.status === 'paused' ? 'paused' : 'idle', cards };
  }
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
      reopenChild: ({ childCardId }: { childCardId: string }) => this.reopenChild(requireParent(), childCardId),
    });
  }

  private reopenChild(parent: CardActivationOwner, childCardId: string): PlannerChildReopenResult {
    this.requireOwnerAuthority(parent);
    if (parent.phase !== 'active' || parent.terminalWinner !== 'open' || !this.applicationAdmissionOpen) throw new Error(`Parent activation '${parent.cardId}' is closed to child reopening.`);
    if (cardParentId(childCardId) !== parent.cardId) throw new Error(`reopen_card can target only immediate children of '${parent.cardId}'.`);
    if (this.activationOwners.has(childCardId)) throw new Error(`Child '${childCardId}' still has an activation owner.`);
    const child = this.behavior.actorStore.read(childCardId);
    if (!child) throw new Error(`Child card '${childCardId}' not found.`);
    if (child.lifecycle.status !== 'done' && child.lifecycle.status !== 'failed') throw new Error(`Card '${childCardId}' in status '${child.lifecycle.status}' cannot be reopened.`);
    this.requireOwnerAuthority(parent);
    if (parent.phase !== 'active' || parent.terminalWinner !== 'open' || !this.applicationAdmissionOpen) throw new Error(`Parent activation '${parent.cardId}' is closed to child reopening.`);
    const changed = this.publish(parent, () => this.behavior.actorStore.setStatus(childCardId, 'changed'));
    if (changed === null) {
      this.requireOwnerAuthority(parent);
      throw new Error('Child reopening publication returned no result without stopping the runtime.');
    }
    return { card_id: childCardId, status: 'changed' };
  }

  private activateChild(parent: CardActivationOwner, childCardId: string, lease: ChildInvocationLease): Promise<import('../../contracts/tool-api.js').CardActivationOutcome> {
    if (this.halt?.owners.includes(parent)) return this.rejectLease(lease, this.halt.interruption);
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
    this.assertDurableParentRunning(parent, admission.child);
    const incomplete = admission.dependencies.filter(({ status }) => status !== 'done');
    if (incomplete.length) return this.rejectLease(lease, new Error(`Child card '${childCardId}' has incomplete dependencies: ${incomplete.map(({ id, status }) => `${id} (${status})`).join(', ')}.`));
    const entry = cardProcessEntryForStatus(admission.child.lifecycle.status);
    if (entry === null) return this.rejectLease(lease, new Error(`Card '${childCardId}' in status '${admission.child.lifecycle.status}' is not activatable.`));
    const relationship = Object.freeze({ parentCardId: parent.cardId, invocation: lease });
    const owner = this.createOwner(admission.child, entry, 'child_admission', relationship);
    this.ownershipTransition(true, () => {
      this.requireOwnerAuthority(parent);
      this.activationOwners.set(childCardId, owner); parent.childCardId = childCardId; lease.markAdmitted();
    });
    const running = this.publish(owner, () => admission.child.lifecycle.status === 'stopped' ? this.behavior.actorStore.activateStopped(childCardId) : this.behavior.actorStore.setStatus(childCardId, 'running'));
    if (!running) return lease.activation;
    if (this.halt?.owners.includes(owner)) return lease.activation;
    this.ownershipTransition(true, () => { this.requireOwnerAuthority(owner); owner.phase = 'active'; owner.cachedStatus = 'running'; this.currentCardId = childCardId; });
    if (this.halt?.owners.includes(owner)) return lease.activation;
    this.activateProcessor(owner);
    return lease.activation;
  }

  private rejectLease(lease: ChildInvocationLease, error: Error): Promise<never> {
    lease.markRejected(); lease.deliverInterruption(error); return lease.activation as Promise<never>;
  }

  private createOwner(card: CardRecord, entry: CardProcessEntry, phase: 'prepared_root' | 'child_admission', relationship?: CardActivationOwner['parentRelationship']): CardActivationOwner {
    const activationId = randomUUID();
    const parentControl = this.boundParentControl(card.id, activationId);
    const submitNotification: NotificationSubmissionPort = (id, notification, urgency, signal) => this.submitNotificationWithAdmission(id, notification, urgency, signal, () => {
      const owner = this.activationOwners.get(card.id);
      if (!owner || owner.activationId !== activationId || owner.phase !== 'active' || owner.terminalWinner !== 'open' || this.halt || !this.applicationAdmissionOpen)
        throw new Error(`Card activation '${card.id}' is closed to notification submission.`);
      return owner;
    });
    const process = this.behavior.workflows.cardTypes.get(card.type);
    if (!process) throw new Error(`No compiled workflow for card type '${card.type}'.`);
    const processor = new CardProcessActor({ projectRoot: this.behavior.projectRoot, cardId: card.id, process, workflows:this.behavior.workflows, store: this.behavior.actorStore, parentControl, notifyCard: (id, notification) => this.notifyCard(id, notification), submitNotification, provider: this.behavior.provider, conversations: this.behavior.conversations, processRunner: this.#processRunner, runtimeProcessRootScope: this.#runtimeProcessRootScope, promptTemplates: this.behavior.promptTemplates, runtimeProjectionChanged: () => { this.ownershipInvalidated(); this.behavior.freshness.agentMembershipChanged({ scope: 'card', cardId: card.id }); }, onActorMainFailure: (error) => this.onProcessorActorMainFailure(card.id, activationId, error), fatalPort: this.behavior.fatalPort, gate: this.runtimeGate, mcpToolInvocation: this.behavior.mcpToolInvocation, compactor: this.behavior.compactor, compactionConfig: this.behavior.compactionConfig, summarizerProvider: this.behavior.summarizerProvider });
    processor.start();
    return new CardActivationOwner({ card, processor, activationId, entry, phase, parentRelationship: relationship ?? undefined });
  }

  private activateProcessor(owner: CardActivationOwner): void {
    this.requireOwnerAuthority(owner);
    if (owner.phase !== 'active') return;
    const caller = owner.parentRelationship === null
      ? { kind: 'root' as const }
      : { kind: 'parent' as const, cardId: owner.parentRelationship.parentCardId, sessionId: owner.parentRelationship.invocation.identity.sessionId };
    const input = { activationId: owner.activationId, card: this.requireKnownCard(owner), caller, entry: owner.entry, notificationDelivery: { hasPendingNotifications: () => { this.requireOwnerAuthority(owner); return this.requireKnownCard(owner).pending_notifications.length > 0; }, selectNotifications: () => { this.requireOwnerAuthority(owner); return this.requireKnownCard(owner).pending_notifications; }, removeNotifications: (ids: readonly string[]) => { this.requireOwnerAuthority(owner); this.behavior.actorStore.removeNotifications(owner.cardId, [...ids]); } }, claimResult: () => this.claimResult(owner) };
    void owner.processor.activate(input, owner.abortController.signal).then((outcome) => {
      void this.settleResult(owner, outcome).catch((error: Error) => this.haltOnSettlementFailure(owner, error));
    }, (error) => {
      if (this.halt?.owners.includes(owner) || owner.terminalWinner === 'cancel' || owner.terminalWinner === 'interrupt') return;
      if (error instanceof PublicationOutcomeUnknownError) {
        this.behavior.fatalPort.publicationOutcomeUnknown(error);
      }
      const message = error instanceof Error ? error.message : String(error);
      void this.settleResult(owner, { status: 'failed', summary: message, result: { kind: 'runtime-failure', summary: message } }).catch((settlementError: Error) => this.haltOnSettlementFailure(owner, settlementError));
    });
  }

  private haltOnSettlementFailure(owner: CardActivationOwner, error: Error): void {
    const halt = this.halt;
    if (halt?.owners.includes(owner)) {
      void halt.promise.catch(() => undefined);
      return;
    }
    if (this.activationOwners.get(owner.cardId) === owner) {
      void this.beginHalt('runtime_failure', owner, error).catch(() => undefined);
      return;
    }
    if (!this.runIdentity && !this.halt) return;
    void this.beginHalt('runtime_failure').catch(() => undefined);
  }

  private onProcessorActorMainFailure(cardId: string, activationId: string, _error: unknown): void {
    const owner = this.activationOwners.get(cardId);
    const halt = this.halt;
    if (halt) {
      if (!owner || owner.activationId !== activationId || !halt.owners.includes(owner)) throw new Error(`Card '${cardId}' actor-main failure has no owner in the current runtime halt.`);
      void halt.promise.catch(() => undefined);
      return;
    }
    if (!owner || owner.activationId !== activationId) throw new Error(`Card '${cardId}' actor-main failure owner is no longer current.`);
    if (owner.terminalWinner === 'interrupt') return;
    void this.beginHalt('runtime_failure').catch(() => undefined);
  }

  private claimResult(owner: CardActivationOwner): void {
    this.requireOwnerAuthority(owner);
    owner.abortController.signal.throwIfAborted();
    if (owner.terminalWinner !== 'open') throw new Error(`Card '${owner.cardId}' terminal winner is '${owner.terminalWinner}'.`);
    owner.terminalWinner = 'result';
  }

  private async settleResult(owner: CardActivationOwner, outcome: Exclude<import('../../contracts/tool-api.js').CardActivationOutcome, { status: 'cancelled' | 'stopped' }>): Promise<void> {
    if (this.halt?.owners.includes(owner)) return;
    this.requireOwnerAuthority(owner);
    if (owner.terminalWinner === 'cancel') return;
    this.assertNoOwnedChildAtResultSettlement(owner);
    if (owner.cardId === PROJECT_CARD_ID) {
      const chain = selectLinkedRunningChain(this.behavior.actorStore);
      if (chain.length !== 1 || chain[0]!.id !== PROJECT_CARD_ID) throw new Error("Natural root settlement requires the durable running chain to be exactly ['project'].");
    }
    this.ownershipTransition(true, () => {
      this.requireOwnerAuthority(owner);
      if (owner.terminalWinner === 'open') owner.terminalWinner = 'result';
      if (owner.terminalWinner !== 'result') throw new Error(`Card '${owner.cardId}' cannot settle result from '${owner.terminalWinner}'.`);
      owner.phase = 'settling';
      if (owner.parentRelationship?.invocation.phase() === 'admitted') owner.parentRelationship.invocation.markSettling();
    });
    const committed = this.publish(owner, () => this.behavior.actorStore.commitActivationOutcome(owner.cardId, outcome, this.now()));
    if (!committed) return;
    if (this.halt?.owners.includes(owner)) return;
    this.requireOwnerAuthority(owner);
    owner.cachedStatus = committed.lifecycle.status;
    owner.processor.suppressContinuationAndPrepareJoin(new Error('Activation settled.'));
    try { await owner.processor.joinActivation(); } catch { void this.beginHalt('runtime_failure').catch(() => undefined); return; }
    if (this.halt?.owners.includes(owner)) return;
    this.requireOwnerAuthority(owner);
    if (owner.cardId === PROJECT_CARD_ID) this.releaseRootNaturally(owner, outcome);
    else this.releaseChildNaturally(owner, outcome);
  }

  private releaseChildNaturally(owner: CardActivationOwner, outcome: import('../../contracts/tool-api.js').CardActivationOutcome): void {
    const relationship = owner.parentRelationship!; const lease = relationship.invocation;
    this.ownershipTransition(true, () => {
      this.requireOwnerAuthority(owner); const parent = this.activationOwners.get(relationship.parentCardId); if (!parent || parent.childCardId !== owner.cardId) throw new Error('Parent relationship changed before child release.');
      this.activationOwners.delete(owner.cardId); parent.childCardId = null; this.currentCardId = parent.cardId; lease.markReleased();
    });
    owner.settlement.resolve(outcome); lease.deliverOutcome(outcome);
  }

  private releaseRootNaturally(owner: CardActivationOwner, outcome: Exclude<import('../../contracts/tool-api.js').CardActivationOutcome, { status: 'cancelled' | 'stopped' }>): void {
    this.requireOwnerAuthority(owner);
    if (this.status !== 'running' && this.status !== 'pausing' && this.status !== 'paused') throw new Error(`Root cannot naturally release from '${this.status}'.`);
    this.ownershipTransition(true, () => {
      this.requireOwnerAuthority(owner);
      this.runtimeGate.completeRun(); this.activationOwners.delete(PROJECT_CARD_ID); this.preparedLaunch = null; this.runIdentity = null; this.currentCardId = null; this.status = 'stopped';
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
      if (owner.terminalWinner === 'cancel' && owner.cancellationSettlement) return owner.cancellationSettlement;
      const suffix: CardActivationOwner[] = []; let current: CardActivationOwner | undefined = owner;
      while (current) { suffix.push(current); current = current.childCardId ? this.activationOwners.get(current.childCardId) : undefined; if (suffix.at(-1)!.childCardId && !current) throw new Error('Owned child relationship has no owner.'); }
      const cancelReason = { reason, cancelled_at: this.now() };
      this.ownershipTransition(true, () => {
        for (const item of suffix) {
          this.requireOwnerAuthority(item);
          if (item.phase !== 'active') throw new Error(`Card '${item.cardId}' cannot be cancelled while activation ownership is '${item.phase}'.`);
          if (item.terminalWinner !== 'open') throw new Error(`Card '${item.cardId}' ${item.terminalWinner} already claimed the activation.`);
          if (item.parentRelationship && item.parentRelationship.invocation.phase() !== 'admitted')
            throw new Error(`Card '${item.cardId}' child admission is not open for cancellation.`);
        }
        for (const item of suffix) {
          item.terminalWinner = 'cancel'; item.phase = 'settling'; item.cancellationReason = cancelReason;
          if (item.parentRelationship) item.parentRelationship.invocation.markSettling();
        }
      });
      for (const item of suffix) { const cancellation = new Error(reason); item.abortController.abort(cancellation); item.processor.disposeActivation(cancellation); }
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

  private selectUrgentRoute(cardId: string): UrgentSelection {
    const notices: { cardId: string; childId: string; childStatus: string }[] = [];
    let boundary: CardActivationOwner | null = null;
    let conflictedOwner = false;
    if (cardId === PROJECT_CARD_ID) {
      const root = this.activationOwners.get(PROJECT_CARD_ID);
      if (!root) return { capture: null, notices, conflictedOwner: false };
      if (root.phase !== 'active' || root.terminalWinner !== 'open') return { capture: null, notices, conflictedOwner: true };
      boundary = root;
    }
    let childId = cardId;
    for (let parentId = cardParentId(childId); parentId !== null; parentId = cardParentId(childId)) {
      const child = this.behavior.actorStore.read(childId);
      const parent = this.behavior.actorStore.read(parentId);
      if (!child || !parent || !parent.child_membership.includes(childId)) throw new Error(`Urgent notification path '${parentId}' -> '${childId}' is not committed.`);
      const owner = this.activationOwners.get(parentId);
      if (owner && (owner.phase !== 'active' || owner.terminalWinner !== 'open')) conflictedOwner = true;
      if (acceptsCardNotifications(parent.lifecycle.status) && parent.lifecycle.status !== 'blocked' && (!owner || (owner.phase === 'active' && owner.terminalWinner === 'open'))) {
        notices.push({ cardId: parentId, childId, childStatus: child.lifecycle.status });
        if (owner && parent.lifecycle.status === 'running') { boundary = owner; break; }
      }
      childId = parentId;
    }
    if (!boundary) return { capture: null, notices, conflictedOwner };
    const suffix: CardActivationOwner[] = [];
    const leases: ChildInvocationLease[] = [];
    let activeChildId = boundary.childCardId;
    while (activeChildId !== null) {
      const child = this.activationOwners.get(activeChildId);
      if (!child || !child.parentRelationship) throw new Error('Owned urgent descendant relationship is incomplete.');
      suffix.push(child);
      leases.push(child.parentRelationship.invocation);
      activeChildId = child.childCardId;
    }
    const position = boundary.processor.processPosition();
    if (position.kind !== 'node') return { capture: null, notices, conflictedOwner: true };
    return { capture: { boundary, ordinal: position.executionOrdinal, suffix, leases, replaceRoot: cardId === PROJECT_CARD_ID }, notices, conflictedOwner };
  }

  private urgentNodeIsCurrent(capture: UrgentNodeCapture): boolean {
    const { boundary, ordinal } = capture;
    return this.activationOwners.get(boundary.cardId) === boundary && boundary.phase === 'active' && boundary.terminalWinner === 'open' && boundary.processor.canInterruptNode(ordinal) && capture.suffix.every((owner, index) => this.activationOwners.get(owner.cardId) === owner && owner.phase === 'active' && owner.terminalWinner === 'open' && owner.parentRelationship?.invocation === capture.leases[index] && capture.leases[index]!.phase() === 'admitted' && (index === 0 ? boundary.childCardId === owner.cardId : capture.suffix[index - 1]!.childCardId === owner.cardId) && owner.childCardId === (capture.suffix[index + 1]?.cardId ?? null));
  }

  private async settleInterruptedOwner(owner: CardActivationOwner, interruption: CardInterruptedError): Promise<InterruptedOwnerSettlement> {
    const beforeJoinHalt = this.haltFor(owner);
    if (beforeJoinHalt) return { kind: 'taken_over', halt: beforeJoinHalt };
    this.requireOwnerAuthority(owner);
    try { await owner.processor.joinActivation(); }
    catch (error) {
      if (error instanceof PublicationOutcomeUnknownError) this.behavior.fatalPort.publicationOutcomeUnknown(error);
      void this.beginHalt('runtime_failure').catch(() => undefined);
      throw error;
    }
    const afterJoinHalt = this.haltFor(owner);
    if (afterJoinHalt) return { kind: 'taken_over', halt: afterJoinHalt };
    this.requireOwnerAuthority(owner);
    const stopped = this.publish(owner, () => this.behavior.actorStore.stopRunning(owner.cardId));
    if (!stopped) {
      const halt = this.halt;
      if (!halt) throw new Error(`Interrupted card '${owner.cardId}' stop publication returned no result without a runtime halt.`);
      if (halt.trigger === 'publication_failure') throw halt.failure ?? halt.interruption;
      return { kind: 'taken_over', halt };
    }
    const afterPublicationHalt = this.haltFor(owner);
    if (afterPublicationHalt) return { kind: 'taken_over', halt: afterPublicationHalt };
    this.requireOwnerAuthority(owner);
    owner.cachedStatus = 'stopped';
    const relationship = owner.parentRelationship;
    if (!relationship) return { kind: 'completed' };
    const outcome = { status: 'stopped' as const, summary: interruption.message };
    this.ownershipTransition(false, () => {
      this.requireOwnerAuthority(owner);
      const parent = this.activationOwners.get(relationship.parentCardId);
      if (!parent || parent.childCardId !== owner.cardId) throw new Error('Interrupted child relationship changed before release.');
      this.activationOwners.delete(owner.cardId);
      parent.childCardId = null;
      this.currentCardId = parent.cardId;
      relationship.invocation.markReleased();
    });
    owner.settlement.resolve(outcome);
    relationship.invocation.deliverOutcome(outcome);
    this.ownershipInvalidated();
    return { kind: 'completed' };
  }

  private replaceInterruptedRoot(old: CardActivationOwner, settlement: Promise<void>): CardActivationOwner | null {
    this.requireOwnerAuthority(old);
    const stopped = this.requireKnownCard(old);
    const replacement = this.createOwner(stopped, 'STOPPED', 'prepared_root');
    this.ownershipTransition(false, () => {
      this.requireOwnerAuthority(old);
      replacement.urgentSettlement = settlement;
      this.activationOwners.set(PROJECT_CARD_ID, replacement);
    });
    old.settlement.resolve({ status: 'stopped', summary: 'Urgent root interruption.' });
    const running = this.publish(replacement, () => this.behavior.actorStore.activateStopped(PROJECT_CARD_ID));
    if (!running) return null;
    if (this.haltFor(replacement)) return null;
    this.ownershipTransition(true, () => {
      this.requireOwnerAuthority(replacement);
      replacement.phase = 'active';
      replacement.cachedStatus = 'running';
    });
    if (this.haltFor(replacement)) return null;
    this.activateProcessor(replacement);
    return replacement;
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
      const written = this.publish(owner, () => this.behavior.actorStore.setStatus(owner.cardId, 'cancelled'));
      if (!written) return await owner.settlement.promise as never;
      this.requireOwnerAuthority(owner);
      owner.cachedStatus = 'cancelled';
      const outcome = { status: 'cancelled' as const, summary: owner.cancellationReason!.reason };
      if (owner.cardId === PROJECT_CARD_ID) this.releaseRootNaturally(owner, outcome as never); else this.releaseChildNaturally(owner, outcome);
      return { card_id: owner.cardId, status: 'cancelled', cancelled_card_ids: [...cancelledDescendants, owner.cardId] };
    })();
    return owner.cancellationSettlement;
  }

  private beginHalt(trigger: 'stop' | 'application_close' | 'publication_failure' | 'runtime_failure', failureOwner?: CardActivationOwner, failure?: Error): Promise<void> {
    if (this.halt) {
      if (trigger === 'application_close') this.ownershipTransition(false, () => { this.applicationAdmissionOpen = false; });
      return this.halt.promise;
    }
    if (!this.runIdentity) throw new Error('Cannot halt a runtime without a run identity.');
    if (failureOwner && this.activationOwners.get(failureOwner.cardId) !== failureOwner) throw new Error(`Card '${failureOwner.cardId}' failure owner is no longer current.`);

    const owners = Object.freeze([...this.activationOwners.values()]);
    const interruption = new RuntimeStoppedInterruption();
    const settlement = deferred<void>();
    const halt: RuntimeHalt = Object.freeze({ trigger, interruption, owners, promise: settlement.promise, ...(failure ? { failure } : {}) });
    let firstFailure: unknown;
    let hasFailure = false;
    const retainFirst = (error: unknown): void => { if (!hasFailure) { hasFailure = true; firstFailure = error; } };

    this.ownershipTransition(true, () => {
      if (trigger === 'application_close') this.applicationAdmissionOpen = false;
      this.halt = halt;
      this.status = 'closing';
      this.runtimeGate.close();
      this.preparedLaunch = null;
    });

    for (const owner of owners) {
      const lease = owner.parentRelationship?.invocation;
      if (lease && (lease.phase() === 'admitted' || lease.phase() === 'settling')) {
        try { lease.interrupt(interruption); } catch (error) { retainFirst(error); }
      }
      owner.settlement.reject(owner === failureOwner && failure !== undefined ? failure : interruption);
    }
    for (const owner of owners) try { owner.processor.prepareForRuntimeHalt(interruption); } catch (error) { retainFirst(error); }
    for (const owner of owners) try { owner.abortController.abort(interruption); } catch (error) { retainFirst(error); }

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
      }).then((report) => { if (report.failed.length !== 0) throw new Error('Runtime process-scope termination failed.'); });
    } catch (error) { processTermination = Promise.reject(error); }

    // Halt joins current and retiring processor ownership plus captured urgent settlement.
    // Urgent settlement may observe takeover, but must never await this encompassing halt.
    void Promise.allSettled([...joins, ...owners.flatMap((owner) => owner.urgentSettlement ? [owner.urgentSettlement] : []), processTermination]).then((results) => {
      for (const result of results) if (result.status === 'rejected') retainFirst(result.reason);
      if (hasFailure) {
        try {
          this.ownershipTransition(true, () => {
            if (this.halt !== halt) throw new Error('Runtime halt identity changed during failed settlement.');
            this.status = 'error';
          });
        } catch (error) {
          if (this.halt === halt) {
            this.status = 'error';
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
        });
        for (const owner of owners)
          this.behavior.freshness.agentMembershipChanged({ scope: 'card', cardId: owner.cardId });
        settlement.resolve();
      } catch (error) {
        if (this.halt === halt) {
          this.status = 'error';
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
      if (error instanceof PublicationOutcomeUnknownError) this.behavior.fatalPort.publicationOutcomeUnknown(error);
      void this.beginHalt('publication_failure', owner, error as Error).catch(() => undefined);
      return null;
    }
  }

  private requirePreparation(owner: CardActivationOwner, identity: object): void { if (this.halt?.owners.includes(owner)) throw this.halt.interruption; if (this.runIdentity !== identity || this.activationOwners.get(PROJECT_CARD_ID) !== owner || owner.phase !== 'prepared_root' || owner.terminalWinner !== 'open' || this.halt || !this.applicationAdmissionOpen) throw new Error('Root preparation authority is no longer current.'); }
  private haltFor(owner: CardActivationOwner): RuntimeHalt | null { const halt = this.halt; return halt?.owners.includes(owner) ? halt : null; }
  private requireOwner(owner: CardActivationOwner): void { if (this.activationOwners.get(owner.cardId) !== owner) throw new Error(`Card '${owner.cardId}' activation owner is no longer current.`); }
  private requireOwnerAuthority(owner: CardActivationOwner): void {
    if (this.halt?.owners.includes(owner)) throw this.halt.interruption;
    this.requireOwner(owner);
    if (this.halt) throw new Error(`Card '${owner.cardId}' is outside the frozen runtime halt graph.`);
  }
  private requireKnownCard(owner: CardActivationOwner): CardRecord { const card = this.behavior.actorStore.read(owner.cardId); if (!card) throw new Error(`Card '${owner.cardId}' not found.`); return card; }
  private assertDurableParentRunning(parent: CardActivationOwner, child: CardRecord): void {
    const durableParent = this.requireKnownCard(parent);
    if (durableParent.lifecycle.status !== 'running') throw new Error(`Runtime invariant failed: operation=activate_child parent=${parent.cardId} parent_status=${durableParent.lifecycle.status} child=${child.id} child_status=${child.lifecycle.status} parent_activation=${parent.activationId}.`);
  }
  private assertNoOwnedChildAtResultSettlement(owner: CardActivationOwner): void {
    const childCardId = owner.childCardId;
    if (childCardId === null) return;
    const card = this.requireKnownCard(owner);
    const child = this.behavior.actorStore.read(childCardId);
    if (!child) throw new Error(`Runtime invariant failed: operation=settle_result card=${owner.cardId} activation=${owner.activationId}; owned child card '${childCardId}' not found.`);
    throw new Error(`Runtime invariant failed: operation=settle_result card=${owner.cardId} card_status=${card.lifecycle.status} activation=${owner.activationId} child=${childCardId} child_status=${child.lifecycle.status}.`);
  }
  private startRejected(error: string): StartProjectResult { const status = this.publicRuntimeStatus(); return { runtime: this.runtimeState(), status, started: false, stopped: status === 'stopped', error }; }
  private runtimeState(): RuntimeState | null { if (!this.runIdentity) return null; if (!this.currentCardId) throw new Error('Active runtime has no current card.'); return { status: this.publicRuntimeStatus(), project_id: 'project', pid: this.behavior.processIdentity.pid, started_at: this.behavior.processIdentity.startedAt, current_card_id: this.currentCardId, updated_at: this.now() }; }
  private publicRuntimeStatus(): RuntimeStatus { if (this.status === 'uninitialized') throw new Error('Runtime has not been initialized.'); return this.status; }

  private ownershipTransition(invalidate: boolean, mutate: () => void): void {
    if (this.inOwnershipTransition) throw new Error('Nested ownership transition is forbidden.');
    const previousStatus=this.status;this.inOwnershipTransition = true;
    try { mutate(); this.assertOwnershipInvariants(); } finally { this.inOwnershipTransition = false; }
    if(previousStatus!==this.status&&this.status!=='uninitialized')this.behavior.runtimeStatusChanged?.(this.status);
    if (invalidate) this.ownershipInvalidated();
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
    if (this.status === 'uninitialized') {
      if (this.runIdentity || this.currentCardId || this.activationOwners.size || this.preparedLaunch || this.halt) throw new Error('Uninitialized runtime retains ownership state.');
      return;
    }
    if (this.status === 'stopped' && (this.runIdentity || this.currentCardId || this.activationOwners.size || this.preparedLaunch || this.halt)) throw new Error('Stopped runtime retains ownership state.');
    if (this.runIdentity && !this.currentCardId) throw new Error('Active runtime has no current card.');
    if (this.halt && (this.status !== 'closing' && this.status !== 'error')) throw new Error('Runtime halt requires closing or error status.');
    if (this.halt && this.halt.owners.some((owner) => this.activationOwners.get(owner.cardId) !== owner)) throw new Error('Runtime halt owner graph is not installed.');
  }

  private ownershipInvalidated(): void { this.behavior.freshness.runtimeChanged(); }
  private async cancelNonrunningSubtree(cardId: string, cancelled: string[], authority?: CardActivationOwner): Promise<void> { if (authority) this.requireOwnerAuthority(authority); else if (this.halt) throw this.halt.interruption; const owner = this.activationOwners.get(cardId); if (owner) { const result = await this.cancelOwnedOrStored(cardId, 'ancestor cancelled', null); if (authority) this.requireOwnerAuthority(authority); cancelled.push(...result.cancelled_card_ids); return; } const card = this.behavior.actorStore.read(cardId); if (!card || !canCancelCardStatus(card.lifecycle.status)) return; if (card.lifecycle.status === 'running') throw new Error(`Running card '${cardId}' has no activation owner.`); for (const childId of this.behavior.actorStore.listChildren(cardId)) { await this.cancelNonrunningSubtree(childId, cancelled, authority); if (authority) this.requireOwnerAuthority(authority); else if (this.halt) throw this.halt.interruption; } if (authority) this.requireOwnerAuthority(authority); else if (this.halt) throw this.halt.interruption; this.behavior.actorStore.setStatus(cardId, 'cancelled'); cancelled.push(cardId); }
}

export function createSupervisorRuntimeApi(options: SupervisorRuntimeApiOptions): SupervisorRuntimeApi { return new SupervisorRuntimeApi(options); }
function eligibleAgents(workflows: CompiledRuntimeWorkflows, card: CardRecord): readonly import('../../schemas/index.js').AgentName[] { const workflow=workflows.cardTypes.get(card.type);if(!workflow)throw new Error(`No compiled workflow for '${card.type}'.`);return [...new Set([...workflow.states.values()].flatMap((state)=>state.kind==='node'?[state.agent.name]:[]))]; }
