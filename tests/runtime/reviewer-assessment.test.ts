import { describe, expect, it } from '@jest/globals';
import { buildReviewAssessment, nextReviewerAssessmentId, reviewerSessionId, validateReviewerAssessment } from '../../src/runtime/reviewer-assessment.js';
import type { CardRecord, ReviewAssessment } from '../../src/schemas/types.js';

function assessment(overrides: Partial<ReviewAssessment> = {}): Pick<ReviewAssessment, 'result' | 'summary' | 'achieved' | 'issues' | 'evidence_card_ids'> {
  return { result: 'pass', summary: 'ok', achieved: ['a'], issues: [], evidence_card_ids: ['goal-a'], ...overrides };
}

function card(overrides: Partial<CardRecord> = {}): CardRecord {
  return {
    id: 'goal-a',
    type: 'goal',
    parent: 'project',
    depth: 1,
    title: 'Goal A',
    description: '',
    status: 'done',
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'planner',
    depends_on: [],
    related: [],
    acceptance: '',
    retries: 0,
    lifecycle: { status: 'done', result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-01-01T00:00:00.000Z' },
    ...overrides,
  } as CardRecord;
}

describe('reviewer assessment helpers', () => {
  it('generates stable incrementing assessment and session ids', () => {
    expect(nextReviewerAssessmentId('goal/a', undefined)).toBe('assessment-goal-a-1');
    expect(nextReviewerAssessmentId('goal/a', { kind: 'done', summary: 'done' })).toBe('assessment-goal-a-1');
    expect(reviewerSessionId('goal/a', 'assessment-goal-a-4')).toBe('reviewer:goal/a:assessment-goal-a-4');
  });

  it('builds review assessments with deterministic timestamps and overrides', () => {
    expect(buildReviewAssessment({
      goalId: 'goal-a',
      assessmentId: 'assessment-goal-a-1',
      reviewerSessionId: 'reviewer:goal-a:assessment-goal-a-1',
      result: assessment(),
      nowIso: 't1',
      override: { result: 'needs_corrections', summary: 'forced' },
    })).toEqual(expect.objectContaining({ result: 'needs_corrections', summary: 'forced', at: 't1', created_at: 't1' }));
  });

  it('validates reviewer evidence cards', () => {
    const cards = new Map([['goal-a', card()], ['child-a', card({ id: 'child-a', status: 'done' })]]);
    const readCard = (id: string) => cards.get(id) ?? null;
    const descendants = new Set(['child-a', 'child-blocked', 'empty']);
    const isDescendantOf = (id: string) => descendants.has(id);
    const candidatePlannerResult = { kind: 'done' as const, summary: 'candidate done' };
    expect(validateReviewerAssessment({ goalId: 'goal-a', assessment: assessment({ evidence_card_ids: ['goal-a'] }), candidatePlannerResult, readCard, isDescendantOf }).reason).toContain('outside');
    expect(validateReviewerAssessment({ goalId: 'goal-a', assessment: assessment({ evidence_card_ids: ['child-a'] }), candidatePlannerResult, readCard, isDescendantOf })).toEqual({ valid: true });
    expect(validateReviewerAssessment({ goalId: 'goal-a', assessment: assessment({ evidence_card_ids: [] }), candidatePlannerResult, readCard, isDescendantOf }).valid).toBe(false);
    expect(validateReviewerAssessment({ goalId: 'goal-a', assessment: assessment({ evidence_card_ids: ['missing'] }), candidatePlannerResult, readCard, isDescendantOf }).reason).toContain('missing');
    cards.set('child-blocked', card({ id: 'child-blocked', status: 'blocked' }));
    expect(validateReviewerAssessment({ goalId: 'goal-a', assessment: assessment({ evidence_card_ids: ['child-blocked'] }), candidatePlannerResult, readCard, isDescendantOf }).reason).toContain('non-accepted');
    cards.set('empty', card({ id: 'empty', lifecycle: { status: 'done', result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-01-01T00:00:00.000Z' } }));
    expect(validateReviewerAssessment({ goalId: 'goal-a', assessment: assessment({ evidence_card_ids: ['empty'] }), candidatePlannerResult, readCard, isDescendantOf }).valid).toBe(true);
  });
});
