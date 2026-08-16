import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { closeSync, fstatSync, fsyncSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';

import { CardService } from '../helpers/canonical-project.js';
import type { LiveSyncInvalidateFrame } from '../../src/contracts/index.js';
import type { GrowingFileIo } from '../../src/persistence/growing-file.js';
import { LiveSyncSocket } from '../../src/server/live-sync-socket.js';
import { SyncHub } from '../../src/server/sync-hub.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { workflowResult } from '../helpers/workflow-result.js';

const context = { actor: 'analyst' as const, surface: 'runtime' as const, reason: 'sync effects' };

function input(parent = 'project') {
  return { type: 'code' as const, parent, title: 'card', bootstrap_content: 'brief', tags: [], priority: 0, urgency: 'normal' as const, created_by: 'analyst' as const, depends_on: [], related: [] };
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

function block(cards: CardService, id: string): void {
  cards.setStatus(id, 'running');
  cards.commitActivationOutcome(id, { status: 'blocked', summary: 'blocked', result: workflowResult('BLOCKED', 'blocked') }, '2026-08-15T00:00:00.000Z');
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
    cards = new CardService(root, hub);
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

    cards.reorderChildren(parent.id, [second.id, first.id]);

    expect(flush()).toEqual(versionFrames(parent.id, 'project'));
  });

  it('publishes exact detail, history, diff, own-children, and containing-parent scopes for a child patch', () => {
    const child = cards.create(input());
    flush(); clear();

    cards.editCard(child.id, { title: 'changed' });

    expect(flush()).toEqual(versionFrames(child.id, 'project'));
  });

  it('publishes no record target for open, edit, or discard and one exact target only for close', () => {
    const child = cards.create(input());
    flush(); clear();

    const draft = cards.openRecord(child.id, 'status.md', null);
    const working = cards.editRecord(child.id, 'status.md', draft.headVersion, 'working');
    cards.discardRecord(child.id, 'status.md', working.headVersion, 'not ready');
    expect(flush()).toEqual([]);

    const next = cards.openRecord(child.id, 'status.md', 3);
    const edited = cards.editRecord(child.id, 'status.md', next.headVersion, 'closed');
    cards.closeRecord(child.id, 'status.md', edited.headVersion, 'executor');
    expect(flush()).toEqual([{ t: 'invalidate', resource: 'cards', scope: 'record', card_id: child.id, record_name: 'status.md' }]);
  });

  it('publishes every tombstoned card scope, all record slots, and one coalesced containing-parent scope', () => {
    const parent = cards.create({ ...input(), type: 'goal' });
    const child = cards.create(input(parent.id));
    flush(); clear();

    cards.deleteSubtrees([parent.id], () => true);

    expect(flush()).toEqual([
      ...versionFrames(child.id, parent.id),
      { t: 'invalidate', resource: 'cards', scope: 'record', card_id: child.id, record_name: 'brief.md' },
      { t: 'invalidate', resource: 'cards', scope: 'record', card_id: child.id, record_name: 'status.md' },
      { t: 'invalidate', resource: 'runtime' },
      ...versionFrames(parent.id, 'project').filter((frame) => !(frame.resource === 'cards' && frame.scope === 'children' && frame.card_id === parent.id)),
      { t: 'invalidate', resource: 'cards', scope: 'record', card_id: parent.id, record_name: 'brief.md' },
      { t: 'invalidate', resource: 'cards', scope: 'record', card_id: parent.id, record_name: 'status.md' },
      { t: 'invalidate', resource: 'cards', scope: 'record', card_id: parent.id, record_name: 'review.md' },
    ]);
  });

  it('emits no hint for no-op and reported write failure', () => {
    const child = cards.create(input());
    flush(); clear();
    cards.editCard(child.id, {});
    expect(flush()).toEqual([]);

    const failure = new Error('injected append failure');
    const failingIo: GrowingFileIo = {
      open: openSync,
      stat: fstatSync,
      write: writeSync,
      fsync(fd) { fsyncSync(fd); throw failure; },
      close: closeSync,
    };
    const failingCards = new CardService(root, hub, failingIo);
    expect(() => failingCards.editCard(child.id, { title: 'version publication failed' })).toThrow(failure);
    expect(flush()).toEqual([]);
  });

  it('prunes before effects and orders nested status admission/publication before metadata publication', () => {
    const child = cards.create(input());
    block(cards, child.id);
    flush(); clear();

    const events: string[] = [];
    const freshness = {
      cardProjectionChanged(effect: { scope: string }) { events.push(`effect:${effect.scope}`); },
      runtimeChanged() { events.push('effect:runtime'); },
      agentMembershipChanged() { events.push('effect:membership'); },
    };
    const io = {
      open(path: string, flags: number, mode?: number) { events.push('publication:open'); return mode === undefined ? openSync(path, flags) : openSync(path, flags, mode); },
      stat: fstatSync, write: writeSync, fsync: fsyncSync, close: closeSync,
    } as unknown as GrowingFileIo;
    const service = new CardService(root, freshness, io);
    const originalRead = service.read.bind(service);
    jest.spyOn(service, 'read').mockImplementation((id) => { events.push('business:read'); return originalRead(id); });
    const originalSetStatus = service.setStatus.bind(service);
    const setStatus = jest.spyOn(service, 'setStatus').mockImplementation((id, status) => { events.push('business:setStatus'); return originalSetStatus(id, status); });

    expect(service.editCard(child.id, { title: child.title }, 'planner')).toMatchObject({ lifecycle: { status: 'blocked' } });
    expect(events).toEqual(['business:read']);
    expect(setStatus).not.toHaveBeenCalled();

    events.length = 0;
    expect(service.editCard(child.id, { title: 'corrected' }, 'planner')).toMatchObject({ title: 'corrected', lifecycle: { status: 'changed' } });
    expect(setStatus).toHaveBeenCalledWith(child.id, 'changed');
    expect(events.slice(0, 4)).toEqual(['business:read', 'business:setStatus', 'business:read', 'publication:open']);
    const publicationIndexes = events.flatMap((event, index) => event === 'publication:open' ? [index] : []);
    expect(publicationIndexes).toHaveLength(2);
    expect(events.slice(publicationIndexes[0]! + 1, publicationIndexes[1]!)).toEqual([
      'effect:detail', 'effect:history', 'effect:diff', 'effect:children', 'effect:children', 'effect:runtime',
    ]);
    expect(events.slice(publicationIndexes[1]! + 1)).toEqual([
      'effect:detail', 'effect:history', 'effect:diff', 'effect:children', 'effect:children',
    ]);
  });

  it('lets the exact second-publication failure escape with only completed status-prefix effects', () => {
    const child = cards.create(input());
    block(cards, child.id);
    flush(); clear();

    const failure = new Error('injected metadata publication failure');
    const events: string[] = [];
    let publications = 0;
    const freshness = {
      cardProjectionChanged(effect: { scope: string }) { events.push(`effect:${effect.scope}`); },
      runtimeChanged() { events.push('effect:runtime'); },
      agentMembershipChanged() { events.push('effect:membership'); },
    };
    const io = {
      open(path: string, flags: number, mode?: number) { publications += 1; events.push(`publication:${publications}:open`); return mode === undefined ? openSync(path, flags) : openSync(path, flags, mode); },
      stat: fstatSync,
      write(fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null) {
        events.push(`publication:${publications}:write`);
        if (publications === 2) throw failure;
        return writeSync(fd, buffer, offset as number, length as number, position as number | null);
      },
      fsync: fsyncSync,
      close: closeSync,
    } as unknown as GrowingFileIo;
    const service = new CardService(root, freshness, io);
    const originalRead = service.read.bind(service);
    jest.spyOn(service, 'read').mockImplementation((id) => { events.push('business:read'); return originalRead(id); });
    const originalSetStatus = service.setStatus.bind(service);
    jest.spyOn(service, 'setStatus').mockImplementation((id, status) => { events.push('business:setStatus'); return originalSetStatus(id, status); });

    let caught: unknown;
    try { service.editCard(child.id, { title: 'uncertain metadata' }, 'planner'); }
    catch (error) { caught = error; }
    expect(caught).toBe(failure);
    expect(events).toEqual([
      'business:read', 'business:setStatus', 'business:read',
      'publication:1:open', 'publication:1:write',
      'effect:detail', 'effect:history', 'effect:diff', 'effect:children', 'effect:children', 'effect:runtime',
      'publication:2:open', 'publication:2:write',
    ]);
  });

  it('emits no record hint when close reports an outcome-unknown append failure', () => {
    const child = cards.create(input());
    const draft = cards.openRecord(child.id, 'status.md', null);
    const edited = cards.editRecord(child.id, 'status.md', draft.headVersion, 'review');
    flush(); clear();

    const failure = new Error('injected record close failure');
    const failingIo: GrowingFileIo = {
      open: openSync,
      stat: fstatSync,
      write: writeSync,
      fsync(fd) { fsyncSync(fd); throw failure; },
      close: closeSync,
    };
    const failingCards = new CardService(root, hub, failingIo);

    expect(() => failingCards.closeRecord(child.id, 'status.md', edited.headVersion, 'executor')).toThrow(failure);
    expect(flush()).toEqual([]);
  });

  it('fails fast without effects when immutable card or record version creation fails', () => {
    const child = cards.create(input());
    const draft = cards.openRecord(child.id, 'status.md', null);
    flush(); clear();
    const missingIo: GrowingFileIo = {
      open() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      stat: fstatSync, write: writeSync, fsync: fsyncSync, close: closeSync,
    };
    const missingCards = new CardService(root, hub, missingIo);
    expect(() => missingCards.editCard(child.id, { title: 'not published' })).toThrow('missing');
    expect(flush()).toEqual([]);
    expect(() => missingCards.editRecord(child.id, 'status.md', draft.headVersion, 'not published')).toThrow('missing');
    expect(flush()).toEqual([]);
  });
});
