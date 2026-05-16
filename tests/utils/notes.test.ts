import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdtempSync,
  mkdirSync,
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

let tmpDir: string;
let saivageDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'saivage-notes-test-'));
  saivageDir = join(tmpDir, '.saivage');
  mkdirSync(join(saivageDir, 'notes', 'by-card'), { recursive: true });
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function ensureQueueExists(): void {
  const queueJsonPath = join(saivageDir, 'notes', 'queue.json');
  if (!existsSync(queueJsonPath)) {
    mkdirSync(join(saivageDir, 'notes'), { recursive: true });
    writeFileSync(queueJsonPath, JSON.stringify({ entries: [] }, null, 2) + '\n', 'utf-8');
  }
}

function readQueueFile(): { entries: Array<{ card_id: string; note_id: string; timestamp: string; kind: string }>; } {
  const path = join(saivageDir, 'notes', 'queue.json');
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf-8'));
  return { entries: [] };
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
    expect(queue.entries.length).toBe(1);
    expect(queue.entries[0].card_id).toBe('goal-1');
    expect(queue.entries[0].note_id).toBe('n-goal-1-1');
    expect(queue.entries[0].kind).toBe('comment');
  });

  it('appends to existing JSONL file with incrementing sequence', () => {
    appendNote(saivageDir, 'goal-1', { author: 'user', content: 'First', kind: 'comment' });
    const note2 = appendNote(saivageDir, 'goal-1', { author: 'executor', content: 'Second', kind: 'progress' });
    expect(note2.id).toBe('n-goal-1-2');
    expect(readNotesFile('goal-1').length).toBe(2);
    expect(readQueueFile().entries.length).toBe(2);
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
    appendNote(saivageDir, 'goal-1', { author: 'user', content: 'Unhandled 1', kind: 'comment' });
    appendNote(saivageDir, 'goal-1', { author: 'user', content: 'Will be handled', kind: 'comment' });
    appendNote(saivageDir, 'goal-1', { author: 'user', content: 'Unhandled 2', kind: 'escalation' });
    markNoteHandled(saivageDir, 'goal-1', 'n-goal-1-2');
    expect(getUnhandledNotes(saivageDir, 'goal-1').map((n) => n.content)).toEqual(['Unhandled 1', 'Unhandled 2']);
  });
});

describe('queue validation and reconciliation', () => {
  beforeEach(() => ensureQueueExists());

  it('throws on malformed queue schema', () => {
    writeFileSync(join(saivageDir, 'notes', 'queue.json'), JSON.stringify({ entries: [{ card_id: 'goal-1' }] }) + '\n');
    expect(() => getUnhandledNotesQueue(saivageDir)).toThrow(/NotesQueue validation failed/);
  });

  it('reconciles stale queue entries whose note file is missing', () => {
    appendNote(saivageDir, 'goal-1', { author: 'user', content: 'Keep me', kind: 'comment' });
    writeFileSync(join(saivageDir, 'notes', 'queue.json'), JSON.stringify({
      entries: [
        ...readQueueFile().entries,
        { card_id: 'missing-card', note_id: 'n-missing-card-1', timestamp: new Date().toISOString(), kind: 'comment' },
      ],
    }, null, 2) + '\n');
    const resolved = getReconciledUnhandledNotesQueue(saivageDir);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].note.content).toBe('Keep me');
    expect(readQueueFile().entries).toHaveLength(1);
    expect(readQueueFile().entries[0].card_id).toBe('goal-1');
  });

  it('reconciles queue entries that point at handled notes', () => {
    appendNote(saivageDir, 'goal-1', { author: 'user', content: 'Handle me', kind: 'directive' });
    const before = readQueueFile();
    expect(before.entries).toHaveLength(1);
    const notes = getNotes(saivageDir, 'goal-1');
    notes[0] = { ...notes[0], handled: true, handled_at: new Date().toISOString() };
    writeFileSync(join(saivageDir, 'notes', 'by-card', 'goal-1.jsonl'), notes.map((n) => JSON.stringify(n)).join('\n') + '\n');
    expect(getReconciledUnhandledNotesQueue(saivageDir)).toEqual([]);
    expect(readQueueFile().entries).toEqual([]);
  });
});

describe('markNoteHandled', () => {
  beforeEach(() => ensureQueueExists());
  it('sets handled=true and handled_at', () => {
    appendNote(saivageDir, 'goal-1', { author: 'user', content: 'Test note', kind: 'comment' });
    const marked = markNoteHandled(saivageDir, 'goal-1', 'n-goal-1-1');
    expect(marked.handled).toBe(true);
    expect(marked.handled_at).toBeDefined();
  });
});

describe('updateNote', () => {
  beforeEach(() => ensureQueueExists());
  it('updates kind on unhandled note and updates queue', () => {
    appendNote(saivageDir, 'goal-1', { author: 'user', content: 'Content', kind: 'comment' });
    const updated = updateNote(saivageDir, 'goal-1', 'n-goal-1-1', { kind: 'escalation' });
    expect(updated.kind).toBe('escalation');
    expect(readQueueFile().entries[0].kind).toBe('escalation');
  });
});

describe('deleteNote', () => {
  beforeEach(() => ensureQueueExists());
  it('deletes unhandled note', () => {
    appendNote(saivageDir, 'goal-1', { author: 'user', content: 'To delete', kind: 'comment' });
    appendNote(saivageDir, 'goal-1', { author: 'user', content: 'To keep', kind: 'progress' });
    deleteNote(saivageDir, 'goal-1', 'n-goal-1-1');
    const notes = getNotes(saivageDir, 'goal-1');
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe('n-goal-1-2');
  });
});

describe('deleteAllNotes', () => {
  beforeEach(() => ensureQueueExists());
  it('removes all queue entries for the card', () => {
    appendNote(saivageDir, 'goal-1', { author: 'user', content: 'G1 note', kind: 'comment' });
    appendNote(saivageDir, 'goal-2', { author: 'user', content: 'G2 note', kind: 'comment' });
    appendNote(saivageDir, 'goal-1', { author: 'user', content: 'G1 second', kind: 'directive' });
    deleteAllNotes(saivageDir, 'goal-1');
    expect(readQueueFile().entries).toHaveLength(1);
    expect(readQueueFile().entries[0].card_id).toBe('goal-2');
  });
});
