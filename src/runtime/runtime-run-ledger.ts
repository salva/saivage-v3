import type { RuntimeRunRecord } from '../schemas/index.js';
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
    const updated = deps.mutations.apply({ kind: 'finishOpenPlannerRun', goalId, result, at: deps.now() });
    if (updated) deps.publishRuntimeRun(updated);
    },

    bindPlannerSessionToOpenRun(goalId: string, plannerSessionId: string): void {
    const updated = deps.mutations.apply({ kind: 'bindPlannerSessionToOpenRun', goalId, plannerSessionId });
    if (updated) deps.publishRuntimeRun(updated);
    },
  };
}
