import { describe, expect, it } from 'vitest';
import websocketSource from '../api/websocket.ts?raw';
import {
  LiveSyncInvalidateFrameSchema,
  LiveSyncSubscribedFrameSchema,
  buildConnectedEnvelope,
  parseKnownWsEnvelope,
} from '../api/contracts';

describe('websocket bootstrap boundary after S06', () => {
  it('uses bounded ws-ticket bootstrap and does not append bearer/api-token query parameters', () => {
    expect(websocketSource).toContain('issueWebSocketTicket');
    expect(websocketSource).toContain("wsUrl.searchParams.set('ticket', ticket)");
    expect(websocketSource).toContain('must never be placed in WebSocket URLs');

    expect(websocketSource).not.toMatch(/searchParams\.set\(['\"](?:token|apiToken|bearer|authorization)['\"]/i);
  });

  it.each(['global', 'analyst:test', 'analyst:telegram-42', 'analyst:other'])('rejects malformed exact-identity server frames for %s', (id) => {
    expect(LiveSyncSubscribedFrameSchema.safeParse({ t: 'subscribed', resource: 'conversation', id, lease: 'lease' }).success).toBe(false);
    expect(LiveSyncInvalidateFrameSchema.safeParse({ t: 'invalidate', resource: 'conversation', id }).success).toBe(false);
    expect(() => parseKnownWsEnvelope({ type: 'status', content: { event: 'analyst_turn_acknowledged', sessionId: id, restart: null } })).toThrow();
    expect(() => parseKnownWsEnvelope({ type: 'activity', content: { event: 'analyst_tool_invoked', sessionId: id, tool: 'read', success: true, summary: '' } })).toThrow();
  });

  it('accepts only runtime as an unscoped invalidation resource', () => {
    expect(LiveSyncInvalidateFrameSchema.safeParse({ t: 'invalidate', resource: 'runtime' }).success).toBe(true);
    for (const resource of ['timeline', 'files', 'processes']) {
      expect(LiveSyncInvalidateFrameSchema.safeParse({ t: 'invalidate', resource }).success).toBe(false);
    }
  });

  it('strictly parses valid known input and throws for unknown or malformed input', () => {
    const connected = buildConnectedEnvelope({ sessionId: 'agent:analyst:global' });
    expect(parseKnownWsEnvelope(connected)).toEqual(connected);

    expect(() => parseKnownWsEnvelope({ type: 'activity', content: { event: 'future_event' } })).toThrow();
    expect(() => parseKnownWsEnvelope({ type: 'activity', content: { event: 'card_history_appended' } })).toThrow();
  });
});
