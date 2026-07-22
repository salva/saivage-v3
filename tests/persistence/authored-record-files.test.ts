import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardService,initProjectTree } from '../helpers/canonical-project.js';
import { AuthoredRecordNotFoundError } from '../../src/persistence/authored-record-files.js';
import { cardNamespace, cardRecordStreamFile, cardStreamFile } from '../../src/persistence/layout.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function setup() { const root = mkdtempSync(join(tmpdir(), 'saivage-record-stream-')); roots.push(root); initProjectTree(root); const cards = new CardService(root); const card = cards.create({ type: 'code', parent: 'project', title: 'card', bootstrap_content: 'brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] }); return { cards, card }; }

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

  it('uses one typed signal for clean card and selector absence', () => {
    const { cards, card } = setup();
    for (const read of [
      () => cards.readRecord('card-z', 'status.md', 'latest'),
      () => cards.readRecord(card.id, 'status.md', 'latest'),
      () => cards.readRecord(card.id, 'status.md', 'open'),
      () => cards.readRecord(card.id, 'status.md', 7),
      () => cards.recordReader.record(card.id, 'status.md', 'latest'),
    ]) expect(read).toThrow(AuthoredRecordNotFoundError);
  });

  it('preserves malformed canonical and I/O failures instead of classifying them as absence', () => {
    const malformed = setup();
    writeFileSync(join(cardNamespace(malformed.cards.projectRoot, malformed.card.id), 'status.jsonl'), 'complete malformed record\n');
    expect(() => malformed.cards.readRecord(malformed.card.id, 'status.md')).toThrow(/malformed/);

    const malformedCard = setup();
    writeFileSync(cardStreamFile(malformedCard.cards.projectRoot, malformedCard.card.id), 'complete malformed card\n');
    expect(() => malformedCard.cards.readRecord(malformedCard.card.id, 'status.md')).toThrow(/malformed/);

    const missingBrief = setup();
    rmSync(cardRecordStreamFile(missingBrief.cards.projectRoot, missingBrief.card.id, missingBrief.cards.recordReader.definition(missingBrief.card.id,'brief.md')));
    let missingBriefError: unknown;
    try { missingBrief.cards.readRecord(missingBrief.card.id, 'brief.md'); } catch (error) { missingBriefError = error; }
    expect(missingBriefError).not.toBeInstanceOf(AuthoredRecordNotFoundError);
    expect((missingBriefError as NodeJS.ErrnoException).code).toBe('ENOENT');

    const ioFailure = setup();
    mkdirSync(join(cardNamespace(ioFailure.cards.projectRoot, ioFailure.card.id), 'status.jsonl'));
    try { ioFailure.cards.readRecord(ioFailure.card.id, 'status.md'); }
    catch (error) {
      expect(error).not.toBeInstanceOf(AuthoredRecordNotFoundError);
      expect((error as NodeJS.ErrnoException).code).toBe('EISDIR');
      return;
    }
    throw new Error('Expected strict record I/O failure.');
  });
});
