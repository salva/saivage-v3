import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type {
  CardRecord,
  RuntimeState,
  EventKind,
  ReviewAssessment,
  ActionableErrorEnvelope,
  RuntimeCommandRecord,
  RuntimeRunRecord,
  RuntimeActivationRecord,
} from '../schemas/index.js';
import { CardStore, PROJECT_CARD_ID } from '../cards/store-api.js';
import {
  consumeChangedCardActivation,
  injectQueuedSyntheticPlannerNotes,
  queueSyntheticPlannerNote,
  drainSyntheticPlannerNotes,
} from './synthetic-planner-notes.js';
import { reconcileOrphanedAgentSessions } from './session-persistence.js';
import {
  initRuntimeState,
  readRuntimeState,
  saveRuntimeState,
  updateRuntimeState,
  appendRuntimeCommand,
  appendRuntimeRun,
  updateRuntimeRun,
  upsertRuntimeIntent,
  upsertRuntimeActivation,
} from './state.js';
import { acquireLock, releaseLock } from './lock.js';
import { createDefaultAgentExecution } from './default-agent-execution.js';
import type {
  AgentExecutionPort,
  PlannerResult,
  ReviewerResult,
  RuntimeActivationLedgerPort,
} from '../contracts/index.js';
import { unwrapFailure, type LlmTransportFailure } from '../contracts/llm-failure.js';
import {
  disposeProcessRuntimeScope,
  listProcesses,
  reconcileProcessRecords,
  setProcessTerminalBuffering,
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
  appendMessage,
} from './session-persistence.js';
import {
  StuckAgentSupervisor,
  DEFAULT_SUPERVISOR_CONFIG,
  type SupervisorConfig,
  type SupervisorDeps,
} from '../runtime/stuck-agent-supervisor.js';
import { buildCompletedRuntimeCommandState, buildCurrentAgentSessionPatch, buildDispatchPausedRuntimeStatePatch, buildPauseRuntimeStatePatch, buildRejectedRuntimeCommandState, buildResumeRuntimeStatePatch, buildShutdownRuntimeStatePatch, planClearActiveCardRunPatch, planIdleRunningRootRunReconciliation, planOpenPlannerRunTerminalUpdate, planOpenRootRunStopUpdates, planPlannerRunSessionBinding, planRootRunDispatchFailureUpdate, planRootRunDispatchSuccessUpdate, planStartProjectPrecondition, planSweptCurrentAgentSessionPatch } from './runtime-core.js';
import { cardHasBlockedPlanning, getBlockedPlanning } from './planning-blockers.js';
import { nextReviewerAssessmentId, reviewerSessionId as makeReviewerSessionId, validateReviewerAssessment } from './reviewer-assessment.js';
import { ActivationUnwindRunner, selectChildGoalActivationOutcome, selectPendingActivationChildCardIds } from './activation-unwind.js';
import { inferGoalResumeReason, type GoalResumeReason } from './goal-context.js';
import { buildProjectRunCompletedPayload } from './project-run-completion.js';
import { buildCardContextBlock as buildRuntimeCardContextBlock, buildGoalContextBlock as renderGoalContextBlock, buildGoalContextPayload as buildRuntimeGoalContextPayload, buildGoalEvidenceContext as buildRuntimeGoalEvidenceContext } from './context-builder.js';
import { buildExecutorActiveRunPatch, resolveExecutorLastSessionId, selectExecutorStartAction } from './phases/executor-phase.js';
import { ExecutorPhaseRunner } from './phases/executor-phase-runner.js';
import { buildIgnoredExecutorEvidencePatch, createExecutorEvidenceRegistrar, registerExecutorEvidence, summarizeExecutorEvidenceRegistrationFailure } from './phases/executor-evidence.js';
import { handleExecutorInvocationFailure } from './phases/executor-invocation-failure.js';
import { handleExecutorCompletion } from './phases/executor-completion-handler.js';
import { buildReviewerActiveRun, decideReviewerPhase } from './phases/reviewer-phase.js';
import { ReviewerPhaseRunner } from './phases/reviewer-phase-runner.js';
import { handleReviewerInvocationFailure } from './phases/reviewer-invocation-failure.js';
import { handleReviewerAssessmentDecision } from './phases/reviewer-assessment-handler.js';
import { buildPlannerActivationPlanningPatch, buildPlannerActiveRunPatch, buildPlannerInvocationFailureBlocker, buildProjectPlannerRetryPatch, decideGoalActivationTransition, decidePlannerPostDispatch, describeProjectPlannerRetry, planPlannerActivationSetup, summarizePlannerPostDispatch } from './phases/planner-phase.js';
import { handlePlannerInvocationFailure, selectPlannerInvocationFailureRun, type PlannerInvocationFailureKind } from './phases/planner-invocation-failure.js';
import { handlePlannerPostDispatchDecision } from './phases/planner-post-dispatch-handler.js';
import { PlannerPhaseRunner } from './phases/planner-phase-runner.js';
import { PlannerResultApplier } from './phases/planner-result-applier.js';
import { decideStartupActiveRunRepair, executeStartupActiveRunRepairDecision, selectStartupPlannerRedispatchCardId, shouldRestartRunningIntentOnStartup } from './startup-repair.js';
import { SessionStampCounter } from '../contracts/session-stamper.js';
import type { RuntimeCompositionHooks, RuntimeConfig, RuntimeSkillsPort, RuntimeStampSource, RuntimeTestHooks } from './runtime-config.js';
import { compactPersistedPlannerHistoryForRetry } from './persisted-planner-history.js';
import { performRuntimeCrashRecovery } from './crash-recovery.js';

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
function isTokenBudgetFailure(error: unknown): boolean {
  if (error && typeof error === 'object' && (error as { failure?: unknown }).failure) {
    const failure = (error as { failure: LlmTransportFailure }).failure;
    if (failure?.kind === 'token_budget_exceeded') return true;
  }
  const failure = unwrapFailure(error);
  if (failure.kind === 'token_budget_exceeded') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /context_length_exceeded|token budget exceeded|maximum context length/i.test(message);
}

