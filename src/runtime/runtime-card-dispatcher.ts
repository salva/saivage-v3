import type { RuntimePlannerDispatcher } from './runtime-planner-dispatcher.js';
import type { RuntimeLifecycleState } from './runtime-lifecycle-state.js';

export class RuntimeCardDispatcher {
  constructor(
    private readonly deps: {
      plannerDispatcher: RuntimePlannerDispatcher;
      lifecycle: RuntimeLifecycleState;
    },
  ) {}

  async dispatchGoal(goalId: string): Promise<void> {
    if (this.deps.lifecycle.dispatchInFlight.has(goalId)) return;
    this.deps.lifecycle.dispatchInFlight.add(goalId);
    try {
      await this.deps.plannerDispatcher.dispatchGoal(goalId);
    } finally {
      this.deps.lifecycle.dispatchInFlight.delete(goalId);
    }
  }
}
