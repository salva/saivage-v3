import { describe, expect, it } from '@jest/globals';
import { buildReviewerActiveRun, decideReviewerPhase } from '../../src/runtime/phases/reviewer-phase.js';
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

  it('builds reviewer active-run state', () => {
    expect(buildReviewerActiveRun({
      goalId: 'goal-a',
      ownership: { kind: 'direct', source: 'project_root' },
      reviewerSessionId: 'reviewer:goal-a:assessment-1',
      assessmentId: 'assessment-1',
      goalCard: { type: 'goal' } as any,
      activeRun: {
        card_id: 'goal-a',
        card_type: 'goal',
        ownership: { kind: 'direct', source: 'project_root' },
        runtime_status: 'running',
        phase: 'planner',
        caller_session_id: null,
        caller_tool_call_id: null,
        planner_session_id: 'planner:goal-a',
        correction_attempts: 0,
        started_at: 'before',
        last_turn_at: 'before',
      },
      at: 'now',
    })).toEqual(expect.objectContaining({
      card_id: 'goal-a',
      card_type: 'goal',
      phase: 'reviewer',
      planner_session_id: 'planner:goal-a',
      reviewer_session_id: 'reviewer:goal-a:assessment-1',
      started_at: 'before',
      last_turn_at: 'before',
    }));
  });
});
