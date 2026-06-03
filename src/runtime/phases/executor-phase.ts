import type { ActivationCompletionOutcome, CardRecord, CardStatus, RuntimeState } from '../../schemas/index.js';
import type { ExecutorResult } from '../../contracts/index.js';
import type { RuntimeCardAction } from '../state-machine.js';
import { RESTARTABLE_STATES, STARTABLE_STATES } from '../../permissions/index.js';

export function selectExecutorStartAction(status: CardStatus): RuntimeCardAction | null {
  if ((STARTABLE_STATES as readonly CardStatus[]).includes(status)) return 'start';
  if ((RESTARTABLE_STATES as readonly CardStatus[]).includes(status)) return 'restart';
  if (status === 'active') return 'reviewer_repair_resume';
  if (status === 'running') return null;
  return 'restart';
}

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
      finalStatus: execResult.status,
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

export interface ExecutorCompletionPatchInput {
  execResult: ExecutorResult;
  existingResult: CardRecord['result'] | undefined;
  existingCompletedAt: string | null | undefined;
  acceptedAt: string;
  lastSessionId: string | null;
  terminalCompletedAt: string | null;
  registrationFailed: boolean;
  registrationError: string | null;
  artifactRegistrationErrors: string[];
  attachmentRegistrationErrors: string[];
  parkedForVerification: boolean;
}

export function buildExecutorCompletionPatch(input: ExecutorCompletionPatchInput): Partial<CardRecord> {
  const latestSelfReport = {
    result: input.execResult.status,
    outcome: input.execResult.status,
    summary: input.execResult.summary ?? input.execResult.error ?? input.execResult.status_text,
    status_text: input.execResult.status_text,
    at: input.acceptedAt,
  };
  return {
    result: {
      ...(input.existingResult ?? {}),
      ...(input.execResult.result ?? {}),
      executor: input.execResult.result ?? null,
      latest_self_report: latestSelfReport,
      ...(input.registrationFailed
        ? {
            evidence_registration_failures: {
              artifacts: input.artifactRegistrationErrors,
              attachments: input.attachmentRegistrationErrors,
            },
          }
        : {}),
      ...(input.parkedForVerification
        ? { fallback_with_evidence: input.execResult.fallback_with_evidence }
        : {}),
    },
    ...(input.terminalCompletedAt
      ? { completed_at: input.existingCompletedAt ?? input.terminalCompletedAt }
      : {}),
    error: input.registrationError ?? input.execResult.error ?? null,
    status_text: input.execResult.status_text,
    status_text_updated_at: input.acceptedAt,
    status_text_author_session_id: input.lastSessionId,
    latest_self_report: latestSelfReport,
  };
}

export function buildExecutorActiveRunPatch(input: {
  card: Pick<CardRecord, 'id' | 'type'>;
  goalId: string;
  callerEdge: { callerSessionId: string; callerToolCallId: string } | null | undefined;
  at: string;
}): Partial<RuntimeState> {
  return {
    current_card_id: input.card.id,
    active_card_run: {
      card_id: input.card.id,
      card_type: input.card.type,
      runtime_status: 'running',
      phase: 'executor',
      caller_session_id: input.callerEdge?.callerSessionId ?? `planner:${input.goalId}`,
      caller_tool_call_id: input.callerEdge?.callerToolCallId ?? null,
      executor_session_id: `executor-${input.card.id}`,
      correction_attempts: 0,
      started_at: input.at,
      last_turn_at: input.at,
    },
  };
}

export function resolveExecutorLastSessionId(input: {
  adapterLastSessionId: string | null | undefined;
  activeRunExecutorSessionId: string | null | undefined;
  currentAgentSessionId: string | null | undefined;
}): string | null {
  return input.adapterLastSessionId ?? input.activeRunExecutorSessionId ?? input.currentAgentSessionId ?? null;
}
