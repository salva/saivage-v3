import { describe, expect, it } from '@jest/globals';

import { reduceActivationCompletion } from '../../src/runtime/activation-completion-reducer.js';
import { planOpenPlannerRunTerminalUpdate, planPlannerRunSessionBinding } from '../../src/runtime/planner-run-reducers.js';
import { buildCompletedRuntimeCommandState, buildRejectedRuntimeCommandState } from '../../src/runtime/runtime-command-state.js';
import type { DoneResult } from '../../src/schemas/index.js';
import type { RuntimeState } from '../../src/schemas/types.js';

const plannerDone: DoneResult = { kind: 'done', summary: 'done' };

function state(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    status: 'stopped',
    project_id: 'project',
    pid: 1234,
    started_at: '2026-05-26T00:00:00.000Z',
    active_card_run: null,
    runtime_commands: [],
    runtime_runs: [],
    runtime_activations: [],
    updated_at: '2026-05-26T00:00:00.000Z',
    ...overrides,
  } as RuntimeState;
}

function activation(overrides: Partial<RuntimeState['runtime_activations'][number]> = {}): RuntimeState['runtime_activations'][number] {
  return {
    activation_id: 'act-1',
    idempotency_key: 'parent-run:call:child',
    parent_card_id: 'parent',
    parent_run_id: 'parent-run',
    parent_session_id: 'planner:parent',
    parent_tool_call_id: 'call-1',
    child_card_id: 'child',
    status: 'running',
    precondition: 'accepted',
    requested_at: 't0',
    updated_at: 't0',
    runtime_run_id: 'run-1',
    error: null,
    ...overrides,
  };
}

function run(overrides: Partial<RuntimeState['runtime_runs'][number]> = {}): RuntimeState['runtime_runs'][number] {
  return {
    run_id: 'run-1',
    kind: 'child',
    ownership: { kind: 'activation', activation_id: 'act-test', parent_run_id: 'run-parent', parent_card_id: 'project', parent_session_id: 'planner:project', parent_tool_call_id: 'call-test' },
    card_id: 'child',
    parent_run_id: 'parent-run',
    command_id: null,
    activation_id: 'act-1',
    phase: 'executor',
    runtime_status: 'running',
    session_id: 'exec-1',
    started_at: 't0',
    updated_at: 't0',
    ...overrides,
  };
}

