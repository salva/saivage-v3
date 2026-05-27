import { describe, expect, it } from '@jest/globals';
import { observeRuntimeStateInvariants, planProjectRootRedispatch, reduceRuntimeEvent } from '../../src/runtime/runtime-core.js';
import type { RuntimeState } from '../../src/schemas/types.js';

function state(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    status: 'idle',
    paused: false,
    paused_at: null,
    current_card_id: null,
    current_agent_session_id: null,
    active_card_run: null,
    runtime_intent: { status: 'stopped', updated_at: '2026-05-26T00:00:00.000Z' },
    runtime_commands: [],
    runtime_runs: [],
    runtime_activations: [],
    updated_at: '2026-05-26T00:00:00.000Z',
    ...overrides,
  } as RuntimeState;
}

describe('runtime core reducers', () => {
  it('reduces lifecycle events to patches without persisting them', () => {
    expect(reduceRuntimeEvent(state(), 'paused', {}, '2026-05-26T01:00:00.000Z')).toEqual({ status: 'paused', paused: true, paused_at: '2026-05-26T01:00:00.000Z' });
    expect(reduceRuntimeEvent(state({ active_card_run: { card_id: 'c1', card_type: 'goal', runtime_status: 'running', phase: 'planner', caller_session_id: null, caller_tool_call_id: null, planner_session_id: 'planner:c1', correction_attempts: 0, started_at: 't', last_turn_at: 't' } }), 'resumed', {}, 'now')).toEqual({ status: 'running', paused: false, paused_at: null });
    expect(reduceRuntimeEvent(state(), 'goal_exit', {}, 'now')).toEqual({ status: 'idle', current_card_id: null, current_agent_session_id: null, active_card_run: null });
  });

  it('plans invariant observations and corrections as data', () => {
    expect(observeRuntimeStateInvariants({ state: state({ status: 'running', active_card_run: null }), currentCardStatus: null })).toEqual([
      expect.objectContaining({ invariant: 'I1', key: 'global', correction: expect.objectContaining({ status: 'idle' }) }),
    ]);
    expect(observeRuntimeStateInvariants({ state: state({ current_card_id: 'c1' }), currentCardStatus: 'done' })).toEqual(expect.arrayContaining([
      expect.objectContaining({ invariant: 'I2', key: 'c1', correction: expect.objectContaining({ active_card_run: null }) }),
      expect.objectContaining({ invariant: 'I3', key: 'c1|null' }),
    ]));
  });

  it('plans canonical project-root redispatch only for an idle running intent with an open root run', () => {
    const runningRoot = state({
      runtime_intent: { status: 'running', source_command_id: 'cmd-1', updated_at: '2026-05-26T00:00:00.000Z' },
      runtime_runs: [{ run_id: 'run-1', kind: 'root', card_id: 'project', parent_run_id: null, command_id: 'cmd-1', activation_id: null, phase: 'planner', runtime_status: 'running', session_id: null, result: null, started_at: 't', updated_at: 't' }],
    });
    expect(planProjectRootRedispatch({ state: runningRoot, projectCardId: 'project' })).toEqual({ shouldRedispatch: true, cardId: 'project', reason: 'open_root_run' });
    expect(planProjectRootRedispatch({ state: state({ paused: true }), projectCardId: 'project' })).toEqual({ shouldRedispatch: false });
  });
});
