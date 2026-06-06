import { describe, expect, it } from 'vitest';
import type { RuntimeRunRecord, RuntimeState } from '../api/types';
import { selectCurrentAgentSessionId, selectCurrentCardId, selectLiveUpdateState, selectRuntimeStatusLabel, selectRuntimeSummary } from '../stores/runtime-read-model';

function runtime(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    status: 'running',
    project_id: 'project',
    pid: 123,
    started_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    active_card_run: { card_id: 'goal', card_type: 'goal', runtime_status: 'running', phase: 'planner', caller_session_id: null, caller_tool_call_id: null, planner_session_id: 'planner:goal', correction_attempts: 0, started_at: '2025-01-01T00:00:00Z', last_turn_at: '2025-01-01T00:00:00Z' },
    paused: false,
    paused_at: null,
    frozen_reason: null,
    runtime_runs: [],
    runtime_activations: [],
    runtime_commands: [],
    ...overrides,
  };
}

function run(overrides: Partial<RuntimeRunRecord>): RuntimeRunRecord {
  return {
    run_id: overrides.run_id ?? 'run',
    kind: 'root',
    card_id: 'goal',
    session_id: null,
    phase: 'planner',
    runtime_status: 'running',
    parent_run_id: null,
    command_id: null,
    activation_id: null,
    started_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    finished_at: null,
    ...overrides,
  };
}

describe('runtime-read-model', () => {
  it('selects current root run, active child runs, and latest actionable error from a runtime snapshot', () => {
    const child = run({ run_id: 'child', kind: 'child', card_id: 'child-card' });
    const root = run({ run_id: 'root', kind: 'root', card_id: 'goal' });
    const summary = selectRuntimeSummary(runtime({ runtime_runs: [child, root] }));

    expect(summary.currentRun?.run_id).toBe('root');
    expect(summary.activeChildRuns.map((entry) => entry.run_id)).toEqual(['child']);
  });

  it('single-sources status and live update labels', () => {
    expect(selectRuntimeStatusLabel(runtime({ paused: true }))).toBe('paused');
    expect(selectCurrentCardId(runtime())).toBe('goal');
    expect(selectCurrentAgentSessionId(runtime())).toBe('planner:goal');
    expect(selectLiveUpdateState({ connectionState: 'no-token', unauthorized: false, stale: false, wsStale: false })).toBe('offline');
  });
});
