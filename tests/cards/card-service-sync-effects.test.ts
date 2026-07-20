import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { closeSync, fstatSync, fsyncSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';

import { ReadModelChangeBroadcaster } from '../../src/application/read-model-changes.js';
import { CardService } from '../../src/cards/card-service.js';
import type { LiveSyncInvalidateFrame } from '../../src/contracts/index.js';
import type { GrowingFileIo } from '../../src/persistence/growing-file.js';
import { LiveSyncSocket } from '../../src/server/live-sync-socket.js';
import { SyncHub } from '../../src/server/sync-hub.js';
import { initProjectTree } from '../helpers/canonical-project.js';

const context = { actor: 'analyst' as const, surface: 'runtime' as const, reason: 'sync effects' };

function input(parent = 'project') {
  return { type: 'code' as const, parent, title: 'card', brief: 'brief', status: 'backlog' as const, tags: [], priority: 0, urgency: 'normal' as const, created_by: 'analyst' as const, depends_on: [], related: [] };
}

function versionFrames(cardId: string, parentId: string | null): LiveSyncInvalidateFrame[] {
  return [
    { t: 'invalidate', resource: 'cards', scope: 'detail', card_id: cardId },
    { t: 'invalidate', resource: 'cards', scope: 'history', card_id: cardId },
    { t: 'invalidate', resource: 'cards', scope: 'diff', card_id: cardId },
    { t: 'invalidate', resource: 'cards', scope: 'children', card_id: cardId },
    ...(parentId ? [{ t: 'invalidate', resource: 'cards', scope: 'children', card_id: parentId } as const] : []),
  ];
}

describe('CardService scoped mutation-to-frame effects', () => {
  let root: string;
  let ws: WebSocket;
  let hub: SyncHub;
  let cards: CardService;

  const frames = (): LiveSyncInvalidateFrame[] => jest.mocked(ws.send).mock.calls.map(([payload]) => JSON.parse(payload as string) as LiveSyncInvalidateFrame);
  const flush = (): LiveSyncInvalidateFrame[] => { jest.advanceTimersByTime(10); return frames(); };
  const clear = (): void => { jest.mocked(ws.send).mockClear(); };

  beforeEach(() => {
    jest.useFakeTimers();
    root = mkdtempSync(join(tmpdir(), 'saivage-card-sync-effects-'));
    initProjectTree(root);
    ws = { OPEN: 1, CONNECTING: 0, readyState: 1, send: jest.fn(), close: jest.fn(), removeAllListeners: jest.fn() } as unknown as WebSocket;
    const live = new LiveSyncSocket();
    live.add(ws);
    hub = new SyncHub(live, 10);
    const changes = new ReadModelChangeBroadcaster();
    changes.subscribe(hub);
    cards = new CardService(root, undefined, changes);
  });

  afterEach(() => {
    hub.dispose();
    jest.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  it('publishes only the linked parent version scopes for create', () => {
    const child = cards.create(input());

    expect(flush()).toEqual([...versionFrames('project', null), { t: 'invalidate', resource: 'runtime' }]);
    expect(frames().some((frame) => frame.resource === 'cards' && frame.card_id === child.id)).toBe(false);
  });

  it('publishes exact parent-owned reorder scopes and containing-parent row scope', () => {
    const parent = cards.create({ ...input(), type: 'goal' });
    const first = cards.create(input(parent.id));
    const second = cards.create(input(parent.id));
    flush(); clear();

    cards.reorderChildren(parent.id, [second.id, first.id], context);

    expect(flush()).toEqual(versionFrames(parent.id, 'project'));
  });

  it('publishes exact detail, history, diff, own-children, and containing-parent scopes for a child patch', () => {
    const child = cards.create(input());
    flush(); clear();

    cards.update(child.id, { title: 'changed' });

    expect(flush()).toEqual(versionFrames(child.id, 'project'));
  });

  it('publishes no record target for open, edit, or discard and one exact target only for close', () => {
    const child = cards.create(input());
    flush(); clear();

    const draft = cards.openRecord(child.id, 'status.md');
    cards.editRecord(child.id, 'status.md', draft.version, 'working');
    cards.discardRecord(child.id, 'status.md', draft.version, 'not ready');
    expect(flush()).toEqual([]);

    const next = cards.openRecord(child.id, 'status.md');
    cards.editRecord(child.id, 'status.md', next.version, 'closed');
    cards.closeRecord(child.id, 'status.md', next.version, 'executor', cards.read(child.id)!.version_seq);
    expect(flush()).toEqual([{ t: 'invalidate', resource: 'cards', scope: 'record', card_id: child.id, slot: 'status' }]);
  });

  it('publishes every tombstoned card scope, all record slots, and one coalesced containing-parent scope', () => {
    const parent = cards.create({ ...input(), type: 'goal' });
    const child = cards.create(input(parent.id));
    flush(); clear();

    cards.deleteSubtrees([parent.id], context, () => true);

    expect(flush()).toEqual([
      ...versionFrames(child.id, parent.id),
      { t: 'invalidate', resource: 'cards', scope: 'record', card_id: child.id, slot: 'brief' },
      { t: 'invalidate', resource: 'cards', scope: 'record', card_id: child.id, slot: 'status' },
      { t: 'invalidate', resource: 'cards', scope: 'record', card_id: child.id, slot: 'review' },
      { t: 'invalidate', resource: 'runtime' },
      ...versionFrames(parent.id, 'project').filter((frame) => !(frame.resource === 'cards' && frame.scope === 'children' && frame.card_id === parent.id)),
      { t: 'invalidate', resource: 'cards', scope: 'record', card_id: parent.id, slot: 'brief' },
      { t: 'invalidate', resource: 'cards', scope: 'record', card_id: parent.id, slot: 'status' },
      { t: 'invalidate', resource: 'cards', scope: 'record', card_id: parent.id, slot: 'review' },
    ]);
  });

  it('emits no hint for no-op and reported write failure', () => {
    const child = cards.create(input());
    flush(); clear();
    cards.update(child.id, {});
    expect(flush()).toEqual([]);

    const failure = new Error('injected append failure');
    const failingIo: GrowingFileIo = {
      open: openSync,
      stat: fstatSync,
      write: writeSync,
      fsync(fd) { fsyncSync(fd); throw failure; },
      close: closeSync,
    };
    const changes = new ReadModelChangeBroadcaster();
    changes.subscribe(hub);
    const failingCards = new CardService(root, undefined, changes, failingIo);
    expect(() => failingCards.update(child.id, { title: 'outcome unknown' })).toThrow(failure);
    expect(flush()).toEqual([]);
  });

  it('emits no record hint when close reports an outcome-unknown append failure', () => {
    const child = cards.create(input());
    const draft = cards.openRecord(child.id, 'review.md');
    cards.editRecord(child.id, 'review.md', draft.version, 'review');
    flush(); clear();

    const failure = new Error('injected record close failure');
    const failingIo: GrowingFileIo = {
      open: openSync,
      stat: fstatSync,
      write: writeSync,
      fsync(fd) { fsyncSync(fd); throw failure; },
      close: closeSync,
    };
    const changes = new ReadModelChangeBroadcaster();
    changes.subscribe(hub);
    const failingCards = new CardService(root, undefined, changes, failingIo);

    expect(() => failingCards.closeRecord(child.id, 'review.md', draft.version, 'reviewer', cards.read(child.id)!.version_seq)).toThrow(failure);
    expect(flush()).toEqual([]);
  });

  it('fails fast without effects when a required existing card or record stream is missing at append open', () => {
    const child = cards.create(input());
    const draft = cards.openRecord(child.id, 'review.md');
    flush(); clear();
    const missingIo: GrowingFileIo = {
      open() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      stat: fstatSync, write: writeSync, fsync: fsyncSync, close: closeSync,
    };
    const changes = new ReadModelChangeBroadcaster(); changes.subscribe(hub);
    const missingCards = new CardService(root, undefined, changes, missingIo);
    expect(() => missingCards.update(child.id, { title: 'not published' })).toThrow(/disappeared before version append/);
    expect(flush()).toEqual([]);
    expect(() => missingCards.editRecord(child.id, 'review.md', draft.version, 'not published')).toThrow(/disappeared before append/);
    expect(flush()).toEqual([]);
  });
});
