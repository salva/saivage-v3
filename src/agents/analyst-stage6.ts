import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ActiveCardRun, AgentSession, CardRecord, CardStatus, RuntimeStatus } from '../schemas/index.js';
import { CardStore } from '../cards/index.js';
import { appendMessage, findPlannerSessionForCard, getSession, listSessions } from './session-persistence.js';
import { appendNote, getNotes, markNoteHandled } from '../cards/index.js';
import { writeFileAtomic } from '../persistence/index.js';
import { sanitizeAnalystPayload, sanitizeAnalystText } from './analyst-sanitization.js';
import { readRuntimeState } from '../runtime/index.js';

export const analystIssueSchema = z.object({
  summary: z.string().min(1),
  severity: z.enum(['info', 'warning', 'blocker']).optional(),
  evidence_path: z.string().optional(),
}).strict();

export const analystIssuesSchema = z.array(analystIssueSchema);

export type AnalystIssue = z.infer<typeof analystIssueSchema>;

export interface SyntheticPlannerNote {
  id: string;
  target_planner_session_id: string;
  target_goal_card_id: string;
  kind: 'analyst_note' | 'pending_subtree_correction' | 'subtree_changed' | 'reviewer_interrupted';
  affected_card_id: string;
  descendant_card_ids: string[];
  summary: string;
  created_at: string;
}

interface SyntheticQueue { notes: SyntheticPlannerNote[]; }


function saivageDir(projectRoot: string): string { return join(projectRoot, '.saivage'); }
function syntheticQueuePath(projectRoot: string): string { return join(saivageDir(projectRoot), 'runtime', 'synthetic-notes.json'); }
function now(): string { return new Date().toISOString(); }
function readJson<T>(path: string, fallback: T): T { if (!existsSync(path)) return fallback; try { return JSON.parse(readFileSync(path, 'utf-8')) as T; } catch { return fallback; } }
function readSyntheticQueue(projectRoot: string): SyntheticQueue { return readJson<SyntheticQueue>(syntheticQueuePath(projectRoot), { notes: [] }); }
function writeSyntheticQueue(projectRoot: string, queue: SyntheticQueue): void { writeFileAtomic(syntheticQueuePath(projectRoot), JSON.stringify(queue, null, 2) + '\n'); }

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

function contains(store: CardStore, goalId: string, affectedCardId: string): boolean {
  return goalId === affectedCardId || store.getDescendantIds(goalId).includes(affectedCardId);
}

export function findDeepestContainingPlanner(projectRoot: string, store: CardStore, affectedCardId: string): { session: AgentSession; goalId: string } | null {
  const sessions = listSessions(saivageDir(projectRoot))
    .map((id) => getSession(saivageDir(projectRoot), id))
    .filter((session): session is AgentSession => Boolean(session && session.role === 'planner' && session.goal_card_id));
  const candidates = sessions
    .map((session) => ({ session, goalId: session.goal_card_id as string, card: store.read(session.goal_card_id as string) }))
    .filter((entry): entry is { session: AgentSession; goalId: string; card: CardRecord } => Boolean(entry.card && contains(store, entry.goalId, affectedCardId)))
    .sort((a, b) => b.card.depth - a.card.depth);
  if (candidates[0]) return { session: candidates[0].session, goalId: candidates[0].goalId };
  const ancestors = [affectedCardId, ...store.getAncestors(affectedCardId)];
  for (const id of ancestors) {
    const card = store.read(id);
    if (!card || (card.type !== 'goal' && card.type !== 'project')) continue;
    const session = findPlannerSessionForCard(saivageDir(projectRoot), id);
    if (session) return { session, goalId: id };
  }
  return null;
}

export function queueSyntheticPlannerNote(projectRoot: string, input: Omit<SyntheticPlannerNote, 'id' | 'created_at'>): SyntheticPlannerNote | null {
  const queue = readSyntheticQueue(projectRoot);
  const existing = queue.notes.find((note) => note.target_planner_session_id === input.target_planner_session_id && note.kind === input.kind && note.affected_card_id === input.affected_card_id && note.summary === input.summary);
  if (existing) return existing;
  const note: SyntheticPlannerNote = { ...input, id: `synthetic-${Date.now()}-${queue.notes.length + 1}`, created_at: now() };
  queue.notes.push(note);
  writeSyntheticQueue(projectRoot, queue);
  return note;
}

