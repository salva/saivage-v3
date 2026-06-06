import { describe, expect, it } from '@jest/globals';
import { handlePlannerInvocationFailure, selectPlannerInvocationFailureRun, type PlannerInvocationFailureEffects } from '../../src/runtime/phases/planner-invocation-failure.js';
import type { CardRecord, RuntimeRunRecord, RuntimeState } from '../../src/schemas/types.js';

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

  it('blocks token-budget failures with typed planner-blocked lifecycle result', async () => {
    const calls: string[] = [];
    const published: RuntimeRunRecord[] = [];
    const effects = testEffects({
      transitionCard: async (cardId, event, details) => { calls.push(`${event}:${cardId}:${details.blocked_reason ? 'blocked' : 'none'}`); },
      updateCard: async (_cardId, patch) => { calls.push(`update:${patch.status}`); expect(patch.lifecycle?.result).toMatchObject({ kind: 'planner_blocked', resume_reason: 'planner_context_length_exceeded' }); },
      updateRuntimeRun: (runId, updates) => ({ ...failedRun, run_id: runId, ...updates }) as RuntimeRunRecord,
      publishRuntimeRun: (run) => { published.push(run); },
      transitionRuntime: async (event, details) => { calls.push(`${event}:${details.reason}`); },
    });

    const result = await handlePlannerInvocationFailure({
      goalId: 'goal-a',
      error: new Error('context length exceeded'),
      failureKind: 'token_budget',
      providerStatus: 400,
      currentCard: baseCard({ id: 'goal-a', type: 'goal' }),
      failedRun,
      effects,
    });

    expect(result).toEqual({ kind: 'handled' });
    expect(calls).toEqual(['block:goal-a:blocked', 'update:blocked', 'card_terminated:planner_context_length_exceeded']);
    expect(published).toEqual([expect.objectContaining({ run_id: 'run-a', phase: 'blocked', outcome: expect.objectContaining({ kind: 'blocked' }) })]);
  });

  it('marks generic planner failures and asks caller to rethrow', async () => {
    const calls: string[] = [];
    const error = new Error('planner exploded');
    const result = await handlePlannerInvocationFailure({
      goalId: 'goal-a',
      error,
      failureKind: 'generic',
      providerStatus: null,
      currentCard: baseCard({ id: 'goal-a', type: 'goal' }),
      failedRun,
      effects: testEffects({
        transitionCard: async (cardId, event) => { calls.push(`${event}:${cardId}`); },
        updateCard: async (_cardId, patch) => { calls.push(`update:${patch.lifecycle?.result?.kind}:${patch.status}`); },
        transitionRuntime: async (event, details) => { calls.push(`${event}:${details.reason}`); },
      }),
    });

    expect(result).toEqual({ kind: 'rethrow', error });
    expect(calls).toEqual(['fail:goal-a', 'update:planner_failure:failed', 'goal_exit:planner_error']);
  });
});

function testEffects(overrides: Partial<PlannerInvocationFailureEffects> = {}): PlannerInvocationFailureEffects {
  return {
    now: () => '2026-01-01T00:00:00.000Z',
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

function baseCard(overrides: Partial<CardRecord> = {}): CardRecord {
  const lifecycle = overrides.lifecycle ?? ({ status: overrides.status ?? 'running', result: null, error: null, completed_at: null } as CardRecord['lifecycle']);
  return {
    id: overrides.id ?? 'card-a',
    type: overrides.type ?? 'goal',
    parent: overrides.parent ?? 'project',
    depth: overrides.depth ?? 1,
    position: overrides.position ?? 0,
    title: overrides.title ?? 'Card',
    description: overrides.description ?? '',
    status: overrides.status ?? 'running',
    tags: overrides.tags ?? [],
    priority: overrides.priority ?? 0,
    urgency: overrides.urgency ?? 'normal',
    created_by: overrides.created_by ?? 'planner',
    created_at: overrides.created_at ?? '2026-01-01T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-01-01T00:00:00.000Z',
    version_seq: overrides.version_seq ?? 1,
    depends_on: overrides.depends_on ?? [],
    related: overrides.related ?? [],
    acceptance: overrides.acceptance ?? '',
    lifecycle,
    artifacts: overrides.artifacts ?? [],
    attachments: overrides.attachments ?? [],
    retries: overrides.retries ?? 0,
  };
}
