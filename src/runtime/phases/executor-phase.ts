import type { ActivationCompletionOutcome, CardRecord, CardStatus, RuntimeDispatchOwnership, RuntimeState } from '../../schemas/index.js';
import type { ExecutorResult } from '../../contracts/index.js';
import { activeRunFromActivationState, executorActivationStateFromCard } from '../activation-reducer.js';

export interface ExecutorOutcomeDecision {
  parkedForVerification: boolean;
  finalStatus: CardStatus;
  outcome: ActivationCompletionOutcome;
  transitionAction: 'executor_finish' | 'executor_partial_finish';
  reason?: string;
}

export function decideExecutorOutcome(input: {
  execResult: ExecutorResult;
  registrationFailed: boolean;
}): ExecutorOutcomeDecision {
  const { execResult, registrationFailed } = input;
  const parkedForVerification = !registrationFailed && execResult.fallback_with_evidence !== null;
  if (parkedForVerification) {
    return {
      parkedForVerification,
      finalStatus: 'needs_verification',
      outcome: 'needs_verification',
      transitionAction: 'executor_partial_finish',
      reason: `fallback_with_evidence:${execResult.fallback_with_evidence!.reason}`,
    };
  }
  const finalStatus: CardStatus = registrationFailed ? 'failed' : execResult.status;
  return {
    parkedForVerification,
    finalStatus,
    outcome: finalStatus === 'done' ? 'done' : 'failed',
    transitionAction: 'executor_finish',
    reason: registrationFailed ? 'evidence_registration_failed' : undefined,
  };
}

export function buildExecutorActiveRunPatch(input: {
  card: Pick<CardRecord, 'id' | 'type'>;
  goalId: string;
  ownership: RuntimeDispatchOwnership;
  callerEdge: { callerSessionId: string; callerToolCallId: string };
  plannerSessionId: string | null;
  at: string;
}): Partial<RuntimeState> {
  const executorSessionId = `executor-${input.card.id}`;
  return {
    status: 'running',
    active_card_run: activeRunFromActivationState(executorActivationStateFromCard({ ...input, executorSessionId }), input.at),
  };
}

export function resolveExecutorLastSessionId(input: {
  adapterLastSessionId: string | null | undefined;
  activeRunExecutorSessionId: string | null | undefined;
  currentAgentSessionId: string | null | undefined;
}): string | null {
  return input.adapterLastSessionId ?? input.activeRunExecutorSessionId ?? input.currentAgentSessionId ?? null;
}
