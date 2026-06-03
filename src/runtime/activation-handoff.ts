import type { ActivationCompletionOutcome, CardRecord } from '../schemas/index.js';
import { selectChildGoalActivationOutcome } from './activation-unwind.js';

export interface ChildGoalActivationHandoffEffects {
  dispatchGoal(goalId: string): Promise<void>;
  readCard(cardId: string): Pick<CardRecord, 'status'> | null;
  appendChildUnwindToolResult(childCardId: string, outcome: ActivationCompletionOutcome, summary: string): void;
}

export interface ChildGoalActivationHandoffResult {
  outcome: ActivationCompletionOutcome;
  completedSuccessfully: boolean;
}

export async function deliverChildGoalActivationHandoff(input: {
  childCardId: string;
  effects: ChildGoalActivationHandoffEffects;
}): Promise<ChildGoalActivationHandoffResult> {
  await input.effects.dispatchGoal(input.childCardId);
  const completedCard = input.effects.readCard(input.childCardId);
  const outcome = selectChildGoalActivationOutcome(completedCard);
  input.effects.appendChildUnwindToolResult(
    input.childCardId,
    outcome,
    `Child goal ${input.childCardId} finished with status ${completedCard?.status ?? 'unknown'}.`,
  );
  return { outcome, completedSuccessfully: outcome === 'done' };
}
