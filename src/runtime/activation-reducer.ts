import type { ActivationCompletionOutcome, CardRecord, RuntimeState } from '../schemas/index.js';

/**
 * @internal
 * @stage activation-state-machine
 *
 * Planner-facing shapers for active card run snapshots. RuntimeStateMachine owns
 * card phase transitions and RuntimeStateMutationPort owns persisted activation
 * completion.
 */
export type ActivationState =
  | { phase: 'planner'; cardId: string; plannerSessionId: string; correctionAttempts: number; cardType?: CardRecord['type']; activeRun?: NonNullable<RuntimeState['active_card_run']> }
  | { phase: 'executor'; cardId: string; goalId: string; executorSessionId: string; cardType?: CardRecord['type']; callerSessionId?: string | null; callerToolCallId?: string | null; activeRun?: NonNullable<RuntimeState['active_card_run']> }
  | { phase: 'reviewer'; cardId: string; reviewerSessionId: string; assessmentId: string; cardType?: CardRecord['type']; activeRun?: NonNullable<RuntimeState['active_card_run']> }
  | { phase: 'completed'; cardId: string; outcome: ActivationCompletionOutcome }
  | { phase: 'repairing'; cardId: string; previous: NonNullable<RuntimeState['active_card_run']> };

export function activeRunFromActivationState(state: ActivationState, nowIso: string): RuntimeState['active_card_run'] {
  if (state.phase === 'completed') return null;
  if (state.phase === 'repairing') return state.previous;
  if (state.phase === 'planner') {
    return {
      ...state.activeRun,
      card_id: state.cardId,
      card_type: state.activeRun?.card_type ?? state.cardType ?? 'goal',
      runtime_status: state.activeRun?.runtime_status ?? 'running',
      phase: 'planner',
      caller_session_id: state.activeRun?.caller_session_id ?? null,
      caller_tool_call_id: state.activeRun?.caller_tool_call_id ?? null,
      planner_session_id: state.plannerSessionId,
      correction_attempts: state.correctionAttempts,
      started_at: state.activeRun?.started_at ?? nowIso,
      last_turn_at: state.activeRun?.last_turn_at ?? nowIso,
    };
  }
  if (state.phase === 'executor') {
    return {
      ...state.activeRun,
      card_id: state.cardId,
      card_type: state.activeRun?.card_type ?? state.cardType ?? 'code',
      runtime_status: state.activeRun?.runtime_status ?? 'running',
      phase: 'executor',
      caller_session_id: state.activeRun?.caller_session_id ?? state.callerSessionId ?? `planner:${state.goalId}`,
      caller_tool_call_id: state.activeRun?.caller_tool_call_id ?? state.callerToolCallId ?? null,
      planner_session_id: state.activeRun?.planner_session_id ?? `planner:${state.goalId}`,
      executor_session_id: state.executorSessionId,
      correction_attempts: state.activeRun?.correction_attempts ?? 0,
      started_at: state.activeRun?.started_at ?? nowIso,
      last_turn_at: state.activeRun?.last_turn_at ?? nowIso,
    };
  }
  return {
    ...state.activeRun,
    card_id: state.cardId,
    card_type: state.activeRun?.card_type ?? state.cardType ?? 'goal',
    runtime_status: state.activeRun?.runtime_status ?? 'running',
    phase: 'reviewer',
    caller_session_id: state.activeRun?.caller_session_id ?? null,
    caller_tool_call_id: state.activeRun?.caller_tool_call_id ?? null,
    planner_session_id: state.activeRun?.planner_session_id ?? `planner:${state.cardId}`,
    reviewer_session_id: state.reviewerSessionId,
    correction_attempts: state.activeRun?.correction_attempts ?? 0,
    started_at: state.activeRun?.started_at ?? nowIso,
    last_turn_at: state.activeRun?.last_turn_at ?? nowIso,
  };
}

export function plannerActivationStateFromGoal(input: {
  goal: Pick<CardRecord, 'id' | 'type'>;
  plannerSessionId: string;
}): Extract<ActivationState, { phase: 'planner' }> {
  return {
    phase: 'planner',
    cardId: input.goal.id,
    cardType: input.goal.type,
    plannerSessionId: input.plannerSessionId,
    correctionAttempts: 0,
  };
}

export function executorActivationStateFromCard(input: {
  card: Pick<CardRecord, 'id' | 'type'>;
  goalId: string;
  executorSessionId: string;
  callerEdge?: { callerSessionId: string; callerToolCallId: string } | null;
  activeRun?: NonNullable<RuntimeState['active_card_run']>;
}): Extract<ActivationState, { phase: 'executor' }> {
  return {
    phase: 'executor',
    cardId: input.card.id,
    cardType: input.card.type,
    goalId: input.goalId,
    executorSessionId: input.executorSessionId,
    callerSessionId: input.callerEdge?.callerSessionId ?? null,
    callerToolCallId: input.callerEdge?.callerToolCallId ?? null,
    activeRun: input.activeRun,
  };
}

export function reviewerActivationStateFromCard(input: {
  goalId: string;
  reviewerSessionId: string;
  assessmentId: string;
  goalCard?: Pick<CardRecord, 'type'> | null;
  activeRun?: NonNullable<RuntimeState['active_card_run']>;
}): Extract<ActivationState, { phase: 'reviewer' }> {
  return {
    phase: 'reviewer',
    cardId: input.goalId,
    cardType: input.goalCard?.type ?? 'goal',
    reviewerSessionId: input.reviewerSessionId,
    assessmentId: input.assessmentId,
    activeRun: input.activeRun,
  };
}
