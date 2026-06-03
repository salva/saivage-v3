import { join } from 'node:path';
import { CardStore } from '../cards/store-api.js';
import {
  readRuntimeState,
} from './state.js';
import type { AgentExecutionPort } from '../contracts/index.js';
import {
  listProcesses,
} from './process-runner.js';
import { EventLogger } from '../observability/index.js';
import { ErrorLogger } from '../observability/index.js';
import {
  RuntimeStateMachine,
} from './state-machine.js';
import {
  StuckAgentSupervisor,
} from '../runtime/stuck-agent-supervisor.js';
import { ActivationUnwindRunner, createFileActivationUnwindSessionPort } from './activation-unwind.js';
import { SessionStampCounter, type SessionStamper } from '../contracts/session-stamper.js';
import type { RuntimeCompositionHooks, RuntimeConfig, RuntimeSkillsPort, RuntimeTestHooks } from './runtime-config.js';
import { RuntimeGoalContextCoordinator } from './runtime-goal-context.js';
import { RuntimeProjectCommandRunner } from './runtime-project-commands.js';
import { RuntimePauseResumeController } from './runtime-pause-resume.js';
import { RuntimeRunLedger } from './runtime-run-ledger.js';
import { PendingActivationDispatcher } from './pending-activation-dispatcher.js';
import { RuntimeCardDispatcher } from './runtime-card-dispatcher.js';
import { createRuntimeSupervisor } from './supervisor-factory.js';
import { RuntimeEventPublisher } from './runtime-event-publisher.js';
import { RuntimeDiagnostics } from './runtime-diagnostics.js';
import { performRuntimeShutdown } from './runtime-shutdown.js';
import { performRuntimeStartup } from './runtime-startup.js';
import { performRuntimeCrashRecovery } from './crash-recovery.js';
import { repairRuntimeStartupActiveCardRun } from './runtime-startup-active-run-repair.js';
import { createConfiguredAgentRuntime } from './agent-runtime-factory.js';
import { createRuntimeStateMachine } from './state-machine-factory.js';
import { ActivationScheduler } from './scheduler.js';
import { createRuntimeStateMutationPort, type RuntimeStateMutationPort } from './mutations.js';

function now(): string {
  return new Date().toISOString();
}
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
  private _activationScheduler!: ActivationScheduler;
  private readonly _mutations: RuntimeStateMutationPort;
  private readonly _sessionStamper: SessionStamper;
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
    this._mutations = createRuntimeStateMutationPort(this.projectRoot);
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
    this._events = new RuntimeEventPublisher(this._eventLogger, this._mutations);
    this.cardStore = new CardStore(
      config.projectRoot,
      config.maxGoalDepth,
      undefined,
      this._events.eventBus,
    );
    this._sessionStamper = config.sessionStamper ?? new SessionStampCounter();
    this._activationUnwind = new ActivationUnwindRunner({
      cards: this.cardStore,
      sessionPort: createFileActivationUnwindSessionPort(this.projectRoot),
      sessionStamper: this._sessionStamper,
      mutations: this._mutations,
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
      mutations: this._mutations,
      publishRuntimeRun: (run) => this._events.publishRuntimeLedgerEvent('runtime_run', { run }),
    });
    this.agentRuntime = createConfiguredAgentRuntime({
      config,
      sessionStamper: this._sessionStamper,
      mutations: this._mutations,
      agentRuntime,
    });
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
    this._activationScheduler = new ActivationScheduler(
      this._goalDispatcher,
      (goalId) => this._cardDispatcher.dispatchGoal(goalId),
    );
    this._stateMachine = createRuntimeStateMachine({
      projectRoot: this.projectRoot,
      cards: this.cardStore,
      errorLogger: this._errorLogger,
      mutations: this._mutations,
      dispatchGoalThroughScheduler: (cardId) => {
        void this._activationScheduler.dispatch(cardId);
      },
    });
    this._projectCommands = new RuntimeProjectCommandRunner({
      projectRoot: this.projectRoot,
      cards: this.cardStore,
      agentRuntime: this.agentRuntime,
      eventLogger: this._eventLogger,
      sessionStamper: this._sessionStamper,
      stateMachine: this._stateMachine,
      mutations: this._mutations,
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
      dispatchGoalThroughScheduler: (goalId) => this._activationScheduler.dispatch(goalId),
    });
    this._pauseResume = new RuntimePauseResumeController({
      projectRoot: this.projectRoot,
      eventLogger: this._eventLogger,
      stateMachine: this._stateMachine,
      goalContext: this._goalContext,
      mutations: this._mutations,
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
      mutations: this._mutations,
      eventLogger: this._eventLogger,
      errorLogger: this._errorLogger,
      isPaused: () => this._paused,
      isShuttingDown: () => this._shuttingDown,
      dispatchGoalThroughScheduler: (goalId) => this._activationScheduler.dispatch(goalId),
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
      mutations: this._mutations,
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
      subscribe: (options) => this._events.eventBus.subscribe(options),
      publishRuntimeLedgerEvent: (event) => this._events.eventBus.emit(event),
      emitAnalystToolInvoked: (payload) => this._events.eventBus.emit('analyst_tool_invoked', payload),
      countGoals: () => this.cardStore.list().filter((card) => card.type === 'goal').length,
    });
    testHooks.testPartsSink?.setRuntimeTestParts({
      cards: this.cardStore,
      agentRuntime: this.agentRuntime,
      errorLogger: this._errorLogger,
      eventLogger: this._eventLogger,
      supervisor: this._supervisor,
    });
    testHooks.schedulerSink?.setDispatchGoal((goalId) => this._activationScheduler.dispatch(goalId));
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

  private consumeResumeHandoffContext(): string | null {
    const ctx = this._resumeHandoffContext;
    this._resumeHandoffContext = null;
    return ctx;
  }
  private async startup(): Promise<void> {
    await performRuntimeStartup({
      projectRoot: this.projectRoot,
      cards: this.cardStore,
      stateMachine: this._stateMachine,
      runLedger: this._runLedger,
      projectCommands: this._projectCommands,
      supervisor: this._supervisor,
      events: this._events,
      eventLogger: this._eventLogger,
      mutations: this._mutations,
      isRunning: () => this._running,
      setPaused: (paused) => {
        this._paused = paused;
      },
      setRunning: (running) => {
        this._running = running;
      },
      setShuttingDown: (shuttingDown) => {
        this._shuttingDown = shuttingDown;
      },
      setStartupRepairPending: (pending) => {
        this._startupRepairPending = pending;
      },
      repairStartupActiveCardRun: (previousState) =>
        repairRuntimeStartupActiveCardRun({
          projectRoot: this.projectRoot,
          previousState,
          cards: this.cardStore,
          stateMachine: this._stateMachine,
          activationUnwind: this._activationUnwind,
          runLedger: this._runLedger,
          mutations: this._mutations,
        }),
      dispatchGoalThroughScheduler: (goalId) => this._activationScheduler.dispatch(goalId),
      trackBackgroundDispatch: (dispatch) => this._diagnostics.trackBackgroundDispatch(dispatch),
    });
  }
  private async shutdown(): Promise<void> {
    await performRuntimeShutdown({
      projectRoot: this.projectRoot,
      cards: this.cardStore,
      agentRuntime: this.agentRuntime,
      supervisor: this._supervisor,
      stateMachine: this._stateMachine,
      diagnostics: this._diagnostics,
      mutations: this._mutations,
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
