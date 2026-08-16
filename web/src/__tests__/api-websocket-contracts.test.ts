import { describe, expect, it } from 'vitest';
import websocketSource from '../api/websocket.ts?raw';
import {
  LiveSyncInvalidateFrameSchema,
  LiveSyncSubscribedFrameSchema,
  buildConnectedEnvelope,
  parseKnownWsContent,
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
    expect(() => parseKnownWsContent({ event: 'analyst_turn_acknowledged', sessionId: id, restart: null })).toThrow();
    expect(() => parseKnownWsContent({ event: 'analyst_tool_invoked', sessionId: id, tool: 'read', success: true, summary: '' })).toThrow();
  });

  it('accepts only runtime and timeline as unscoped invalidation resources', () => {
    for (const resource of ['runtime', 'timeline']) {
      expect(LiveSyncInvalidateFrameSchema.safeParse({ t: 'invalidate', resource }).success).toBe(true);
    }
    for (const resource of ['files', 'processes']) {
      expect(LiveSyncInvalidateFrameSchema.safeParse({ t: 'invalidate', resource }).success).toBe(false);
    }
  });

  it('strictly parses valid known input and throws for unknown or malformed input', () => {
    const connected = buildConnectedEnvelope({ sessionId: 'agent:analyst:global' });
    expect(parseKnownWsContent(connected.content)).toEqual(connected.content);
    expect(parseKnownWsEnvelope(connected)).toEqual(connected);

    expect(() => parseKnownWsContent({ event: 'future_event' })).toThrow();
    expect(() => parseKnownWsContent({ event: 'card_history_appended' })).toThrow();
    expect(() => parseKnownWsEnvelope({ type: 'activity', content: { event: 'future_event' } })).toThrow();
    expect(() => parseKnownWsEnvelope({ type: 'activity', content: { event: 'card_history_appended' } })).toThrow();
  });
});
