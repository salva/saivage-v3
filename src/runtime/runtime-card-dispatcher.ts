import type { AgentExecutionPort, PlannerResult, ReviewerResult } from '../contracts/index.js';
import { unwrapFailure, type LlmTransportFailure } from '../contracts/llm-failure.js';
import type { CardRecord, ReviewAssessment } from '../schemas/index.js';
import type { RuntimeRunRecord } from '../schemas/index.js';
import type { ErrorLogger, EventLogger } from '../observability/index.js';
import type { CardStore } from '../cards/store-api.js';
import { PROJECT_CARD_ID } from '../cards/store-api.js';
import type { RuntimeSkillsPort, RuntimeStampSource } from './runtime-config.js';
import type { RuntimeStateMachine } from './state-machine.js';
import type { RuntimeGoalContextCoordinator } from './runtime-goal-context.js';
import type { RuntimeRunLedger } from './runtime-run-ledger.js';
import type { ActivationUnwindRunner } from './activation-unwind.js';
import type { PendingActivationDispatcher } from './pending-activation-dispatcher.js';
import { consumeChangedCardActivation } from './synthetic-planner-notes.js';
import { readRuntimeState, updateRuntimeRun, updateRuntimeState } from './state.js';
import {
  buildCurrentAgentSessionPatch,
  buildDispatchPausedRuntimeStatePatch,
} from './runtime-core.js';
import { buildGoalEvidenceContext } from './context-builder.js';
import {
  buildPlannerActivationPlanningPatch,
  buildPlannerActiveRunPatch,
  decideGoalActivationTransition,
  decidePlannerPostDispatch,
  planPlannerActivationSetup,
  summarizePlannerPostDispatch,
} from './phases/planner-phase.js';
import {
  handlePlannerInvocationFailure,
  selectPlannerInvocationFailureRun,
  type PlannerInvocationFailureKind,
} from './phases/planner-invocation-failure.js';
import { handlePlannerPostDispatchDecision } from './phases/planner-post-dispatch-handler.js';
import { PlannerPhaseRunner } from './phases/planner-phase-runner.js';
import { PlannerResultApplier } from './phases/planner-result-applier.js';
import {
  buildReviewerActiveRun,
  decideReviewerPhase,
} from './phases/reviewer-phase.js';
import { ReviewerPhaseRunner } from './phases/reviewer-phase-runner.js';
import { handleReviewerInvocationFailure } from './phases/reviewer-invocation-failure.js';
import { handleReviewerAssessmentDecision } from './phases/reviewer-assessment-handler.js';
import {
  nextReviewerAssessmentId,
  reviewerSessionId as makeReviewerSessionId,
  validateReviewerAssessment,
} from './reviewer-assessment.js';
import { compactPersistedPlannerHistoryForRetry } from './persisted-planner-history.js';
import { isPlannerTerminalToolExhaustion } from './startup-blocked-planning.js';
import { buildProjectRunCompletedPayload } from './project-run-completion.js';

const MAX_PLANNER_ITERATIONS = 50;

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

export class RuntimeCardDispatcher {
  constructor(
    private readonly deps: {
      projectRoot: string;
      cards: CardStore;
      agentRuntime: AgentExecutionPort;
      skillsEngine(): RuntimeSkillsPort | null;
      eventLogger: EventLogger;
      errorLogger: ErrorLogger;
      stateMachine: RuntimeStateMachine;
      goalContext: RuntimeGoalContextCoordinator;
      activationUnwind: ActivationUnwindRunner;
      pendingActivations: PendingActivationDispatcher;
      runLedger: RuntimeRunLedger;
      sessionStamper: RuntimeStampSource;
      dispatchInFlight: Set<string>;
      isPaused(): boolean;
      isShuttingDown(): boolean;
      consumeResumeHandoffContext(): string | null;
      emit(eventName: string, data: Record<string, unknown>): void;
      emitRuntimeDiagnostic(input: { goal_id?: string; card_id?: string; phase?: string; error: unknown }): void;
      publishRuntimeRun(run: RuntimeRunRecord): void;
      now(): string;
    },
  ) {}

