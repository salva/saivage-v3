import type { CardLifecycleState, CardRecord, ExecutorFailureResult, ExecutorNeedsVerificationResult, ExecutorSuccessResult, SelfReport } from '../../schemas/index.js';
import { lifecyclePatch } from './lifecycle-patch.js';
import { generatedFileValidationErrors, validateGeneratedFiles, validateTerminalOverlay } from './validators.js';

export interface TerminalCommitEffects {
  transitionCard(cardId: string, event: string, details: Record<string, unknown>): Promise<boolean | unknown> | boolean | unknown;
  updateCard(cardId: string, patch: Partial<CardRecord>): Promise<unknown> | unknown;
}

export interface TerminalCommitReceipt<TLifecycle extends CardLifecycleState, TResult> {
  lifecycle: TLifecycle;
  result: TResult;
  patch: Partial<CardRecord>;
  transitioned: boolean;
}

export async function commitExecutorSuccess(input: {
  projectRoot: string;
  card: CardRecord;
  goalId: string;
  executor: Record<string, unknown>;
  generatedFiles: string[];
  acceptedAt: string;
  completedAt: string;
  summary: string;
  statusText: string;
  sessionId: string | null;
  warnings?: string[];
  effects: TerminalCommitEffects;
}): Promise<TerminalCommitReceipt<Extract<CardLifecycleState, { status: 'done' }>, ExecutorSuccessResult>> {
  const validation = validateGeneratedFiles(input.projectRoot, input.generatedFiles);
  const fileErrors = generatedFileValidationErrors(validation);
  if (fileErrors.length > 0) throw new Error(`Cannot commit executor success with invalid generated files: ${fileErrors.join(' ')}`);

  const latestSelfReport = selfReport('done', input.summary, input.statusText, input.acceptedAt);
  const result: ExecutorSuccessResult = {
    kind: 'executor_success',
    executor: input.executor,
    generated_files: validation.valid,
    verified_at: input.acceptedAt,
    latest_self_report: latestSelfReport,
    warnings: input.warnings ?? [],
  };
  const lifecycle = { status: 'done', result, error: null, completed_at: input.completedAt } satisfies Extract<CardLifecycleState, { status: 'done' }>;
  assertNoTerminalOverlayErrors(input.card, lifecycle);
  const transitioned = await input.effects.transitionCard(input.card.id, 'executor_finish', { goalId: input.goalId, finalStatus: 'done' });
  const patch: Partial<CardRecord> = { ...lifecyclePatch(lifecycle), status_text: input.statusText, status_text_updated_at: input.acceptedAt, status_text_author_session_id: input.sessionId, latest_self_report: latestSelfReport as unknown as Record<string, unknown> };
  await input.effects.updateCard(input.card.id, patch);
  return { lifecycle, result, patch, transitioned: transitioned !== false };
}

export async function commitExecutorFailure(input: {
  card: CardRecord;
  goalId: string;
  error: string;
  partialResult: Record<string, unknown> | null;
  acceptedAt: string;
  completedAt: string;
  statusText: string;
  effects: TerminalCommitEffects;
}): Promise<TerminalCommitReceipt<Extract<CardLifecycleState, { status: 'failed' }>, ExecutorFailureResult>> {
  if (!input.error.trim()) throw new Error('Cannot commit executor failure without a non-empty error.');
  const latestSelfReport = selfReport('failed', input.error, input.statusText, input.acceptedAt);
  const result: ExecutorFailureResult = { kind: 'executor_failure', error: input.error, partial_result: input.partialResult, latest_self_report: latestSelfReport };
  const lifecycle = { status: 'failed', result, error: input.error, completed_at: input.completedAt } satisfies Extract<CardLifecycleState, { status: 'failed' }>;
  assertNoTerminalOverlayErrors(input.card, lifecycle);
  const transitioned = await input.effects.transitionCard(input.card.id, 'executor_finish', { goalId: input.goalId, finalStatus: 'failed' });
  const patch: Partial<CardRecord> = { ...lifecyclePatch(lifecycle), status_text: input.statusText, status_text_updated_at: input.acceptedAt, latest_self_report: latestSelfReport as unknown as Record<string, unknown> };
  await input.effects.updateCard(input.card.id, patch);
  return { lifecycle, result, patch, transitioned: transitioned !== false };
}

export async function commitExecutorParkedVerification(input: {
  card: CardRecord;
  goalId: string;
  reason: string;
  preservedResult: Record<string, unknown>;
  fallbackReason: string | null;
  acceptedAt: string;
  statusText: string;
  effects: TerminalCommitEffects;
}): Promise<TerminalCommitReceipt<Extract<CardLifecycleState, { status: 'needs_verification' }>, ExecutorNeedsVerificationResult>> {
  if (!input.reason.trim()) throw new Error('Cannot park executor for verification without a non-empty reason.');
  const latestSelfReport = selfReport('needs_verification', input.reason, input.statusText, input.acceptedAt);
  const result: ExecutorNeedsVerificationResult = { kind: 'executor_needs_verification', reason: input.reason, preserved_result: input.preservedResult, fallback_reason: input.fallbackReason, latest_self_report: latestSelfReport };
  const lifecycle = { status: 'needs_verification', result, error: null, completed_at: null } satisfies Extract<CardLifecycleState, { status: 'needs_verification' }>;
  assertNoTerminalOverlayErrors(input.card, lifecycle);
  const transitioned = await input.effects.transitionCard(input.card.id, 'executor_partial_finish', { goalId: input.goalId, finalStatus: 'needs_verification', reason: input.reason });
  const patch: Partial<CardRecord> = { ...lifecyclePatch(lifecycle), status_text: input.statusText, status_text_updated_at: input.acceptedAt, latest_self_report: latestSelfReport as unknown as Record<string, unknown> };
  await input.effects.updateCard(input.card.id, patch);
  return { lifecycle, result, patch, transitioned: transitioned !== false };
}

function selfReport(result: string, summary: string, statusText: string, at: string): SelfReport {
  return { result, outcome: result, summary, status_text: statusText, at };
}

function assertNoTerminalOverlayErrors(card: CardRecord, lifecycle: CardLifecycleState): void {
  const diagnostics = validateTerminalOverlay(card, lifecycle);
  if (diagnostics.length > 0) throw new Error(`Invalid terminal lifecycle overlay: ${diagnostics.join(' ')}`);
}
