import { describe, expect, it } from '@jest/globals';
import { buildLoggedEventSchema, EventRegistry, eventKindValues, payloadSchemaByKind } from '../../src/schemas/event-catalog.js';

describe('EventRegistry', () => {
  it('keeps only currently emitted event kinds', () => {
    expect(eventKindValues).toEqual([
      'runtime_diagnostic',
      'runtime_actionable_error',
      'subscriber_error',
      'mcp_tool_invocation',
      'card_history_appended',
      'notification_added',
      'control_action_recorded',
      'analyst_tool_invoked',
      'conversation_changed',
      'control_action_record_appended',
      'event_log_record_appended',
      'error_log_record_appended',
    ]);
  });

  it('does not contain removed legacy runtime, session, or LLM event kinds', () => {
    const keys = Object.keys(EventRegistry);
    expect(keys).not.toEqual(expect.arrayContaining([
      'goal_completed',
      'card_failed',
      'session_started',
      'llm_attempt',
      'llm_invocation_summary',
      'runtime_activation',
      'stuck_supervisor_started',
      'process_reconciled_dead',
      'process_reattach_rejected',
    ]));
  });

  it('validates kept payload schemas from the catalog', () => {
    expect(() => payloadSchemaByKind.runtime_diagnostic.parse({ error_message: 'boom' })).not.toThrow();
    expect(() => payloadSchemaByKind.runtime_diagnostic.parse({})).toThrow();
    expect(() => payloadSchemaByKind.card_history_appended.parse({
      entry_id: '11111111-1111-4111-8111-111111111111',
      entry_kind: 'update',
      card_id: '11111111-1111-4111-8111-111111111111',
      version_seq: 1,
      changed_fields: [],
      changed_at: '2026-01-01T00:00:00.000Z',
    })).not.toThrow();
    expect(payloadSchemaByKind.notification_added.parse({ session_id: null, notification_kind: 'runtime_state' })).toMatchObject({ notification_kind: 'runtime_state' });
    expect(() => payloadSchemaByKind.notification_added.parse({ session_id: null, kind: 'runtime_state' })).toThrow();
  });

  it('keeps logged event kind as the envelope discriminator', () => {
    const schema = buildLoggedEventSchema('notification_added');
    expect(() => schema.parse({
      id: 'event-1',
      kind: 'notification_added',
      timestamp: '2026-01-01T00:00:00.000Z',
      session_id: null,
      notification_kind: 'runtime_state',
    })).not.toThrow();
    expect(() => schema.parse({
      id: 'event-1',
      kind: 'wrong_kind',
      timestamp: '2026-01-01T00:00:00.000Z',
      session_id: null,
      notification_kind: 'runtime_state',
    })).toThrow();
  });
});
