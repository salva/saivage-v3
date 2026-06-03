import type { ReviewerResult } from '../../contracts/index.js';
import type { CardRecord, RuntimeState } from '../../schemas/index.js';

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
  existingResult: CardRecord['result'] | undefined;
  blockedReason: string;
}): Partial<CardRecord> {
  return {
    status: 'blocked',
    error: input.blockedReason,
    status_text: input.blockedReason,
    result: {
      ...(input.existingResult ?? {}),
      planning: {
        status: 'blocked',
        blocked_reason: input.blockedReason,
        resume_reason: 'reviewer_unavailable',
        failure_kind: 'reviewer_invocation_failed',
        created_cards: [],
        updated_cards: [],
      },
    },
  };
}

export function buildReviewerPassCompletionPatch(input: {
  existingResult: CardRecord['result'] | undefined;
  existingCompletedAt: string | null | undefined;
  completedAt: string;
  reviewSummary: string;
}): Partial<CardRecord> {
  return {
    completed_at: input.existingCompletedAt ?? input.completedAt,
    result: {
      ...(input.existingResult ?? {}),
      planning: {
        status: 'done',
        created_cards: [],
        review_summary: input.reviewSummary,
      },
    },
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
