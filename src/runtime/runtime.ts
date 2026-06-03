import { join } from 'node:path';
import type {
  RuntimeState,
} from '../schemas/index.js';
import { CardStore, PROJECT_CARD_ID } from '../cards/store-api.js';
import { queueSyntheticPlannerNote } from './synthetic-planner-notes.js';
import { reconcileOrphanedAgentSessions } from './session-persistence.js';
import {
  initRuntimeState,
  readRuntimeState,
  saveRuntimeState,
  updateRuntimeState,
  appendRuntimeRun,
  upsertRuntimeActivation,
} from './state.js';
import { acquireLock } from './lock.js';
import { createDefaultAgentExecution } from './default-agent-execution.js';
import type { AgentExecutionPort, RuntimeActivationLedgerPort } from '../contracts/index.js';
import {
  listProcesses,
  reconcileProcessRecords,
} from './process-runner.js';
import { EventLogger } from '../observability/index.js';
import { ErrorLogger } from '../observability/index.js';
import {
  RuntimeStateMachine,
  type RuntimeScheduler,
  type RuntimeSchedulerHandle,
} from './state-machine.js';
import type { RuntimeCardPort, RuntimeStatePort } from './ports.js';
import {
  StuckAgentSupervisor,
} from '../runtime/stuck-agent-supervisor.js';
import { planSweptCurrentAgentSessionPatch } from './runtime-core.js';
import { cardHasBlockedPlanning } from './planning-blockers.js';
import { ActivationUnwindRunner } from './activation-unwind.js';
import { decideStartupActiveRunRepair, executeStartupActiveRunRepairDecision, selectStartupPlannerRedispatchCardId, shouldRestartRunningIntentOnStartup } from './startup-repair.js';
import { SessionStampCounter } from '../contracts/session-stamper.js';
import type { RuntimeCompositionHooks, RuntimeConfig, RuntimeSkillsPort, RuntimeStampSource, RuntimeTestHooks } from './runtime-config.js';
import { performRuntimeCrashRecovery } from './crash-recovery.js';
import { RuntimeGoalContextCoordinator } from './runtime-goal-context.js';
import { RuntimeProjectCommandRunner } from './runtime-project-commands.js';
import { RuntimePauseResumeController } from './runtime-pause-resume.js';
import { alignBlockedPlanningCardStatuses } from './startup-blocked-planning.js';
import { reconcileIdleRunningRootRuns } from './startup-run-reconciliation.js';
import { RuntimeRunLedger } from './runtime-run-ledger.js';
import { PendingActivationDispatcher } from './pending-activation-dispatcher.js';
import { RuntimeCardDispatcher } from './runtime-card-dispatcher.js';
import { createRuntimeSupervisor } from './supervisor-factory.js';
import { RuntimeEventPublisher } from './runtime-event-publisher.js';
import { RuntimeDiagnostics } from './runtime-diagnostics.js';
import { performRuntimeShutdown } from './runtime-shutdown.js';

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled']);
function now(): string {
  return new Date().toISOString();
}
type ConfigurableAgentRuntime = AgentExecutionPort & {
  setSaivageDir?: (saivageDir: string) => void;
  setActivationLedger?: (activationLedger: RuntimeActivationLedgerPort) => void;
  setSessionStamper?: (sessionStamper: RuntimeStampSource) => void;
};

export function initializeRuntimeImplementation(
  config: RuntimeConfig,
  agentRuntime?: AgentExecutionPort,
  hooks: RuntimeCompositionHooks = {},
  testHooks: RuntimeTestHooks = {},
): void {
  new Runtime(config, agentRuntime, hooks, testHooks);
}

