import { describe, expect, it, jest } from '@jest/globals';

import { PlannerIterationRunner, type PlannerIterationRunnerDeps } from '../../src/runtime/phases/planner-iteration-runner.js';
import { createLifecycleFlags } from '../../src/runtime/runtime-lifecycle-state.js';
import type { AgentExecutionPort } from '../../src/contracts/index.js';
import type { CardRecord } from '../../src/schemas/types.js';

function makeGoal(overrides: Partial<CardRecord> = {}): CardRecord {
  const status = overrides.status ?? 'running';
  return {
    id: 'goal-1',
    type: 'goal',
    parent: 'project',
    depth: 1,
    position: 0,
    title: 'Goal',
    description: '',
    status,
    lifecycle: { status, result: null, error: null, completed_at: null } as CardRecord['lifecycle'],
    subtype: null,
    instructions_file: null,
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'planner',
    created_at: '2026-06-05T00:00:00.000Z',
    updated_at: '2026-06-05T00:00:00.000Z',
    version_seq: 1,
    assigned_to: null,
    depends_on: [],
    related: [],
    acceptance: '',
    metrics: null,
    artifacts: [],
    attachments: [],
    estimate: null,
    started_at: null,
    duration_ms: null,
    status_text: null,
    status_text_updated_at: null,
    status_text_author_session_id: null,
    latest_self_report: null,
    retries: 0,
    ...overrides,
  };
}

function makeDeps(card: CardRecord): PlannerIterationRunnerDeps {
  return {
    cards: {
      maxDepth: 3,
      read: jest.fn(() => card),
      listChildren: jest.fn(() => []),
      list: jest.fn(() => [card]),
      create: jest.fn(),
      mutateCard: jest.fn(),
      update: jest.fn(),
      commitTerminalLifecyclePatch: jest.fn(),
    } as unknown as PlannerIterationRunnerDeps['cards'],
    stateMachine: {
      transition: jest.fn(),
      transitionCard: jest.fn(),
    } as unknown as PlannerIterationRunnerDeps['stateMachine'],
    mutations: { apply: jest.fn() } as unknown as PlannerIterationRunnerDeps['mutations'],
    lifecycle: createLifecycleFlags(),
    now: () => '2026-06-05T00:00:00.000Z',
    agentRuntime: {
      invokePlanner: jest.fn(() => ({
        status: 'continue',
        summary: 'goal needs another planning pass',
      })),
    } as unknown as AgentExecutionPort,
    skillsEngine: () => null,
    goalContext: {
      buildPlannerGoalContext: jest.fn(() => ({ resumeReason: 'initial', goalContext: '## Goal Context\ncontext' })),
      inferResumeReason: jest.fn(() => 'initial'),
    } as unknown as PlannerIterationRunnerDeps['goalContext'],
    pendingActivations: {
      dispatchActivation: jest.fn(),
      dispatch: jest.fn(async () => ({ dispatchedGoal: false, executedTerminal: false })),
    } as unknown as PlannerIterationRunnerDeps['pendingActivations'],
    runLedger: { finishOpenPlannerRun: jest.fn() } as unknown as PlannerIterationRunnerDeps['runLedger'],
    handlePlannerFailure: jest.fn(async () => ({ kind: 'handled' as const })),
  };
}

describe('PlannerIterationRunner replan on changed', () => {
  it('returns replan when goal status is changed after planner phase', async () => {
    const card = makeGoal({ status: 'changed', retries: 3 });
    const deps = makeDeps(card);

    const result = await new PlannerIterationRunner(deps).run({ goalId: card.id, iteration: 0 });

    expect(result).toEqual({ kind: 'replan' });
    expect(deps.pendingActivations.dispatch).toHaveBeenCalledWith(card.id);
  });
});
