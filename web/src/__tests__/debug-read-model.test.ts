import { describe, expect, it } from 'vitest';
import type { ContentReview, DebugErrorRecord, DebugTimelineEvent, DoctorCheck, DoctorIssue, ProcessView } from '../api/types';
import {
  filterTimelineByKinds,
  projectErrorRecord,
  projectTimelineError,
  selectDoctorIssuesBySeverity,
  selectErrorsBySource,
  selectFailedChecks,
  selectOperatorDataFreshnessLabel,
  selectReviewsByStatus,
  selectSortedProcesses,
  selectSortedTimeline,
  selectTimelineDerivedErrors,
  selectTimelineKindOptions,
} from '../stores/debug-read-model';

const timestamp = '2026-01-01T00:00:00.000Z';
const events = {
  runtime_diagnostic: { id: 'event-runtime-diagnostic', kind: 'runtime_diagnostic', timestamp, session_id: 'planner:project', card_id: 'card-a', goal_id: 'project', error_message: 'token=abc1234567890', metadata: { api_key: 'secret' } },
  runtime_actionable_error: { id: 'event-runtime-actionable', kind: 'runtime_actionable_error', timestamp, card_id: 'card-a', actionable_error: { message: 'act now', token: 'secret' } },
  subscriber_error: { id: 'event-subscriber', kind: 'subscriber_error', timestamp, goal_id: 'project', subscription_id: 'sub-1', source_kind: 'timeline', error_message: 'subscriber failed' },
  mcp_tool_invocation: { id: 'event-mcp', kind: 'mcp_tool_invocation', timestamp, server: 'tools', tool: 'inspect', success: false, duration_ms: 10, error: 'tool failed' },
  card_history_appended: { id: 'event-history', kind: 'card_history_appended', timestamp, entry_id: '11111111-1111-4111-8111-111111111111', entry_kind: 'update', card_id: 'card-a', version_seq: 2, changed_fields: ['title'], changed_at: timestamp },
  notification_added: { id: 'event-notification', kind: 'notification_added', timestamp, session_id: null, notification_kind: 'directive' },
  control_action_recorded: { id: 'event-control', kind: 'control_action_recorded', timestamp, action: 'inspect', target_kind: 'card', target_id: 'card-a', outcome: 'ok', created_at: timestamp },
  analyst_tool_invoked: { id: 'event-analyst', kind: 'analyst_tool_invoked', timestamp, sessionId: 'analyst:global', tool: 'inspect', success: true, summary: 'done' },
  conversation_changed: { id: 'event-conversation', kind: 'conversation_changed', timestamp, session_id: 'planner:project', mutation: 'entry_appended', message_id: 'message-1', message_kind: 'text', role: 'user', message_timestamp: timestamp },
  control_action_record_appended: { id: 'event-control-record', kind: 'control_action_record_appended', timestamp, record: { id: 'control-1' } },
  event_log_record_appended: { id: 'event-event-record', kind: 'event_log_record_appended', timestamp, record: { id: 'event-1' } },
  error_log_record_appended: { id: 'event-error-record', kind: 'error_log_record_appended', timestamp, record: { id: 'error-1' } },
} as const satisfies Record<string, DebugTimelineEvent>;

function process(overrides: Partial<ProcessView>): ProcessView {
  return {
    id: overrides.id ?? 'p', status: 'exited', started_at: timestamp, ended_at: null, exit_code: null, timed_out: false,
    owner_kind: 'agent', owner_id: 'agent-1', session_id: null, card_id: 'card-a', command: 'echo ok', cwd: null,
    logs: { stdout: null, stderr: null }, ...overrides,
  };
}

