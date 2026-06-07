import { describe, expect, it } from '@jest/globals';
import { buildCompletedRuntimeCommandState, buildDispatchPausedRuntimeStatePatch, buildFreezeManifest, buildFreezeRuntimeStatePatch, buildPauseRuntimeStatePatch, buildRejectedRuntimeCommandState, buildResumeFromFreezeRuntimeStatePatch, buildResumeHandoffContext, buildResumeRuntimeStatePatch, buildShutdownRuntimeStatePatch, makeRuntimePreconditionError, observeRuntimeStateInvariants, planClearActiveCardRunForRepair, planIdleRunningRootRunReconciliation, planOpenPlannerRunTerminalUpdate, planOpenRootRunStopUpdates, planPlannerRunSessionBinding, planProjectRootRedispatch, planRootRunDispatchFailureUpdate, planRootRunDispatchSuccessUpdate, planStartProjectPrecondition, planSweptCurrentAgentSessionPatch, reduceActivationCompletion, reduceRuntimeEvent } from '../../src/runtime/runtime-core.js';
import { RuntimeStateInvariantError } from '../../src/runtime/state.js';
import type { PlannerDoneResult } from '../../src/schemas/index.js';
import type { RuntimeState } from '../../src/schemas/types.js';

const plannerDone: PlannerDoneResult = { kind: 'planner_done', summary: 'done' };

function state(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    status: 'idle',
    paused: false,
    paused_at: null,
    active_card_run: null,
    runtime_intent: { status: 'stopped', updated_at: '2026-05-26T00:00:00.000Z' },
    runtime_commands: [],
    runtime_runs: [],
    runtime_activations: [],
    updated_at: '2026-05-26T00:00:00.000Z',
    ...overrides,
  } as RuntimeState;
}

