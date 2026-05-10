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
    writeFileSync(
      queueJsonPath,
      JSON.stringify({ entries: [] }, null, 2) + '\n',
      'utf-8',
    );
  }
}

function readQueueFile(): {
  entries: Array<{
    card_id: string;
    note_id: string;
    timestamp: string;
    kind: string;
  }>;
} {
  const path = join(saivageDir, 'notes', 'queue.json');
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf-8'));
  }
  return { entries: [] };
}

function readNotesFile(cardId: string): NoteRecord[] {
  const path = join(saivageDir, 'notes', 'by-card', `${cardId}.jsonl`);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  if (raw.trim() === '') return [];
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as NoteRecord);
}

describe('appendNote', () => {
  beforeEach(() => ensureQueueExists());

  it('creates a new JSONL file for a card and adds to queue', () => {
    const note = appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'First note',
      kind: 'comment',
    });

    expect(note.id).toBe('n-goal-1-1');
    expect(note.card_id).toBe('goal-1');
    expect(note.author).toBe('user');
    expect(note.content).toBe('First note');
    expect(note.kind).toBe('comment');
    expect(note.handled).toBe(false);
    expect(note.timestamp).toBeDefined();

    const filePath = join(saivageDir, 'notes', 'by-card', 'goal-1.jsonl');
    expect(existsSync(filePath)).toBe(true);

    const fileNotes = readNotesFile('goal-1');
    expect(fileNotes.length).toBe(1);
    expect(fileNotes[0].id).toBe('n-goal-1-1');

    const queue = readQueueFile();
    expect(queue.entries.length).toBe(1);
    expect(queue.entries[0].card_id).toBe('goal-1');
    expect(queue.entries[0].note_id).toBe('n-goal-1-1');
    expect(queue.entries[0].kind).toBe('comment');
  });

  it('appends to existing JSONL file with incrementing sequence', () => {
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'First',
      kind: 'comment',
    });
    const note2 = appendNote(saivageDir, 'goal-1', {
      author: 'executor',
      content: 'Second',
      kind: 'progress',
    });

    expect(note2.id).toBe('n-goal-1-2');

    const fileNotes = readNotesFile('goal-1');
    expect(fileNotes.length).toBe(2);
    expect(fileNotes[0].id).toBe('n-goal-1-1');
    expect(fileNotes[1].id).toBe('n-goal-1-2');

    const queue = readQueueFile();
    expect(queue.entries.length).toBe(2);
  });

  it('validates with Zod schema', () => {
    const note = appendNote(saivageDir, 'goal-1', {
      author: 'planner',
      content: 'Schema test',
      kind: 'directive',
    });
    expect(note.handled).toBe(false);
    expect(note.author).toBe('planner');
    expect(note.kind).toBe('directive');
  });

  it('generates sequential IDs across multiple cards independently', () => {
    const n1 = appendNote(saivageDir, 'card-a', {
      author: 'user',
      content: 'A1',
      kind: 'comment',
    });
    const n2 = appendNote(saivageDir, 'card-b', {
      author: 'user',
      content: 'B1',
      kind: 'comment',
    });
    const n3 = appendNote(saivageDir, 'card-a', {
      author: 'user',
      content: 'A2',
      kind: 'comment',
    });

    expect(n1.id).toBe('n-card-a-1');
    expect(n2.id).toBe('n-card-b-1');
    expect(n3.id).toBe('n-card-a-2');
  });
});

describe('getNotes', () => {
  beforeEach(() => ensureQueueExists());

  it('returns notes in chronological order', () => {
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'First',
      kind: 'comment',
    });
    appendNote(saivageDir, 'goal-1', {
      author: 'executor',
      content: 'Second',
      kind: 'progress',
    });
    appendNote(saivageDir, 'goal-1', {
      author: 'planner',
      content: 'Third',
      kind: 'directive',
    });

    const notes = getNotes(saivageDir, 'goal-1');
    expect(notes.length).toBe(3);
    expect(notes[0].content).toBe('First');
    expect(notes[1].content).toBe('Second');
    expect(notes[2].content).toBe('Third');
  });

  it('returns empty array for card with no notes', () => {
    const notes = getNotes(saivageDir, 'nonexistent');
    expect(notes).toEqual([]);
  });
});

describe('getUnhandledNotes', () => {
  beforeEach(() => ensureQueueExists());

  it('returns only unhandled notes', () => {
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'Unhandled 1',
      kind: 'comment',
    });
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'Will be handled',
      kind: 'comment',
    });
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'Unhandled 2',
      kind: 'escalation',
    });

    markNoteHandled(saivageDir, 'goal-1', 'n-goal-1-2');

    const unhandled = getUnhandledNotes(saivageDir, 'goal-1');
    expect(unhandled.length).toBe(2);
    expect(unhandled[0].content).toBe('Unhandled 1');
    expect(unhandled[1].content).toBe('Unhandled 2');
  });

  it('returns empty array when all notes are handled', () => {
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'Only note',
      kind: 'comment',
    });
    markNoteHandled(saivageDir, 'goal-1', 'n-goal-1-1');

    const unhandled = getUnhandledNotes(saivageDir, 'goal-1');
    expect(unhandled).toEqual([]);
  });
});

