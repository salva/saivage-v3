import { describe, expect, it, jest } from '@jest/globals';
import { ActivationScheduler } from '../../src/runtime/scheduler.js';

describe('ActivationScheduler', () => {
  it('dispatches directly when no goal dispatcher is configured', async () => {
    const dispatchGoalFn = jest.fn(async (goalId: string) => {
      void goalId;
    });

    await new ActivationScheduler(undefined, dispatchGoalFn).dispatch('goal-a');

    expect(dispatchGoalFn).toHaveBeenCalledWith('goal-a');
  });

  it('routes through a configured goal dispatcher with a continuation', async () => {
    const dispatchGoalFn = jest.fn(async (goalId: string) => {
      void goalId;
    });
    const goalDispatcher = jest.fn(async (goalId: string, next: (goalId: string) => Promise<void>) => {
      await next(`${goalId}:child`);
    });

    await new ActivationScheduler(goalDispatcher, dispatchGoalFn).dispatch('goal-a');

    expect(goalDispatcher).toHaveBeenCalledTimes(1);
    expect(goalDispatcher.mock.calls[0]?.[0]).toBe('goal-a');
    expect(dispatchGoalFn).toHaveBeenCalledWith('goal-a:child');
  });

  it('propagates dispatch promise rejection', async () => {
    const error = new Error('dispatch failed');
    const dispatchGoalFn = jest.fn(async () => {
      throw error;
    });

    await expect(new ActivationScheduler(undefined, dispatchGoalFn).dispatch('goal-a')).rejects.toBe(error);
  });
});
