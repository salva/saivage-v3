import type { CardRecord } from '../../schemas/index.js';
import type { CardLifecycleState, PlannerBlockedResult, PlannerDoneResult, PlannerFailureResult } from '../../schemas/lifecycle.js';
import type { GoalCardStatusPort, GoalOutcome } from './goal-card-runner.js';

export interface GoalCardStorePort {
  setStatus(id: string, status: 'running' | 'cancelled'): CardRecord;
  commitTerminalLifecyclePatch(id: string, changes: Partial<CardRecord>): CardRecord;
}

export function createGoalCardStatusPort(store: GoalCardStorePort, now: () => string = () => new Date().toISOString()): GoalCardStatusPort {
  return {
    markRunning(cardId) {
      store.setStatus(cardId, 'running');
    },
    markCancelled(cardId) {
      store.setStatus(cardId, 'cancelled');
    },
    commitGoalOutcome(cardId, outcome) {
      const stamp = now();
      store.commitTerminalLifecyclePatch(cardId, {
        status: outcome.status,
        lifecycle: goalLifecycle(outcome, stamp),
        status_text: outcome.statusText,
        status_text_updated_at: stamp,
        status_text_author_session_id: null,
      });
    },
  };
}

function goalLifecycle(outcome: GoalOutcome, stamp: string): CardLifecycleState {
  if (outcome.status === 'done') {
    const result: PlannerDoneResult = { kind: 'planner_done', summary: outcome.statusText };
    return { status: 'done', result, error: null, completed_at: stamp };
  }
  if (outcome.status === 'failed') {
    const result: PlannerFailureResult = { kind: 'planner_failure', error: outcome.statusText };
    return { status: 'failed', result, error: outcome.statusText, completed_at: stamp };
  }
  if (outcome.status === 'blocked') {
    const result: PlannerBlockedResult = { kind: 'planner_blocked', blocked_reason: outcome.statusText, resume_reason: 'xstate_goal_blocked', blocker_cause: 'generic' };
    return { status: 'blocked', result, error: outcome.statusText, completed_at: null };
  }
  return { status: 'cancelled', result: null, error: null, completed_at: stamp };
}