  async dispatchGoal(goalId: string): Promise<void> {
    if (this.deps.dispatchInFlight.has(goalId)) return;
    this.deps.dispatchInFlight.add(goalId);
    try {
      if (this.deps.isPaused()) {
        this.emitDispatchBlocked(goalId);
        return;
      }
      let planCard: CardRecord;
      try {
        planCard = await this.activatePlanner(goalId);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.deps.emitRuntimeDiagnostic({ goal_id: goalId, phase: 'activate', error: err });
        this.deps.eventLogger.appendEvent({
          kind: 'runtime_diagnostic',
          goal_id: goalId,
          phase: 'activate',
          error_message: errorMessage,
        });
        this.deps.errorLogger.appendError({ message: errorMessage, goalId, phase: 'activate' });
        return;
      }

      let plannerDone = false;
      for (let iter = 0; iter < MAX_PLANNER_ITERATIONS && !plannerDone && !this.deps.isShuttingDown(); iter++) {
        if (this.deps.isPaused()) {
          this.emitDispatchBlocked(goalId);
          updateRuntimeState(this.deps.projectRoot, buildDispatchPausedRuntimeStatePatch());
          return;
        }
        let plannerResult: PlannerResult;
        try {
          plannerResult = await new PlannerPhaseRunner({
            agentRuntime: this.deps.agentRuntime,
            skillsEngine: this.deps.skillsEngine(),
            maxDepth: this.deps.cards.maxDepth,
            readGoalCard: (cardId) => this.deps.cards.read(cardId),
            buildGoalEvidenceContext: (cardId) => buildGoalEvidenceContext({ goalId: cardId, cards: this.deps.cards }),
            buildGoalContextBlock: (cardId, resumeReason) => this.deps.goalContext.buildGoalContextBlock(cardId, resumeReason),
            inferResumeReason: (cardId, fallback) => this.deps.goalContext.inferResumeReason(cardId, fallback),
            consumeResumeHandoffContext: () => this.deps.consumeResumeHandoffContext(),
            injectSyntheticPlannerNotes: (cardId) => {
              this.deps.goalContext.injectQueuedPlannerNotes(`planner:${cardId}`);
            },
          }).run({ goalId, iteration: iter });
        } catch (err) {
          const failure = await this.handlePlannerFailure(goalId, err);
          if (failure.kind === 'handled') return;
          throw failure.error;
        }
        await new PlannerResultApplier({
          cardStore: this.deps.cards,
          transitionCard: (cardId, action, input) => this.deps.stateMachine.transitionCard(cardId, action, input),
        }).apply(goalId, plannerResult);
        updateRuntimeState(this.deps.projectRoot, buildCurrentAgentSessionPatch(`planner:${goalId}`));
        const execution = await this.deps.pendingActivations.dispatch(goalId);
        if (execution.failed) plannerDone = false;
        if (this.deps.isShuttingDown()) break;
        if (this.deps.isPaused()) {
          this.emitDispatchBlocked(goalId);
          return;
        }
        const postDispatchSummary = summarizePlannerPostDispatch({ plannerResult, childCards: this.deps.cards.list(), goalId });
        const postDispatchDecision = decidePlannerPostDispatch({
          plannerResult,
          currentCard: this.deps.cards.read(goalId),
          createdCardIds: postDispatchSummary.createdCardIds,
          updatedCardIds: postDispatchSummary.updatedCardIds,
          hasGoalDispatch: execution.dispatchedGoal,
          hasUnfinishedChildWork: postDispatchSummary.hasUnfinishedChildWork,
          executedTerminal: execution.executedTerminal,
          isProjectCard: goalId === PROJECT_CARD_ID,
        });
        const postDispatch = await handlePlannerPostDispatchDecision({
          goalId,
          decision: postDispatchDecision,
          effects: {
            blockGoalWithPlanning: (input) => this.blockGoalWithPlanning(input),
            updateGoalCard: (cardId, patch) => this.deps.cards.update(cardId, patch),
            transitionGoalExit: (cardId, reason) => this.deps.stateMachine.transition('goal_exit', { goalId: cardId, reason }),
          },
        });
        plannerDone = postDispatch.plannerDone;
        if (postDispatch.shouldReturn) return;
        if (plannerDone) {
          const completed = await this.runReviewer(goalId);
          if (completed) return;
          plannerDone = false;
        }
      }
      if (this.deps.isShuttingDown()) {
        this.deps.emit('dispatch_interrupted', { goal_id: goalId, reason: 'shutdown' });
        this.deps.eventLogger.appendEvent({
          kind: 'dispatch_interrupted',
          goal_id: goalId,
          reason: 'shutdown',
        });
      }
    } finally {
      this.deps.dispatchInFlight.delete(goalId);
    }
  }

