import { describe, expect, it } from '@jest/globals';
import { blockedPlanningReason, cardHasBlockedPlanning, getBlockedPlanning, isReviewerCapacityPlannerBlocker, shouldPreservePrecisePlanningBlocker } from '../../src/runtime/planning-blockers.js';
import type { CardRecord } from '../../src/schemas/types.js';

function card(result: CardRecord['result'] = null, overrides: Partial<CardRecord> = {}): CardRecord {
  return {
    id: 'goal-a',
    type: 'goal',
    parent: 'project',
    depth: 1,
    title: 'Goal A',
    description: '',
    status: 'blocked',
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'planner',
    depends_on: [],
    related: [],
    blocks: [],
    artifacts: [],
    attachments: [],
    acceptance: '',
    retries: 0,
    result,
    ...overrides,
  } as CardRecord;
}

describe('planning blocker helpers', () => {
  it('detects blocked planning records and fallback reasons', () => {
    const blocked = card({ planning: { status: 'blocked', blocked_reason: 'Need operator input' } });
    expect(cardHasBlockedPlanning(blocked)).toBe(true);
    expect(getBlockedPlanning(blocked)).toEqual({ status: 'blocked', blocked_reason: 'Need operator input' });
    expect(blockedPlanningReason(blocked, getBlockedPlanning(blocked)!)).toBe('Need operator input');
    expect(blockedPlanningReason(card({ planning: { status: 'blocked' } }, { error: 'Card error' }), { status: 'blocked' })).toBe('Card error');
    expect(cardHasBlockedPlanning(card({ planning: { status: 'continue' } }))).toBe(false);
  });

  it('preserves precise reviewer-capacity blockers only for generic planner blocks', () => {
    const blocked = card({ planning: { status: 'blocked', resume_reason: 'reviewer_unavailable', failure_kind: 'reviewer_invocation_failed' } });
    expect(shouldPreservePrecisePlanningBlocker(blocked, 'planner_blocked')).toBe(true);
    expect(shouldPreservePrecisePlanningBlocker(blocked, 'planner_context_length_exceeded')).toBe(false);
    expect(shouldPreservePrecisePlanningBlocker(card({ planning: { status: 'blocked', resume_reason: 'other' } }), 'planner_blocked')).toBe(false);
  });

  it('classifies reviewer-capacity planner blocker text', () => {
    expect(isReviewerCapacityPlannerBlocker('report_goal_done failed because reviewer/provider capacity is unavailable')).toBe(true);
    expect(isReviewerCapacityPlannerBlocker('report_goal_done failed for unrelated contract error')).toBe(false);
    expect(isReviewerCapacityPlannerBlocker(null)).toBe(false);
  });
});
