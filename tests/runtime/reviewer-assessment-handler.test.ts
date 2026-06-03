import { describe, expect, it } from '@jest/globals';
import { handleReviewerAssessmentDecision, type ReviewerAssessmentEffects } from '../../src/runtime/phases/reviewer-assessment-handler.js';
import type { CardRecord, ReviewAssessment } from '../../src/schemas/types.js';
import type { ReviewerResult } from '../../src/contracts/index.js';

function reviewResult(result: ReviewerResult['assessment']['result']): ReviewerResult {
  return {
    assessment: {
      result,
      summary: 'review summary',
      achieved: [],
      issues: [],
      evidence_card_ids: ['goal-a'],
    },
  } as ReviewerResult;
}

describe('reviewer assessment handler', () => {
  it('turns invalid pass into needs-corrections and continues planner loop', async () => {
    const failed: ReviewAssessment[] = [];
    const outcome = await handleReviewerAssessmentDecision({
      goalId: 'goal-a',
      projectCardId: 'project',
      assessmentId: 'assessment-goal-a-1',
      reviewerSessionId: 'reviewer:goal-a:assessment-goal-a-1',
      reviewResult: reviewResult('pass'),
      decision: { kind: 'invalid_pass', reason: 'missing evidence' },
      effects: testEffects({ emitReviewFailed: (_goalId, assessment) => { failed.push(assessment); } }),
    });

    expect(outcome).toEqual({ kind: 'continue_planner' });
    expect(failed).toEqual([expect.objectContaining({ result: 'needs_corrections', summary: 'Reviewer pass rejected: missing evidence' })]);
  });

  it('persists pass completion and emits completion effects', async () => {
    const calls: string[] = [];
    const outcome = await handleReviewerAssessmentDecision({
      goalId: 'goal-a',
      projectCardId: 'goal-a',
      assessmentId: 'assessment-goal-a-1',
      reviewerSessionId: 'reviewer:goal-a:assessment-goal-a-1',
      reviewResult: reviewResult('pass'),
      decision: { kind: 'pass' },
      effects: testEffects({
        readCard: () => ({ id: 'goal-a', status: 'active', result: { previous: true }, completed_at: null } as unknown as CardRecord),
        transitionCard: async (cardId, event) => { calls.push(`${event}:${cardId}`); },
        updateCard: async (_cardId, patch) => { calls.push(`update:${patch.completed_at}`); expect(patch.result).toMatchObject({ previous: true, planning: { status: 'done', review_summary: 'review summary' } }); },
        appendChildUnwindToolResult: (cardId, outcomeKind) => { calls.push(`unwind:${cardId}:${outcomeKind}`); },
        transitionRuntime: async (event, details) => { calls.push(`${event}:${details.reason}`); },
        emitGoalCompleted: (cardId) => { calls.push(`completed:${cardId}`); },
        emitProjectRunCompleted: (cardId) => { calls.push(`project:${cardId}`); },
      }),
    });

    expect(outcome).toEqual({ kind: 'completed' });
    expect(calls).toEqual([
      'complete:goal-a',
      'update:now',
      'unwind:goal-a:done',
      'reviewer_finished:review_pass',
      'completed:goal-a',
      'project:goal-a',
    ]);
  });
});

function testEffects(overrides: Partial<ReviewerAssessmentEffects> = {}): ReviewerAssessmentEffects {
  return {
    now: () => 'now',
    readCard: () => null,
    transitionCard: async () => undefined,
    updateCard: async () => undefined,
    persistReviewState: async () => undefined,
    emitReviewFailed: () => undefined,
    emitGoalCompleted: () => undefined,
    appendChildUnwindToolResult: () => undefined,
    transitionRuntime: async () => undefined,
    emitProjectRunCompleted: () => undefined,
    ...overrides,
  };
}
