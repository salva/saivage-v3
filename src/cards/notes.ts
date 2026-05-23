import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { noteRecordSchema, notesQueueEntrySchema, notesQueueSchema } from '../schemas/validators.js';
import type {
  NoteRecord,
  NoteAuthor,
  NoteKind,
  NotesQueue,
  NotesQueueEntry,
  NotesQueueResolvedEntry,
} from '../schemas/types.js';
import { writeFileAtomic } from '../persistence/file-tree.js';
import { enqueueNoteNotifications } from '../notifications/notification-triggers.js';

function queuePath(saivageDir: string): string {
  return join(saivageDir, 'notes', 'queue.json');
}

function notesFilePath(saivageDir: string, cardId: string): string {
  return join(saivageDir, 'notes', 'by-card', `${cardId}.jsonl`);
}

function createEmptyQueue(): NotesQueue {
  return {
    next_note_sequence: 1,
    entries: [],
  };
}

function summarizeZodError(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
    .join('; ');
}

function extractQueueEntryCandidates(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') {
    return [];
  }
  const candidateEntries = (value as { entries?: unknown }).entries;
  return Array.isArray(candidateEntries) ? candidateEntries : [];
}

function extractNoteSequenceSuffix(noteId: string): number | null {
  const suffix = Number(noteId.match(/-(\d+)$/)?.[1] ?? NaN);
  return Number.isInteger(suffix) && suffix > 0 ? suffix : null;
}

function computeSafeNextNoteSequence(entries: NotesQueueEntry[], candidateValue: unknown): number {
  let nextSequence = 1;
  if (candidateValue && typeof candidateValue === 'object') {
    const rawNext = (candidateValue as { next_note_sequence?: unknown }).next_note_sequence;
    if (typeof rawNext === 'number' && Number.isInteger(rawNext) && rawNext > 0) {
      nextSequence = rawNext;
    }
  }

  for (const entry of entries) {
    const suffix = extractNoteSequenceSuffix(entry.note_id);
    if (suffix !== null && suffix >= nextSequence) {
      nextSequence = suffix + 1;
    }
  }
  return nextSequence;
}

function reconcileQueueShape(rawValue: unknown, reason: string): NotesQueue {
  const entries: NotesQueueEntry[] = [];
  let droppedInvalidEntries = 0;
  for (const candidate of extractQueueEntryCandidates(rawValue)) {
    const parsed = notesQueueEntrySchema.safeParse(candidate);
    if (parsed.success) {
      entries.push(parsed.data);
    } else {
      droppedInvalidEntries += 1;
    }
  }

  const reconciled: NotesQueue = {
    next_note_sequence: computeSafeNextNoteSequence(entries, rawValue),
    entries,
  };

  const detail = droppedInvalidEntries > 0
    ? ` Dropped ${droppedInvalidEntries} invalid queue entr${droppedInvalidEntries === 1 ? 'y' : 'ies'}.`
    : '';
  console.error(`Notes queue malformed at ${reason}; reconciled to a valid queue.${detail}`);
  return reconciled;
}

function readQueue(saivageDir: string): NotesQueue {
  const path = queuePath(saivageDir);
  if (!existsSync(path)) {
    return createEmptyQueue();
  }

  let rawValue: unknown;
  try {
    rawValue = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    const reconciled = createEmptyQueue();
    console.error(`Notes queue at ${path} is not valid JSON; resetting to empty queue: ${error instanceof Error ? error.message : String(error)}`);
    writeQueueAtomic(saivageDir, reconciled);
    return reconciled;
  }

  const parsed = notesQueueSchema.safeParse(rawValue);
  if (parsed.success) {
    return parsed.data;
  }

  const reconciled = reconcileQueueShape(rawValue, `${path} (${summarizeZodError(parsed.error)})`);
  writeQueueAtomic(saivageDir, reconciled);
  return reconciled;
}

