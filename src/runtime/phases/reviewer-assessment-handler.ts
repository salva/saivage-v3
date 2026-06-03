import type { CardRecord, ReviewAssessment } from '../../schemas/index.js';
import type { ReviewerResult } from '../../contracts/index.js';
import { buildReviewAssessment } from '../reviewer-assessment.js';
import { buildReviewerPassCompletionPatch, type ReviewerPhaseDecision } from './reviewer-phase.js';

export interface ReviewerAssessmentEffects {
  now(): string;
  readCard(cardId: string): CardRecord | null;
  transitionCard(cardId: string, event: 'complete', details: Record<string, unknown>): Promise<unknown>;
  updateCard(cardId: string, patch: Partial<CardRecord>): Promise<unknown> | unknown;
  persistReviewState(goalId: string, assessment: ReviewAssessment): Promise<void> | void;
  emitReviewFailed(goalId: string, assessment: ReviewAssessment): void;
  emitGoalCompleted(goalId: string, assessment: ReviewAssessment): void;
  appendChildUnwindToolResult(goalId: string, outcome: 'done', summary: string): void;
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
    await input.effects.persistReviewState(input.goalId, invalidAssessment);
    input.effects.emitReviewFailed(input.goalId, invalidAssessment);
    return { kind: 'continue_planner' };
  }

  if (input.decision.kind === 'pass') {
    if (input.effects.readCard(input.goalId)?.status !== 'done') {
      await input.effects.transitionCard(input.goalId, 'complete', {
        assessment: input.reviewResult.assessment,
      });
    }
    const assessment = buildReviewAssessment({
      goalId: input.goalId,
      assessmentId: input.assessmentId,
      reviewerSessionId: input.reviewerSessionId,
      result: input.reviewResult.assessment,
      nowIso: input.effects.now(),
    });
    await input.effects.persistReviewState(input.goalId, assessment);
    const latestGoalCard = input.effects.readCard(input.goalId);
    await input.effects.updateCard(
      input.goalId,
      buildReviewerPassCompletionPatch({
        existingResult: latestGoalCard?.result,
        existingCompletedAt: latestGoalCard?.completed_at,
        completedAt: input.effects.now(),
        reviewSummary: input.reviewResult.assessment.summary,
      }),
    );
    input.effects.appendChildUnwindToolResult(input.goalId, 'done', input.reviewResult.assessment.summary);
    await input.effects.transitionRuntime('reviewer_finished', {
      goalId: input.goalId,
      reason: 'review_pass',
    });
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
  await input.effects.persistReviewState(input.goalId, failedAssessment);
  input.effects.emitReviewFailed(input.goalId, failedAssessment);
  return { kind: 'continue_planner' };
}
