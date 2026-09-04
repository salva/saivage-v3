import { describe, expect, it } from 'vitest';
import type { DebugErrorRecord, ProcessView } from '../api/types';
import { projectErrorRecord, selectErrorsBySource, selectRuntimeStatusLabel, selectSortedProcesses } from '../stores/debug-read-model';

const timestamp = '2026-01-01T00:00:00.000Z';
const diagnostic = { id: 'event-diagnostic', kind: 'runtime_diagnostic', timestamp, card_id: 'card-a', goal_id: 'project', phase: 'execute', error_message: 'token=abc1234567890' } as const satisfies DebugErrorRecord;
const actionable = { id: 'event-actionable', kind: 'runtime_actionable_error', timestamp, actionable_error: { code: 'blocked', message: 'act now', nextAction: 'retry', cardId: 'card-a' } } as const satisfies DebugErrorRecord;
const mcpFailure = { id: 'event-mcp', kind: 'mcp_tool_invocation', timestamp, server: 'tools', tool: 'inspect', success: false, duration_ms: 10, error: 'tool failed' } as const satisfies DebugErrorRecord;

function process(overrides: Partial<ProcessView>): ProcessView {
  return { id: overrides.id ?? 'p', status: 'exited', started_at: timestamp, ended_at: null, exit_code: null, timed_out: false, owner_kind: 'agent', owner_id: 'agent-1', session_id: null, card_id: 'card-a', command: 'echo ok', cwd: null, logs: { stdout: null, stderr: null }, ...overrides };
}

describe('debug-read-model', () => {
  it('projects each strict durable error event directly', () => {
    const projected = [diagnostic, actionable, mcpFailure].map(projectErrorRecord);
    expect(projected[0]).toMatchObject({ id: diagnostic.id, source: 'card-a', type: 'execute', severity: 'error' });
    expect(projected[0]!.message).toContain('[REDACTED]');
    expect(projected[1]).toMatchObject({ source: 'card-a', message: 'act now', type: 'runtime_actionable_error' });
    expect(projected[2]).toMatchObject({ source: 'mcp:tools', message: 'tool failed', type: 'mcp_tool_invocation' });
    expect(selectErrorsBySource(projected).get('card-a')).toHaveLength(2);
  });

  it('projects process ordering', () => {
    expect(selectSortedProcesses([process({ id: 'old', status: 'exited' }), process({ id: 'run', status: 'running' })]).map((entry) => entry.id)).toEqual(['run', 'old']);
  });

  it('capitalizes loaded-aware runtime status', () => {
    expect(selectRuntimeStatusLabel(false, null)).toBe('Unknown');
    expect(selectRuntimeStatusLabel(true, null)).toBe('Stopped');
  });
});
