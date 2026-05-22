import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnalystActivityEventNames,
  buildInboundAnalystMessageEnvelope,
  parseKnownWsEnvelope,
  RuntimeActionableErrorEventSchema,
  RuntimeActivationEventSchema,
  RuntimeCommandEventSchema,
  RuntimeRunEventSchema,
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


  it('validates projected runtime ledger websocket envelopes as live observations', () => {
    const command = { command_id: 'cmd-1', command: 'start_project', status: 'completed', requested_at: '2026-01-01T00:00:00.000Z', completed_at: '2026-01-01T00:00:01.000Z', source: 'operator', error: null };
    const run = { run_id: 'run-1', kind: 'root', card_id: 'project', command_id: 'cmd-1', activation_id: null, parent_run_id: null, phase: 'planner', runtime_status: 'running', session_id: 'planner:project', started_at: '2026-01-01T00:00:01.000Z', updated_at: '2026-01-01T00:00:01.000Z', finished_at: null, result: null };
    const activation = { activation_id: 'act-1', idempotency_key: 'run-1:planner:project:call-1:card-1', parent_card_id: 'project', parent_run_id: 'run-1', parent_session_id: 'planner:project', parent_tool_call_id: 'call-1', child_card_id: 'card-1', status: 'running', requested_at: '2026-01-01T00:00:02.000Z', updated_at: '2026-01-01T00:00:02.000Z', precondition: 'accepted', runtime_run_id: 'run-child-1', error: null };
    const actionable_error = { code: 'runtime_not_running', message: 'Runtime is not running.', nextAction: 'Start the project first.', cardId: 'card-1', runId: 'run-1' };
    const envelopes = [
      { type: 'activity', content: { event: 'runtime.command', command } },
      { type: 'status', content: { event: 'runtime.run', run } },
      { type: 'activity', content: { event: 'runtime.activation', activation } },
      { type: 'error', content: { event: 'runtime.actionable_error', actionable_error } },
    ];

    expect(RuntimeCommandEventSchema.parse(envelopes[0]).content.command).toEqual(command);
    expect(RuntimeRunEventSchema.parse(envelopes[1]).content.run).toEqual(run);
    expect(RuntimeActivationEventSchema.parse(envelopes[2]).content.activation).toEqual(activation);
    expect(RuntimeActionableErrorEventSchema.parse(envelopes[3]).content.actionable_error).toEqual(actionable_error);
    expect(envelopes.map((envelope) => parseKnownWsEnvelope(envelope)?.content.event)).toEqual(['runtime.command', 'runtime.run', 'runtime.activation', 'runtime.actionable_error']);
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
