import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import {
  assertCleanGitDelivery,
  runGitWorkflow,
  type NativeGitRequest,
  type NativeGitResult,
} from '../git-workflow.js';
import type { CardGitFacts } from '../../schemas/git-source.js';
import type { AcceptedSource, SourcePreparation } from './card-activation-owner.js';
import {
  cardAgentSessionId,
  canonicalValueSha256,
  type CardNotification,
  type CardRecord,
  type ConversationSessionId,
  type RuntimeState,
  type RuntimeStatus,
} from '../../schemas/index.js';
import { PROJECT_CARD_ID } from '../../cards/store-api.js';
import { acceptsCardNotifications, canCancelCardStatus } from '../../cards/status-api.js';
import {
  CardActivationOwner,
  type CardCancellationResult,
  type PlannerChildControlPort,
  type PlannerChildReopenResult,
} from './card-activation-owner.js';
import { CardProcessActor } from './card-process-actor.js';
import { toPublicCardActorState } from '../../schemas/index.js';
import type { ChildInvocationLease } from './child-invocation-wait.js';
import type { ActorRuntimeReadModel } from '../../application/index.js';
import type {
  NotificationSubmissionResult,
  NotifyCardResult,
  RuntimeApi,
  StartProjectResult,
  StopProjectResult,
} from '../runtime-api.js';
import { RuntimeGate } from '../runtime-gate.js';
import { selectLinkedRunningChain } from '../running-card-chain.js';
import type { LLMProviderPort, CompactorPort } from './llm-actor.js';
import type { AutonomousCompactionPolicy } from './compaction/compactor.js';
import type { SummarizerProviderPort } from './compaction/summarizer.js';
import type { CardService } from '../../cards/store-api.js';
import type { InterventionReadinessFacet } from '../../contracts/index.js';
import type { ProcessRunner } from '../process-runner.js';
import type { ManagedProcessScope } from '../managed-process-group-registry.js';
import type { PromptTemplateRegistry } from '../../utils/prompt-api.js';
import type { ExecutingLlmSnapshot } from './executing-llm-snapshot.js';
import type { ConversationFileContext } from '../../persistence/session-api.js';
import type { FreshnessEffects } from '../../contracts/index.js';
import type { McpToolInvocationPort } from '../../mcp/manager-api.js';
import { RuntimeStoppedInterruption } from './runtime-stopped-interruption.js';
import type { RuntimeProcessIdentity } from '../lock.js';
import { AnalystInterventionNotReadyError } from '../../contracts/index.js';
import {
  cardProcessEntryForStatus,
  type CompiledRuntimeWorkflows,
  type CardProcessEntry,
} from '../card-process/card-process-config.js';
import { stabilizeAgentSession } from './conversation-recovery.js';
import { TERMINAL_RESULT_TOOL_NAME } from '../../contracts/index.js';
import { cardParentId } from '../../schemas/index.js';
import { deferred } from './deferred.js';
import {
  PublicationOutcomeUnknownError,
  WorkGcBusyError,
  WorkGcMaintenanceError,
  type ApplicationFatalPort,
} from '../../contracts/index.js';
import type { NotificationUrgency } from '../../contracts/index.js';
import { CardInterruptedError } from './card-interrupted-error.js';

interface SupervisorRuntimeApiOptions {
  cancelWorkGc?(reason: Error): void;
  outboundHttp?: import('../../contracts/index.js').OutboundHttpEmitter;
  projectRoot: string;
  now?: () => string;
  actorStore: CardService;
  provider: LLMProviderPort;
  conversations: ConversationFileContext;
  freshness: Pick<FreshnessEffects, 'runtimeChanged' | 'agentMembershipChanged'>;
  compactor: CompactorPort;
  compactionConfig: AutonomousCompactionPolicy;
  summarizerProvider: SummarizerProviderPort;
  processRunner: ProcessRunner;
  runtimeProcessRootScope: ManagedProcessScope;
  promptTemplates: PromptTemplateRegistry;
  workflows: CompiledRuntimeWorkflows;
  runtimeGate: RuntimeGate;
  mcpToolInvocation: McpToolInvocationPort;
  retrieval?: import('../../contracts/observed-collections.js').RetrievalPort;
  processIdentity: RuntimeProcessIdentity;
  fatalPort: ApplicationFatalPort;
  runtimeStatusChanged?(status: RuntimeStatus): void;
}

declare const supervisorLaunchPlanBrand: unique symbol;
interface SupervisorLaunchPlan {
  readonly [supervisorLaunchPlanBrand]: never;
  readonly owner: CardActivationOwner;
  readonly runIdentity: object;
}
interface RuntimeHalt {
  readonly trigger: 'stop' | 'application_close' | 'publication_failure' | 'runtime_failure';
  readonly interruption: RuntimeStoppedInterruption;
  readonly owners: readonly CardActivationOwner[];
  readonly promise: Promise<void>;
  readonly failure?: Error;
}

type InterruptedOwnerSettlement =
  | Readonly<{ kind: 'completed' }>
  | Readonly<{ kind: 'taken_over'; halt: RuntimeHalt }>;

interface UrgentNodeCapture {
  readonly boundary: CardActivationOwner;
  readonly ordinal: number;
  readonly suffix: readonly CardActivationOwner[];
  readonly leases: readonly ChildInvocationLease[];
  readonly replaceRoot: boolean;
}
interface UrgentSelection {
  readonly capture: UrgentNodeCapture | null;
  readonly notices: readonly {
    readonly cardId: string;
    readonly childId: string;
    readonly childStatus: string;
  }[];
  readonly conflictedOwner: boolean;
}

type SupervisorStatus = RuntimeStatus | 'uninitialized';

interface WorkGcHold {
  readonly runIdentity: object;
  readonly abort: AbortController;
  readonly parked: ReturnType<typeof deferred<void>>;
  phase: 'settling' | 'collecting';
  restoreRunning: boolean;
}

class SupervisorRuntimeApi implements RuntimeApi, InterventionReadinessFacet {
  private readonly behavior: Omit<
    SupervisorRuntimeApiOptions,
    'processRunner' | 'runtimeProcessRootScope'
  >;
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
  private workGcHold: WorkGcHold | null = null;

  assertGlobalSourceWrite(absolutePath: string): void {
    const policy = this.behavior.workflows.gitPolicy;
    if (!policy) return;
    const path = relative(realpathSync(this.behavior.projectRoot), absolutePath).replaceAll(
      '\\',
      '/',
    );
    if (
      path === '..' ||
      path.startsWith('../') ||
      isAbsolute(path) ||
      policy.excluded_paths.some(
        (excluded) => path === excluded || path.startsWith(`${excluded}/`),
      ) ||
      !policy.source_roots.some(
        (root) => root === '.' || path === root || path.startsWith(`${root}/`),
      )
    )
      return;
    if (
      !this.applicationAdmissionOpen ||
      this.status !== 'stopped' ||
      this.runIdentity ||
      this.preparedLaunch ||
      this.halt ||
      this.applicationCleanupTask ||
      this.inOwnershipTransition ||
      this.activationOwners.size ||
      this.workGcHold
    )
      throw new Error('Global source writes require a genuinely stopped native Git runtime.');
    const facts = this.behavior.actorStore.read(PROJECT_CARD_ID)?.git;
    if (
      !facts ||
      facts.kind !== 'root' ||
      facts.policy_digest !== canonicalValueSha256(policy) ||
      facts.parent.branch_ref !== `refs/heads/${policy.delivery_branch}`
    )
      throw new Error('Global source writes require matching commissioned root source facts.');
    assertCleanGitDelivery(this.behavior.projectRoot, facts.parent, policy);
  }

  assertWorkGcIngressAllowed(): void {
    if (this.workGcHold) throw new WorkGcBusyError();
  }

  private assertWorkGcNotCollecting(): void {
    if (this.workGcHold?.phase === 'collecting')
      throw new Error('Work garbage collection is collecting; mutation is unavailable.');
  }

  cancelWorkGc(reason: Error): void {
    const hold = this.workGcHold;
    if (hold) {
      hold.restoreRunning = false;
      hold.abort.abort(reason);
    }
    this.behavior.cancelWorkGc?.(reason);
  }

  async withWorkGcMaintenance<T>(input: {
    signal: AbortSignal;
    assertEntryIdle(): void;
    settleAcceptedWork(): Promise<void>;
    assertReady(): void;
    collect(signal: AbortSignal): Promise<T>;
  }): Promise<{ value: T; restoredRunning: boolean }> {
    this.assertWorkGcIngressAllowed();
    input.signal.throwIfAborted();
    if (
      !this.applicationAdmissionOpen ||
      this.halt ||
      !this.runIdentity ||
      (this.status !== 'running' && this.status !== 'paused')
    )
      throw new Error('Work garbage collection requires an existing running or fully paused run.');
    const hold: WorkGcHold = {
      runIdentity: this.runIdentity,
      abort: new AbortController(),
      parked: deferred<void>(),
      phase: 'settling',
      restoreRunning: this.status === 'running',
    };
    this.workGcHold = hold;
    const signal = AbortSignal.any([input.signal, hold.abort.signal, AbortSignal.timeout(60_000)]);
    const cancelled = deferred<never>();
    const onAbort = () => cancelled.reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void cancelled.promise.catch(() => undefined);
    const finish = (): boolean => {
      signal.removeEventListener('abort', onAbort);
      const restore =
        hold.restoreRunning &&
        this.runIdentity === hold.runIdentity &&
        this.applicationAdmissionOpen &&
        !this.halt &&
        (this.status === 'pausing' || this.status === 'paused');
      this.workGcHold = null;
      if (restore) {
        this.runtimeGate.open();
        this.ownershipTransition(true, () => {
          this.status = 'running';
        });
      }
      return restore;
    };
    try {
      // Entry refusal happens under the hold, before requesting project pause.
      input.assertEntryIdle();
      if (this.status === 'running') this.requestPause();
      else hold.parked.resolve();
      const settling = Promise.all([hold.parked.promise, input.settleAcceptedWork()]);
      // Keep fatal observation even when cancellation stops waiting for accepted work.
      void settling.catch((error) => {
        if (error instanceof PublicationOutcomeUnknownError)
          this.behavior.fatalPort.publicationOutcomeUnknown(error);
      });
      await Promise.race([settling, cancelled.promise]);
      signal.throwIfAborted();
      if (
        this.runIdentity !== hold.runIdentity ||
        this.status !== 'paused' ||
        !this.runtimeGate.isParked ||
        this.halt ||
        [...this.activationOwners.values()].some(
          (owner) =>
            owner.phase !== 'active' ||
            owner.terminalWinner !== 'open' ||
            owner.urgentSettlement !== null ||
            owner.cancellationSettlement !== null,
        )
      )
        throw new Error('Work garbage collection has no settled parked project frontier.');
      input.assertReady();
      hold.phase = 'collecting';
      const value = await input.collect(signal);
      signal.throwIfAborted();
      return { value, restoredRunning: finish() };
    } catch (error) {
      if (error instanceof PublicationOutcomeUnknownError)
        this.behavior.fatalPort.publicationOutcomeUnknown(error);
      throw new WorkGcMaintenanceError(finish(), error, signal.aborted);
    }
  }

  constructor(options: SupervisorRuntimeApiOptions) {
    const { processRunner, runtimeProcessRootScope, ...behavior } = options;
    this.#processRunner = processRunner;
    this.#runtimeProcessRootScope = runtimeProcessRootScope;
    this.behavior = behavior;
    this.now = behavior.now ?? (() => new Date().toISOString());
    this.runtimeGate = behavior.runtimeGate;
  }

