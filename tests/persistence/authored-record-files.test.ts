import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AuthoredRecordNotFoundError, RecordPriorHeadInvariantError, classifyCurrentAuthoredRecord, initializeDynamicAuthoredRecord } from '../../src/persistence/authored-record-files.js';
import { cardRecordRoot,cardRecordsRoot,cardRecordVersionFile, cardRecordVersionIndexFile,cardRecordVersionsRoot, cardVersionIndexFile } from '../../src/persistence/layout.js';
import type { RecordDefinition } from '../../src/records/record-definition.js';
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
  it('classifies a dynamic exact child only beneath a proven real records root and publishes its empty namespace once',()=>{
    const {cards,card}=setup();const definition:RecordDefinition={filename:'notes.md',format:'markdown',schema:'authored-record.v1',bootstrap:false,declared:false};const reads:string[]=[];
    expect(classifyCurrentAuthoredRecord(cards.projectRoot,card.id,definition,{onRead:(path)=>reads.push(path)})).toEqual({kind:'unclaimed'});
    expect(reads).toContain(cardRecordsRoot(cards.projectRoot,card.id));expect(reads).toContain(cardRecordRoot(cards.projectRoot,card.id,definition));
    initializeDynamicAuthoredRecord(cards.projectRoot,card.id,definition);
    expect(classifyCurrentAuthoredRecord(cards.projectRoot,card.id,definition)).toEqual({kind:'empty'});
    expect(()=>initializeDynamicAuthoredRecord(cards.projectRoot,card.id,definition)).toThrow(expect.objectContaining({code:'EEXIST'}));
  });

  it('fails closed for missing, non-directory, symlink, and claimed-indexless exact authority',()=>{
    const definition:RecordDefinition={filename:'notes.md',format:'markdown',schema:'authored-record.v1',bootstrap:false,declared:false};
    const missing=setup();rmSync(cardRecordsRoot(missing.cards.projectRoot,missing.card.id),{recursive:true});expect(()=>classifyCurrentAuthoredRecord(missing.cards.projectRoot,missing.card.id,definition)).toThrow(expect.objectContaining({code:'ENOENT'}));
    const fileRoot=setup();rmSync(cardRecordsRoot(fileRoot.cards.projectRoot,fileRoot.card.id),{recursive:true});writeFileSync(cardRecordsRoot(fileRoot.cards.projectRoot,fileRoot.card.id),'not a directory');expect(()=>classifyCurrentAuthoredRecord(fileRoot.cards.projectRoot,fileRoot.card.id,definition)).toThrow(/not a real directory/);
    const linked=setup();const root=cardRecordsRoot(linked.cards.projectRoot,linked.card.id);rmSync(root,{recursive:true});mkdirSync(`${root}-target`);symlinkSync(`${root}-target`,root);expect(()=>classifyCurrentAuthoredRecord(linked.cards.projectRoot,linked.card.id,definition)).toThrow(/not a real directory/);
    const claimed=setup();mkdirSync(cardRecordRoot(claimed.cards.projectRoot,claimed.card.id,definition));mkdirSync(cardRecordVersionsRoot(claimed.cards.projectRoot,claimed.card.id,definition));expect(()=>classifyCurrentAuthoredRecord(claimed.cards.projectRoot,claimed.card.id,definition)).toThrow(expect.objectContaining({code:'ENOENT'}));
  });
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
    expect(() => cards.editRecord(card.id, 'status.md', opened.headVersion + 1, 'content')).toThrow(RecordPriorHeadInvariantError);
    expect(cards.readCurrentRecord(card.id, 'status.md').headVersion).toBe(opened.headVersion);
    expect(() => cards.openRecord(card.id, 'status.md', null)).toThrow(RecordPriorHeadInvariantError);
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

    expect(() => cards.closeRecord(card.id, 'status.md', edited.headVersion - 1, 'executor')).toThrow(RecordPriorHeadInvariantError);
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

  it.each(['missing', 'malformed', 'mismatched'] as const)('rejects a %s indexed current artifact without changing its index', (fault) => {
    const { cards, card } = setup();
    const definition = cards.recordReader.definition(card.id, 'status.md');
    cards.openRecord(card.id, 'status.md', null);
    const indexPath = cardRecordVersionIndexFile(cards.projectRoot, card.id, definition);
    const indexBytes = readFileSync(indexPath);
    const index = JSON.parse(indexBytes.toString('utf8')) as { current_filename: string };
    const artifactPath = cardRecordVersionFile(cards.projectRoot, card.id, definition, index.current_filename);
    if (fault === 'missing') unlinkSync(artifactPath);
    else if (fault === 'malformed') writeFileSync(artifactPath, 'complete malformed artifact\n');
    else {
      const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as { card_id: string };
      writeFileSync(artifactPath, `${JSON.stringify({ ...artifact, card_id: 'card-z' })}\n`);
    }

    expect(() => cards.readCurrentRecord(card.id, 'status.md')).toThrow();
    expect(readFileSync(indexPath)).toEqual(indexBytes);
  });
});