function activation(overrides: Partial<NonNullable<RuntimeState['runtime_activations']>[number]> = {}): NonNullable<RuntimeState['runtime_activations']>[number] {
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

function run(overrides: Partial<NonNullable<RuntimeState['runtime_runs']>[number]> = {}): NonNullable<RuntimeState['runtime_runs']>[number] {
  return {
    run_id: 'run-1',
    kind: 'child',
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

describe('runtime core reducers', () => {
  it('builds actionable runtime precondition errors', () => {
    expect(makeRuntimePreconditionError({ code: 'runtime_not_started', message: 'Runtime is stopped.', nextAction: 'Start runtime.', currentState: { status: 'idle' } })).toEqual({
      code: 'runtime_not_started',
      message: 'Runtime is stopped.',
      nextAction: 'Start runtime.',
      currentState: { status: 'idle' },
      docsRef: 'docs/runbook/index.md',
    });
  });

  it('builds rejected runtime command state', () => {
    const error = makeRuntimePreconditionError({ code: 'bad', message: 'Bad', nextAction: 'Fix' });
    const command = { command_id: 'cmd-a', command: 'start_project', status: 'accepted', requested_at: 'before', completed_at: null, error: null } as any;
    const result = buildRejectedRuntimeCommandState({ state: state({ runtime_commands: [command] }), command, error, at: 'now' });
    expect(result.rejectedCommand).toEqual(expect.objectContaining({ command_id: 'cmd-a', status: 'rejected', completed_at: 'now', error }));
    expect(result.state.runtime_commands).toEqual([result.rejectedCommand]);
    expect(result.state.updated_at).toBe('now');
  });

  it('builds completed runtime command state with optional runtime patches', () => {
    const command = { command_id: 'cmd-a', command: 'stop_project', status: 'accepted', requested_at: 'before', completed_at: null, error: null } as any;
    const result = buildCompletedRuntimeCommandState({ state: state({ runtime_commands: [command], status: 'running' }), command, at: 'now', statePatch: { status: 'idle' } });
    expect(result.completedCommand).toEqual(expect.objectContaining({ command_id: 'cmd-a', status: 'completed', completed_at: 'now' }));
    expect(result.state.runtime_commands).toEqual([result.completedCommand]);
    expect(result.state.status).toBe('idle');
    expect(result.state.updated_at).toBe('now');
  });

  it('plans root-run terminal updates after background dispatch', () => {
    const runningState = state({
      runtime_intent: { status: 'running', source_command_id: 'cmd-1', updated_at: 't0' },
      runtime_runs: [run({ run_id: 'root', kind: 'root', card_id: 'project', parent_run_id: null, activation_id: null })],
    });
    expect(planRootRunDispatchSuccessUpdate({ state: runningState, runId: 'root', nowIso: 't1' })).toEqual({
      runId: 'root',
      updates: { phase: 'completed', runtime_status: 'idle', finished_at: 't1', outcome: { kind: 'completed', result: 'done', finished_at: 't1' } },
    });
    expect(planRootRunDispatchSuccessUpdate({ state: state({ runtime_intent: { status: 'stopped', source_command_id: 'cmd-1', updated_at: 't0' } }), runId: 'root', nowIso: 't1' })).toBeNull();
    expect(planRootRunDispatchFailureUpdate({ state: runningState, runId: 'root', nowIso: 't2' })).toEqual({
      runId: 'root',
      updates: { phase: 'failed', runtime_status: 'error', finished_at: 't2', outcome: { kind: 'completed', result: 'failed', error: 'Root run dispatch failed.', finished_at: 't2' } },
    });
    expect(planRootRunDispatchFailureUpdate({ state: state({ runtime_runs: [run({ run_id: 'root', runtime_status: 'error' })] }), runId: 'root', nowIso: 't2' })).toBeNull();
  });

  it('plans stop_project updates for open root runs only', () => {
    expect(planOpenRootRunStopUpdates({
      state: state({
        runtime_runs: [
          run({ run_id: 'root-open', kind: 'root', card_id: 'project', parent_run_id: null, activation_id: null }),
          run({ run_id: 'root-closed', kind: 'root', card_id: 'project', parent_run_id: null, activation_id: null, finished_at: 'done' }),
          run({ run_id: 'child-open' }),
        ],
      }),
      nowIso: 't1',
    })).toEqual([
      { runId: 'root-open', updates: { phase: 'stopped', runtime_status: 'stopped', finished_at: 't1', outcome: { kind: 'completed', result: 'stopped', finished_at: 't1' } } },
    ]);
  });

  it('builds pause, resume, and freeze-manifest state helper shapes', () => {
    const activeState = state({
      started_at: 'started',
      active_card_run: { card_id: 'goal-a', card_type: 'goal', runtime_status: 'running', phase: 'planner', caller_session_id: null, caller_tool_call_id: null, planner_session_id: 'planner:goal-a', correction_attempts: 0, started_at: 'started', last_turn_at: 'turn' },
    });
    expect(buildPauseRuntimeStatePatch('paused')).toEqual({ status: 'paused', paused: true, paused_at: 'paused' });
    expect(buildResumeRuntimeStatePatch(activeState)).toEqual({ status: 'running', paused: false, paused_at: null });
    expect(buildFreezeRuntimeStatePatch({ state: activeState, frozenAt: 'frozen' })).toEqual(expect.objectContaining({ status: 'frozen', started_at: 'started', paused: true, paused_at: 'frozen' }));
    const manifest = buildFreezeManifest({
      state: activeState,
      freezeId: 'freeze-1',
      frozenAt: 'frozen',
      pid: 123,
      handoffSummaries: [{ session_id: 'planner:goal-a', role: 'planner', last_action: 'planned', next_action: 'resume', context_summary: 'context' }],
      runtimeVersion: '0.1.0',
    });
    expect(manifest).toEqual(expect.objectContaining({ freeze_id: 'freeze-1', reason: 'operator requested freeze', active_card_run: expect.objectContaining({ card_id: 'goal-a' }), schema_version: 1 }));
    expect(buildResumeFromFreezeRuntimeStatePatch(manifest)).toEqual(expect.objectContaining({ status: 'running', started_at: 'started', active_card_run: expect.objectContaining({ card_id: 'goal-a' }), paused: false, paused_at: null }));
    expect(buildResumeHandoffContext(manifest)).toContain('[Handoff] Session: planner:goal-a');
  });

  it('plans startup and shutdown cleanup patches', () => {
    const activeState = state({
      status: 'running',
      active_card_run: { card_id: 'goal-a', card_type: 'goal', runtime_status: 'running', phase: 'planner', caller_session_id: null, caller_tool_call_id: null, planner_session_id: 'planner:goal-a', correction_attempts: 0, started_at: 'started', last_turn_at: 'turn' },
    });
    expect(planClearActiveCardRunForRepair({ state: activeState, cardId: 'goal-a' })).toEqual({ status: 'idle', active_card_run: null });
    expect(planClearActiveCardRunForRepair({ state: activeState, cardId: 'other' })).toBeNull();
    expect(planSweptCurrentAgentSessionPatch({ state: activeState, sweptSessionIds: ['planner:goal-a'] })).toEqual({ status: 'idle', active_card_run: null });
    expect(planSweptCurrentAgentSessionPatch({ state: activeState, sweptSessionIds: ['other'] })).toBeNull();
    expect(buildShutdownRuntimeStatePatch()).toEqual({ status: 'idle', active_card_run: null, paused: false, paused_at: null });
    expect(buildDispatchPausedRuntimeStatePatch()).toEqual({ status: 'paused' });
  });

  it('plans start_project precondition errors and retryable planning blockers', () => {
    expect(planStartProjectPrecondition({
      state: state(),
      projectCardId: 'project',
      projectCardExists: false,
      projectCardStatus: null,
      hasBlockedPlanning: false,
      blockedPlanning: null,
      paused: false,
      source: 'operator',
    }).error).toBeNull();

    expect(planStartProjectPrecondition({
      state: state({ runtime_intent: { status: 'running', source_command_id: 'cmd-1', updated_at: 't0' }, runtime_runs: [run({ run_id: 'root', kind: 'root', card_id: 'project', parent_run_id: null, activation_id: null })] }),
      projectCardId: 'project',
      projectCardExists: true,
      projectCardStatus: 'active',
      hasBlockedPlanning: false,
      blockedPlanning: null,
      paused: false,
      source: 'operator',
    }).error).toEqual(expect.objectContaining({ code: 'runtime_start_precondition_failed', currentState: expect.objectContaining({ activeRunId: 'root' }) }));

    const retry = planStartProjectPrecondition({
      state: state({ runtime_intent: { status: 'running', source_command_id: 'cmd-1', updated_at: 't0' } }),
      projectCardId: 'project',
      projectCardExists: true,
      projectCardStatus: 'blocked',
      hasBlockedPlanning: true,
      blockedPlanning: { status: 'blocked', resume_reason: 'planner_context_length_exceeded', failure_kind: 'token_budget_exceeded' },
      paused: false,
      source: 'operator',
    });
    expect(retry.error).toBeNull();
    expect(retry.retryingPlanningBlocker).toBe(true);
    expect(retry.retryingTokenBudgetPlanningBlocker).toBe(true);
  });

  it('reduces lifecycle events to patches without persisting them', () => {
    expect(reduceRuntimeEvent(state(), 'paused', {}, '2026-05-26T01:00:00.000Z')).toEqual({ status: 'paused', paused: true, paused_at: '2026-05-26T01:00:00.000Z' });
    expect(reduceRuntimeEvent(state({ active_card_run: { card_id: 'c1', card_type: 'goal', runtime_status: 'running', phase: 'planner', caller_session_id: null, caller_tool_call_id: null, planner_session_id: 'planner:c1', correction_attempts: 0, started_at: 't', last_turn_at: 't' } }), 'resumed', {}, 'now')).toEqual({ status: 'running', paused: false, paused_at: null });
    expect(reduceRuntimeEvent(state(), 'goal_exit', {}, 'now')).toEqual({ status: 'idle', active_card_run: null });
    expect(reduceRuntimeEvent(state(), 'reviewer_started', {
      goalId: 'goal-a',
      reviewerSessionId: 'reviewer:goal-a',
      activeCardRun: { card_id: 'goal-a', card_type: 'goal', runtime_status: 'running', phase: 'reviewer', caller_session_id: null, caller_tool_call_id: null, reviewer_session_id: 'reviewer:goal-a', correction_attempts: 0, started_at: '2026-05-26T01:00:00.000Z', last_turn_at: '2026-05-26T01:00:00.000Z' },
    }, 'now')).toEqual(expect.objectContaining({ status: 'running', active_card_run: expect.objectContaining({ card_id: 'goal-a', reviewer_session_id: 'reviewer:goal-a' }) }));
  });

  it('requires reviewer_started to include a valid activeCardRun', () => {
    expect(() => reduceRuntimeEvent(state(), 'reviewer_started', {}, 'now')).toThrow(RuntimeStateInvariantError);
    expect(() => reduceRuntimeEvent(state(), 'reviewer_started', { activeCardRun: { card_id: 'goal-a' } }, 'now')).toThrow(RuntimeStateInvariantError);
  });

  it('observes invariant violations without repair corrections', () => {
    expect(observeRuntimeStateInvariants({ state: state({ status: 'running', active_card_run: null }), currentCardStatus: null })).toEqual([
      { invariant: 'I1', key: 'global', details: { status: 'running' } },
    ]);
    const idleActiveObservations = observeRuntimeStateInvariants({
      state: state({ status: 'idle', active_card_run: { card_id: 'code-a', card_type: 'code', runtime_status: 'running', phase: 'executor', caller_session_id: 'planner:goal-a', caller_tool_call_id: null, executor_session_id: 'executor-code-a', correction_attempts: 0, started_at: 't', last_turn_at: 't' } }),
      currentCardStatus: 'running',
    });
    expect(idleActiveObservations).toEqual(expect.arrayContaining([
      expect.objectContaining({ invariant: 'I1', key: 'global' }),
    ]));
    expect(idleActiveObservations[0]).not.toHaveProperty('correction');
    const terminalObservations = observeRuntimeStateInvariants({ state: state({ active_card_run: { card_id: 'c1', card_type: 'goal', runtime_status: 'running', phase: 'planner', caller_session_id: null, caller_tool_call_id: null, planner_session_id: 'planner:c1', correction_attempts: 0, started_at: 't', last_turn_at: 't' } }), currentCardStatus: 'done' });
    expect(terminalObservations).toEqual(expect.arrayContaining([
      expect.objectContaining({ invariant: 'I2', key: 'c1' }),
    ]));
    expect(terminalObservations[0]).not.toHaveProperty('correction');
    expect(observeRuntimeStateInvariants({
      state: state({
        runtime_activations: [activation({ status: 'needs_verification', outcome: { kind: 'completed', outcome: 'done', card_id: 'child', completed_at: '2026-05-26T01:00:00.000Z' } })],
        runtime_runs: [run({ phase: 'needs_verification', outcome: { kind: 'completed', result: 'done', finished_at: '2026-05-26T01:00:00.000Z' } })],
      }),
      currentCardStatus: null,
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ invariant: 'I7', key: 'act-1' }),
      expect.objectContaining({ invariant: 'I8', key: 'run-1' }),
    ]));
    expect(observeRuntimeStateInvariants({
      state: state({ runtime_activations: [activation()], runtime_runs: [run()] }),
      currentCardStatus: null,
      readCard: () => ({ status: 'done', lifecycle: { status: 'running', result: null, error: null, completed_at: null } }),
    })).toEqual(expect.arrayContaining([expect.objectContaining({ invariant: 'I5', key: 'child' })]));
  });

  it('plans canonical project-root redispatch for a running intent with an open or failed root run', () => {
    const runningRoot = state({
      runtime_intent: { status: 'running', source_command_id: 'cmd-1', updated_at: '2026-05-26T00:00:00.000Z' },
      runtime_runs: [{ run_id: 'run-1', kind: 'root', card_id: 'project', parent_run_id: null, command_id: 'cmd-1', activation_id: null, phase: 'planner', runtime_status: 'running', session_id: null, started_at: 't', updated_at: 't' }],
    });
    expect(planProjectRootRedispatch({ state: runningRoot, projectCardId: 'project' })).toEqual({ shouldRedispatch: true, cardId: 'project', reason: 'open_root_run' });

    const failedRoot = state({
      runtime_intent: { status: 'running', source_command_id: 'cmd-1', updated_at: '2026-05-26T00:00:00.000Z' },
      runtime_runs: [{ run_id: 'run-1', kind: 'root', card_id: 'project', parent_run_id: null, command_id: 'cmd-1', activation_id: null, phase: 'failed', runtime_status: 'error', session_id: 'planner:project', outcome: { kind: 'completed', result: 'failed', error: 'failed', finished_at: '2026-05-26T01:00:00.000Z' }, started_at: 't', updated_at: '2026-05-26T01:00:00.000Z', finished_at: '2026-05-26T01:00:00.000Z' }],
    });
    expect(planProjectRootRedispatch({ state: failedRoot, projectCardId: 'project' })).toEqual({ shouldRedispatch: true, cardId: 'project', reason: 'failed_root_run_with_running_intent' });
    expect(planProjectRootRedispatch({ state: state({ paused: true }), projectCardId: 'project' })).toEqual({ shouldRedispatch: false });
  });

  it('plans idle/running root run reconciliation without stopping open-run scheduling intent', () => {
    const current = state({
      runtime_intent: { status: 'running', source_command_id: 'cmd-1', updated_at: 't0' },
      runtime_runs: [
        run({ run_id: 'root', kind: 'root', card_id: 'project', parent_run_id: null, activation_id: null, phase: 'planner', session_id: 'planner:project' }),
        run({ run_id: 'child', kind: 'child', card_id: 'goal-a', parent_run_id: 'root', activation_id: 'act-a', phase: 'planner', session_id: 'planner:goal-a' }),
      ],
    });
    expect(planIdleRunningRootRunReconciliation({ state: current, projectTerminal: true, nowIso: 't1' })).toEqual({
      runUpdates: [
        { runId: 'root', updates: { phase: 'completed', runtime_status: 'idle', finished_at: 't1', updated_at: 't1', outcome: { kind: 'completed', result: 'done', finished_at: 't1' } } },
        { runId: 'child', updates: { phase: 'failed', runtime_status: 'error', finished_at: 't1', updated_at: 't1', outcome: { kind: 'completed', result: 'failed', error: 'Runtime was idle with an open runtime run.', finished_at: 't1' } } },
      ],
      diagnosticMessage: 'Reconciled running runtime intent to expected idle because the project card is terminal and no active card run exists.',
    });
    expect(planIdleRunningRootRunReconciliation({ state: current, projectTerminal: false, nowIso: 't1' })?.runUpdates.map((update) => update.updates)).toEqual([
      expect.objectContaining({ phase: 'failed', runtime_status: 'error', outcome: { kind: 'completed', result: 'failed', error: 'Runtime was idle with an open runtime run.', finished_at: 't1' } }),
      expect.objectContaining({ phase: 'failed', runtime_status: 'error', outcome: { kind: 'completed', result: 'failed', error: 'Runtime was idle with an open runtime run.', finished_at: 't1' } }),
    ]);
    expect(planIdleRunningRootRunReconciliation({
      state: state({
        runtime_intent: { status: 'running', source_command_id: 'cmd-1', updated_at: 't0' },
        runtime_runs: [run({ run_id: 'child', kind: 'child', card_id: 'goal-a', parent_run_id: 'root', activation_id: 'act-a', phase: 'planner', session_id: 'planner:goal-a' })],
      }),
      projectTerminal: false,
      nowIso: 't1',
    })?.runUpdates).toEqual([
      { runId: 'child', updates: { phase: 'failed', runtime_status: 'error', finished_at: 't1', updated_at: 't1', outcome: { kind: 'completed', result: 'failed', error: 'Runtime was idle with an open runtime run.', finished_at: 't1' } } },
    ]);
    expect(planIdleRunningRootRunReconciliation({ state: state({ runtime_intent: { status: 'stopped', source_command_id: null, updated_at: 't0' } }), projectTerminal: true, nowIso: 't1' })).toBeNull();
  });

  it('stops terminal running intent even when all root runs are already closed', () => {
    expect(planIdleRunningRootRunReconciliation({
      state: state({
        runtime_intent: { status: 'running', source_command_id: 'cmd-1', updated_at: 't0' },
        runtime_runs: [run({ run_id: 'root', kind: 'root', card_id: 'project', parent_run_id: null, activation_id: null, phase: 'completed', runtime_status: 'idle', session_id: 'planner:project', finished_at: 't0', outcome: { kind: 'completed', result: 'done', finished_at: 't0' } })],
      }),
      projectTerminal: true,
      nowIso: 't1',
    })).toEqual({
      runUpdates: [],
      statePatch: expect.objectContaining({
        status: 'idle',
        runtime_intent: expect.objectContaining({ status: 'stopped', source_command_id: 'cmd-1', updated_at: 't1' }),
      }),
      diagnosticMessage: 'Reconciled running runtime intent to expected idle because the project card is terminal and no active card run exists.',
    });
  });

  it('plans planner session binding without stealing an already-bound same-card child run', () => {
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
      state: state({ runtime_runs: [run({ run_id: 'root-run', kind: 'root', card_id: 'project', parent_run_id: null, activation_id: null, phase: 'planner', session_id: 'planner:project' })] }),
      goalId: 'project',
      result: 'failed',
      nowIso: 't1',
    })).toEqual({
      runId: 'root-run',
      updates: { phase: 'failed', runtime_status: 'error', finished_at: 't1', updated_at: 't1', outcome: { kind: 'completed', result: 'failed', error: 'Planner run failed.', finished_at: 't1' } },
    });
  });

  it('reduces child activation completion and matching runtime run updates', () => {
    const current = state({
      runtime_activations: [
        activation(),
      ],
      runtime_runs: [
        run(),
      ],
    });
    const next = reduceActivationCompletion(current, 'child', 'done', '2026-05-26T01:00:00.000Z', { status: 'done', result: plannerDone, error: null, completed_at: '2026-05-26T01:00:00.000Z' });
    expect(next?.runtime_activations?.[0]).toEqual(expect.objectContaining({ status: 'completed', updated_at: '2026-05-26T01:00:00.000Z', outcome: { kind: 'completed', outcome: 'done', card_id: 'child', completed_at: '2026-05-26T01:00:00.000Z' } }));
    expect(next?.runtime_runs?.[0]).toEqual(expect.objectContaining({ phase: 'completed', runtime_status: 'idle', finished_at: '2026-05-26T01:00:00.000Z', updated_at: '2026-05-26T01:00:00.000Z', outcome: { kind: 'completed', result: 'done', finished_at: '2026-05-26T01:00:00.000Z' } }));
    expect(next).toEqual(expect.objectContaining({ status: 'idle' }));
    expect(next?.updated_at).toBe('2026-05-26T01:00:00.000Z');
  });

  it('restores parent planner as active run when child activation completes under a waiting parent planner', () => {
    const parentRun = { run_id: 'parent-run', kind: 'root' as const, card_id: 'parent', parent_run_id: null, command_id: null, activation_id: null, phase: 'planner' as const, runtime_status: 'running' as const, session_id: 'planner:parent', started_at: 't0', updated_at: 't0' };
    const current = state({
      status: 'running',
      active_card_run: { card_id: 'child', card_type: 'code', runtime_status: 'running', phase: 'executor', caller_session_id: 'planner:parent', caller_tool_call_id: 'call-1', executor_session_id: 'exec-1', correction_attempts: 0, started_at: 't0', last_turn_at: 't0' },
      runtime_activations: [
        activation({ parent_card_id: 'parent', parent_session_id: 'planner:parent', parent_run_id: 'parent-run' }),
      ],
      runtime_runs: [
        parentRun,
        run(),
      ],
    });
    const next = reduceActivationCompletion(current, 'child', 'done', '2026-05-26T01:00:00.000Z', { status: 'done', result: plannerDone, error: null, completed_at: '2026-05-26T01:00:00.000Z' });
    expect(next).toEqual(expect.objectContaining({ status: 'running' }));
    expect(next?.active_card_run).not.toBeNull();
    expect(next?.active_card_run?.card_id).toBe('parent');
    expect(next?.active_card_run?.phase).toBe('planner');
    expect(next?.active_card_run?.planner_session_id).toBe('planner:parent');
  });

  it('fails closed when active child activation completes but parent has no open planner run', () => {
    const current = state({
      status: 'running',
      active_card_run: { card_id: 'child', card_type: 'code', runtime_status: 'running', phase: 'executor', caller_session_id: 'planner:parent', caller_tool_call_id: 'call-1', executor_session_id: 'exec-1', correction_attempts: 0, started_at: 't0', last_turn_at: 't0' },
      runtime_activations: [
        activation({ parent_card_id: 'parent', parent_session_id: 'planner:parent', parent_run_id: 'parent-run' }),
      ],
      runtime_runs: [
        run(),
      ],
    });
    expect(() => reduceActivationCompletion(current, 'child', 'done', '2026-05-26T01:00:00.000Z', { status: 'done', result: plannerDone, error: null, completed_at: '2026-05-26T01:00:00.000Z' })).toThrow(/parent planner run/);
  });

  it('fails closed when active child completion has no unresolved activation', () => {
    const current = state({
      status: 'running',
      active_card_run: { card_id: 'child', card_type: 'code', runtime_status: 'running', phase: 'executor', caller_session_id: 'planner:parent', caller_tool_call_id: 'call-1', executor_session_id: 'exec-1', correction_attempts: 0, started_at: 't0', last_turn_at: 't0' },
      runtime_activations: [
        activation({ status: 'completed' }),
      ],
      runtime_runs: [
        run(),
      ],
    });
    expect(() => reduceActivationCompletion(current, 'child', 'done', '2026-05-26T01:00:00.000Z', { status: 'done', result: plannerDone, error: null, completed_at: '2026-05-26T01:00:00.000Z' })).toThrow(/exactly one unresolved activation/);
  });

  it('fails closed when active child completion has duplicate unresolved activations', () => {
    const current = state({
      status: 'running',
      active_card_run: { card_id: 'child', card_type: 'code', runtime_status: 'running', phase: 'executor', caller_session_id: 'planner:parent', caller_tool_call_id: 'call-1', executor_session_id: 'exec-1', correction_attempts: 0, started_at: 't0', last_turn_at: 't0' },
      runtime_activations: [
        activation({ activation_id: 'act-1' }),
        activation({ activation_id: 'act-2', idempotency_key: 'parent-run:call-2:child' }),
      ],
      runtime_runs: [
        run(),
      ],
    });
    expect(() => reduceActivationCompletion(current, 'child', 'done', '2026-05-26T01:00:00.000Z', { status: 'done', result: plannerDone, error: null, completed_at: '2026-05-26T01:00:00.000Z' })).toThrow(/exactly one unresolved activation/);
  });

  it('maps needs_verification activation completion to paused outcome snapshots', () => {
    const next = reduceActivationCompletion(state({
      runtime_activations: [activation({ status: 'pending' })],
      runtime_runs: [run()],
    }), 'child', 'needs_verification', '2026-05-26T01:00:00.000Z', { status: 'needs_verification', result: { kind: 'executor_needs_verification', reason: 'inspect evidence', preserved_result: {}, fallback_reason: null, latest_self_report: { result: 'needs_verification', outcome: 'needs_verification', summary: 'inspect evidence', status_text: 'verify', at: '2026-05-26T01:00:00.000Z' } }, error: null, completed_at: null });
    expect(next?.runtime_activations?.[0]).toEqual(expect.objectContaining({ status: 'needs_verification', outcome: { kind: 'paused', reason: 'needs_verification', card_id: 'child', detail: 'inspect evidence' } }));
    expect(next?.runtime_runs?.[0]).toEqual(expect.objectContaining({ phase: 'needs_verification', runtime_status: 'error', outcome: { kind: 'paused', reason: 'needs_verification', detail: 'inspect evidence' } }));
  });

  it('returns null when activation completion has no activation ledger', () => {
    expect(reduceActivationCompletion(state({ runtime_activations: [] }), 'child', 'done', 't1')).toBeNull();
  });

  it('does not mutate unrelated activation records', () => {
    const current = state({
      runtime_activations: [
        activation({ child_card_id: 'other' }),
      ],
    });
    const next = reduceActivationCompletion(current, 'child', 'done', 't1');
    expect(next?.runtime_activations?.[0]).toEqual(current.runtime_activations?.[0]);
  });

  it('only completes the runtime run bound to the completed activation', () => {
    const next = reduceActivationCompletion(state({
      runtime_activations: [
        activation({ activation_id: 'act-1', runtime_run_id: 'run-1' }),
        activation({ activation_id: 'act-2', runtime_run_id: 'run-2', status: 'completed' }),
      ],
      runtime_runs: [
        run({ run_id: 'run-1', activation_id: 'act-1' }),
        run({ run_id: 'run-2', activation_id: 'act-2', session_id: 'planner:other' }),
      ],
    }), 'child', 'blocked', 't1');
    expect(next?.runtime_runs?.find((candidate) => candidate.run_id === 'run-1')).toEqual(expect.objectContaining({ phase: 'blocked', outcome: { kind: 'blocked', error: 'Activation blocked.' } }));
    expect(next?.runtime_runs?.find((candidate) => candidate.run_id === 'run-2')).toEqual(expect.objectContaining({ phase: 'executor', session_id: 'planner:other' }));
    expect(next?.runtime_runs?.find((candidate) => candidate.run_id === 'run-2')).not.toHaveProperty('outcome');
  });
});
