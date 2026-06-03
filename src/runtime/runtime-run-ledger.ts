import type { RuntimeRunRecord } from '../schemas/index.js';
import {
  planOpenPlannerRunTerminalUpdate,
  planPlannerRunSessionBinding,
} from './runtime-core.js';
import { readRuntimeState } from './state.js';
import type { RuntimeStateMutationPort } from './mutations.js';

export class RuntimeRunLedger {
  constructor(
    private readonly deps: {
      projectRoot: string;
      now(): string;
      mutations: RuntimeStateMutationPort;
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
    const updated = this.deps.mutations.apply({ kind: 'updateRuntimeRun', runId: plan.runId, updates: plan.updates });
    if (updated) this.deps.publishRuntimeRun(updated);
  }

  bindPlannerSessionToOpenRun(goalId: string, plannerSessionId: string): void {
    const plan = planPlannerRunSessionBinding({
      state: readRuntimeState(this.deps.projectRoot),
      goalId,
      plannerSessionId,
    });
    if (!plan) return;
    const updated = this.deps.mutations.apply({ kind: 'updateRuntimeRun', runId: plan.runId, updates: plan.updates });
    if (updated) this.deps.publishRuntimeRun(updated);
  }
}
