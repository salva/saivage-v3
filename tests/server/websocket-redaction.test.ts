import { describe, expect, it, jest } from '@jest/globals';
import type { WebSocket } from 'ws';
import { buildConnectedEnvelope } from '../../src/contracts/index.js';
import { sendToClient, serializeOutboundEnvelope } from '../../src/server/websocket.js';

describe('strict WebSocket outbound projection', () => {
  it('serializes only the exact connected transport status', () => {
    const envelope = buildConnectedEnvelope({ timestamp: '2026-09-05T00:00:00.000Z', clientCount: 1 });
    const ws = { OPEN: 1, readyState: 1, send: jest.fn() } as unknown as WebSocket;
    sendToClient(ws, envelope);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify(envelope));
  });
  it.each([
    { type: 'message', content: { text: 'token=not-for-egress' } },
    { type: 'activity', content: { event: 'tool_invocation', params: { token: 'secret' } } },
    { type: 'error', content: { error: 'analyst_processing_failed' } },
    { type: 'status', content: { event: 'analyst_turn_acknowledged', restart: null } },
    { ...buildConnectedEnvelope({}), extra: true },
    { type: 'status', content: { ...buildConnectedEnvelope({}).content, sessionId: 'agent:analyst:global' } },
  ])('rejects unsupported or undeclared data before sending %#', (envelope) => {
    const ws = { OPEN: 1, readyState: 1, send: jest.fn() } as unknown as WebSocket;
    expect(() => serializeOutboundEnvelope(envelope as never)).toThrow();
    sendToClient(ws, envelope as never);
    expect(ws.send).not.toHaveBeenCalled();
  });
});
