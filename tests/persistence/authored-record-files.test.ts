import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acceptAuthoredRecord,
  classifyCurrentAuthoredRecord,
  openAuthoredRecord,
  readAuthoredRecordVersionPair,
  inspectAuthoredRecordSelection,
  restoreAuthoredRecordSelection,
} from '../../src/persistence/authored-record-files.js';
import {
  cardAcceptedRecordFile,
  cardAcceptedRecordsRoot,
  cardRecordHeadFile,
  cardRecordPreviousHeadFile,
  cardHeadFile,
} from '../../src/persistence/layout.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';
import type { ReplacementFileIo } from '../../src/persistence/replace-file.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => {
  jest.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'saivage-record-head-'));
  roots.push(root);
  initProjectTree(root);
  const cards = new CardService(root);
  const card = cards.create({
    type: 'code',
    parent: 'project',
    title: 'card',
    bootstrap_content: 'brief',
    priority: 0,
    urgency: 'normal',
    created_by: 'analyst',
    depends_on: [],
  });
  return { root, cards, card };
}
function current(cards: CardService, cardId: string, name: string) {
  const result = cards.readRecordCurrent(cardId, name);
  if (result.kind !== 'found' || !result.value.projection) throw new Error('Missing test record.');
  return result.value.projection;
}
function history(cards: CardService, cardId: string, name: string) {
  const result = cards.readRecordHistory(cardId, name);
  if (result.kind !== 'found') throw new Error('Missing test card.');
  return result.value.catalog.versions;
}
const definition = {
  filename: 'status.md',
  format: 'markdown' as const,
  schema: 'work-status.v1',
  declared: true,
  bootstrap: false,
};

