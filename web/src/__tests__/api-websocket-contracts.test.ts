import { describe, expect, it } from 'vitest';
import websocketSource from '../api/websocket.ts?raw';
import {
  LiveSyncInvalidateFrameSchema,
  LiveSyncSubscribedFrameSchema,
  buildConnectedEnvelope,
  parseServerEgressWsEnvelope,
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
    expect(() => parseServerEgressWsEnvelope({ type: 'status', content: { event: 'analyst_turn_acknowledged', sessionId: id, restart: null } })).toThrow();
    expect(() => parseServerEgressWsEnvelope({ type: 'activity', content: { event: 'analyst_tool_invoked', sessionId: id, tool: 'read', success: true, summary: '' } })).toThrow();
  });

  it('accepts only runtime as an unscoped invalidation resource', () => {
    expect(LiveSyncInvalidateFrameSchema.safeParse({ t: 'invalidate', resource: 'runtime' }).success).toBe(true);
    for (const resource of ['timeline', 'files', 'processes']) {
      expect(LiveSyncInvalidateFrameSchema.safeParse({ t: 'invalidate', resource }).success).toBe(false);
    }
  });

  it('strictly parses valid server input and throws for wrong-direction, unknown, or malformed input', () => {
    const connected = buildConnectedEnvelope({ sessionId: 'agent:analyst:global' });
    expect(parseServerEgressWsEnvelope(connected)).toEqual(connected);

    expect(() => parseServerEgressWsEnvelope({ type: 'activity', content: { event: 'future_event' } })).toThrow();
    expect(() => parseServerEgressWsEnvelope({
      type: 'activity',
      content: {
        event: 'card_history_appended',
        card_id: 'project',
        version_seq: 2,
        changed_fields: ['pending_notifications'],
        changed_at: '2026-09-09T00:00:00.000Z',
      },
    })).toThrow();
    expect(() => parseServerEgressWsEnvelope({ type: 'message', content: { text: 'browser input only' } })).toThrow();
    expect(() => parseServerEgressWsEnvelope({ type: 'thinking', content: {} })).toThrow();
    expect(() => parseServerEgressWsEnvelope({ ...connected, extra: true })).toThrow();
  });

  it('requires the classified ToolResult activity contract', () => {
    const activity = {
      type: 'activity',
      content: {
        event: 'tool_invocation',
        sessionId: 'agent:analyst:global',
        tool: 'read',
        params: {},
        result: { success: true, data: { visible: true } },
      },
    };
    expect(parseServerEgressWsEnvelope(activity)).toEqual(activity);
    expect(() => parseServerEgressWsEnvelope({
      ...activity,
      content: { ...activity.content, result: { success: true, error: 'impossible' } },
    })).toThrow();
  });

  it('preserves exact queue notification success and activation-closed failure events', () => {
    const content = {
      event: 'tool_invocation' as const,
      sessionId: 'agent:analyst:global',
      tool: 'queue_notification',
      params: { card_id: 'card-a', kind: 'progress', body: 'Working' },
    };
    const success = {
      type: 'activity' as const,
      content: {
        ...content,
        result: { success: true as const, data: { queued: true, card_id: 'card-a', notification_id: 'notification-a' } },
      },
    };
    const failure = {
      type: 'activity' as const,
      content: {
        ...content,
        result: {
          success: false as const,
          error: "Cannot queue notification for card 'card-a': its current activation is closed to new notifications.",
          data: { queued: false, reason: 'activation_closed', card_id: 'card-a' },
        },
      },
    };
    expect(parseServerEgressWsEnvelope(success)).toEqual(success);
    expect(parseServerEgressWsEnvelope(failure)).toEqual(failure);
    expect(failure.content.result.data).not.toHaveProperty('status');
    expect(failure.content.result.data).not.toHaveProperty('winner');
  });
});
