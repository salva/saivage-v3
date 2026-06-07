import { describe, expect, it } from '@jest/globals';
import { blockedPlanningReason, cardHasBlockedPlanning, getBlockedPlanning, shouldPreservePrecisePlanningBlocker } from '../../src/runtime/planning-blockers.js';
import { buildPlannerInvocationFailureBlocker } from '../../src/runtime/phases/planner-phase.js';
import type { CardRecord, PlannerBlockedResult } from '../../src/schemas/index.js';

function planning(overrides: Partial<PlannerBlockedResult> = {}): PlannerBlockedResult {
  return { kind: 'planner_blocked', blocked_reason: 'Need operator input', resume_reason: 'planner_blocked', ...overrides };
}

function card(result: CardRecord['lifecycle']['result'] = null, overrides: Partial<CardRecord> = {}): CardRecord {
  const status = overrides.status ?? 'blocked';
  const error = overrides.lifecycle?.error ?? (status === 'blocked' ? 'Card error' : null);
  return {
    id: 'goal-a',
    type: 'goal',
    parent: 'project',
    depth: 1,
    title: 'Goal A',
    description: '',
    status,
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'planner',
    depends_on: [],
    related: [],
    artifacts: [],
    attachments: [],
    acceptance: '',
    retries: 0,
    lifecycle: overrides.lifecycle ?? ({ status, result, error, completed_at: null } as CardRecord['lifecycle']),
    ...overrides,
  } as CardRecord;
}

describe('planning blocker helpers', () => {
  it('detects blocked planning records and fallback reasons', () => {
    const blocked = card(planning());
    expect(cardHasBlockedPlanning(blocked)).toBe(true);
    expect(getBlockedPlanning(blocked)).toEqual(planning());
    expect(blockedPlanningReason(blocked, getBlockedPlanning(blocked)!)).toBe('Need operator input');
    expect(blockedPlanningReason(card(planning({ blocked_reason: '' }), { lifecycle: { status: 'blocked', result: planning({ blocked_reason: '' }), error: 'Card error', completed_at: null } }), planning({ blocked_reason: '' }))).toBe('Card error');
    expect(cardHasBlockedPlanning(card(null))).toBe(false);
  });

  it('preserves precise reviewer-capacity blockers by creation-time cause only for generic planner blocks', () => {
    const blocked = card(planning({ resume_reason: 'reviewer_unavailable', blocker_cause: 'reviewer_unavailable' }));
    expect(shouldPreservePrecisePlanningBlocker(blocked, 'planner_blocked')).toBe(true);
    expect(shouldPreservePrecisePlanningBlocker(blocked, 'planner_context_length_exceeded')).toBe(false);
    expect(shouldPreservePrecisePlanningBlocker(card(planning({ resume_reason: 'reviewer_unavailable' })), 'planner_blocked')).toBe(false);
  });

  it('sets token-budget blocker cause at planner invocation failure creation time', () => {
    expect(buildPlannerInvocationFailureBlocker({ providerStatus: null }).planning.blocker_cause).toBe('token_budget_exceeded');
  });
});
