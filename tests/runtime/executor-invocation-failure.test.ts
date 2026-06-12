import { describe, expect, it } from '@jest/globals';
import { handleExecutorInvocationFailure, type ExecutorInvocationFailureEffects } from '../../src/runtime/phases/executor-invocation-failure.js';
import type { CardRecord } from '../../src/schemas/index.js';

describe('executor invocation failure handler', () => {
  it('fails the card, appends unwind result, and emits card_failed', async () => {
    const calls: string[] = [];
    await handleExecutorInvocationFailure({
      card: executorCard('code-a'),
      cardId: 'code-a',
      goalId: 'goal-a',
      error: new Error('executor exploded'),
      effects: testEffects({
        transitionCard: async (cardId, event, details) => { calls.push(`${event}:${cardId}:${details.reason}`); },
        appendChildUnwindToolResult: (cardId, outcome, summary) => { calls.push(`unwind:${cardId}:${outcome}:${summary}`); },
        emitCardFailed: (cardId, goalId) => { calls.push(`failed:${cardId}:${goalId}`); },
      }),
    });

    expect(calls).toEqual([
      'fail:code-a:executor_exception',
      'unwind:code-a:failed:Terminal card code-a execution failed before producing a result.',
      'failed:code-a:goal-a',
    ]);
  });
});

function testEffects(overrides: Partial<ExecutorInvocationFailureEffects> = {}): ExecutorInvocationFailureEffects {
  return {
    publishRuntimeDiagnostic: () => undefined,
    appendError: () => undefined,
    transitionCard: async () => undefined,
    updateCard: () => undefined,
    appendChildUnwindToolResult: () => undefined,
    emitCardFailed: () => undefined,
    now: () => '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function executorCard(id: string): CardRecord {
  return {
    id,
    type: 'code',
    parent: 'goal-a',
    depth: 1,
    title: 'Code A',
    description: 'Do code work',
    status: 'running',
    depends_on: [],
    priority: 1,
    tags: [],
    urgency: 'normal',
    created_by: 'planner',
    related: [],
    acceptance: '',
    artifacts: [],
    attachments: [],
    retries: 0,
    lifecycle: { status: 'running', result: null, error: null, completed_at: null },
  } as unknown as CardRecord;
}
