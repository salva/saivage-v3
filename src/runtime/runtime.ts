import { CardStore } from '../cards/store-api.js';
import type { AgentExecutionPort } from '../contracts/index.js';
import { EventLogger } from '../observability/index.js';
import { ErrorLogger } from '../observability/index.js';
import {
  StuckAgentSupervisor,
} from '../runtime/stuck-agent-supervisor.js';
import { ActivationUnwindRunner } from './activation-unwind.js';
import { SessionStampCounter } from './session-stamp-counter.js';
import type { SessionStamper } from './session-stamper.js';
import type { RuntimeAssembly, RuntimeConfig, RuntimeControls, RuntimeCoreParts, RuntimeDiagnosticsObserver, RuntimeSkillsPort } from './runtime-config.js';
import { createRuntimeGoalContextCoordinator, type RuntimeGoalContextCoordinator } from './runtime-goal-context.js';
import { createRuntimeRunLedger, type RuntimeRunLedger } from './runtime-run-ledger.js';
import { createRuntimeSupervisor } from './stuck-agent-supervisor.js';
import { RuntimeEventPublisher } from './runtime-event-publisher.js';
import { createRuntimeDiagnostics, type RuntimeDiagnostics } from './runtime-diagnostics.js';
import { createConfiguredAgentRuntime } from './agent-runtime-factory.js';
import { createRuntimeStateMutationPort, type RuntimeStateMutationPort } from './mutations.js';
import { createRuntimeLifecycleController, type RuntimeLifecycleController } from './runtime-lifecycle-controller.js';
import { createLifecycleFlags } from './runtime-lifecycle-state.js';
import { createRuntimeDispatchCollaborators, type RuntimeDispatchCollaborators } from './runtime-dispatch-composition.js';
import { createFileRuntimeSessionPersistencePort } from './session-persistence-port.js';
import { now } from '../utils/clock.js';

export function initializeRuntimeImplementation(
  config: RuntimeConfig,
  agentRuntime?: AgentExecutionPort,
  options: { includeTestParts?: boolean; diagnosticsObserver?: RuntimeDiagnosticsObserver } = {},
): RuntimeAssembly {
  return new Runtime(config, agentRuntime, options).assembly;
}

class Runtime {
  private readonly projectRoot: string;
  private readonly cardStore: CardStore;
  private readonly agentRuntime: AgentExecutionPort;
  private readonly _events: RuntimeEventPublisher;
  private _skillsEngine: RuntimeSkillsPort | null = null;
  private _eventLogger: EventLogger;
  private _errorLogger: ErrorLogger;
  private _supervisor: StuckAgentSupervisor;
  private readonly _diagnostics: RuntimeDiagnostics;
  private _stateMachine: RuntimeDispatchCollaborators['stateMachine'];
  private readonly _activationUnwind: ActivationUnwindRunner;
  private readonly _goalContext: RuntimeGoalContextCoordinator;
  private _projectCommands!: RuntimeDispatchCollaborators['projectCommands'];
  private _pauseResume!: RuntimeDispatchCollaborators['pauseResume'];
  private readonly _runLedger: RuntimeRunLedger;
  private _plannerDispatcher!: RuntimeDispatchCollaborators['plannerDispatcher'];
  private readonly _mutations: RuntimeStateMutationPort;
  private readonly _sessionStamper: SessionStamper;
  private readonly lifecycle = createLifecycleFlags();
  private _lifecycleController!: RuntimeLifecycleController;
  private readonly _assembly: RuntimeAssembly;

  constructor(
    config: RuntimeConfig,
    agentRuntime?: AgentExecutionPort,
    options: { includeTestParts?: boolean; diagnosticsObserver?: RuntimeDiagnosticsObserver } = {},
  ) {
    this.projectRoot = config.projectRoot;
    this._diagnostics = createRuntimeDiagnostics(options.diagnosticsObserver);
    this._mutations = createRuntimeStateMutationPort(this.projectRoot);
    this._eventLogger = config.eventLogger;
    this._errorLogger = config.errorLogger;
    this._events = new RuntimeEventPublisher(this._eventLogger, config.eventBus);
    this.cardStore = config.cardStore;
    this._sessionStamper = config.sessionStamper ?? new SessionStampCounter();
    this._activationUnwind = new ActivationUnwindRunner({
      cards: this.cardStore,
      sessionPort: createFileRuntimeSessionPersistencePort(this.projectRoot),
      sessionStamper: this._sessionStamper,
      mutations: this._mutations,
      now,
    });
    this._goalContext = createRuntimeGoalContextCoordinator({
      projectRoot: this.projectRoot,
      cards: this.cardStore,
      sessionStamper: this._sessionStamper,
    });
    this._runLedger = createRuntimeRunLedger({
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
    this._plannerDispatcher = dispatchCollaborators.plannerDispatcher;
    this._stateMachine = dispatchCollaborators.stateMachine;
    this._projectCommands = dispatchCollaborators.projectCommands;
    this._pauseResume = dispatchCollaborators.pauseResume;
    this._lifecycleController = createRuntimeLifecycleController({
      projectRoot: this.projectRoot,
      cards: this.cardStore,
      agentRuntime: this.agentRuntime,
      supervisor: this._supervisor,
      stateMachine: this._stateMachine,
      runLedger: this._runLedger,
      projectCommands: this._projectCommands,
      events: this._events,
      eventLogger: this._eventLogger,
      errorLogger: this._errorLogger,
      ownsEventLogger: false,
      ownsErrorLogger: false,
      diagnostics: this._diagnostics,
      mutations: this._mutations,
      lifecycle: this.lifecycle,
      activationUnwind: this._activationUnwind,
      plannerDispatcher: this._plannerDispatcher,
    });
    const coreParts: RuntimeCoreParts = {
      subscribe: (options) => this._events.eventBus.subscribe(options),
      publishRuntimeLedgerEvent: (kind, payload) => this._events.eventBus.emit(kind, payload),
      emitAnalystToolInvoked: (payload) => this._events.eventBus.emit('analyst_tool_invoked', payload),
      countGoals: () => this.cardStore.list().filter((card) => card.type === 'goal').length,
    };
    const controls: RuntimeControls = {
      start: () => this._lifecycleController.start(),
      shutdown: () => this._lifecycleController.shutdown(),
      pause: () => this._pauseResume.pause(),
      resume: () => this._pauseResume.resume(),
      startProject: (source) => this._projectCommands.startProject(source),
      stopProject: (source) => this._projectCommands.stopProject(source),
    };
    this._diagnostics.publish();
    this._assembly = {
      controls,
      coreParts,
      emitAgentEvent: (name, data) => this._events.emitAgentEvent(name, data),
      ...(options.includeTestParts
        ? {
            testParts: {
              cards: this.cardStore,
              agentRuntime: this.agentRuntime,
              errorLogger: this._errorLogger,
              eventLogger: this._eventLogger,
              supervisor: this._supervisor,
              dispatchGoal: (goalId) => this._plannerDispatcher.dispatchGoal(goalId),
              onRuntimeEvent: (eventName, listener) => this._events.on(eventName, listener),
              performCrashRecovery: () => this._lifecycleController.performCrashRecovery(),
              requestImmediateTick: () => this._lifecycleController.requestImmediateTick(),
            },
          }
        : {}),
    };
  }

  get assembly(): RuntimeAssembly {
    return this._assembly;
  }
}