function writeQueueAtomic(saivageDir: string, queue: NotesQueue): void {
  const parsed = notesQueueSchema.safeParse(queue);
  if (!parsed.success) {
    throw new Error(`NotesQueue validation failed: ${parsed.error.message}`);
  }
  writeFileAtomic(queuePath(saivageDir), JSON.stringify(parsed.data, null, 2) + '\n');
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
  return lines.map((line) => noteRecordSchema.parse(JSON.parse(line)));
}

function writeAllNotes(saivageDir: string, cardId: string, notes: NoteRecord[]): void {
  const path = notesFilePath(saivageDir, cardId);
  const content = notes.map((n) => JSON.stringify(noteRecordSchema.parse(n))).join('\n') + (notes.length > 0 ? '\n' : '');
  writeFileAtomic(path, content);
}

function collectMaxPersistedNoteSequence(saivageDir: string, cardIds: Iterable<string>): number {
  let maxSequence = 0;
  for (const cardId of cardIds) {
    for (const note of getAllNotes(saivageDir, cardId)) {
      const suffix = extractNoteSequenceSuffix(note.id);
      if (suffix !== null && suffix > maxSequence) {
        maxSequence = suffix;
      }
    }
  }
  return maxSequence;
}

function computeReconciledNextNoteSequence(
  saivageDir: string,
  queue: NotesQueue,
  resolvedEntries: NotesQueueResolvedEntry[],
): number {
  const maxPersistedSequence = collectMaxPersistedNoteSequence(
    saivageDir,
    new Set([
      ...queue.entries.map((entry) => entry.card_id),
      ...resolvedEntries.map((entry) => entry.card_id),
    ]),
  );
  return Math.max(queue.next_note_sequence, maxPersistedSequence + 1);
}

function generateNoteId(cardId: string, queue: NotesQueue): string {
  return `n-${cardId}-${queue.next_note_sequence}`;
}

function removeFromQueue(saivageDir: string, cardId: string, noteId: string): void {
  const queue = readQueue(saivageDir);
  queue.entries = queue.entries.filter((e) => !(e.card_id === cardId && e.note_id === noteId));
  writeQueueAtomic(saivageDir, queue);
}

function removeAllFromQueue(saivageDir: string, cardId: string): void {
  const queue = readQueue(saivageDir);
  queue.entries = queue.entries.filter((e) => e.card_id !== cardId);
  writeQueueAtomic(saivageDir, queue);
}

function getAllNotes(saivageDir: string, cardId: string): NoteRecord[] {
  return parseNoteLines(readAllNoteLines(saivageDir, cardId));
}

function resolveQueueEntry(saivageDir: string, entry: NotesQueueEntry): NotesQueueResolvedEntry | null {
  const notes = getAllNotes(saivageDir, entry.card_id);
  const note = notes.find((candidate) => candidate.id === entry.note_id);
  if (!note) {
    return null;
  }
  if (note.handled) {
    return null;
  }
  if (
    note.card_id !== entry.card_id ||
    note.timestamp !== entry.timestamp ||
    note.kind !== entry.kind
  ) {
    return null;
  }
  return { ...entry, note };
}

function reconcileQueueEntries(saivageDir: string, queue: NotesQueue): {
  resolved: NotesQueueResolvedEntry[];
  removed: NotesQueueEntry[];
} {
  const resolved: NotesQueueResolvedEntry[] = [];
  const removed: NotesQueueEntry[] = [];
  for (const entry of queue.entries) {
    const match = resolveQueueEntry(saivageDir, entry);
    if (match) {
      resolved.push(match);
    } else {
      removed.push(entry);
    }
  }
  return { resolved, removed };
}

