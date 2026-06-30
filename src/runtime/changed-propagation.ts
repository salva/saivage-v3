import type { AnalystIssue, CardStatus } from '../schemas/index.js';
import type { CardStore } from '../cards/store-api.js';
import { sanitizeAnalystText } from '../sanitization/analyst-sanitization.js';
import { getActiveGoalNoteSinks } from './actors/active-goal-note-sinks.js';
import { findContainingPlannerChain, queueSyntheticPlannerNote } from './synthetic-planner-notes.js';

const FLIPPABLE_RESTING: ReadonlySet<CardStatus> = new Set(['done', 'failed', 'cancelled', 'blocked']);

export type ChangeOrigin =
  | { kind: 'analyst_edit'; summary: string }
  | { kind: 'analyst_correction'; issues: AnalystIssue[]; note?: string };

export interface ChangedPropagation {
  flipped: Array<{ card_id: string; previous_status: CardStatus }>;
  stopped_at_running: string | null;
  notified_planner_session_ids: string[];
}

interface RoutedPlannerNoteInput {
  target_planner_session_id: string;
  target_goal_card_id: string;
  kind: 'analyst_note' | 'pending_subtree_correction' | 'subtree_changed';
  affected_card_id: string;
  descendant_card_ids: string[];
  summary: string;
  previous_status?: CardStatus;
}

function originSummary(origin: ChangeOrigin): string {
  if (origin.kind === 'analyst_edit') return sanitizeAnalystText(origin.summary, 1000);
  const issueSummary = origin.issues.map((issue) => issue.summary).join('; ');
  return sanitizeAnalystText(`${issueSummary}${origin.note ? `\n${origin.note}` : ''}`, 1000);
}

export function propagateChange(projectRoot: string, store: CardStore, editedCardId: string, origin: ChangeOrigin): ChangedPropagation {
  const edited = store.read(editedCardId);
  if (!edited) throw new Error(`Card '${editedCardId}' not found.`);

  const path = [editedCardId, ...store.getAncestors(editedCardId).reverse()];
  const previousStatusByCardId = new Map<string, CardStatus>();
  const flipped: ChangedPropagation['flipped'] = [];
  let stopped_at_running: string | null = null;

  for (const cardId of path) {
    const card = store.read(cardId);
    if (card) previousStatusByCardId.set(cardId, card.status);
  }

  for (const cardId of path) {
    const card = store.read(cardId);
    if (!card) continue;
    if (card.status === 'running') {
      stopped_at_running = cardId;
      break;
    }
    if (FLIPPABLE_RESTING.has(card.status)) {
      store.setStatus(cardId, 'changed');
      flipped.push({ card_id: cardId, previous_status: card.status });
    }
  }

  const summary = originSummary(origin);
  const notified = new Set<string>();
  const liveNotes = getActiveGoalNoteSinks(projectRoot);
  for (const routed of findContainingPlannerChain(projectRoot, store, editedCardId)) {
    const kind = editedCardId === routed.goalId ? 'analyst_note' : 'subtree_changed';
    queuePlannerNote(projectRoot, liveNotes, {
      target_planner_session_id: routed.sessionId,
      target_goal_card_id: routed.goalId,
      kind,
      affected_card_id: editedCardId,
      descendant_card_ids: editedCardId === routed.goalId ? [] : [editedCardId],
      summary,
      ...(previousStatusByCardId.get(routed.goalId) ? { previous_status: previousStatusByCardId.get(routed.goalId)! } : {}),
    });
    notified.add(routed.sessionId);
  }

  if (origin.kind === 'analyst_correction') {
    const routed = findContainingPlannerChain(projectRoot, store, editedCardId)[0];
    if (routed) {
      queuePlannerNote(projectRoot, liveNotes, {
        target_planner_session_id: routed.sessionId,
        target_goal_card_id: routed.goalId,
        kind: 'pending_subtree_correction',
        affected_card_id: editedCardId,
        descendant_card_ids: [],
        summary,
        ...(previousStatusByCardId.get(routed.goalId) ? { previous_status: previousStatusByCardId.get(routed.goalId)! } : {}),
      });
      notified.add(routed.sessionId);
    }
  }

  return { flipped, stopped_at_running, notified_planner_session_ids: [...notified] };
}

function queuePlannerNote(projectRoot: string, liveNotes: ReturnType<typeof getActiveGoalNoteSinks>, input: RoutedPlannerNoteInput): void {
  const deliveredLive = liveNotes.addNote(input.target_goal_card_id, {
    id: `changed:${input.kind}:${input.target_goal_card_id}:${input.affected_card_id}:${input.summary}`,
    content: JSON.stringify({
      kind: input.kind,
      affected_card_id: input.affected_card_id,
      descendant_card_ids: input.descendant_card_ids,
      summary: input.summary,
      previous_status: input.previous_status ?? null,
    }),
  });
  if (deliveredLive) return;
  queueSyntheticPlannerNote(projectRoot, input);
}
