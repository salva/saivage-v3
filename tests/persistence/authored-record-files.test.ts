import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AuthoredRecordNotFoundError, RecordHeadMismatchError } from '../../src/persistence/authored-record-files.js';
import { cardRecordVersionFile, cardRecordVersionIndexFile, cardVersionIndexFile } from '../../src/persistence/layout.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'saivage-record-version-'));
  roots.push(root);
  initProjectTree(root);
  const cards = new CardService(root);
  const card = cards.create({ type: 'code', parent: 'project', title: 'card', bootstrap_content: 'brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
  return { cards, card };
}

describe('authored record version files', () => {
  it('publishes immutable open, edit, close, discard, and reopen versions with singular URLs', () => {
    const { cards, card } = setup();
    const opened = cards.openRecord(card.id, 'status.md', null);
    expect(opened).toMatchObject({ headVersion: 1, currentUrl: `record:///status.md?card=${encodeURIComponent(card.id)}`, versionUrl: `record:///status.md?card=${encodeURIComponent(card.id)}&v=1`, artifact: { state: 'open' } });

    const edited = cards.editRecord(card.id, 'status.md', opened.headVersion, 'closed content');
    const earlierCardVersion = cards.read(card.id)!.version_seq;
    const advanced = cards.editCard(card.id, { title: 'advanced before close' });
    expect(advanced.version_seq).toBe(earlierCardVersion + 1);
    const closed = cards.closeRecord(card.id, 'status.md', edited.headVersion, 'executor');
    expect(closed.headVersion).toBe(3);
    expect(closed.artifact.accepted?.content).toBe('closed content');
    expect(closed.artifact.accepted?.card_version_seq).toBe(advanced.version_seq);
    expect(closed.artifact.accepted?.card_version_seq).not.toBe(earlierCardVersion);
    expect(cards.readHistoricalRecord(card.id, 'status.md', 1).artifact.state).toBe('open');
    expect(cards.readCurrentRecord(card.id, 'status.md').artifact).toEqual(closed.artifact);

    const reopened = cards.openRecord(card.id, 'status.md', closed.headVersion);
    expect(reopened.artifact.accepted).toEqual(closed.artifact.accepted);
    const discarded = cards.discardRecord(card.id, 'status.md', reopened.headVersion, 'not needed');
    expect(discarded).toMatchObject({ headVersion: 5, artifact: { state: 'discarded', accepted: closed.artifact.accepted } });
    expect(cards.openRecord(card.id, 'status.md', discarded.headVersion).headVersion).toBe(6);

    const index = JSON.parse(readFileSync(cardRecordVersionIndexFile(cards.projectRoot, card.id, cards.recordReader.definition(card.id, 'status.md')), 'utf8')) as { versions: Array<{ filename: string }> };
    expect(index.versions).toHaveLength(6);
    expect(new Set(index.versions.map((entry) => entry.filename)).size).toBe(6);
    expect(index.versions.every((entry, offset) => entry.filename.startsWith(`${offset + 1}-`) && entry.filename.endsWith('.json'))).toBe(true);
  });

  it('requires the exact expected head and does not publish on mismatch', () => {
    const { cards, card } = setup();
    const opened = cards.openRecord(card.id, 'status.md', null);
    expect(() => cards.editRecord(card.id, 'status.md', opened.headVersion + 1, 'content')).toThrow(RecordHeadMismatchError);
    expect(cards.readCurrentRecord(card.id, 'status.md').headVersion).toBe(opened.headVersion);
    expect(() => cards.openRecord(card.id, 'status.md', null)).toThrow(RecordHeadMismatchError);
  });

  it('rejects a stale close from the valid index before opening its malformed indexed head artifact', () => {
    const { cards, card } = setup();
    const definition = cards.recordReader.definition(card.id, 'status.md');
    const opened = cards.openRecord(card.id, 'status.md', null);
    const edited = cards.editRecord(card.id, 'status.md', opened.headVersion, 'content');
    const indexPath = cardRecordVersionIndexFile(cards.projectRoot, card.id, definition);
    const indexBytes = readFileSync(indexPath);
    const index = JSON.parse(indexBytes.toString('utf8')) as { current_filename: string };
    writeFileSync(cardRecordVersionFile(cards.projectRoot, card.id, definition, index.current_filename), 'complete malformed artifact\n');

    expect(() => cards.closeRecord(card.id, 'status.md', edited.headVersion - 1, 'executor')).toThrow(RecordHeadMismatchError);
    expect(readFileSync(indexPath)).toEqual(indexBytes);
  });

  it('uses typed absence only for unknown cards, empty current records, and unlisted history', () => {
    const { cards, card } = setup();
    expect(() => cards.readCurrentRecord('card-z', 'status.md')).toThrow(AuthoredRecordNotFoundError);
    expect(() => cards.readCurrentRecord(card.id, 'status.md')).toThrow(AuthoredRecordNotFoundError);
    expect(cards.readCurrentRecordOrNull(card.id, 'status.md')).toBeNull();
    expect(() => cards.readHistoricalRecord(card.id, 'status.md', 7)).toThrow(AuthoredRecordNotFoundError);
    expect(() => cards.recordReader.current(card.id, 'status.md')).toThrow(AuthoredRecordNotFoundError);
  });

  it('preserves malformed canonical and I/O failures instead of classifying them as absence', () => {
    const malformed = setup();
    writeFileSync(cardRecordVersionIndexFile(malformed.cards.projectRoot, malformed.card.id, malformed.cards.recordReader.definition(malformed.card.id, 'status.md')), 'complete malformed record\n');
    expect(() => malformed.cards.readCurrentRecord(malformed.card.id, 'status.md')).toThrow(/malformed/);

    const malformedCard = setup();
    writeFileSync(cardVersionIndexFile(malformedCard.cards.projectRoot, malformedCard.card.id), 'complete malformed card\n');
    expect(() => malformedCard.cards.readCurrentRecord(malformedCard.card.id, 'status.md')).toThrow(/malformed/);

    const missingBrief = setup();
    rmSync(cardRecordVersionIndexFile(missingBrief.cards.projectRoot, missingBrief.card.id, missingBrief.cards.recordReader.definition(missingBrief.card.id, 'brief.md')));
    expect(() => missingBrief.cards.readCurrentRecord(missingBrief.card.id, 'brief.md')).toThrow(expect.objectContaining({ code: 'ENOENT' }));

    const ioFailure = setup();
    const indexPath = cardRecordVersionIndexFile(ioFailure.cards.projectRoot, ioFailure.card.id, ioFailure.cards.recordReader.definition(ioFailure.card.id, 'status.md'));
    rmSync(indexPath);
    mkdirSync(indexPath);
    expect(() => ioFailure.cards.readCurrentRecord(ioFailure.card.id, 'status.md')).toThrow(expect.objectContaining({ code: expect.stringMatching(/EISDIR|EACCES/) }));
  });
});
