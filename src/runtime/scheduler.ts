import type { RuntimeConfig } from './runtime-config.js';

export class ActivationScheduler {
  constructor(
    private readonly goalDispatcher: RuntimeConfig['goalDispatcher'],
    private readonly dispatchGoal: (goalId: string) => Promise<void>,
  ) {}

  dispatch(goalId: string): Promise<void> {
    return this.goalDispatcher
      ? this.goalDispatcher(goalId, (nextGoalId: string) => this.dispatchGoal(nextGoalId))
      : this.dispatchGoal(goalId);
  }
}
