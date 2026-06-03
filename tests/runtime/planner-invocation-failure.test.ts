import { describe, expect, it } from '@jest/globals';
import { handlePlannerInvocationFailure, selectPlannerInvocationFailureRun, type PlannerInvocationFailureEffects } from '../../src/runtime/phases/planner-invocation-failure.js';
import type { RuntimeRunRecord, RuntimeState } from '../../src/schemas/types.js';

const failedRun = { run_id: 'run-a' } as RuntimeRunRecord;

describe('planner invocation failure handler', () => {
  it('selects the open planner run owned by the failing planner invocation', () => {
    const state = {
      runtime_runs: [
        { ...failedRun, run_id: 'activation-owned', card_id: 'goal-a', phase: 'planner', runtime_status: 'running', session_id: 'planner:goal-a', activation_id: 'act-1' },
        { ...failedRun, run_id: 'other-session', card_id: 'goal-a', phase: 'planner', runtime_status: 'running', session_id: 'planner:other', activation_id: null },
        { ...failedRun, run_id: 'root-run', kind: 'root', card_id: 'goal-a', phase: 'planner', runtime_status: 'running', session_id: 'planner:goal-a', activation_id: null },
      ],
    } as RuntimeState;
    expect(selectPlannerInvocationFailureRun({ state, goalId: 'goal-a' })?.run_id).toBe('root-run');
  });

  it('blocks token-budget failures and preserves existing result data', async () => {
    const calls: string[] = [];
    const published: RuntimeRunRecord[] = [];
    const effects = testEffects({
      transitionCard: async (cardId, event, details) => { calls.push(`${event}:${cardId}:${details.blocked_reason ? 'blocked' : 'none'}`); },
      updateCard: async (_cardId, patch) => { calls.push(`update:${patch.status}`); expect(patch.result).toMatchObject({ existing: true, planning: expect.objectContaining({ resume_reason: 'planner_context_length_exceeded' }) }); },
      updateRuntimeRun: (runId, updates) => ({ ...failedRun, run_id: runId, ...updates }) as RuntimeRunRecord,
      publishRuntimeRun: (run) => { published.push(run); },
      transitionRuntime: async (event, details) => { calls.push(`${event}:${details.reason}`); },
    });

    const result = await handlePlannerInvocationFailure({
      goalId: 'goal-a',
      error: new Error('context length exceeded'),
      failureKind: 'token_budget',
      providerStatus: 400,
      existingResult: { existing: true },
      failedRun,
      effects,
    });

    expect(result).toEqual({ kind: 'handled' });
    expect(calls).toEqual(['block:goal-a:blocked', 'update:blocked', 'card_terminated:planner_context_length_exceeded']);
    expect(published).toEqual([expect.objectContaining({ run_id: 'run-a', phase: 'blocked', result: 'blocked' })]);
  });

  it('marks generic planner failures and asks caller to rethrow', async () => {
    const calls: string[] = [];
    const error = new Error('planner exploded');
    const result = await handlePlannerInvocationFailure({
      goalId: 'goal-a',
      error,
      failureKind: 'generic',
      providerStatus: null,
      existingResult: undefined,
      failedRun,
      effects: testEffects({
        transitionCard: async (cardId, event) => { calls.push(`${event}:${cardId}`); },
        updateCard: async (_cardId, patch) => { calls.push(`update:${patch.status_text}`); },
        transitionRuntime: async (event, details) => { calls.push(`${event}:${details.reason}`); },
      }),
    });

    expect(result).toEqual({ kind: 'rethrow', error });
    expect(calls).toEqual(['fail:goal-a', 'update:Planner failed: planner exploded', 'goal_exit:planner_error']);
  });
});

function testEffects(overrides: Partial<PlannerInvocationFailureEffects> = {}): PlannerInvocationFailureEffects {
  return {
    now: () => 'now',
    emitRuntimeDiagnostic: () => undefined,
    appendRuntimeDiagnostic: () => undefined,
    appendError: () => undefined,
    transitionCard: async () => undefined,
    updateCard: async () => undefined,
    updateRuntimeRun: (_runId, updates) => ({ ...failedRun, ...updates }) as RuntimeRunRecord,
    publishRuntimeRun: () => undefined,
    transitionRuntime: async () => undefined,
    ...overrides,
  };
}
