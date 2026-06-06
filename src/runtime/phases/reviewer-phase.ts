import type { ReviewerResult } from '../../contracts/index.js';
import type { CardRecord, RuntimeState } from '../../schemas/index.js';
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
  reviewerSessionId: string;
  assessmentId: string;
  goalCard: Pick<CardRecord, 'type'> | null | undefined;
  at: string;
}): NonNullable<RuntimeState['active_card_run']> {
  return activeRunFromActivationState(reviewerActivationStateFromCard(input), input.at)!;
}
