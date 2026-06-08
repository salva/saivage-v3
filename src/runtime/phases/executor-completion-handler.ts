import type { ActivationCompletionOutcome, CardLifecycleState, CardRecord } from '../../schemas/index.js';
import type { ExecutorResult } from '../../contracts/index.js';
import { commitExecutorFailure, commitExecutorParkedVerification, commitExecutorSuccess } from '../terminal-commit/index.js';
import { decideExecutorOutcome } from './executor-phase.js';
import { RuntimeDispatchInvariantError } from '../state.js';

export interface ExecutorCompletionEffects {
  now(): string;
  transitionCard(cardId: string, event: 'executor_finish' | 'executor_partial_finish', details: Record<string, unknown>): Promise<boolean>;
  readCard(cardId: string): CardRecord | null;
  updateCard(cardId: string, patch: Partial<CardRecord>): Promise<unknown> | unknown;
  appendChildUnwindToolResult(cardId: string, outcome: ActivationCompletionOutcome, summary: string): void;
  recordChildActivationLifecycle?(cardId: string, lifecycle: CardLifecycleState): void;
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
  ignoredArtifactRegistrations?: string[];
  ignoredAttachmentRegistrations?: string[];
  effects: ExecutorCompletionEffects;
}): Promise<{ executedTerminal: boolean; failed: boolean; outcome: ActivationCompletionOutcome | null }> {
  const outcomeDecision = decideExecutorOutcome({ execResult: input.execResult, registrationFailed: input.registrationFailed });
  const outcome = outcomeDecision.outcome;
  const latestCard = input.effects.readCard(input.cardId);
  if (!latestCard) throw new RuntimeDispatchInvariantError(`Runtime dispatch invariant violation: executor completion for '${input.cardId}' cannot read current card state.`);
  const commonEffects = {
    transitionCard: (cardId: string, event: string, details: Record<string, unknown>) => input.effects.transitionCard(cardId, event as 'executor_finish' | 'executor_partial_finish', details),
    updateCard: (cardId: string, patch: Partial<CardRecord>) => input.effects.updateCard(cardId, patch),
  };

  const receipt = outcome === 'done'
    ? await commitExecutorSuccess({
        projectRoot: input.projectRoot,
        card: latestCard,
        goalId: input.goalId,
        executor: preservedExecutorResult(latestCard, input.execResult, input),
        generatedFiles: resultGeneratedFiles(input.execResult),
        acceptedAt: input.acceptedAt,
        completedAt: latestCard.lifecycle.completed_at ?? input.effects.now(),
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
           completedAt: latestCard.lifecycle.completed_at ?? input.effects.now(),
          statusText: input.execResult.status_text,
          sessionId: input.lastSessionId,
          transitionReason: outcomeDecision.reason,
          effects: commonEffects,
        })
      : await commitExecutorParkedVerification({
          card: latestCard,
          goalId: input.goalId,
          reason: outcomeDecision.reason ?? input.execResult.summary ?? input.execResult.status_text,
          preservedResult: preservedVerificationResult(latestCard, input.execResult, input),
          fallbackReason: input.execResult.fallback_with_evidence?.reason ?? null,
          acceptedAt: input.acceptedAt,
          statusText: input.execResult.status_text,
          sessionId: input.lastSessionId,
          effects: commonEffects,
        });
  input.effects.recordChildActivationLifecycle?.(input.cardId, receipt.lifecycle);

  if (outcome === 'needs_verification') {
    return { executedTerminal: false, failed: false, outcome };
  }
  input.effects.appendChildUnwindToolResult(
    input.cardId,
    outcome,
    `Terminal card ${input.cardId} finished with outcome ${outcome}.`,
  );
  if (outcome === 'failed') {
    input.effects.emitCardFailed(input.cardId, input.goalId);
    return { executedTerminal: true, failed: true, outcome };
  }
  return { executedTerminal: true, failed: false, outcome };
}

function executorResultPayload(execResult: ExecutorResult): Record<string, unknown> {
  return {
    ...(execResult.result ?? {}),
    executor: execResult.result ?? null,
  };
}

function preservedVerificationResult(card: CardRecord, execResult: ExecutorResult, input: Parameters<typeof handleExecutorCompletion>[0]): Record<string, unknown> {
  return {
    ...recordResult(card.lifecycle.result),
    ...executorResultPayload(execResult),
    ...ignoredEvidenceResult(input),
    fallback_with_evidence: execResult.fallback_with_evidence,
  };
}

function preservedExecutorResult(card: CardRecord, execResult: ExecutorResult, input?: Parameters<typeof handleExecutorCompletion>[0]): Record<string, unknown> {
  return {
    ...recordResult(card.lifecycle.result),
    ...executorResultPayload(execResult),
    ...ignoredEvidenceResult(input),
  };
}

function failedPartialResult(input: Parameters<typeof handleExecutorCompletion>[0]): Record<string, unknown> | null {
  const partial = {
    ...recordResult((input.effects.readCard(input.cardId) ?? input.card).lifecycle.result),
    ...executorResultPayload(input.execResult),
    ...(input.registrationFailed
      ? {
          evidence_registration_failures: {
            artifacts: input.artifactRegistrationErrors,
            attachments: input.attachmentRegistrationErrors,
          },
        }
      : {}),
    ...ignoredEvidenceResult(input),
  };
  return Object.keys(partial).length > 0 ? partial : null;
}

function ignoredEvidenceResult(input?: Pick<Parameters<typeof handleExecutorCompletion>[0], 'ignoredArtifactRegistrations' | 'ignoredAttachmentRegistrations'>): Record<string, unknown> {
  const artifacts = input?.ignoredArtifactRegistrations ?? [];
  const attachments = input?.ignoredAttachmentRegistrations ?? [];
  return artifacts.length > 0 || attachments.length > 0
    ? { evidence_registration_ignored: { artifacts, attachments } }
    : {};
}

function recordResult(result: CardLifecycleState['result']): Record<string, unknown> {
  return result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {};
}

function resultGeneratedFiles(execResult: ExecutorResult): string[] {
  const generatedFiles = execResult.result?.generated_files;
  if (!Array.isArray(generatedFiles)) return [];
  return generatedFiles.filter((file): file is string => typeof file === 'string');
}
