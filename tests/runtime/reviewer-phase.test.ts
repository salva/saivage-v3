import { describe, expect, it } from '@jest/globals';
import { buildReviewerActiveRun, buildReviewerInvocationFailurePatch, buildReviewerPassCompletionPatch, decideReviewerPhase } from '../../src/runtime/phases/reviewer-phase.js';
import type { ReviewerResult } from '../../src/contracts/index.js';

function assessment(result: ReviewerResult['assessment']['result']): ReviewerResult['assessment'] {
  return { result, summary: 'summary', achieved: [], issues: [], evidence_card_ids: ['goal-a'] };
}

describe('reviewer phase decisions', () => {
  it('classifies invalid pass, pass, and correction results', () => {
    expect(decideReviewerPhase({ assessment: assessment('pass'), validation: { valid: false, reason: 'missing evidence' } })).toEqual({ kind: 'invalid_pass', reason: 'missing evidence' });
    expect(decideReviewerPhase({ assessment: assessment('pass'), validation: { valid: true } })).toEqual({ kind: 'pass' });
    expect(decideReviewerPhase({ assessment: assessment('needs_corrections'), validation: { valid: true } })).toEqual({ kind: 'needs_corrections' });
  });

  it('builds reviewer invocation failure card patch', () => {
    expect(buildReviewerInvocationFailurePatch({
      existingResult: { previous: true },
      blockedReason: 'reviewer failed',
    })).toEqual({
      status: 'blocked',
      error: 'reviewer failed',
      status_text: 'reviewer failed',
      result: {
        previous: true,
        planning: {
          status: 'blocked',
          blocked_reason: 'reviewer failed',
          resume_reason: 'reviewer_unavailable',
          failure_kind: 'reviewer_invocation_failed',
          created_cards: [],
          updated_cards: [],
        },
      },
    });
  });

  it('builds reviewer pass completion card patch', () => {
    expect(buildReviewerPassCompletionPatch({
      existingResult: { previous: true },
      existingCompletedAt: null,
      completedAt: '2026-01-01T00:00:00.000Z',
      reviewSummary: 'passed',
    })).toEqual({
      completed_at: '2026-01-01T00:00:00.000Z',
      result: {
        previous: true,
        planning: {
          status: 'done',
          created_cards: [],
          review_summary: 'passed',
        },
      },
    });
  });

  it('preserves existing reviewer completion timestamp', () => {
    expect(buildReviewerPassCompletionPatch({
      existingResult: null,
      existingCompletedAt: 'already-complete',
      completedAt: 'new-complete',
      reviewSummary: 'passed',
    }).completed_at).toBe('already-complete');
  });

  it('builds reviewer active-run state', () => {
    expect(buildReviewerActiveRun({
      goalId: 'goal-a',
      reviewerSessionId: 'reviewer:goal-a:assessment-1',
      goalCard: { type: 'goal' } as any,
      at: 'now',
    })).toEqual(expect.objectContaining({
      card_id: 'goal-a',
      card_type: 'goal',
      phase: 'reviewer',
      planner_session_id: 'planner:goal-a',
      reviewer_session_id: 'reviewer:goal-a:assessment-1',
      started_at: 'now',
      last_turn_at: 'now',
    }));
  });
});
