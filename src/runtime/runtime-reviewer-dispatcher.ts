import type { AgentExecutionPort, ReviewerResult } from '../contracts/index.js';
import type { CardRecord, PlannerDoneResult, ProjectRunCompletedPayload, ReviewAssessment, RuntimeDispatchOwnership } from '../schemas/index.js';
import type { RuntimeSkillsPort } from './runtime-config.js';
import type { RuntimeGoalContextCoordinator } from './runtime-goal-context.js';
import type { RuntimeRunLedger } from './runtime-run-ledger.js';
import type { ActivationUnwindRunner } from './activation-unwind.js';
import type { RuntimeServices } from './runtime-services.js';
import { buildGoalEvidenceContext } from './context-builder.js';
import { buildReviewerActiveRun, decideReviewerPhase } from './phases/reviewer-phase.js';
import { ReviewerPhaseRunner } from './phases/reviewer-phase-runner.js';
import { handleReviewerInvocationFailure } from './phases/reviewer-invocation-failure.js';
import { handleReviewerAssessmentDecision } from './phases/reviewer-assessment-handler.js';
import { peekSyntheticPlannerNotes } from './synthetic-planner-notes.js';
import {
  nextReviewerAssessmentId,
  reviewerSessionId as makeReviewerSessionId,
  validateReviewerAssessment,
} from './reviewer-assessment.js';
import { readRuntimeState } from './state.js';

export function buildProjectRunCompletedPayload(
  card: CardRecord,
  assessment?: ReviewAssessment,
): ProjectRunCompletedPayload {
  const outcome = card.status === 'blocked' ? 'blocked' : card.status === 'failed' ? 'failed' : 'done';
  const summary = assessment?.summary ?? card.status_text ?? card.lifecycle.error ?? `project ${outcome}`;
  if (outcome === 'blocked') {
    return {
      project_card_id: card.id,
      result: outcome,
      summary,
      blocked_reason: card.lifecycle.error ?? undefined,
    };
  }
  if (outcome === 'failed') {
    return {
      project_card_id: card.id,
      result: outcome,
      summary,
      failure_kind: card.lifecycle.error ?? undefined,
    };
  }
  return { project_card_id: card.id, result: outcome, summary };
}

export interface RuntimeReviewerDispatcherDeps extends Pick<RuntimeServices,
  | 'projectRoot'
  | 'cards'
  | 'eventLogger'
  | 'errorLogger'
  | 'stateMachine'
  | 'emit'
  | 'publishRuntimeDiagnostic'
  | 'now'
> {
  agentRuntime: AgentExecutionPort;
  skillsEngine(): RuntimeSkillsPort | null;
  goalContext: RuntimeGoalContextCoordinator;
  activationUnwind: ActivationUnwindRunner;
  runLedger: RuntimeRunLedger;
}

export class RuntimeReviewerDispatcher {
  constructor(private readonly deps: RuntimeReviewerDispatcherDeps) {}

  async runReviewer(goalId: string, planningContext?: PlannerDoneResult | null): Promise<boolean> {
    const assessmentId = nextReviewerAssessmentId(goalId, this.deps.cards.read(goalId)?.lifecycle.result);
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
          if (!goalCard) throw new Error(`Reviewer '${startedReviewerSessionId}' cannot start because goal card '${startedGoalId}' is missing.`);
          const activeRun = readRuntimeState(this.deps.projectRoot)?.active_card_run;
          if (!activeRun || activeRun.card_id !== startedGoalId) throw new Error(`Reviewer '${startedReviewerSessionId}' cannot start because active run ownership for '${startedGoalId}' is missing.`);
          await this.deps.stateMachine.transition('reviewer_started', {
            goalId: startedGoalId,
            reviewerSessionId: startedReviewerSessionId,
            activeCardRun: buildReviewerActiveRun({
              goalId: startedGoalId,
              ownership: activeRun.ownership,
              reviewerSessionId: startedReviewerSessionId,
              assessmentId,
              goalCard,
              activeRun,
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
      const failedGoalCard = this.deps.cards.read(goalId);
      if (!failedGoalCard) throw err;
      await handleReviewerInvocationFailure({
        goalId,
        card: failedGoalCard,
        error: err,
        effects: {
          publishRuntimeDiagnostic: (input) => this.deps.publishRuntimeDiagnostic(input),
          appendError: (input) => this.deps.errorLogger.appendError(input),
          transitionCard: (cardId, event, details) => this.deps.stateMachine.transitionCard(cardId, event, details),
          updateCard: (cardId, patch) => this.deps.cards.repairTerminalLifecycle(cardId, patch),
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
      ownership: readRequiredReviewerOwnership(this.deps.projectRoot, goalId),
      assessmentId,
      reviewerSessionId,
      reviewResult,
      decision: reviewerDecision,
      planningContext,
      effects: {
        projectRoot: this.deps.projectRoot,
        now: this.deps.now,
        readCard: (cardId) => this.deps.cards.read(cardId),
        transitionCard: (cardId, event, details) => this.deps.stateMachine.transitionCard(cardId, event, details),
        updateCard: (cardId, patch) => this.deps.cards.commitTerminalLifecyclePatch(cardId, patch),
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
        peekPlannerNotes: (plannerSessionId) => peekSyntheticPlannerNotes(this.deps.projectRoot, plannerSessionId),
      },
    });
    return reviewerOutcome.kind === 'completed';
  }

  private emitProjectRunCompleted(cardId: string, assessment: ReviewAssessment): void {
    const projectCard = this.deps.cards.read(cardId);
    if (!projectCard) return;
    const payload = buildProjectRunCompletedPayload(projectCard, assessment);
    this.deps.emit('project_run_completed', { ...payload });
    this.deps.eventLogger.appendEvent({ kind: 'project_run_completed', ...payload });
  }
}

function readRequiredReviewerOwnership(projectRoot: string, goalId: string): RuntimeDispatchOwnership {
  const activeRun = readRuntimeState(projectRoot)?.active_card_run;
  if (!activeRun || activeRun.card_id !== goalId) throw new Error(`Reviewer assessment for '${goalId}' has no active run ownership.`);
  return activeRun.ownership;
}
