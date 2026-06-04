import type { RuntimeRunRecord } from '../schemas/index.js';
import {
  planOpenPlannerRunTerminalUpdate,
  planPlannerRunSessionBinding,
} from './runtime-core.js';
import { readRuntimeState } from './state.js';
import type { RuntimeStateMutationPort } from './mutations.js';

export interface RuntimeRunLedger {
  finishOpenPlannerRun(goalId: string, result: 'blocked' | 'failed'): void;
  bindPlannerSessionToOpenRun(goalId: string, plannerSessionId: string): void;
}

interface RuntimeRunLedgerDeps {
  projectRoot: string;
  now(): string;
  mutations: RuntimeStateMutationPort;
  publishRuntimeRun(run: RuntimeRunRecord): void;
}

export function createRuntimeRunLedger(deps: RuntimeRunLedgerDeps): RuntimeRunLedger {
  return {
    finishOpenPlannerRun(goalId: string, result: 'blocked' | 'failed'): void {
    const plan = planOpenPlannerRunTerminalUpdate({
      state: readRuntimeState(deps.projectRoot),
      goalId,
      result,
      nowIso: deps.now(),
    });
    if (!plan) return;
    const updated = deps.mutations.apply({ kind: 'updateRuntimeRun', runId: plan.runId, updates: plan.updates });
    if (updated) deps.publishRuntimeRun(updated);
    },

    bindPlannerSessionToOpenRun(goalId: string, plannerSessionId: string): void {
    const plan = planPlannerRunSessionBinding({
      state: readRuntimeState(deps.projectRoot),
      goalId,
      plannerSessionId,
    });
    if (!plan) return;
    const updated = deps.mutations.apply({ kind: 'updateRuntimeRun', runId: plan.runId, updates: plan.updates });
    if (updated) deps.publishRuntimeRun(updated);
    },
  };
}