describe('exact record heads and accepted predecessor chains', () => {
  it.each(['replacement', 'initial'] as const)('fresh-restores exact previous accepted/draft selection in %s mode without predecessor reads', mode => {
    const { root, cards, card } = setup();
    cards.acceptRecord(card.id, 'status.md', 'first', 'analyst');
    cards.acceptRecord(card.id, 'status.md', 'second', 'analyst');
    cards.openRecord(card.id, 'status.md'); cards.editRecord(card.id, 'status.md', 'retained draft');
    cards.editRecord(card.id, 'status.md', 'lost draft');
    const path = cardRecordHeadFile(root, card.id, definition); const prev = cardRecordPreviousHeadFile(root, card.id, definition);
    const candidateBytes = readFileSync(prev); const before = readFileSync(path); const reads: string[] = [];
    const candidate = inspectAuthoredRecordSelection(root, card.id, definition, candidateBytes, {onRead:p=>reads.push(p)});
    expect(candidate.projection).toMatchObject({accepted:{content:'second'}, draft:{content:'retained draft'}});
    expect(reads).toEqual([cardAcceptedRecordFile(root, card.id, candidate.head.accepted!.entry_id)]);
    expect(readFileSync(path)).toEqual(before); expect(readFileSync(prev)).toEqual(candidateBytes);
    unlinkSync(path); if (mode === 'replacement') writeFileSync(path, '{bad');
    restoreAuthoredRecordSelection(root, card.id, definition, candidate.head, mode);
    const restored = current(cards, card.id, 'status.md');
    expect(restored).toEqual({...candidate.projection, headId:expect.any(String)});
    expect(restored.headId).not.toBe(candidate.head.head_id);
    if (mode === 'replacement') expect(readFileSync(prev, 'utf8')).toBe('{bad');
    else expect(existsSync(prev)).toBe(false);
  });
  it('refuses previous record owner/definition mismatch and damaged selected accepted content without changing selectors', () => {
    const { root, cards, card } = setup(); cards.acceptRecord(card.id, 'status.md', 'first', 'analyst'); cards.openRecord(card.id, 'status.md');
    const path = cardRecordHeadFile(root, card.id, definition); const prev = cardRecordPreviousHeadFile(root, card.id, definition);
    const before = readFileSync(path); const candidate = readFileSync(prev);
    expect(() => inspectAuthoredRecordSelection(root, card.id, {...definition, schema:'different.v1'}, candidate)).toThrow(/identity/);
    const selected = inspectAuthoredRecordSelection(root, card.id, definition, candidate);
    const artifactPath = cardAcceptedRecordFile(root, card.id, selected.head.accepted!.entry_id);
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')); artifact.accepted.content = 'tampered';
    writeFileSync(artifactPath, JSON.stringify(artifact));
    expect(() => inspectAuthoredRecordSelection(root, card.id, definition, candidate)).toThrow();
    expect(readFileSync(path)).toEqual(before); expect(readFileSync(prev)).toEqual(candidate);
  });
  it('retains whole head inodes on every acceptance and draft mutation, while normal reads ignore previous', () => {
    const { root, cards, card } = setup();
    const path = cardRecordHeadFile(root, card.id, definition);
    const previous = cardRecordPreviousHeadFile(root, card.id, definition);
    cards.acceptRecord(card.id, 'status.md', 'first', 'analyst');
    expect(existsSync(previous)).toBe(false);
    for (const publish of [() => cards.openRecord(card.id, 'status.md'), () => cards.editRecord(card.id, 'status.md', 'draft'), () => cards.discardRecord(card.id, 'status.md'), () => cards.openRecord(card.id, 'status.md'), () => cards.editRecord(card.id, 'status.md', 'accepted'), () => cards.closeRecord(card.id, 'status.md', 'executor'), () => cards.acceptRecord(card.id, 'status.md', 'second', 'analyst')]) {
      const before = readFileSync(path); const inode = statSync(path).ino; const priorId = current(cards, card.id, 'status.md').headId;
      publish();
      expect(statSync(previous).ino).toBe(inode); expect(readFileSync(previous)).toEqual(before);
      expect(current(cards, card.id, 'status.md').headId).not.toBe(priorId);
    }
    writeFileSync(previous, 'invalid previous'); const reads: string[] = [];
    expect(cards.readRecordCurrent(card.id, 'status.md', {onRead:path=>reads.push(path)}).kind).toBe('found');
    expect(cards.readRecordHistory(card.id, 'status.md', {onRead:path=>reads.push(path)}).kind).toBe('found');
    expect(reads).not.toContain(previous);
    const {head_id: _id, ...missingId} = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify(missingId)); expect(() => cards.readRecordCurrent(card.id, 'status.md')).toThrow();
  });
  function sparseFixture() {
    const value = setup(); const { cards, card, root } = value;
    cards.acceptRecord(card.id, 'status.md', 'one', 'analyst');
    for (const content of ['four', 'seven']) {
      cards.openRecord(card.id, 'status.md'); cards.discardRecord(card.id, 'status.md');
      cards.acceptRecord(card.id, 'status.md', content, 'analyst');
    }
    cards.acceptRecord(card.id, 'status.md', 'eight', 'analyst');
    const paths = new Map(history(cards, card.id, 'status.md').map(row => [row.version, cardAcceptedRecordFile(root, card.id, row.entry_id)]));
    return { ...value, paths };
  }
  it('selects numeric accepted pairs with one bounded traversal and exact content/provenance', () => {
    const { cards, card, paths } = sparseFixture(); const reads: string[] = [];
    expect(cards.diffRecordVersions(card.id, 'status.md', { from: 4, to: 8 }, { onRead: path => reads.push(path) })).toMatchObject({
      kind: 'found', value: { from: { revision: 4, accepted: { source_version: 4, content: 'four', writer_agent: 'analyst', card_version_seq: 1 } }, to: { revision: 8, accepted: { source_version: 8, content: 'eight' } }, target: { kind: 'version', version: 8 } },
    });
    for (const version of [4, 7, 8]) expect(reads.filter(path => path === paths.get(version))).toHaveLength(1);
    expect(reads).not.toContain(paths.get(1));
  });
  it('consumes the selected acceptance for above-head pivots without opening predecessors', () => {
    const { root, card, paths } = sparseFixture(); const reads: string[] = [];
    expect(readAuthoredRecordVersionPair(root, card, definition, { from: 9, to: 10 }, { onRead: path => reads.push(path) })).toEqual({ from: null, to: null });
    expect(reads.filter(path => path === paths.get(8))).toHaveLength(1);
    for (const version of [1, 4, 7]) expect(reads).not.toContain(paths.get(version));
    writeFileSync(paths.get(8)!, '{broken');
    expect(() => readAuthoredRecordVersionPair(root, card, definition, { from: 9, to: 10 })).toThrow();
  });
  it.each([
    [4, 4, { kind: 'found', value: { from: { revision: 4 }, to: { revision: 4 } } }],
    [5, 8, { kind: 'version-not-found', version: 5, side: 'from' }],
    [4, 6, { kind: 'version-not-found', version: 6, side: 'to' }],
    [5, 6, { kind: 'version-not-found', version: 5, side: 'from' }],
    [8, 4, { kind: 'invalid-pivots', from: 8, to: 4 }],
    [9, 10, { kind: 'version-not-found', version: 9, side: 'from' }],
    [4, 10, { kind: 'version-not-found', version: 10, side: 'to' }],
  ])('preserves accepted pivot semantics for %s → %s', (from, to, expected) => {
    const { cards, card } = sparseFixture();
    expect(cards.diffRecordVersions(card.id, 'status.md', { from: from as number, to: to as number })).toMatchObject(expected);
  });
  it.each(['missing', 'malformed', 'link'] as const)('rejects a reached %s acceptance before reporting a gap', fault => {
    const { cards, card, paths } = sparseFixture(); const path = paths.get(7)!;
    if (fault === 'missing') unlinkSync(path);
    else if (fault === 'malformed') writeFileSync(path, '{broken');
    else { const stored = JSON.parse(readFileSync(path, 'utf8')); stored.predecessor.version = stored.version; writeFileSync(path, JSON.stringify(stored)); }
    expect(() => cards.diffRecordVersions(card.id, 'status.md', { from: 5, to: 6 })).toThrow();
  });
  it('does not consume below an exact or gap stop, while preserving single-selector bounds', () => {
    const { cards, card, paths } = sparseFixture(); writeFileSync(paths.get(1)!, '{broken');
    expect(cards.diffRecordVersions(card.id, 'status.md', { from: 4, to: 8 }).kind).toBe('found');
    expect(cards.diffRecordVersions(card.id, 'status.md', { from: 5, to: 8 })).toEqual({ kind: 'version-not-found', version: 5, side: 'from' });
    expect(cards.readRecordVersion(card.id, 'status.md', 4).kind).toBe('found');
    expect(cards.readRecordVersion(card.id, 'status.md', 5)).toEqual({ kind: 'version-not-found', version: 5 });
    expect(() => cards.diffRecordVersions(card.id, 'status.md', { from: 2, to: 8 })).toThrow();
  });
  it('publishes bootstrap acceptance with actual initial ordinary provenance and leaves optional heads absent', () => {
    const { root, cards, card } = setup();
    const ordinary = JSON.parse(readFileSync(cardHeadFile(root, card.id), 'utf8')).ordinary;
    expect(current(cards, card.id, 'brief.md')).toMatchObject({
      revision: 1,
      state: 'closed',
      draft: null,
      accepted: {
        content: 'brief',
        card_version_seq: 1,
        card_history: ordinary,
        writer_agent: 'runtime:bootstrap',
      },
    });
    expect(existsSync(cardRecordHeadFile(root, card.id, definition))).toBe(false);
    expect(classifyCurrentAuthoredRecord(root, card, definition)).toEqual({ kind: 'empty' });
    expect(
      classifyCurrentAuthoredRecord(root, card, {
        ...definition,
        filename: 'notes.md',
        declared: false,
      }),
    ).toEqual({ kind: 'unclaimed' });
  });
  it('retains only accepted sparse versions; mutable edits count A→B→A and discard clears no accepted history', () => {
    const { root, cards, card } = setup();
    expect(cards.openRecord(card.id, 'status.md')).toMatchObject({
      revision: 1,
      acceptedVersionUrl: null,
      state: 'open',
    });
    const openedBytes = readFileSync(cardRecordHeadFile(root, card.id, definition));
    expect(cards.openRecord(card.id, 'status.md').revision).toBe(1);
    expect(readFileSync(cardRecordHeadFile(root, card.id, definition))).toEqual(openedBytes);
    cards.editRecord(card.id, 'status.md', 'A');
    cards.editRecord(card.id, 'status.md', 'B');
    cards.editRecord(card.id, 'status.md', 'A');
    expect(current(cards, card.id, 'status.md').revision).toBe(4);
    expect(history(cards, card.id, 'status.md')).toEqual([]);
    const closed = cards.closeRecord(card.id, 'status.md', 'executor');
    expect(closed).toMatchObject({
      revision: 5,
      state: 'closed',
      acceptedVersionUrl: `record:///status.md?card=${card.id}&v=5`,
      accepted: { content: 'A' },
    });
    const first = history(cards, card.id, 'status.md')[0]!;
    const firstBytes = readFileSync(cardAcceptedRecordFile(root, card.id, first.entry_id));
    cards.openRecord(card.id, 'status.md');
    cards.editRecord(card.id, 'status.md', 'later draft');
    cards.discardRecord(card.id, 'status.md');
    expect(current(cards, card.id, 'status.md')).toMatchObject({
      revision: 8,
      state: 'closed',
      draft: null,
      accepted: closed.accepted,
    });
    const next = cards.acceptRecord(card.id, 'status.md', 'accepted B', 'analyst');
    expect(next.revision).toBe(9);
    expect(history(cards, card.id, 'status.md').map((entry) => entry.version)).toEqual([5, 9]);
    expect(history(cards, card.id, 'status.md')[1]!.predecessor).toEqual({
      entry_id: first.entry_id,
      version: 5,
    });
    expect(readFileSync(cardAcceptedRecordFile(root, card.id, first.entry_id))).toEqual(firstBytes);
    for (const gap of [1, 2, 3, 4, 6, 7, 8])
      expect(cards.readRecordVersion(card.id, 'status.md', gap)).toEqual({
        kind: 'version-not-found',
        version: gap,
      });
  });
  it('keeps present empty heads distinct from missing optional or generic heads', () => {
    const { root, cards, card } = setup();
    cards.openRecord(card.id, 'status.md');
    cards.discardRecord(card.id, 'status.md');
    expect(current(cards, card.id, 'status.md')).toMatchObject({
      revision: 2,
      state: 'empty',
      draft: null,
      accepted: null,
      acceptedVersionUrl: null,
    });
    expect(classifyCurrentAuthoredRecord(root, card, definition)).toMatchObject({
      kind: 'present',
    });
    const dynamic = {
      ...definition,
      filename: 'card.md',
      schema: 'authored-record.v1',
      declared: false,
    };
    const before = readFileSync(cardHeadFile(root, card.id));
    openAuthoredRecord(root, card, dynamic);
    expect(existsSync(cardRecordHeadFile(root, card.id, dynamic))).toBe(true);
    expect(readFileSync(cardHeadFile(root, card.id))).toEqual(before);
  });
  it('captures observed queue-only mutation revision and real ordinary UUID separately at acceptance', () => {
    const { root, cards, card } = setup();
    const notification = {
      id: randomUUID(),
      content: 'notice',
      created_at: new Date().toISOString(),
    };
    cards.enqueueNotification(card.id, notification);
    cards.removeNotifications(card.id, [notification.id]);
    const accepted = cards.acceptRecord(card.id, 'status.md', 'accepted', 'analyst');
    const ordinary = JSON.parse(readFileSync(cardHeadFile(root, card.id), 'utf8')).ordinary;
    expect(accepted).toMatchObject({
      revision: 1,
      accepted: { card_version_seq: 3, card_history: ordinary },
    });
    expect(ordinary.version).toBe(1);
  });
  it('preserves crash-left draft after owner recreation and rejects explicit Analyst acceptance', () => {
    const { root, cards, card } = setup();
    cards.openRecord(card.id, 'status.md');
    cards.editRecord(card.id, 'status.md', 'unfinished');
    const restarted = new CardService(root);
    expect(current(restarted, card.id, 'status.md')).toMatchObject({
      revision: 2,
      state: 'open',
      draft: { content: 'unfinished' },
    });
    expect(() => restarted.acceptRecord(card.id, 'status.md', 'replacement', 'analyst')).toThrow(
      /draft/,
    );
    expect(history(restarted, card.id, 'status.md')).toEqual([]);
    expect(restarted.closeRecord(card.id, 'status.md', 'executor').accepted?.content).toBe(
      'unfinished',
    );
  });
  it('consumes selected current only and detects corrupt or missing predecessors at history use without fallback', () => {
    const { root, cards, card } = setup();
    cards.acceptRecord(card.id, 'status.md', 'A', 'analyst');
    cards.acceptRecord(card.id, 'status.md', 'B', 'analyst');
    const first = history(cards, card.id, 'status.md')[0]!;
    const path = cardAcceptedRecordFile(root, card.id, first.entry_id);
    writeFileSync(path, '{broken');
    expect(current(cards, card.id, 'status.md').accepted?.content).toBe('B');
    expect(cards.readRecordVersion(card.id, 'status.md', 2).kind).toBe('found');
    expect(() => cards.readRecordVersion(card.id, 'status.md', 1)).toThrow();
    expect(() => history(cards, card.id, 'status.md')).toThrow();
    unlinkSync(path);
    expect(() => cards.readRecordVersion(card.id, 'status.md', 1)).toThrow();
  });
  it.each([
    'head-identity',
    'accepted-identity',
    'link-order',
    'selected-missing',
    'head-malformed',
    'head-utf8',
  ] as const)('fails strictly at exact consumed %s without rewriting', (fault) => {
    const { root, cards, card } = setup();
    cards.acceptRecord(card.id, 'status.md', 'A', 'analyst');
    const headPath = cardRecordHeadFile(root, card.id, definition);
    const head = JSON.parse(readFileSync(headPath, 'utf8'));
    const acceptedPath = cardAcceptedRecordFile(root, card.id, head.accepted.entry_id);
    let path = headPath;
    if (fault === 'head-identity') {
      head.record_name = 'other.md';
      writeFileSync(path, JSON.stringify(head));
    }
    if (fault === 'head-malformed') writeFileSync(path, '{broken');
    if (fault === 'head-utf8') writeFileSync(path, Buffer.from([0xff]));
    if (fault === 'selected-missing') {
      unlinkSync(acceptedPath);
    }
    if (fault === 'accepted-identity' || fault === 'link-order') {
      path = acceptedPath;
      const accepted = JSON.parse(readFileSync(path, 'utf8'));
      if (fault === 'accepted-identity') accepted.record_name = 'other.md';
      else accepted.predecessor = { entry_id: randomUUID(), version: accepted.version };
      writeFileSync(path, JSON.stringify(accepted));
    }
    const before = readFileSync(path);
    expect(() => current(cards, card.id, 'status.md')).toThrow();
    expect(() => cards.acceptRecord(card.id, 'status.md', 'B', 'analyst')).toThrow();
    expect(readFileSync(path)).toEqual(before);
  });
  it('tags current draft diff separately from immutable accepted selectors', () => {
    const { cards, card } = setup();
    cards.acceptRecord(card.id, 'status.md', 'A', 'analyst');
    cards.openRecord(card.id, 'status.md');
    cards.editRecord(card.id, 'status.md', 'B');
    expect(
      cards.diffRecordVersions(card.id, 'status.md', { from: 1, to: 'current' }),
    ).toMatchObject({
      kind: 'found',
      value: {
        from: { accepted: { content: 'A' }, draft: null },
        to: { draft: { content: 'B' }, accepted: { content: 'A' } },
        target: { kind: 'current', revision: 3, accepted_version: 1 },
      },
    });
    expect(cards.diffRecordVersions(card.id, 'status.md', { from: 1, to: 1 })).toMatchObject({
      kind: 'found',
      value: { target: { kind: 'version', version: 1 } },
    });
    expect(cards.diffRecordVersions(card.id, 'status.md', { from: 1, to: 2 })).toEqual({
      kind: 'version-not-found',
      version: 2,
      side: 'to',
    });
  });
  it('stops immediately on uncertain head selection after accepted publication without follow-up reads', () => {
    const { root, cards, card } = setup();
    cards.acceptRecord(card.id, 'status.md', 'A', 'analyst');
    const headPath = cardRecordHeadFile(root, card.id, definition);
    const before = readFileSync(headPath);
    const calls: string[] = [];
    const io: ReplacementFileIo = {
      open: (...args) => {
        calls.push('open');
        return openSync(...args);
      },
      write: writeSync,
      fsync: fsyncSync,
      close: closeSync,
      rename: (from, to) => {
        calls.push('rename');
        if (to === headPath) throw new Error('head rename failed');
        renameSync(from, to);
      },
    };
    expect(() => acceptAuthoredRecord(root, card, definition, 'B', 'analyst', io)).toThrow(
      PublicationOutcomeUnknownError,
    );
    expect(calls.at(-1)).toBe('rename');
    expect(readFileSync(headPath)).toEqual(before);
    expect(current(cards, card.id, 'status.md').accepted?.content).toBe('A');
    expect(history(cards, card.id, 'status.md')).toHaveLength(1);
  });
  it.each([
    'temporary-open',
    'write',
    'file-sync',
    'file-close',
    'rename',
    'parent-open',
    'parent-sync',
    'parent-close',
  ] as const)('ends accepted publication on %s failure before selecting a record head', (fault) => {
    const { root, card } = setup();
    const calls: string[] = [];
    const parents = new Set<number>();
    const error = new Error(`accepted ${fault} failed`);
    const step = (name: string) => {
      calls.push(name);
      if (name === fault) throw error;
    };
    const acceptedRoot = cardAcceptedRecordsRoot(root, card.id);
    const io: ReplacementFileIo = {
      open: (path, flags) => {
        const parent = path === acceptedRoot;
        step(parent ? 'parent-open' : 'temporary-open');
        const fd = openSync(path, flags);
        if (parent) parents.add(fd);
        return fd;
      },
      write: ((...args: Parameters<typeof writeSync>) => {
        step('write');
        return writeSync(...args);
      }) as typeof writeSync,
      fsync: (fd) => {
        step(parents.has(fd) ? 'parent-sync' : 'file-sync');
        fsyncSync(fd);
      },
      close: (fd) => {
        step(parents.has(fd) ? 'parent-close' : 'file-close');
        closeSync(fd);
      },
      rename: (from, to) => {
        step('rename');
        renameSync(from, to);
      },
    };
    expect(() =>
      acceptAuthoredRecord(root, card, definition, 'new acceptance', 'analyst', io),
    ).toThrow(
      fault.startsWith('parent-') || fault === 'rename' ? PublicationOutcomeUnknownError : error,
    );
    expect(calls.at(-1)).toBe(fault);
    expect(existsSync(cardRecordHeadFile(root, card.id, definition))).toBe(false);
    expect(classifyCurrentAuthoredRecord(root, card, definition)).toEqual({ kind: 'empty' });
  });
  it('refuses temporary collision without replacing it or creating a head', () => {
    const { root, card } = setup();
    const temp = '11111111-1111-4111-8111-111111111111';
    const path = cardRecordHeadFile(root, card.id, definition);
    const temporaryPath = join(
      root,
      '.saivage',
      'cards',
      'project',
      'children',
      'a',
      'records',
      `.record-status.json.${temp}.saivage-tmp`,
    );
    writeFileSync(temporaryPath, 'collision');
    const temporary = () => temp;
    expect(() => openAuthoredRecord(root, card, definition, undefined, temporary)).toThrow();
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(temporaryPath, 'utf8')).toBe('collision');
  });
  it.each([
    { operation: 'open', offset: 1, unknown: false },
    { operation: 'write', offset: 2, unknown: false },
    { operation: 'fsync', offset: 3, unknown: false },
    { operation: 'close', offset: 4, unknown: false },
    { operation: 'rename', offset: 5, unknown: true },
    { operation: 'open', offset: 6, unknown: true },
    { operation: 'fsync', offset: 7, unknown: true },
    { operation: 'close', offset: 8, unknown: true },
  ])('ends record head selection at $operation stage $offset without hints or further effects', ({ operation, offset, unknown }) => {
    for (const mutation of ['accept', 'close'] as const) {
      const { root, cards, card } = setup();
      cards.acceptRecord(card.id, 'status.md', 'baseline', 'analyst');
      if (mutation === 'close') {
        cards.openRecord(card.id, 'status.md');
        cards.editRecord(card.id, 'status.md', 'unfinished');
      }
      const headPath = cardRecordHeadFile(root, card.id, definition);
      const before = readFileSync(headPath);
      const operations: string[] = [];
      const fault = new Error('record head publication failed');
      const hit = (name: string) => {
        operations.push(name);
        if (operations.length === 11 + offset) { expect(name).toBe(operation); throw fault; }
      };
      const io: ReplacementFileIo = {
        open: (...args) => { hit('open'); return openSync(...args); },
        write: ((...args: Parameters<typeof writeSync>) => { hit('write'); return writeSync(...args); }) as typeof writeSync,
        fsync: fd => { hit('fsync'); fsyncSync(fd); },
        close: fd => { hit('close'); closeSync(fd); },
        rename: (from, to) => { hit('rename'); renameSync(from, to); },
      };
      const freshness = { cardProjectionChanged: jest.fn(), runtimeChanged: jest.fn(), agentMembershipChanged: jest.fn() };
      const failing = new CardService(root, freshness, io);
      let caught: unknown;
      try {
        if (mutation === 'accept') failing.acceptRecord(card.id, 'status.md', 'new accepted', 'analyst');
        else failing.closeRecord(card.id, 'status.md', 'executor');
      } catch (error) { caught = error; }
      if (unknown) expect(caught).toBeInstanceOf(PublicationOutcomeUnknownError);
      else expect(caught).toBe(fault);
      expect(operations).toHaveLength(11 + offset);
      for (const effect of Object.values(freshness)) expect(effect).not.toHaveBeenCalled();
      if (offset <= 5) expect(readFileSync(headPath)).toEqual(before);
    }
  });
});
