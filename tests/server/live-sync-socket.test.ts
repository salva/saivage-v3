import { describe, expect, it, jest } from '@jest/globals';
import { LiveSyncSocket } from '../../src/server/live-sync-socket.js';
import type { WebSocket } from 'ws';

function socket() {
  return { OPEN: 1, CONNECTING: 0, readyState: 1, send: jest.fn(), close: jest.fn(), removeAllListeners: jest.fn() } as unknown as WebSocket;
}

describe('LiveSyncSocket conversation leases', () => {
  it('keeps a replacement lease when a stale unsubscribe arrives', () => {
    const live = new LiveSyncSocket();
    const ws = socket();
    live.add(ws);
    live.handleClientFrame(ws, { t: 'subscribe', resource: 'conversation', id: 'agent:planner:project', lease: 'old' });
    live.handleClientFrame(ws, { t: 'subscribe', resource: 'conversation', id: 'agent:planner:project', lease: 'current' });
    live.handleClientFrame(ws, { t: 'unsubscribe', resource: 'conversation', id: 'agent:planner:project', lease: 'old' });
    live.invalidate({ resource: 'conversation', id: 'agent:planner:project' });

    expect(jest.mocked(ws.send).mock.calls.map(([payload]) => JSON.parse(payload as string))).toContainEqual({
      t: 'invalidate', resource: 'conversation', id: 'agent:planner:project',
    });
  });

  it.each(['global', 'analyst:test', 'analyst:telegram-42', 'analyst:other'])('retains no invalid subscription and sends no acknowledgement for %s', (id) => {
    const live = new LiveSyncSocket();
    const ws = socket();
    live.add(ws);
    expect(live.handleClientFrame(ws, { t: 'subscribe', resource: 'conversation', id, lease: 'bad' })).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
    live.invalidate({ resource: 'conversation', id } as never);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it.each(['global', 'analyst:test', 'analyst:telegram-42', 'analyst:other'])('invalid unsubscribe %s cannot remove a valid lease', (id) => {
    const live = new LiveSyncSocket();
    const ws = socket();
    live.add(ws);
    live.handleClientFrame(ws, { t: 'subscribe', resource: 'conversation', id: 'agent:planner:project', lease: 'valid' });
    jest.mocked(ws.send).mockClear();
    expect(live.handleClientFrame(ws, { t: 'unsubscribe', resource: 'conversation', id, lease: 'valid' })).toBe(false);
    live.invalidate({ resource: 'conversation', id: 'agent:planner:project' });
    expect(jest.mocked(ws.send).mock.calls.map(([payload]) => JSON.parse(payload as string))).toEqual([{ t: 'invalidate', resource: 'conversation', id: 'agent:planner:project' }]);
  });
});

describe('LiveSyncSocket scoped Cards invalidations', () => {
  it('broadcasts one exact scoped payload to every open client without a subscription', () => {
    const live = new LiveSyncSocket();
    const first = socket();
    const second = socket();
    live.add(first);
    live.add(second);

    live.invalidate({ resource: 'cards', scope: 'record', card_id: 'card-a-b', record_name: 'review' });

    const expected = [{ t: 'invalidate', resource: 'cards', scope: 'record', card_id: 'card-a-b', record_name: 'review' }];
    expect(jest.mocked(first.send).mock.calls.map(([payload]) => JSON.parse(payload as string))).toEqual(expected);
    expect(jest.mocked(second.send).mock.calls.map(([payload]) => JSON.parse(payload as string))).toEqual(expected);
  });
});
