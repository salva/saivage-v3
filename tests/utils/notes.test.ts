import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdtempSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendNote,
  getNotes,
  getUnhandledNotes,
  getUnhandledNotesQueue,
  getReconciledUnhandledNotesQueue,
  markNoteHandled,
  updateNote,
  deleteNote,
  deleteAllNotes,
} from '../../src/utils/notes.js';
import type { NoteRecord } from '../../src/schemas/types.js';
import { initProjectTree } from '../../src/utils/file-tree.js';

let tmpDir: string;
let saivageDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'saivage-notes-test-'));
  initProjectTree(tmpDir);
  saivageDir = join(tmpDir, '.saivage');
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

function ensureQueueExists(): void {
  const queueJsonPath = join(saivageDir, 'notes', 'queue.json');
  if (!existsSync(queueJsonPath)) {
    writeFileSync(queueJsonPath, JSON.stringify({ next_note_sequence: 1, entries: [] }, null, 2) + '\n', 'utf-8');
  }
}

function readQueueFile(): { next_note_sequence: number; entries: Array<{ card_id: string; note_id: string; timestamp: string; kind: string }>; } {
  const path = join(saivageDir, 'notes', 'queue.json');
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf-8'));
  return { next_note_sequence: 1, entries: [] };
}

function readNotesFile(cardId: string): NoteRecord[] {
  const path = join(saivageDir, 'notes', 'by-card', `${cardId}.jsonl`);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  if (raw.trim() === '') return [];
  return raw.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as NoteRecord);
}

describe('appendNote', () => {
  beforeEach(() => ensureQueueExists());
  it('creates a new JSONL file for a card and adds to queue', () => {
    const note = appendNote(saivageDir, 'goal-1', { author: 'user', content: 'First note', kind: 'comment' });
    expect(note.id).toBe('n-goal-1-1');
    expect(note.card_id).toBe('goal-1');
    expect(note.author).toBe('user');
    expect(note.content).toBe('First note');
    expect(note.kind).toBe('comment');
    expect(note.handled).toBe(false);
    expect(note.timestamp).toBeDefined();
    expect(existsSync(join(saivageDir, 'notes', 'by-card', 'goal-1.jsonl'))).toBe(true);
    expect(readNotesFile('goal-1')[0].id).toBe('n-goal-1-1');
    const queue = readQueueFile();
    expect(queue.next_note_sequence).toBe(2);
    expect(queue.entries.length).toBe(1);
    expect(queue.entries[0].card_id).toBe('goal-1');
    expect(queue.entries[0].note_id).toBe('n-goal-1-1');
    expect(queue.entries[0].kind).toBe('comment');
  });

  it('appends to existing JSONL file with monotonic sequence', () => {
    appendNote(saivageDir, 'goal-1', { author: 'user', content: 'First', kind: 'comment' });
    const note2 = appendNote(saivageDir, 'goal-1', { author: 'executor', content: 'Second', kind: 'progress' });
    expect(note2.id).toBe('n-goal-1-2');
    expect(readNotesFile('goal-1').length).toBe(2);
    expect(readQueueFile().next_note_sequence).toBe(3);
    expect(readQueueFile().entries.length).toBe(2);
  });

  it('does not reuse a deleted note id for a newly created note', () => {
    const note1 = appendNote(saivageDir, 'goal-1', { author: 'user', content: 'First', kind: 'comment' });
    appendNote(saivageDir, 'goal-1', { author: 'user', content: 'Second', kind: 'comment' });
    deleteNote(saivageDir, 'goal-1', note1.id);
    const replacement = appendNote(saivageDir, 'goal-1', { author: 'user', content: 'Replacement', kind: 'comment' });
    expect(replacement.id).toBe('n-goal-1-3');
    expect(replacement.id).not.toBe(note1.id);
    expect(readQueueFile().next_note_sequence).toBe(4);
  });

  it('does not reuse an acknowledged note id for a newly created note', () => {
    const original = appendNote(saivageDir, 'goal-1', { author: 'user', content: 'Ack me', kind: 'comment' });
    markNoteHandled(saivageDir, 'goal-1', original.id);
    const queueBeforeAppend = readQueueFile();
    expect(queueBeforeAppend.next_note_sequence).toBe(2);
    expect(queueBeforeAppend.entries).toEqual([]);
    const replacement = appendNote(saivageDir, 'goal-1', { author: 'user', content: 'After ack', kind: 'comment' });
    expect(replacement.id).toBe('n-goal-1-2');
    expect(replacement.id).not.toBe(original.id);
    expect(readQueueFile().next_note_sequence).toBe(3);
  });

  it('does not reuse cleared note ids after deleteAllNotes', () => {
    appendNote(saivageDir, 'goal-1', { author: 'user', content: 'One', kind: 'comment' });
    appendNote(saivageDir, 'goal-1', { author: 'user', content: 'Two', kind: 'comment' });
    deleteAllNotes(saivageDir, 'goal-1');
    const replacement = appendNote(saivageDir, 'goal-1', { author: 'user', content: 'Three', kind: 'comment' });
    expect(replacement.id).toBe('n-goal-1-3');
    expect(readQueueFile().next_note_sequence).toBe(4);
  });
});

describe('getNotes', () => {
  beforeEach(() => ensureQueueExists());
  it('returns notes in chronological order', () => {
    appendNote(saivageDir, 'goal-1', { author: 'user', content: 'First', kind: 'comment' });
    appendNote(saivageDir, 'goal-1', { author: 'executor', content: 'Second', kind: 'progress' });
    appendNote(saivageDir, 'goal-1', { author: 'planner', content: 'Third', kind: 'directive' });
    const notes = getNotes(saivageDir, 'goal-1');
    expect(notes.map((n) => n.content)).toEqual(['First', 'Second', 'Third']);
  });
  it('returns empty array for card with no notes', () => {
    expect(getNotes(saivageDir, 'nonexistent')).toEqual([]);
  });
});

