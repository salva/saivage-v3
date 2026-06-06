import { describe, expect, it } from 'vitest';
import type { RuntimeRunRecord, RuntimeState } from '../api/types';
import { selectLiveUpdateState, selectRuntimeStatusLabel, selectRuntimeSummary } from '../stores/runtime-read-model';

function runtime(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    status: 'running',
    project_id: 'project',
    pid: 123,
    started_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    current_card_id: 'goal',
    current_agent_session_id: 'session',
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
    expect(selectLiveUpdateState({ connectionState: 'no-token', unauthorized: false, stale: false, wsStale: false })).toBe('offline');
  });
});
