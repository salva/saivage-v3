import { describe, expect, it } from '@jest/globals';

import {
  ChatIdentityResponseSchema,
  ChatSendResponseSchema,
  chatOperatorApiContracts,
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
  it('does not declare handler-owned not-found outcomes for parameterized chat operations', () => {
    expect(chatOperatorApiContracts['chats.get'].response).not.toHaveProperty('404');
    expect(chatOperatorApiContracts['chats.send'].response).not.toHaveProperty('404');
  });

  it('encodes literal agent:analyst:global in chat and WebSocket success contracts', () => {
    expect(ChatIdentityResponseSchema.parse({ session_id: 'agent:analyst:global' }).session_id).toBe(
      'agent:analyst:global',
    );
    expect(ChatSendResponseSchema.parse({ sessionId: 'agent:analyst:global', toolInvocations: [], restart: null }).sessionId).toBe('agent:analyst:global');
    expect(buildConnectedEnvelope({sessionId:'agent:analyst:global'}).content.sessionId).toBe('agent:analyst:global');
    expect(AnalystTurnAcknowledgedStatusContentSchema.parse({ event: 'analyst_turn_acknowledged', sessionId: 'agent:analyst:global', restart: null }).sessionId).toBe('agent:analyst:global');
    expect(AnalystToolInvokedContentSchema.parse({ event: 'analyst_tool_invoked', sessionId: 'agent:analyst:global', tool: 'read', success: true, summary: '' }).sessionId).toBe('agent:analyst:global');
    expect(ToolInvocationContentSchema.parse({ event: 'tool_invocation', sessionId: 'agent:analyst:global', tool: 'read' }).sessionId).toBe('agent:analyst:global');
  });

  it.each(invalid)('rejects noncanonical Analyst identity %s at every success/event boundary', (sessionId) => {
    expect(ChatIdentityResponseSchema.safeParse({ session_id: sessionId }).success).toBe(false);
    expect(ChatSendResponseSchema.safeParse({ sessionId, toolInvocations: [], restart: null }).success).toBe(false);
    expect(ConnectedStatusContentSchema.safeParse({ event: 'connected', sessionId, timestamp, clientCount: 1 }).success).toBe(false);
    expect(AnalystTurnAcknowledgedStatusContentSchema.safeParse({ event: 'analyst_turn_acknowledged', sessionId, restart: null }).success).toBe(false);
    expect(AnalystToolInvokedContentSchema.safeParse({ event: 'analyst_tool_invoked', sessionId, tool: 'read', success: true, summary: '' }).success).toBe(false);
    expect(ToolInvocationContentSchema.safeParse({ event: 'tool_invocation', sessionId, tool: 'read' }).success).toBe(false);
  });

  it('accepts only the identity response and rejects removed transcript/activity fields', () => {
    const identity = { session_id: 'agent:analyst:global' as const };
    expect(ChatIdentityResponseSchema.parse(identity)).toEqual(identity);
    for (const removed of [
      { session: null },
      { entries: [] },
      { activity_status: { status: 'inactive', pending_calls: [] } },
      { sessionId: 'agent:analyst:global' },
    ]) {
      expect(ChatIdentityResponseSchema.safeParse({ ...identity, ...removed }).success).toBe(false);
    }
  });
});