describe('debug-read-model', () => {
  it('projects canonical errors with source/type precedence and redacted metadata', () => {
    const error: DebugErrorRecord = { id: 'err-1', kind: 'error', timestamp, message: 'token=abc1234567890', cardId: 'card-a', goalId: 'project', phase: 'execute', metadata: { api_key: 'secret', safe: true } };
    const projected = projectErrorRecord(error);
    expect(projected).toMatchObject({ id: 'err-1', source: 'card-a', type: 'execute', severity: 'error' });
    expect(projected.message).toContain('[REDACTED]');
    expect(projected.details).toContain('[REDACTED]');
    expect(projectErrorRecord({ ...error, cardId: undefined }).source).toBe('project');
    expect(projectErrorRecord({ ...error, cardId: undefined, goalId: undefined }).source).toBe('execute');
    expect(projectErrorRecord({ ...error, cardId: undefined, goalId: undefined, phase: undefined }).source).toBe('runtime');
  });

  it('handles all 12 event variants explicitly with canonical error severity and source precedence', () => {
    const all = Object.values(events);
    expect(all.map(projectTimelineError).filter(Boolean)).toHaveLength(4);
    const errors = selectTimelineDerivedErrors(all);
    expect(errors.map((error) => error.type)).toEqual(['runtime_diagnostic', 'runtime_actionable_error', 'subscriber_error', 'mcp_tool_invocation']);
    expect(errors.map((error) => error.severity)).toEqual(['error', 'error', 'error', 'info']);
    expect(errors[0]).toMatchObject({ id: 'event-runtime-diagnostic', source: 'planner:project' });
    expect(errors[0]!.message).toContain('[REDACTED]');
    expect(errors[0]!.details).toContain('[REDACTED]');
    expect(errors[1]).toMatchObject({ source: 'card-a', message: 'act now' });
    expect(errors[2]).toMatchObject({ source: 'project' });
    expect(errors[3]).toMatchObject({ source: 'runtime', message: 'tool failed' });
    expect(projectTimelineError({ ...events.mcp_tool_invocation, success: true })).toBeNull();
    expect([...selectErrorsBySource(errors).keys()]).toEqual(['planner:project', 'card-a', 'project', 'runtime']);
  });

  it.each([{}, { message: null }, { message: 7 }])('uses a fail-safe actionable-error message for %p', (actionable_error) => {
    const result = projectTimelineError({ ...events.runtime_actionable_error, actionable_error });
    expect(result?.message).toBe('Runtime actionable error recorded');
    expect(result?.details).toContain('actionable_error');
  });

  it('projects and nonmutatingly sorts timeline rows, then offers and filters present canonical kinds', () => {
    const input: DebugTimelineEvent[] = [
      { ...events.runtime_diagnostic, timestamp: '2026-01-01T00:00:01.000Z' },
      events.mcp_tool_invocation,
    ];
    const original = [...input];
    const sorted = selectSortedTimeline(input);
    expect(input).toEqual(original);
    expect(sorted.map((event) => event.id)).toEqual(['event-runtime-diagnostic', 'event-mcp']);
    expect(sorted[0]).toMatchObject({ cardId: 'card-a', goalId: 'project', sessionId: 'planner:project' });
    expect(sorted[0]!.details).toMatchObject({ error_message: expect.any(String), metadata: { api_key: '[REDACTED]' } });
    expect(selectTimelineKindOptions(sorted)).toEqual(['mcp_tool_invocation', 'runtime_diagnostic']);
    expect(filterTimelineByKinds(sorted, ['mcp_tool_invocation']).map((event) => event.kind)).toEqual(['mcp_tool_invocation']);
  });

  it('projects freshness and process ordering', () => {
    expect(selectOperatorDataFreshnessLabel(timestamp, new Date('2026-01-01T00:00:30Z').getTime())).toBe('fresh');
    expect(selectSortedProcesses([process({ id: 'old', status: 'exited' }), process({ id: 'run', status: 'running' })]).map((entry) => entry.id)).toEqual(['run', 'old']);
  });

  it('groups doctor and supervision projections without store-only computed state', () => {
    const checks: DoctorCheck[] = [{ name: 'integrity', passed: false }, { name: 'metadata', passed: true }];
    const issues: DoctorIssue[] = [{ severity: 'error', message: 'missing' }, { severity: 'warning', message: 'unsafe' }];
    const reviews: ContentReview[] = [{ id: 'r1', source_kind: 'file', source_ref: 'file', status: 'passed', summary: 'safe', risk: 'low', created_at: timestamp }];
    expect(selectFailedChecks(checks).map((check) => check.name)).toEqual(['integrity']);
    expect(selectDoctorIssuesBySeverity(issues).get('warning')).toHaveLength(1);
    expect(selectReviewsByStatus(reviews).get('passed')).toHaveLength(1);
  });
});
