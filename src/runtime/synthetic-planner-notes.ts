import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileSyncDurable } from '../persistence/index.js';
import { appendMessage, findPlannerSessionForCard, getSession, listSessions } from './session-persistence.js';
import type { RoundStamp } from '../contracts/session-stamper.js';
import type { AgentSession, CardRecord } from '../schemas/index.js';
import type { CardStore } from '../cards/store-api.js';

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
function writeSyntheticQueue(projectRoot: string, queue: SyntheticQueue): void { writeFileSyncDurable(syntheticQueuePath(projectRoot), JSON.stringify(queue, null, 2) + '\n'); }

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

export function injectQueuedSyntheticPlannerNotes(projectRoot: string, plannerSessionId: string, sessionStamper: { stampUserMessage(sessionId: string): RoundStamp }): number {
  const queue = readSyntheticQueue(projectRoot);
  const pending = queue.notes.filter((note) => note.target_planner_session_id === plannerSessionId);
  if (pending.length === 0) return 0;
  const lines = ['## Synthetic runtime notes since your last turn', '', ...pending.map((note) => `- ${note.kind} for ${note.affected_card_id}: ${note.summary}${note.descendant_card_ids.length ? ` (descendant_card_ids: ${note.descendant_card_ids.join(', ')})` : ''}`)];
  appendMessage(saivageDir(projectRoot), plannerSessionId, { role: 'user', kind: 'text', content: lines.join('\n') }, sessionStamper.stampUserMessage(plannerSessionId));
  const injectedIds = new Set(pending.map((note) => note.id));
  const after = readSyntheticQueue(projectRoot);
  after.notes = after.notes.filter((note) => !injectedIds.has(note.id));
  writeSyntheticQueue(projectRoot, after);
  return pending.length;
}

export function consumeChangedCardActivation(projectRoot: string, cardId: string): number {
  return discardSubtreeChangedSyntheticNotes(projectRoot, cardId);
}
