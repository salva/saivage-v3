import type { ReviewerResult } from '../../contracts/index.js';
import type { CardLifecycleState, CardRecord, RuntimeState } from '../../schemas/index.js';
import { lifecycleCardPatch } from '../terminal-commit/lifecycle-patch.js';

export type ReviewerPhaseDecision =
  | { kind: 'invalid_pass'; reason: string }
  | { kind: 'pass' }
  | { kind: 'needs_corrections' };

export function decideReviewerPhase(input: {
  assessment: ReviewerResult['assessment'];
  validation: { valid: boolean; reason?: string };
}): ReviewerPhaseDecision {
  if (input.assessment.result === 'pass' && !input.validation.valid) {
    return { kind: 'invalid_pass', reason: input.validation.reason ?? 'Reviewer evidence validation failed.' };
  }
  if (input.assessment.result === 'pass') return { kind: 'pass' };
  return { kind: 'needs_corrections' };
}

export function buildReviewerInvocationFailurePatch(input: {
  existingLifecycle: CardLifecycleState;
  blockedReason: string;
}): Partial<CardRecord> {
  const lifecycle = {
    status: 'blocked',
    error: input.blockedReason,
    completed_at: null,
    result: {
      kind: 'planner_blocked',
      blocked_reason: input.blockedReason,
      resume_reason: 'reviewer_unavailable',
    },
  } satisfies Extract<CardLifecycleState, { status: 'blocked' }>;
  return {
    ...lifecycleCardPatch(lifecycle),
    status_text: input.blockedReason,
  };
}

export function buildReviewerActiveRun(input: {
  goalId: string;
  reviewerSessionId: string;
  goalCard: Pick<CardRecord, 'type'> | null | undefined;
  at: string;
}): NonNullable<RuntimeState['active_card_run']> {
  return {
    card_id: input.goalId,
    card_type: input.goalCard?.type ?? 'goal',
    runtime_status: 'running',
    phase: 'reviewer',
    caller_session_id: null,
    caller_tool_call_id: null,
    planner_session_id: `planner:${input.goalId}`,
    reviewer_session_id: input.reviewerSessionId,
    correction_attempts: 0,
    started_at: input.at,
    last_turn_at: input.at,
  };
}
