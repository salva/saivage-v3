import { describe, expect, it } from '@jest/globals';
import { handleReviewerAssessmentDecision, type ReviewerAssessmentEffects } from '../../src/runtime/phases/reviewer-assessment-handler.js';
import type { CardRecord, ReviewAssessment } from '../../src/schemas/types.js';
import type { ReviewerResult } from '../../src/contracts/index.js';

const now = '2026-01-01T00:00:00.000Z';

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
    const patches: Partial<CardRecord>[] = [];
    const outcome = await handleReviewerAssessmentDecision({
      goalId: 'goal-a',
      projectCardId: 'goal-a',
      assessmentId: 'assessment-goal-a-1',
      reviewerSessionId: 'reviewer:goal-a:assessment-goal-a-1',
      reviewResult: reviewResult('pass'),
      decision: { kind: 'pass' },
      effects: testEffects({
        readCard: () => ({ id: 'goal-a', status: 'active', result: { kind: 'planner_done', created_cards: [], updated_cards: [], summary: 'review summary' }, completed_at: null, error: 'stale error' } as unknown as CardRecord),
        transitionCard: async (cardId, event, details) => { calls.push(`${event}:${cardId}:${'assessment' in details}`); },
        updateCard: async (_cardId, patch) => { patches.push(patch); calls.push(`update:${patch.completed_at}`); },
        appendChildUnwindToolResult: (cardId, outcomeKind) => { calls.push(`unwind:${cardId}:${outcomeKind}`); },
        transitionRuntime: async (event, details) => { calls.push(`${event}:${details.reason}`); },
        emitGoalCompleted: (cardId) => { calls.push(`completed:${cardId}`); },
        emitProjectRunCompleted: (cardId) => { calls.push(`project:${cardId}`); },
      }),
    });

    expect(outcome).toEqual({ kind: 'completed' });
    expect(calls).toEqual([
      'complete:goal-a:true',
      `update:${now}`,
      'unwind:goal-a:done',
      'reviewer_finished:review_pass',
      'completed:goal-a',
      'project:goal-a',
    ]);
    expect(patches[0]).toMatchObject({
      status: 'done',
      completed_at: now,
      error: null,
      result: {
        kind: 'reviewer_pass',
        planning: { kind: 'planner_done', created_cards: [], updated_cards: [], summary: 'review summary' },
        review_summary: 'review summary',
        assessment_id: 'assessment-goal-a-1',
      },
    });
  });

  it('persists correction assessment without committing correction as lifecycle result', async () => {
    const persisted: ReviewAssessment[] = [];
    const patches: Partial<CardRecord>[] = [];
    const outcome = await handleReviewerAssessmentDecision({
      goalId: 'goal-a',
      projectCardId: 'project',
      assessmentId: 'assessment-goal-a-1',
      reviewerSessionId: 'reviewer:goal-a:assessment-goal-a-1',
      reviewResult: reviewResult('needs_corrections'),
      decision: { kind: 'needs_corrections' },
      effects: testEffects({
        persistReviewState: async (_goalId, assessment) => { persisted.push(assessment); },
        updateCard: async (_cardId, patch) => { patches.push(patch); },
      }),
    });

    expect(outcome).toEqual({ kind: 'continue_planner' });
    expect(persisted).toEqual([expect.objectContaining({ result: 'needs_corrections', summary: 'review summary' })]);
    expect(patches).toEqual([]);
  });
});

function testEffects(overrides: Partial<ReviewerAssessmentEffects> = {}): ReviewerAssessmentEffects {
  return {
    now: () => now,
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
