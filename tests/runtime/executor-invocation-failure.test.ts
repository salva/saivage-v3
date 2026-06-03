import { describe, expect, it } from '@jest/globals';
import { handleExecutorInvocationFailure, type ExecutorInvocationFailureEffects } from '../../src/runtime/phases/executor-invocation-failure.js';

describe('executor invocation failure handler', () => {
  it('fails the card, appends unwind result, and emits card_failed', async () => {
    const calls: string[] = [];
    await handleExecutorInvocationFailure({
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
    emitRuntimeDiagnostic: () => undefined,
    appendRuntimeDiagnostic: () => undefined,
    appendError: () => undefined,
    transitionCard: async () => undefined,
    appendChildUnwindToolResult: () => undefined,
    emitCardFailed: () => undefined,
    ...overrides,
  };
}
