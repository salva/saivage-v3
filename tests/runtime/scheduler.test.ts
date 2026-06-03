import { describe, expect, it, jest } from '@jest/globals';
import { ActivationScheduler } from '../../src/runtime/scheduler.js';

describe('ActivationScheduler', () => {
  it('dispatches directly when no goal dispatcher is configured', async () => {
    const dispatchGoal = jest.fn(async (goalId: string) => {
      void goalId;
    });

    await new ActivationScheduler(undefined, dispatchGoal).dispatch('goal-a');

    expect(dispatchGoal).toHaveBeenCalledWith('goal-a');
  });

  it('routes through a configured goal dispatcher with a continuation', async () => {
    const dispatchGoal = jest.fn(async (goalId: string) => {
      void goalId;
    });
    const goalDispatcher = jest.fn(async (goalId: string, next: (goalId: string) => Promise<void>) => {
      await next(`${goalId}:child`);
    });

    await new ActivationScheduler(goalDispatcher, dispatchGoal).dispatch('goal-a');

    expect(goalDispatcher).toHaveBeenCalledTimes(1);
    expect(goalDispatcher.mock.calls[0]?.[0]).toBe('goal-a');
    expect(dispatchGoal).toHaveBeenCalledWith('goal-a:child');
  });

  it('propagates dispatch promise rejection', async () => {
    const error = new Error('dispatch failed');
    const dispatchGoal = jest.fn(async () => {
      throw error;
    });

    await expect(new ActivationScheduler(undefined, dispatchGoal).dispatch('goal-a')).rejects.toBe(error);
  });
});