describe('markNoteHandled', () => {
  beforeEach(() => ensureQueueExists());

  it('sets handled=true and handled_at', () => {
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'Test note',
      kind: 'comment',
    });

    const marked = markNoteHandled(saivageDir, 'goal-1', 'n-goal-1-1');
    expect(marked.handled).toBe(true);
    expect(marked.handled_at).toBeDefined();
    expect(typeof marked.handled_at).toBe('string');

    const notes = getNotes(saivageDir, 'goal-1');
    expect(notes[0].handled).toBe(true);
    expect(notes[0].handled_at).toBeDefined();
  });

  it('removes entry from the notes queue', () => {
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'Test note',
      kind: 'comment',
    });
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'Another note',
      kind: 'directive',
    });

    expect(readQueueFile().entries.length).toBe(2);

    markNoteHandled(saivageDir, 'goal-1', 'n-goal-1-1');

    const queue = readQueueFile();
    expect(queue.entries.length).toBe(1);
    expect(queue.entries[0].note_id).toBe('n-goal-1-2');
  });

  it('makes note immutable — updateNote throws after marking handled', () => {
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'Mutable note',
      kind: 'comment',
    });
    markNoteHandled(saivageDir, 'goal-1', 'n-goal-1-1');

    expect(() =>
      updateNote(saivageDir, 'goal-1', 'n-goal-1-1', { content: 'Changed' }),
    ).toThrow(/immutable/);
  });

  it('makes note immutable — deleteNote throws after marking handled', () => {
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'Mutable note',
      kind: 'comment',
    });
    markNoteHandled(saivageDir, 'goal-1', 'n-goal-1-1');

    expect(() => deleteNote(saivageDir, 'goal-1', 'n-goal-1-1')).toThrow(
      /immutable/,
    );
  });

  it('throws when marking a non-existent note', () => {
    expect(() =>
      markNoteHandled(saivageDir, 'goal-1', 'n-nonexistent-1'),
    ).toThrow(/not found/);
  });
});

describe('updateNote', () => {
  beforeEach(() => ensureQueueExists());

  it('updates content on unhandled note', () => {
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'Original content',
      kind: 'comment',
    });

    const updated = updateNote(saivageDir, 'goal-1', 'n-goal-1-1', {
      content: 'Updated content',
    });

    expect(updated.content).toBe('Updated content');
    expect(updated.kind).toBe('comment');

    const notes = getNotes(saivageDir, 'goal-1');
    expect(notes[0].content).toBe('Updated content');
  });

  it('updates kind on unhandled note and updates queue', () => {
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'Content',
      kind: 'comment',
    });

    const updated = updateNote(saivageDir, 'goal-1', 'n-goal-1-1', {
      kind: 'escalation',
    });

    expect(updated.kind).toBe('escalation');
    expect(updated.content).toBe('Content');

    const queue = readQueueFile();
    const entry = queue.entries.find((e) => e.note_id === 'n-goal-1-1');
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe('escalation');
  });

  it('updates both content and kind simultaneously', () => {
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'Old',
      kind: 'comment',
    });

    const updated = updateNote(saivageDir, 'goal-1', 'n-goal-1-1', {
      content: 'New',
      kind: 'directive',
    });

    expect(updated.content).toBe('New');
    expect(updated.kind).toBe('directive');
  });

  it('throws when updating handled note', () => {
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'Important',
      kind: 'directive',
    });
    markNoteHandled(saivageDir, 'goal-1', 'n-goal-1-1');

    expect(() =>
      updateNote(saivageDir, 'goal-1', 'n-goal-1-1', { content: 'Changed' }),
    ).toThrow(/immutable/);
  });

  it('throws when note not found', () => {
    expect(() =>
      updateNote(saivageDir, 'goal-1', 'n-nonexistent-1', { content: 'x' }),
    ).toThrow(/not found/);
  });

  it('validates with Zod after update', () => {
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'Valid',
      kind: 'comment',
    });

    const updated = updateNote(saivageDir, 'goal-1', 'n-goal-1-1', {
      content: 'Still valid',
      kind: 'progress',
    });
    expect(updated.content).toBe('Still valid');
    expect(updated.kind).toBe('progress');
  });
});

