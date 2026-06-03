export interface ExecutorInvocationFailureEffects {
  emitRuntimeDiagnostic(input: { card_id: string; goal_id: string; phase: 'executor'; error: unknown }): void;
  appendRuntimeDiagnostic(input: { card_id: string; goal_id: string; phase: 'executor'; error_message: string }): void;
  appendError(input: { message: string; cardId: string; goalId: string; phase: 'executor' }): void;
  transitionCard(cardId: string, event: 'fail', details: Record<string, unknown>): Promise<unknown>;
  appendChildUnwindToolResult(cardId: string, outcome: 'failed', summary: string): void;
  emitCardFailed(cardId: string, goalId: string): void;
}

export async function handleExecutorInvocationFailure(input: {
  cardId: string;
  goalId: string;
  error: unknown;
  effects: ExecutorInvocationFailureEffects;
}): Promise<void> {
  const errorMessage = input.error instanceof Error ? input.error.message : String(input.error);
  input.effects.emitRuntimeDiagnostic({ card_id: input.cardId, goal_id: input.goalId, phase: 'executor', error: input.error });
  input.effects.appendRuntimeDiagnostic({ card_id: input.cardId, goal_id: input.goalId, phase: 'executor', error_message: errorMessage });
  input.effects.appendError({ message: errorMessage, cardId: input.cardId, goalId: input.goalId, phase: 'executor' });
  await input.effects.transitionCard(input.cardId, 'fail', { reason: 'executor_exception', error: errorMessage });
  input.effects.appendChildUnwindToolResult(input.cardId, 'failed', `Terminal card ${input.cardId} execution failed before producing a result.`);
  input.effects.emitCardFailed(input.cardId, input.goalId);
}
