import { describe, expect, it, jest } from '@jest/globals';
import { deliverChildGoalActivationHandoff } from '../../src/runtime/pending-activation-dispatcher.js';

describe('deliverChildGoalActivationHandoff', () => {
  it('dispatches the child goal and appends a successful parent result', async () => {
    const dispatchGoalFn = jest.fn(async (_goalId: string) => undefined);
    const appendChildUnwindToolResult = jest.fn();

    const result = await deliverChildGoalActivationHandoff({
      childCardId: 'goal-child',
      effects: {
        dispatchGoal: dispatchGoalFn,
        readCard: () => ({ status: 'done' }),
        appendChildUnwindToolResult,
      },
    });

    expect(dispatchGoalFn).toHaveBeenCalledWith('goal-child');
    expect(appendChildUnwindToolResult).toHaveBeenCalledWith(
      'goal-child',
      'done',
      'Child goal goal-child finished with status done.',
    );
    expect(result).toEqual({ outcome: 'done', completedSuccessfully: true });
  });

  it('maps missing or non-done child goal status to unsuccessful completion', async () => {
    const appendChildUnwindToolResult = jest.fn();

    const result = await deliverChildGoalActivationHandoff({
      childCardId: 'goal-child',
      effects: {
        dispatchGoal: async () => undefined,
        readCard: () => null,
        appendChildUnwindToolResult,
      },
    });

    expect(appendChildUnwindToolResult).toHaveBeenCalledWith(
      'goal-child',
      'failed',
      'Child goal goal-child finished with status unknown.',
    );
    expect(result).toEqual({ outcome: 'failed', completedSuccessfully: false });
  });
});
