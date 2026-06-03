import { describe, expect, it } from '@jest/globals';
import { handlePlannerPostDispatchDecision, type PlannerPostDispatchEffects } from '../../src/runtime/phases/planner-post-dispatch-handler.js';

describe('planner post-dispatch handler', () => {
  it('applies block decisions through the block effect', async () => {
    const calls: string[] = [];
    const result = await handlePlannerPostDispatchDecision({
      goalId: 'goal-a',
      decision: { kind: 'block', blockedReason: 'blocked', planning: { status: 'blocked' }, terminalReason: 'planner_blocked' },
      effects: testEffects({ blockGoalWithPlanning: async (input) => { calls.push(`${input.goalId}:${input.terminalReason}`); } }),
    });
    expect(result).toEqual({ plannerDone: false, shouldReturn: true });
    expect(calls).toEqual(['goal-a:planner_blocked']);
  });

  it('updates card and exits when planner is done with unfinished child work', async () => {
    const calls: string[] = [];
    const result = await handlePlannerPostDispatchDecision({
      goalId: 'goal-a',
      decision: { kind: 'exit_with_unfinished_child_work', patch: { error: null }, terminalReason: 'planner_done_with_unfinished_child_work' },
      effects: testEffects({
        updateGoalCard: async (cardId) => { calls.push(`update:${cardId}`); },
        transitionGoalExit: async (cardId, reason) => { calls.push(`exit:${cardId}:${reason}`); },
      }),
    });
    expect(result).toEqual({ plannerDone: false, shouldReturn: true });
    expect(calls).toEqual(['update:goal-a', 'exit:goal-a:planner_done_with_unfinished_child_work']);
  });

  it('continues or marks ready for review', async () => {
    const calls: string[] = [];
    await expect(handlePlannerPostDispatchDecision({
      goalId: 'goal-a',
      decision: { kind: 'continue', patch: { error: null } },
      effects: testEffects({ updateGoalCard: async (cardId) => { calls.push(`update:${cardId}`); } }),
    })).resolves.toEqual({ plannerDone: false, shouldReturn: false });
    await expect(handlePlannerPostDispatchDecision({
      goalId: 'goal-a',
      decision: { kind: 'ready_for_review' },
      effects: testEffects(),
    })).resolves.toEqual({ plannerDone: true, shouldReturn: false });
    expect(calls).toEqual(['update:goal-a']);
  });
});

function testEffects(overrides: Partial<PlannerPostDispatchEffects> = {}): PlannerPostDispatchEffects {
  return {
    blockGoalWithPlanning: async () => undefined,
    updateGoalCard: async () => undefined,
    transitionGoalExit: async () => undefined,
    ...overrides,
  };
}
