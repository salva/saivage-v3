import { describe, expect, it } from '@jest/globals';

import {
  ChatIdentityResponseSchema,
  ChatSendResponseSchema,
  AnalystTurnBusyErrorSchema,
  chatOperatorApiContracts,
} from '../../src/contracts/operator-api-chats.js';
import {
  ConnectedStatusContentSchema,
  buildConnectedEnvelope,
} from '../../src/contracts/operator-events.js';

const invalid = ['global', 'analyst:test', 'analyst:telegram-42', 'analyst:other'] as const;
const timestamp = '2026-07-17T00:00:00.000Z';
const availability = { mode: 'internal' as const, internal_enabled: true, external_enabled: false };

describe('singleton Analyst contracts', () => {
  it('does not declare handler-owned not-found outcomes for parameterized chat operations', () => {
    expect(chatOperatorApiContracts['chats.get'].response).not.toHaveProperty('404');
    expect(chatOperatorApiContracts['chats.send'].response).not.toHaveProperty('404');
  });

  it('keeps chat identity authoritative and connected status transport-only', () => {
    expect(ChatIdentityResponseSchema.parse({ session_id: 'agent:analyst:global', ...availability }).session_id).toBe(
      'agent:analyst:global',
    );
    expect(ChatSendResponseSchema.parse({ toolInvocations: [], restart: null })).toEqual({ toolInvocations: [], restart: null });
    expect(buildConnectedEnvelope({}).content).not.toHaveProperty('sessionId');
  });

  it.each(invalid)('rejects noncanonical Analyst identity %s at every identity-bearing success/event boundary', (sessionId) => {
    expect(ChatIdentityResponseSchema.safeParse({ session_id: sessionId, ...availability }).success).toBe(false);
    expect(ConnectedStatusContentSchema.safeParse({ event: 'connected', sessionId, timestamp, clientCount: 1 }).success).toBe(false);
  });

  it('accepts only identity/availability and rejects missing capabilities or removed transcript/activity fields', () => {
    const identity = { session_id: 'agent:analyst:global' as const, ...availability };
    expect(ChatIdentityResponseSchema.parse(identity)).toEqual(identity);
    for (const field of ['mode', 'internal_enabled', 'external_enabled'])
      expect(ChatIdentityResponseSchema.safeParse({ ...identity, [field]: undefined }).success).toBe(false);
    for (const removed of [
      { session: null },
      { entries: [] },
      { activity_status: { status: 'inactive', pending_calls: [] } },
      { sessionId: 'agent:analyst:global' },
    ]) {
      expect(ChatIdentityResponseSchema.safeParse({ ...identity, ...removed }).success).toBe(false);
    }
  });

  it('keeps both session identity spellings out of the POST response', () => {
    const response = { toolInvocations: [], restart: null };
    expect(ChatSendResponseSchema.parse(response)).toEqual(response);
    expect(ChatSendResponseSchema.safeParse({ ...response, sessionId: 'agent:analyst:global' }).success).toBe(false);
    expect(ChatSendResponseSchema.safeParse({ ...response, session_id: 'agent:analyst:global' }).success).toBe(false);
  });

  it('keeps REST busy errors strict and content-free', () => {
    const busy = { error: 'analyst_turn_busy', message: 'Another Analyst turn is active. Retry after it finishes.' };
    expect(AnalystTurnBusyErrorSchema.parse(busy)).toEqual(busy);
    expect(AnalystTurnBusyErrorSchema.safeParse({ ...busy, details: 'not admitted' }).success).toBe(false);
  });
});
