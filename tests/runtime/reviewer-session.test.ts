import { describe, expect, it } from '@jest/globals';
import { nextReviewerAssessmentId, reviewerSessionId } from '../../src/runtime/reviewer-session.js';

describe('reviewer session helpers', () => {
  it('generates stable assessment and session ids', () => {
    expect(nextReviewerAssessmentId('goal/a', undefined)).toBe('assessment-goal-a-1');
    expect(nextReviewerAssessmentId('goal/a', { kind: 'done', summary: 'done' })).toBe('assessment-goal-a-1');
    expect(reviewerSessionId('goal/a', 'assessment-goal-a-4')).toBe('reviewer:goal/a:assessment-goal-a-4');
  });
});