class Runtime {
  private readonly projectRoot: string;
  private readonly cardStore: CardStore;
  private readonly agentRuntime: AgentExecutionPort;
  private readonly _events: RuntimeEventPublisher;
  private _paused = false;
  private _running = false;
  private _shuttingDown = false;
  private _skillsEngine: RuntimeSkillsPort | null = null;
  private _eventLogger: EventLogger;
  private _ownsEventLogger: boolean;
  private _errorLogger: ErrorLogger;
  private _ownsErrorLogger: boolean;
  private readonly _runningProcesses: Set<string> = new Set();
  private _supervisor: StuckAgentSupervisor;
  private _continuousImprovementReserved: boolean;
  private _autoDispatchBacklog: boolean;
  private _resumeHandoffContext: string | null = null;
  private _startupRepairPending = false;
  /* Goal-level re-entrancy guard for dispatchGoal(goalId); the global single-active-non-analyst-session invariant is enforced by assertNoActiveAgentSession in session persistence. */ private _dispatchInFlight =
    new Set<string>();
  private readonly _diagnostics: RuntimeDiagnostics;
  private _stateMachine: RuntimeStateMachine;
  private readonly _activationUnwind: ActivationUnwindRunner;
  private readonly _goalContext: RuntimeGoalContextCoordinator;
  private _projectCommands!: RuntimeProjectCommandRunner;
  private _pauseResume!: RuntimePauseResumeController;
  private readonly _runLedger: RuntimeRunLedger;
  private _pendingActivations!: PendingActivationDispatcher;
  private _cardDispatcher!: RuntimeCardDispatcher;
  private readonly _sessionStamper: RuntimeStampSource;
  private readonly _goalDispatcher: RuntimeConfig['goalDispatcher'];

