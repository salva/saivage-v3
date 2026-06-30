import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileSyncDurable } from '../persistence/index.js';
import { listConversationSessionIds } from './actors/conversation-store.js';
import type { AgentSession, CardRecord, CardStatus } from '../schemas/index.js';
import type { CardStore } from '../cards/store-api.js';
import { now } from '../utils/clock.js';

export interface SyntheticPlannerNote {
  id: string;
  target_planner_session_id: string;
  target_goal_card_id: string;
  kind: 'analyst_note' | 'pending_subtree_correction' | 'subtree_changed' | 'reviewer_interrupted';
  affected_card_id: string;
  descendant_card_ids: string[];
  summary: string;
  previous_status?: CardStatus;
  created_at: string;
}

interface SyntheticQueue { notes: SyntheticPlannerNote[]; }

function saivageDir(projectRoot: string): string { return join(projectRoot, '.saivage'); }
function syntheticQueuePath(projectRoot: string): string { return join(saivageDir(projectRoot), 'runtime', 'synthetic-notes.json'); }
function readJson<T>(path: string, fallback: T): T { if (!existsSync(path)) return fallback; try { return JSON.parse(readFileSync(path, 'utf-8')) as T; } catch { return fallback; } }
function readSyntheticQueue(projectRoot: string): SyntheticQueue { return readJson<SyntheticQueue>(syntheticQueuePath(projectRoot), { notes: [] }); }
function writeSyntheticQueue(projectRoot: string, queue: SyntheticQueue): void { writeFileSyncDurable(syntheticQueuePath(projectRoot), JSON.stringify(queue, null, 2) + '\n'); }

function contains(store: CardStore, goalId: string, affectedCardId: string): boolean {
  return goalId === affectedCardId || store.getDescendantIds(goalId).includes(affectedCardId);
}

function plannerSessionForGoal(goalId: string): AgentSession {
  return { id: `planner:${goalId}`, role: 'planner', goal_card_id: goalId, card_id: goalId, status: 'active', started_at: new Date(0).toISOString() };
}

function plannerGoalFromSessionId(sessionId: string): string | null {
  return sessionId.startsWith('planner:') ? sessionId.slice('planner:'.length) : null;
}

export function findContainingPlannerChain(projectRoot: string, store: CardStore, affectedCardId: string): Array<{ session: AgentSession; goalId: string }> {
  const sessions = listConversationSessionIds(projectRoot)
    .map((id) => plannerGoalFromSessionId(id))
    .filter((goalId): goalId is string => Boolean(goalId))
    .map(plannerSessionForGoal);
  const candidates = sessions
    .map((session) => ({ session, goalId: session.goal_card_id as string, card: store.read(session.goal_card_id as string) }))
    .filter((entry): entry is { session: AgentSession; goalId: string; card: CardRecord } => Boolean(entry.card && contains(store, entry.goalId, affectedCardId)))
    .sort((a, b) => b.card.depth - a.card.depth);
  if (candidates.length > 0) return candidates.map(({ session, goalId }) => ({ session, goalId }));
  const ancestors = [affectedCardId, ...store.getAncestors(affectedCardId).reverse()];
  const chain: Array<{ session: AgentSession; goalId: string }> = [];
  for (const id of ancestors) {
    const card = store.read(id);
    if (!card || (card.type !== 'goal' && card.type !== 'project')) continue;
    const sessionId = `planner:${id}`;
    if (listConversationSessionIds(projectRoot).includes(sessionId)) chain.push({ session: plannerSessionForGoal(id), goalId: id });
  }
  return chain;
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

export function peekSyntheticPlannerNotes(projectRoot: string, plannerSessionId: string): SyntheticPlannerNote[] {
  return readSyntheticQueue(projectRoot).notes.filter((note) => note.target_planner_session_id === plannerSessionId);
}

export function discardSubtreeChangedSyntheticNotes(projectRoot: string, affectedCardId: string): number {
  const queue = readSyntheticQueue(projectRoot);
  const before = queue.notes.length;
  queue.notes = queue.notes.filter((note) => !(note.kind === 'subtree_changed' && (note.affected_card_id === affectedCardId || note.descendant_card_ids.includes(affectedCardId))));
  writeSyntheticQueue(projectRoot, queue);
  return before - queue.notes.length;
}

export function consumeChangedCardActivation(projectRoot: string, cardId: string): number {
  return discardSubtreeChangedSyntheticNotes(projectRoot, cardId);
}
