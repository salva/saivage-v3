import type { ActivationCompletionOutcome, RuntimeState } from '../schemas/index.js';
import type { ExecutorResult, PlannerResult, ReviewerResult } from '../contracts/index.js';

export type ActivationState =
  | { phase: 'planner'; cardId: string; plannerSessionId: string; correctionAttempts: number }
  | { phase: 'executor'; cardId: string; goalId: string; executorSessionId: string }
  | { phase: 'reviewer'; cardId: string; reviewerSessionId: string; assessmentId: string }
  | { phase: 'completed'; cardId: string; outcome: ActivationCompletionOutcome }
  | { phase: 'repairing'; cardId: string; previous: NonNullable<RuntimeState['active_card_run']> };

export type ActivationEvent =
  | { type: 'plannerResult'; result: PlannerResult }
  | { type: 'childActivated'; childCardId: string }
  | { type: 'executorResult'; result: ExecutorResult }
  | { type: 'reviewerResult'; result: ReviewerResult }
  | { type: 'pauseRequested' }
  | { type: 'cancelRequested'; reason: string }
  | { type: 'restartRepairRequested' }
  | { type: 'complete'; outcome: ActivationCompletionOutcome };

export type ActivationEffect =
  | { kind: 'invokePlanner'; cardId: string; plannerSessionId: string }
  | { kind: 'invokeExecutor'; cardId: string; executorSessionId: string }
  | { kind: 'invokeReviewer'; cardId: string; reviewerSessionId: string; assessmentId: string }
  | { kind: 'unwindActivation'; cardId: string; outcome: ActivationCompletionOutcome }
  | { kind: 'pauseActivation'; cardId: string }
  | { kind: 'cancelActivation'; cardId: string; reason: string }
  | { kind: 'repairActivation'; cardId: string };

export interface ActivationDecision {
  state: ActivationState;
  effects: ActivationEffect[];
}

export function activationStateFromActiveRun(activeRun: RuntimeState['active_card_run']): ActivationState | null {
  if (!activeRun) return null;
  if (activeRun.phase === 'planner') {
    return {
      phase: 'planner',
      cardId: activeRun.card_id,
      plannerSessionId: activeRun.planner_session_id ?? `planner:${activeRun.card_id}`,
      correctionAttempts: activeRun.correction_attempts,
    };
  }
  if (activeRun.phase === 'executor') {
    return {
      phase: 'executor',
      cardId: activeRun.card_id,
      goalId: activeRun.planner_session_id?.replace(/^planner:/, '') ?? activeRun.card_id,
      executorSessionId: activeRun.executor_session_id ?? `executor:${activeRun.card_id}`,
    };
  }
  if (activeRun.phase === 'reviewer') {
    return {
      phase: 'reviewer',
      cardId: activeRun.card_id,
      reviewerSessionId: activeRun.reviewer_session_id ?? `reviewer:${activeRun.card_id}`,
      assessmentId: activeRun.reviewer_session_id?.split(':').slice(2).join(':') || `assessment-${activeRun.card_id}-1`,
    };
  }
  return { phase: 'repairing', cardId: activeRun.card_id, previous: activeRun };
}

export function activeRunFromActivationState(state: ActivationState, nowIso: string): RuntimeState['active_card_run'] {
  if (state.phase === 'completed') return null;
  if (state.phase === 'repairing') return state.previous;
  if (state.phase === 'planner') {
    return {
      card_id: state.cardId,
      card_type: 'goal',
      runtime_status: 'running',
      phase: 'planner',
      caller_session_id: null,
      caller_tool_call_id: null,
      planner_session_id: state.plannerSessionId,
      correction_attempts: state.correctionAttempts,
      started_at: nowIso,
      last_turn_at: nowIso,
    };
  }
  if (state.phase === 'executor') {
    return {
      card_id: state.cardId,
      card_type: 'code',
      runtime_status: 'running',
      phase: 'executor',
      caller_session_id: null,
      caller_tool_call_id: null,
      planner_session_id: `planner:${state.goalId}`,
      executor_session_id: state.executorSessionId,
      correction_attempts: 0,
      started_at: nowIso,
      last_turn_at: nowIso,
    };
  }
  return {
    card_id: state.cardId,
    card_type: 'goal',
    runtime_status: 'running',
    phase: 'reviewer',
    caller_session_id: null,
    caller_tool_call_id: null,
    planner_session_id: `planner:${state.cardId}`,
    reviewer_session_id: state.reviewerSessionId,
    correction_attempts: 0,
    started_at: nowIso,
    last_turn_at: nowIso,
  };
}

export function reduceActivation(state: ActivationState, event: ActivationEvent): ActivationDecision {
  if (event.type === 'pauseRequested') return { state, effects: [{ kind: 'pauseActivation', cardId: state.cardId }] };
  if (event.type === 'cancelRequested') return { state, effects: [{ kind: 'cancelActivation', cardId: state.cardId, reason: event.reason }] };
  if (event.type === 'restartRepairRequested') return { state: { phase: 'repairing', cardId: state.cardId, previous: activeRunFromActivationState(state, new Date(0).toISOString())! }, effects: [{ kind: 'repairActivation', cardId: state.cardId }] };
  if (event.type === 'complete') return { state: { phase: 'completed', cardId: state.cardId, outcome: event.outcome }, effects: [{ kind: 'unwindActivation', cardId: state.cardId, outcome: event.outcome }] };
  return { state, effects: [] };
}
