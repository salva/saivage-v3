import { afterEach, describe, expect, it } from '@jest/globals';
import { closeSync, existsSync, fstatSync, fsyncSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AuthoredRecordNotFoundError, classifyCurrentAuthoredRecord, initializeAuthoredRecord, openAuthoredRecord, readCurrentAuthoredRecord } from '../../src/persistence/authored-record-files.js';
import { readStrictCanonicalGrowingFile } from '../../src/persistence/growing-file.js';
import { authoredRecordVersionArtifactSchema, type AuthoredRecordVersionArtifact } from '../../src/persistence/canonical-record-artifacts.js';
import { cardRecordStreamFile, cardStreamFile } from '../../src/persistence/layout.js';
import type { RecordDefinition } from '../../src/records/record-definition.js';
import type { CanonicalReadInstrumentation,GrowingFileIo } from '../../src/persistence/growing-file.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'saivage-record-stream-'));
  roots.push(root);
  initProjectTree(root);
  const cards = new CardService(root);
  const card = cards.create({ type: 'code', parent: 'project', title: 'card', bootstrap_content: 'brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
  return { cards, card, root };
}

function statusDefinition(overrides: Partial<RecordDefinition> = {}): RecordDefinition { return { filename: 'status.md', format: 'markdown', schema: 'work-status.v1', bootstrap: false, declared: true, ...overrides }; }
function streamPath(root: string, cardId: string, filename: string): string { return cardRecordStreamFile(root, cardId, { filename: filename as never }); }
function recordRows(root: string, cardId: string, definition: RecordDefinition): AuthoredRecordVersionArtifact[] { return readStrictCanonicalGrowingFile(cardRecordStreamFile(root, cardId, definition), authoredRecordVersionArtifactSchema); }
function current(cards:CardService,cardId:string,name:string){const result=cards.readRecordCurrent(cardId,name);if(result.kind!=='found'||!result.value.projection)throw new AuthoredRecordNotFoundError();return result.value.projection;}
function historical(cards:CardService,cardId:string,name:string,version:number){const result=cards.readRecordVersion(cardId,name,version);if(result.kind!=='found')throw new AuthoredRecordNotFoundError();return result.value.projection;}

describe('authored record exact streams', () => {
  it('reads one active path and one record stream for each complete record operation',()=>{
    const {cards,card,root}=setup();cards.openRecord(card.id,'status.md');const expected=[cardStreamFile(root,'project'),cardStreamFile(root,card.id),streamPath(root,card.id,'status.md')];
    for(const read of [(i:CanonicalReadInstrumentation)=>cards.readRecordCurrent(card.id,'status.md',i),(i:CanonicalReadInstrumentation)=>cards.readRecordHistory(card.id,'status.md',i),(i:CanonicalReadInstrumentation)=>cards.readRecordVersion(card.id,'status.md',1,i),(i:CanonicalReadInstrumentation)=>cards.diffRecordVersions(card.id,'status.md',{from:1,to:1},i)]){const paths:string[]=[];read({onRead:(path)=>paths.push(path)});expect(paths).toEqual(expected);}
  });

  it('publishes the bootstrap record as one nonempty first envelope and creates no optional or dynamic stream', () => {
    const { cards, card, root } = setup();
    expect(existsSync(streamPath(root, card.id, 'brief.md'))).toBe(true);
    const firstEnvelope = readFileSync(streamPath(root, card.id, 'brief.md'), 'utf8').trimEnd().split('\n');
    expect(firstEnvelope).toHaveLength(1);
    const brief = readCurrentAuthoredRecord(root, card, statusDefinition({ filename: 'brief.md', schema: 'card-brief.v1', bootstrap: true }));
    expect(brief).toMatchObject({ headVersion: 1, artifact: { state: 'closed', accepted: { writer_agent: 'runtime:bootstrap', content: 'brief' } } });
    expect(existsSync(streamPath(root, card.id, 'status.md'))).toBe(false);
    expect(existsSync(streamPath(root, card.id, 'review.md'))).toBe(false);
    expect(cards.readRecordCurrent(card.id,'status.md')).toMatchObject({kind:'found',value:{projection:null}});
  });

  it('classifies a missing declared stream as empty and a missing undeclared stream as unclaimed without creating files', () => {
    const { card, root } = setup();
    const declared = statusDefinition();
    const dynamic = statusDefinition({ filename: 'notes.md', schema: 'authored-record.v1', declared: false });
    expect(classifyCurrentAuthoredRecord(root, card, declared)).toEqual({ kind: 'empty' });
    expect(classifyCurrentAuthoredRecord(root, card, dynamic)).toEqual({ kind: 'unclaimed' });
    expect(existsSync(streamPath(root, card.id, 'status.md'))).toBe(false);
    expect(existsSync(streamPath(root, card.id, 'notes.md'))).toBe(false);
  });

  it('publishes dynamic first publication directly with no empty file', () => {
    const { card, root } = setup();
    const dynamic = statusDefinition({ filename: 'notes.md', schema: 'authored-record.v1', declared: false });
    const opened = openAuthoredRecord(root, card, dynamic);
    const path = streamPath(root, card.id, 'notes.md');
    expect(opened).toMatchObject({ headVersion: 1, artifact: { state: 'open' } });
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).byteLength).toBeGreaterThan(0);
    expect(readFileSync(path).at(-1)).toBe(0x0a);
    expect(classifyCurrentAuthoredRecord(root, card, dynamic)).toMatchObject({ kind: 'present', projection: { headVersion: 1 } });
  });

  it('publishes one envelope per open, edit, close, discard, and reopen mutation with contiguous versions and singular URLs', () => {
    const { cards, card, root } = setup();
    const admitted=cards.readRecordCurrent(card.id,'status.md');if(admitted.kind!=='found')throw new Error('missing card');const definition=admitted.value.definition;
    const path = streamPath(root, card.id, 'status.md');
    const opened = cards.openRecord(card.id, 'status.md');
    expect(opened).toMatchObject({ headVersion: 1, currentUrl: `record:///status.md?card=${encodeURIComponent(card.id)}`, versionUrl: `record:///status.md?card=${encodeURIComponent(card.id)}&v=1`, artifact: { state: 'open' } });
    expect(readFileSync(path, 'utf8').trimEnd().split('\n')).toHaveLength(1);

    const edited = cards.editRecord(card.id, 'status.md', 'closed content');
    const earlierCardVersion = cards.read(card.id)!.version_seq;
    const advanced = cards.editCard(card.id, { title: 'advanced before close' }, 'planner');
    expect(advanced.version_seq).toBe(earlierCardVersion + 1);
    const closed = cards.closeRecord(card.id, 'status.md', 'executor');
    expect(closed.headVersion).toBe(3);
    expect(closed.artifact.accepted?.content).toBe('closed content');
    expect(closed.artifact.accepted?.card_version_seq).toBe(advanced.version_seq);
    expect(closed.artifact.accepted?.card_version_seq).not.toBe(earlierCardVersion);
    expect(historical(cards,card.id,'status.md',1).artifact.state).toBe('open');
    expect(current(cards,card.id,'status.md').artifact).toEqual(closed.artifact);

    const reopened = cards.openRecord(card.id, 'status.md');
    expect(reopened.artifact.accepted).toEqual(closed.artifact.accepted);
    const discarded = cards.discardRecord(card.id, 'status.md', 'not needed');
    expect(discarded).toMatchObject({ headVersion: 5, artifact: { state: 'discarded', accepted: closed.artifact.accepted } });
    expect(cards.openRecord(card.id, 'status.md').headVersion).toBe(6);

    const rows = recordRows(root, card.id, definition);
    expect(rows.map(({ version }) => version)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows.map(({ state }) => state)).toEqual(['open', 'open', 'closed', 'open', 'discarded', 'open']);
    expect(readFileSync(path, 'utf8').trimEnd().split('\n')).toHaveLength(6);
  });

  it('treats opening an already-open record as a no-op that appends nothing', () => {
    const { cards, card, root } = setup();
    cards.openRecord(card.id, 'status.md');
    const path = streamPath(root, card.id, 'status.md');
    const before = readFileSync(path);
    const reopened = cards.openRecord(card.id, 'status.md');
    expect(reopened.headVersion).toBe(1);
    expect(readFileSync(path)).toEqual(before);
  });

  it('uses typed absence only for unknown cards, empty current records, and unlisted history', () => {
    const { cards, card } = setup();
    expect(cards.readRecordCurrent('card-z','status.md')).toEqual({kind:'card-not-found'});
    expect(cards.readRecordCurrent(card.id,'status.md')).toMatchObject({kind:'found',value:{projection:null}});
    expect(cards.readRecordVersion(card.id,'status.md',7)).toEqual({kind:'version-not-found',version:7});
  });

  it.each(['malformed', 'empty', 'nonstream'] as const)('fails fast on a %s record stream without mutation', (fault) => {
    const { cards, card, root } = setup();
    cards.openRecord(card.id, 'status.md');
    const path = streamPath(root, card.id, 'status.md');
    if (fault === 'malformed') writeFileSync(path, 'complete malformed record\n');
    else if (fault === 'empty') writeFileSync(path, '');
    else writeFileSync(path, `${JSON.stringify({ hello: 'world' })}\n`);
    const before = readFileSync(path);
    expect(() => cards.readRecordCurrent(card.id, 'status.md')).toThrow();
    expect(() => cards.editRecord(card.id, 'status.md', 'content')).toThrow();
    expect(() => cards.readRecordVersion(card.id, 'status.md', 1)).toThrow();
    expect(readFileSync(path)).toEqual(before);
  });

  it('fails closed for non-file and symlink stream paths', () => {
    const definition = statusDefinition({ filename: 'notes.md', declared: false });
    const dirStream = setup(); mkdirSync(streamPath(dirStream.root, dirStream.card.id, 'notes.md')); expect(() => classifyCurrentAuthoredRecord(dirStream.root, dirStream.card, definition)).toThrow();
    const linked = setup(); const target = streamPath(linked.root, linked.card.id, 'notes.md'); mkdirSync(`${target}-dir`); symlinkSync(`${target}-dir`, target); expect(() => classifyCurrentAuthoredRecord(linked.root, linked.card, definition)).toThrow();
  });

  it('rejects streams that violate the fold contract', () => {
    const { card, root } = setup();
    const definition = statusDefinition({ filename: 'brief2.md', schema: 'card-brief.v1', bootstrap: true, declared: true });
    expect(() => openAuthoredRecord(root, card, definition)).toThrow(/bootstrap/);
    const bootstrap = initializeAuthoredRecord(root, card.id, definition, 'bootstrap content');
    expect(bootstrap?.headVersion).toBe(1);
    const wrongIdentity = statusDefinition({ filename: 'status.md' });
    writeFileSync(streamPath(root, card.id, 'status.md'), '');
    expect(() => classifyCurrentAuthoredRecord(root, card, wrongIdentity)).toThrow(/empty/);
  });

  it('maps configured bootstrap and dynamic card.md records onto record-card.jsonl and never touches card authority', () => {
    const { cards, card, root } = setup();
    const configuredCardMd = statusDefinition({ filename: 'card.md', schema: 'card-doc.v1', bootstrap: true });
    const bootstrap = initializeAuthoredRecord(root, card.id, configuredCardMd, 'card.md bootstrap');
    expect(bootstrap?.versionUrl).toBe(`record:///card.md?card=${encodeURIComponent(card.id)}&v=1`);
    expect(existsSync(streamPath(root, card.id, 'card.md'))).toBe(true);
    expect(streamPath(root, card.id, 'card.md')).not.toBe(cardStreamFile(root, card.id));

    const other = cards.create({ type: 'code', parent: 'project', title: 'other', bootstrap_content: 'brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const dynamicCardMd = statusDefinition({ filename: 'card.md', declared: false });
    expect(classifyCurrentAuthoredRecord(root, other, dynamicCardMd)).toEqual({ kind: 'unclaimed' });
    const otherCardAuthority = cardStreamFile(root, other.id);
    const before = readFileSync(otherCardAuthority);
    const opened = openAuthoredRecord(root, other, dynamicCardMd);
    expect(opened).toMatchObject({ headVersion: 1, artifact: { state: 'open', accepted: null } });
    expect(existsSync(streamPath(root, other.id, 'card.md'))).toBe(true);
    expect(readFileSync(otherCardAuthority)).toEqual(before);
  });

  it('propagates append outcome-unknown without reread, retry, or stream change', () => {
    const { card, root } = setup();
    const definition = statusDefinition({ filename: 'status.md', declared: true });
    const cardsWithIo = new CardService(root, undefined, {
      open: openSync,
      stat: fstatSync,
      write: (() => { const failure = new Error('simulated append failure') as NodeJS.ErrnoException; failure.code = 'EIO'; throw failure; }) as typeof writeSync,
      fsync: fsyncSync,
      close: closeSync,
    } satisfies GrowingFileIo);
    cardsWithIo.openRecord(card.id, 'status.md');
    const path = streamPath(root, card.id, 'status.md');
    const before = readFileSync(path);
    expect(() => cardsWithIo.editRecord(card.id, 'status.md', 'content')).toThrow(PublicationOutcomeUnknownError);
    expect(readFileSync(path)).toEqual(before);
    expect(recordRows(root, card.id, definition)).toHaveLength(1);
  });
});
