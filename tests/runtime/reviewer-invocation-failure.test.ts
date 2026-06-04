import { describe, expect, it } from '@jest/globals';
import { handleReviewerInvocationFailure, type ReviewerInvocationFailureEffects } from '../../src/runtime/phases/reviewer-invocation-failure.js';

describe('reviewer invocation failure handler', () => {
  it('blocks the goal with reviewer-unavailable planning metadata', async () => {
    const calls: string[] = [];
    const effects = testEffects({
      transitionCard: async (cardId, event, details) => { calls.push(`${event}:${cardId}:${String(details.blocked_reason).slice(0, 35)}`); },
      updateCard: async (_cardId, patch) => {
        calls.push(`update:${patch.status}`);
        expect(patch.lifecycle?.result).toMatchObject({ kind: 'planner_blocked', resume_reason: 'reviewer_unavailable' });
      },
      finishOpenPlannerRun: (goalId, result) => { calls.push(`finish:${goalId}:${result}`); },
      transitionRuntime: async (event, details) => { calls.push(`${event}:${details.reason}`); },
    });

    await handleReviewerInvocationFailure({
      goalId: 'goal-a',
      error: new Error('reviewer offline'),
      existingLifecycle: { status: 'running', result: null, error: null, completed_at: null },
      effects,
    });

    expect(calls).toEqual([
      'block:goal-a:Reviewer invocation failed before a',
      'update:blocked',
      'finish:goal-a:blocked',
      'card_terminated:reviewer_invocation_failed',
    ]);
  });
});

function testEffects(overrides: Partial<ReviewerInvocationFailureEffects> = {}): ReviewerInvocationFailureEffects {
  return {
    emitRuntimeDiagnostic: () => undefined,
    appendRuntimeDiagnostic: () => undefined,
    appendError: () => undefined,
    transitionCard: async () => undefined,
    updateCard: async () => undefined,
    finishOpenPlannerRun: () => undefined,
    transitionRuntime: async () => undefined,
    ...overrides,
  };
}