describe('deleteNote', () => {
  beforeEach(() => ensureQueueExists());

  it('deletes unhandled note', () => {
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'To delete',
      kind: 'comment',
    });
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'To keep',
      kind: 'progress',
    });

    deleteNote(saivageDir, 'goal-1', 'n-goal-1-1');

    const notes = getNotes(saivageDir, 'goal-1');
    expect(notes.length).toBe(1);
    expect(notes[0].id).toBe('n-goal-1-2');
    expect(notes[0].content).toBe('To keep');
  });

  it('removes from queue after deletion', () => {
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'To delete',
      kind: 'comment',
    });

    expect(readQueueFile().entries.length).toBe(1);

    deleteNote(saivageDir, 'goal-1', 'n-goal-1-1');

    expect(readQueueFile().entries.length).toBe(0);
  });

  it('throws when deleting handled note', () => {
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'Handled note',
      kind: 'comment',
    });
    markNoteHandled(saivageDir, 'goal-1', 'n-goal-1-1');

    expect(() => deleteNote(saivageDir, 'goal-1', 'n-goal-1-1')).toThrow(
      /immutable/,
    );
  });

  it('throws when note not found', () => {
    expect(() =>
      deleteNote(saivageDir, 'goal-1', 'n-nonexistent-1'),
    ).toThrow(/not found/);
  });

  it('re-numbers on subsequent appends after deletion', () => {
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'N1',
      kind: 'comment',
    });
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'N2',
      kind: 'comment',
    });

    deleteNote(saivageDir, 'goal-1', 'n-goal-1-1');

    const note3 = appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'N3',
      kind: 'comment',
    });
    expect(note3.id).toBe('n-goal-1-2');
  });
});

describe('deleteAllNotes', () => {
  beforeEach(() => ensureQueueExists());

  it('removes the notes file completely', () => {
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'Note 1',
      kind: 'comment',
    });
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'Note 2',
      kind: 'progress',
    });

    const filePath = join(saivageDir, 'notes', 'by-card', 'goal-1.jsonl');
    expect(existsSync(filePath)).toBe(true);

    deleteAllNotes(saivageDir, 'goal-1');
    expect(existsSync(filePath)).toBe(false);
  });

  it('removes all queue entries for the card', () => {
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'G1 note',
      kind: 'comment',
    });
    appendNote(saivageDir, 'goal-2', {
      author: 'user',
      content: 'G2 note',
      kind: 'comment',
    });
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'G1 second',
      kind: 'directive',
    });

    expect(readQueueFile().entries.length).toBe(3);

    deleteAllNotes(saivageDir, 'goal-1');

    const queue = readQueueFile();
    expect(queue.entries.length).toBe(1);
    expect(queue.entries[0].card_id).toBe('goal-2');
  });

  it('silently succeeds if note file does not exist', () => {
    expect(() => deleteAllNotes(saivageDir, 'nonexistent-card')).not.toThrow();
  });

  it('returns empty array from getNotes after deletion', () => {
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'Temporary',
      kind: 'comment',
    });
    deleteAllNotes(saivageDir, 'goal-1');

    const notes = getNotes(saivageDir, 'goal-1');
    expect(notes).toEqual([]);
  });
});

describe('getUnhandledNotesQueue', () => {
  beforeEach(() => ensureQueueExists());

  it('returns all queued entries across cards', () => {
    appendNote(saivageDir, 'card-a', {
      author: 'user',
      content: 'A note',
      kind: 'comment',
    });
    appendNote(saivageDir, 'card-b', {
      author: 'planner',
      content: 'B note',
      kind: 'directive',
    });

    const queue = getUnhandledNotesQueue(saivageDir);
    expect(queue.length).toBe(2);
    expect(queue[0].card_id).toBe('card-a');
    expect(queue[1].card_id).toBe('card-b');
  });

  it('excludes handled notes from queue', () => {
    appendNote(saivageDir, 'card-a', {
      author: 'user',
      content: 'Will handle',
      kind: 'comment',
    });
    appendNote(saivageDir, 'card-a', {
      author: 'user',
      content: 'Unhandled',
      kind: 'escalation',
    });

    markNoteHandled(saivageDir, 'card-a', 'n-card-a-1');

    const queue = getUnhandledNotesQueue(saivageDir);
    expect(queue.length).toBe(1);
    expect(queue[0].note_id).toBe('n-card-a-2');
  });

  it('returns empty array when no notes exist', () => {
    const queue = getUnhandledNotesQueue(saivageDir);
    expect(queue).toEqual([]);
  });
});

describe('Zod validation', () => {
  beforeEach(() => ensureQueueExists());

  it('all note operations produce valid NoteRecords', () => {
    const note = appendNote(saivageDir, 'goal-1', {
      author: 'reviewer',
      content: 'Review completed',
      kind: 'progress',
    });

    expect(note.id).toBeTruthy();
    expect(note.card_id).toBe('goal-1');
    expect(note.author).toBe('reviewer');
    expect(note.timestamp).toBeTruthy();
    expect(new Date(note.timestamp).toISOString()).toBe(note.timestamp);
    expect(note.content).toBe('Review completed');
    expect(note.kind).toBe('progress');
    expect(note.handled).toBe(false);
    expect(note.handled_at).toBeUndefined();
  });

  it('markNoteHandled validates result with Zod', () => {
    appendNote(saivageDir, 'goal-1', {
      author: 'user',
      content: 'Test',
      kind: 'comment',
    });

    const marked = markNoteHandled(saivageDir, 'goal-1', 'n-goal-1-1');
    expect(marked.handled).toBe(true);
    expect(marked.handled_at).toBeTruthy();
    expect(new Date(marked.handled_at!).toISOString()).toBe(marked.handled_at);
  });
});
