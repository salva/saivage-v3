import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SyncHub } from '../../src/server/sync-hub.js';
import { LiveSyncSocket } from '../../src/server/live-sync-socket.js';
import { CardService } from '../helpers/canonical-project.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import type { WebSocket } from 'ws';

function socket() {
  return { OPEN: 1, CONNECTING: 0, readyState: 1, send: jest.fn(), close: jest.fn(), removeAllListeners: jest.fn() } as unknown as WebSocket;
}

describe('SyncHub semantic hints', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('coalesces duplicate direct hints while retaining distinct core targets', () => {
    jest.useFakeTimers();
    const invalidate = jest.fn();
    const hub = new SyncHub({ invalidate } as unknown as LiveSyncSocket, 25);

    hub.runtimeChanged();
    hub.runtimeChanged();
    hub.cardProjectionChanged({ resource: 'cards', scope: 'detail', card_id: 'card-a' });
    hub.cardProjectionChanged({ resource: 'cards', scope: 'detail', card_id: 'card-a' });
    hub.cardProjectionChanged({ resource: 'cards', scope: 'detail', card_id: 'card-b' });
    hub.cardProjectionChanged({ resource: 'cards', scope: 'history', card_id: 'card-a' });
    hub.cardProjectionChanged({ resource: 'cards', scope: 'record', card_id: 'card-a', record_name: 'brief' });
    hub.cardProjectionChanged({ resource: 'cards', scope: 'record', card_id: 'card-a', record_name: 'status' });
    hub.agentsChanged();
    hub.conversationChanged('agent:analyst:global');
    hub.conversationChanged('agent:analyst:global');
    expect(invalidate).not.toHaveBeenCalled();

    jest.advanceTimersByTime(25);

    expect(invalidate.mock.calls.map(([target]) => target)).toEqual([
      { resource: 'runtime' },
      { resource: 'cards', scope: 'detail', card_id: 'card-a' },
      { resource: 'cards', scope: 'detail', card_id: 'card-b' },
      { resource: 'cards', scope: 'history', card_id: 'card-a' },
      { resource: 'cards', scope: 'record', card_id: 'card-a', record_name: 'brief' },
      { resource: 'cards', scope: 'record', card_id: 'card-a', record_name: 'status' },
      { resource: 'agents' },
      { resource: 'conversation', id: 'agent:analyst:global' },
    ]);
  });

  it('delivers post-link Cards and runtime frames through the real create composition', () => {
    jest.useFakeTimers();
    const live = new LiveSyncSocket();
    const ws = socket();
    live.add(ws);
    const hub = new SyncHub(live, 25);
    const root = mkdtempSync(join(tmpdir(), 'saivage-sync-card-index-'));
    try {
      initProjectTree(root);
      const cards = new CardService(root, hub);
      const parent = cards.create({ type: 'goal', parent: 'project', title: 'sync parent', bootstrap_content: 'sync', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
      jest.advanceTimersByTime(25);
      jest.mocked(ws.send).mockClear();

      const child = cards.create({ type: 'code', parent: parent.id, title: 'sync child', bootstrap_content: 'sync', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
      expect(child.id).toBe('card-a-a');
      expect(cards.read(parent.id)?.children).toEqual([child.id]);
      expect(cards.listChildren(parent.id)).toEqual([child.id]);
      expect(cards.list().map(({ id }) => id)).toEqual(['project', parent.id, child.id]);
      expect(cards.read(child.id)?.id).toBe(child.id);
      expect(ws.send).not.toHaveBeenCalled();

      jest.advanceTimersByTime(25);

      expect(jest.mocked(ws.send).mock.calls.map(([payload]) => JSON.parse(payload as string))).toEqual([
        { t: 'invalidate', resource: 'cards', scope: 'detail', card_id: parent.id },
        { t: 'invalidate', resource: 'cards', scope: 'history', card_id: parent.id },
        { t: 'invalidate', resource: 'cards', scope: 'diff', card_id: parent.id },
        { t: 'invalidate', resource: 'cards', scope: 'children', card_id: parent.id },
        { t: 'invalidate', resource: 'cards', scope: 'children', card_id: 'project' },
        { t: 'invalidate', resource: 'runtime' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      hub.dispose();
    }
  });

  it('delivers a direct runtime ownership hint after debounce', () => {
    jest.useFakeTimers();
    const live = new LiveSyncSocket();
    const invalidate = jest.spyOn(live, 'invalidate');
    const hub = new SyncHub(live, 25);
    hub.runtimeChanged();
    expect(invalidate).not.toHaveBeenCalled();

    jest.advanceTimersByTime(25);

    expect(invalidate.mock.calls).toEqual([[{ resource: 'runtime' }]]);
    hub.dispose();
  });
});
