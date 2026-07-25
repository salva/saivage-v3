import {
  AgentConversationResponseSchema,
  AgentSessionSummarySchema,
  CardAgentSessionsResponseSchema,
} from '../../src/contracts/operator-api-agents.js';
import { ChatIdentityResponseSchema } from '../../src/contracts/operator-api-chats.js';
import {
  LiveSyncClientFrameSchema,
  LiveSyncInvalidateFrameSchema,
} from '../../src/contracts/operator-events.js';
import { describe, expect, it } from '@jest/globals';
import {
  ListAgentSessionsToolResultSchema,
  ReadAgentSessionToolResultSchema,
} from '../../src/tools/analyst-misc-tools.js';
describe('changeset C contracts', () => {
  const summary = {
    id: 'agent:analyst:global',
    agent_name: 'analyst',
    session_scope: 'global',
    card_id: null,
    started_at: '2026-07-24T00:00:00.000Z',
  };
  it('has singular durable summaries and transcript cursors', () => {
    expect(AgentSessionSummarySchema.parse(summary)).toEqual(summary);
    expect(AgentSessionSummarySchema.safeParse({ ...summary, status: 'active' }).success).toBe(
      false,
    );
    expect(
      AgentConversationResponseSchema.parse({ session_id: summary.id, entries: [], cursor: 'z' })
        .cursor,
    ).toBe('z');
    expect(ChatIdentityResponseSchema.parse({ session_id: summary.id })).toEqual({
      session_id: summary.id,
    });
    expect(CardAgentSessionsResponseSchema.parse({ card_id: 'card-a', sessions: [] })).toEqual({
      card_id: 'card-a',
      sessions: [],
    });
  });
  it('has exact independent leases and watermarks', () => {
    for (const resource of ['conversation', 'llm-exchange'] as const)
      expect(
        LiveSyncClientFrameSchema.safeParse({
          t: 'subscribe',
          resource,
          id: summary.id,
          lease: 'x',
        }).success,
      ).toBe(true);
    expect(
      LiveSyncClientFrameSchema.safeParse({
        t: 'subscribe',
        resource: 'agents',
        lease: 'x',
        id: summary.id,
      }).success,
    ).toBe(false);
    expect(
      LiveSyncInvalidateFrameSchema.safeParse({
        t: 'invalidate',
        resource: 'conversation',
        id: summary.id,
      }).success,
    ).toBe(false);
    expect(
      LiveSyncInvalidateFrameSchema.safeParse({
        t: 'invalidate',
        resource: 'conversation',
        id: summary.id,
        through_message_id: 'a',
      }).success,
    ).toBe(true);
  });
  it('atomically rejects former Analyst producer wrappers', () => {
    expect(
      ListAgentSessionsToolResultSchema.safeParse({ success: true, data: [summary] }).success,
    ).toBe(false);
    expect(
      ListAgentSessionsToolResultSchema.safeParse({ success: true, data: { sessions: [summary] } })
        .success,
    ).toBe(true);
    expect(
      ReadAgentSessionToolResultSchema.safeParse({
        success: false,
        error: 'missing',
        data: { sessionId: summary.id },
      }).success,
    ).toBe(false);
    expect(
      ReadAgentSessionToolResultSchema.safeParse({
        success: true,
        data: { session: summary, total_messages: 0, returned: 0, parse_errors: 0, messages: [] },
      }).success,
    ).toBe(false);
  });
});
