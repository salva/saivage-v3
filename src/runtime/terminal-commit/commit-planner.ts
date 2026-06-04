import type { CardLifecycleState, CardRecord, PlannerBlockedResult, PlannerDoneResult } from '../../schemas/index.js';
import { lifecyclePatch } from './lifecycle-patch.js';
import type { TerminalCommitEffects, TerminalCommitReceipt } from './commit-executor.js';
import { validateTerminalOverlay } from './validators.js';

export async function commitPlannerDone(input: {
  card: CardRecord;
  createdCards: string[];
  updatedCards: string[];
  summary: string;
  completedAt: string;
  effects: TerminalCommitEffects;
}): Promise<TerminalCommitReceipt<Extract<CardLifecycleState, { status: 'done' }>, PlannerDoneResult>> {
  if (input.card.type === 'project' || input.card.type === 'goal') {
    throw new Error(`Planner done cannot be terminal for parent card type '${input.card.type}'.`);
  }
  const result: PlannerDoneResult = { kind: 'planner_done', created_cards: input.createdCards, updated_cards: input.updatedCards, summary: input.summary };
  const lifecycle = { status: 'done', result, error: null, completed_at: input.completedAt } satisfies Extract<CardLifecycleState, { status: 'done' }>;
  assertNoTerminalOverlayErrors(input.card, lifecycle);
  const transitioned = await input.effects.transitionCard(input.card.id, 'complete', { summary: input.summary });
  const patch = { ...lifecyclePatch(lifecycle), result: { ...result, planning: { status: 'done', created_cards: input.createdCards, updated_cards: input.updatedCards, summary: input.summary } }, status_text: input.summary };
  await input.effects.updateCard(input.card.id, patch);
  return { lifecycle, result, patch, transitioned: transitioned !== false };
}

export async function commitPlannerBlocked(input: {
  card: CardRecord;
  blockedReason: string;
  resumeReason: string;
  createdCards: string[];
  updatedCards: string[];
  preservedResult?: CardRecord['result'];
  planning?: Record<string, unknown>;
  effects: TerminalCommitEffects;
}): Promise<TerminalCommitReceipt<Extract<CardLifecycleState, { status: 'blocked' }>, PlannerBlockedResult>> {
  if (!input.blockedReason.trim()) throw new Error('Cannot commit planner blocked without a non-empty blocked reason.');
  if (!input.resumeReason.trim()) throw new Error('Cannot commit planner blocked without a non-empty resume reason.');
  const result: PlannerBlockedResult = { kind: 'planner_blocked', blocked_reason: input.blockedReason, resume_reason: input.resumeReason, created_cards: input.createdCards, updated_cards: input.updatedCards };
  const lifecycle = { status: 'blocked', result, error: input.blockedReason, completed_at: null } satisfies Extract<CardLifecycleState, { status: 'blocked' }>;
  assertNoTerminalOverlayErrors(input.card, lifecycle);
  const transitioned = await input.effects.transitionCard(input.card.id, 'block', { blocked_reason: input.blockedReason });
  const patchResult = input.planning
    ? { ...(input.preservedResult && typeof input.preservedResult === 'object' ? input.preservedResult : {}), planning: input.planning }
    : lifecycle.result;
  const patch = { ...lifecyclePatch(lifecycle), result: patchResult as CardRecord['result'], status_text: input.blockedReason };
  await input.effects.updateCard(input.card.id, patch);
  return { lifecycle, result, patch, transitioned: transitioned !== false };
}

function assertNoTerminalOverlayErrors(card: CardRecord, lifecycle: CardLifecycleState): void {
  const diagnostics = validateTerminalOverlay(card, lifecycle);
  if (diagnostics.length > 0) throw new Error(`Invalid terminal lifecycle overlay: ${diagnostics.join(' ')}`);
}
