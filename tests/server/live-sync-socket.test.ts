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
    live.handleClientFrame(ws, { t: 'subscribe', resource: 'conversation', id: 'planner:project', lease: 'old' });
    live.handleClientFrame(ws, { t: 'subscribe', resource: 'conversation', id: 'planner:project', lease: 'current' });
    live.handleClientFrame(ws, { t: 'unsubscribe', resource: 'conversation', id: 'planner:project', lease: 'old' });
    live.invalidate({ resource: 'conversation', id: 'planner:project' });

    expect(jest.mocked(ws.send).mock.calls.map(([payload]) => JSON.parse(payload as string))).toContainEqual({
      t: 'invalidate', resource: 'conversation', id: 'planner:project',
    });
  });
});
