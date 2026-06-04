import type { CardLifecycleState, CardRecord, PlannerBlockedResult, PlannerDoneResult, ReviewerCorrectionResult, ReviewerPassResult } from '../../schemas/index.js';
import { lifecyclePatch } from './lifecycle-patch.js';
import type { TerminalCommitEffects, TerminalCommitReceipt } from './commit-executor.js';
import { validateTerminalOverlay } from './validators.js';

export async function commitReviewerPass(input: {
  card: CardRecord;
  planning: PlannerDoneResult | PlannerBlockedResult;
  reviewSummary: string;
  assessmentId: string;
  completedAt: string;
  effects: TerminalCommitEffects;
}): Promise<TerminalCommitReceipt<Extract<CardLifecycleState, { status: 'done' }>, ReviewerPassResult>> {
  const result: ReviewerPassResult = { kind: 'reviewer_pass', planning: input.planning, review_summary: input.reviewSummary, assessment_id: input.assessmentId };
  const lifecycle = { status: 'done', result, error: null, completed_at: input.completedAt } satisfies Extract<CardLifecycleState, { status: 'done' }>;
  assertNoTerminalOverlayErrors(input.card, lifecycle);
  const transitioned = input.card.status === 'done'
    ? true
    : await input.effects.transitionCard(input.card.id, 'complete', { assessment_id: input.assessmentId });
  const patch = { ...lifecyclePatch(lifecycle), status_text: input.reviewSummary };
  await input.effects.updateCard(input.card.id, patch);
  return { lifecycle, result, patch, transitioned: transitioned !== false };
}

export async function commitReviewerCorrection(input: {
  card: CardRecord;
  issues: Array<Record<string, unknown>>;
  summary: string;
  assessmentId: string;
  effects?: Pick<TerminalCommitEffects, 'transitionCard'>;
}): Promise<{ result: ReviewerCorrectionResult; transitioned: boolean }> {
  const result: ReviewerCorrectionResult = { kind: 'reviewer_correction', issues: input.issues, summary: input.summary, assessment_id: input.assessmentId };
  const transitioned = input.effects
    ? await input.effects.transitionCard(input.card.id, 'reviewer_repair_resume', { assessment_id: input.assessmentId })
    : true;
  return { result, transitioned: transitioned !== false };
}

function assertNoTerminalOverlayErrors(card: CardRecord, lifecycle: CardLifecycleState): void {
  const diagnostics = validateTerminalOverlay(card, lifecycle);
  if (diagnostics.length > 0) throw new Error(`Invalid terminal lifecycle overlay: ${diagnostics.join(' ')}`);
}
