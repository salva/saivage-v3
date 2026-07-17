import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { liveSyncEventKinds, mapLiveSyncEvent, SyncHub } from '../../src/server/sync-hub.js';
import { EventBus } from '../../src/events/index.js';
import type { DomainEvent } from '../../src/events/index.js';
import { LiveSyncSocket } from '../../src/server/live-sync-socket.js';
import { ReadModelChangeBroadcaster } from '../../src/application/read-model-changes.js';
import { CardService } from '../../src/cards/card-service.js';
import { ActiveCardLeaf } from '../../src/runtime/active-card-leaf.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import type { WebSocket } from 'ws';

const FIRST_SEGMENT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SECOND_SEGMENT = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function socket() {
  return { OPEN: 1, CONNECTING: 0, readyState: 1, send: jest.fn(), close: jest.fn(), removeAllListeners: jest.fn() } as unknown as WebSocket;
}

function event(kind: string, payload: Record<string, unknown>): DomainEvent<any> {
  return {
    id: `evt-${kind}`,
    kind,
    timestamp: new Date(0).toISOString(),
    payload,
  } as DomainEvent<any>;
}

describe('mapLiveSyncEvent', () => {
  it('never derives core projection freshness from metadata', () => {
    for (const kind of liveSyncEventKinds) {
      const targets = mapLiveSyncEvent(event(kind, {
        session_id: 'analyst:global',
        action: 'card.create',
        tool: 'create_card',
      }));
      expect(targets.every((target) => target.resource === 'timeline')).toBe(true);
    }
  });

  it('does not map tool activity events to conversation invalidations', () => {
    expect(mapLiveSyncEvent(event('mcp_tool_invocation', { session_id: 'planner:project', role: 'planner', server_name: 'mcp', tool_name: 'read', success: true }))).toEqual([]);
    expect(mapLiveSyncEvent(event('analyst_tool_invoked', { sessionId: 'analyst:global', tool: 'read', success: true, summary: 'read file' }))).toEqual([{ resource: 'timeline' }]);
  });

  it('rejects reserved timestamp and unknown conversation_changed payload keys', () => {
    const bus = new EventBus();
    const payload = { session_id: 'analyst:global', mutation: 'entry_appended', message_id: 'msg-1', message_kind: 'text', role: 'assistant', message_timestamp: new Date(1).toISOString() } as const;
    expect(() => bus.emit('conversation_changed', { ...payload, timestamp: new Date(2).toISOString() } as never)).toThrow();
    expect(() => bus.emit('conversation_changed', { ...payload, extra: true } as never)).toThrow();
  });
});

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
    hub.cardStateChanged();
    hub.agentsChanged();
    hub.conversationChanged('analyst:global');
    hub.conversationChanged('analyst:global');
    expect(invalidate).not.toHaveBeenCalled();

    jest.advanceTimersByTime(25);

    expect(invalidate.mock.calls.map(([target]) => target)).toEqual([
      { resource: 'runtime' },
      { resource: 'cards' },
      { resource: 'agents' },
      { resource: 'conversation', id: 'analyst:global' },
    ]);
  });

  it('delivers post-link Cards and runtime frames through the real create composition', () => {
    jest.useFakeTimers();
    const live = new LiveSyncSocket();
    const ws = socket();
    live.add(ws);
    const hub = new SyncHub(live, 25);
    const changes = new ReadModelChangeBroadcaster();
    changes.subscribe(hub);
    const root = mkdtempSync(join(tmpdir(), 'saivage-sync-card-index-'));
    try {
      initProjectTree(root);
      const segments = [FIRST_SEGMENT, SECOND_SEGMENT];
      const cards = new CardService(root, undefined, changes, () => segments.shift()!);
      const parent = cards.create({ type: 'goal', parent: 'project', title: 'sync parent', brief: 'sync', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
      jest.advanceTimersByTime(25);
      jest.mocked(ws.send).mockClear();

      const child = cards.create({ type: 'code', parent: parent.id, title: 'sync child', brief: 'sync', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
      expect(child.id).toBe(`card-${FIRST_SEGMENT}-${SECOND_SEGMENT}`);
      expect(cards.read(parent.id)?.children).toEqual([child.id]);
      expect(cards.listChildren(parent.id)).toEqual([child.id]);
      expect(cards.list().map(({ id }) => id)).toEqual(['project', parent.id, child.id]);
      expect(cards.read(child.id)?.id).toBe(child.id);
      expect(ws.send).not.toHaveBeenCalled();

      jest.advanceTimersByTime(25);

      expect(jest.mocked(ws.send).mock.calls.map(([payload]) => JSON.parse(payload as string))).toEqual([
        { t: 'invalidate', resource: 'cards' },
        { t: 'invalidate', resource: 'runtime' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      hub.dispose();
    }
  });

  it('delivers a real actor-owner runtime hint through the broadcaster after debounce', () => {
    jest.useFakeTimers();
    const live = new LiveSyncSocket();
    const invalidate = jest.spyOn(live, 'invalidate');
    const hub = new SyncHub(live, 25);
    const changes = new ReadModelChangeBroadcaster();
    changes.subscribe(hub);
    const currentness = new ActiveCardLeaf(() => changes.runtimeChanged());
    currentness.setChain(['project']);
    expect(invalidate).not.toHaveBeenCalled();

    jest.advanceTimersByTime(25);

    expect(invalidate.mock.calls).toEqual([[{ resource: 'runtime' }]]);
    hub.dispose();
  });
});
