import { describe, expect, it } from '@jest/globals';
import { handleReviewerInvocationFailure, type ReviewerInvocationFailureEffects } from '../../src/runtime/phases/reviewer-invocation-failure.js';
import type { CardRecord } from '../../src/schemas/index.js';

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
      card: goalCard('goal-a'),
      error: new Error('reviewer offline'),
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

function goalCard(id: string): CardRecord {
  return {
    id,
    type: 'goal',
    parent: 'project',
    depth: 1,
    title: 'Goal A',
    description: 'Do goal work',
    status: 'running',
    depends_on: [],
    priority: 1,
    tags: [],
    urgency: 'normal',
    created_by: 'planner',
    blocks: [],
    related: [],
    acceptance: '',
    artifacts: [],
    attachments: [],
    retries: 0,
    lifecycle: { status: 'running', result: null, error: null, completed_at: null },
  } as unknown as CardRecord;
}
