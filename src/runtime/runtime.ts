import { join } from 'node:path';
import { CardStore } from '../cards/store-api.js';
import type { AgentExecutionPort } from '../contracts/index.js';
import { EventLogger } from '../observability/index.js';
import { ErrorLogger } from '../observability/index.js';
import {
  StuckAgentSupervisor,
} from '../runtime/stuck-agent-supervisor.js';
import { ActivationUnwindRunner, createFileActivationUnwindSessionPort } from './activation-unwind.js';
import { SessionStampCounter, type SessionStamper } from '../contracts/session-stamper.js';
import type { RuntimeCompositionHooks, RuntimeConfig, RuntimeSkillsPort, RuntimeTestHooks } from './runtime-config.js';
import { RuntimeGoalContextCoordinator } from './runtime-goal-context.js';
import { RuntimeRunLedger } from './runtime-run-ledger.js';
import { createRuntimeSupervisor } from './supervisor-factory.js';
import { RuntimeEventPublisher } from './runtime-event-publisher.js';
import { RuntimeDiagnostics } from './runtime-diagnostics.js';
import { performRuntimeShutdown } from './runtime-shutdown.js';
import { performRuntimeStartup } from './runtime-startup.js';
import { performRuntimeCrashRecovery } from './crash-recovery.js';
import { repairRuntimeStartupActiveCardRun } from './runtime-startup-active-run-repair.js';
import { createConfiguredAgentRuntime } from './agent-runtime-factory.js';
import { createRuntimeStateMutationPort, type RuntimeStateMutationPort } from './mutations.js';
import { RuntimeLifecycleState } from './runtime-lifecycle-state.js';
import { createRuntimeDispatchCollaborators, type RuntimeDispatchCollaborators } from './runtime-dispatch-composition.js';

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
  private _skillsEngine: RuntimeSkillsPort | null = null;
  private _eventLogger: EventLogger;
  private _ownsEventLogger: boolean;
  private _errorLogger: ErrorLogger;
  private _ownsErrorLogger: boolean;
  private _supervisor: StuckAgentSupervisor;
  private readonly _diagnostics: RuntimeDiagnostics;
  private _stateMachine: RuntimeDispatchCollaborators['stateMachine'];
  private readonly _activationUnwind: ActivationUnwindRunner;
  private readonly _goalContext: RuntimeGoalContextCoordinator;
  private _projectCommands!: RuntimeDispatchCollaborators['projectCommands'];
  private _pauseResume!: RuntimeDispatchCollaborators['pauseResume'];
  private readonly _runLedger: RuntimeRunLedger;
  private _activationScheduler!: RuntimeDispatchCollaborators['activationScheduler'];
  private readonly _mutations: RuntimeStateMutationPort;
  private readonly _sessionStamper: SessionStamper;
  private readonly lifecycle = new RuntimeLifecycleState();

  constructor(
    config: RuntimeConfig,
    agentRuntime?: AgentExecutionPort,
    hooks: RuntimeCompositionHooks = {},
    testHooks: RuntimeTestHooks = {},
  ) {
    this.projectRoot = config.projectRoot;
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
    this._supervisor = createRuntimeSupervisor({
      projectRoot: this.projectRoot,
      agentRuntime: this.agentRuntime,
      eventLogger: this._eventLogger,
      supervisorConfig: config.supervisorConfig,
      lifecycle: this.lifecycle,
      emit: (kind, data) => this._events.emit(kind, data),
    });
    const dispatchCollaborators = createRuntimeDispatchCollaborators({
      projectRoot: this.projectRoot,
      config,
      cards: this.cardStore,
      agentRuntime: this.agentRuntime,
      getSkillsEngine: () => this._skillsEngine,
      eventLogger: this._eventLogger,
      errorLogger: this._errorLogger,
      events: this._events,
      diagnostics: this._diagnostics,
      mutations: this._mutations,
      lifecycle: this.lifecycle,
      sessionStamper: this._sessionStamper,
      activationUnwind: this._activationUnwind,
      goalContext: this._goalContext,
      runLedger: this._runLedger,
      now,
    });
    this._activationScheduler = dispatchCollaborators.activationScheduler;
    this._stateMachine = dispatchCollaborators.stateMachine;
    this._projectCommands = dispatchCollaborators.projectCommands;
    this._pauseResume = dispatchCollaborators.pauseResume;
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
      lifecycle: this.lifecycle,
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
      lifecycle: this.lifecycle,
      emitShutdown: () => this._events.emit('shutdown'),
    });
  }
}
