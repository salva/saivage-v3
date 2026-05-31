import type { CardStatus, RuntimeState } from '../schemas/index.js';

const TERMINAL_STATUSES: ReadonlySet<CardStatus> = new Set<CardStatus>(['done', 'failed', 'cancelled']);

export type RuntimeStateMachineEvent =
  | 'tick'
  | 'paused'
  | 'resumed'
  | 'goal_exit'
  | 'card_terminated'
  | 'goal_completed'
  | 'reviewer_started'
  | 'reviewer_finished';

export function reduceRuntimeEvent(
  currentState: RuntimeState | null,
  event: Exclude<RuntimeStateMachineEvent, 'tick'>,
  payload: Record<string, unknown>,
  nowIso: string,
): Partial<RuntimeState> {
  switch (event) {
    case 'paused':
      return { status: 'paused', paused: true, paused_at: nowIso };
    case 'resumed':
      return { status: currentState?.active_card_run ? 'running' : 'idle', paused: false, paused_at: null };
    case 'goal_exit':
    case 'card_terminated':
    case 'goal_completed':
      return { status: 'idle', current_card_id: null, current_agent_session_id: null, active_card_run: null };
    case 'reviewer_started': {
      const goalId = (payload.goalId as string | undefined) ?? null;
      const reviewerSessionId = (payload.reviewerSessionId as string | undefined) ?? null;
      const activeCardRun = (payload.activeCardRun ?? null) as RuntimeState['active_card_run'];
      return { current_card_id: goalId, current_agent_session_id: reviewerSessionId, active_card_run: activeCardRun };
    }
    case 'reviewer_finished':
      return { status: 'idle', current_card_id: null, current_agent_session_id: null, active_card_run: null };
  }
}

export type InvariantId = 'I1' | 'I2' | 'I3' | 'I4';

export interface RuntimeInvariantObservation {
  invariant: InvariantId;
  key: string;
  details: Record<string, unknown>;
  correction?: Partial<RuntimeState>;
}

export function observeRuntimeStateInvariants(input: {
  state: RuntimeState;
  currentCardStatus: CardStatus | null;
}): RuntimeInvariantObservation[] {
  const observations: RuntimeInvariantObservation[] = [];
  const { state, currentCardStatus } = input;

  if (state.status === 'running' && (state.active_card_run ?? null) === null) {
    observations.push({
      invariant: 'I1',
      key: 'global',
      details: { status: state.status },
      correction: { status: 'idle', current_card_id: null, current_agent_session_id: null },
    });
  }

  const currentCardId = state.current_card_id ?? null;
  if (currentCardId !== null && currentCardStatus !== null && TERMINAL_STATUSES.has(currentCardStatus)) {
    observations.push({
      invariant: 'I2',
      key: currentCardId,
      details: { cardId: currentCardId, cardStatus: currentCardStatus },
      correction: { status: 'idle', current_card_id: null, current_agent_session_id: null, active_card_run: null },
    });
  }

  const runCardId = state.active_card_run?.card_id ?? null;
  if (runCardId !== currentCardId) {
    observations.push({
      invariant: 'I3',
      key: `${currentCardId ?? 'null'}|${runCardId ?? 'null'}`,
      details: { currentCardId, activeRunCardId: runCardId },
      correction: { status: 'idle', current_card_id: null, current_agent_session_id: null, active_card_run: null },
    });
  }

  return observations;
}

export interface ProjectRootRedispatchDecision {
  shouldRedispatch: boolean;
  cardId?: string;
  reason?: string;
}

export function planProjectRootRedispatch(input: {
  state: RuntimeState;
  projectCardId: string;
}): ProjectRootRedispatchDecision {
  const { state, projectCardId } = input;
  if (state.paused) return { shouldRedispatch: false };
  if (state.status !== 'idle') return { shouldRedispatch: false };
  if ((state.active_card_run ?? null) !== null) return { shouldRedispatch: false };
  const intentStatus = state.runtime_intent?.status ?? 'stopped';
  if (intentStatus !== 'running') return { shouldRedispatch: false };
  const rootRuns = (state.runtime_runs ?? []).filter((run) => run.kind === 'root' && run.card_id === projectCardId);
  const openRootRun = rootRuns.find((run) => !run.finished_at);
  if (openRootRun) return { shouldRedispatch: true, cardId: projectCardId, reason: 'open_root_run' };
  const latestRootRun = rootRuns.slice().sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))[0];
  if (latestRootRun?.result === 'failed' || latestRootRun?.runtime_status === 'error' || latestRootRun?.phase === 'failed') {
    return { shouldRedispatch: true, cardId: projectCardId, reason: 'failed_root_run_with_running_intent' };
  }
  return { shouldRedispatch: false };
}
