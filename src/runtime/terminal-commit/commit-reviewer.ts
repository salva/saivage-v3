import type { CardLifecycleState, CardRecord, PlannerBlockedResult, PlannerDoneResult, ReviewerPassResult } from '../../schemas/index.js';
import { lifecycleCardPatch } from './lifecycle-patch.js';
import type { TerminalCommitEffects, TerminalCommitReceipt } from './commit-executor.js';
import { validateTerminalOverlay } from './validators.js';

export async function commitReviewerPass(input: {
  card: CardRecord;
  planning: PlannerDoneResult | PlannerBlockedResult | null | undefined;
  reviewSummary: string;
  assessmentId: string;
  completedAt: string;
  transitionDetails?: Record<string, unknown>;
  effects: TerminalCommitEffects;
}): Promise<TerminalCommitReceipt<Extract<CardLifecycleState, { status: 'done' }>, ReviewerPassResult>> {
  if (!input.planning) throw new Error(`Cannot commit reviewer pass for card '${input.card.id}' without typed planner lifecycle context.`);
  const result: ReviewerPassResult = { kind: 'reviewer_pass', planning: input.planning, review_summary: input.reviewSummary, assessment_id: input.assessmentId };
  const lifecycle = { status: 'done', result, error: null, completed_at: input.completedAt } satisfies Extract<CardLifecycleState, { status: 'done' }>;
  assertNoTerminalOverlayErrors(input.card, lifecycle);
  if (input.card.status !== 'done') {
    await input.effects.transitionCard(input.card.id, 'complete', input.transitionDetails ?? { assessment_id: input.assessmentId });
  }
  const patch = { ...lifecycleCardPatch(lifecycle), status_text: input.reviewSummary };
  await input.effects.updateCard(input.card.id, patch);
  return { lifecycle, result, patch };
}

export async function commitReviewerInvocationFailure(input: {
  card: CardRecord;
  blockedReason: string;
  effects: TerminalCommitEffects;
}): Promise<TerminalCommitReceipt<Extract<CardLifecycleState, { status: 'blocked' }>, PlannerBlockedResult>> {
  const result: PlannerBlockedResult = {
    kind: 'planner_blocked',
    blocked_reason: input.blockedReason,
    resume_reason: 'reviewer_unavailable',
    blocker_cause: 'reviewer_unavailable',
  };
  const lifecycle = {
    status: 'blocked',
    error: input.blockedReason,
    completed_at: null,
    result,
  } satisfies Extract<CardLifecycleState, { status: 'blocked' }>;
  assertNoTerminalOverlayErrors(input.card, lifecycle);
  if (input.card.status !== 'blocked') {
    await input.effects.transitionCard(input.card.id, 'block', { blocked_reason: input.blockedReason });
  }
  const patch: Partial<CardRecord> = { ...lifecycleCardPatch(lifecycle), status_text: input.blockedReason };
  await input.effects.updateCard(input.card.id, patch);
  return { lifecycle, result, patch };
}

function assertNoTerminalOverlayErrors(card: CardRecord, lifecycle: CardLifecycleState): void {
  const diagnostics = validateTerminalOverlay(card, lifecycle);
  if (diagnostics.length > 0) throw new Error(`Invalid terminal lifecycle overlay: ${diagnostics.join(' ')}`);
}
