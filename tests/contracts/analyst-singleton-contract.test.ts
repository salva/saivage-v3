import { describe, expect, it } from '@jest/globals';

import {
  ChatEntriesResponseSchema,
  ChatListResponseSchema,
  ChatSendResponseSchema,
} from '../../src/contracts/operator-api-chats.js';
import {
  AnalystToolInvokedContentSchema,
  AnalystTurnAcknowledgedStatusContentSchema,
  ConnectedStatusContentSchema,
  ToolInvocationContentSchema,
  buildConnectedEnvelope,
} from '../../src/contracts/operator-events.js';

const invalid = ['global', 'analyst:test', 'analyst:telegram-42', 'analyst:other'] as const;
const timestamp = '2026-07-17T00:00:00.000Z';

describe('singleton Analyst contracts', () => {
  it('encodes literal analyst:global in chat and WebSocket success contracts', () => {
    expect(ChatListResponseSchema.parse({ sessions: [{ id: 'analyst:global', role: 'analyst', status: 'active', started_at: timestamp }] }).sessions[0]!.id).toBe('analyst:global');
    expect(ChatEntriesResponseSchema.parse({ sessionId: 'analyst:global', entries: [entry()] }).sessionId).toBe('analyst:global');
    expect(ChatSendResponseSchema.parse({ sessionId: 'analyst:global', toolInvocations: [], restart: null }).sessionId).toBe('analyst:global');
    expect(buildConnectedEnvelope().content.sessionId).toBe('analyst:global');
    expect(AnalystTurnAcknowledgedStatusContentSchema.parse({ event: 'analyst_turn_acknowledged', sessionId: 'analyst:global', restart: null }).sessionId).toBe('analyst:global');
    expect(AnalystToolInvokedContentSchema.parse({ event: 'analyst_tool_invoked', sessionId: 'analyst:global', tool: 'read', success: true, summary: '' }).sessionId).toBe('analyst:global');
    expect(ToolInvocationContentSchema.parse({ event: 'tool_invocation', sessionId: 'analyst:global', tool: 'read' }).sessionId).toBe('analyst:global');
  });

  it.each(invalid)('rejects noncanonical Analyst identity %s at every success/event boundary', (sessionId) => {
    expect(ChatListResponseSchema.safeParse({ sessions: [{ id: sessionId, role: 'analyst', status: 'active', started_at: timestamp }] }).success).toBe(false);
    expect(ChatEntriesResponseSchema.safeParse({ sessionId, entries: [] }).success).toBe(false);
    expect(ChatSendResponseSchema.safeParse({ sessionId, toolInvocations: [], restart: null }).success).toBe(false);
    expect(ConnectedStatusContentSchema.safeParse({ event: 'connected', sessionId, timestamp, clientCount: 1 }).success).toBe(false);
    expect(AnalystTurnAcknowledgedStatusContentSchema.safeParse({ event: 'analyst_turn_acknowledged', sessionId, restart: null }).success).toBe(false);
    expect(AnalystToolInvokedContentSchema.safeParse({ event: 'analyst_tool_invoked', sessionId, tool: 'read', success: true, summary: '' }).success).toBe(false);
    expect(ToolInvocationContentSchema.safeParse({ event: 'tool_invocation', sessionId, tool: 'read' }).success).toBe(false);
  });
});

function entry() {
  return { id: 'm1', session_id: 'analyst:global', role: 'user', kind: 'text', content: 'hello', round_id: 'r-user-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', message_index: 0, block_index: 0, timestamp };
}
