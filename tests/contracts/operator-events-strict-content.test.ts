import { describe, expect, it } from '@jest/globals';

import {
  AnalystToolInvokedContentSchema,
  CardHistoryAppendedContentSchema,
  ConnectedStatusContentSchema,
  ControlActionRecordedContentSchema,
  InboundAnalystMessageContentSchema,
  NotificationAddedContentSchema,
  ClassifiedToolInvocationActivityContentSchema,
} from '../../src/contracts/operator-events.js';

const strictContentCases = [
  {
    name: 'connected status',
    schema: ConnectedStatusContentSchema,
    valid: {
      event: 'connected',
      sessionId: 'agent:analyst:global',
      timestamp: '2026-08-11T00:00:00.000Z',
      clientCount: 1,
    },
  },
  {
    name: 'card history appended activity',
    schema: CardHistoryAppendedContentSchema,
    valid: {
      event: 'card_history_appended',
      card_id: 'project',
      version_seq: 2,
      changed_fields: ['title'],
      changed_at: '2026-08-11T00:00:00.000Z',
    },
  },
  {
    name: 'notification added activity',
    schema: NotificationAddedContentSchema,
    valid: { event: 'notification_added', session_id: null, kind: 'card_updated' },
  },
  {
    name: 'control action recorded activity',
    schema: ControlActionRecordedContentSchema,
    valid: {
      event: 'control_action_recorded',
      id: 'action-1',
      action: 'pause',
      target_kind: null,
      target_id: null,
      outcome: 'accepted',
      created_at: '2026-08-11T00:00:00.000Z',
      actor: 'operator',
      surface: 'web',
    },
  },
  {
    name: 'Analyst tool invoked activity',
    schema: AnalystToolInvokedContentSchema,
    valid: {
      event: 'analyst_tool_invoked',
      sessionId: 'agent:analyst:global',
      tool: 'read',
      success: true,
      summary: 'Read the requested file.',
      related_card_id: 'project',
    },
  },
  {
    name: 'tool invocation activity',
    schema: ClassifiedToolInvocationActivityContentSchema,
    valid: {
      event: 'tool_invocation',
      sessionId: 'agent:analyst:global',
      tool: 'read',
      params: { path: 'README.md' },
      result: { success: true },
    },
  },
  {
    name: 'inbound Analyst message',
    schema: InboundAnalystMessageContentSchema,
    valid: { text: 'Inspect the current project.' },
  },
] as const;

describe('strict WebSocket content contracts', () => {
  it.each(strictContentCases)('accepts exact $name content', ({ schema, valid }) => {
    expect(schema.parse(valid)).toEqual(valid);
  });

  it.each(strictContentCases)('rejects an undeclared key on $name content', ({ schema, valid }) => {
    expect(schema.safeParse({ ...valid, unexpected: true }).success).toBe(false);
  });
});
