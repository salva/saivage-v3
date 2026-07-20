import type { LoggedEventByKind } from '../../src/schemas/index.js';

const timestamp = '2026-01-01T00:00:00.000Z';

export const representativeLoggedEvents = {
  runtime_diagnostic: { id: 'event-runtime-diagnostic', kind: 'runtime_diagnostic', timestamp, session_id: 'planner:project', card_id: 'card-a', goal_id: 'project', phase: 'execute', error_message: 'boom', error_name: 'Error', metadata: { attempt: 1 } },
  runtime_actionable_error: { id: 'event-runtime-actionable', kind: 'runtime_actionable_error', timestamp, actionable_error: { message: 'fix this', code: 'TEST' } },
  subscriber_error: { id: 'event-subscriber-error', kind: 'subscriber_error', timestamp, subscription_id: 'sub-1', source_kind: 'timeline', error_message: 'subscriber failed', timed_out: false },
  mcp_tool_invocation: { id: 'event-mcp', kind: 'mcp_tool_invocation', timestamp, server: 'tools', tool: 'inspect', success: false, duration_ms: 12, error: 'tool failed' },
  card_history_appended: { id: 'event-card-history', kind: 'card_history_appended', timestamp, entry_id: '11111111-1111-4111-8111-111111111111', entry_kind: 'update', card_id: 'card-a', version_seq: 2, changed_fields: ['title'], changed_at: timestamp },
  notification_added: { id: 'event-notification', kind: 'notification_added', timestamp, session_id: null, notification_kind: 'directive' },
  control_action_recorded: { id: 'event-control', kind: 'control_action_recorded', timestamp, action: 'inspect', target_kind: 'card', target_id: 'card-a', outcome: 'ok', created_at: timestamp, actor: 'user', surface: 'rest' },
  analyst_tool_invoked: { id: 'event-analyst-tool', kind: 'analyst_tool_invoked', timestamp, sessionId: 'analyst:global', tool: 'inspect', success: true, summary: 'done', related_card_id: 'card-a' },
  conversation_changed: { id: 'event-conversation', kind: 'conversation_changed', timestamp, session_id: 'planner:project', mutation: 'entry_appended', message_id: 'message-1', message_kind: 'text', role: 'user', message_timestamp: timestamp },
  control_action_record_appended: { id: 'event-control-record', kind: 'control_action_record_appended', timestamp, record: { id: 'control-1' } },
  event_log_record_appended: { id: 'event-event-record', kind: 'event_log_record_appended', timestamp, record: { id: 'event-1' } },
  error_log_record_appended: { id: 'event-error-record', kind: 'error_log_record_appended', timestamp, record: { id: 'error-1' } },
} as const satisfies { [K in keyof LoggedEventByKind]: LoggedEventByKind[K] };

export const allRepresentativeLoggedEvents = Object.values(representativeLoggedEvents);