  constructor(
    config: RuntimeConfig,
    agentRuntime?: AgentExecutionPort,
    hooks: RuntimeCompositionHooks = {},
    testHooks: RuntimeTestHooks = {},
  ) {
    this.projectRoot = config.projectRoot;
    this._goalDispatcher = config.goalDispatcher;
    this._diagnostics = new RuntimeDiagnostics(testHooks.diagnosticsSink);
    if (config.eventLogger) {
      this._eventLogger = config.eventLogger;
      this._ownsEventLogger = false;
    } else {
      this._eventLogger = new EventLogger(join(config.projectRoot, '.saivage'));
      this._ownsEventLogger = true;
    }
    if (config.errorLogger) {
      this._errorLogger = config.errorLogger;
      this._ownsErrorLogger = false;
    } else {
      this._errorLogger = new ErrorLogger(join(config.projectRoot, '.saivage'));
      this._ownsErrorLogger = true;
    }
    this._events = new RuntimeEventPublisher(this.projectRoot, this._eventLogger);
    this.cardStore = new CardStore(
      config.projectRoot,
      config.maxGoalDepth,
      undefined,
      this._events.eventBus,
    );
    const activationLedger: RuntimeActivationLedgerPort = {
      readState: () => readRuntimeState(config.projectRoot),
      appendRun: (input) => appendRuntimeRun(config.projectRoot, input),
      upsertActivation: (input) => upsertRuntimeActivation(config.projectRoot, input),
    };
    this._sessionStamper = config.sessionStamper ?? new SessionStampCounter();
    this._activationUnwind = new ActivationUnwindRunner({
      projectRoot: this.projectRoot,
      cards: this.cardStore,
      sessionStamper: this._sessionStamper,
      now,
    });
    this._goalContext = new RuntimeGoalContextCoordinator({
      projectRoot: this.projectRoot,
      cards: this.cardStore,
      sessionStamper: this._sessionStamper,
    });
    this._runLedger = new RuntimeRunLedger({
      projectRoot: this.projectRoot,
      now,
      publishRuntimeRun: (run) => this._events.publishRuntimeLedgerEvent('runtime_run', { run }),
    });
    this.agentRuntime =
      agentRuntime ??
      (config.agentExecutionFactory ?? createDefaultAgentExecution)(
        config.projectRoot,
        {
          ...config.fakeAgentConfig,
          saivageDir: join(config.projectRoot, '.saivage'),
          sessionStamper: this._sessionStamper,
        },
        activationLedger,
      );
    const configurableAgentRuntime = this.agentRuntime as ConfigurableAgentRuntime;
    configurableAgentRuntime.setSaivageDir?.(join(config.projectRoot, '.saivage'));
    configurableAgentRuntime.setActivationLedger?.(activationLedger);
    configurableAgentRuntime.setSessionStamper?.(this._sessionStamper);
    this._skillsEngine = config.skillsEngine ?? null;
    this._continuousImprovementReserved = config.continuousImprovement ?? false;
    this._autoDispatchBacklog = config.autoDispatchBacklog ?? false;
    this._supervisor = createRuntimeSupervisor({
      projectRoot: this.projectRoot,
      agentRuntime: this.agentRuntime,
      eventLogger: this._eventLogger,
      supervisorConfig: config.supervisorConfig,
      emit: (kind, data) => this._events.emit(kind, data),
      isShuttingDown: () => this._shuttingDown,
    });
    const scheduler: RuntimeScheduler = {
      setInterval: (handler, ms) => setInterval(handler, ms) as unknown as RuntimeSchedulerHandle,
      clearInterval: (handle) => clearInterval(handle as unknown as NodeJS.Timeout),
    };
    const runtimeCards: RuntimeCardPort = {
      readStatus: (cardId) => this.cardStore.read(cardId)?.status,
      canTransition: (from, to) => this.cardStore.canTransition(from, to),
      setStatus: (cardId, status) => {
        this.cardStore.setStatus(cardId, status);
      },
    };
    const runtimeState: RuntimeStatePort = {
      read: () => readRuntimeState(this.projectRoot),
      patch: (changes) => updateRuntimeState(this.projectRoot, changes),
    };
    this._stateMachine = new RuntimeStateMachine({
      cards: runtimeCards,
      state: runtimeState,
      errors: this._errorLogger,
      clock: { now: () => new Date() },
      scheduler,
      redispatch: {
        redispatch: (cardId) => {
          if (!cardHasBlockedPlanning(this.cardStore.read(cardId)))
            void this.dispatchGoalThroughScheduler(cardId);
        },
      },
      projectCardId: PROJECT_CARD_ID,
    });
    this._projectCommands = new RuntimeProjectCommandRunner({
      projectRoot: this.projectRoot,
      cards: this.cardStore,
      agentRuntime: this.agentRuntime,
      eventLogger: this._eventLogger,
      sessionStamper: this._sessionStamper,
      stateMachine: this._stateMachine,
      dispatchInFlight: this._dispatchInFlight,
      isPaused: () => this._paused,
      setShuttingDown: (shuttingDown) => {
        this._shuttingDown = shuttingDown;
      },
      now,
      publishRuntimeCommand: (command) => this._events.publishRuntimeLedgerEvent('runtime_command', { command }),
      publishRuntimeRun: (run) => this._events.publishRuntimeLedgerEvent('runtime_run', { run }),
      publishActionableError: (error) =>
        this._events.publishRuntimeLedgerEvent('runtime_actionable_error', { actionable_error: error }),
      trackBackgroundDispatch: (dispatch) => this._diagnostics.trackBackgroundDispatch(dispatch),
      dispatchGoalThroughScheduler: (goalId) => this.dispatchGoalThroughScheduler(goalId),
    });
    this._pauseResume = new RuntimePauseResumeController({
      projectRoot: this.projectRoot,
      eventLogger: this._eventLogger,
      stateMachine: this._stateMachine,
      goalContext: this._goalContext,
      setPaused: (paused) => {
        this._paused = paused;
      },
      emit: (eventName, data) => this._events.emit(eventName, data),
      now,
    });
    this._pendingActivations = new PendingActivationDispatcher({
      projectRoot: this.projectRoot,
      cards: this.cardStore,
      agentRuntime: this.agentRuntime,
      skillsEngine: this._skillsEngine,
      stateMachine: this._stateMachine,
      activationUnwind: this._activationUnwind,
      eventLogger: this._eventLogger,
      errorLogger: this._errorLogger,
      isPaused: () => this._paused,
      isShuttingDown: () => this._shuttingDown,
      dispatchGoalThroughScheduler: (goalId) => this.dispatchGoalThroughScheduler(goalId),
      emit: (eventName, data) => this._events.emit(eventName, data),
      emitRuntimeDiagnostic: (input) => this._events.emitRuntimeDiagnostic(input),
      now,
    });
    this._cardDispatcher = new RuntimeCardDispatcher({
      projectRoot: this.projectRoot,
      cards: this.cardStore,
      agentRuntime: this.agentRuntime,
      skillsEngine: () => this._skillsEngine,
      eventLogger: this._eventLogger,
      errorLogger: this._errorLogger,
      stateMachine: this._stateMachine,
      goalContext: this._goalContext,
      activationUnwind: this._activationUnwind,
      pendingActivations: this._pendingActivations,
      runLedger: this._runLedger,
      sessionStamper: this._sessionStamper,
      dispatchInFlight: this._dispatchInFlight,
      isPaused: () => this._paused,
      isShuttingDown: () => this._shuttingDown,
      consumeResumeHandoffContext: () => this.consumeResumeHandoffContext(),
      emit: (eventName, data) => this._events.emit(eventName, data),
      emitRuntimeDiagnostic: (input) => this._events.emitRuntimeDiagnostic(input),
      publishRuntimeRun: (run) => this._events.publishRuntimeLedgerEvent('runtime_run', { run }),
      now,
    });
    hooks.corePartsSink?.setRuntimeCoreParts({
      eventBus: this._events.eventBus,
      cards: this.cardStore,
    });
    testHooks.testPartsSink?.setRuntimeTestParts({
      agentRuntime: this.agentRuntime,
      errorLogger: this._errorLogger,
      eventLogger: this._eventLogger,
      supervisor: this._supervisor,
    });
    testHooks.schedulerSink?.setDispatchGoal((goalId) => this._cardDispatcher.dispatchGoal(goalId));
    testHooks.eventListenerSink?.setRuntimeEventListener((eventName, listener) => {
      this._events.on(eventName, listener);
    });
    hooks.controlSink?.setRuntimeControls({
      start: () => this.startup(),
      shutdown: () => this.shutdown(),
      pause: () => this._pauseResume.pause(),
      resume: () => this._pauseResume.resume(),
      startProject: (source) => this._projectCommands.startProject(source),
      stopProject: (source) => this._projectCommands.stopProject(source),
    });
    this._diagnostics.publish();
    testHooks.lifecycleTestToolsSink?.setPerformCrashRecovery(() =>
      performRuntimeCrashRecovery({
        projectRoot: this.projectRoot,
        cards: this.cardStore.list(),
        transitionCard: (cardId, event) => this._stateMachine.transitionCard(cardId, event),
      }),
    );
    testHooks.lifecycleTestToolsSink?.setRequestImmediateTick(() => this._stateMachine.requestImmediateTick());
    hooks.agentEventSink?.setEmitAgentEvent((name, data) => this._events.emitAgentEvent(name, data));
  }

