import { describe, expect, it } from '@jest/globals';

import {
  ChatEntriesResponseSchema,
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
    expect(ChatEntriesResponseSchema.parse({ session_id:'agent:analyst:global',session: session('inactive'), entries: [entry()], activity_status: { status: 'inactive', pending_calls: [] } }).session?.id).toBe('agent:analyst:global');
    expect(ChatSendResponseSchema.parse({ sessionId: 'agent:analyst:global', toolInvocations: [], restart: null }).sessionId).toBe('agent:analyst:global');
    expect(buildConnectedEnvelope({sessionId:'agent:analyst:global'}).content.sessionId).toBe('agent:analyst:global');
    expect(AnalystTurnAcknowledgedStatusContentSchema.parse({ event: 'analyst_turn_acknowledged', sessionId: 'agent:analyst:global', restart: null }).sessionId).toBe('agent:analyst:global');
    expect(AnalystToolInvokedContentSchema.parse({ event: 'analyst_tool_invoked', sessionId: 'agent:analyst:global', tool: 'read', success: true, summary: '' }).sessionId).toBe('agent:analyst:global');
    expect(ToolInvocationContentSchema.parse({ event: 'tool_invocation', sessionId: 'agent:analyst:global', tool: 'read' }).sessionId).toBe('agent:analyst:global');
  });

  it.each(invalid)('rejects noncanonical Analyst identity %s at every success/event boundary', (sessionId) => {
    expect(ChatEntriesResponseSchema.safeParse({ session_id:sessionId,session: { ...session('inactive'),id:sessionId }, entries: [], activity_status: { status: 'inactive', pending_calls: [] } }).success).toBe(false);
    expect(ChatSendResponseSchema.safeParse({ sessionId, toolInvocations: [], restart: null }).success).toBe(false);
    expect(ConnectedStatusContentSchema.safeParse({ event: 'connected', sessionId, timestamp, clientCount: 1 }).success).toBe(false);
    expect(AnalystTurnAcknowledgedStatusContentSchema.safeParse({ event: 'analyst_turn_acknowledged', sessionId, restart: null }).success).toBe(false);
    expect(AnalystToolInvokedContentSchema.safeParse({ event: 'analyst_tool_invoked', sessionId, tool: 'read', success: true, summary: '' }).success).toBe(false);
    expect(ToolInvocationContentSchema.safeParse({ event: 'tool_invocation', sessionId, tool: 'read' }).success).toBe(false);
  });

  it('accepts only the exact absent chat shape and rejects every null-session live or populated variant', () => {
    const absent = { session_id:'agent:analyst:global',session: null, entries: [], activity_status: { status: 'inactive', pending_calls: [] } };
    expect(ChatEntriesResponseSchema.parse(absent)).toEqual(absent);
    expect(ChatEntriesResponseSchema.safeParse({ ...absent, entries: [entry()] }).success).toBe(false);
    expect(ChatEntriesResponseSchema.safeParse({ ...absent, activity_status: { status: 'active', pending_calls: [] } }).success).toBe(false);
    expect(ChatEntriesResponseSchema.safeParse({ ...absent, activity_status: { status: 'waiting', pending_calls: [{ id: 'call-1', tool: 'webfetch', started_at: timestamp }] } }).success).toBe(false);
  });

  it('strictly enforces present session/activity equality, entry correlation, pending-call shape, and removed vocabulary', () => {
    const waiting = { session_id:'agent:analyst:global',session: session('waiting'), entries: [entry()], activity_status: { status: 'waiting', pending_calls: [{ id: 'call-1', tool: 'webfetch', started_at: timestamp }] } };
    expect(ChatEntriesResponseSchema.parse(waiting)).toEqual(waiting);
    expect(ChatEntriesResponseSchema.safeParse({ ...waiting, session: { ...waiting.session, status: 'active' } }).success).toBe(false);
    expect(ChatEntriesResponseSchema.safeParse({ ...waiting, entries: [{ ...entry(), session_id: 'agent:planner:project' }] }).success).toBe(false);
    for (const status of ['idle', 'thinking', 'tool_calling', 'responding', 'compacting']) {
      expect(ChatEntriesResponseSchema.safeParse({ ...waiting, session: { ...waiting.session, status }, activity_status: { status, pending_calls: [] } }).success).toBe(false);
    }
    expect(ChatEntriesResponseSchema.safeParse({ ...waiting, activity_status: { ...waiting.activity_status, updated_at: timestamp } }).success).toBe(false);
    expect(ChatEntriesResponseSchema.safeParse({ ...waiting, activity_status: { ...waiting.activity_status, pending_calls: [{ ...waiting.activity_status.pending_calls[0], process_id: 'proc-a' }] } }).success).toBe(false);
    expect(ChatEntriesResponseSchema.safeParse({ ...waiting, sessionId: 'agent:analyst:global' }).success).toBe(false);
    expect(ChatEntriesResponseSchema.safeParse({ ...waiting, extra: true }).success).toBe(false);
    expect(ChatEntriesResponseSchema.safeParse({ ...waiting, session: { ...waiting.session, completed_at: timestamp } }).success).toBe(false);
  });
});

function entry() {
  return { id: 'm1', session_id: 'agent:analyst:global', role: 'user', kind: 'text', content: 'hello', round_id: 'r-user-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', message_index: 0, block_index: 0, timestamp };
}
function session(status:'active'|'waiting'|'inactive') {return {id:'agent:analyst:global' as const,agent_name:'analyst',session_scope:'global' as const,card_id:null,status,started_at:timestamp};}