describe('runtime reducer helpers', () => {
  it('builds rejected and completed runtime command state', () => {
    const command = { command_id: 'cmd-a', command: 'start_project', status: 'accepted', requested_at: 'before', completed_at: null, error: null } as RuntimeState['runtime_commands'][number];
    const error = { code: 'bad', message: 'Bad', nextAction: 'Fix', docsRef: 'docs/runbook/index.md' };

    const rejected = buildRejectedRuntimeCommandState({ state: state({ runtime_commands: [command] }), command, error, at: 'now' });
    expect(rejected.rejectedCommand).toEqual(expect.objectContaining({ command_id: 'cmd-a', status: 'rejected', completed_at: 'now', error }));
    expect(rejected.state.runtime_commands).toEqual([rejected.rejectedCommand]);

    const completed = buildCompletedRuntimeCommandState({ state: state({ runtime_commands: [command], status: 'running' }), command, at: 'done', statePatch: { status: 'stopped' } });
    expect(completed.completedCommand).toEqual(expect.objectContaining({ command_id: 'cmd-a', status: 'completed', completed_at: 'done' }));
    expect(completed.state.status).toBe('stopped');
  });

  it('plans planner run session binding without stealing an already-bound same-card child run', () => {
    const current = state({
      runtime_runs: [
        run({ run_id: 'pending', card_id: 'goal-a', phase: 'pending', session_id: null, activation_id: 'act-a' }),
        run({ run_id: 'other-bound', card_id: 'goal-a', phase: 'planner', session_id: 'planner:other-goal-a', activation_id: 'act-other' }),
      ],
    });
    expect(planPlannerRunSessionBinding({ state: current, goalId: 'goal-a', plannerSessionId: 'planner:goal-a' })).toEqual({
      runId: 'pending',
      updates: { phase: 'planner', session_id: 'planner:goal-a' },
    });
  });

  it('plans planner terminal updates only for root or non-activation-owned child runs', () => {
    const current = state({
      runtime_runs: [
        run({ run_id: 'activation-owned', card_id: 'goal-a', phase: 'planner', session_id: 'planner:goal-a', activation_id: 'act-a' }),
        run({ run_id: 'other-bound', card_id: 'goal-a', phase: 'planner', session_id: 'planner:other-goal-a', activation_id: 'act-other' }),
      ],
    });
    expect(planOpenPlannerRunTerminalUpdate({ state: current, goalId: 'goal-a', result: 'blocked', nowIso: 't1' })).toBeNull();

    expect(planOpenPlannerRunTerminalUpdate({
      state: state({ runtime_runs: [run({ run_id: 'root-run', kind: 'root', ownership: { kind: 'direct', source: 'project_root' }, card_id: 'project', parent_run_id: null, activation_id: null, phase: 'planner', session_id: 'planner:project' })] }),
      goalId: 'project',
      result: 'failed',
      nowIso: 't1',
    })).toEqual({
      runId: 'root-run',
      updates: { phase: 'failed', runtime_status: 'error', finished_at: 't1', updated_at: 't1', outcome: { kind: 'completed', result: 'failed', error: 'Planner run failed.', finished_at: 't1' } },
    });
  });

  it('reduces child activation completion and matching runtime run updates', () => {
    const next = reduceActivationCompletion(state({ runtime_activations: [activation()], runtime_runs: [run()] }), 'child', 'done', '2026-05-26T01:00:00.000Z', { status: 'done', result: plannerDone, error: null, completed_at: '2026-05-26T01:00:00.000Z' });
    expect(next?.runtime_activations[0]).toEqual(expect.objectContaining({ status: 'completed', updated_at: '2026-05-26T01:00:00.000Z', outcome: { kind: 'completed', outcome: 'done', card_id: 'child', completed_at: '2026-05-26T01:00:00.000Z' } }));
    expect(next?.runtime_runs[0]).toEqual(expect.objectContaining({ phase: 'completed', runtime_status: 'stopped', finished_at: '2026-05-26T01:00:00.000Z', updated_at: '2026-05-26T01:00:00.000Z', outcome: { kind: 'completed', result: 'done', finished_at: '2026-05-26T01:00:00.000Z' } }));
  });

  it('restores parent planner as active run when child activation completes under a waiting parent planner', () => {
    const parentRun = { run_id: 'parent-run', kind: 'root' as const, card_id: 'parent', ownership: { kind: 'direct', source: 'project_root' } as const, parent_run_id: null, command_id: null, activation_id: null, phase: 'planner' as const, runtime_status: 'running' as const, session_id: 'planner:parent', started_at: 't0', updated_at: 't0' };
    const next = reduceActivationCompletion(state({
      status: 'running',
      active_card_run: { card_id: 'child', card_type: 'code', ownership: { kind: 'direct', source: 'project_root' }, runtime_status: 'running', phase: 'executor', caller_session_id: 'planner:parent', caller_tool_call_id: 'call-1', executor_session_id: 'exec-1', correction_attempts: 0, started_at: 't0', last_turn_at: 't0' },
      runtime_activations: [activation({ parent_card_id: 'parent', parent_session_id: 'planner:parent', parent_run_id: 'parent-run' })],
      runtime_runs: [parentRun, run()],
    }), 'child', 'done', '2026-05-26T01:00:00.000Z', { status: 'done', result: plannerDone, error: null, completed_at: '2026-05-26T01:00:00.000Z' });

    expect(next).toEqual(expect.objectContaining({ status: 'running' }));
    expect(next?.active_card_run).toEqual(expect.objectContaining({ card_id: 'parent', phase: 'planner', planner_session_id: 'planner:parent' }));
  });

  it('fails closed when active child completion cannot resume a parent planner run', () => {
    expect(() => reduceActivationCompletion(state({
      status: 'running',
      active_card_run: { card_id: 'child', card_type: 'code', ownership: { kind: 'direct', source: 'project_root' }, runtime_status: 'running', phase: 'executor', caller_session_id: 'planner:parent', caller_tool_call_id: 'call-1', executor_session_id: 'exec-1', correction_attempts: 0, started_at: 't0', last_turn_at: 't0' },
      runtime_activations: [activation({ parent_card_id: 'parent', parent_session_id: 'planner:parent', parent_run_id: 'parent-run' })],
      runtime_runs: [run()],
    }), 'child', 'done', '2026-05-26T01:00:00.000Z', { status: 'done', result: plannerDone, error: null, completed_at: '2026-05-26T01:00:00.000Z' })).toThrow(/parent planner run/);
  });

});
