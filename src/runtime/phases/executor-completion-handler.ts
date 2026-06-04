import type { ActivationCompletionOutcome, CardRecord } from '../../schemas/index.js';
import type { ExecutorResult } from '../../contracts/index.js';
import { commitExecutorFailure, commitExecutorParkedVerification, commitExecutorSuccess } from '../terminal-commit/index.js';
import { decideExecutorOutcome } from './executor-phase.js';

export interface ExecutorCompletionEffects {
  now(): string;
  transitionCard(cardId: string, event: 'executor_finish' | 'executor_partial_finish', details: Record<string, unknown>): Promise<boolean>;
  readCard(cardId: string): CardRecord | null;
  updateCard(cardId: string, patch: Partial<CardRecord>): Promise<unknown> | unknown;
  appendChildUnwindToolResult(cardId: string, outcome: ActivationCompletionOutcome, summary: string): void;
  emitCardFailed(cardId: string, goalId: string): void;
}

export async function handleExecutorCompletion(input: {
  projectRoot: string;
  card: CardRecord;
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
  const outcome = outcomeDecision.outcome;
  const latestCard = input.effects.readCard(input.cardId) ?? input.card;
  const commonEffects = {
    transitionCard: (cardId: string, event: string, details: Record<string, unknown>) => input.effects.transitionCard(cardId, event as 'executor_finish' | 'executor_partial_finish', details),
    updateCard: (cardId: string, patch: Partial<CardRecord>) => input.effects.updateCard(cardId, patch),
  };

  const receipt = outcome === 'done'
    ? await commitExecutorSuccess({
        projectRoot: input.projectRoot,
        card: latestCard,
        goalId: input.goalId,
        executor: preservedExecutorResult(latestCard, input.execResult),
        generatedFiles: resultGeneratedFiles(input.execResult),
        acceptedAt: input.acceptedAt,
        completedAt: latestCard.completed_at ?? input.effects.now(),
        summary: input.execResult.summary ?? input.execResult.status_text,
        statusText: input.execResult.status_text,
        sessionId: input.lastSessionId,
        effects: commonEffects,
      })
    : outcome === 'failed'
      ? await commitExecutorFailure({
          card: latestCard,
          goalId: input.goalId,
          error: input.registrationError ?? input.execResult.error ?? input.execResult.summary ?? input.execResult.status_text,
          partialResult: failedPartialResult(input),
          acceptedAt: input.acceptedAt,
          completedAt: latestCard.completed_at ?? input.effects.now(),
          statusText: input.execResult.status_text,
          sessionId: input.lastSessionId,
          transitionReason: outcomeDecision.reason,
          effects: commonEffects,
        })
      : await commitExecutorParkedVerification({
          card: latestCard,
          goalId: input.goalId,
          reason: outcomeDecision.reason ?? input.execResult.summary ?? input.execResult.status_text,
          preservedResult: preservedVerificationResult(latestCard, input.execResult),
          fallbackReason: input.execResult.fallback_with_evidence?.reason ?? null,
          acceptedAt: input.acceptedAt,
          statusText: input.execResult.status_text,
          sessionId: input.lastSessionId,
          effects: commonEffects,
        });
  if (!receipt.transitioned) return { transitioned: false, executedTerminal: false, failed: true, outcome: null };

  if (outcome === 'needs_verification') {
    return { transitioned: true, executedTerminal: false, failed: false, outcome };
  }
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

function executorResultPayload(execResult: ExecutorResult): Record<string, unknown> {
  return {
    ...(execResult.result ?? {}),
    executor: execResult.result ?? null,
  };
}

function preservedVerificationResult(card: CardRecord, execResult: ExecutorResult): Record<string, unknown> {
  return {
    ...recordResult(card.result),
    ...executorResultPayload(execResult),
    fallback_with_evidence: execResult.fallback_with_evidence,
  };
}

function preservedExecutorResult(card: CardRecord, execResult: ExecutorResult): Record<string, unknown> {
  return {
    ...recordResult(card.result),
    ...executorResultPayload(execResult),
  };
}

function failedPartialResult(input: Parameters<typeof handleExecutorCompletion>[0]): Record<string, unknown> | null {
  const partial = {
    ...recordResult((input.effects.readCard(input.cardId) ?? input.card).result),
    ...executorResultPayload(input.execResult),
    ...(input.registrationFailed
      ? {
          evidence_registration_failures: {
            artifacts: input.artifactRegistrationErrors,
            attachments: input.attachmentRegistrationErrors,
          },
        }
      : {}),
  };
  return Object.keys(partial).length > 0 ? partial : null;
}

function recordResult(result: CardRecord['result']): Record<string, unknown> {
  return result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {};
}

function resultGeneratedFiles(execResult: ExecutorResult): string[] {
  const generatedFiles = execResult.result?.generated_files;
  if (!Array.isArray(generatedFiles)) return [];
  return generatedFiles.filter((file): file is string => typeof file === 'string');
}
