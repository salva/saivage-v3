import { describe, expect, it } from '@jest/globals';
import { ConnectedStatusContentSchema, ServerEgressWsEnvelopeSchema, parseLiveSyncClientFrame } from '../../src/contracts/operator-events.js';
import { ChatSendRequestSchema, MAX_INBOUND_ANALYST_TEXT_CHARS } from '../../src/contracts/operator-api-chats.js';

describe('observation-only WebSocket contracts', () => {
  it('accepts exact transport status without Analyst identity', () => {
    const content = { event: 'connected', timestamp: '2026-08-11T00:00:00.000Z', clientCount: 1 };
    expect(ConnectedStatusContentSchema.parse(content)).toEqual(content);
    expect(ConnectedStatusContentSchema.safeParse({ ...content, sessionId: 'agent:analyst:global' }).success).toBe(false);
  });
  it.each(['message', 'activity', 'error'])('rejects removed %s envelopes', (type) => {
    const frame = { type, content: { text: 'inspect' } };
    expect(parseLiveSyncClientFrame(frame)).toBeNull();
    expect(ServerEgressWsEnvelopeSchema.safeParse(frame).success).toBe(false);
  });
  it('retains the separate REST text bound', () => {
    expect(ChatSendRequestSchema.safeParse({ content: 'a'.repeat(MAX_INBOUND_ANALYST_TEXT_CHARS) }).success).toBe(true);
    expect(ChatSendRequestSchema.safeParse({ content: 'a'.repeat(MAX_INBOUND_ANALYST_TEXT_CHARS + 1) }).success).toBe(false);
  });
});
