import { describe, expect, it } from '@jest/globals';
import { handleExecutorCompletion, type ExecutorCompletionEffects } from '../../src/runtime/phases/executor-completion-handler.js';
import type { CardRecord } from '../../src/schemas/types.js';
import type { ExecutorResult } from '../../src/contracts/index.js';

function execResult(status: ExecutorResult['status']): ExecutorResult {
  return { status, status_text: `${status} text`, summary: `${status} summary`, error: null, result: { output: true }, fallback_with_evidence: null } as unknown as ExecutorResult;
}

describe('executor completion handler', () => {
  it('completes successful executor output with unwind result', async () => {
    const calls: string[] = [];
    const result = await handleExecutorCompletion({
      cardId: 'code-a',
      goalId: 'goal-a',
      execResult: execResult('done'),
      acceptedAt: 'accepted',
      lastSessionId: 'executor-code-a',
      registrationFailed: false,
      registrationError: null,
      artifactRegistrationErrors: [],
      attachmentRegistrationErrors: [],
      effects: testEffects({
        transitionCard: async (cardId, event, details) => { calls.push(`${event}:${cardId}:${details.finalStatus}`); return true; },
        readCard: () => ({ result: { previous: true }, completed_at: null } as unknown as CardRecord),
        updateCard: async (_cardId, patch) => { calls.push(`update:${patch.completed_at}`); expect(patch.result).toMatchObject({ previous: true, output: true, latest_self_report: { result: 'done' } }); },
        appendChildUnwindToolResult: (cardId, outcome) => { calls.push(`unwind:${cardId}:${outcome}`); },
      }),
    });

    expect(result).toEqual({ transitioned: true, executedTerminal: true, failed: false, outcome: 'done' });
    expect(calls).toEqual(['executor_finish:code-a:done', 'update:now', 'unwind:code-a:done']);
  });

  it('turns evidence registration failure into failed completion and card_failed event', async () => {
    const calls: string[] = [];
    const result = await handleExecutorCompletion({
      cardId: 'code-a',
      goalId: 'goal-a',
      execResult: execResult('done'),
      acceptedAt: 'accepted',
      lastSessionId: null,
      registrationFailed: true,
      registrationError: 'registration failed',
      artifactRegistrationErrors: ['artifact failed'],
      attachmentRegistrationErrors: [],
      effects: testEffects({
        transitionCard: async (cardId, event, details) => { calls.push(`${event}:${cardId}:${details.finalStatus}:${details.reason}`); return true; },
        updateCard: async (_cardId, patch) => { calls.push(`update:${patch.error}`); expect(patch.result).toMatchObject({ evidence_registration_failures: { artifacts: ['artifact failed'] } }); },
        appendChildUnwindToolResult: (cardId, outcome) => { calls.push(`unwind:${cardId}:${outcome}`); },
        emitCardFailed: (cardId, goalId) => { calls.push(`failed:${cardId}:${goalId}`); },
      }),
    });

    expect(result).toEqual({ transitioned: true, executedTerminal: true, failed: true, outcome: 'failed' });
    expect(calls).toEqual([
      'executor_finish:code-a:failed:evidence_registration_failed',
      'update:registration failed',
      'unwind:code-a:failed',
      'failed:code-a:goal-a',
    ]);
  });
});

function testEffects(overrides: Partial<ExecutorCompletionEffects> = {}): ExecutorCompletionEffects {
  return {
    now: () => 'now',
    transitionCard: async () => true,
    readCard: () => null,
    updateCard: async () => undefined,
    appendChildUnwindToolResult: () => undefined,
    emitCardFailed: () => undefined,
    ...overrides,
  };
}
