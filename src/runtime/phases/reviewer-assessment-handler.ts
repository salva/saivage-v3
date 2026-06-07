import type { CardRecord, PlannerBlockedResult, PlannerDoneResult, ReviewAssessment } from '../../schemas/index.js';
import type { ReviewerResult } from '../../contracts/index.js';
import { commitReviewerPass } from '../terminal-commit/index.js';
import { buildReviewAssessment } from '../reviewer-assessment.js';
import { RuntimeActivationInvariantError } from '../state.js';
import type { ReviewerPhaseDecision } from './reviewer-phase.js';

export interface ReviewerAssessmentEffects {
  now(): string;
  readCard(cardId: string): CardRecord | null;
  transitionCard(cardId: string, event: 'complete', details: Record<string, unknown>): Promise<unknown>;
  updateCard(cardId: string, patch: Partial<CardRecord>): Promise<unknown> | unknown;
  emitReviewFailed(goalId: string, assessment: ReviewAssessment): void;
  emitGoalCompleted(goalId: string, assessment: ReviewAssessment): void;
  appendChildUnwindToolResult(goalId: string, outcome: 'done', summary: string): boolean;
  transitionRuntime(event: 'reviewer_finished', details: Record<string, unknown>): Promise<unknown>;
  emitProjectRunCompleted(goalId: string, assessment: ReviewAssessment): void;
}

export async function handleReviewerAssessmentDecision(input: {
  goalId: string;
  projectCardId: string;
  assessmentId: string;
  reviewerSessionId: string;
  reviewResult: ReviewerResult;
  decision: ReviewerPhaseDecision;
  planningContext?: PlannerDoneResult | PlannerBlockedResult | null;
  effects: ReviewerAssessmentEffects;
}): Promise<{ kind: 'continue_planner' } | { kind: 'completed' }> {
  if (input.decision.kind === 'invalid_pass') {
    const invalidAssessment = buildReviewAssessment({
      goalId: input.goalId,
      assessmentId: input.assessmentId,
      reviewerSessionId: input.reviewerSessionId,
      result: input.reviewResult.assessment,
      nowIso: input.effects.now(),
      override: {
        result: 'needs_corrections',
        summary: `Reviewer pass rejected: ${input.decision.reason}`,
        achieved: [],
        issues: [
          {
            summary: input.decision.reason,
            severity: 'blocker' as const,
          },
        ],
      },
    });
    input.effects.emitReviewFailed(input.goalId, invalidAssessment);
    return { kind: 'continue_planner' };
  }

  if (input.decision.kind === 'pass') {
    const assessment = buildReviewAssessment({
      goalId: input.goalId,
      assessmentId: input.assessmentId,
      reviewerSessionId: input.reviewerSessionId,
      result: input.reviewResult.assessment,
      nowIso: input.effects.now(),
    });
    const latestGoalCard = input.effects.readCard(input.goalId);
    if (!latestGoalCard) {
      throw new RuntimeActivationInvariantError(
        `Runtime activation invariant violation: reviewer pass for '${input.goalId}' cannot commit because the goal card cannot be read.`,
      );
    }
    await commitReviewerPass({
      card: latestGoalCard,
      planning: typedPlannerContext(latestGoalCard) ?? input.planningContext,
      reviewSummary: input.reviewResult.assessment.summary,
      assessmentId: input.assessmentId,
      completedAt: latestGoalCard.lifecycle.completed_at ?? input.effects.now(),
      transitionDetails: { assessment: input.reviewResult.assessment },
      effects: input.effects,
    });
    if (input.goalId === input.projectCardId) {
      await input.effects.transitionRuntime('reviewer_finished', {
        goalId: input.goalId,
        reason: 'review_pass',
      });
    } else {
      const unwoundToParent = input.effects.appendChildUnwindToolResult(input.goalId, 'done', input.reviewResult.assessment.summary);
      if (!unwoundToParent) {
        await input.effects.transitionRuntime('reviewer_finished', {
          goalId: input.goalId,
          reason: 'review_pass',
        });
      }
    }
    input.effects.emitGoalCompleted(input.goalId, assessment);
    if (input.goalId === input.projectCardId) input.effects.emitProjectRunCompleted(input.goalId, assessment);
    return { kind: 'completed' };
  }

  const failedAssessment = buildReviewAssessment({
    goalId: input.goalId,
    assessmentId: input.assessmentId,
    reviewerSessionId: input.reviewerSessionId,
    result: input.reviewResult.assessment,
    nowIso: input.effects.now(),
  });
  input.effects.emitReviewFailed(input.goalId, failedAssessment);
  return { kind: 'continue_planner' };
}

function typedPlannerContext(card: CardRecord): PlannerDoneResult | PlannerBlockedResult | null {
  const lifecycleResult = card.lifecycle.result;
  if (lifecycleResult?.kind === 'planner_done' || lifecycleResult?.kind === 'planner_blocked') return lifecycleResult;
  if (lifecycleResult?.kind === 'reviewer_pass') return lifecycleResult.planning;
  return null;
}
