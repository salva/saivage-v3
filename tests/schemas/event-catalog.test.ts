import { describe, expect, it } from '@jest/globals';
import { EventRegistry, eventKindValues, payloadSchemaByKind } from '../../src/schemas/event-catalog.js';

describe('EventRegistry', () => {
  it('keeps only currently emitted event kinds', () => {
    expect(eventKindValues).toEqual([
      'process_reconciled_dead',
      'process_reattach_rejected',
      'runtime_diagnostic',
      'runtime_actionable_error',
      'subscriber_error',
      'mcp_tool_invocation',
      'card_history_appended',
      'notification_added',
      'control_action_recorded',
      'analyst_tool_invoked',
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
    ]));
  });

  it('validates kept payload schemas from the catalog', () => {
    expect(() => payloadSchemaByKind.runtime_diagnostic.parse({ error_message: 'boom' })).not.toThrow();
    expect(() => payloadSchemaByKind.runtime_diagnostic.parse({})).toThrow();
    expect(() => payloadSchemaByKind.card_history_appended.parse({
      entry_id: '11111111-1111-4111-8111-111111111111',
      entry_kind: 'update',
      card_id: 'card-1',
      version_seq: 1,
      changed_fields: [],
      changed_at: '2026-01-01T00:00:00.000Z',
    })).not.toThrow();
  });
});
