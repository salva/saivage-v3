import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { cardHeadFile, cardPreviousHeadFile, cardHistoryFile, cardMailboxFile } from '../../src/persistence/layout.js';
import { cardHeadSchema } from '../../src/persistence/canonical-card-artifacts.js';
import { readCanonicalLinkedCardHistoryTree, readCommittedCardVersionPair } from '../../src/persistence/card-files.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';
import type { ReplacementFileIo } from '../../src/persistence/replace-file.js';
import { workflowResult } from '../helpers/workflow-result.js';
import { CanonicalCardFilesReadModel } from '../../src/application/read-models/canonical-card-files-read-model.js';
import { buildContentPolicyReadModel } from '../../src/application/read-models/content-policy-read-model.js';
import { COMPACTION_SUMMARY_BLOCKED_SUMMARY, CONTENT_POLICY_REFUSAL_BLOCKED_SUMMARY } from '../../src/schemas/index.js';

const roots: string[] = [];
afterEach(() => { jest.useRealTimers(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function fixture(io?: ReplacementFileIo) {
  const root = mkdtempSync(join(tmpdir(), 'saivage-card-head-')); roots.push(root); initProjectTree(root);
  const cards = new CardService(root, undefined, io);
  const child = cards.create({ type: 'code', parent: 'project', title: 'before', bootstrap_content: 'brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
  return { root, cards, child };
}
function head(root: string, id: string) { return cardHeadSchema.parse(JSON.parse(readFileSync(cardHeadFile(root, id), 'utf8'))); }
function notice() { return { id: randomUUID(), content: 'private mailbox body', created_at: '2026-10-02T00:00:00.000Z', source: 'analyst_correction' }; }
const io: ReplacementFileIo = { open: openSync, write: writeSync, fsync: fsyncSync, close: closeSync, rename: renameSync };

describe('card immutable history and pending-only mailbox', () => {
  it('maintains the whole previous head for ordinary, queue, lifecycle and tombstone publications with fresh IDs', () => {
    const { root, cards, child } = fixture(); const path = cardHeadFile(root, child.id); const previous = cardPreviousHeadFile(root, child.id);
    expect(existsSync(previous)).toBe(false);
    const message = notice();
    for (const publish of [() => cards.editCard(child.id, {title:'new'}), () => cards.enqueueNotification(child.id, message), () => cards.removeNotifications(child.id, [message.id]), () => cards.setStatus(child.id, 'running'), () => cards.stopRunning(child.id), () => cards.deleteSubtrees([child.id], () => true, 'analyst')]) {
      const before = readFileSync(path); const inode = statSync(path).ino;
      const id = head(root, child.id).head_id;
      publish();
      expect(statSync(previous).ino).toBe(inode);
      expect(readFileSync(previous)).toEqual(before);
      expect(head(root, child.id).head_id).not.toBe(id);
    }
  });
  it('never consumes previous bytes in current/history reads or falls back when current is invalid', () => {
    const { root, cards, child } = fixture(); cards.editCard(child.id, { title:'new' });
    const previous = cardPreviousHeadFile(root, child.id); writeFileSync(previous, 'not a head');
    const reads: string[] = [];
    expect(cards.getCardDetail(child.id, {onRead:path=>reads.push(path)}).kind).toBe('found');
    expect(cards.listCardVersions(child.id, {onRead:path=>reads.push(path)}).kind).toBe('found');
    expect(reads).not.toContain(previous);
    const selected = head(root, child.id); const {head_id: _id, ...missingId} = selected;
    writeFileSync(cardHeadFile(root, child.id), JSON.stringify(missingId));
    expect(() => cards.read(child.id)).toThrow();
  });
  function sparseFixture() {
    const value = fixture(); const { cards, child } = value;
    for (const title of ['four', 'seven']) {
      const message = notice(); cards.enqueueNotification(child.id, message); cards.removeNotifications(child.id, [message.id]);
      cards.editCard(child.id, { title });
    }
    cards.editCard(child.id, { title: 'eight' });
    const paths = new Map<number, string>();
    for (const version of [1, 4, 7, 8]) {
      const selected = cards.readCardVersion(child.id, version);
      if (selected.kind !== 'found') throw new Error('Missing test version.');
      paths.set(version, cardHistoryFile(value.root, child.id, selected.value.entry_id));
    }
    return { ...value, paths };
  }
  it('selects numeric pairs with one bounded predecessor traversal and exact provenance', () => {
    const { cards, child, paths } = sparseFixture(); const reads: string[] = [];
    const result = cards.diffCardVersions(child.id, { fromVersion: 4, toVersion: 8 }, { onRead: path => reads.push(path) });
    expect(result).toMatchObject({ kind: 'found', fromArtifact: { version: 4, card: { title: 'four' } }, toArtifact: { version: 8, card: { title: 'eight' } }, target: { kind: 'version', version: 8 } });
    for (const version of [4, 7]) expect(reads.filter(path => path === paths.get(version))).toHaveLength(1);
    expect(reads).not.toContain(paths.get(1));
  });
  it('consumes the selected head even for above-head pivots and no predecessor', () => {
    const { root, child, paths } = sparseFixture(); const reads: string[] = [];
    expect(readCommittedCardVersionPair(root, child.id, { from: 9, to: 10 }, { onRead: path => reads.push(path) })).toEqual({ kind: 'found', value: { from: null, to: null } });
    expect(reads.filter(path => path === paths.get(8))).toHaveLength(1);
    for (const version of [1, 4, 7]) expect(reads).not.toContain(paths.get(version));
    writeFileSync(paths.get(8)!, '{broken');
    expect(() => readCommittedCardVersionPair(root, child.id, { from: 9, to: 10 })).toThrow();
  });
  it.each([
    [4, 4, { kind: 'found', fromArtifact: { version: 4 }, toArtifact: { version: 4 } }],
    [5, 8, { kind: 'version-not-found', version: 5, side: 'from' }],
    [4, 6, { kind: 'version-not-found', version: 6, side: 'to' }],
    [5, 6, { kind: 'version-not-found', version: 5, side: 'from' }],
    [8, 4, { kind: 'invalid-pivots', from: 8, to: 4 }],
    [9, 10, { kind: 'version-not-found', version: 9, side: 'from' }],
    [4, 10, { kind: 'version-not-found', version: 10, side: 'to' }],
  ])('preserves numeric pivot semantics for %s → %s', (fromVersion, toVersion, expected) => {
    const { cards, child } = sparseFixture();
    expect(cards.diffCardVersions(child.id, { fromVersion: fromVersion as number, toVersion: toVersion as number })).toMatchObject(expected);
  });
  it.each(['missing', 'malformed', 'link', 'transition'] as const)('rejects a reached %s intermediate before reporting a gap', fault => {
    const { cards, child, paths } = sparseFixture(); const path = paths.get(7)!;
    if (fault === 'missing') unlinkSync(path);
    else if (fault === 'malformed') writeFileSync(path, '{broken');
    else { const stored = JSON.parse(readFileSync(path, 'utf8')); if (fault === 'link') stored.predecessor.version = 2; else stored.card.created_at = '2020-01-01T00:00:00.000Z'; writeFileSync(path, JSON.stringify(stored)); }
    expect(() => cards.diffCardVersions(child.id, { fromVersion: 5, toVersion: 6 })).toThrow();
  });
  it('does not open below exact or sparse-gap stopping artifacts but rejects that artifact when reached', () => {
    const { cards, child, paths } = sparseFixture(); writeFileSync(paths.get(1)!, '{broken');
    expect(cards.diffCardVersions(child.id, { fromVersion: 4, toVersion: 8 }).kind).toBe('found');
    expect(cards.diffCardVersions(child.id, { fromVersion: 5, toVersion: 8 })).toEqual({ kind: 'version-not-found', version: 5, side: 'from' });
    expect(() => cards.diffCardVersions(child.id, { fromVersion: 2, toVersion: 8 })).toThrow();
  });
  it('retains content-policy evidence through ordinary predecessors without opening cleared mailbox bodies', () => {
    const { root, cards, child } = fixture(); const message = notice(); cards.enqueueNotification(child.id, message); cards.setStatus(child.id, 'running');
    const settledAt = new Date().toISOString(); cards.commitActivationOutcome(child.id, { status: 'blocked', summary: CONTENT_POLICY_REFUSAL_BLOCKED_SUMMARY,
      result: { kind: 'content-policy-refusal', summary: CONTENT_POLICY_REFUSAL_BLOCKED_SUMMARY, session_id: `agent:executor:${child.id}`, marker_id: 'marker', evidence_url: '/evidence' } }, settledAt);
    writeFileSync(cardMailboxFile(root, child.id, message.id), 'forgotten invalid bytes'); cards.setStatus(child.id, 'changed');
    expect(buildContentPolicyReadModel(root)).toMatchObject({ refusal_high_water: 1, latest: { card_id: child.id, blocked_at: settledAt } });
  });

  it('retains strict compaction-summary BLOCKED result and ordinary reopening without inventing policy evidence', () => {
    const { root, cards, child } = fixture(); cards.setStatus(child.id, 'running');
    cards.commitActivationOutcome(child.id, { status: 'blocked', summary: COMPACTION_SUMMARY_BLOCKED_SUMMARY,
      result: { kind: 'compaction-summary-blocked', summary: COMPACTION_SUMMARY_BLOCKED_SUMMARY, session_id: `agent:executor:${child.id}`, summary_input_id: randomUUID() } }, new Date().toISOString());
    expect(cards.readCardVersion(child.id, 3)).toMatchObject({ kind: 'found', value: { card: { lifecycle: { status: 'blocked', result: { kind: 'compaction-summary-blocked' } } }, change: { terminal_summary: { content_policy: null } } } });
    expect(buildContentPolicyReadModel(root)).toEqual({ refusal_high_water: 0, latest: null });
    cards.setStatus(child.id, 'running'); expect(cards.read(child.id)).toMatchObject({ lifecycle: { status: 'running', result: null } });
  });
  it('projects Files current revision and retained history separately without physical mailbox/history paths', () => {
    const { root, cards, child } = fixture(); const files = new CanonicalCardFilesReadModel(() => cards);
    const path = '.saivage/cards/project/children/a/card.json'; const historical = files.content(`${path}?v=1`);
    const message = notice(); cards.enqueueNotification(child.id, message); cards.removeNotifications(child.id, [message.id]);
    const current = files.content(path); expect(current).toMatchObject({ body: { version: 3 } });
    expect(current.body).toHaveProperty('content');
    if ('content' in current.body) {
      expect(JSON.parse(current.body.content)).toMatchObject({ kind: 'card-current', version_seq: 3, history_version: 1, card: { version_seq: 3 } });
      expect(current.body.content).not.toContain(message.content); expect(current.body.content).not.toContain('pending');
      const listing = files.list('.saivage/cards/project/children/a');
      expect(listing).toMatchObject({ body: { files: expect.arrayContaining([expect.objectContaining({ name: 'card.json', size: Buffer.byteLength(current.body.content), modifiedAt: cards.read(child.id)!.updated_at })]) } });
      if ('files' in listing.body) expect(listing.body.files.map(file => file.name)).not.toEqual(expect.arrayContaining(['mailbox', 'card-history', 'card-head.json']));
    }
    expect(files.content(`${path}?v=1`)).toEqual(historical);
    expect(files.content(`${path}?v=2`)).toMatchObject({ statusCode: 404, body: { error: 'workspace_historical_version_not_found' } });
  });
  it('keeps current queue revisions distinct from sparse immutable history and tagged diffs', () => {
    const { root, cards, child } = fixture(); const initial = head(root, child.id);
    const path = cardHistoryFile(root, child.id, initial.ordinary.entry_id); const bytes = readFileSync(path);
    const message = notice(); cards.enqueueNotification(child.id, message);
    expect(cards.read(child.id)).toMatchObject({ version_seq: 2, pending_notifications: [message.id] });
    expect(cards.readPendingNotifications(child.id)).toEqual([message]);
    expect(head(root, child.id)).toMatchObject({ ordinary: initial.ordinary, pending: [message.id], version_seq: 2 });
    expect(readFileSync(cardHeadFile(root, child.id), 'utf8')).not.toContain(message.content);
    cards.removeNotifications(child.id, [message.id]);
    expect(cards.read(child.id)).toMatchObject({ version_seq: 3, pending_notifications: [] });
    expect(cards.listCardVersions(child.id)).toMatchObject({ kind: 'found', value: [{ version: 1 }] });
    const currentDiff = cards.diffCardVersions(child.id, { fromVersion: 1, toVersion: 'current' });
    expect(currentDiff).toMatchObject({ kind: 'found', target: { kind: 'current', version_seq: 3, history_version: 1 }, toArtifact: null });
    cards.editCard(child.id, { title: 'after' });
    expect(cards.listCardVersions(child.id)).toMatchObject({ kind: 'found', value: [{ version: 1 }, { version: 4 }] });
    expect(cards.readCardVersion(child.id, 4)).toMatchObject({ kind: 'found', value: { predecessor: initial.ordinary, card: { version_seq: 4, pending_notifications: [] } } });
    for (const version of [2, 3]) expect(cards.readCardVersion(child.id, version)).toEqual({ kind: 'version-not-found', version });
    expect(readFileSync(path)).toEqual(bytes);
    const stored = JSON.parse(readFileSync(cardHistoryFile(root, child.id, head(root, child.id).ordinary.entry_id), 'utf8'));
    for (const field of ['pending_notifications', 'version_seq', 'updated_at']) expect(stored.card).not.toHaveProperty(field);
    expect(cards.diffCardVersions(child.id, { fromVersion: 1, toVersion: 4 })).toMatchObject({ kind: 'found', target: { kind: 'version', version: 4 } });
    expect(new CardService(root).read(child.id)).toMatchObject({ version_seq: 4, title: 'after' });
  });

  it('reads message bodies only on consumption and removes only exact selected IDs', () => {
    const { root, cards, child } = fixture(); const first = notice(); const later = { ...first, id: randomUUID() };
    cards.enqueueNotification(child.id, first); const selected = cards.readPendingNotifications(child.id);
    cards.enqueueNotification(child.id, later); cards.removeNotifications(child.id, selected.map(item => item.id));
    expect(cards.readPendingNotifications(child.id)).toEqual([later]);
    writeFileSync(cardMailboxFile(root, child.id, first.id), 'forgotten malformed data');
    expect(cards.listCardVersions(child.id)).toMatchObject({ kind: 'found', value: [{ version: 1 }] });
    writeFileSync(cardMailboxFile(root, child.id, later.id), 'malformed selected body');
    expect(cards.read(child.id)).toMatchObject({ pending_notifications: [later.id] });
    expect(() => cards.readPendingNotifications(child.id)).toThrow();
  });

  it.each(['notification', 'owner', 'missing'] as const)('rejects a selected message %s mismatch at actual consumption', fault => {
    const { root, cards, child } = fixture(); const message = notice(); cards.enqueueNotification(child.id, message);
    const path = cardMailboxFile(root, child.id, message.id);
    if (fault === 'missing') unlinkSync(path);
    else { const stored = JSON.parse(readFileSync(path, 'utf8')); if (fault === 'owner') stored.card_id = 'project'; else stored.notification.id = randomUUID(); writeFileSync(path, JSON.stringify(stored)); }
    expect(() => cards.readPendingNotifications(child.id)).toThrow();
  });

  it('refuses invalid IDs, duplicate selection and exact collision with a forgotten message', () => {
    const { root, cards, child } = fixture(); const message = notice();
    expect(() => cards.enqueueNotification(child.id, { ...message, id: `change:${message.id}` })).toThrow();
    cards.enqueueNotification(child.id, message); expect(() => cards.enqueueNotification(child.id, message)).toThrow();
    const selected = head(root, child.id); writeFileSync(cardHeadFile(root, child.id), JSON.stringify({ ...selected, pending: [message.id, message.id] }));
    expect(() => cards.read(child.id)).toThrow(); writeFileSync(cardHeadFile(root, child.id), JSON.stringify(selected));
    cards.removeNotifications(child.id, [message.id]); const before = readFileSync(cardHeadFile(root, child.id));
    writeFileSync(cardMailboxFile(root, child.id, message.id), 'unreferenced invalid bytes');
    expect(() => cards.enqueueNotification(child.id, message)).toThrow('already published');
    expect(readFileSync(cardHeadFile(root, child.id))).toEqual(before);
    expect(readFileSync(cardMailboxFile(root, child.id, message.id), 'utf8')).toBe('unreferenced invalid bytes');
  });

  it.each(['done', 'failed', 'blocked', 'cancelled'] as const)('jointly publishes %s lifecycle and empty selection without retaining pending history', status => {
    const { root, cards, child } = fixture(); const message = notice(); cards.enqueueNotification(child.id, message);
    cards.setStatus(child.id, 'running'); cards.stopRunning(child.id);
    expect(cards.readPendingNotifications(child.id)).toEqual([message]); cards.activateStopped(child.id);
    if (status === 'cancelled') cards.setStatus(child.id, status);
    else cards.commitActivationOutcome(child.id, { status, summary: 'settled', result: workflowResult(status === 'done' ? 'DONE' : status === 'failed' ? 'FAILED' : 'BLOCKED', 'settled') }, new Date().toISOString());
    expect(head(root, child.id).pending).toEqual([]);
    expect(cards.read(child.id)).toMatchObject({ lifecycle: { status }, pending_notifications: [] });
    const catalog = cards.listCardVersions(child.id); expect(catalog.kind).toBe('found');
    if (catalog.kind === 'found') for (const item of catalog.value) {
      const version = cards.readCardVersion(child.id, item.version); expect(version).toMatchObject({ kind: 'found', value: { card: { pending_notifications: [] } } });
      if (item.change) expect(item.change.changed_fields).not.toContain('pending_notifications');
    }
    if (status === 'blocked') { cards.enqueueNotification(child.id, notice()); expect(cards.readPendingNotifications(child.id)).toHaveLength(1); }
  });

  it('retains pre-delete mutation metadata and ordinary predecessor after queue-only changes', () => {
    const { root, cards, child } = fixture(); const initial = head(root, child.id).ordinary;
    const message = notice(); cards.enqueueNotification(child.id, message); cards.removeNotifications(child.id, [message.id]); const prior = cards.read(child.id)!;
    cards.deleteSubtrees([child.id], () => true);
    expect(cards.read(child.id)).toBeNull(); expect(cards.read('project')!.child_membership).toContain(child.id);
    expect(cards.readCardVersion(child.id, 4)).toMatchObject({ kind: 'found', value: { kind: 'card-tombstone', predecessor: initial, prior_card_version: 3, prior_updated_at: prior.updated_at, final_card: { version_seq: 3, updated_at: prior.updated_at } } });
    expect(head(root, child.id)).toMatchObject({ version_seq: 4, pending: [] });
    expect(cards.diffCardVersions(child.id, { fromVersion: 1, toVersion: 'current' })).toMatchObject({ kind: 'found', target: { kind: 'version', version: 4 }, toArtifact: { kind: 'card-tombstone' } });
    expect(cards.diffCardVersions(child.id, { fromVersion: 1, toVersion: 4 })).toMatchObject({ kind: 'found', target: { kind: 'version', version: 4 }, toArtifact: { kind: 'card-tombstone' } });
    expect(readCanonicalLinkedCardHistoryTree(root).at(-1)!.tombstone).not.toBeNull();
  });

  it('current consumption does not preflight retained ancestors, while history rejects missing or nondecreasing links', () => {
    const { root, cards, child } = fixture(); const initial = head(root, child.id).ordinary; cards.editCard(child.id, { title: 'after' });
    unlinkSync(cardHistoryFile(root, child.id, initial.entry_id));
    expect(cards.read(child.id)!.title).toBe('after'); expect(() => cards.readCardVersion(child.id, 1)).toThrow();
    const path = cardHistoryFile(root, child.id, head(root, child.id).ordinary.entry_id); const stored = JSON.parse(readFileSync(path, 'utf8'));
    stored.predecessor.version = stored.version; writeFileSync(path, JSON.stringify(stored)); expect(() => cards.read(child.id)).toThrow();
  });

  it.each(['message', 'head'] as const)('publication uncertainty at %s stops without receipt/hint or subsequent publication', stage => {
    const { root, cards, child } = fixture(); const before = readFileSync(cardHeadFile(root, child.id)); const message = notice();
    const renames: string[] = []; const freshness = { cardProjectionChanged: jest.fn(), runtimeChanged: jest.fn(), agentMembershipChanged: jest.fn() };
    const failing = new CardService(root, freshness, { ...io, rename: (from, to) => {
      renames.push(String(to)); if (String(to) === (stage === 'message' ? cardMailboxFile(root, child.id, message.id) : cardHeadFile(root, child.id))) throw new Error('rename failed'); renameSync(from, to);
    } });
    expect(() => failing.enqueueNotification(child.id, message)).toThrow(PublicationOutcomeUnknownError);
    expect(renames).toEqual(stage === 'message' ? [cardMailboxFile(root, child.id, message.id)] : [cardMailboxFile(root, child.id, message.id), cardHeadFile(root, child.id)]);
    expect(freshness.cardProjectionChanged).not.toHaveBeenCalled(); expect(freshness.runtimeChanged).not.toHaveBeenCalled();
    expect(readFileSync(cardHeadFile(root, child.id))).toEqual(before); expect(cards.readPendingNotifications(child.id)).toEqual([]);
  });

  it.each([
    { operation: 'open', offset: 1, unknown: false }, { operation: 'write', offset: 2, unknown: false },
    { operation: 'fsync', offset: 3, unknown: false }, { operation: 'close', offset: 4, unknown: false },
    { operation: 'rename', offset: 5, unknown: true }, { operation: 'open', offset: 6, unknown: true },
    { operation: 'fsync', offset: 7, unknown: true }, { operation: 'close', offset: 8, unknown: true },
  ])('stops at immutable/head publication $operation stage $offset without follow-up', ({ operation, offset, unknown }) => {
    for (const mutation of ['ordinary', 'enqueue'] as const) for (const publication of [0, 1]) {
      const { root, child } = fixture(); let count = 0; const operations: string[] = []; const failure = new Error('injected publication failure');
      const hit = (name: string) => { operations.push(name); count++; if (count === publication * 8 + (publication === 1 ? 3 : 0) + offset) { expect(name).toBe(operation); throw failure; } };
      const failingIo: ReplacementFileIo = {
        open: ((...args: Parameters<typeof openSync>) => { hit('open'); return openSync(...args); }) as typeof openSync,
        write: ((...args: Parameters<typeof writeSync>) => { hit('write'); return Reflect.apply(writeSync, undefined, args); }) as typeof writeSync,
        fsync: fd => { hit('fsync'); fsyncSync(fd); }, close: fd => { hit('close'); closeSync(fd); },
        rename: (from, to) => { hit('rename'); renameSync(from, to); },
      };
      const freshness = { cardProjectionChanged: jest.fn(), runtimeChanged: jest.fn(), agentMembershipChanged: jest.fn() };
      const cards = new CardService(root, freshness, failingIo);
      let caught: unknown; try { if (mutation === 'ordinary') cards.editCard(child.id, { title: 'after' }); else cards.enqueueNotification(child.id, notice()); } catch (error) { caught = error; }
      if (unknown) expect(caught).toBeInstanceOf(PublicationOutcomeUnknownError); else expect(caught).toBe(failure);
      expect(operations).toHaveLength(publication * 8 + (publication === 1 ? 3 : 0) + offset);
      for (const effect of Object.values(freshness)) expect(effect).not.toHaveBeenCalled();
    }
  });
});