  async start(): Promise<void> {
    this.initializeStoppedRuntime();
  }

  private initializeStoppedRuntime(): void {
    if (this.status !== 'uninitialized') return;
    this.runtimeGate.close();
    this.assertOwnershipInvariants();
    let runningChain: readonly CardRecord[];
    try {
      runningChain = selectLinkedRunningChain(this.behavior.actorStore);
    } catch (error) {
      throw new Error('Startup interrupted-card settlement: linked-chain selection failed.', {
        cause: error,
      });
    }
    this.settleInterruptedRunningChain(runningChain, (write, operation) => {
      try {
        write();
        return true;
      } catch (error) {
        if (error instanceof PublicationOutcomeUnknownError)
          this.behavior.fatalPort.publicationOutcomeUnknown(error);
        throw new Error(`Startup interrupted-card settlement: ${operation} failed.`, {
          cause: error,
        });
      }
    });
    this.status = 'stopped';
    this.behavior.runtimeStatusChanged?.('stopped');
  }

  private settleInterruptedRunningChain(
    chain: readonly CardRecord[],
    publish: (write: () => void, operation: string) => boolean,
  ): boolean {
    // True means the operation completed and this caller still authorizes progression.
    // Startup returns true or throws; prepared Run may return false after failure or halt takeover.
    for (const card of [...chain].reverse()) {
      for (const agentName of eligibleAgents(this.behavior.workflows, card)) {
        const sessionId = cardAgentSessionId(agentName, card.id);
        if (
          !publish(() => {
            stabilizeAgentSession({
              sessionId,
              conversations: this.behavior.conversations,
              terminalToolNames: new Set([TERMINAL_RESULT_TOOL_NAME]),
            });
          }, `configured session '${sessionId}'`)
        )
          return false;
      }
      if (
        !publish(() => {
          this.behavior.actorStore.stopRunning(card.id);
        }, `card '${card.id}' stopped publication`)
      )
        return false;
    }
    return true;
  }

  assertInterventionReady(): void {
    this.assertWorkGcNotCollecting();
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
    this.cancelWorkGc(new Error('Application closing.'));
    if (!this.applicationAdmissionOpen) return;
    if (!this.runIdentity && !this.halt) {
      this.applicationAdmissionOpen = false;
      return;
    }
    this.applicationCleanupTask = this.beginHalt('application_close');
  }

