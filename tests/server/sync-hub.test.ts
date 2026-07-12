import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { liveSyncEventKinds, mapLiveSyncEvent, SyncHub } from '../../src/server/sync-hub.js';
import { EventBus } from '../../src/events/index.js';
import type { DomainEvent } from '../../src/events/index.js';
import type { LiveSyncSocket } from '../../src/server/live-sync-socket.js';

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
});
