import { afterEach, describe, expect, it } from '@jest/globals';
import { closeSync, ftruncateSync, fsyncSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardService } from '../../src/cards/card-service.js';
import type { GrowingFileIo } from '../../src/persistence/growing-file.js';
import { initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
const io: GrowingFileIo = { read: readFileSync, open: openSync, write: writeSync, fsync: fsyncSync, truncate: ftruncateSync, close: closeSync };
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function setup() { const root = mkdtempSync(join(tmpdir(), 'saivage-record-stream-')); roots.push(root); initProjectTree(root); const cards = new CardService(root, undefined, undefined, () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa'); const card = cards.create({ type: 'code', parent: 'project', title: 'card', brief: 'brief', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] }); return { root, cards, card }; }

describe('authored record revision streams', () => {
  it('preserves logical-version URLs across edit, close, discard, and new open versions', () => {
    const { cards, card } = setup();
    const first = cards.openRecord(card.id, 'status.md');
    expect(first.recordUrl).toContain(`card=${encodeURIComponent(card.id)}&v=1`);
    cards.editRecord(card.id, 'status.md', 1, 'closed content');
    cards.closeRecord(card.id, 'status.md', 1, 'executor', card.version_seq);
    expect(cards.readRecord(card.id, 'status.md', 'latest').artifact.content).toBe('closed content');
    expect(cards.readRecord(card.id, 'status.md', 1).artifact.state).toBe('closed');
    cards.openRecord(card.id, 'status.md');
    cards.discardRecord(card.id, 'status.md', 2, 'not needed');
    expect(cards.readRecord(card.id, 'status.md', 2).artifact.state).toBe('discarded');
    expect(cards.openRecord(card.id, 'status.md').version).toBe(3);
  });

  it('leaves a complete record revision visible after reported fsync failure without retry', () => {
    const { root, cards, card } = setup(); cards.openRecord(card.id, 'status.md');
    let fsyncs = 0; const failing: GrowingFileIo = { ...io, fsync(fd) { fsyncs += 1; fsyncSync(fd); throw new Error('record fsync'); } };
    const faulty = new CardService(root, undefined, undefined, undefined, failing);
    expect(() => faulty.editRecord(card.id, 'status.md', 1, 'outcome unknown content')).toThrow('record fsync');
    expect(fsyncs).toBe(1);
    expect(cards.readRecord(card.id, 'status.md', 1).artifact.content).toBe('outcome unknown content');
  });
});
