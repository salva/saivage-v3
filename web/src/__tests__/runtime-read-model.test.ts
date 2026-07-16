import { describe, expect, it } from 'vitest';
import type { RuntimeState } from '../api/types';
import { selectCurrentAgentSessionId, selectCurrentCardId, selectLiveUpdateState, selectRuntimeStatusLabel, selectRuntimeSummary } from '../stores/runtime-read-model';

function runtime(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    status: 'running',
    project_id: 'project',
    pid: 123,
    started_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    active_card_run: { card_id: '11111111-1111-4111-8111-111111111111', card_type: 'goal', ownership: { kind: 'direct', source: 'operator' }, runtime_status: 'running', phase: 'planner', caller_session_id: null, caller_tool_call_id: null, planner_session_id: 'planner:11111111-1111-4111-8111-111111111111', started_at: '2025-01-01T00:00:00Z', last_turn_at: '2025-01-01T00:00:00Z' },
    ...overrides,
  };
}

describe('runtime-read-model', () => {
  it('does not project deleted runtime ledgers', () => {
    expect(selectRuntimeSummary(runtime())).toEqual({ lastActionableError: null });
  });

  it('single-sources status and live update labels from current runtime state', () => {
    expect(selectRuntimeStatusLabel(runtime({ status: 'paused' }))).toBe('paused');
    expect(selectCurrentCardId(runtime())).toBe('11111111-1111-4111-8111-111111111111');
    expect(selectCurrentAgentSessionId(runtime())).toBe('planner:11111111-1111-4111-8111-111111111111');
    expect(selectLiveUpdateState({ connectionState: 'no-token', unauthorized: false, stale: false, wsStale: false })).toBe('offline');
  });
});
