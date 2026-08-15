import { describe, expect, it } from 'vitest';
import {
  AgentConversationResponseSchema,
  AgentSessionSummarySchema,
  CardAgentSessionsResponseSchema,
} from '@saivage/contracts/operator-api';
import {
  LiveSyncClientFrameSchema,
  LiveSyncInvalidateFrameSchema,
} from '@saivage/contracts/operator-events';
const session = {
  id: 'agent:analyst:global',
  agent_name: 'analyst',
  session_scope: 'global',
  card_id: null,
  started_at: '2026-07-24T00:00:00.000Z',
  status: 'active',
  activity: 'busy',
};
describe('changeset C browser contracts', () => {
  it('requires the valid status/activity pair and rejects unrelated telemetry', () => {
    expect(AgentSessionSummarySchema.safeParse(session).success).toBe(true);
    expect(AgentSessionSummarySchema.safeParse({ ...session, status: 'inactive', activity: 'idle' }).success).toBe(true);
    expect(AgentSessionSummarySchema.safeParse({ ...session, activity: 'idle' }).success).toBe(false);
    expect(AgentSessionSummarySchema.safeParse({ ...session, status: undefined }).success).toBe(false);
    expect(AgentSessionSummarySchema.safeParse({ ...session, model: 'x' }).success).toBe(false);
  });
  it('requires strict cursor transcript and card partition shapes', () => {
    expect(
      AgentConversationResponseSchema.safeParse({
        session_id: session.id,
        segment_version: 1,
        segment_context: null,
        entries: [],
        cursor: { segment_version: 1, message_id: 'z' },
      }).success,
    ).toBe(true);
    expect(
      CardAgentSessionsResponseSchema.safeParse({ card_id: 'card-a', sessions: [] }).success,
    ).toBe(true);
  });
  it('separates exact leases and opaque watermarks', () => {
    expect(
      LiveSyncClientFrameSchema.parse({
        t: 'subscribe',
        resource: 'llm-exchange',
        id: session.id,
        lease: 'l',
      }).resource,
    ).toBe('llm-exchange');
    expect(
      LiveSyncInvalidateFrameSchema.safeParse({
        t: 'invalidate',
        resource: 'conversation',
        id: session.id,
      }).success,
    ).toBe(false);
    expect(
      LiveSyncInvalidateFrameSchema.safeParse({
        t: 'invalidate',
        resource: 'conversation',
        id: session.id,
        segment_version: 1, visible_message_id: 'a',
      }).success,
    ).toBe(true);
  });
});
