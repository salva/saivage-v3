import type { CardLifecycleState, CardRecord, PlannerBlockedResult, PlannerDoneResult, PlannerFailureResult } from '../../schemas/index.js';
import { lifecycleCardPatch } from './lifecycle-patch.js';
import type { TerminalCommitEffects, TerminalCommitReceipt } from './commit-executor.js';
import { validateTerminalOverlay } from './validators.js';

export async function commitPlannerDone(input: {
  card: CardRecord;
  summary: string;
  completedAt: string;
  effects: TerminalCommitEffects;
}): Promise<TerminalCommitReceipt<Extract<CardLifecycleState, { status: 'done' }>, PlannerDoneResult>> {
  if (input.card.type === 'project' || input.card.type === 'goal') {
    throw new Error(`Planner done cannot be terminal for parent card type '${input.card.type}'.`);
  }
  const result: PlannerDoneResult = { kind: 'planner_done', summary: input.summary };
  const lifecycle = { status: 'done', result, error: null, completed_at: input.completedAt } satisfies Extract<CardLifecycleState, { status: 'done' }>;
  assertNoTerminalOverlayErrors(input.card, lifecycle);
  const transitioned = await input.effects.transitionCard(input.card.id, 'complete', { summary: input.summary });
  const patch = { ...lifecycleCardPatch(lifecycle), status_text: input.summary };
  await input.effects.updateCard(input.card.id, patch);
  return { lifecycle, result, patch, transitioned: transitioned !== false };
}

export async function commitPlannerBlocked(input: {
  card: CardRecord;
  blockedReason: string;
  resumeReason: string;
  effects: TerminalCommitEffects;
}): Promise<TerminalCommitReceipt<Extract<CardLifecycleState, { status: 'blocked' }>, PlannerBlockedResult>> {
  if (!input.blockedReason.trim()) throw new Error('Cannot commit planner blocked without a non-empty blocked reason.');
  if (!input.resumeReason.trim()) throw new Error('Cannot commit planner blocked without a non-empty resume reason.');
  const result: PlannerBlockedResult = {
    kind: 'planner_blocked',
    blocked_reason: input.blockedReason,
    resume_reason: input.resumeReason,
    blocker_cause: input.resumeReason === 'planner_context_length_exceeded'
      ? 'token_budget_exceeded'
      : input.resumeReason === 'reviewer_unavailable'
          ? 'reviewer_unavailable'
          : input.resumeReason === 'non_actionable_continue' || input.resumeReason === 'non_actionable_project_done'
            ? 'non_actionable_continue'
            : 'generic',
  };
  const lifecycle = { status: 'blocked', result, error: input.blockedReason, completed_at: null } satisfies Extract<CardLifecycleState, { status: 'blocked' }>;
  assertNoTerminalOverlayErrors(input.card, lifecycle);
  const transitioned = await input.effects.transitionCard(input.card.id, 'block', { blocked_reason: input.blockedReason });
  const patch = { ...lifecycleCardPatch(lifecycle), status_text: input.blockedReason };
  await input.effects.updateCard(input.card.id, patch);
  return { lifecycle, result, patch, transitioned: transitioned !== false };
}

export async function commitPlannerFailed(input: {
  card: CardRecord;
  error: string;
  completedAt: string;
  effects: TerminalCommitEffects;
}): Promise<TerminalCommitReceipt<Extract<CardLifecycleState, { status: 'failed' }>, PlannerFailureResult>> {
  if (!input.error.trim()) throw new Error('Cannot commit planner failure without a non-empty error.');
  const result: PlannerFailureResult = { kind: 'planner_failure', error: input.error };
  const lifecycle = { status: 'failed', result, error: input.error, completed_at: input.completedAt } satisfies Extract<CardLifecycleState, { status: 'failed' }>;
  assertNoTerminalOverlayErrors(input.card, lifecycle);
  const transitioned = await input.effects.transitionCard(input.card.id, 'fail', { reason: 'planner_error', error: input.error });
  const patch = { ...lifecycleCardPatch(lifecycle), status_text: `Planner failed: ${input.error}` };
  await input.effects.updateCard(input.card.id, patch);
  return { lifecycle, result, patch, transitioned: transitioned !== false };
}

function assertNoTerminalOverlayErrors(card: CardRecord, lifecycle: CardLifecycleState): void {
  const diagnostics = validateTerminalOverlay(card, lifecycle);
  if (diagnostics.length > 0) throw new Error(`Invalid terminal lifecycle overlay: ${diagnostics.join(' ')}`);
}