  private async repairStartupActiveCardRun(
    previousState: RuntimeState | null,
  ): Promise<RuntimeState | null> {
    const run = previousState?.active_card_run ?? null;
    const card = run ? this.cardStore.read(run.card_id) : null;
    const persistedReview =
      card?.result && typeof card.result === 'object'
        ? (card.result as { review?: unknown }).review
        : undefined;
    const decision = decideStartupActiveRunRepair({
      previousState,
      card,
      hasPersistedReview: Boolean(persistedReview),
      cardHasBlockedPlanning: card ? cardHasBlockedPlanning(card) : false,
      isTerminalCardStatus: card ? TERMINAL_STATUSES.has(card.status) : false,
    });

    return executeStartupActiveRunRepairDecision({
      decision,
      previousState,
      effects: {
        now,
        repairOrphanActivateCardToolCalls: () => this._activationUnwind.repairOrphanActivateCardToolCalls(),
        transitionCard: (cardId, event, details) => this._stateMachine.transitionCard(cardId, event, details),
        updateCard: (cardId, patch) => this.cardStore.update(cardId, patch),
        appendChildUnwindToolResult: (cardId, outcome, summary) => this._activationUnwind.appendChildUnwindToolResult(cardId, outcome, summary),
        parentPlannerRunFor: (cardId) => this._activationUnwind.parentPlannerRunFor(cardId),
        findCallerEdge: (cardId) => this._activationUnwind.findCallerEdge(cardId),
        synthesizeTerminalActivationResult: (sessionId, toolCallId, cardId) => this._activationUnwind.synthesizeTerminalActivationResult(sessionId, toolCallId, cardId),
        finishOpenPlannerRun: (cardId, result) => this._runLedger.finishOpenPlannerRun(cardId, result),
        queueSyntheticPlannerNote: (note) => queueSyntheticPlannerNote(this.projectRoot, note),
        saveState: (state) => saveRuntimeState(this.projectRoot, state),
      },
    });
  }

  private consumeResumeHandoffContext(): string | null {
    const ctx = this._resumeHandoffContext;
    this._resumeHandoffContext = null;
    return ctx;
  }
  private dispatchGoalThroughScheduler(goalId: string): Promise<void> {
    return this._goalDispatcher
      ? this._goalDispatcher(goalId, (nextGoalId: string) => this._cardDispatcher.dispatchGoal(nextGoalId))
      : this._cardDispatcher.dispatchGoal(goalId);
  }

