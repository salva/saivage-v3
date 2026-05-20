import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnalystActivityEventNames,
  buildInboundAnalystMessageEnvelope,
  parseKnownWsEnvelope,
  parseWsEnvelope,
  wsContractFixtures,
} from '../api/contracts';

const issueWebSocketTicket = vi.fn(async () => ({ ticket: 'ticket-1', expires_at: '2026-01-01T00:00:30.000Z' }));
vi.mock('../api/client', () => ({ issueWebSocketTicket }));

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: MockWebSocket[] = [];
  OPEN = 1;
  CONNECTING = 0;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; }
}

function latestSocket(): MockWebSocket {
  const socket = MockWebSocket.instances.at(-1);
  if (!socket) throw new Error('missing websocket');
  return socket;
}

describe('web websocket shared contract adapter/client', () => {
  beforeEach(() => {
    vi.resetModules();
    MockWebSocket.instances = [];
    issueWebSocketTicket.mockClear();
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:3000' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exports shared fixture seams and parser helpers for ARCH-020', () => {
    expect(AnalystActivityEventNames).toContain('analyst_tool_invoked');
    expect(parseWsEnvelope(wsContractFixtures.unknownBaseValid)).toEqual(wsContractFixtures.unknownBaseValid);
    expect(parseKnownWsEnvelope(wsContractFixtures.unknownBaseValid)).toBeNull();
    expect(() => parseKnownWsEnvelope(wsContractFixtures.malformedKnown)).toThrow();
    expect(buildInboundAnalystMessageEnvelope('hello')).toEqual({ type: 'message', content: { text: 'hello' } });
  });

  it('dispatches known and unknown base-valid envelopes but drops malformed-known and invalid envelopes', async () => {
    const { createWsConnection } = await import('../api/websocket');
    const conn = createWsConnection();
    const handler = vi.fn();
    conn.onEvent(handler);
    conn.connect();
    await vi.waitFor(() => expect(issueWebSocketTicket).toHaveBeenCalledOnce());
    const socket = latestSocket();
    socket.onopen?.();

    socket.onmessage?.({ data: JSON.stringify({ type: 'status', content: { event: 'connected', sessionId: 'session-1', timestamp: '2026-01-01T00:00:00.000Z', clientCount: 1 } }) });
    socket.onmessage?.({ data: JSON.stringify({ type: 'activity', content: { event: 'future_event', payload: true } }) });
    socket.onmessage?.({ data: JSON.stringify({ type: 'activity', content: { event: 'card_history_appended' } }) });
    socket.onmessage?.({ data: JSON.stringify({ type: 'status' }) });

    expect(conn.sessionId.value).toBe('session-1');
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1][0]).toEqual({ type: 'activity', content: { event: 'future_event', payload: true } });
  });

  it('constructs outbound analyst messages through the shared schema', async () => {
    const { createWsConnection } = await import('../api/websocket');
    const conn = createWsConnection();
    conn.connect();
    await vi.waitFor(() => expect(issueWebSocketTicket).toHaveBeenCalledOnce());
    const socket = latestSocket();

    conn.sendMessage('hello analyst');

    expect(socket.sent).toEqual([JSON.stringify({ type: 'message', content: { text: 'hello analyst' } })]);
  });
});
