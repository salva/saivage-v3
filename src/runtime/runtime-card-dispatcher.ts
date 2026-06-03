import type { RuntimePlannerDispatcher } from './runtime-planner-dispatcher.js';

export class RuntimeCardDispatcher {
  constructor(
    private readonly deps: {
      plannerDispatcher: RuntimePlannerDispatcher;
      dispatchInFlight: Set<string>;
    },
  ) {}

  async dispatchGoal(goalId: string): Promise<void> {
    if (this.deps.dispatchInFlight.has(goalId)) return;
    this.deps.dispatchInFlight.add(goalId);
    try {
      await this.deps.plannerDispatcher.dispatchGoal(goalId);
    } finally {
      this.deps.dispatchInFlight.delete(goalId);
    }
  }
}
