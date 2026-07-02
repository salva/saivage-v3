import type { RuntimeState } from '../schemas/index.js';

export type GoalResumeReason =
  | 'initial'
  | 'reviewer_rework'
  | 'analyst_directive'
  | 'subtree_changed'
  | 'service_restart';

export function inferGoalResumeReason(input: {
  goalId: string;
  fallback?: GoalResumeReason;
  activeRun: RuntimeState['active_card_run'] | null | undefined;
  notes: ReadonlyArray<{ kind?: unknown }>;
}): GoalResumeReason {
  const { goalId, activeRun, notes } = input;
  const fallback = input.fallback ?? 'initial';
  if (fallback === 'service_restart' && activeRun?.card_id === goalId && activeRun.phase === 'planner') {
    return 'service_restart';
  }
  if (notes.some((note) => note.kind === 'reviewer_interrupted')) return 'service_restart';
  if (notes.some((note) => note.kind === 'pending_subtree_correction')) return 'analyst_directive';
  if (notes.some((note) => note.kind === 'subtree_changed')) return 'subtree_changed';
  return fallback;
}
