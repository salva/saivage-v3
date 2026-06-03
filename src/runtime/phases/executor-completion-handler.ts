import type { ActivationCompletionOutcome, CardRecord } from '../../schemas/index.js';
import type { ExecutorResult } from '../../contracts/index.js';
import { buildExecutorCompletionPatch, decideExecutorOutcome } from './executor-phase.js';

export interface ExecutorCompletionEffects {
  now(): string;
  transitionCard(cardId: string, event: 'executor_finish' | 'executor_partial_finish', details: Record<string, unknown>): Promise<boolean>;
  readCard(cardId: string): CardRecord | null;
  updateCard(cardId: string, patch: Partial<CardRecord>): Promise<unknown> | unknown;
  appendChildUnwindToolResult(cardId: string, outcome: ActivationCompletionOutcome, summary: string): void;
  emitCardFailed(cardId: string, goalId: string): void;
}

export async function handleExecutorCompletion(input: {
  cardId: string;
  goalId: string;
  execResult: ExecutorResult;
  acceptedAt: string;
  lastSessionId: string | null;
  registrationFailed: boolean;
  registrationError: string | null;
  artifactRegistrationErrors: string[];
  attachmentRegistrationErrors: string[];
  effects: ExecutorCompletionEffects;
}): Promise<{ transitioned: boolean; executedTerminal: boolean; failed: boolean; outcome: ActivationCompletionOutcome | null }> {
  const outcomeDecision = decideExecutorOutcome({ execResult: input.execResult, registrationFailed: input.registrationFailed });
  const transitioned = await input.effects.transitionCard(input.cardId, outcomeDecision.transitionAction, {
    goalId: input.goalId,
    finalStatus: outcomeDecision.finalStatus,
    reason: outcomeDecision.reason,
  });
  if (!transitioned) return { transitioned: false, executedTerminal: false, failed: true, outcome: null };

  const outcome = outcomeDecision.outcome;
  const terminalCompletedAt = outcome === 'done' || outcome === 'failed' ? input.effects.now() : null;
  const latestCard = input.effects.readCard(input.cardId);
  await input.effects.updateCard(
    input.cardId,
    buildExecutorCompletionPatch({
      execResult: input.execResult,
      existingResult: latestCard?.result,
      existingCompletedAt: latestCard?.completed_at,
      acceptedAt: input.acceptedAt,
      lastSessionId: input.lastSessionId,
      terminalCompletedAt,
      registrationFailed: input.registrationFailed,
      registrationError: input.registrationError,
      artifactRegistrationErrors: input.artifactRegistrationErrors,
      attachmentRegistrationErrors: input.attachmentRegistrationErrors,
      parkedForVerification: outcomeDecision.parkedForVerification,
    }),
  );
  input.effects.appendChildUnwindToolResult(
    input.cardId,
    outcome,
    `Terminal card ${input.cardId} finished with outcome ${outcome}.`,
  );
  if (outcome === 'failed') {
    input.effects.emitCardFailed(input.cardId, input.goalId);
    return { transitioned: true, executedTerminal: true, failed: true, outcome };
  }
  return { transitioned: true, executedTerminal: true, failed: false, outcome };
}
