import { describe, expect, it } from '@jest/globals';
import { inferGoalResumeReason } from '../../src/runtime/goal-context.js';

describe('goal context helpers', () => {
  it('prefers service restart when the active planner run is being resumed after restart', () => {
    expect(inferGoalResumeReason({
      goalId: 'goal-a',
      fallback: 'service_restart',
      activeRun: { card_id: 'goal-a', card_type: 'goal', ownership: { kind: 'direct', source: 'project_root' },
  runtime_status: 'running', phase: 'planner', caller_session_id: null, caller_tool_call_id: null, planner_session_id: 'planner:goal-a', correction_attempts: 0, started_at: 't0', last_turn_at: 't0' },
      notes: [],
    })).toBe('service_restart');
  });

  it('maps synthetic note kinds to resume reasons by priority', () => {
    expect(inferGoalResumeReason({ goalId: 'goal-a', activeRun: null, notes: [{ kind: 'reviewer_interrupted' }, { kind: 'subtree_changed' }] })).toBe('service_restart');
    expect(inferGoalResumeReason({ goalId: 'goal-a', activeRun: null, notes: [{ kind: 'pending_subtree_correction' }] })).toBe('analyst_directive');
    expect(inferGoalResumeReason({ goalId: 'goal-a', activeRun: null, notes: [{ kind: 'subtree_changed' }] })).toBe('subtree_changed');
    expect(inferGoalResumeReason({ goalId: 'goal-a', fallback: 'reviewer_correction', activeRun: null, notes: [] })).toBe('reviewer_correction');
  });
});