describe('getUnhandledNotes', () => {
  beforeEach(() => ensureQueueExists());
  it('returns only unhandled notes', () => {
    const first = appendNote(saivageDir, 'goal-1', { author: 'user', content: 'Unhandled 1', kind: 'comment' });
    const second = appendNote(saivageDir, 'goal-1', { author: 'user', content: 'Will be handled', kind: 'comment' });
    appendNote(saivageDir, 'goal-1', { author: 'user', content: 'Unhandled 2', kind: 'escalation' });
    expect(first.id).toBe('n-goal-1-1');
    markNoteHandled(saivageDir, 'goal-1', second.id);
    expect(getUnhandledNotes(saivageDir, 'goal-1').map((n) => n.content)).toEqual(['Unhandled 1', 'Unhandled 2']);
  });
});

describe('queue reconciliation and monotonic sequence behavior', () => {
  beforeEach(() => ensureQueueExists());

  it('reconciles malformed queue schema instead of throwing', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    writeFileSync(join(saivageDir, 'notes', 'queue.json'), JSON.stringify({ entries: [{ card_id: 'goal-1' }] }) + '\n');
    expect(getUnhandledNotesQueue(saivageDir)).toEqual([]);
    expect(readQueueFile()).toEqual({ next_note_sequence: 1, entries: [] });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('repairs legacy queue files missing next_note_sequence without touching backing notes', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const note = appendNote(saivageDir, 'goal-1', { author: 'user', content: 'Legacy queue owner', kind: 'comment' });
    writeFileSync(
      join(saivageDir, 'notes', 'queue.json'),
      JSON.stringify({
        entries: [{ card_id: note.card_id, note_id: note.id, timestamp: note.timestamp, kind: note.kind }],
      }, null, 2) + '\n',
    );
    const queue = getUnhandledNotesQueue(saivageDir);
    expect(queue).toHaveLength(1);
    expect(queue[0].note_id).toBe(note.id);
    expect(readNotesFile('goal-1')).toHaveLength(1);
    expect(readQueueFile().next_note_sequence).toBe(2);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('reconciles queue entries that point at handled notes', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    appendNote(saivageDir, 'goal-1', { author: 'user', content: 'Handle me', kind: 'directive' });
    const before = readQueueFile();
    expect(before.entries).toHaveLength(1);
    const notes = getNotes(saivageDir, 'goal-1');
    notes[0] = { ...notes[0], handled: true, handled_at: new Date().toISOString() };
    writeFileSync(join(saivageDir, 'notes', 'by-card', 'goal-1.jsonl'), notes.map((n) => JSON.stringify(n)).join('\n') + '\n');
    expect(getReconciledUnhandledNotesQueue(saivageDir)).toEqual([]);
    expect(readQueueFile().entries).toEqual([]);
    expect(readQueueFile().next_note_sequence).toBe(2);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('markNoteHandled', () => {
  beforeEach(() => ensureQueueExists());
  it('sets handled=true and handled_at without decrementing sequence', () => {
    const created = appendNote(saivageDir, 'goal-1', { author: 'user', content: 'Test note', kind: 'comment' });
    const marked = markNoteHandled(saivageDir, 'goal-1', created.id);
    expect(marked.handled).toBe(true);
    expect(marked.handled_at).toBeDefined();
    expect(readQueueFile().next_note_sequence).toBe(2);
  });
});

describe('updateNote', () => {
  beforeEach(() => ensureQueueExists());
  it('updates kind on unhandled note and updates queue', () => {
    const created = appendNote(saivageDir, 'goal-1', { author: 'user', content: 'Content', kind: 'comment' });
    const updated = updateNote(saivageDir, 'goal-1', created.id, { kind: 'escalation' });
    expect(updated.kind).toBe('escalation');
    expect(readQueueFile().entries[0].kind).toBe('escalation');
    expect(readQueueFile().next_note_sequence).toBe(2);
  });
});

describe('deleteNote', () => {
  beforeEach(() => ensureQueueExists());
  it('deletes unhandled note without decrementing sequence', () => {
    const toDelete = appendNote(saivageDir, 'goal-1', { author: 'user', content: 'To delete', kind: 'comment' });
    const toKeep = appendNote(saivageDir, 'goal-1', { author: 'user', content: 'To keep', kind: 'progress' });
    deleteNote(saivageDir, 'goal-1', toDelete.id);
    const notes = getNotes(saivageDir, 'goal-1');
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe(toKeep.id);
    expect(toKeep.id).toBe('n-goal-1-2');
    expect(readQueueFile().next_note_sequence).toBe(3);
  });
});

describe('deleteAllNotes', () => {
  beforeEach(() => ensureQueueExists());
  it('removes all queue entries for the card while preserving sequence ownership', () => {
    appendNote(saivageDir, 'goal-1', { author: 'user', content: 'G1 note', kind: 'comment' });
    appendNote(saivageDir, 'goal-2', { author: 'user', content: 'G2 note', kind: 'comment' });
    appendNote(saivageDir, 'goal-1', { author: 'user', content: 'G1 second', kind: 'directive' });
    deleteAllNotes(saivageDir, 'goal-1');
    expect(readQueueFile().entries).toHaveLength(1);
    expect(readQueueFile().entries[0].card_id).toBe('goal-2');
    expect(readQueueFile().next_note_sequence).toBe(4);
  });
});