  private async activatePlanner(goalId: string): Promise<CardRecord> {
    consumeChangedCardActivation(this.deps.projectRoot, goalId);
    const goalCard = this.deps.cards.read(goalId);
    if (!goalCard) throw new Error(`Goal '${goalId}' not found.`);
    if (goalCard.type !== 'project' && goalCard.type !== 'goal')
      throw new Error(`dispatchGoal requires a project or goal card, got type '${goalCard.type}'.`);
    const currentStatus = goalCard.status;
    const activationTransition = decideGoalActivationTransition(currentStatus);
    if (activationTransition.kind === 'invalid_status') {
      throw new Error(`Goal '${goalId}' is in status '${currentStatus}' which is neither startable nor restartable.`);
    }
    if (activationTransition.kind === 'transition') {
      const transitioned = await this.deps.stateMachine.transitionCard(goalId, activationTransition.action, { goalId });
      if (!transitioned)
        throw new Error(`Goal '${goalId}' could not be transitioned via ${activationTransition.action} from status '${currentStatus}'.`);
    }
    const refreshed = this.deps.cards.read(goalId);
    if (!refreshed) throw new Error(`Goal '${goalId}' disappeared during activation.`);
    const setup = planPlannerActivationSetup({ goalId, initialStatus: currentStatus, refreshedCard: refreshed });
    const compactedPersistedPlannerHistory =
      setup.shouldCompactPersistedPlannerHistory
        ? compactPersistedPlannerHistoryForRetry({
            projectRoot: this.deps.projectRoot,
            plannerSessionId: setup.plannerSessionId,
            sessionStamper: this.deps.sessionStamper,
            eventLogger: this.deps.eventLogger,
          })
        : false;
    if (setup.shouldUpdatePlanning) {
      await this.deps.cards.update(
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
    const planCard = this.deps.cards.read(goalId)!;
    updateRuntimeState(
      this.deps.projectRoot,
      buildPlannerActiveRunPatch({ goal: planCard, plannerSessionId: setup.plannerSessionId, at: this.deps.now() }),
    );
    this.deps.runLedger.bindPlannerSessionToOpenRun(goalId, setup.plannerSessionId);
    return planCard;
  }

  private async handlePlannerFailure(goalId: string, err: unknown) {
    const failedRun = selectPlannerInvocationFailureRun({ state: readRuntimeState(this.deps.projectRoot), goalId });
    const tokenBudgetFailure = isTokenBudgetFailure(err);
    const failureKind: PlannerInvocationFailureKind = tokenBudgetFailure
      ? 'token_budget'
      : isPlannerTerminalToolExhaustion(err)
        ? 'terminal_tool'
        : 'generic';
    return handlePlannerInvocationFailure({
      goalId,
      error: err,
      failureKind,
      providerStatus: tokenBudgetFailure
        ? ((err as { failure?: { status?: number } }).failure?.status ?? null)
        : null,
      existingResult: this.deps.cards.read(goalId)?.result,
      failedRun,
      effects: {
        now: this.deps.now,
        emitRuntimeDiagnostic: (input) => this.deps.emitRuntimeDiagnostic(input),
        appendRuntimeDiagnostic: (input) => this.deps.eventLogger.appendEvent({ kind: 'runtime_diagnostic', ...input }),
        appendError: (input) => this.deps.errorLogger.appendError(input),
        transitionCard: (cardId, event, details) => this.deps.stateMachine.transitionCard(cardId, event, details),
        updateCard: (cardId, patch) => this.deps.cards.update(cardId, patch),
        updateRuntimeRun: (runId, updates) => updateRuntimeRun(this.deps.projectRoot, runId, updates),
        publishRuntimeRun: (run) => this.deps.publishRuntimeRun(run),
        transitionRuntime: (event, details) => this.deps.stateMachine.transition(event, details),
      },
    });
  }

  private async runReviewer(goalId: string): Promise<boolean> {
    const assessmentId = nextReviewerAssessmentId(goalId, this.deps.cards.read(goalId)?.result);
    const reviewerSessionId = makeReviewerSessionId(goalId, assessmentId);
    let reviewResult: ReviewerResult;
    try {
      reviewResult = await new ReviewerPhaseRunner({
        agentRuntime: this.deps.agentRuntime,
        skillsEngine: this.deps.skillsEngine(),
        readGoalCard: (cardId) => this.deps.cards.read(cardId),
        buildGoalContextBlock: (cardId) => this.deps.goalContext.buildGoalContextBlock(cardId),
        buildGoalEvidenceContext: (cardId) => buildGoalEvidenceContext({ goalId: cardId, cards: this.deps.cards }),
        markReviewerStarted: async ({ goalId: startedGoalId, reviewerSessionId: startedReviewerSessionId, goalCard }) => {
          await this.deps.stateMachine.transition('reviewer_started', {
            goalId: startedGoalId,
            reviewerSessionId: startedReviewerSessionId,
            activeCardRun: buildReviewerActiveRun({
              goalId: startedGoalId,
              reviewerSessionId: startedReviewerSessionId,
              goalCard,
              at: this.deps.now(),
            }),
          });
        },
      }).run({ goalId, assessmentId, reviewerSessionId });
      this.deps.emit('review_complete', { goal_id: goalId, assessment: reviewResult.assessment });
      this.deps.eventLogger.appendEvent({
        kind: 'review_complete',
        goal_id: goalId,
        assessment: reviewResult.assessment,
      });
    } catch (err) {
      await handleReviewerInvocationFailure({
        goalId,
        error: err,
        existingResult: this.deps.cards.read(goalId)?.result,
        effects: {
          emitRuntimeDiagnostic: (input) => this.deps.emitRuntimeDiagnostic(input),
          appendRuntimeDiagnostic: (input) => this.deps.eventLogger.appendEvent({ kind: 'runtime_diagnostic', ...input }),
          appendError: (input) => this.deps.errorLogger.appendError(input),
          transitionCard: (cardId, event, details) => this.deps.stateMachine.transitionCard(cardId, event, details),
          updateCard: (cardId, patch) => this.deps.cards.update(cardId, patch),
          finishOpenPlannerRun: (cardId, result) => this.deps.runLedger.finishOpenPlannerRun(cardId, result),
          transitionRuntime: (event, details) => this.deps.stateMachine.transition(event, details),
        },
      });
      return true;
    }
    const validation = validateReviewerAssessment({ goalId, assessment: reviewResult.assessment, readCard: (evidenceId) => this.deps.cards.read(evidenceId) });
    const reviewerDecision = decideReviewerPhase({ assessment: reviewResult.assessment, validation });
    const reviewerOutcome = await handleReviewerAssessmentDecision({
      goalId,
      projectCardId: PROJECT_CARD_ID,
      assessmentId,
      reviewerSessionId,
      reviewResult,
      decision: reviewerDecision,
      effects: {
        now: this.deps.now,
        readCard: (cardId) => this.deps.cards.read(cardId),
        transitionCard: (cardId, event, details) => this.deps.stateMachine.transitionCard(cardId, event, details),
        updateCard: (cardId, patch) => this.deps.cards.update(cardId, patch),
        persistReviewState: (cardId, assessment) => this.persistReviewState(cardId, assessment),
        emitReviewFailed: (cardId, assessment) => {
          this.deps.emit('review_failed', { goal_id: cardId, assessment });
          this.deps.eventLogger.appendEvent({ kind: 'review_failed', goal_id: cardId, assessment });
        },
        emitGoalCompleted: (cardId, assessment) => {
          this.deps.emit('goal_completed', { goal_id: cardId, assessment });
          this.deps.eventLogger.appendEvent({ kind: 'goal_completed', goal_id: cardId, assessment });
        },
        appendChildUnwindToolResult: (cardId, outcome, summary) => this.deps.activationUnwind.appendChildUnwindToolResult(cardId, outcome, summary),
        transitionRuntime: (event, details) => this.deps.stateMachine.transition(event, details),
        emitProjectRunCompleted: (cardId, assessment) => this.emitProjectRunCompleted(cardId, assessment),
      },
    });
    return reviewerOutcome.kind === 'completed';
  }

  private async persistReviewState(goalId: string, assessment: ReviewerResult['assessment']): Promise<void> {
    const goal = this.deps.cards.read(goalId);
    await this.deps.cards.update(goalId, {
      result: { ...(goal?.result ?? {}), review: assessment },
    });
  }

  private async blockGoalWithPlanning(input: {
    goalId: string;
    blockedReason: string;
    planning: Record<string, unknown>;
    terminalReason: string;
  }): Promise<void> {
    await this.deps.stateMachine.transitionCard(input.goalId, 'block', {
      blocked_reason: input.blockedReason,
    });
    await this.deps.cards.update(input.goalId, {
      status: 'blocked',
      error: input.blockedReason,
      status_text: input.blockedReason,
      result: {
        ...(this.deps.cards.read(input.goalId)?.result ?? {}),
        planning: input.planning,
      },
    });
    this.deps.runLedger.finishOpenPlannerRun(input.goalId, 'blocked');
    await this.deps.stateMachine.transition('card_terminated', {
      goalId: input.goalId,
      reason: input.terminalReason,
    });
  }

  private emitProjectRunCompleted(cardId: string, assessment: ReviewAssessment): void {
    const projectCard = this.deps.cards.read(cardId);
    if (!projectCard) return;
    const payload = buildProjectRunCompletedPayload(projectCard, assessment);
    this.deps.emit('project_run_completed', { ...payload });
    this.deps.eventLogger.appendEvent({ kind: 'project_run_completed', ...payload });
  }

  private emitDispatchBlocked(goalId: string): void {
    this.deps.emit('dispatch_blocked', { reason: 'paused', goal_id: goalId });
    this.deps.eventLogger.appendEvent({
      kind: 'dispatch_blocked',
      reason: 'paused',
      goal_id: goalId,
    });
  }
}
