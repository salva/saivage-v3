import { z } from 'zod';
import type { CardStatus, RuntimeStatus } from '../schemas/index.js';
import type { CardStore } from '../cards/store-api.js';
import { sanitizeAnalystPayload, sanitizeAnalystText } from './analyst-sanitization.js';
import { readRuntimeState } from '../runtime/state-api.js';
import { consumeChangedCardActivation, discardSubtreeChangedSyntheticNotes, drainSyntheticPlannerNotes, findDeepestContainingPlanner, injectQueuedSyntheticPlannerNotes, queueSyntheticPlannerNote, type SyntheticPlannerNote } from '../runtime/synthetic-planner-notes.js';

export const analystIssueSchema = z.object({
  summary: z.string().min(1),
  severity: z.enum(['info', 'warning', 'blocker']).optional(),
  evidence_path: z.string().optional(),
}).strict();

export const analystIssuesSchema = z.array(analystIssueSchema);

export type AnalystIssue = z.infer<typeof analystIssueSchema>;

export function normalizeAnalystIssues(input: unknown): AnalystIssue[] {
  const parsed = analystIssuesSchema.parse(input);
  return parsed.map((issue) => sanitizeAnalystPayload(issue, 1000) as AnalystIssue);
}

export function runtimeStatusForApi(projectRoot: string): 'idle' | 'running' | 'paused' {
  const state = readRuntimeState(projectRoot);
  if (state?.paused || state?.status === 'paused') return 'paused';
  if (state?.status === 'running') return 'running';
  return 'idle';
}

export { consumeChangedCardActivation, discardSubtreeChangedSyntheticNotes, drainSyntheticPlannerNotes, findDeepestContainingPlanner, injectQueuedSyntheticPlannerNotes, queueSyntheticPlannerNote };

export function markGoalNeedsCorrections(projectRoot: string, store: CardStore, originGoalId: string, issues: AnalystIssue[], note?: string): { origin_goal_id: string; notes_recorded_on_goal_ids: string[]; status_transition: { from: CardStatus; to: CardStatus } | null } {
  const origin = store.read(originGoalId);
  if (!origin || (origin.type !== 'goal' && origin.type !== 'project')) throw new Error(`Goal '${originGoalId}' not found.`);
  const summary = issues.map((issue) => issue.summary).join('; ');
  const routed = findDeepestContainingPlanner(projectRoot, store, originGoalId);
  if (routed) queueSyntheticPlannerNote(projectRoot, { target_planner_session_id: routed.session.id, target_goal_card_id: routed.goalId, kind: 'pending_subtree_correction', affected_card_id: originGoalId, descendant_card_ids: [], summary: `${summary}${note ? `
${sanitizeAnalystText(note, 1000)}` : ''}` });
  let status_transition: { from: CardStatus; to: CardStatus } | null = null;
  if (markCardChangedForAnalystCorrection(store, originGoalId, origin.status)) {
    status_transition = { from: origin.status, to: 'changed' };
  }
  return { origin_goal_id: originGoalId, notes_recorded_on_goal_ids: [], status_transition };
}

export function markDescendantChanged(projectRoot: string, store: CardStore, affectedCardId: string, summary: string): void {
  const card = store.read(affectedCardId);
  if (!card) throw new Error(`Card '${affectedCardId}' not found.`);
  markCardChangedForAnalystCorrection(store, affectedCardId, card.status);
  const routed = findDeepestContainingPlanner(projectRoot, store, affectedCardId);
  if (routed) queueSyntheticPlannerNote(projectRoot, { target_planner_session_id: routed.session.id, target_goal_card_id: routed.goalId, kind: 'subtree_changed', affected_card_id: affectedCardId, descendant_card_ids: [affectedCardId], summary: sanitizeAnalystText(summary, 1000) });
}

function markCardChangedForAnalystCorrection(store: CardStore, cardId: string, status: CardStatus): boolean {
  if (status === 'changed') return false;
  if (status === 'running' || status === 'blocked') {
    store.setStatus(cardId, 'changed');
    return true;
  }
  if (status === 'done') {
    // Analyst correction invalidates an accepted terminal result; this is an explicit repair escape hatch.
    store.repairTerminalLifecycle(cardId, {
      status: 'changed',
      lifecycle: { status: 'changed', result: null, error: null, completed_at: null },
    });
    return true;
  }
  return false;
}

/**
 * Notify any running/dormant planner that the analyst has acted on a card it
 * owns, so the planner can resume and integrate the change on its next turn.
 *
 * This is the minimal wakeup signal for two kinds of analyst actions that
 * otherwise would be invisible to the planner until something else happened:
 *   - analyst-authored correction/directive updates on a goal/project card
 *   - `edit_card` that mutates tracked fields (title, description, acceptance,
 *     depends_on, etc.) on any card under a planner subtree
 *
 */
export function notifyPlannerOfAnalystAction(
  projectRoot: string,
  store: CardStore,
  affectedCardId: string,
  summary: string,
  opts: { kind?: SyntheticPlannerNote['kind'] } = {},
): void {
  const card = store.read(affectedCardId);
  if (!card) return;
  const routed = findDeepestContainingPlanner(projectRoot, store, affectedCardId);
  if (routed) {
    queueSyntheticPlannerNote(projectRoot, {
      target_planner_session_id: routed.session.id,
      target_goal_card_id: routed.goalId,
      kind: opts.kind ?? (affectedCardId === routed.goalId ? 'analyst_note' : 'subtree_changed'),
      affected_card_id: affectedCardId,
      descendant_card_ids: affectedCardId === routed.goalId ? [] : [affectedCardId],
      summary: sanitizeAnalystText(summary, 1000),
    });
  }
}

export function normalizeRuntimeStatus(status: RuntimeStatus | undefined, paused: boolean | undefined): 'idle' | 'running' | 'paused' {
  if (paused || status === 'paused') return 'paused';
  return status === 'running' ? 'running' : 'idle';
}
