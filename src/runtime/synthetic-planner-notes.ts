import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CardStatus } from '../schemas/index.js';
import { CardStore } from '../cards/store-api.js';
import { writeFileAtomic } from '../persistence/index.js';
import { appendMessage } from './session-persistence.js';
import type { RoundStamp } from '../contracts/session-stamper.js';

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

export function injectQueuedSyntheticPlannerNotes(projectRoot: string, plannerSessionId: string, activeRuntime: { stampUserMessage(sessionId: string): RoundStamp }): number {
  const notes = drainSyntheticPlannerNotes(projectRoot, plannerSessionId);
  if (notes.length === 0) return 0;
  const lines = ['## Synthetic runtime notes since your last turn', '', ...notes.map((note) => `- ${note.kind} for ${note.affected_card_id}: ${note.summary}${note.descendant_card_ids.length ? ` (descendant_card_ids: ${note.descendant_card_ids.join(', ')})` : ''}`)];
  appendMessage(saivageDir(projectRoot), plannerSessionId, { role: 'user', kind: 'text', content: lines.join('\n') }, activeRuntime.stampUserMessage(plannerSessionId));
  return notes.length;
}

export function consumeChangedCardActivation(projectRoot: string, cardId: string): number {
  const store = new CardStore(projectRoot);
  const card = store.read(cardId);
  if (card?.status === 'changed') store.update(cardId, { status: 'running' as CardStatus });
  return discardSubtreeChangedSyntheticNotes(projectRoot, cardId);
}
