import type { ActivationCompletionOutcome, CardRecord, RuntimeDispatchOwnership, RuntimeState } from '../schemas/index.js';

/**
 * @internal
 * @stage activation-state-machine
 *
 * Planner-facing shapers for active card run snapshots. The actor runtime owns
 * card phase transitions and RuntimeStateMutationPort owns persisted activation
 * completion.
 */
export type ActivationState =
  | { phase: 'planner'; cardId: string; cardType: CardRecord['type']; ownership: RuntimeDispatchOwnership; plannerSessionId: string; correctionAttempts: number; callerSessionId: string | null; callerToolCallId: string | null; activeRun?: NonNullable<RuntimeState['active_card_run']> }
  | { phase: 'executor'; cardId: string; cardType: CardRecord['type']; ownership: RuntimeDispatchOwnership; executorSessionId: string; callerSessionId: string; callerToolCallId: string; plannerSessionId: string | null; activeRun?: NonNullable<RuntimeState['active_card_run']> }
  | { phase: 'reviewer'; cardId: string; cardType: CardRecord['type']; ownership: RuntimeDispatchOwnership; reviewerSessionId: string; plannerSessionId: string | null; callerSessionId: string | null; callerToolCallId: string | null; correctionAttempts: number; activeRun?: NonNullable<RuntimeState['active_card_run']> }
  | { phase: 'completed'; cardId: string; outcome: ActivationCompletionOutcome }
  | { phase: 'repairing'; cardId: string; previous: NonNullable<RuntimeState['active_card_run']> };

export function activeRunFromActivationState(state: ActivationState, nowIso: string): RuntimeState['active_card_run'] {
  if (state.phase === 'completed') return null;
  if (state.phase === 'repairing') return state.previous;
  if (state.phase === 'planner') {
    return {
      ...state.activeRun,
      card_id: state.cardId,
      card_type: state.cardType,
      ownership: state.ownership,
      runtime_status: state.activeRun?.runtime_status ?? 'running',
      phase: 'planner',
      caller_session_id: state.callerSessionId,
      caller_tool_call_id: state.callerToolCallId,
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
      card_type: state.cardType,
      ownership: state.ownership,
      runtime_status: state.activeRun?.runtime_status ?? 'running',
      phase: 'executor',
      caller_session_id: state.callerSessionId,
      caller_tool_call_id: state.callerToolCallId,
      planner_session_id: state.plannerSessionId,
      executor_session_id: state.executorSessionId,
      correction_attempts: state.activeRun?.correction_attempts ?? 0,
      started_at: state.activeRun?.started_at ?? nowIso,
      last_turn_at: state.activeRun?.last_turn_at ?? nowIso,
    };
  }
  return {
    ...state.activeRun,
    card_id: state.cardId,
    card_type: state.cardType,
    ownership: state.ownership,
    runtime_status: state.activeRun?.runtime_status ?? 'running',
    phase: 'reviewer',
    caller_session_id: state.callerSessionId,
    caller_tool_call_id: state.callerToolCallId,
    planner_session_id: state.plannerSessionId,
    reviewer_session_id: state.reviewerSessionId,
    correction_attempts: state.activeRun?.correction_attempts ?? 0,
    started_at: state.activeRun?.started_at ?? nowIso,
    last_turn_at: state.activeRun?.last_turn_at ?? nowIso,
  };
}

export function plannerActivationStateFromGoal(input: {
  goal: Pick<CardRecord, 'id' | 'type'>;
  ownership: RuntimeDispatchOwnership;
  plannerSessionId: string;
  callerSessionId: string | null;
  callerToolCallId: string | null;
}): Extract<ActivationState, { phase: 'planner' }> {
  return {
    phase: 'planner',
    cardId: input.goal.id,
    cardType: input.goal.type,
    ownership: input.ownership,
    plannerSessionId: input.plannerSessionId,
    callerSessionId: input.callerSessionId,
    callerToolCallId: input.callerToolCallId,
    correctionAttempts: 0,
  };
}

export function executorActivationStateFromCard(input: {
  card: Pick<CardRecord, 'id' | 'type'>;
  ownership: RuntimeDispatchOwnership;
  executorSessionId: string;
  callerEdge: { callerSessionId: string; callerToolCallId: string };
  plannerSessionId: string | null;
  activeRun?: NonNullable<RuntimeState['active_card_run']>;
}): Extract<ActivationState, { phase: 'executor' }> {
  return {
    phase: 'executor',
    cardId: input.card.id,
    cardType: input.card.type,
    ownership: input.ownership,
    executorSessionId: input.executorSessionId,
    callerSessionId: input.callerEdge.callerSessionId,
    callerToolCallId: input.callerEdge.callerToolCallId,
    plannerSessionId: input.plannerSessionId,
    activeRun: input.activeRun,
  };
}

export function reviewerActivationStateFromCard(input: {
  goalId: string;
  ownership: RuntimeDispatchOwnership;
  reviewerSessionId: string;
  assessmentId: string;
  goalCard: Pick<CardRecord, 'type'>;
  plannerSessionId: string | null;
  callerSessionId: string | null;
  callerToolCallId: string | null;
  correctionAttempts: number;
  activeRun?: NonNullable<RuntimeState['active_card_run']>;
}): Extract<ActivationState, { phase: 'reviewer' }> {
  return {
    phase: 'reviewer',
    cardId: input.goalId,
    cardType: input.goalCard.type,
    ownership: input.ownership,
    reviewerSessionId: input.reviewerSessionId,
    plannerSessionId: input.plannerSessionId,
    callerSessionId: input.callerSessionId,
    callerToolCallId: input.callerToolCallId,
    correctionAttempts: input.correctionAttempts,
    activeRun: input.activeRun,
  };
}
