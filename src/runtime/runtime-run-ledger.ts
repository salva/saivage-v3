import type { RuntimeRunRecord } from '../schemas/index.js';
import {
  planOpenPlannerRunTerminalUpdate,
  planPlannerRunSessionBinding,
} from './runtime-core.js';
import { readRuntimeState, updateRuntimeRun } from './state.js';

export class RuntimeRunLedger {
  constructor(
    private readonly deps: {
      projectRoot: string;
      now(): string;
      publishRuntimeRun(run: RuntimeRunRecord): void;
    },
  ) {}

  finishOpenPlannerRun(goalId: string, result: 'blocked' | 'failed'): void {
    const plan = planOpenPlannerRunTerminalUpdate({
      state: readRuntimeState(this.deps.projectRoot),
      goalId,
      result,
      nowIso: this.deps.now(),
    });
    if (!plan) return;
    const updated = updateRuntimeRun(this.deps.projectRoot, plan.runId, plan.updates);
    if (updated) this.deps.publishRuntimeRun(updated);
  }

  bindPlannerSessionToOpenRun(goalId: string, plannerSessionId: string): void {
    const plan = planPlannerRunSessionBinding({
      state: readRuntimeState(this.deps.projectRoot),
      goalId,
      plannerSessionId,
    });
    if (!plan) return;
    const updated = updateRuntimeRun(this.deps.projectRoot, plan.runId, plan.updates);
    if (updated) this.deps.publishRuntimeRun(updated);
  }
}
