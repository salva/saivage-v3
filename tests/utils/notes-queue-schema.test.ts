import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendNote,
  getNotes,
  getUnhandledNotesQueue,
  getReconciledUnhandledNotesQueue,
} from '../../src/utils/notes.js';
import type { NoteRecord } from '../../src/schemas/types.js';
import { initProjectTree } from '../../src/utils/file-tree.js';

let tmpDir: string;
let saivageDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'saivage-notes-queue-schema-'));
  initProjectTree(tmpDir);
  saivageDir = join(tmpDir, '.saivage');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

function readQueueFile(): { next_note_sequence: number; entries: Array<{ card_id: string; note_id: string; timestamp: string; kind: string }>; } {
  return JSON.parse(readFileSync(join(saivageDir, 'notes', 'queue.json'), 'utf-8'));
}

function readNotesFile(cardId: string): NoteRecord[] {
  const path = join(saivageDir, 'notes', 'by-card', `${cardId}.jsonl`);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  if (raw.trim() === '') return [];
  return raw.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as NoteRecord);
}

describe('notes queue schema and reconciliation', () => {
  it('round-trips a valid queue through append and read', () => {
    const note = appendNote(saivageDir, 'goal-1', { author: 'user', content: 'Queue me', kind: 'directive' });
    const queue = getUnhandledNotesQueue(saivageDir);
    expect(queue).toEqual([
      {
        card_id: 'goal-1',
        note_id: note.id,
        timestamp: note.timestamp,
        kind: 'directive',
      },
    ]);
    expect(readQueueFile().next_note_sequence).toBe(2);
  });

  it('reconciles corrupted non-json queue files to an empty valid queue', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    writeFileSync(join(saivageDir, 'notes', 'queue.json'), '{not-json\n');
    expect(getUnhandledNotesQueue(saivageDir)).toEqual([]);
    expect(readQueueFile()).toEqual({ next_note_sequence: 1, entries: [] });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('drops malformed queue entries while preserving valid entries and a safe next sequence', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const note = appendNote(saivageDir, 'goal-1', { author: 'user', content: 'Keep me', kind: 'comment' });
    writeFileSync(
      join(saivageDir, 'notes', 'queue.json'),
      JSON.stringify({
        next_note_sequence: 0,
        entries: [
          { card_id: note.card_id, note_id: note.id, timestamp: note.timestamp, kind: note.kind },
          { card_id: 'goal-2', note_id: 42, timestamp: 'bad-date', kind: 'comment' },
          { note_id: 'n-missing-fields' },
        ],
      }, null, 2) + '\n',
    );
    const queue = getUnhandledNotesQueue(saivageDir);
    expect(queue).toHaveLength(1);
    expect(queue[0].note_id).toBe(note.id);
    expect(readQueueFile().next_note_sequence).toBe(2);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('drops ghost entries for missing notes without deleting backing notes for valid entries', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const note = appendNote(saivageDir, 'goal-1', { author: 'user', content: 'Backed note', kind: 'comment' });
    writeFileSync(
      join(saivageDir, 'notes', 'queue.json'),
      JSON.stringify({
        next_note_sequence: 2,
        entries: [
          { card_id: note.card_id, note_id: note.id, timestamp: note.timestamp, kind: note.kind },
          { card_id: 'missing-card', note_id: 'n-missing-card-9', timestamp: new Date().toISOString(), kind: 'comment' },
        ],
      }, null, 2) + '\n',
    );
    const resolved = getReconciledUnhandledNotesQueue(saivageDir);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].note.id).toBe(note.id);
    expect(readQueueFile().entries).toHaveLength(1);
    expect(readNotesFile('goal-1')).toHaveLength(1);
    expect(getNotes(saivageDir, 'goal-1')[0].content).toBe('Backed note');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('drops queue entries for handled or metadata-mismatched notes and leaves note files intact', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const handled = appendNote(saivageDir, 'goal-1', { author: 'user', content: 'Handled soon', kind: 'comment' });
    const mismatched = appendNote(saivageDir, 'goal-1', { author: 'user', content: 'Mismatched metadata', kind: 'directive' });
    const notes = getNotes(saivageDir, 'goal-1').map((note) => {
      if (note.id === handled.id) {
        return { ...note, handled: true, handled_at: new Date().toISOString() };
      }
      return note;
    });
    writeFileSync(join(saivageDir, 'notes', 'by-card', 'goal-1.jsonl'), notes.map((n) => JSON.stringify(n)).join('\n') + '\n');
    writeFileSync(
      join(saivageDir, 'notes', 'queue.json'),
      JSON.stringify({
        next_note_sequence: 3,
        entries: [
          { card_id: handled.card_id, note_id: handled.id, timestamp: handled.timestamp, kind: handled.kind },
          { card_id: mismatched.card_id, note_id: mismatched.id, timestamp: mismatched.timestamp, kind: 'comment' },
        ],
      }, null, 2) + '\n',
    );
    const resolved = getReconciledUnhandledNotesQueue(saivageDir);
    expect(resolved).toEqual([]);
    expect(readQueueFile()).toEqual({ next_note_sequence: 3, entries: [] });
    expect(readNotesFile('goal-1')).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('reconciles stale queue entries without exposing undefined notes, preserves note files, and advances next_note_sequence past existing note ids', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const kept = appendNote(saivageDir, 'goal-1', { author: 'user', content: 'Keep me', kind: 'directive' });
    const stale = appendNote(saivageDir, 'goal-1', { author: 'user', content: 'Stale only in queue', kind: 'comment' });
    writeFileSync(
      join(saivageDir, 'notes', 'queue.json'),
      JSON.stringify({
        next_note_sequence: 1,
        entries: [
          { card_id: kept.card_id, note_id: kept.id, timestamp: kept.timestamp, kind: kept.kind },
          { card_id: stale.card_id, note_id: stale.id, timestamp: stale.timestamp, kind: 'progress' },
          { card_id: stale.card_id, note_id: 'n-goal-1-999', timestamp: stale.timestamp, kind: stale.kind },
        ],
      }, null, 2) + '\n',
    );

    const resolved = getReconciledUnhandledNotesQueue(saivageDir);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ card_id: 'goal-1', note_id: kept.id, note: { id: kept.id, content: 'Keep me' } });
    expect((resolved[0] as { note?: unknown }).note).toBeDefined();
    expect(readNotesFile('goal-1').map((note) => note.id).sort()).toEqual([kept.id, stale.id].sort());
    expect(readQueueFile()).toEqual({
      next_note_sequence: 3,
      entries: [{ card_id: kept.card_id, note_id: kept.id, timestamp: kept.timestamp, kind: kept.kind }],
    });

    const appended = appendNote(saivageDir, 'goal-1', { author: 'analyst', content: 'Fresh after reconcile', kind: 'progress' });
    expect(appended.id).toBe('n-goal-1-3');
    expect(readQueueFile().next_note_sequence).toBe(4);
    expect(readNotesFile('goal-1').map((note) => note.id)).toEqual([kept.id, stale.id, appended.id]);
    expect(warnSpy).toHaveBeenCalled();
  });
});