export function drainSyntheticPlannerNotes(projectRoot: string, plannerSessionId: string): SyntheticPlannerNote[] {
  const queue = readSyntheticQueue(projectRoot);
  const drained = queue.notes.filter((note) => note.target_planner_session_id === plannerSessionId);
  if (drained.length === 0) return [];
  queue.notes = queue.notes.filter((note) => note.target_planner_session_id !== plannerSessionId);
  writeSyntheticQueue(projectRoot, queue);
  return drained;
}

export function discardSubtreeChangedSyntheticNotes(projectRoot: string, affectedCardId: string): number {
  const queue = readSyntheticQueue(projectRoot);
  const before = queue.notes.length;
  queue.notes = queue.notes.filter((note) => !(note.kind === 'subtree_changed' && (note.affected_card_id === affectedCardId || note.descendant_card_ids.includes(affectedCardId))));
  writeSyntheticQueue(projectRoot, queue);
  return before - queue.notes.length;
}

export function injectQueuedSyntheticPlannerNotes(projectRoot: string, plannerSessionId: string): number {
  const notes = drainSyntheticPlannerNotes(projectRoot, plannerSessionId);
  if (notes.length === 0) return 0;
  const lines = ['## Synthetic runtime notes since your last turn', '', ...notes.map((note) => `- ${note.kind} for ${note.affected_card_id}: ${note.summary}${note.descendant_card_ids.length ? ` (descendant_card_ids: ${note.descendant_card_ids.join(', ')})` : ''}`)];
  appendMessage(saivageDir(projectRoot), plannerSessionId, { role: 'user', kind: 'text', content: lines.join('\n') });
  return notes.length;
}

export function markGoalNeedsCorrections(projectRoot: string, originGoalId: string, issues: AnalystIssue[], note?: string): { origin_goal_id: string; notes_recorded_on_goal_ids: string[]; status_transition: { from: CardStatus; to: CardStatus } | null } {
  const store = new CardStore(projectRoot);
  const origin = store.read(originGoalId);
  if (!origin || (origin.type !== 'goal' && origin.type !== 'project')) throw new Error(`Goal '${originGoalId}' not found.`);
  const targets = [originGoalId, ...store.getAncestors(originGoalId)].filter((id) => {
    const card = store.read(id);
    return card?.type === 'goal' || card?.type === 'project';
  });
  const summary = issues.map((issue) => issue.summary).join('; ');
  const content = `pending_subtree_correction from ${originGoalId}: ${summary}${note ? `\n${sanitizeAnalystText(note, 1000)}` : ''}`;
  const recorded: string[] = [];
  for (const target of targets) {
    appendNote(saivageDir(projectRoot), target, { author: 'analyst', kind: 'directive', content });
    recorded.push(target);
    const routed = findDeepestContainingPlanner(projectRoot, store, originGoalId);
    if (routed) queueSyntheticPlannerNote(projectRoot, { target_planner_session_id: routed.session.id, target_goal_card_id: routed.goalId, kind: target === originGoalId ? 'pending_subtree_correction' : 'subtree_changed', affected_card_id: originGoalId, descendant_card_ids: target === originGoalId ? [] : [originGoalId], summary });
  }
  let status_transition: { from: CardStatus; to: CardStatus } | null = null;
  if (['done', 'running', 'blocked'].includes(origin.status)) {
    store.update(originGoalId, { status: 'changed' });
    status_transition = { from: origin.status, to: 'changed' };
  }
  return { origin_goal_id: originGoalId, notes_recorded_on_goal_ids: recorded, status_transition };
}

