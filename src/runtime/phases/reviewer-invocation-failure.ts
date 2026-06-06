import type { CardRecord } from '../../schemas/index.js';
import { commitReviewerInvocationFailure } from '../terminal-commit/index.js';

export interface ReviewerInvocationFailureEffects {
  emitRuntimeDiagnostic(input: { goal_id: string; phase: 'reviewer'; error: unknown }): void;
  appendRuntimeDiagnostic(input: { goal_id: string; phase: 'reviewer'; error_message: string }): void;
  appendError(input: { message: string; goalId: string; phase: 'reviewer' }): void;
  transitionCard(cardId: string, event: 'block', details: Record<string, unknown>): Promise<unknown>;
  updateCard(cardId: string, patch: Partial<CardRecord>): Promise<unknown> | unknown;
  finishOpenPlannerRun(goalId: string, result: 'blocked'): void;
  transitionRuntime(event: 'card_terminated', details: Record<string, unknown>): Promise<unknown>;
}

export async function handleReviewerInvocationFailure(input: {
  goalId: string;
  card: CardRecord;
  error: unknown;
  effects: ReviewerInvocationFailureEffects;
}): Promise<void> {
  const errorMessage = input.error instanceof Error ? input.error.message : String(input.error);
  const blockedReason = `Reviewer invocation failed before assessment output could be produced: ${errorMessage}`;
  input.effects.emitRuntimeDiagnostic({ goal_id: input.goalId, phase: 'reviewer', error: input.error });
  input.effects.appendRuntimeDiagnostic({ goal_id: input.goalId, phase: 'reviewer', error_message: errorMessage });
  input.effects.appendError({ message: errorMessage, goalId: input.goalId, phase: 'reviewer' });
  await commitReviewerInvocationFailure({
    card: input.card,
    blockedReason,
    effects: {
      transitionCard: (cardId, event, details) => input.effects.transitionCard(cardId, event as 'block', details),
      updateCard: (cardId, patch) => input.effects.updateCard(cardId, patch),
    },
  });
  input.effects.finishOpenPlannerRun(input.goalId, 'blocked');
  await input.effects.transitionRuntime('card_terminated', {
    goalId: input.goalId,
    reason: 'reviewer_invocation_failed',
  });
}
