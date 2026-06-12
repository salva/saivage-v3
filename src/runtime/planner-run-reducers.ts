import type { RuntimeRunRecord, RuntimeState } from '../schemas/index.js';

export interface RuntimeRunUpdatePlan {
  runId: string;
  updates: Partial<RuntimeRunRecord>;
}

function isOpenPlannerRun(run: RuntimeRunRecord, goalId: string): boolean {
  return (
    run.card_id === goalId &&
    run.phase === 'planner' &&
    run.runtime_status === 'running' &&
    !run.finished_at
  );
}

function preferRootRun(a: RuntimeRunRecord, b: RuntimeRunRecord): number {
  return (b.kind === 'root' ? 1 : 0) - (a.kind === 'root' ? 1 : 0);
}

function canPlannerTerminalUpdateOwnRun(run: RuntimeRunRecord): boolean {
  return run.kind === 'root' || !run.activation_id;
}

export function planPlannerRunSessionBinding(input: {
  state: RuntimeState | null;
  goalId: string;
  plannerSessionId: string;
}): RuntimeRunUpdatePlan | null {
  const { state, goalId, plannerSessionId } = input;
  const openRun = (state?.runtime_runs ?? [])
    .filter(
      (run) =>
        run.card_id === goalId &&
        ['pending', 'planner'].includes(run.phase) &&
        run.runtime_status === 'running' &&
        !run.finished_at &&
        (!run.session_id || run.session_id === plannerSessionId),
    )
    .sort((a, b) => {
      const phase = (b.phase === 'planner' ? 1 : 0) - (a.phase === 'planner' ? 1 : 0);
      if (phase !== 0) return phase;
      return preferRootRun(a, b);
    })[0];
  if (!openRun) return null;
  const updates: Partial<RuntimeRunRecord> = {};
  if (openRun.phase !== 'planner') updates.phase = 'planner';
  if (openRun.session_id !== plannerSessionId) updates.session_id = plannerSessionId;
  return Object.keys(updates).length > 0 ? { runId: openRun.run_id, updates } : null;
}

export function planOpenPlannerRunTerminalUpdate(input: {
  state: RuntimeState | null;
  goalId: string;
  result: 'blocked' | 'failed';
  nowIso: string;
}): RuntimeRunUpdatePlan | null {
  const { state, goalId, result, nowIso } = input;
  const openRun = (state?.runtime_runs ?? [])
    .filter(
      (run) =>
        isOpenPlannerRun(run, goalId) &&
        (!run.session_id || run.session_id === `planner:${goalId}`) &&
        canPlannerTerminalUpdateOwnRun(run),
    )
    .sort(preferRootRun)[0];
  if (!openRun) return null;
  return {
    runId: openRun.run_id,
    updates: {
      phase: result,
      runtime_status: 'error',
      finished_at: nowIso,
      updated_at: nowIso,
      outcome: result === 'blocked'
        ? { kind: 'blocked', error: 'Planner run blocked.' }
        : { kind: 'completed', result: 'failed', error: 'Planner run failed.', finished_at: nowIso },
    },
  };
}
