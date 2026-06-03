import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type {
  RuntimeState,
  EventKind,
  ActionableErrorEnvelope,
  RuntimeCommandRecord,
  RuntimeRunRecord,
  RuntimeActivationRecord,
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
import { acquireLock, releaseLock } from './lock.js';
import { createDefaultAgentExecution } from './default-agent-execution.js';
import type { AgentExecutionPort, RuntimeActivationLedgerPort } from '../contracts/index.js';
import {
  disposeProcessRuntimeScope,
  listProcesses,
  reconcileProcessRecords,
} from './process-runner.js';
import type { RuntimeDisposeReportEntry } from './lifecycle.js';
import {
  cleanAll,
} from '../runtime/cleanup.js';
import { EventLogger } from '../observability/index.js';
import { ErrorLogger } from '../observability/index.js';
import {
  RuntimeStateMachine,
  type RuntimeScheduler,
  type RuntimeSchedulerHandle,
} from './state-machine.js';
import type { RuntimeCardPort, RuntimeStatePort } from './ports.js';
import { EventBus } from '../events/index.js';
import { trackedEventKindValues, type EventPayload } from '../events/index.js';
import {
  StuckAgentSupervisor,
  DEFAULT_SUPERVISOR_CONFIG,
  type SupervisorConfig,
  type SupervisorDeps,
} from '../runtime/stuck-agent-supervisor.js';
import { buildCurrentAgentSessionPatch, buildShutdownRuntimeStatePatch, planSweptCurrentAgentSessionPatch } from './runtime-core.js';
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

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled']);
function now(): string {
  return new Date().toISOString();
}
function saivageWorkDir(projectRoot: string): string {
  return join(projectRoot, '.saivage-work');
}
function eventsLogPath(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'runtime', 'events.jsonl');
}
const TRACKED_EVENT_KINDS: ReadonlySet<EventKind> = new Set(trackedEventKindValues);

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
  private readonly eventBus: EventBus;
  private readonly eventEmitter = new EventEmitter();
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
  private _backgroundDispatches = new Set<Promise<void>>();
  private _lastLifecycleDisposeReport: RuntimeDisposeReportEntry[] = [];
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
  private readonly _diagnosticsSink: RuntimeTestHooks['diagnosticsSink'];

  constructor(
    config: RuntimeConfig,
    agentRuntime?: AgentExecutionPort,
    hooks: RuntimeCompositionHooks = {},
    testHooks: RuntimeTestHooks = {},
  ) {
    this.projectRoot = config.projectRoot;
    this._goalDispatcher = config.goalDispatcher;
    this._diagnosticsSink = testHooks.diagnosticsSink;
    this.eventBus = new EventBus();
    this.cardStore = new CardStore(
      config.projectRoot,
      config.maxGoalDepth,
      undefined,
      this.eventBus,
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
      publishRuntimeRun: (run) => this.publishRuntimeLedgerEvent('runtime_run', { run }),
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
    const supervisorDeps: SupervisorDeps = {
      getRecentLogs: (maxLines: number) => {
        try {
          const logPath = eventsLogPath(this.projectRoot);
          if (!existsSync(logPath)) return '';
          const raw = readFileSync(logPath, 'utf-8');
          const allLines = raw.split('\n').filter(Boolean);
          return allLines.slice(-maxLines).join('\n');
        } catch {
          return '';
        }
      },
      getActiveSessions: () => {
        try {
          const handoffs = this.agentRuntime.getActiveSessionHandoffs();
          if (!(handoffs instanceof Promise)) {
            const active = handoffs.map((handoff) => ({
              role: handoff.role,
              sessionId: handoff.session_id,
            }));
            if (active.length > 0) return active;
          }
        } catch {
          void 0;
        }
        try {
          const state = readRuntimeState(this.projectRoot);
          if (state && state.current_agent_session_id) {
            const sessionId = state.current_agent_session_id;
            let role = 'executor';
            if (sessionId.startsWith('planner-') || sessionId.startsWith('planner:'))
              role = 'planner';
            else if (sessionId.startsWith('reviewer-') || sessionId.startsWith('reviewer:'))
              role = 'reviewer';
            return [{ role, sessionId }];
          }
        } catch {
          void 0;
        }
        return [];
      },
      abortSession: (sessionId: string) => {
        void this.agentRuntime.cancelSession(sessionId);
      },
      forceCancelSession: (sessionId: string) => {
        void this.agentRuntime.forceCancelSession(sessionId);
      },
      emitEvent: (kind: string, data: Record<string, unknown>) => {
        this.emit(kind, data);
        if (TRACKED_EVENT_KINDS.has(kind as EventKind))
          this._eventLogger.appendEvent({ kind: kind as EventKind, ...data });
      },
      isShuttingDown: () => this._shuttingDown,
    };
    const mergedSupervisorConfig: SupervisorConfig = {
      ...DEFAULT_SUPERVISOR_CONFIG,
      ...config.supervisorConfig,
    };
    this._supervisor = new StuckAgentSupervisor(mergedSupervisorConfig, supervisorDeps);
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
      publishRuntimeCommand: (command) => this.publishRuntimeLedgerEvent('runtime_command', { command }),
      publishRuntimeRun: (run) => this.publishRuntimeLedgerEvent('runtime_run', { run }),
      publishActionableError: (error) =>
        this.publishRuntimeLedgerEvent('runtime_actionable_error', { actionable_error: error }),
      trackBackgroundDispatch: (dispatch) => this.trackBackgroundDispatch(dispatch),
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
      emit: (eventName, data) => this.emit(eventName, data),
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
      emit: (eventName, data) => this.emit(eventName, data),
      emitRuntimeDiagnostic: (input) => this.emitRuntimeDiagnostic(input),
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
      emit: (eventName, data) => this.emit(eventName, data),
      emitRuntimeDiagnostic: (input) => this.emitRuntimeDiagnostic(input),
      publishRuntimeRun: (run) => this.publishRuntimeLedgerEvent('runtime_run', { run }),
      now,
    });
    hooks.corePartsSink?.setRuntimeCoreParts({
      eventBus: this.eventBus,
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
      this.eventEmitter.on(eventName, listener);
    });
    hooks.controlSink?.setRuntimeControls({
      start: () => this.startup(),
      shutdown: () => this.shutdown(),
      pause: () => this._pauseResume.pause(),
      resume: () => this._pauseResume.resume(),
      startProject: (source) => this._projectCommands.startProject(source),
      stopProject: (source) => this._projectCommands.stopProject(source),
    });
    this.publishDiagnostics();
    testHooks.lifecycleTestToolsSink?.setPerformCrashRecovery(() =>
      performRuntimeCrashRecovery({
        projectRoot: this.projectRoot,
        cards: this.cardStore.list(),
        transitionCard: (cardId, event) => this._stateMachine.transitionCard(cardId, event),
      }),
    );
    testHooks.lifecycleTestToolsSink?.setRequestImmediateTick(() => this._stateMachine.requestImmediateTick());
    hooks.agentEventSink?.setEmitAgentEvent((name, data) => this.emitAgentEvent(name, data));
  }

  private publishDiagnostics(): void {
    this._diagnosticsSink?.setBackgroundDispatchCount(this._backgroundDispatches.size);
    this._diagnosticsSink?.setLastLifecycleDisposeReport([...this._lastLifecycleDisposeReport]);
  }
  private emit(eventName: string, ...args: unknown[]): boolean {
    const emitted = eventName === 'error' ? false : this.eventEmitter.emit(eventName, ...args);
    if (TRACKED_EVENT_KINDS.has(eventName as EventKind)) {
      const data =
        args[0] && typeof args[0] === 'object'
          ? (args[0] as Record<string, unknown>)
          : { raw: args[0] };
      this.eventBus.emit(eventName as EventKind, data as EventPayload<EventKind>);
    }
    return emitted;
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
  private emitAgentEvent(name: string, data: Record<string, unknown>): void {
    if (name === 'session_started' && typeof data.session_id === 'string') {
      try {
        updateRuntimeState(this.projectRoot, buildCurrentAgentSessionPatch(data.session_id));
      } catch {
        void 0;
      }
    }
    this.emit(name, data);
  }

  private emitRuntimeDiagnostic(input: {
    goal_id?: string;
    card_id?: string;
    phase?: string;
    error: unknown;
  }): void {
    const error = input.error instanceof Error ? input.error : new Error(String(input.error));
    this.emit('runtime_diagnostic', {
      goal_id: input.goal_id,
      card_id: input.card_id,
      phase: input.phase,
      error_message: error.message,
      error_name: error.name,
    });
  }

  private publishRuntimeLedgerEvent(
    kind: 'runtime_command',
    payload: { command: RuntimeCommandRecord },
  ): void;
  private publishRuntimeLedgerEvent(kind: 'runtime_run', payload: { run: RuntimeRunRecord }): void;
  private publishRuntimeLedgerEvent(
    kind: 'runtime_activation',
    payload: { activation: RuntimeActivationRecord },
  ): void;
  private publishRuntimeLedgerEvent(
    kind: 'runtime_actionable_error',
    payload: { actionable_error: ActionableErrorEnvelope },
  ): void;
  private publishRuntimeLedgerEvent(
    kind: 'runtime_command' | 'runtime_run' | 'runtime_activation' | 'runtime_actionable_error',
    payload: Record<string, unknown>,
  ): void {
    const logged = this._eventLogger.appendEvent({ kind, ...payload });
    this.eventBus.emit(logged);
    this.eventEmitter.emit(kind, payload);
  }

  private trackBackgroundDispatch(dispatch: Promise<void>): void {
    this._backgroundDispatches.add(dispatch);
    this.publishDiagnostics();
    dispatch
      .finally(() => {
        this._backgroundDispatches.delete(dispatch);
        this.publishDiagnostics();
      })
      .catch(() => undefined);
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
      this.emit('startup_session_sweep', { swept_session_ids: sweptSessionIds });
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
    this.emit('started', { projectRoot: this.projectRoot });
    this._eventLogger.appendEvent({ kind: 'started', project_root: this.projectRoot });
    this._supervisor.start();
    this._stateMachine.start();
    state = reconcileIdleRunningRootRuns({
      projectRoot: this.projectRoot,
      state: readRuntimeState(this.projectRoot) ?? state,
      cards: this.cardStore,
      eventLogger: this._eventLogger,
      now,
      publishRuntimeRun: (run) => this.publishRuntimeLedgerEvent('runtime_run', { run }),
    });
    if (shouldRestartRunningIntentOnStartup({ state, projectHasBlockedPlanning: cardHasBlockedPlanning(this.cardStore.read(PROJECT_CARD_ID)) })) {
      this.trackBackgroundDispatch(this._projectCommands.startProject('runtime').then(() => undefined));
    }
    const startupActiveRunCardId = state.active_card_run?.card_id ?? null;
    const startupPlannerRedispatchCardId = selectStartupPlannerRedispatchCardId({
      state,
      activeCardHasBlockedPlanning: startupActiveRunCardId ? cardHasBlockedPlanning(this.cardStore.read(startupActiveRunCardId)) : false,
    });
    if (startupPlannerRedispatchCardId) {
      this.trackBackgroundDispatch(this.dispatchGoalThroughScheduler(startupPlannerRedispatchCardId));
    }
    setTimeout(() => {
      void this._stateMachine.requestImmediateTick();
    }, 0);
  }
  private async shutdown(): Promise<void> {
    if (this._dispatchInFlight.size > 0) {
      await Promise.allSettled(
        Array.from(this._dispatchInFlight).map((cardId) =>
          this.agentRuntime.forceCancelSession(`planner:${cardId}`),
        ),
      );
    }
    if (!this._running) return;
    this._supervisor.stop();
    this._stateMachine.stop();
    if ((readRuntimeState(this.projectRoot)?.status ?? 'idle') === 'frozen') {
      try {
        this._lastLifecycleDisposeReport = await disposeProcessRuntimeScope(this.projectRoot);
        this.publishDiagnostics();
      } catch (error) {
        this._lastLifecycleDisposeReport = [
          {
            id: 'process-runtime-scope',
            kind: 'disposable',
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          },
        ];
        this.publishDiagnostics();
      }
      try {
        releaseLock(this.projectRoot);
      } catch {
        void 0;
      }
      this._running = false;
      this._shuttingDown = false;
      this.emit('shutdown');
      this._eventLogger.appendEvent({ kind: 'shutdown' });
      if (this._ownsEventLogger) this._eventLogger.close();
      if (this._ownsErrorLogger) this._errorLogger.close();
      return;
    }
    this._shuttingDown = true;
    this._running = false;
    try {
      this._lastLifecycleDisposeReport = await disposeProcessRuntimeScope(this.projectRoot);
      this.publishDiagnostics();
      for (const id of this._lastLifecycleDisposeReport
        .filter((entry) => entry.kind === 'child_process')
        .map((entry) => entry.id.replace(/^child:/, '')))
        this._runningProcesses.delete(id);
    } catch (error) {
      this._lastLifecycleDisposeReport = [
        {
          id: 'process-runtime-scope',
          kind: 'disposable',
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        },
      ];
      this.publishDiagnostics();
    }
    try {
      updateRuntimeState(this.projectRoot, buildShutdownRuntimeStatePatch());
    } catch {
      void 0;
    }
    try {
      releaseLock(this.projectRoot);
    } catch {
      void 0;
    }
    try {
      cleanAll(saivageWorkDir(this.projectRoot), this.cardStore);
    } catch {
      void 0;
    }
    this.emit('shutdown');
    this._eventLogger.appendEvent({ kind: 'shutdown' });
    if (this._ownsEventLogger) this._eventLogger.close();
    if (this._ownsErrorLogger) this._errorLogger.close();
  }
}
