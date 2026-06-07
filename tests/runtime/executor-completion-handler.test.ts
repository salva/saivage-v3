import { describe, expect, it } from '@jest/globals';
import { handleExecutorCompletion, type ExecutorCompletionEffects } from '../../src/runtime/phases/executor-completion-handler.js';
import type { CardLifecycleState, CardRecord } from '../../src/schemas/index.js';
import type { ExecutorResult } from '../../src/contracts/index.js';

const acceptedAt = '2026-01-01T00:00:00.000Z';
const completedAt = '2026-01-01T00:00:01.000Z';

function execResult(status: ExecutorResult['status']): ExecutorResult {
  return { status, status_text: `${status} text`, summary: `${status} summary`, error: null, result: { output: true }, fallback_with_evidence: null } as unknown as ExecutorResult;
}

describe('executor completion handler', () => {
  it('completes successful executor output with unwind result', async () => {
    const calls: string[] = [];
    const result = await handleExecutorCompletion({
      projectRoot: process.cwd(),
      card: cardRecord({ id: 'code-a' }),
      cardId: 'code-a',
      goalId: 'goal-a',
      execResult: execResult('done'),
      acceptedAt,
      lastSessionId: 'executor-code-a',
      registrationFailed: false,
      registrationError: null,
      artifactRegistrationErrors: [],
      attachmentRegistrationErrors: [],
      effects: testEffects({
        transitionCard: async (cardId, event, details) => { calls.push(`${event}:${cardId}:${details.finalStatus}`); return true; },
        now: () => completedAt,
        readCard: () => cardRecord({ id: 'code-a', lifecycle: { status: 'running', result: null, error: null, completed_at: null } }),
        updateCard: async (_cardId, patch) => { calls.push(`update:${patch.lifecycle?.completed_at}`); expect(patch.lifecycle?.result).toMatchObject({ kind: 'executor_success', executor: { output: true }, latest_self_report: { result: 'done' } }); },
        appendChildUnwindToolResult: (cardId, outcome) => { calls.push(`unwind:${cardId}:${outcome}`); },
      }),
    });

    expect(result).toEqual({ transitioned: true, executedTerminal: true, failed: false, outcome: 'done' });
    expect(calls).toEqual([`executor_finish:code-a:done`, `update:${completedAt}`, 'unwind:code-a:done']);
  });

  it('turns evidence registration failure into failed completion and card_failed event', async () => {
    const calls: string[] = [];
    const result = await handleExecutorCompletion({
      projectRoot: process.cwd(),
      card: cardRecord({ id: 'code-a' }),
      cardId: 'code-a',
      goalId: 'goal-a',
      execResult: execResult('done'),
      acceptedAt,
      lastSessionId: null,
      registrationFailed: true,
      registrationError: 'registration failed',
      artifactRegistrationErrors: ['artifact failed'],
      attachmentRegistrationErrors: [],
      effects: testEffects({
        transitionCard: async (cardId, event, details) => { calls.push(`${event}:${cardId}:${details.finalStatus}:${details.reason}`); return true; },
        now: () => completedAt,
        readCard: () => cardRecord({ id: 'code-a', lifecycle: { status: 'running', result: null, error: null, completed_at: null } }),
        updateCard: async (_cardId, patch) => { calls.push(`update:${patch.lifecycle?.error}`); expect(patch.lifecycle?.result).toMatchObject({ kind: 'executor_failure', partial_result: { evidence_registration_failures: { artifacts: ['artifact failed'] } } }); },
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

  it('throws when executor completion cannot read current card state', async () => {
    await expect(handleExecutorCompletion({
      projectRoot: process.cwd(),
      card: cardRecord({ id: 'code-a' }),
      cardId: 'code-a',
      goalId: 'goal-a',
      execResult: execResult('done'),
      acceptedAt,
      lastSessionId: null,
      registrationFailed: false,
      registrationError: null,
      artifactRegistrationErrors: [],
      attachmentRegistrationErrors: [],
      effects: testEffects({ readCard: () => null }),
    })).rejects.toThrow("executor completion for 'code-a' cannot read current card state");
  });

  it('parks fallback evidence without terminal unwind or parent success', async () => {
    const calls: string[] = [];
    const result = await handleExecutorCompletion({
      projectRoot: process.cwd(),
      card: cardRecord({ id: 'code-a' }),
      cardId: 'code-a',
      goalId: 'goal-a',
      execResult: { ...execResult('done'), fallback_with_evidence: { reason: 'parse_failure' } },
      acceptedAt,
      lastSessionId: 'executor-code-a',
      registrationFailed: false,
      registrationError: null,
      artifactRegistrationErrors: [],
      attachmentRegistrationErrors: [],
      effects: testEffects({
        transitionCard: async (cardId, event, details) => { calls.push(`${event}:${cardId}:${details.finalStatus}:${details.reason}`); return true; },
        readCard: () => cardRecord({ id: 'code-a', lifecycle: { status: 'running', result: null, error: 'stale', completed_at: null } }),
        updateCard: async (_cardId, patch) => { calls.push(`update:${patch.status}:${patch.lifecycle?.error}:${patch.lifecycle?.completed_at}`); expect(patch.lifecycle?.result).toMatchObject({ kind: 'executor_needs_verification', preserved_result: { output: true, fallback_with_evidence: { reason: 'parse_failure' } } }); },
        appendChildUnwindToolResult: (cardId, outcome) => { calls.push(`unwind:${cardId}:${outcome}`); },
      }),
    });

    expect(result).toEqual({ transitioned: true, executedTerminal: false, failed: false, outcome: 'needs_verification' });
    expect(calls).toEqual(['executor_partial_finish:code-a:needs_verification:fallback_with_evidence:parse_failure', 'update:needs_verification:null:null']);
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

function cardRecord(overrides: Partial<CardRecord> = {}): CardRecord {
  const lifecycle = overrides.lifecycle ?? ({ status: overrides.status ?? 'running', result: null, error: null, completed_at: null } as CardLifecycleState);
  return {
    id: overrides.id ?? 'code-a',
    type: overrides.type ?? 'code',
    parent: overrides.parent ?? 'goal-a',
    depth: overrides.depth ?? 1,
    position: overrides.position ?? 0,
    title: overrides.title ?? 'Code A',
    description: overrides.description ?? '',
    status: overrides.status ?? 'running',
    subtype: overrides.subtype ?? null,
    instructions_file: overrides.instructions_file ?? null,
    tags: overrides.tags ?? [],
    priority: overrides.priority ?? 0,
    urgency: overrides.urgency ?? 'normal',
    created_by: overrides.created_by ?? 'planner',
    created_at: overrides.created_at ?? acceptedAt,
    updated_at: overrides.updated_at ?? acceptedAt,
    version_seq: overrides.version_seq ?? 1,
    assigned_to: overrides.assigned_to ?? null,
    depends_on: overrides.depends_on ?? [],
    related: overrides.related ?? [],
    acceptance: overrides.acceptance ?? '',
    lifecycle,
    metrics: overrides.metrics ?? null,
    artifacts: overrides.artifacts ?? [],
    attachments: overrides.attachments ?? [],
    estimate: overrides.estimate ?? null,
    started_at: overrides.started_at ?? null,
    duration_ms: overrides.duration_ms ?? null,
    status_text: overrides.status_text ?? null,
    status_text_updated_at: overrides.status_text_updated_at ?? null,
    status_text_author_session_id: overrides.status_text_author_session_id ?? null,
    latest_self_report: overrides.latest_self_report ?? null,
    metadata: overrides.metadata ?? null,
    retries: overrides.retries ?? 0,
  };
}
