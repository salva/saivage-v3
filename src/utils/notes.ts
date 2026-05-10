import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { noteRecordSchema } from '../schemas/validators.js';
import type { NoteRecord, NoteAuthor, NoteKind } from '../schemas/types.js';
import { writeFileAtomic } from './file-tree.js';

// ── Queue Schema ──────────────────────────────────────────────

interface NotesQueue {
  entries: Array<{
    card_id: string;
    note_id: string;
    timestamp: string;
    kind: string;
  }>;
}

// ── Helpers ───────────────────────────────────────────────────

function queuePath(saivageDir: string): string {
  return join(saivageDir, 'notes', 'queue.json');
}

function notesFilePath(saivageDir: string, cardId: string): string {
  return join(saivageDir, 'notes', 'by-card', `${cardId}.jsonl`);
}

function readQueue(saivageDir: string): NotesQueue {
  const path = queuePath(saivageDir);
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as NotesQueue;
    // Ensure entries is always an array
    if (!Array.isArray(parsed.entries)) {
      return { entries: [] };
    }
    return parsed;
  }
  return { entries: [] };
}

function writeQueueAtomic(saivageDir: string, queue: NotesQueue): void {
  writeFileAtomic(queuePath(saivageDir), JSON.stringify(queue, null, 2) + '\n');
}

function readAllNoteLines(saivageDir: string, cardId: string): string[] {
  const path = notesFilePath(saivageDir, cardId);
  if (!existsSync(path)) {
    return [];
  }
  const raw = readFileSync(path, 'utf-8');
  if (raw.trim() === '') {
    return [];
  }
  return raw.split('\n').filter((line) => line.trim() !== '');
}

function parseNoteLines(lines: string[]): NoteRecord[] {
  return lines.map((line) => {
    const parsed = noteRecordSchema.parse(JSON.parse(line));
    return parsed;
  });
}

function writeAllNotes(saivageDir: string, cardId: string, notes: NoteRecord[]): void {
  const path = notesFilePath(saivageDir, cardId);
  const content = notes.map((n) => JSON.stringify(n)).join('\n') + (notes.length > 0 ? '\n' : '');
  writeFileAtomic(path, content);
}

function generateNoteId(cardId: string, existingNotes: NoteRecord[]): string {
  const seq = existingNotes.length + 1;
  return `n-${cardId}-${seq}`;
}

function addToQueue(saivageDir: string, note: NoteRecord): void {
  const queue = readQueue(saivageDir);
  queue.entries.push({
    card_id: note.card_id,
    note_id: note.id,
    timestamp: note.timestamp,
    kind: note.kind,
  });
  writeQueueAtomic(saivageDir, queue);
}

function removeFromQueue(saivageDir: string, cardId: string, noteId: string): void {
  const queue = readQueue(saivageDir);
  queue.entries = queue.entries.filter(
    (e) => !(e.card_id === cardId && e.note_id === noteId),
  );
  writeQueueAtomic(saivageDir, queue);
}

function removeAllFromQueue(saivageDir: string, cardId: string): void {
  const queue = readQueue(saivageDir);
  queue.entries = queue.entries.filter((e) => e.card_id !== cardId);
  writeQueueAtomic(saivageDir, queue);
}

// ── Public API ────────────────────────────────────────────────

/**
 * Append a new note to a card's JSONL note log.
 *
 * ID is auto-generated as: n-{cardId}-{sequence} (e.g., n-goal-1-1, n-goal-1-2).
 * Adds entry to notes queue.
 *
 * @returns The created NoteRecord.
 */
export function appendNote(
  saivageDir: string,
  cardId: string,
  note: {
    author: NoteAuthor;
    content: string;
    kind: NoteKind;
  },
): NoteRecord {
  const existing = getAllNotes(saivageDir, cardId);
  const newNote: NoteRecord = {
    id: generateNoteId(cardId, existing),
    card_id: cardId,
    author: note.author,
    timestamp: new Date().toISOString(),
    content: note.content,
    kind: note.kind,
    handled: false,
  };

  // Validate with Zod
  noteRecordSchema.parse(newNote);

  existing.push(newNote);
  writeAllNotes(saivageDir, cardId, existing);
  addToQueue(saivageDir, newNote);
  return newNote;
}

/**
 * Get all notes for a card, in chronological order.
 * Returns empty array if card has no notes.
 */