  private async startup(): Promise<void> {
    if (this._running) throw new Error('Runtime is already running.');
    let state = readRuntimeState(this.projectRoot);
    if (!state) state = initRuntimeState(this.projectRoot);
    acquireLock(this.projectRoot);
    await alignBlockedPlanningCardStatuses({
      cards: this.cardStore,
      transitionCard: (cardId, event, details) => this._stateMachine.transitionCard(cardId, event, details),
      finishOpenPlannerRun: (goalId, result) => this._runLedger.finishOpenPlannerRun(goalId, result),
      projectRoot: this.projectRoot,
    });
    state = readRuntimeState(this.projectRoot) ?? state;
    await performRuntimeCrashRecovery({
      projectRoot: this.projectRoot,
      cards: this.cardStore.list(),
      transitionCard: (cardId, event) => this._stateMachine.transitionCard(cardId, event),
    });
    reconcileProcessRecords(this.projectRoot);
    this._startupRepairPending = true;
    const repairedState = await this.repairStartupActiveCardRun(state);
    this._startupRepairPending = false;
    if (!repairedState) state = initRuntimeState(this.projectRoot);
    else state = repairedState;
    const swept = reconcileOrphanedAgentSessions(join(this.projectRoot, '.saivage'));
    if (swept.length > 0) {
      const sweptSessionIds = swept.map((session) => session.id);
      this._events.emit('startup_session_sweep', { swept_session_ids: sweptSessionIds });
      this._eventLogger.appendEvent({
        kind: 'startup_session_sweep',
        swept_session_ids: sweptSessionIds,
      });
      const postRepairState = readRuntimeState(this.projectRoot);
      const patch = planSweptCurrentAgentSessionPatch({ state: postRepairState, sweptSessionIds });
      if (patch) {
        updateRuntimeState(this.projectRoot, patch);
        state = readRuntimeState(this.projectRoot) ?? state;
      }
    }
    this._paused = state.paused;
    this._running = true;
    this._shuttingDown = false;
    this._events.emit('started', { projectRoot: this.projectRoot });
    this._eventLogger.appendEvent({ kind: 'started', project_root: this.projectRoot });
    this._supervisor.start();
    this._stateMachine.start();
    state = reconcileIdleRunningRootRuns({
      projectRoot: this.projectRoot,
      state: readRuntimeState(this.projectRoot) ?? state,
      cards: this.cardStore,
      eventLogger: this._eventLogger,
      now,
      publishRuntimeRun: (run) => this._events.publishRuntimeLedgerEvent('runtime_run', { run }),
    });
    if (shouldRestartRunningIntentOnStartup({ state, projectHasBlockedPlanning: cardHasBlockedPlanning(this.cardStore.read(PROJECT_CARD_ID)) })) {
      this._diagnostics.trackBackgroundDispatch(this._projectCommands.startProject('runtime').then(() => undefined));
    }
    const startupActiveRunCardId = state.active_card_run?.card_id ?? null;
    const startupPlannerRedispatchCardId = selectStartupPlannerRedispatchCardId({
      state,
      activeCardHasBlockedPlanning: startupActiveRunCardId ? cardHasBlockedPlanning(this.cardStore.read(startupActiveRunCardId)) : false,
    });
    if (startupPlannerRedispatchCardId) {
      this._diagnostics.trackBackgroundDispatch(this.dispatchGoalThroughScheduler(startupPlannerRedispatchCardId));
    }
    setTimeout(() => {
      void this._stateMachine.requestImmediateTick();
    }, 0);
  }
  private async shutdown(): Promise<void> {
    await performRuntimeShutdown({
      projectRoot: this.projectRoot,
      cards: this.cardStore,
      agentRuntime: this.agentRuntime,
      supervisor: this._supervisor,
      stateMachine: this._stateMachine,
      diagnostics: this._diagnostics,
      eventLogger: this._eventLogger,
      errorLogger: this._errorLogger,
      ownsEventLogger: this._ownsEventLogger,
      ownsErrorLogger: this._ownsErrorLogger,
      runningProcesses: this._runningProcesses,
      dispatchInFlight: this._dispatchInFlight,
      isRunning: () => this._running,
      setRunning: (running) => {
        this._running = running;
      },
      setShuttingDown: (shuttingDown) => {
        this._shuttingDown = shuttingDown;
      },
      emitShutdown: () => this._events.emit('shutdown'),
    });
  }
}
