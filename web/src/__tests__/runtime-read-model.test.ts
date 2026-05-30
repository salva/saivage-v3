import { describe, expect, it } from 'vitest';
import type { CardIndex, RuntimeRunRecord, RuntimeState } from '../api/types';
import { mergeRuntimeSummaryPatch, reduceRuntimeWsEvent, selectLiveUpdateState, selectRuntimeStatusLabel, selectRuntimeSummary } from '../stores/runtime-read-model';

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
    result: null,
    ...overrides,
  };
}

const cardIndex: CardIndex = { total: 0, byStatus: {}, byType: {} };

describe('runtime-read-model', () => {
  it('selects current root run, active child runs, and latest actionable error from a runtime snapshot', () => {
    const child = run({ run_id: 'child', kind: 'child', card_id: 'child-card' });
    const root = run({ run_id: 'root', kind: 'root', card_id: 'goal' });
    const summary = selectRuntimeSummary(runtime({ runtime_runs: [child, root] }));

    expect(summary.currentRun?.run_id).toBe('root');
    expect(summary.activeChildRuns.map((entry) => entry.run_id)).toEqual(['child']);
  });

  it('reduces runtime websocket command and child run events without mutating caller state', () => {
    const state = {
      runtime: runtime(),
      cardIndex,
      serverAvailability: null,
      ...selectRuntimeSummary(runtime()),
      statusBeforePause: null,
    };

    const reducedRun = reduceRuntimeWsEvent(state, { event: 'runtime.run', run: run({ run_id: 'child-1', kind: 'child', card_id: 'child-1' }) }, null);
    expect(reducedRun.state.activeChildRuns.map((entry) => entry.run_id)).toEqual(['child-1']);

    const reducedCommand = reduceRuntimeWsEvent(reducedRun.state, {}, { event: 'runtime.command', command: { command_id: 'cmd-1', command: 'pause-runtime', status: 'failed', requested_at: '2025-01-01T00:00:00Z', source: 'operator', error: { code: 'bad', message: 'Bad', nextAction: 'Fix' } } });
    expect(reducedCommand.state.lastCommand?.command).toBe('pause-runtime');
    expect(reducedCommand.state.lastActionableError?.message).toBe('Bad');
  });

  it('single-sources status and live update labels', () => {
    expect(selectRuntimeStatusLabel(runtime({ paused: true }))).toBe('paused');
    expect(selectLiveUpdateState({ connectionState: 'no-token', unauthorized: false, stale: false, wsStale: false })).toBe('no-token');
  });
});

describe('mergeRuntimeSummaryPatch', () => {
  it('returns an empty patch and does not throw when summary is a string (E01 regression)', () => {
    expect(() => mergeRuntimeSummaryPatch({ summary: 'completed' })).not.toThrow();
    expect(mergeRuntimeSummaryPatch({ summary: 'completed' })).toEqual({});
  });

  it('returns an empty patch when runtimeSummary is a non-object scalar', () => {
    expect(mergeRuntimeSummaryPatch({ runtimeSummary: 42 })).toEqual({});
  });

  it('extracts nested summary fields when the envelope is an object', () => {
    expect(mergeRuntimeSummaryPatch({ summary: { intent: 'running', currentRun: null } })).toEqual({ intent: 'running', currentRun: null });
  });

  it('extracts top-level intent without requiring a nested summary envelope', () => {
    expect(mergeRuntimeSummaryPatch({ intent: 'idle' })).toEqual({ intent: 'idle' });
  });

  it('returns an empty patch and does not throw when content itself is not an object', () => {
    expect(() => mergeRuntimeSummaryPatch(null)).not.toThrow();
    expect(mergeRuntimeSummaryPatch(null)).toEqual({});
    expect(() => mergeRuntimeSummaryPatch('boom')).not.toThrow();
    expect(mergeRuntimeSummaryPatch('boom')).toEqual({});
  });
});
