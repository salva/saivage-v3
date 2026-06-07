import type { CardRecord } from '../../schemas/index.js';
import type { RuntimeDiagnosticInput } from '../runtime-event-publisher.js';
import { commitExecutorInvocationFailure } from '../terminal-commit/index.js';

export interface ExecutorInvocationFailureEffects {
  publishRuntimeDiagnostic(input: RuntimeDiagnosticInput): void;
  appendError(input: { message: string; cardId: string; goalId: string; phase: 'executor' }): void;
  transitionCard(cardId: string, event: 'fail', details: Record<string, unknown>): Promise<unknown>;
  updateCard(cardId: string, patch: Partial<CardRecord>): Promise<unknown> | unknown;
  appendChildUnwindToolResult(cardId: string, outcome: 'failed', summary: string): void;
  emitCardFailed(cardId: string, goalId: string): void;
  now(): string;
}

export async function handleExecutorInvocationFailure(input: {
  card: CardRecord;
  cardId: string;
  goalId: string;
  error: unknown;
  effects: ExecutorInvocationFailureEffects;
}): Promise<void> {
  const errorMessage = input.error instanceof Error ? input.error.message : String(input.error);
  input.effects.publishRuntimeDiagnostic({ card_id: input.cardId, goal_id: input.goalId, phase: 'executor', error: input.error });
  input.effects.appendError({ message: errorMessage, cardId: input.cardId, goalId: input.goalId, phase: 'executor' });
  await commitExecutorInvocationFailure({
    card: input.card,
    goalId: input.goalId,
    reason: 'executor_exception',
    error: errorMessage,
    at: input.effects.now(),
    effects: {
      transitionCard: (cardId, event, details) => input.effects.transitionCard(cardId, event as 'fail', details),
      updateCard: (cardId, patch) => input.effects.updateCard(cardId, patch),
    },
  });
  input.effects.appendChildUnwindToolResult(input.cardId, 'failed', `Terminal card ${input.cardId} execution failed before producing a result.`);
  input.effects.emitCardFailed(input.cardId, input.goalId);
}