export function markDescendantChanged(projectRoot: string, affectedCardId: string, summary: string): void {
  const store = new CardStore(projectRoot);
  const card = store.read(affectedCardId);
  if (!card) throw new Error(`Card '${affectedCardId}' not found.`);
  if (card.status !== 'changed') store.update(affectedCardId, { status: 'changed' });
  for (const ancestorId of store.getAncestors(affectedCardId)) {
    const ancestor = store.read(ancestorId);
    if (!ancestor || (ancestor.type !== 'goal' && ancestor.type !== 'project')) continue;
    appendNote(saivageDir(projectRoot), ancestorId, { author: 'analyst', kind: 'directive', content: `subtree_changed: ${affectedCardId}: ${sanitizeAnalystText(summary, 1000)}` });
  }
  const routed = findDeepestContainingPlanner(projectRoot, store, affectedCardId);
  if (routed) queueSyntheticPlannerNote(projectRoot, { target_planner_session_id: routed.session.id, target_goal_card_id: routed.goalId, kind: 'subtree_changed', affected_card_id: affectedCardId, descendant_card_ids: [affectedCardId], summary: sanitizeAnalystText(summary, 1000) });
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
  affectedCardId: string,
  summary: string,
  opts: { kind?: SyntheticPlannerNote['kind'] } = {},
): void {
  const store = new CardStore(projectRoot);
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

export function consumeChangedCardActivation(projectRoot: string, cardId: string): number {
  const store = new CardStore(projectRoot);
  const card = store.read(cardId);
  if (card?.status === 'changed') store.update(cardId, { status: 'running' });
  let removedCardNotes = 0;
  for (const card of store.list()) {
    for (const note of getNotes(saivageDir(projectRoot), card.id)) {
      if (!note.handled && note.content.includes('subtree_changed') && note.content.includes(cardId)) {
        markNoteHandled(saivageDir(projectRoot), card.id, note.id);
        removedCardNotes += 1;
      }
    }
  }
  return removedCardNotes;
}

export interface CardBreadcrumbNode { card_id: string; card_type: string; title: string; status_text?: string; }
export interface DormantPlannerRow { goal_card_id: string; planner_session_id: string; latest_self_report: Record<string, unknown> | null; }
export interface PendingCorrectionRow { card_id: string; status: CardStatus; note_count: number; last_note_at: string | null; }
export interface CardRunsResponse { active_card_run: ActiveCardRun | null; active_breadcrumb: CardBreadcrumbNode[]; dormant_planners: DormantPlannerRow[]; cards_with_pending_corrections: PendingCorrectionRow[]; }

export function buildCardRunsResponse(projectRoot: string): CardRunsResponse {
  const store = new CardStore(projectRoot);
  const state = readRuntimeState(projectRoot);
  const active = state?.active_card_run ?? null;
  const active_breadcrumb = active ? [active.card_id, ...store.getAncestors(active.card_id)].reverse().map((id) => {
    const card = store.read(id)!;
    return { card_id: card.id, card_type: card.type, title: card.title, ...(card.status_text ? { status_text: card.status_text } : {}) };
  }) : [];
  const dormant_planners = listSessions(saivageDir(projectRoot))
    .map((id) => getSession(saivageDir(projectRoot), id))
    .filter((session): session is AgentSession => Boolean(session && session.role === 'planner' && session.goal_card_id && session.id !== active?.planner_session_id))
    .map((session) => {
      const card = store.read(session.goal_card_id as string);
      return { goal_card_id: session.goal_card_id as string, planner_session_id: session.id, latest_self_report: (card?.latest_self_report as Record<string, unknown> | null | undefined) ?? null };
    });
  const cards_with_pending_corrections = store.list().map((card) => {
    const notes = getNotes(saivageDir(projectRoot), card.id).filter((note) => !note.handled && (note.content.includes('pending_subtree_correction') || note.content.includes('subtree_changed')));
    return { card, notes };
  }).filter(({ notes }) => notes.length > 0).map(({ card, notes }) => ({ card_id: card.id, status: card.status, note_count: notes.length, last_note_at: notes.map((n) => n.timestamp).sort().at(-1) ?? null }));
  return { active_card_run: active, active_breadcrumb, dormant_planners, cards_with_pending_corrections };
}

export function normalizeRuntimeStatus(status: RuntimeStatus | undefined, paused: boolean | undefined): 'idle' | 'running' | 'paused' {
  if (paused || status === 'paused') return 'paused';
  return status === 'running' ? 'running' : 'idle';
}