export function appendNote(
  saivageDir: string,
  cardId: string,
  note: {
    author: NoteAuthor;
    content: string;
    kind: NoteKind;
  },
): NoteRecord {
  const queue = readQueue(saivageDir);
  const existing = getAllNotes(saivageDir, cardId);
  const newNote: NoteRecord = {
    id: generateNoteId(cardId, queue),
    card_id: cardId,
    author: note.author,
    timestamp: new Date().toISOString(),
    content: note.content,
    kind: note.kind,
    handled: false,
  };

  noteRecordSchema.parse(newNote);
  existing.push(newNote);
  writeAllNotes(saivageDir, cardId, existing);
  queue.next_note_sequence += 1;
  queue.entries.push({
    card_id: newNote.card_id,
    note_id: newNote.id,
    timestamp: newNote.timestamp,
    kind: newNote.kind,
  });
  writeQueueAtomic(saivageDir, queue);
  enqueueNoteNotifications(join(saivageDir, '..'), newNote, { actor: newNote.author, surface: 'runtime' });
  return newNote;
}

export function getNotes(saivageDir: string, cardId: string): NoteRecord[] {
  return getAllNotes(saivageDir, cardId);
}

export function getUnhandledNotes(saivageDir: string, cardId: string): NoteRecord[] {
  return getAllNotes(saivageDir, cardId).filter((n) => !n.handled);
}

export function getUnhandledNotesQueue(saivageDir: string): NotesQueueEntry[] {
  return readQueue(saivageDir).entries;
}

export function getReconciledUnhandledNotesQueue(saivageDir: string): NotesQueueResolvedEntry[] {
  const queue = readQueue(saivageDir);
  const { resolved, removed } = reconcileQueueEntries(saivageDir, queue);
  if (removed.length > 0) {
    console.warn(`Removed ${removed.length} stale notes queue entr${removed.length === 1 ? 'y' : 'ies'} from ${queuePath(saivageDir)} because the backing note was missing, handled, or mismatched.`);
    writeQueueAtomic(saivageDir, {
      next_note_sequence: computeReconciledNextNoteSequence(saivageDir, queue, resolved),
      entries: resolved.map(({ note: _note, ...entry }) => entry),
    });
  }
  return resolved;
}

export function findUnhandledNoteCardId(saivageDir: string, noteId: string): string | null {
  const queue = getReconciledUnhandledNotesQueue(saivageDir);
  const entry = queue.find((candidate) => candidate.note_id === noteId);
  return entry ? entry.card_id : null;
}

export function markNoteHandled(saivageDir: string, cardId: string, noteId: string): NoteRecord {
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

  noteRecordSchema.parse(notes[idx]);
  writeAllNotes(saivageDir, cardId, notes);
  removeFromQueue(saivageDir, cardId, noteId);
  return notes[idx];
}

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
    throw new Error(`Cannot update handled note: ${noteId}. Notes are immutable after handling.`);
  }

  const updated: NoteRecord = {
    ...notes[idx],
    ...(changes.content !== undefined ? { content: changes.content } : {}),
    ...(changes.kind !== undefined ? { kind: changes.kind } : {}),
  };

  noteRecordSchema.parse(updated);
  notes[idx] = updated;
  writeAllNotes(saivageDir, cardId, notes);

  if (changes.kind !== undefined) {
    const queue = readQueue(saivageDir);
    const qIdx = queue.entries.findIndex((e) => e.card_id === cardId && e.note_id === noteId);
    if (qIdx !== -1) {
      queue.entries[qIdx].kind = changes.kind;
      writeQueueAtomic(saivageDir, queue);
    }
  }

  return updated;
}

export function deleteNote(saivageDir: string, cardId: string, noteId: string): void {
  const notes = getAllNotes(saivageDir, cardId);
  const idx = notes.findIndex((n) => n.id === noteId);
  if (idx === -1) {
    throw new Error(`Note not found: ${noteId} for card ${cardId}`);
  }

  if (notes[idx].handled) {
    throw new Error(`Cannot delete handled note: ${noteId}. Notes are immutable after handling.`);
  }

  notes.splice(idx, 1);
  writeAllNotes(saivageDir, cardId, notes);
  removeFromQueue(saivageDir, cardId, noteId);
}

export function deleteAllNotes(saivageDir: string, cardId: string): void {
  const path = notesFilePath(saivageDir, cardId);
  if (existsSync(path)) {
    unlinkSync(path);
  }
  removeAllFromQueue(saivageDir, cardId);
}
