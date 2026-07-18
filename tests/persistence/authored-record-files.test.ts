import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardService } from '../../src/cards/card-service.js';
import { initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function setup() { const root = mkdtempSync(join(tmpdir(), 'saivage-record-stream-')); roots.push(root); initProjectTree(root); const cards = new CardService(root); const card = cards.create({ type: 'code', parent: 'project', title: 'card', brief: 'brief', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] }); return { cards, card }; }

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
});