function isPlannerTerminalToolExhaustion(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Role 'planner' did not emit terminal tool within \d+ turns\./.test(message);
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
    testHooks.schedulerSink?.setDispatchGoal((goalId) => this.dispatchGoal(goalId));
    testHooks.eventListenerSink?.setRuntimeEventListener((eventName, listener) => {
      this.eventEmitter.on(eventName, listener);
    });
    hooks.controlSink?.setRuntimeControls({
      start: () => this.startup(),
      shutdown: () => this.shutdown(),
      pause: () => this.pause(),
      resume: () => this.resume(),
      startProject: (source) => this.startProject(source),
      stopProject: (source) => this.stopProject(source),
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
  private userStamp(sessionId: string) {
    return this._sessionStamper.stampUserMessage(sessionId);
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
        finishOpenPlannerRun: (cardId, result) => this.finishOpenPlannerRun(cardId, result),
        queueSyntheticPlannerNote: (note) => queueSyntheticPlannerNote(this.projectRoot, note),
        saveState: (state) => saveRuntimeState(this.projectRoot, state),
      },
    });
  }

  private buildGoalContextNotes(goalId: string): Array<Record<string, unknown>> {
    return drainSyntheticPlannerNotes(this.projectRoot, `planner:${goalId}`).map((note) => ({
      kind: note.kind,
      origin_card_id: note.affected_card_id,
      descendant_card_ids: note.descendant_card_ids,
      body: note.summary,
      at: note.created_at,
    }));
  }

  private inferResumeReason(
    goalId: string,
    fallback: GoalResumeReason = 'initial',
  ): GoalResumeReason {
    const state = readRuntimeState(this.projectRoot);
    const notes = this.buildGoalContextNotes(goalId);
    return inferGoalResumeReason({ goalId, fallback, activeRun: state?.active_card_run, notes });
  }

  private buildGoalContextPayload(
    goalId: string,
    resumeReason:
      | 'initial'
      | 'reviewer_correction'
      | 'analyst_directive'
      | 'subtree_changed'
      | 'service_restart' = 'initial',
  ): Record<string, unknown> | null {
    const goal = this.cardStore.read(goalId);
    const state = readRuntimeState(this.projectRoot);
    return buildRuntimeGoalContextPayload({
      goalId,
      resumeReason,
      cards: this.cardStore,
      notes: this.buildGoalContextNotes(goalId),
      activeRun: state?.active_card_run?.card_id === goalId ? state.active_card_run : null,
    });
  }

  /** Build a canonical §9 goal-context block to attach to prompts and synthetic planner turns. */
  private buildGoalContextBlock(
    goalId: string,
    resumeReason:
      | 'initial'
      | 'reviewer_correction'
      | 'analyst_directive'
      | 'subtree_changed'
      | 'service_restart' = 'initial',
  ): string {
    const payload = this.buildGoalContextPayload(goalId, resumeReason);
    return renderGoalContextBlock({ goalId, resumeReason, payload });
  }

  private appendPlannerResumeContext(
    goalId: string,
    plannerSessionId: string,
    resumeReason:
      | 'initial'
      | 'reviewer_correction'
      | 'analyst_directive'
      | 'subtree_changed'
      | 'service_restart',
  ): void {
    appendMessage(
      join(this.projectRoot, '.saivage'),
      plannerSessionId,
      { role: 'user', kind: 'text', content: this.buildGoalContextBlock(goalId, resumeReason) },
      this.userStamp(plannerSessionId),
      this._sessionStamper,
    );
  }

  private async persistReviewState(goalId: string, assessment: ReviewAssessment): Promise<void> {
    const goal = this.cardStore.read(goalId);
    await this.cardStore.update(goalId, {
      result: { ...(goal?.result ?? {}), review: assessment },
    });
  }

  private async blockGoalWithPlanning(input: {
    goalId: string;
    blockedReason: string;
    planning: Record<string, unknown>;
    terminalReason: string;
  }): Promise<void> {
    await this._stateMachine.transitionCard(input.goalId, 'block', {
      blocked_reason: input.blockedReason,
    });
    await this.cardStore.update(input.goalId, {
      status: 'blocked',
      error: input.blockedReason,
      status_text: input.blockedReason,
      result: {
        ...(this.cardStore.read(input.goalId)?.result ?? {}),
        planning: input.planning,
      },
    });
    this.finishOpenPlannerRun(input.goalId, 'blocked');
    await this._stateMachine.transition('card_terminated', {
      goalId: input.goalId,
      reason: input.terminalReason,
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
      ? this._goalDispatcher(goalId, (nextGoalId: string) => this.dispatchGoal(nextGoalId))
      : this.dispatchGoal(goalId);
  }

  private finishOpenPlannerRun(goalId: string, result: 'blocked' | 'failed'): void {
    const plan = planOpenPlannerRunTerminalUpdate({ state: readRuntimeState(this.projectRoot), goalId, result, nowIso: now() });
    if (!plan) return;
    const updated = updateRuntimeRun(this.projectRoot, plan.runId, plan.updates);
    if (updated) this.publishRuntimeLedgerEvent('runtime_run', { run: updated });
  }

  private reconcileIdleRunningRootRuns(state: RuntimeState): RuntimeState {
    const projectCard = this.cardStore.read(PROJECT_CARD_ID);
    const projectTerminal = projectCard ? TERMINAL_STATUSES.has(projectCard.status) : false;
    const plan = planIdleRunningRootRunReconciliation({ state, projectTerminal, nowIso: now() });
    if (!plan) return state;
    let reconciled = state;
    for (const update of plan.runUpdates) {
      const updated = updateRuntimeRun(this.projectRoot, update.runId, update.updates);
      if (updated) {
        this.publishRuntimeLedgerEvent('runtime_run', { run: updated });
        reconciled = readRuntimeState(this.projectRoot) ?? reconciled;
      }
    }
    if (plan.statePatch) {
      updateRuntimeState(this.projectRoot, plan.statePatch);
      reconciled = readRuntimeState(this.projectRoot) ?? reconciled;
    }
    this._eventLogger.appendEvent({
      kind: 'runtime_diagnostic',
      phase: 'startup',
      error_message: plan.diagnosticMessage,
    });
    return readRuntimeState(this.projectRoot) ?? reconciled;
  }

  private bindPlannerSessionToOpenRun(goalId: string, plannerSessionId: string): void {
    const plan = planPlannerRunSessionBinding({ state: readRuntimeState(this.projectRoot), goalId, plannerSessionId });
    if (!plan) return;
    const updated = updateRuntimeRun(this.projectRoot, plan.runId, plan.updates);
    if (updated) this.publishRuntimeLedgerEvent('runtime_run', { run: updated });
  }

  private async startProject(source: 'operator' | 'tool' | 'runtime' | 'analyst' = 'operator'): Promise<
    | {
        success: true;
        command: RuntimeCommandRecord;
        intent: RuntimeState['runtime_intent'];
        run: RuntimeRunRecord;
      }
    | { success: false; command: RuntimeCommandRecord; error: ActionableErrorEnvelope }
  > {
    const command = appendRuntimeCommand(this.projectRoot, 'start_project', source);
    const state = readRuntimeState(this.projectRoot) ?? initRuntimeState(this.projectRoot);
    const projectCard = this.cardStore.read(PROJECT_CARD_ID);
    const blockedPlanning = getBlockedPlanning(projectCard);
    const startDecision = planStartProjectPrecondition({
      state,
      projectCardId: PROJECT_CARD_ID,
      projectCardExists: projectCard !== null,
      projectCardStatus: projectCard?.status ?? null,
      hasBlockedPlanning: cardHasBlockedPlanning(projectCard),
      blockedPlanning,
      paused: this._paused,
      source,
    });
    if (startDecision.error) {
      const error = startDecision.error;
      const rejectedAt = now();
      const rejection = buildRejectedRuntimeCommandState({ state, command, error, at: rejectedAt });
      const rejectedCommand = rejection.rejectedCommand;
      saveRuntimeState(this.projectRoot, rejection.state);
      this.publishRuntimeLedgerEvent('runtime_command', { command: rejectedCommand });
      this.publishRuntimeLedgerEvent('runtime_actionable_error', { actionable_error: error });
      return { success: false, command: rejectedCommand, error };
    }
    const { retryingPlanningBlocker, retryingTerminalToolPlanningBlocker, retryingTokenBudgetPlanningBlocker } = startDecision;
    if (retryingPlanningBlocker) {
      const retryDescription = describeProjectPlannerRetry({ retryingTokenBudgetBlocker: retryingTokenBudgetPlanningBlocker });
      await this.cardStore.update(
        PROJECT_CARD_ID,
        buildProjectPlannerRetryPatch({
          existingResult: projectCard?.result,
          retryingTokenBudgetBlocker: retryingTokenBudgetPlanningBlocker,
          compactedPersistedPlannerHistory: retryingTokenBudgetPlanningBlocker
            ? compactPersistedPlannerHistoryForRetry({
                projectRoot: this.projectRoot,
                plannerSessionId: `planner:${PROJECT_CARD_ID}`,
                sessionStamper: this._sessionStamper,
                eventLogger: this._eventLogger,
              })
            : false,
        }),
      );
      this._eventLogger.appendEvent({
        kind: 'runtime_diagnostic',
        goal_id: PROJECT_CARD_ID,
        phase: 'planner_blocked_retry',
        error_message: retryDescription.diagnosticMessage,
      });
    }
    const retryDescription = retryingPlanningBlocker
      ? describeProjectPlannerRetry({ retryingTokenBudgetBlocker: retryingTokenBudgetPlanningBlocker })
      : null;
    upsertRuntimeIntent(
      this.projectRoot,
      'running',
      command.command_id,
      retryDescription?.intentReason ?? 'explicit start_project command',
    );
    const run = appendRuntimeRun(this.projectRoot, {
      kind: 'root',
      card_id: PROJECT_CARD_ID,
      parent_run_id: null,
      command_id: command.command_id,
      activation_id: null,
      phase: 'planner',
      runtime_status: 'running',
      session_id: null,
      result: null,
    });
    this.publishRuntimeLedgerEvent('runtime_run', { run });
    if (!this._paused) {
      this.trackBackgroundDispatch(
        this.dispatchGoalThroughScheduler(PROJECT_CARD_ID)
          .then(() => {
            const plan = planRootRunDispatchSuccessUpdate({ state: readRuntimeState(this.projectRoot), runId: run.run_id, nowIso: now() });
            if (!plan) return;
            const updated = updateRuntimeRun(this.projectRoot, plan.runId, plan.updates);
            if (updated) this.publishRuntimeLedgerEvent('runtime_run', { run: updated });
          })
          .catch(async () => {
            try {
              await this._stateMachine.transition('goal_exit', {
                goalId: PROJECT_CARD_ID,
                reason: 'dispatch_failed',
              });
            } catch {
              void 0;
            }
            const plan = planRootRunDispatchFailureUpdate({ state: readRuntimeState(this.projectRoot), runId: run.run_id, nowIso: now() });
            if (!plan) return;
            const updated = updateRuntimeRun(this.projectRoot, plan.runId, plan.updates);
            if (updated) this.publishRuntimeLedgerEvent('runtime_run', { run: updated });
          }),
      );
    }
    const current = readRuntimeState(this.projectRoot) ?? state;
    const completedAt = now();
    const completion = buildCompletedRuntimeCommandState({ state: current, command, at: completedAt });
    const completedCommand = completion.completedCommand;
    saveRuntimeState(this.projectRoot, completion.state);
    this.publishRuntimeLedgerEvent('runtime_command', { command: completedCommand });
    return {
      success: true,
      command: completedCommand,
      intent: (readRuntimeState(this.projectRoot) ?? current).runtime_intent,
      run:
        ((readRuntimeState(this.projectRoot) ?? current).runtime_runs ?? []).find(
          (item) => item.run_id === run.run_id,
        ) ?? run,
    };
  }

  private async stopProject(source: 'operator' | 'tool' | 'runtime' | 'analyst' = 'operator'): Promise<{
    success: true;
    command: RuntimeCommandRecord;
    intent: RuntimeState['runtime_intent'];
    run?: RuntimeRunRecord;
  }> {
    const command = appendRuntimeCommand(this.projectRoot, 'stop_project', source);
    this._shuttingDown = true;
    const state = upsertRuntimeIntent(
      this.projectRoot,
      'stopped',
      command.command_id,
      'explicit stop_project command',
    );
    for (const cardId of this._dispatchInFlight)
      void this.agentRuntime.forceCancelSession(`planner:${cardId}`);
    const stopRunPlans = planOpenRootRunStopUpdates({ state, nowIso: now() });
    const stoppedRunIds = stopRunPlans.map((plan) => plan.runId);
    for (const plan of stopRunPlans) {
      const updated = updateRuntimeRun(this.projectRoot, plan.runId, plan.updates);
      if (updated) this.publishRuntimeLedgerEvent('runtime_run', { run: updated });
    }
    const current = readRuntimeState(this.projectRoot) ?? state;
    const completedAt = now();
    const completion = buildCompletedRuntimeCommandState({
      state: current,
      command,
      at: completedAt,
      statePatch: {
      status: 'idle',
      active_card_run: null,
      current_card_id: null,
      current_agent_session_id: null,
      },
    });
    const completedCommand = completion.completedCommand;
    saveRuntimeState(this.projectRoot, completion.state);
    this.publishRuntimeLedgerEvent('runtime_command', { command: completedCommand });
    this._shuttingDown = false;
    const persisted = readRuntimeState(this.projectRoot) ?? current;
    const stoppedRun =
      stoppedRunIds.length > 0
        ? (persisted.runtime_runs ?? []).find((item) => item.run_id === stoppedRunIds[0])
        : undefined;
    return {
      success: true,
      command: completedCommand,
      intent: persisted.runtime_intent,
      ...(stoppedRun ? { run: stoppedRun } : {}),
    };
  }

  private async alignBlockedPlanningCardStatuses(): Promise<void> {
    for (const card of this.cardStore.list()) {
      if (card.type !== 'project' && card.type !== 'goal') continue;
      if (card.status === 'failed' && isPlannerTerminalToolExhaustion(card.error ?? '')) {
        const plannerFailureBlocker = buildPlannerInvocationFailureBlocker({
          tokenBudgetFailure: false,
          providerStatus: null,
        });
        await this.cardStore.update(card.id, {
          status: 'blocked',
          error: plannerFailureBlocker.blockedReason,
          status_text: plannerFailureBlocker.blockedReason,
          result: {
            ...(card.result ?? {}),
            planning: plannerFailureBlocker.planning,
          },
        });
        this.finishOpenPlannerRun(card.id, 'blocked');
        const patch = planClearActiveCardRunPatch({ state: readRuntimeState(this.projectRoot), cardId: card.id });
        if (patch) updateRuntimeState(this.projectRoot, patch);
        continue;
      }
      if (card.status === 'blocked') continue;
      const planning =
        card.result && typeof card.result === 'object'
          ? (card.result as { planning?: unknown }).planning
          : null;
      if (!planning || typeof planning !== 'object') continue;
      const blockedPlanning = planning as {
        status?: unknown;
        resume_reason?: unknown;
        failure_kind?: unknown;
        blocked_reason?: unknown;
      };
      if (blockedPlanning.status !== 'blocked') continue;
      const blockedReason =
        typeof blockedPlanning.blocked_reason === 'string'
          ? blockedPlanning.blocked_reason
          : 'Planner context exceeded the selected LLM token budget before scheduler output could be produced; compact/trim planner context before resuming.';
      await this._stateMachine.transitionCard(card.id, 'block', { blocked_reason: blockedReason });
      this.finishOpenPlannerRun(card.id, 'blocked');
      await this.cardStore.update(card.id, {
        status: 'blocked',
        error: card.error ?? blockedReason,
        status_text: card.status_text ?? blockedReason,
      });
      const patch = planClearActiveCardRunPatch({ state: readRuntimeState(this.projectRoot), cardId: card.id });
      if (patch) updateRuntimeState(this.projectRoot, patch);
    }
  }

  private async startup(): Promise<void> {
    if (this._running) throw new Error('Runtime is already running.');
    let state = readRuntimeState(this.projectRoot);
    if (!state) state = initRuntimeState(this.projectRoot);
    acquireLock(this.projectRoot);
    await this.alignBlockedPlanningCardStatuses();
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
    state = this.reconcileIdleRunningRootRuns(readRuntimeState(this.projectRoot) ?? state);
    if (shouldRestartRunningIntentOnStartup({ state, projectHasBlockedPlanning: cardHasBlockedPlanning(this.cardStore.read(PROJECT_CARD_ID)) })) {
      this.trackBackgroundDispatch(this.startProject('runtime').then(() => undefined));
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
  private pause(): void {
    this._paused = true;
    setProcessTerminalBuffering(this.projectRoot, true);
    try {
      updateRuntimeState(this.projectRoot, buildPauseRuntimeStatePatch(now()));
    } catch {
      void 0;
    }
    this.emit('paused');
    this._eventLogger.appendEvent({ kind: 'paused' });
  }
  private resume(): void {
    this._paused = false;
    setProcessTerminalBuffering(this.projectRoot, false);
    try {
      const state = readRuntimeState(this.projectRoot);
      const plannerSessionId =
        state?.active_card_run?.planner_session_id ?? state?.current_agent_session_id;
      if (plannerSessionId && state?.active_card_run?.card_id) {
        this.appendPlannerResumeContext(
          state.active_card_run.card_id,
          plannerSessionId,
          this.inferResumeReason(state.active_card_run.card_id),
        );
        injectQueuedSyntheticPlannerNotes(this.projectRoot, plannerSessionId, {
          stampUserMessage: (id: string) => this.userStamp(id),
        });
      }
      updateRuntimeState(this.projectRoot, buildResumeRuntimeStatePatch(state));
    } catch {
      void 0;
    }
    this.emit('resumed');
    this._eventLogger.appendEvent({ kind: 'resumed' });
    void this._stateMachine.requestImmediateTick();
  }
  private async dispatchGoal(goalId: string): Promise<void> {
    if (this._dispatchInFlight.has(goalId)) return;
    this._dispatchInFlight.add(goalId);
    try {
      if (this._paused) {
        this.emit('dispatch_blocked', { reason: 'paused', goal_id: goalId });
        this._eventLogger.appendEvent({
          kind: 'dispatch_blocked',
          reason: 'paused',
          goal_id: goalId,
        });
        return;
      }
      let planCard: CardRecord;
      try {
        consumeChangedCardActivation(this.projectRoot, goalId);
        const goalCard = this.cardStore.read(goalId);
        if (!goalCard) throw new Error(`Goal '${goalId}' not found.`);
        if (goalCard.type !== 'project' && goalCard.type !== 'goal')
          throw new Error(
            `dispatchGoal requires a project or goal card, got type '${goalCard.type}'.`,
          );
        const currentStatus = goalCard.status;
        const activationTransition = decideGoalActivationTransition(currentStatus);
        if (activationTransition.kind === 'invalid_status') {
          throw new Error(
            `Goal '${goalId}' is in status '${currentStatus}' which is neither startable nor restartable.`,
          );
        }
        if (activationTransition.kind === 'transition') {
          const transitioned = await this._stateMachine.transitionCard(goalId, activationTransition.action, { goalId });
          if (!transitioned)
            throw new Error(
              `Goal '${goalId}' could not be transitioned via ${activationTransition.action} from status '${currentStatus}'.`,
            );
        }
        const refreshed = this.cardStore.read(goalId);
        if (!refreshed) throw new Error(`Goal '${goalId}' disappeared during activation.`);
        const setup = planPlannerActivationSetup({ goalId, initialStatus: currentStatus, refreshedCard: refreshed });
        const compactedPersistedPlannerHistory =
          setup.shouldCompactPersistedPlannerHistory
            ? compactPersistedPlannerHistoryForRetry({
                projectRoot: this.projectRoot,
                plannerSessionId: setup.plannerSessionId,
                sessionStamper: this._sessionStamper,
                eventLogger: this._eventLogger,
              })
            : false;
        if (setup.shouldUpdatePlanning) {
          await this.cardStore.update(
            goalId,
            buildPlannerActivationPlanningPatch({
              existingResult: setup.existingResult,
              existingError: refreshed.error,
              existingStatusText: refreshed.status_text,
              retryingTokenBudgetBlocker: setup.retryingTokenBudgetBlocker,
              retryingTerminalToolBlocker: setup.retryingTerminalToolBlocker,
              compactedPersistedPlannerHistory,
            }),
          );
        }
        planCard = this.cardStore.read(goalId)!;
        const startedAt = now();
        updateRuntimeState(this.projectRoot, buildPlannerActiveRunPatch({ goal: planCard, plannerSessionId: setup.plannerSessionId, at: startedAt }));
        this.bindPlannerSessionToOpenRun(goalId, setup.plannerSessionId);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.emitRuntimeDiagnostic({ goal_id: goalId, phase: 'activate', error: err });
        this._eventLogger.appendEvent({
          kind: 'runtime_diagnostic',
          goal_id: goalId,
          phase: 'activate',
          error_message: errorMessage,
        });
        this._errorLogger.appendError({ message: errorMessage, goalId, phase: 'activate' });
        return;
      }
      let plannerDone = false;
      const MAX_ITERATIONS = 50;
      for (let iter = 0; iter < MAX_ITERATIONS && !plannerDone && !this._shuttingDown; iter++) {
        if (this._paused) {
          this.emit('dispatch_blocked', { reason: 'paused', goal_id: goalId });
          this._eventLogger.appendEvent({
            kind: 'dispatch_blocked',
            reason: 'paused',
            goal_id: goalId,
          });
          updateRuntimeState(this.projectRoot, buildDispatchPausedRuntimeStatePatch());
          return;
        }
        let plannerResult: PlannerResult;
        try {
          plannerResult = await new PlannerPhaseRunner({
            agentRuntime: this.agentRuntime,
            skillsEngine: this._skillsEngine,
            maxDepth: this.cardStore.maxDepth,
            readGoalCard: (cardId) => this.cardStore.read(cardId),
            buildGoalEvidenceContext: (cardId) => buildRuntimeGoalEvidenceContext({ goalId: cardId, cards: this.cardStore }),
            buildGoalContextBlock: (cardId, resumeReason) => this.buildGoalContextBlock(cardId, resumeReason),
            inferResumeReason: (cardId, fallback) => this.inferResumeReason(cardId, fallback),
            consumeResumeHandoffContext: () => this.consumeResumeHandoffContext(),
            injectSyntheticPlannerNotes: (cardId) => {
              injectQueuedSyntheticPlannerNotes(this.projectRoot, `planner:${cardId}`, {
                stampUserMessage: (id: string) => this.userStamp(id),
              });
            },
          }).run({ goalId, iteration: iter });
        } catch (err) {
          const failedRun = selectPlannerInvocationFailureRun({ state: readRuntimeState(this.projectRoot), goalId });
          const tokenBudgetFailure = isTokenBudgetFailure(err);
          const failureKind: PlannerInvocationFailureKind = tokenBudgetFailure
            ? 'token_budget'
            : isPlannerTerminalToolExhaustion(err)
              ? 'terminal_tool'
              : 'generic';
          const failure = await handlePlannerInvocationFailure({
            goalId,
            error: err,
            failureKind,
            providerStatus: tokenBudgetFailure
              ? ((err as { failure?: { status?: number } }).failure?.status ?? null)
              : null,
            existingResult: this.cardStore.read(goalId)?.result,
            failedRun,
            effects: {
              now,
              emitRuntimeDiagnostic: (input) => this.emitRuntimeDiagnostic(input),
              appendRuntimeDiagnostic: (input) => this._eventLogger.appendEvent({ kind: 'runtime_diagnostic', ...input }),
              appendError: (input) => this._errorLogger.appendError(input),
              transitionCard: (cardId, event, details) => this._stateMachine.transitionCard(cardId, event, details),
              updateCard: (cardId, patch) => this.cardStore.update(cardId, patch),
              updateRuntimeRun: (runId, updates) => updateRuntimeRun(this.projectRoot, runId, updates),
              publishRuntimeRun: (run) => this.publishRuntimeLedgerEvent('runtime_run', { run }),
              transitionRuntime: (event, details) => this._stateMachine.transition(event, details),
            },
          });
          if (failure.kind === 'handled') return;
          throw failure.error;
        }
        await new PlannerResultApplier({
          cardStore: this.cardStore,
          transitionCard: (cardId, action, input) => this._stateMachine.transitionCard(cardId, action, input),
        }).apply(goalId, plannerResult);
        updateRuntimeState(this.projectRoot, buildCurrentAgentSessionPatch(`planner:${goalId}`));
        const execution = await this.dispatchPendingActivations(goalId);
        if (execution.failed) plannerDone = false;
        if (this._shuttingDown) break;
        if (this._paused) {
          this.emit('dispatch_blocked', { reason: 'paused', goal_id: goalId });
          this._eventLogger.appendEvent({
            kind: 'dispatch_blocked',
            reason: 'paused',
            goal_id: goalId,
          });
          return;
        }
        const postDispatchSummary = summarizePlannerPostDispatch({ plannerResult, childCards: this.cardStore.list(), goalId });
        const hasGoalDispatch = execution.dispatchedGoal;
        const postDispatchDecision = decidePlannerPostDispatch({
          plannerResult,
          currentCard: this.cardStore.read(goalId),
          createdCardIds: postDispatchSummary.createdCardIds,
          updatedCardIds: postDispatchSummary.updatedCardIds,
          hasGoalDispatch,
          hasUnfinishedChildWork: postDispatchSummary.hasUnfinishedChildWork,
          executedTerminal: execution.executedTerminal,
          isProjectCard: goalId === PROJECT_CARD_ID,
        });
        const postDispatch = await handlePlannerPostDispatchDecision({
          goalId,
          decision: postDispatchDecision,
          effects: {
            blockGoalWithPlanning: (input) => this.blockGoalWithPlanning(input),
            updateGoalCard: (cardId, patch) => this.cardStore.update(cardId, patch),
            transitionGoalExit: (cardId, reason) => this._stateMachine.transition('goal_exit', { goalId: cardId, reason }),
          },
        });
        plannerDone = postDispatch.plannerDone;
        if (postDispatch.shouldReturn) return;
        if (plannerDone) {
          const assessmentId = nextReviewerAssessmentId(goalId, this.cardStore.read(goalId)?.result);
          const reviewerSessionId = makeReviewerSessionId(goalId, assessmentId);
          let reviewResult: ReviewerResult;
          try {
            reviewResult = await new ReviewerPhaseRunner({
              agentRuntime: this.agentRuntime,
              skillsEngine: this._skillsEngine,
              readGoalCard: (cardId) => this.cardStore.read(cardId),
              buildGoalContextBlock: (cardId) => this.buildGoalContextBlock(cardId),
              buildGoalEvidenceContext: (cardId) => buildRuntimeGoalEvidenceContext({ goalId: cardId, cards: this.cardStore }),
              markReviewerStarted: async ({ goalId: startedGoalId, reviewerSessionId: startedReviewerSessionId, goalCard }) => {
                const startedAt = now();
                await this._stateMachine.transition('reviewer_started', {
                  goalId: startedGoalId,
                  reviewerSessionId: startedReviewerSessionId,
                  activeCardRun: buildReviewerActiveRun({
                    goalId: startedGoalId,
                    reviewerSessionId: startedReviewerSessionId,
                    goalCard,
                    at: startedAt,
                  }),
                });
              },
            }).run({ goalId, assessmentId, reviewerSessionId });
            this.emit('review_complete', { goal_id: goalId, assessment: reviewResult.assessment });
            this._eventLogger.appendEvent({
              kind: 'review_complete',
              goal_id: goalId,
              assessment: reviewResult.assessment,
            });
          } catch (err) {
            await handleReviewerInvocationFailure({
              goalId,
              error: err,
              existingResult: this.cardStore.read(goalId)?.result,
              effects: {
                emitRuntimeDiagnostic: (input) => this.emitRuntimeDiagnostic(input),
                appendRuntimeDiagnostic: (input) => this._eventLogger.appendEvent({ kind: 'runtime_diagnostic', ...input }),
                appendError: (input) => this._errorLogger.appendError(input),
                transitionCard: (cardId, event, details) => this._stateMachine.transitionCard(cardId, event, details),
                updateCard: (cardId, patch) => this.cardStore.update(cardId, patch),
                finishOpenPlannerRun: (cardId, result) => this.finishOpenPlannerRun(cardId, result),
                transitionRuntime: (event, details) => this._stateMachine.transition(event, details),
              },
            });
            return;
          }
          const validation = validateReviewerAssessment({ goalId, assessment: reviewResult.assessment, readCard: (evidenceId) => this.cardStore.read(evidenceId) });
          const reviewerDecision = decideReviewerPhase({ assessment: reviewResult.assessment, validation });
          const reviewerOutcome = await handleReviewerAssessmentDecision({
            goalId,
            projectCardId: PROJECT_CARD_ID,
            assessmentId,
            reviewerSessionId,
            reviewResult,
            decision: reviewerDecision,
            effects: {
              now,
              readCard: (cardId) => this.cardStore.read(cardId),
              transitionCard: (cardId, event, details) => this._stateMachine.transitionCard(cardId, event, details),
              updateCard: (cardId, patch) => this.cardStore.update(cardId, patch),
              persistReviewState: (cardId, assessment) => this.persistReviewState(cardId, assessment),
              emitReviewFailed: (cardId, assessment) => {
                this.emit('review_failed', { goal_id: cardId, assessment });
                this._eventLogger.appendEvent({ kind: 'review_failed', goal_id: cardId, assessment });
              },
              emitGoalCompleted: (cardId, assessment) => {
                this.emit('goal_completed', { goal_id: cardId, assessment });
                this._eventLogger.appendEvent({ kind: 'goal_completed', goal_id: cardId, assessment });
              },
              appendChildUnwindToolResult: (cardId, outcome, summary) => this._activationUnwind.appendChildUnwindToolResult(cardId, outcome, summary),
              transitionRuntime: (event, details) => this._stateMachine.transition(event, details),
              emitProjectRunCompleted: (cardId, assessment) => {
                const projectCard = this.cardStore.read(cardId);
                if (!projectCard) return;
                const payload = buildProjectRunCompletedPayload(projectCard, assessment);
                this.emit('project_run_completed', payload);
                this._eventLogger.appendEvent({ kind: 'project_run_completed', ...payload });
              },
            },
          });
          if (reviewerOutcome.kind === 'completed') {
            return;
          }
          plannerDone = false;
        }
      }
      if (this._shuttingDown) {
        this.emit('dispatch_interrupted', { goal_id: goalId, reason: 'shutdown' });
        this._eventLogger.appendEvent({
          kind: 'dispatch_interrupted',
          goal_id: goalId,
          reason: 'shutdown',
        });
      }
    } finally {
      this._dispatchInFlight.delete(goalId);
    }
  }

  private getPendingActivationCards(goalId: string): CardRecord[] {
    return selectPendingActivationChildCardIds(readRuntimeState(this.projectRoot), goalId)
      .map((childCardId) => this.cardStore.read(childCardId))
      .filter((card): card is CardRecord => Boolean(card));
  }

  private async dispatchPendingActivations(
    goalId: string,
  ): Promise<{ dispatchedGoal: boolean; executedTerminal: boolean; failed: boolean }> {
    let activationCards = this.getPendingActivationCards(goalId);
    const goalCard = this.cardStore.read(goalId);
    let dispatchedGoal = false;
    let executedTerminal = false;
    let failed = false;
    while (activationCards.length > 0 && !this._shuttingDown) {
      if (this._paused) return { dispatchedGoal, executedTerminal, failed };
      for (const card of activationCards) {
        if (this._shuttingDown || this._paused) return { dispatchedGoal, executedTerminal, failed };
        const callerEdge = this._activationUnwind.findCallerEdge(card.id);
        if (card.type === 'goal') {
          await this.dispatchGoalThroughScheduler(card.id);
          const completedCard = this.cardStore.read(card.id);
          const outcome = selectChildGoalActivationOutcome(completedCard);
          this._activationUnwind.appendChildUnwindToolResult(
            card.id,
            outcome,
            `Child goal ${card.id} finished with status ${completedCard?.status ?? 'unknown'}.`,
          );
          dispatchedGoal = true;
          if (outcome !== 'done') return { dispatchedGoal, executedTerminal, failed };
          continue;
        }
        {
          const startAction = selectExecutorStartAction(card.status);
          const transitioned =
            startAction === null
              ? true
              : await this._stateMachine.transitionCard(card.id, startAction, {
                  goalId,
                  reason: 'pending_activation_dispatch',
                });
          if (!transitioned) {
            failed = true;
            return { dispatchedGoal, executedTerminal, failed };
          }
        }
        {
          const startedAt = now();
          updateRuntimeState(this.projectRoot, buildExecutorActiveRunPatch({ card, goalId, callerEdge, at: startedAt }));
        }
        let execResult;
        try {
          execResult = await new ExecutorPhaseRunner({
            agentRuntime: this.agentRuntime,
            skillsEngine: this._skillsEngine,
            buildCardContextBlock: (cardId, parentGoalId) => buildRuntimeCardContextBlock({ cardId, goalId: parentGoalId, cards: this.cardStore }),
          }).run({ card, goalId, goalCard });
        } catch (err) {
          await handleExecutorInvocationFailure({
            cardId: card.id,
            goalId,
            error: err,
            effects: {
              emitRuntimeDiagnostic: (input) => this.emitRuntimeDiagnostic(input),
              appendRuntimeDiagnostic: (input) => this._eventLogger.appendEvent({ kind: 'runtime_diagnostic', ...input }),
              appendError: (input) => this._errorLogger.appendError(input),
              transitionCard: (cardId, event, details) => this._stateMachine.transitionCard(cardId, event, details),
              appendChildUnwindToolResult: (cardId, outcome, summary) => this._activationUnwind.appendChildUnwindToolResult(cardId, outcome, summary),
              emitCardFailed: (cardId, parentGoalId) => {
                this.emit('card_failed', { card_id: cardId, goal_id: parentGoalId });
                this._eventLogger.appendEvent({ kind: 'card_failed', card_id: cardId, goal_id: parentGoalId });
              },
            },
          });
          failed = true;
          return { dispatchedGoal, executedTerminal, failed };
        }
        const acceptedAt = now();
        const stateAfterExecutor = readRuntimeState(this.projectRoot);
        const lastSessionId = resolveExecutorLastSessionId({
          adapterLastSessionId: (
            this.agentRuntime as {
              getLastSessionId?: (role: 'executor', goalId: string, cardId: string) => string | null;
            }
          ).getLastSessionId?.('executor', goalId, card.id),
          activeRunExecutorSessionId: stateAfterExecutor?.active_card_run?.executor_session_id,
          currentAgentSessionId: stateAfterExecutor?.current_agent_session_id,
        });
        const {
          artifactRegistrationErrors,
          attachmentRegistrationErrors,
          ignoredArtifactRegistrations,
          ignoredAttachmentRegistrations,
        } = registerExecutorEvidence(
          createExecutorEvidenceRegistrar({
            projectRoot: this.projectRoot,
            cards: this.cardStore,
            cardId: card.id,
            onRegistrationError: ({ phase, error, errorMessage }) => {
              this.emitRuntimeDiagnostic({ card_id: card.id, goal_id: goalId, phase, error });
              this._eventLogger.appendEvent({ kind: 'runtime_diagnostic', card_id: card.id, phase, error_message: errorMessage });
              this._errorLogger.appendError({ message: errorMessage, cardId: card.id, goalId, phase });
            },
          }),
          execResult,
        );
        const ignoredEvidencePatch = buildIgnoredExecutorEvidencePatch({
          existingResult: this.cardStore.read(card.id)?.result,
          ignoredArtifactRegistrations,
          ignoredAttachmentRegistrations,
        });
        if (ignoredEvidencePatch) await this.cardStore.update(card.id, ignoredEvidencePatch);
        const { registrationFailed, registrationError } = summarizeExecutorEvidenceRegistrationFailure({
          execStatus: execResult.status,
          artifactRegistrationErrors,
          attachmentRegistrationErrors,
        });
        const completion = await handleExecutorCompletion({
          cardId: card.id,
          goalId,
          execResult,
          acceptedAt,
          lastSessionId,
          registrationFailed,
          registrationError,
          artifactRegistrationErrors,
          attachmentRegistrationErrors,
          effects: {
            now,
            transitionCard: (cardId, event, details) => this._stateMachine.transitionCard(cardId, event, details),
            readCard: (cardId) => this.cardStore.read(cardId),
            updateCard: (cardId, patch) => this.cardStore.update(cardId, patch),
            appendChildUnwindToolResult: (cardId, outcome, summary) => this._activationUnwind.appendChildUnwindToolResult(cardId, outcome, summary),
            emitCardFailed: (cardId, parentGoalId) => {
              this.emit('card_failed', { card_id: cardId, goal_id: parentGoalId });
              this._eventLogger.appendEvent({ kind: 'card_failed', card_id: cardId, goal_id: parentGoalId });
            },
          },
        });
        executedTerminal = executedTerminal || completion.executedTerminal;
        if (!completion.transitioned || completion.failed) {
          failed = true;
          return { dispatchedGoal, executedTerminal, failed };
        }
      }
      activationCards = this.getPendingActivationCards(goalId);
    }
    return { dispatchedGoal, executedTerminal, failed };
  }

}
