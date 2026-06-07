import type { ReviewerResult } from '../../contracts/index.js';
import type { CardRecord, RuntimeDispatchOwnership, RuntimeState } from '../../schemas/index.js';
import { activeRunFromActivationState, reviewerActivationStateFromCard } from '../activation-reducer.js';

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

export function buildReviewerActiveRun(input: {
  goalId: string;
  ownership: RuntimeDispatchOwnership;
  reviewerSessionId: string;
  assessmentId: string;
  goalCard: Pick<CardRecord, 'type'>;
  activeRun: NonNullable<RuntimeState['active_card_run']>;
  at: string;
}): NonNullable<RuntimeState['active_card_run']> {
  return activeRunFromActivationState(reviewerActivationStateFromCard({
    ...input,
    plannerSessionId: input.activeRun.planner_session_id ?? null,
    callerSessionId: input.activeRun.caller_session_id,
    callerToolCallId: input.activeRun.caller_tool_call_id,
    correctionAttempts: input.activeRun.correction_attempts,
  }), input.at)!;
}
