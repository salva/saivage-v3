import type { ActiveCardRun, RuntimeState } from '../schemas/index.js';

export function deriveCurrentCardId(state: Pick<RuntimeState, 'active_card_run'> | null | undefined): string | null {
  return state?.active_card_run?.card_id ?? null;
}

export function deriveCurrentAgentSessionIdFromRun(run: ActiveCardRun | null | undefined): string | null {
  if (!run) return null;
  switch (run.phase) {
    case 'planner':
      return run.planner_session_id ?? null;
    case 'executor':
      return run.executor_session_id ?? null;
    case 'reviewer':
      return run.reviewer_session_id ?? null;
  }
}

export function deriveCurrentAgentSessionId(state: Pick<RuntimeState, 'active_card_run'> | null | undefined): string | null {
  return deriveCurrentAgentSessionIdFromRun(state?.active_card_run ?? null);
}