export function getNotes(saivageDir: string, cardId: string): NoteRecord[] {
  return getAllNotes(saivageDir, cardId);
}

/**
 * Get only unhandled notes for a card.
 */
export function getUnhandledNotes(saivageDir: string, cardId: string): NoteRecord[] {
  return getAllNotes(saivageDir, cardId).filter((n) => !n.handled);
}

/**
 * Get the global queue of unhandled notes across all cards.
 */
export function getUnhandledNotesQueue(
  saivageDir: string,
): Array<{ card_id: string; note_id: string; timestamp: string; kind: string }> {
  return readQueue(saivageDir).entries;
}

/**
 * Mark a note as handled.
 * Sets handled=true, handled_at=now().
 * After this, updateNote and deleteNote will throw.
 * Removes entry from notes queue.
 */
export function markNoteHandled(
  saivageDir: string,
  cardId: string,
  noteId: string,
): NoteRecord {
  const notes = getAllNotes(saivageDir, cardId);
  const idx = notes.findIndex((n) => n.id === noteId);
  if (idx === -1) {
    throw new Error(`Note not found: ${noteId} for card ${cardId}`);
  }

  notes[idx] = {
    ...notes[idx],
    handled: true,
    handled_at: new Date().toISOString(),
  };

  // Validate before writing
  noteRecordSchema.parse(notes[idx]);
  writeAllNotes(saivageDir, cardId, notes);
  removeFromQueue(saivageDir, cardId, noteId);
  return notes[idx];
}

/**
 * Update a note's content and/or kind.
 * Only allowed when handled===false.
 * Throws if note is already handled.
 */
export function updateNote(
  saivageDir: string,
  cardId: string,
  noteId: string,
  changes: { content?: string; kind?: NoteKind },
): NoteRecord {
  const notes = getAllNotes(saivageDir, cardId);
  const idx = notes.findIndex((n) => n.id === noteId);
  if (idx === -1) {
    throw new Error(`Note not found: ${noteId} for card ${cardId}`);
  }

  if (notes[idx].handled) {
    throw new Error(
      `Cannot update handled note: ${noteId}. Notes are immutable after handling.`,
    );
  }

  const updated: NoteRecord = {
    ...notes[idx],
    ...(changes.content !== undefined ? { content: changes.content } : {}),
    ...(changes.kind !== undefined ? { kind: changes.kind } : {}),
  };

  // Validate before writing
  noteRecordSchema.parse(updated);

  notes[idx] = updated;
  writeAllNotes(saivageDir, cardId, notes);

  // Update the queue entry's kind if kind changed
  if (changes.kind !== undefined) {
    const queue = readQueue(saivageDir);
    const qIdx = queue.entries.findIndex(
      (e) => e.card_id === cardId && e.note_id === noteId,
    );
    if (qIdx !== -1) {
      queue.entries[qIdx].kind = changes.kind;
      writeQueueAtomic(saivageDir, queue);
    }
  }

  return updated;
}

/**
 * Delete a note.
 * Only allowed when handled===false.
 * Throws if note is already handled.
 */
export function deleteNote(saivageDir: string, cardId: string, noteId: string): void {
  const notes = getAllNotes(saivageDir, cardId);
  const idx = notes.findIndex((n) => n.id === noteId);
  if (idx === -1) {
    throw new Error(`Note not found: ${noteId} for card ${cardId}`);
  }

  if (notes[idx].handled) {
    throw new Error(
      `Cannot delete handled note: ${noteId}. Notes are immutable after handling.`,
    );
  }

  notes.splice(idx, 1);
  writeAllNotes(saivageDir, cardId, notes);
  removeFromQueue(saivageDir, cardId, noteId);
}

/**
 * Delete all notes for a card (used when deleting a card).
 * Silently succeeds if note file doesn't exist.
 * Also removes all entries for this card from the queue.
 */
export function deleteAllNotes(saivageDir: string, cardId: string): void {
  const path = notesFilePath(saivageDir, cardId);
  if (existsSync(path)) {
    unlinkSync(path);
  }
  removeAllFromQueue(saivageDir, cardId);
}

// ── Internal Helper ───────────────────────────────────────────

function getAllNotes(saivageDir: string, cardId: string): NoteRecord[] {
  const lines = readAllNoteLines(saivageDir, cardId);
  return parseNoteLines(lines);
}
