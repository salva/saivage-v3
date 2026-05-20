import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  issueWebSocketTicket: vi.fn(),
}));

vi.mock('../api/client', () => ({ issueWebSocketTicket: mocks.issueWebSocketTicket }));
vi.mock('../utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { createWsConnection } from '../api/websocket';

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
}

describe('websocket ticket client', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.issueWebSocketTicket.mockReset();
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket as any);
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fetches a ticket before constructing the WebSocket URL and never appends token', async () => {
    mocks.issueWebSocketTicket.mockResolvedValueOnce({ ticket: 'arch004-ticket-one', expiresAt: '2026-01-01T00:00:00.000Z' });
    const conn = createWsConnection();

    conn.connect();
    await vi.runAllTicks();

    expect(mocks.issueWebSocketTicket).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(1);
    const url = new URL(MockWebSocket.instances[0]!.url);
    expect(url.searchParams.get('ticket')).toBe('arch004-ticket-one');
    expect(url.searchParams.has('token')).toBe(false);
  });

  it('fetches a fresh ticket for reconnect attempts', async () => {
    mocks.issueWebSocketTicket
      .mockResolvedValueOnce({ ticket: 'arch004-ticket-first', expiresAt: '2026-01-01T00:00:00.000Z' })
      .mockResolvedValueOnce({ ticket: 'arch004-ticket-second', expiresAt: '2026-01-01T00:00:30.000Z' });
    const conn = createWsConnection();

    conn.connect();
    await vi.runAllTicks();
    const first = MockWebSocket.instances[0]!;
    first.onopen?.();
    first.onclose?.({ code: 1006, reason: '' });
    vi.advanceTimersByTime(1000);
    await vi.runAllTicks();

    expect(mocks.issueWebSocketTicket).toHaveBeenCalledTimes(2);
    expect(new URL(MockWebSocket.instances[1]!.url).searchParams.get('ticket')).toBe('arch004-ticket-second');
  });

  it('marks unauthorized when ticket acquisition fails without constructing a WebSocket', async () => {
    mocks.issueWebSocketTicket.mockRejectedValueOnce(new Error('Unauthorized'));
    const conn = createWsConnection();

    conn.connect();
    await vi.runAllTicks();

    expect(conn.state.value).toBe('unauthorized');
    expect(MockWebSocket.instances).toHaveLength(0);
  });
});
