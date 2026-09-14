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
describe('changeset C contracts', () => {
  const summary = {
    id: 'agent:analyst:global',
    agent_name: 'analyst',
    session_scope: 'global',
    compaction: null,
    card_id: null,
    started_at: '2026-07-24T00:00:00.000Z',
    status: 'active',
    activity: 'busy',
  };
  it('has singular strict live summaries and transcript cursors', () => {
    expect(AgentSessionSummarySchema.parse(summary)).toEqual(summary);
    expect(AgentSessionSummarySchema.safeParse({ ...summary, status: undefined }).success).toBe(false);
    expect(AgentSessionSummarySchema.safeParse({ ...summary, compaction: undefined }).success).toBe(false);
    expect(AgentSessionSummarySchema.safeParse({ ...summary, compaction: { strategy: 'preventive', started_at: summary.started_at, folds_done: 2, fold_in_flight: true } }).success).toBe(true);
    expect(AgentSessionSummarySchema.safeParse({ ...summary, status: 'inactive', activity: 'idle', compaction: { strategy: 'preventive', started_at: summary.started_at, folds_done: 2, fold_in_flight: true } }).success).toBe(false);
    expect(AgentSessionSummarySchema.safeParse({ ...summary, compaction: { strategy: 'preventive', startedAt: summary.started_at, foldsDone: 2, foldInFlight: true } }).success).toBe(false);
    expect(AgentSessionSummarySchema.safeParse({ ...summary, activity: undefined }).success).toBe(false);
    expect(AgentSessionSummarySchema.safeParse({ ...summary, status: 'inactive', activity: 'idle' }).success).toBe(true);
    expect(AgentSessionSummarySchema.safeParse({ ...summary, status: 'active', activity: 'idle' }).success).toBe(false);
    expect(AgentSessionSummarySchema.safeParse({ ...summary, status: 'running' }).success).toBe(false);
    expect(AgentSessionSummarySchema.safeParse({ ...summary, extra: true }).success).toBe(false);
    expect(
      AgentConversationResponseSchema.parse({ session_id: summary.id, segment_version: 1, segment_context: null, entries: [], cursor: { segment_version: 1, message_id: 'z' } })
        .cursor,
    ).toEqual({ segment_version: 1, message_id: 'z' });
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
        segment_version: 1,
        visible_message_id: 'a',
      }).success,
    ).toBe(true);
  });
});