  cleanupForApplicationStop(): Promise<void> {
    this.closeApplicationAdmission();
    if (!this.applicationCleanupTask) {
      let termination: Promise<import('../process-runner.js').ProcessStopReport>;
      try {
        termination = this.#processRunner.terminateScopeTree({
          rootScope: this.#runtimeProcessRootScope,
          categories: ['runtime_card'],
          reason: 'application stopping',
        });
      } catch (error) {
        termination = Promise.reject(error);
      }
      return termination.then((report) => {
        if (report.failed.length) throw new Error('Runtime application cleanup failed.');
      });
    }
    return this.applicationCleanupTask.catch((error) => {
      throw new Error('Runtime application cleanup failed.', { cause: error });
    });
  }

  stopProject(): Promise<StopProjectResult> {
    this.cancelWorkGc(new Error('Project stopped.'));
    if (!this.runIdentity && !this.halt) {
      const status = this.publicRuntimeStatus();
      if (status !== 'stopped')
        throw new Error(`Inactive runtime has unexpected '${status}' status.`);
      return Promise.resolve({ status, contained: false });
    }
    return this.beginHalt('stop').then<StopProjectResult>(() => ({
      status: 'stopped',
      contained: true,
    }));
  }

  async startProject(): Promise<StartProjectResult> {
    this.assertWorkGcIngressAllowed();
    const prepared = await this.beginStartProject();
    if (!prepared.accepted) return prepared.result;
    const runtime = this.launchStartedProject(prepared.launch);
    if (prepared.launch.owner.entryRefusal)
      return this.startRejected(prepared.launch.owner.entryRefusal.summary);
    if (!runtime) throw new Error('Admitted project launch has no runtime state.');
    return { runtime, status: runtime.status, started: true, stopped: false };
  }

  private async beginStartProject(): Promise<
    | { accepted: false; result: StartProjectResult }
    | { accepted: true; launch: SupervisorLaunchPlan }
  > {
    this.initializeStoppedRuntime();
    this.assertWorkGcIngressAllowed();
    if (!this.applicationAdmissionOpen)
      return { accepted: false, result: this.startRejected('Application is closing.') };
    if (this.status !== 'stopped' || this.runIdentity || this.preparedLaunch)
      return {
        accepted: false,
        result: this.startRejected(`Cannot start runtime from '${this.status}'.`),
      };

    const runningChain = selectLinkedRunningChain(this.behavior.actorStore);
    const root = runningChain[0] ?? this.behavior.actorStore.read(PROJECT_CARD_ID);
    if (!root || root.id !== PROJECT_CARD_ID || root.type !== 'project')
      throw new Error(`Root card record '${PROJECT_CARD_ID}' is missing.`);
    const entry =
      runningChain.length > 0 ? 'STOPPED' : cardProcessEntryForStatus(root.lifecycle.status);
    if (entry === null)
      throw new Error(`Project card in status '${root.lifecycle.status}' cannot start.`);
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

    if (
      !this.settleInterruptedRunningChain(runningChain, (write) => {
        this.requirePreparation(owner, runIdentity);
        return (
          this.publish(owner, () => {
            write();
            return true;
          }) !== null
        );
      })
    )
      return await owner.settlement.promise.then(() => {
        throw new Error('Prepared root unexpectedly settled.');
      });
    this.requirePreparation(owner, runIdentity);
    if (this.behavior.workflows.gitPolicy) {
      try {
        await this.enterSource(owner);
      } catch (error) {
        if (error instanceof PublicationOutcomeUnknownError)
          this.behavior.fatalPort.publicationOutcomeUnknown(error);
        if (!this.halt)
          void this.beginHalt('runtime_failure', owner, error as Error).catch(() => undefined);
        throw error;
      }
      this.requirePreparation(owner, runIdentity);
    }
    const running = this.publish(owner, () =>
      root.lifecycle.status === 'stopped' || runningChain.length > 0
        ? this.behavior.actorStore.activateStopped(PROJECT_CARD_ID)
        : this.behavior.actorStore.setStatus(PROJECT_CARD_ID, 'running'),
    );
    if (!running)
      return await owner.settlement.promise.then(() => {
        throw new Error('Prepared root unexpectedly settled.');
      });
    this.ownershipTransition(true, () => {
      this.requireOwner(owner);
      owner.phase = 'active';
      owner.cachedStatus = 'running';
    });
    return { accepted: true, launch };
  }

  private launchStartedProject(launch: SupervisorLaunchPlan): RuntimeState | null {
    this.assertWorkGcIngressAllowed();
    if (launch !== this.preparedLaunch)
      throw new Error('Runtime launch plan is foreign, stale, or already consumed.');
    const owner = launch.owner;
    this.requireOwner(owner);
    if (this.halt) throw this.halt.interruption;
    if (
      owner.phase !== 'active' ||
      owner.terminalWinner !== 'open' ||
      this.status !== 'starting' ||
      !this.applicationAdmissionOpen
    )
      throw new Error('Prepared runtime launch is no longer admissible.');
    this.ownershipTransition(true, () => {
      this.preparedLaunch = null;
      this.status = 'running';
    });
    const postTransitionHalt = this.halt as RuntimeHalt | null;
    if (postTransitionHalt?.owners.includes(owner)) throw postTransitionHalt.interruption;
    if (this.getStatus().status !== 'running' || !this.applicationAdmissionOpen)
      throw new Error('Prepared runtime launch lost admission during invalidation.');
    this.runtimeGate.open();
    this.activateProcessor(owner);
    return this.runtimeState();
  }

  hasWorkGcMaintenanceHold(): boolean {
    return this.workGcHold !== null;
  }

  pause(): void {
    if (this.workGcHold) {
      this.workGcHold.restoreRunning = false;
      if (this.status === 'pausing' || this.status === 'paused') return;
    }
    this.requestPause();
  }

  private requestPause(): void {
    if (this.halt) throw this.halt.interruption;
    if (this.status !== 'running' || !this.runIdentity)
      throw new Error(`Cannot pause runtime from '${this.status}'.`);
    const identity = this.runIdentity;
    this.ownershipTransition(true, () => {
      this.status = 'pausing';
    });
    this.runtimeGate.requestPause(() => {
      if (this.halt) return;
      if (
        this.runIdentity !== identity ||
        this.status !== 'pausing' ||
        !this.activationOwners.has(PROJECT_CARD_ID)
      )
        return;
      this.ownershipTransition(true, () => {
        this.status = 'paused';
      });
      this.workGcHold?.parked.resolve();
    });
  }

  resume(): void {
    this.assertWorkGcIngressAllowed();
    if (this.halt) throw this.halt.interruption;
    if (this.status !== 'paused' || !this.runIdentity)
      throw new Error(`Cannot resume runtime from '${this.status}'.`);
    const identity = this.runIdentity;
    this.runtimeGate.open();
    this.ownershipTransition(true, () => {
      if (this.halt) throw this.halt.interruption;
      if (this.runIdentity !== identity || this.status !== 'paused')
        throw new Error('Paused runtime identity changed while resuming.');
      this.status = 'running';
    });
  }

  notifyCard(cardId: string, notification: CardNotification): NotifyCardResult {
    this.assertWorkGcNotCollecting();
    const card = this.behavior.actorStore.read(cardId);
    if (!card) return { ok: false, reason: 'missing_card', cardId };
    if (!acceptsCardNotifications(card.lifecycle.status))
      return {
        ok: false,
        reason: 'terminal_card',
        cardId,
        status: card.lifecycle.status as 'done' | 'failed' | 'cancelled',
      };
    const owner = this.activationOwners.get(cardId);
    if (owner && owner.terminalWinner !== 'open')
      return { ok: false, reason: 'activation_closed', cardId };
    this.behavior.actorStore.enqueueNotification(cardId, notification);
    return { ok: true, notificationId: notification.id };
  }

  async submitNotification(
    cardId: string,
    notification: CardNotification,
    urgency: NotificationUrgency,
    signal?: AbortSignal,
  ): Promise<NotificationSubmissionResult> {
    const targetCard = this.behavior.actorStore.read(cardId);
    if (!targetCard) return { queued: false, reason: 'missing_card', cardId };
    const selection = urgency === 'urgent' ? this.selectUrgentRoute(cardId) : null;
    let queued: NotifyCardResult;
    try {
      queued = this.notifyCard(cardId, notification);
    } catch (error) {
      if (error instanceof PublicationOutcomeUnknownError)
        this.behavior.fatalPort.publicationOutcomeUnknown(error);
      throw error;
    }
    if (!queued.ok) {
      const { ok: _ok, ...denied } = queued;
      return { ...denied, queued: false };
    }
    if (selection === null)
      return {
        queued: true,
        cardId,
        notificationId: queued.notificationId,
        interruption: { status: 'not_requested' },
      };
    for (const notice of selection.notices) {
      const parentNote = {
        id: randomUUID(),
        content: `Urgent notification '${notification.id}' for descendant '${cardId}' needs attention through immediate child '${notice.childId}' (status observed when queued: ${notice.childStatus}). Consider ordinary child activation; if the child is DONE or FAILED when considered, discretionary reopening may be appropriate; the workflow may decline.`,
        created_at: this.now(),
        source: 'supervisor',
      };
      try {
        this.notifyCard(notice.cardId, parentNote);
      } catch (error) {
        if (error instanceof PublicationOutcomeUnknownError)
          this.behavior.fatalPort.publicationOutcomeUnknown(error);
        throw error;
      }
    }
    const capture = selection.capture;
    if (!capture)
      return {
        queued: true,
        cardId,
        notificationId: queued.notificationId,
        interruption: selection.conflictedOwner
          ? { status: 'suppressed', reason: 'stale_owner', stopped_card_ids: [] }
          : { status: 'not_applicable' },
      };
    if (signal?.aborted)
      return {
        queued: true,
        cardId,
        notificationId: queued.notificationId,
        interruption: { status: 'suppressed', reason: 'cancelled', stopped_card_ids: [] },
      };
    if (this.status !== 'running' || !this.applicationAdmissionOpen || this.halt)
      return {
        queued: true,
        cardId,
        notificationId: queued.notificationId,
        interruption: { status: 'suppressed', reason: 'runtime_ineligible', stopped_card_ids: [] },
      };
    if (!this.urgentNodeIsCurrent(capture))
      return {
        queued: true,
        cardId,
        notificationId: queued.notificationId,
        interruption: { status: 'suppressed', reason: 'stale_owner', stopped_card_ids: [] },
      };
    const boundary = capture.boundary;
    const interruption = new CardInterruptedError(
      `Interrupted current node after urgent notification '${notification.id}' for '${cardId}'.`,
    );
    const completion = deferred<void>();
    void completion.promise.catch(() => undefined);
    const completed: string[] = [];
    let takenOver = false;
    try {
      // Install node/suffix winners and the same settlement before cancellation or invalidation.
      // Supervisor owns tree authority; the processor owns captured retiring node resources.
      this.ownershipTransition(false, () => {
        if (!this.urgentNodeIsCurrent(capture))
          throw new Error('Urgent notification ownership changed during interruption claim.');
        if (capture.replaceRoot) {
          boundary.terminalWinner = 'interrupt';
          boundary.phase = 'settling';
        } else
          boundary.processor.claimNodeInterruption(
            capture.ordinal,
            completion.promise,
            interruption,
          );
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
    let fatalPublication = false;
    const task = (async () => {
      try {
        for (const owner of capture.suffix)
          owner.processor.interruptActivationGracefully(interruption);
        if (capture.replaceRoot) boundary.processor.interruptActivationGracefully(interruption);
        else boundary.processor.interruptClaimedNodeGracefully();
        this.ownershipInvalidated();
        for (const owner of [...capture.suffix].reverse()) {
          const result = await this.settleInterruptedOwner(owner, interruption);
          if (result.kind === 'taken_over') {
            if (result.halt.trigger !== 'stop' && result.halt.trigger !== 'application_close')
              throw result.halt.failure ?? result.halt.interruption;
            takenOver = true;
            completion.resolve();
            return;
          }
          completed.push(owner.cardId);
        }
        if (capture.replaceRoot) {
          const rootResult = await this.settleInterruptedOwner(boundary, interruption);
          if (rootResult.kind === 'taken_over') {
            if (
              rootResult.halt.trigger !== 'stop' &&
              rootResult.halt.trigger !== 'application_close'
            )
              throw rootResult.halt.failure ?? rootResult.halt.interruption;
            takenOver = true;
            completion.resolve();
            return;
          }
          completed.push(PROJECT_CARD_ID);
          if (!(await this.replaceInterruptedRoot(boundary, completion.promise))) {
            takenOver = true;
            completion.resolve();
            return;
          }
        } else {
          // Never join the surviving activation/current guarded task: it awaits completion below.
          await boundary.processor.joinInterruptedNode();
          if (this.haltFor(boundary)) takenOver = true;
          else {
            this.requireOwnerAuthority(boundary);
            if (this.behavior.workflows.gitPolicy) {
              if (this.sourceFacts(boundary).correction) {
                await this.returnSource(boundary);
                this.requireOwnerAuthority(boundary);
                await this.enterSource(boundary);
                this.requireOwnerAuthority(boundary);
                if (boundary.entryRefusal) throw new Error(boundary.entryRefusal.summary);
              } else {
                await this.sourceOperation(boundary, async () => {
                  const facts = this.sourceFacts(boundary);
                  const saved = await this.nativeCommand(boundary, {
                    ...this.nativeRequest(boundary),
                    step: 'checkpoint',
                    expected: { branch_ref: facts.branch_ref, observed_tip: facts.observed_tip },
                  });
                  this.requireOwnerAuthority(boundary);
                  if (saved.kind !== 'completed')
                    throw new Error('Interrupted source checkpoint did not complete.');
                  this.publishSource(boundary, {
                    ...this.sourceFacts(boundary),
                    observed_tip: saved.observation.observed_tip,
                    candidate: null,
                    last_delivery: null,
                  });
                });
                this.requireOwnerAuthority(boundary);
              }
            }
          }
        }
        completion.resolve();
      } catch (error) {
        if (error instanceof PublicationOutcomeUnknownError) {
          fatalPublication = true;
          this.behavior.fatalPort.publicationOutcomeUnknown(error);
        }
        void this.beginHalt('runtime_failure').catch(() => undefined);
        if (this.behavior.workflows.gitPolicy) {
          takenOver = true;
          completion.resolve();
        } else completion.reject(error);
      } finally {
        if (!fatalPublication) {
          boundary.urgentSettlement = null;
          const currentRoot = this.activationOwners.get(PROJECT_CARD_ID);
          if (currentRoot?.urgentSettlement === completion.promise)
            currentRoot.urgentSettlement = null;
        }
      }
    })();
    void task.catch((error) => {
      if (fatalPublication) return;
      if (error instanceof PublicationOutcomeUnknownError)
        this.behavior.fatalPort.publicationOutcomeUnknown(error);
      completion.reject(error);
      void this.beginHalt('runtime_failure').catch(() => undefined);
    });
    await completion.promise;
    return {
      queued: true,
      cardId,
      notificationId: queued.notificationId,
      interruption: takenOver
        ? { status: 'suppressed', reason: 'runtime_ineligible', stopped_card_ids: completed }
        : { status: 'interrupted', stopped_card_ids: completed },
    };
  }

  cancelCard(cardId: string, reason: string): Promise<CardCancellationResult> {
    this.assertWorkGcNotCollecting();
    return this.cancelOwnedOrStored(cardId, reason, null);
  }
  getStatus() {
    return {
      status: this.publicRuntimeStatus(),
      currentCardId: this.currentCardId,
      pid: this.behavior.processIdentity.pid,
      startedAt: this.behavior.processIdentity.startedAt,
    };
  }
  getRuntimeState(): RuntimeState | null {
    return this.runtimeState();
  }
  captureAutonomousExecutingLlmSnapshots(): ReadonlyMap<
    ConversationSessionId,
    ExecutingLlmSnapshot
  > {
    const snapshots = new Map<ConversationSessionId, ExecutingLlmSnapshot>();
    for (const owner of this.activationOwners.values()) {
      const snapshot = owner.processor.executingLlmSnapshot();
      if (snapshot) snapshots.set(snapshot.sessionId, snapshot);
    }
    return snapshots;
  }
  getActorRuntimeReadModel(): ActorRuntimeReadModel {
    const cards = [...this.activationOwners.values()].map((owner) => ({
      cardId: owner.cardId,
      actorState: toPublicCardActorState(owner.cachedStatus),
      processState: owner.processor.processPosition(),
    }));
    return {
      pauseMode:
        this.status === 'running' ? 'running' : this.status === 'paused' ? 'paused' : 'idle',
      cards,
    };
  }
  private boundParentControl(parentCardId: string, activationId: string): PlannerChildControlPort {
    const requireParent = (): CardActivationOwner => {
      const parent = this.activationOwners.get(parentCardId);
      if (parent?.activationId === activationId && this.halt?.owners.includes(parent))
        throw this.halt.interruption;
      if (!parent || parent.activationId !== activationId || parent.phase !== 'active' || this.halt)
        throw new Error(`Parent activation '${parentCardId}' is no longer active.`);
      return parent;
    };
    return Object.freeze({
      activateChild: ({
        childCardId,
        instructions,
        invocation,
      }: {
        childCardId: string;
        instructions: string;
        invocation: ChildInvocationLease;
      }) => {
        try {
          return this.activateChild(requireParent(), childCardId, instructions, invocation);
        } catch (error) {
          const halt = this.halt;
          if (halt && error === halt.interruption)
            return this.rejectLease(invocation, halt.interruption);
          throw error;
        }
      },
      cancelChild: ({ childCardId, reason }: { childCardId: string; reason: string }) => {
        requireParent();
        return this.cancelOwnedOrStored(childCardId, reason, parentCardId);
      },
      reopenChild: ({ childCardId }: { childCardId: string }) =>
        this.reopenChild(requireParent(), childCardId),
    });
  }

  private reopenChild(parent: CardActivationOwner, childCardId: string): PlannerChildReopenResult {
    this.requireOwnerAuthority(parent);
    if (
      parent.phase !== 'active' ||
      parent.terminalWinner !== 'open' ||
      !this.applicationAdmissionOpen
    )
      throw new Error(`Parent activation '${parent.cardId}' is closed to child reopening.`);
    if (cardParentId(childCardId) !== parent.cardId)
      throw new Error(`reopen_card can target only immediate children of '${parent.cardId}'.`);
    if (this.activationOwners.has(childCardId))
      throw new Error(`Child '${childCardId}' still has an activation owner.`);
    const child = this.behavior.actorStore.read(childCardId);
    if (!child) throw new Error(`Child card '${childCardId}' not found.`);
    if (child.lifecycle.status !== 'done' && child.lifecycle.status !== 'failed')
      throw new Error(
        `Card '${childCardId}' in status '${child.lifecycle.status}' cannot be reopened.`,
      );
    const changed = this.publish(parent, () =>
      this.behavior.actorStore.setStatus(childCardId, 'changed'),
    );
    if (changed === null) {
      this.requireOwnerAuthority(parent);
      throw new Error(
        'Child reopening publication returned no result without stopping the runtime.',
      );
    }
    return { card_id: childCardId, status: 'changed' };
  }

  private activateChild(
    parent: CardActivationOwner,
    childCardId: string,
    instructions: string,
    lease: ChildInvocationLease,
  ): Promise<import('../../contracts/tool-api.js').CardActivationOutcome> {
    this.assertWorkGcNotCollecting();
    if (this.halt?.owners.includes(parent)) return this.rejectLease(lease, this.halt.interruption);
    this.requireOwnerAuthority(parent);
    if (cardParentId(childCardId) !== parent.cardId)
      return this.rejectLease(
        lease,
        new Error(`Planner can activate only immediate children of '${parent.cardId}'.`),
      );
    const snapshot = parent.processor.executingLlmSnapshot();
    if (
      !snapshot ||
      lease.identity.sessionId !== snapshot.sessionId ||
      lease.identity.toolName !== 'activate_card' ||
      lease.childCardId !== childCardId
    )
      throw new Error('Child invocation lease identity does not match parent activation.');
    this.requireOwnerAuthority(parent);
    const existing = this.activationOwners.get(childCardId);
    if (existing) {
      if (
        existing.parentRelationship?.parentCardId === parent.cardId &&
        existing.parentRelationship.invocation === lease &&
        (existing.phase === 'active' || existing.phase === 'settling')
      )
        return lease.activation;
      throw new Error(`Child '${childCardId}' already has a different activation owner.`);
    }
    this.requireOwnerAuthority(parent);
    let admission = this.behavior.actorStore.readActivationAdmission(childCardId);
    if (!admission)
      return this.rejectLease(lease, new Error(`Child card '${childCardId}' not found.`));
    if (cardParentId(admission.child.id) !== parent.cardId)
      return this.rejectLease(
        lease,
        new Error(`Planner can activate only immediate children of '${parent.cardId}'.`),
      );
    this.assertDurableParentRunning(parent, admission.child);
    const incomplete = admission.dependencies.filter(({ status }) => status !== 'done');
    if (incomplete.length)
      return this.rejectLease(
        lease,
        new Error(
          `Child card '${childCardId}' has incomplete dependencies: ${incomplete.map(({ id, status }) => `${id} (${status})`).join(', ')}.`,
        ),
      );
    let entry = cardProcessEntryForStatus(admission.child.lifecycle.status);
    if (entry === null)
      return this.rejectLease(
        lease,
        new Error(
          `Card '${childCardId}' in status '${admission.child.lifecycle.status}' is not activatable.`,
        ),
      );
    const initialAdmission = admission,
      initialEntry = entry;
    const admit = async (): Promise<void> => {
      let admission = initialAdmission,
        entry = initialEntry;
      if (this.behavior.workflows.gitPolicy) {
        const position = parent.processor.processPosition();
        if (position.kind !== 'node')
          throw new Error('Child source handoff requires the current parent node.');
        const current = () => {
          this.requireOwnerAuthority(parent);
          const now = parent.processor.processPosition();
          if (
            parent.terminalWinner !== 'open' ||
            parent.childCardId !== null ||
            now.kind !== 'node' ||
            now.executionOrdinal !== position.executionOrdinal
          )
            throw new Error('Parent source handoff lost its current node.');
        };
        try {
          await parent.processor.settleSourceWriters();
          current();
          await this.sourceOperation(parent, async () => {
            current();
            const facts = this.sourceFacts(parent);
            const saved = await this.nativeCommand(parent, {
              ...this.nativeRequest(parent),
              step: 'checkpoint',
              expected: { branch_ref: facts.branch_ref, observed_tip: facts.observed_tip },
            });
            current();
            if (saved.kind !== 'completed') throw new Error('Parent checkpoint did not complete.');
            this.publishSource(parent, {
              ...this.sourceFacts(parent),
              observed_tip: saved.observation.observed_tip,
              candidate: null,
              last_delivery: null,
            });
          });
          current();
          const freshAdmission = this.behavior.actorStore.readActivationAdmission(childCardId);
          if (
            !freshAdmission ||
            cardParentId(freshAdmission.child.id) !== parent.cardId ||
            freshAdmission.dependencies.some(({ status }) => status !== 'done')
          )
            throw new Error('Child admission changed during source handoff.');
          admission = freshAdmission;
          this.assertDurableParentRunning(parent, admission.child);
          const freshEntry = cardProcessEntryForStatus(admission.child.lifecycle.status);
          if (freshEntry === null)
            throw new Error('Child is no longer activatable after source handoff.');
          entry = freshEntry;
        } catch (error) {
          if (error instanceof PublicationOutcomeUnknownError)
            this.behavior.fatalPort.publicationOutcomeUnknown(error);
          if (!this.halt)
            void this.beginHalt('runtime_failure', parent, error as Error).catch(() => undefined);
          throw error;
        }
      }
      const relationship = Object.freeze({
        parentCardId: parent.cardId,
        instructions,
        invocation: lease,
      });
      const owner = this.createOwner(admission.child, entry, 'child_admission', relationship);
      this.ownershipTransition(true, () => {
        this.requireOwnerAuthority(parent);
        this.activationOwners.set(childCardId, owner);
        parent.childCardId = childCardId;
        lease.markAdmitted();
      });
      if (this.behavior.workflows.gitPolicy) {
        try {
          await this.enterSource(owner);
        } catch (error) {
          if (error instanceof PublicationOutcomeUnknownError)
            this.behavior.fatalPort.publicationOutcomeUnknown(error);
          if (!this.halt)
            void this.beginHalt('runtime_failure', owner, error as Error).catch(() => undefined);
          throw error;
        }
        this.requireOwnerAuthority(parent);
        this.requireOwnerAuthority(owner);
      }
      const running = this.publish(owner, () =>
        admission.child.lifecycle.status === 'stopped'
          ? this.behavior.actorStore.activateStopped(childCardId)
          : this.behavior.actorStore.setStatus(childCardId, 'running'),
      );
      if (!running) return;
      if (this.halt?.owners.includes(owner)) return;
      this.ownershipTransition(true, () => {
        this.requireOwnerAuthority(owner);
        owner.phase = 'active';
        owner.cachedStatus = 'running';
        this.currentCardId = childCardId;
      });
      if (this.halt?.owners.includes(owner)) return;
      this.activateProcessor(owner);
    };
    void admit().catch((error) => {
      if (error instanceof PublicationOutcomeUnknownError)
        this.behavior.fatalPort.publicationOutcomeUnknown(error);
      if (!this.halt)
        void this.beginHalt('runtime_failure', parent, error as Error).catch(() => undefined);
    });
    return lease.activation;
  }

  private rejectLease(lease: ChildInvocationLease, error: Error): Promise<never> {
    lease.markRejected();
    lease.deliverInterruption(error);
    return lease.activation as Promise<never>;
  }

  private createOwner(
    card: CardRecord,
    entry: CardProcessEntry,
    phase: 'prepared_root' | 'child_admission',
    relationship?: CardActivationOwner['parentRelationship'],
  ): CardActivationOwner {
    const activationId = randomUUID();
    const parentControl = this.boundParentControl(card.id, activationId);
    const process = this.behavior.workflows.cardTypes.get(card.type);
    if (!process) throw new Error(`No compiled workflow for card type '${card.type}'.`);
    const processor = new CardProcessActor({
      projectRoot: this.behavior.projectRoot,
      cardId: card.id,
      process,
      workflows: this.behavior.workflows,
      store: this.behavior.actorStore,
      parentControl,
      notifyCard: (id, notification) => this.notifyCard(id, notification),
      provider: this.behavior.provider,
      conversations: this.behavior.conversations,
      processRunner: this.#processRunner,
      runtimeProcessRootScope: this.#runtimeProcessRootScope,
      promptTemplates: this.behavior.promptTemplates,
      runtimeProjectionChanged: () => {
        this.ownershipInvalidated();
        this.behavior.freshness.agentMembershipChanged({ scope: 'card', cardId: card.id });
      },
      onActorMainFailure: (error) => this.onProcessorActorMainFailure(card.id, activationId, error),
      fatalPort: this.behavior.fatalPort,
      gate: this.runtimeGate,
      mcpToolInvocation: this.behavior.mcpToolInvocation,
      retrieval: this.behavior.retrieval,
      outboundHttp: this.behavior.outboundHttp,
      compactor: this.behavior.compactor,
      compactionConfig: this.behavior.compactionConfig,
      summarizerProvider: this.behavior.summarizerProvider,
    });
    processor.start();
    return new CardActivationOwner({
      card,
      processor,
      activationId,
      entry,
      phase,
      parentRelationship: relationship ?? undefined,
    });
  }

  private activateProcessor(owner: CardActivationOwner): void {
    this.assertWorkGcNotCollecting();
    this.requireOwnerAuthority(owner);
    if (owner.phase !== 'active') return;
    if (owner.entryRefusal) {
      const result = owner.entryRefusal;
      void this.settleResult(
        owner,
        { status: 'blocked', summary: result.summary, result },
        true,
      ).catch((error) => this.haltOnSettlementFailure(owner, error));
      return;
    }
    const caller =
      owner.parentRelationship === null
        ? { kind: 'root' as const }
        : {
            kind: 'parent' as const,
            cardId: owner.parentRelationship.parentCardId,
            sessionId: owner.parentRelationship.invocation.identity.sessionId,
            sourceInputId: owner.parentRelationship.invocation.identity.sourceInputId,
            toolCallId: owner.parentRelationship.invocation.identity.toolCallId,
            toolName: 'activate_card' as const,
            instructions: owner.parentRelationship.instructions,
          };
    const input = {
      activationId: owner.activationId,
      card: this.requireKnownCard(owner),
      caller,
      entry: owner.entry,
      ...(this.behavior.workflows.gitPolicy
        ? {
            nativeSource: {
              correctionPending: () => this.sourceFacts(owner).correction !== null,
              verifyCorrection: (ordinal: number) => this.verifyCorrection(owner, ordinal),
              completeCorrection: (ordinal: number) => {
                this.requireSourceOwner(owner, 'open', ordinal);
                this.publishSource(owner, { ...this.sourceFacts(owner), correction: null });
              },
              prepareCandidate: (ordinal: number) => this.prepareCandidate(owner, ordinal),
              checkpoint: (ordinal: number) => this.checkpointSource(owner, ordinal),
              verifyCandidate: (ordinal: number, source: AcceptedSource) =>
                this.verifyCandidate(owner, ordinal, source),
            },
          }
        : {}),
      notificationDelivery: {
        hasPendingNotifications: () => {
          this.requireOwnerAuthority(owner);
          return this.requireKnownCard(owner).pending_notifications.length > 0;
        },
        selectNotifications: () => {
          this.requireOwnerAuthority(owner);
          return this.behavior.actorStore.readPendingNotifications(owner.cardId);
        },
        removeNotifications: (ids: readonly string[]) => {
          this.requireOwnerAuthority(owner);
          this.behavior.actorStore.removeNotifications(owner.cardId, [...ids]);
        },
      },
      claimResult: () => this.claimResult(owner),
    };
    void owner.processor.activate(input, owner.abortController.signal).then(
      (outcome) => {
        void this.settleResult(owner, outcome).catch((error: Error) =>
          this.haltOnSettlementFailure(owner, error),
        );
      },
      (error) => {
        if (
          this.halt?.owners.includes(owner) ||
          owner.terminalWinner === 'cancel' ||
          owner.terminalWinner === 'interrupt'
        )
          return;
        if (error instanceof PublicationOutcomeUnknownError) {
          this.behavior.fatalPort.publicationOutcomeUnknown(error);
        }
        const message = error instanceof Error ? error.message : String(error);
        void this.settleResult(owner, {
          status: 'failed',
          summary: message,
          result: { kind: 'runtime-failure', summary: message },
        }).catch((settlementError: Error) => this.haltOnSettlementFailure(owner, settlementError));
      },
    );
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
      if (!owner || owner.activationId !== activationId || !halt.owners.includes(owner))
        throw new Error(
          `Card '${cardId}' actor-main failure has no owner in the current runtime halt.`,
        );
      void halt.promise.catch(() => undefined);
      return;
    }
    if (!owner || owner.activationId !== activationId)
      throw new Error(`Card '${cardId}' actor-main failure owner is no longer current.`);
    if (owner.terminalWinner === 'interrupt') return;
    void this.beginHalt('runtime_failure').catch(() => undefined);
  }

  private claimResult(owner: CardActivationOwner): void {
    this.requireOwnerAuthority(owner);
    owner.abortController.signal.throwIfAborted();
    if (owner.terminalWinner !== 'open')
      throw new Error(`Card '${owner.cardId}' terminal winner is '${owner.terminalWinner}'.`);
    owner.terminalWinner = 'result';
  }

  private sourceFacts(owner: CardActivationOwner): CardGitFacts {
    this.requireOwnerAuthority(owner);
    const facts = this.requireKnownCard(owner).git;
    if (!facts) throw new Error(`Native source selection missing for '${owner.cardId}'.`);
    return facts;
  }

  private requireSourceOwner(
    owner: CardActivationOwner,
    winner: CardActivationOwner['terminalWinner'],
    ordinal?: number,
  ): void {
    this.requireOwnerAuthority(owner);
    owner.sourceAbortController.signal.throwIfAborted();
    if (owner.terminalWinner !== winner)
      throw new Error('Native source operation lost its terminal winner.');
    if (ordinal !== undefined && !owner.processor.canInterruptNode(ordinal))
      throw new Error('Native source operation lost its invoking node.');
  }

  private nativeRequest(owner: CardActivationOwner) {
    const policy = this.behavior.workflows.gitPolicy;
    if (!policy) throw new Error('Native source operation requires the compiled policy.');
    return {
      project_root: this.behavior.projectRoot,
      timeout_ms: 120000,
      source: {
        source_roots: [...policy.source_roots],
        excluded_paths: [...policy.excluded_paths],
      },
    };
  }

  private async nativeCommand(
    owner: CardActivationOwner,
    request: NativeGitRequest,
    allowRefusal = false,
    invocationId = randomUUID(),
  ): Promise<NativeGitResult> {
    const winner = owner.terminalWinner;
    const urgent = owner.urgentSettlement;
    const position = owner.processor.processPosition();
    const ordinal =
      !urgent && owner.phase === 'active' && winner === 'open' && position.kind === 'node'
        ? position.executionOrdinal
        : undefined;
    const assertCurrent = () => {
      this.requireSourceOwner(owner, winner, ordinal);
      if (urgent !== owner.urgentSettlement)
        throw new Error('Native source operation lost its urgent settlement.');
    };
    assertCurrent();
    const result = await runGitWorkflow({
      request,
      runner: this.#processRunner,
      parentScope: this.#runtimeProcessRootScope,
      cardId: owner.cardId,
      invocationId: 'invocation_id' in request ? request.invocation_id : invocationId,
      signal: owner.sourceAbortController.signal,
      binding: {
        origin: 'activation',
        activation_id: owner.activationId,
        parent_card_id: cardParentId(owner.cardId),
        node: null,
      },
      assertCurrent,
    });
    assertCurrent();
    if ((result.kind === 'refused' && !allowRefusal) || result.kind === 'uncertain')
      throw new Error(`Native ${request.step} ${result.kind}: ${result.reason}`);
    return result;
  }

  private async prepareCandidate(
    owner: CardActivationOwner,
    ordinal: number,
  ): Promise<SourcePreparation> {
    this.requireSourceOwner(owner, 'open', ordinal);
    let prepared!: SourcePreparation;
    await this.sourceOperation(owner, async () => {
      const facts = this.sourceFacts(owner);
      if (facts.correction)
        throw new Error('Product source preparation cannot accept pending correction.');
      const invocationId = randomUUID();
      const result = await this.nativeCommand(
        owner,
        {
          ...this.nativeRequest(owner),
          step: 'prepareCandidate',
          expected: { branch_ref: facts.branch_ref, observed_tip: facts.observed_tip },
          base_oid: facts.base_oid,
          parent: facts.parent,
        },
        true,
        invocationId,
      );
      this.requireSourceOwner(owner, 'open', ordinal);
      if (result.kind === 'refused') {
        prepared = {
          refusal: {
            kind: 'git-workflow-blocked',
            step: 'prepareCandidate',
            invocation_id: invocationId,
            summary: result.reason,
          },
        };
        return;
      }
      if (result.kind !== 'candidate') throw new Error('Unexpected native candidate result.');
      const source = Object.freeze({
        branch_ref: result.observation.branch_ref,
        base_oid: result.base_oid,
        candidate_oid: result.observation.observed_tip,
        preparation_invocation_id: invocationId,
      });
      this.publishSource(owner, {
        ...this.sourceFacts(owner),
        observed_tip: source.candidate_oid,
        candidate: {
          base_oid: source.base_oid,
          candidate_oid: source.candidate_oid,
          preparation_invocation_id: invocationId,
        },
      });
      prepared = { source };
    });
    this.requireSourceOwner(owner, 'open', ordinal);
    return prepared;
  }

  private async checkpointSource(owner: CardActivationOwner, ordinal: number) {
    this.requireSourceOwner(owner, 'open', ordinal);
    if (this.sourceFacts(owner).correction)
      throw new Error('Use native correction verification while a correction task is pending.');
    let observation!: { branch_ref: string; observed_tip: string };
    try {
      await owner.processor.settleSourceWriters();
      this.requireSourceOwner(owner, 'open', ordinal);
      await this.sourceOperation(owner, async () => {
      const facts = this.sourceFacts(owner);
      if (facts.correction) throw new Error('Use native correction verification while a correction task is pending.');
      const result = await this.nativeCommand(owner, {
        ...this.nativeRequest(owner), step: 'checkpoint',
        expected: { branch_ref: facts.branch_ref, observed_tip: facts.observed_tip },
      });
      this.requireSourceOwner(owner, 'open', ordinal);
      if (result.kind !== 'completed') throw new Error('Source checkpoint did not complete.');
      observation = result.observation;
      this.publishSource(owner, { ...this.sourceFacts(owner), observed_tip: observation.observed_tip, candidate: null });
      });
    } catch (error) {
      if (error instanceof PublicationOutcomeUnknownError) throw error;
      // A failed native checkpoint must not become ordinary tool feedback that
      // permits more source work. Close admission without joining this tool itself.
      this.haltOnSettlementFailure(owner, error as Error);
      throw error;
    }
    this.requireSourceOwner(owner, 'open', ordinal);
    return observation;
  }

  private sourceCandidateMatches(facts: CardGitFacts, source: AcceptedSource): boolean {
    return (
      facts.correction === null &&
      facts.branch_ref === source.branch_ref &&
      facts.base_oid === source.base_oid &&
      facts.observed_tip === source.candidate_oid &&
      facts.candidate?.base_oid === source.base_oid &&
      facts.candidate.candidate_oid === source.candidate_oid &&
      facts.candidate.preparation_invocation_id === source.preparation_invocation_id
    );
  }

  private async verifyCandidate(
    owner: CardActivationOwner,
    ordinal: number,
    source: AcceptedSource,
  ): Promise<string | null> {
    this.requireSourceOwner(owner, 'open', ordinal);
    let violation: string | null = null;
    await this.sourceOperation(owner, async () => {
      const facts = this.sourceFacts(owner);
      if (!this.sourceCandidateMatches(facts, source)) {
        violation = 'Reviewed source selection changed; a fresh review is required.';
        return;
      }
      const result = await this.nativeCommand(
        owner,
        {
          ...this.nativeRequest(owner),
          step: 'inspect',
          expected: { branch_ref: source.branch_ref, observed_tip: source.candidate_oid },
          require_clean: true,
          parent: facts.parent,
        },
        true,
      );
      this.requireSourceOwner(owner, 'open', ordinal);
      if (result.kind === 'refused') {
        violation = result.reason;
        return;
      }
      if (result.kind !== 'completed') throw new Error('Unexpected reviewed source inspection.');
      if (!this.sourceCandidateMatches(this.sourceFacts(owner), source))
        violation = 'Reviewed source selection changed; a fresh review is required.';
    });
    this.requireSourceOwner(owner, 'open', ordinal);
    return violation;
  }

  private async deliverSource(owner: CardActivationOwner, source: AcceptedSource): Promise<void> {
    await this.sourceOperation(owner, async () => {
      const facts = this.sourceFacts(owner);
      if (!this.sourceCandidateMatches(facts, source))
        throw new Error('Accepted source selection changed before delivery.');
      const result = await this.nativeCommand(owner, {
        ...this.nativeRequest(owner),
        step: 'deliver',
        expected: { branch_ref: source.branch_ref, observed_tip: source.candidate_oid },
        parent: facts.parent,
      });
      this.requireOwnerAuthority(owner);
      if (result.kind !== 'delivered')
        throw new Error('Native delivery did not establish returned parent source.');
      owner.sourceReturned = true;
      if (owner.parentRelationship) {
        const parent = this.activationOwners.get(owner.parentRelationship.parentCardId);
        if (!parent) throw new Error('Source delivery has no current parent owner.');
        const parentFacts = this.sourceFacts(parent);
        if (
          parentFacts.branch_ref !== facts.parent.branch_ref ||
          parentFacts.observed_tip !== result.parent_before
        )
          throw new Error('Parent selection changed during delivery.');
        this.publishSource(parent, {
          ...parentFacts,
          observed_tip: result.parent_after,
          candidate: null,
          last_delivery: null,
        });
      }
      this.publishSource(owner, {
        ...this.sourceFacts(owner),
        parent: { ...facts.parent, observed_tip: result.parent_after },
        candidate: null,
        last_delivery: {
          child_tip: source.candidate_oid,
          parent_before: result.parent_before,
          parent_after: result.parent_after,
        },
      });
    });
    this.requireOwnerAuthority(owner);
  }

  private async verifyCorrection(
    owner: CardActivationOwner,
    ordinal: number,
  ): Promise<string | null> {
    this.requireSourceOwner(owner, 'open', ordinal);
    let violation: string | null = null;
    await this.sourceOperation(owner, async () => {
      const facts = this.sourceFacts(owner);
      if (!facts.correction) throw new Error('Correction verification has no current task.');
      const { preserved_source: _snapshot, ...task } = facts.correction;
      const result = await this.nativeCommand(
        owner,
        {
          ...this.nativeRequest(owner),
          step: 'verifyCorrection',
          expected: { branch_ref: facts.branch_ref, observed_tip: facts.observed_tip },
          task,
        },
        true,
      );
      this.requireSourceOwner(owner, 'open', ordinal);
      if (result.kind === 'refused') {
        violation = result.reason;
        return;
      }
      if (result.kind !== 'correction-verified')
        throw new Error('Unexpected correction verification result.');
      this.publishSource(owner, {
        ...this.sourceFacts(owner),
        observed_tip: result.observation.observed_tip,
        base_oid: result.base_oid,
        candidate: null,
        last_delivery: null,
      });
    });
    this.requireSourceOwner(owner, 'open', ordinal);
    return violation;
  }

  private publishSource(owner: CardActivationOwner, facts: CardGitFacts): void {
    this.requireOwnerAuthority(owner);
    if (!this.publish(owner, () => this.behavior.actorStore.publishGitFacts(owner.cardId, facts)))
      throw (
        this.halt?.failure ??
        this.halt?.interruption ??
        new Error('Native source publication did not complete.')
      );
  }

  /** A Supervisor-owned task is joined by halt; agent cancellation does not abort cleanup. */
  private sourceOperation(
    owner: CardActivationOwner,
    operation: () => Promise<void>,
  ): Promise<void> {
    if (owner.sourceTask) throw new Error('Native source operations cannot overlap.');
    const task = operation().then(
      () => {
        owner.sourceTask = null;
      },
      (error) => {
        if (error instanceof PublicationOutcomeUnknownError)
          this.behavior.fatalPort.publicationOutcomeUnknown(error);
        owner.sourceTask = null;
        throw error;
      },
    );
    owner.sourceTask = task;
    return task;
  }

  private async enterSource(owner: CardActivationOwner): Promise<void> {
    const policy = this.behavior.workflows.gitPolicy;
    if (!policy) return;
    await this.sourceOperation(owner, async () => {
      this.requireOwnerAuthority(owner);
      const previous = this.requireKnownCard(owner).git;
      const parentOwner = owner.parentRelationship
        ? this.activationOwners.get(owner.parentRelationship.parentCardId)
        : null;
      if (owner.parentRelationship && !parentOwner)
        throw new Error('Native child has no parent owner.');
      const parent = parentOwner ? this.sourceFacts(parentOwner) : previous?.parent;
      if (
        !parent ||
        (!parentOwner &&
          (previous?.kind !== 'root' ||
            parent.branch_ref !== `refs/heads/${policy.delivery_branch}`))
      )
        throw new Error('Root native source must be explicitly commissioned before Run.');
      const expected = { branch_ref: parent.branch_ref, observed_tip: parent.observed_tip };
      if (previous?.correction) {
        const switched = await this.nativeCommand(owner, {
          ...this.nativeRequest(owner),
          step: 'switch',
          expected,
          target: { branch_ref: previous.branch_ref, observed_tip: previous.observed_tip },
        });
        this.requireOwnerAuthority(owner);
        if (switched.kind !== 'completed')
          throw new Error('Pending correction entry did not switch source.');
        this.publishSource(owner, {
          ...previous,
          parent: expected,
          correction: { ...previous.correction, onto: expected },
        });
        owner.sourceReturned = false;
        return;
      }
      const invocationId = randomUUID();
      const result = await this.nativeCommand(
        owner,
        {
          ...this.nativeRequest(owner),
          step: 'enter',
          expected,
          owner: { namespace: policy.private_ref_namespace, card_id: owner.cardId },
          invocation_id: invocationId,
          previous: previous
            ? {
                base_oid: previous.base_oid,
                observed_tip: previous.observed_tip,
                last_delivered_child_tip: previous.last_delivery?.child_tip ?? null,
              }
            : null,
        },
        true,
      );
      this.requireOwnerAuthority(owner);
      if (result.kind === 'refused') {
        if (!result.untouched_parent)
          throw new Error(`Native entry refused without qualified parent source: ${result.reason}`);
        owner.sourceReturned = true;
        owner.entryRefusal = {
          kind: 'git-workflow-blocked',
          step: 'enter',
          invocation_id: invocationId,
          summary: result.reason,
        };
        return;
      }
      if (result.kind !== 'entered' && result.kind !== 'correction-required')
        throw new Error('Unexpected native entry result.');
      const identity =
        previous?.kind === 'root'
          ? { kind: 'root' as const, policy_digest: previous.policy_digest }
          : { kind: 'child' as const };
      this.publishSource(owner, {
        ...identity,
        branch_ref: result.observation.branch_ref,
        observed_tip: result.observation.observed_tip,
        parent: expected,
        base_oid: result.kind === 'entered' ? result.base_oid : result.task.base_oid,
        candidate: null,
        last_delivery: null,
        correction:
          result.kind === 'correction-required' ? { ...result.task, preserved_source: null } : null,
      });
      owner.sourceReturned = false;
    });
    this.requireOwnerAuthority(owner);
  }

  private async returnSource(owner: CardActivationOwner): Promise<void> {
    if (!this.behavior.workflows.gitPolicy || owner.sourceReturned) return;
    await this.sourceOperation(owner, async () => {
      const policy = this.behavior.workflows.gitPolicy!;
      let before = this.sourceFacts(owner);
      let expected = { branch_ref: before.branch_ref, observed_tip: before.observed_tip };
      if (
        before.correction &&
        !existsSync(join(this.behavior.projectRoot, '.git', 'rebase-merge'))
      ) {
        const { preserved_source: _snapshot, ...task } = before.correction;
        const verified = await this.nativeCommand(
          owner,
          { ...this.nativeRequest(owner), step: 'verifyCorrection', expected, task },
          true,
        );
        this.requireOwnerAuthority(owner);
        if (verified.kind === 'correction-verified') {
          this.publishSource(owner, {
            ...before,
            observed_tip: verified.observation.observed_tip,
            base_oid: verified.base_oid,
            candidate: null,
            last_delivery: null,
          });
          before = this.sourceFacts(owner);
          expected = { branch_ref: before.branch_ref, observed_tip: before.observed_tip };
        } else if (verified.kind !== 'refused')
          throw new Error('Unexpected settled correction verification.');
      }
      let result: NativeGitResult;
      if (
        before.correction &&
        existsSync(join(this.behavior.projectRoot, '.git', 'rebase-merge'))
      ) {
        const { preserved_source: _oldSnapshot, ...task } = before.correction;
        const capture = await this.nativeCommand(owner, {
          ...this.nativeRequest(owner),
          step: 'captureRebase',
          expected,
          allow_owned_commits: true,
          task,
          owner: { namespace: policy.private_ref_namespace, card_id: owner.cardId },
          invocation_id: randomUUID(),
        });
        this.requireOwnerAuthority(owner);
        if (capture.kind !== 'captured') throw new Error('Expected a native source capture.');
        const current = this.sourceFacts(owner);
        this.publishSource(owner, {
          ...current,
          candidate: null,
          last_delivery: null,
          correction: { ...capture.task, preserved_source: capture.preserved_source },
        });
        this.requireOwnerAuthority(owner);
        // Only this live owner carries N/Q across the successful CardService publication.
        result = await this.nativeCommand(owner, {
          ...this.nativeRequest(owner),
          step: 'restoreRebaseAndReturn',
          expected,
          allow_owned_commits: true,
          task: capture.task,
          preserved_source: capture.preserved_source,
          rebase_observation: capture.rebase_observation,
          owner: { namespace: policy.private_ref_namespace, card_id: owner.cardId },
          invocation_id: randomUUID(),
        });
      } else {
        const task = before.correction
          ? (() => {
              const { preserved_source: _snapshot, ...task } = before.correction;
              return task;
            })()
          : null;
        result = await this.nativeCommand(owner, {
          ...this.nativeRequest(owner),
          step: 'preserveAndReturn',
          expected,
          parent: before.parent,
          task,
        });
      }
      this.requireOwnerAuthority(owner);
      if (result.kind !== 'returned') throw new Error('Expected actual native source return.');
      const current = this.sourceFacts(owner);
      this.publishSource(owner, {
        ...current,
        observed_tip: result.source.observed_tip,
        candidate: null,
        last_delivery: null,
        correction: result.task
          ? {
              ...result.task,
              preserved_source:
                result.preserved_source ?? current.correction?.preserved_source ?? null,
            }
          : null,
      });
      owner.sourceReturned = true;
    });
    this.requireOwnerAuthority(owner);
  }

  private async settleResult(
    owner: CardActivationOwner,
    outcome: Exclude<
      import('../../contracts/tool-api.js').CardActivationOutcome,
      { status: 'cancelled' | 'stopped' }
    >,
    entryRefusal = false,
  ): Promise<void> {
    if (this.halt?.owners.includes(owner)) return;
    this.requireOwnerAuthority(owner);
    if (owner.terminalWinner === 'cancel') return;
    this.assertNoOwnedChildAtResultSettlement(owner);
    if (owner.cardId === PROJECT_CARD_ID) {
      const chain = selectLinkedRunningChain(this.behavior.actorStore);
      if (chain.length !== 1 || chain[0]!.id !== PROJECT_CARD_ID)
        throw new Error(
          "Natural root settlement requires the durable running chain to be exactly ['project'].",
        );
    }
    this.ownershipTransition(true, () => {
      this.requireOwnerAuthority(owner);
      if (owner.terminalWinner === 'open') owner.terminalWinner = 'result';
      if (owner.terminalWinner !== 'result')
        throw new Error(
          `Card '${owner.cardId}' cannot settle result from '${owner.terminalWinner}'.`,
        );
      owner.phase = 'settling';
      if (owner.parentRelationship?.invocation.phase() === 'admitted')
        owner.parentRelationship.invocation.markSettling();
    });
    if (this.behavior.workflows.gitPolicy && !entryRefusal) {
      owner.processor.suppressContinuationAndPrepareJoin(
        new Error('Native activation settlement.'),
      );
      await owner.processor.joinActivation();
      this.requireOwnerAuthority(owner);
      if (outcome.status === 'done') {
        const source = owner.processor.acceptedTerminalSource();
        if (!source) throw new Error('Native DONE has no same-activation accepted source.');
        await this.deliverSource(owner, source);
      } else await this.returnSource(owner);
      this.requireOwnerAuthority(owner);
    }
    const committed = this.publish(owner, () =>
      this.behavior.actorStore.commitActivationOutcome(owner.cardId, outcome, this.now()),
    );
    if (!committed) return;
    if (this.halt?.owners.includes(owner)) return;
    this.requireOwnerAuthority(owner);
    owner.cachedStatus = committed.card.lifecycle.status;
    if (entryRefusal) {
      if (owner.cardId === PROJECT_CARD_ID) this.releaseRootNaturally(owner, outcome);
      else this.releaseChildNaturally(owner, outcome);
      return;
    }
    await owner.processor.afterActivationCommit(
      committed,
      owner.activationId,
      owner.abortController.signal,
    );
    if (this.halt?.owners.includes(owner)) return;
    this.requireOwnerAuthority(owner);
    owner.processor.suppressContinuationAndPrepareJoin(new Error('Activation settled.'));
    try {
      await owner.processor.joinActivation();
    } catch {
      void this.beginHalt('runtime_failure').catch(() => undefined);
      return;
    }
    if (this.halt?.owners.includes(owner)) return;
    this.requireOwnerAuthority(owner);
    if (owner.cardId === PROJECT_CARD_ID) this.releaseRootNaturally(owner, outcome);
    else this.releaseChildNaturally(owner, outcome);
  }

  private releaseChildNaturally(
    owner: CardActivationOwner,
    outcome: import('../../contracts/tool-api.js').CardActivationOutcome,
  ): void {
    const relationship = owner.parentRelationship!;
    const lease = relationship.invocation;
    this.ownershipTransition(true, () => {
      this.requireOwnerAuthority(owner);
      const parent = this.activationOwners.get(relationship.parentCardId);
      if (!parent || parent.childCardId !== owner.cardId)
        throw new Error('Parent relationship changed before child release.');
      this.activationOwners.delete(owner.cardId);
      parent.childCardId = null;
      this.currentCardId = parent.cardId;
      lease.markReleased();
    });
    owner.settlement.resolve(outcome);
    lease.deliverOutcome(outcome);
  }

  private releaseRootNaturally(
    owner: CardActivationOwner,
    outcome: Exclude<
      import('../../contracts/tool-api.js').CardActivationOutcome,
      { status: 'cancelled' | 'stopped' }
    >,
  ): void {
    this.requireOwnerAuthority(owner);
    if (this.status !== 'running' && this.status !== 'pausing' && this.status !== 'paused')
      throw new Error(`Root cannot naturally release from '${this.status}'.`);
    this.cancelWorkGc(new Error('Project run settled naturally.'));
    this.ownershipTransition(true, () => {
      this.requireOwnerAuthority(owner);
      this.runtimeGate.completeRun();
      this.activationOwners.delete(PROJECT_CARD_ID);
      this.preparedLaunch = null;
      this.runIdentity = null;
      this.currentCardId = null;
      this.status = 'stopped';
    });
    owner.settlement.resolve(outcome);
  }

  private async cancelOwnedOrStored(
    cardId: string,
    reason: string,
    expectedParent: string | null,
  ): Promise<CardCancellationResult> {
    if (this.halt) throw this.halt.interruption;
    if (expectedParent !== null && cardParentId(cardId) !== expectedParent)
      throw new Error(`cancel_card can target only immediate children of '${expectedParent}'.`);
    const owner = this.activationOwners.get(cardId);
    if (owner) {
      this.requireOwnerAuthority(owner);
      if (owner.phase === 'child_admission')
        throw new Error(
          `Card '${cardId}' cannot be cancelled while activation publication is unresolved.`,
        );
      if (owner.terminalWinner === 'cancel' && owner.cancellationSettlement)
        return owner.cancellationSettlement;
      const suffix: CardActivationOwner[] = [];
      let current: CardActivationOwner | undefined = owner;
      while (current) {
        suffix.push(current);
        current = current.childCardId ? this.activationOwners.get(current.childCardId) : undefined;
        if (suffix.at(-1)!.childCardId && !current)
          throw new Error('Owned child relationship has no owner.');
      }
      const cancelReason = { reason, cancelled_at: this.now() };
      this.ownershipTransition(true, () => {
        for (const item of suffix) {
          this.requireOwnerAuthority(item);
          if (item.phase !== 'active')
            throw new Error(
              `Card '${item.cardId}' cannot be cancelled while activation ownership is '${item.phase}'.`,
            );
          if (item.terminalWinner !== 'open')
            throw new Error(
              `Card '${item.cardId}' ${item.terminalWinner} already claimed the activation.`,
            );
          if (item.parentRelationship && item.parentRelationship.invocation.phase() !== 'admitted')
            throw new Error(`Card '${item.cardId}' child admission is not open for cancellation.`);
        }
        for (const item of suffix) {
          item.terminalWinner = 'cancel';
          item.phase = 'settling';
          item.cancellationReason = cancelReason;
          if (item.parentRelationship) item.parentRelationship.invocation.markSettling();
        }
      });
      const cancellations = suffix.map((item) => ({ item, cancellation: new Error(reason) }));
      try {
        for (const { item, cancellation } of cancellations)
          item.processor.prepareForRuntimeHalt(cancellation);
        for (const { item, cancellation } of cancellations)
          item.abortController.abort(cancellation);
      } catch (error) {
        if (error instanceof PublicationOutcomeUnknownError)
          this.behavior.fatalPort.publicationOutcomeUnknown(error);
        void this.beginHalt('runtime_failure').catch(() => undefined);
        throw error;
      }
      const cancelled: string[] = [];
      const settlementOrder = [...suffix].reverse();
      for (const [index, item] of settlementOrder.entries()) {
        const result = await this.settleCancellation(item);
        if (index + 1 < settlementOrder.length) this.requireOwnerAuthority(owner);
        for (const id of result.cancelled_card_ids) if (!cancelled.includes(id)) cancelled.push(id);
      }
      return { card_id: cardId, status: 'cancelled', cancelled_card_ids: cancelled };
    }
    const card = this.behavior.actorStore.read(cardId);
    if (!card) throw new Error(`Card '${cardId}' not found.`);
    if (!canCancelCardStatus(card.lifecycle.status))
      throw new Error(`Card '${cardId}' in status '${card.lifecycle.status}' cannot be cancelled.`);
    if (card.lifecycle.status === 'running')
      throw new Error(`Running card '${cardId}' has no activation owner.`);
    const cancelled: string[] = [];
    await this.cancelNonrunningSubtree(cardId, cancelled);
    const halt = this.halt as RuntimeHalt | null;
    if (halt) throw halt.interruption;
    return { card_id: cardId, status: 'cancelled', cancelled_card_ids: cancelled };
  }

  private selectUrgentRoute(cardId: string): UrgentSelection {
    const notices: { cardId: string; childId: string; childStatus: string }[] = [];
    let boundary: CardActivationOwner | null = null;
    let conflictedOwner = false;
    if (cardId === PROJECT_CARD_ID) {
      const root = this.activationOwners.get(PROJECT_CARD_ID);
      if (!root) return { capture: null, notices, conflictedOwner: false };
      if (root.phase !== 'active' || root.terminalWinner !== 'open')
        return { capture: null, notices, conflictedOwner: true };
      boundary = root;
    }
    let childId = cardId;
    for (
      let parentId = cardParentId(childId);
      parentId !== null;
      parentId = cardParentId(childId)
    ) {
      const child = this.behavior.actorStore.read(childId);
      const parent = this.behavior.actorStore.read(parentId);
      if (!child || !parent || !parent.child_membership.includes(childId))
        throw new Error(`Urgent notification path '${parentId}' -> '${childId}' is not committed.`);
      const owner = this.activationOwners.get(parentId);
      if (owner && (owner.phase !== 'active' || owner.terminalWinner !== 'open'))
        conflictedOwner = true;
      if (
        acceptsCardNotifications(parent.lifecycle.status) &&
        parent.lifecycle.status !== 'blocked' &&
        (!owner || (owner.phase === 'active' && owner.terminalWinner === 'open'))
      ) {
        notices.push({ cardId: parentId, childId, childStatus: child.lifecycle.status });
        if (owner && parent.lifecycle.status === 'running') {
          boundary = owner;
          break;
        }
      }
      childId = parentId;
    }
    if (!boundary) return { capture: null, notices, conflictedOwner };
    const suffix: CardActivationOwner[] = [];
    const leases: ChildInvocationLease[] = [];
    let activeChildId = boundary.childCardId;
    while (activeChildId !== null) {
      const child = this.activationOwners.get(activeChildId);
      if (!child || !child.parentRelationship)
        throw new Error('Owned urgent descendant relationship is incomplete.');
      suffix.push(child);
      leases.push(child.parentRelationship.invocation);
      activeChildId = child.childCardId;
    }
    const position = boundary.processor.processPosition();
    if (position.kind !== 'node') return { capture: null, notices, conflictedOwner: true };
    return {
      capture: {
        boundary,
        ordinal: position.executionOrdinal,
        suffix,
        leases,
        replaceRoot: cardId === PROJECT_CARD_ID,
      },
      notices,
      conflictedOwner,
    };
  }

  private urgentNodeIsCurrent(capture: UrgentNodeCapture): boolean {
    const { boundary, ordinal } = capture;
    return (
      this.activationOwners.get(boundary.cardId) === boundary &&
      boundary.phase === 'active' &&
      boundary.terminalWinner === 'open' &&
      boundary.processor.canInterruptNode(ordinal) &&
      capture.suffix.every(
        (owner, index) =>
          this.activationOwners.get(owner.cardId) === owner &&
          owner.phase === 'active' &&
          owner.terminalWinner === 'open' &&
          owner.parentRelationship?.invocation === capture.leases[index] &&
          capture.leases[index]!.phase() === 'admitted' &&
          (index === 0
            ? boundary.childCardId === owner.cardId
            : capture.suffix[index - 1]!.childCardId === owner.cardId) &&
          owner.childCardId === (capture.suffix[index + 1]?.cardId ?? null),
      )
    );
  }

  private async settleInterruptedOwner(
    owner: CardActivationOwner,
    interruption: CardInterruptedError,
  ): Promise<InterruptedOwnerSettlement> {
    const beforeJoinHalt = this.haltFor(owner);
    if (beforeJoinHalt) return { kind: 'taken_over', halt: beforeJoinHalt };
    this.requireOwnerAuthority(owner);
    try {
      await owner.processor.joinActivation();
    } catch (error) {
      if (error instanceof PublicationOutcomeUnknownError)
        this.behavior.fatalPort.publicationOutcomeUnknown(error);
      void this.beginHalt('runtime_failure').catch(() => undefined);
      throw error;
    }
    const afterJoinHalt = this.haltFor(owner);
    if (afterJoinHalt) return { kind: 'taken_over', halt: afterJoinHalt };
    this.requireOwnerAuthority(owner);
    if (this.behavior.workflows.gitPolicy) {
      try {
        await this.returnSource(owner);
      } catch (error) {
        if (error instanceof PublicationOutcomeUnknownError)
          this.behavior.fatalPort.publicationOutcomeUnknown(error);
        if (!this.halt) void this.beginHalt('runtime_failure').catch(() => undefined);
        const halt = this.haltFor(owner);
        if (halt) return { kind: 'taken_over', halt };
        throw error;
      }
      const halt = this.haltFor(owner);
      if (halt) return { kind: 'taken_over', halt };
      this.requireOwnerAuthority(owner);
    }
    const stopped = this.publish(owner, () => this.behavior.actorStore.stopRunning(owner.cardId));
    if (!stopped) {
      const halt = this.halt;
      if (!halt)
        throw new Error(
          `Interrupted card '${owner.cardId}' stop publication returned no result without a runtime halt.`,
        );
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
      if (!parent || parent.childCardId !== owner.cardId)
        throw new Error('Interrupted child relationship changed before release.');
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

  private async replaceInterruptedRoot(
    old: CardActivationOwner,
    settlement: Promise<void>,
  ): Promise<CardActivationOwner | null> {
    this.assertWorkGcNotCollecting();
    this.requireOwnerAuthority(old);
    const stopped = this.requireKnownCard(old);
    const replacement = this.createOwner(stopped, 'STOPPED', 'prepared_root');
    this.ownershipTransition(false, () => {
      this.requireOwnerAuthority(old);
      replacement.urgentSettlement = settlement;
      this.activationOwners.set(PROJECT_CARD_ID, replacement);
    });
    old.settlement.resolve({ status: 'stopped', summary: 'Urgent root interruption.' });
    if (this.behavior.workflows.gitPolicy) {
      await this.enterSource(replacement);
      if (this.haltFor(replacement)) return null;
      this.requireOwnerAuthority(replacement);
    }
    const running = this.publish(replacement, () =>
      this.behavior.actorStore.activateStopped(PROJECT_CARD_ID),
    );
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
      try {
        await owner.processor.joinActivation();
      } catch (error) {
        if (error instanceof PublicationOutcomeUnknownError)
          this.behavior.fatalPort.publicationOutcomeUnknown(error);
        void this.beginHalt('runtime_failure').catch(() => undefined);
        throw error;
      }
      this.requireOwnerAuthority(owner);
      if (this.behavior.workflows.gitPolicy) {
        try {
          await this.returnSource(owner);
        } catch (error) {
          if (error instanceof PublicationOutcomeUnknownError)
            this.behavior.fatalPort.publicationOutcomeUnknown(error);
          if (!this.halt) void this.beginHalt('runtime_failure').catch(() => undefined);
          throw error;
        }
        this.requireOwnerAuthority(owner);
      }
      const cancelledDescendants: string[] = [];
      for (const childId of this.behavior.actorStore.listChildren(owner.cardId)) {
        this.requireOwnerAuthority(owner);
        if (!this.activationOwners.has(childId))
          await this.cancelNonrunningSubtree(childId, cancelledDescendants, owner);
        this.requireOwnerAuthority(owner);
      }
      this.requireOwnerAuthority(owner);
      const written = this.publish(owner, () =>
        this.behavior.actorStore.setStatus(owner.cardId, 'cancelled'),
      );
      if (!written) return (await owner.settlement.promise) as never;
      this.requireOwnerAuthority(owner);
      owner.cachedStatus = 'cancelled';
      const outcome = { status: 'cancelled' as const, summary: owner.cancellationReason!.reason };
      if (owner.cardId === PROJECT_CARD_ID) this.releaseRootNaturally(owner, outcome as never);
      else this.releaseChildNaturally(owner, outcome);
      return {
        card_id: owner.cardId,
        status: 'cancelled',
        cancelled_card_ids: [...cancelledDescendants, owner.cardId],
      };
    })();
    return owner.cancellationSettlement;
  }

  private beginHalt(
    trigger: 'stop' | 'application_close' | 'publication_failure' | 'runtime_failure',
    failureOwner?: CardActivationOwner,
    failure?: Error,
  ): Promise<void> {
    this.cancelWorkGc(new Error(`Runtime halt: ${trigger}.`));
    if (this.halt) {
      if (trigger === 'application_close')
        this.ownershipTransition(false, () => {
          this.applicationAdmissionOpen = false;
        });
      return this.halt.promise;
    }
    if (!this.runIdentity) throw new Error('Cannot halt a runtime without a run identity.');
    if (failureOwner && this.activationOwners.get(failureOwner.cardId) !== failureOwner)
      throw new Error(`Card '${failureOwner.cardId}' failure owner is no longer current.`);

    const owners = Object.freeze([...this.activationOwners.values()]);
    const interruption = new RuntimeStoppedInterruption();
    const settlement = deferred<void>();
    const halt: RuntimeHalt = Object.freeze({
      trigger,
      interruption,
      owners,
      promise: settlement.promise,
      ...(failure ? { failure } : {}),
    });
    let firstFailure: unknown;
    let hasFailure = false;
    const retainFirst = (error: unknown): void => {
      if (!hasFailure) {
        hasFailure = true;
        firstFailure = error;
      }
    };

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
        try {
          lease.interrupt(interruption);
        } catch (error) {
          retainFirst(error);
        }
      }
      owner.settlement.reject(
        owner === failureOwner && failure !== undefined ? failure : interruption,
      );
    }
    for (const owner of owners)
      try {
        owner.processor.prepareForRuntimeHalt(interruption);
      } catch (error) {
        retainFirst(error);
      }
    for (const owner of owners)
      try {
        owner.abortController.abort(interruption);
        owner.sourceAbortController.abort(interruption);
      } catch (error) {
        retainFirst(error);
      }

    const joins = owners.map((owner) => {
      try {
        return owner.processor.joinActivation();
      } catch (error) {
        return Promise.reject(error);
      }
    });
    let processTermination: Promise<void>;
    try {
      processTermination = this.#processRunner
        .terminateScopeTree({
          rootScope: this.#runtimeProcessRootScope,
          categories: ['runtime_card'],
          reason: trigger === 'application_close' ? 'application stopping' : 'runtime stop',
        })
        .then((report) => {
          if (report.failed.length !== 0)
            throw new Error('Runtime process-scope termination failed.');
        });
    } catch (error) {
      processTermination = Promise.reject(error);
    }

    // Halt joins current and retiring processor ownership plus captured urgent settlement.
    // Urgent settlement may observe takeover, but must never await this encompassing halt.
    void Promise.allSettled([
      ...joins,
      ...owners.flatMap((owner) =>
        owner.sourceTask
          ? [
              owner.sourceTask.catch((error) => {
                if (error instanceof PublicationOutcomeUnknownError)
                  this.behavior.fatalPort.publicationOutcomeUnknown(error);
                if (!owner.sourceAbortController.signal.aborted) throw error;
              }),
            ]
          : [],
      ),
      ...owners.flatMap((owner) => (owner.urgentSettlement ? [owner.urgentSettlement] : [])),
      processTermination,
    ]).then((results) => {
      for (const result of results) if (result.status === 'rejected') retainFirst(result.reason);
      if (hasFailure) {
        try {
          this.ownershipTransition(true, () => {
            if (this.halt !== halt)
              throw new Error('Runtime halt identity changed during failed settlement.');
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
          if (this.halt !== halt)
            throw new Error('Runtime halt identity changed during settlement.');
          const currentOwners = [...this.activationOwners.values()];
          if (
            currentOwners.length !== owners.length ||
            currentOwners.some((owner, index) => owner !== owners[index])
          )
            throw new Error('Runtime halt owner graph changed during settlement.');
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
      if (error instanceof PublicationOutcomeUnknownError)
        this.behavior.fatalPort.publicationOutcomeUnknown(error);
      void this.beginHalt('publication_failure', owner, error as Error).catch(() => undefined);
      return null;
    }
  }

  private requirePreparation(owner: CardActivationOwner, identity: object): void {
    if (this.halt?.owners.includes(owner)) throw this.halt.interruption;
    if (
      this.runIdentity !== identity ||
      this.activationOwners.get(PROJECT_CARD_ID) !== owner ||
      owner.phase !== 'prepared_root' ||
      owner.terminalWinner !== 'open' ||
      this.halt ||
      !this.applicationAdmissionOpen
    )
      throw new Error('Root preparation authority is no longer current.');
  }
  private haltFor(owner: CardActivationOwner): RuntimeHalt | null {
    const halt = this.halt;
    return halt?.owners.includes(owner) ? halt : null;
  }
  private requireOwner(owner: CardActivationOwner): void {
    if (this.activationOwners.get(owner.cardId) !== owner)
      throw new Error(`Card '${owner.cardId}' activation owner is no longer current.`);
  }
  private requireOwnerAuthority(owner: CardActivationOwner): void {
    if (this.halt?.owners.includes(owner)) throw this.halt.interruption;
    this.requireOwner(owner);
    if (this.halt)
      throw new Error(`Card '${owner.cardId}' is outside the frozen runtime halt graph.`);
  }
  private requireKnownCard(owner: CardActivationOwner): CardRecord {
    const card = this.behavior.actorStore.read(owner.cardId);
    if (!card) throw new Error(`Card '${owner.cardId}' not found.`);
    return card;
  }
  private assertDurableParentRunning(parent: CardActivationOwner, child: CardRecord): void {
    const durableParent = this.requireKnownCard(parent);
    if (durableParent.lifecycle.status !== 'running')
      throw new Error(
        `Runtime invariant failed: operation=activate_child parent=${parent.cardId} parent_status=${durableParent.lifecycle.status} child=${child.id} child_status=${child.lifecycle.status} parent_activation=${parent.activationId}.`,
      );
  }
  private assertNoOwnedChildAtResultSettlement(owner: CardActivationOwner): void {
    const childCardId = owner.childCardId;
    if (childCardId === null) return;
    const card = this.requireKnownCard(owner);
    const child = this.behavior.actorStore.read(childCardId);
    if (!child)
      throw new Error(
        `Runtime invariant failed: operation=settle_result card=${owner.cardId} activation=${owner.activationId}; owned child card '${childCardId}' not found.`,
      );
    throw new Error(
      `Runtime invariant failed: operation=settle_result card=${owner.cardId} card_status=${card.lifecycle.status} activation=${owner.activationId} child=${childCardId} child_status=${child.lifecycle.status}.`,
    );
  }
  private startRejected(error: string): StartProjectResult {
    const status = this.publicRuntimeStatus();
    return {
      runtime: this.runtimeState(),
      status,
      started: false,
      stopped: status === 'stopped',
      error,
    };
  }
  private runtimeState(): RuntimeState | null {
    if (!this.runIdentity) return null;
    if (!this.currentCardId) throw new Error('Active runtime has no current card.');
    return {
      status: this.publicRuntimeStatus(),
      project_id: 'project',
      pid: this.behavior.processIdentity.pid,
      started_at: this.behavior.processIdentity.startedAt,
      current_card_id: this.currentCardId,
      updated_at: this.now(),
    };
  }
  private publicRuntimeStatus(): RuntimeStatus {
    if (this.status === 'uninitialized') throw new Error('Runtime has not been initialized.');
    return this.status;
  }

  private ownershipTransition(invalidate: boolean, mutate: () => void): void {
    if (this.inOwnershipTransition) throw new Error('Nested ownership transition is forbidden.');
    const previousStatus = this.status;
    this.inOwnershipTransition = true;
    try {
      mutate();
      this.assertOwnershipInvariants();
    } finally {
      this.inOwnershipTransition = false;
    }
    if (previousStatus !== this.status && this.status !== 'uninitialized')
      this.behavior.runtimeStatusChanged?.(this.status);
    if (invalidate) this.ownershipInvalidated();
  }

  private assertOwnershipInvariants(): void {
    let roots = 0;
    for (const [id, owner] of this.activationOwners) {
      if (id !== owner.cardId) throw new Error('Activation owner map key mismatch.');
      if (!owner.parentRelationship) roots += 1;
      if (owner.parentRelationship) {
        const relationship = owner.parentRelationship;
        const parent = this.activationOwners.get(relationship.parentCardId);
        if (
          !parent ||
          parent.childCardId !== id ||
          owner.cardId !== relationship.invocation.childCardId
        )
          throw new Error('Activation relationship is not bidirectionally owned.');
        const lease = relationship.invocation;
        if (
          lease.relationship.childCardId !== id ||
          lease.relationship.sessionId !== lease.identity.sessionId ||
          lease.relationship.sourceInputId !== lease.identity.sourceInputId ||
          lease.relationship.toolCallId !== lease.identity.toolCallId ||
          lease.relationship.toolName !== lease.identity.toolName
        )
          throw new Error('Activation relationship lease identity mismatch.');
      }
      if (owner.childCardId) {
        const child = this.activationOwners.get(owner.childCardId);
        if (!child || child.parentRelationship?.parentCardId !== id)
          throw new Error('Activation child relationship is incomplete.');
      }
      if (owner.phase === 'child_admission' && owner.terminalWinner !== 'open')
        throw new Error('Child admission cannot have a terminal winner.');
    }
    if (roots > 1) throw new Error('Runtime has more than one root activation owner.');
    if (this.status === 'uninitialized') {
      if (
        this.runIdentity ||
        this.currentCardId ||
        this.activationOwners.size ||
        this.preparedLaunch ||
        this.halt
      )
        throw new Error('Uninitialized runtime retains ownership state.');
      return;
    }
    if (
      this.status === 'stopped' &&
      (this.runIdentity ||
        this.currentCardId ||
        this.activationOwners.size ||
        this.preparedLaunch ||
        this.halt)
    )
      throw new Error('Stopped runtime retains ownership state.');
    if (this.runIdentity && !this.currentCardId)
      throw new Error('Active runtime has no current card.');
    if (this.halt && this.status !== 'closing' && this.status !== 'error')
      throw new Error('Runtime halt requires closing or error status.');
    if (
      this.halt &&
      this.halt.owners.some((owner) => this.activationOwners.get(owner.cardId) !== owner)
    )
      throw new Error('Runtime halt owner graph is not installed.');
  }

  private ownershipInvalidated(): void {
    this.behavior.freshness.runtimeChanged();
  }
  private async cancelNonrunningSubtree(
    cardId: string,
    cancelled: string[],
    authority?: CardActivationOwner,
  ): Promise<void> {
    if (authority) this.requireOwnerAuthority(authority);
    else if (this.halt) throw this.halt.interruption;
    const owner = this.activationOwners.get(cardId);
    if (owner) {
      const result = await this.cancelOwnedOrStored(cardId, 'ancestor cancelled', null);
      if (authority) this.requireOwnerAuthority(authority);
      cancelled.push(...result.cancelled_card_ids);
      return;
    }
    const card = this.behavior.actorStore.read(cardId);
    if (!card || !canCancelCardStatus(card.lifecycle.status)) return;
    if (card.lifecycle.status === 'running')
      throw new Error(`Running card '${cardId}' has no activation owner.`);
    for (const childId of this.behavior.actorStore.listChildren(cardId)) {
      await this.cancelNonrunningSubtree(childId, cancelled, authority);
      if (authority) this.requireOwnerAuthority(authority);
      else if (this.halt) throw this.halt.interruption;
    }
    if (authority) this.requireOwnerAuthority(authority);
    else if (this.halt) throw this.halt.interruption;
    this.behavior.actorStore.setStatus(cardId, 'cancelled');
    cancelled.push(cardId);
  }
}

export function createSupervisorRuntimeApi(
  options: SupervisorRuntimeApiOptions,
): SupervisorRuntimeApi {
  return new SupervisorRuntimeApi(options);
}
function eligibleAgents(
  workflows: CompiledRuntimeWorkflows,
  card: CardRecord,
): readonly import('../../schemas/index.js').AgentName[] {
  const workflow = workflows.cardTypes.get(card.type);
  if (!workflow) throw new Error(`No compiled workflow for '${card.type}'.`);
  return [
    ...new Set(
      [...workflow.states.values()].flatMap((state) =>
        state.kind === 'node' && state.execution.kind === 'agent'
          ? [state.execution.agent.name]
          : [],
      ),
    ),
  ];
}
