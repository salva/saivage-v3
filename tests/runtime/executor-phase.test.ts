import { describe, expect, it } from '@jest/globals';
import { buildExecutorActiveRunPatch, buildExecutorCompletionPatch, decideExecutorOutcome, resolveExecutorLastSessionId, selectExecutorStartAction } from '../../src/runtime/phases/executor-phase.js';
import type { ExecutorResult } from '../../src/contracts/index.js';

function execResult(overrides: Partial<ExecutorResult> = {}): ExecutorResult {
  return {
    status: 'done',
    status_text: 'done',
    summary: 'ok',
    result: null,
    artifacts: [],
    attachments: [],
    fallback_with_evidence: null,
    ...overrides,
  } as ExecutorResult;
}

describe('executor phase decisions', () => {
  it('selects start actions from card status', () => {
    expect(selectExecutorStartAction('backlog')).toBe('start');
    expect(selectExecutorStartAction('done')).toBe('restart');
    expect(selectExecutorStartAction('active')).toBe('reviewer_repair_resume');
    expect(selectExecutorStartAction('running')).toBeNull();
  });

  it('decides terminal, registration-failed, and verification outcomes', () => {
    expect(decideExecutorOutcome({ execResult: execResult(), registrationFailed: false })).toEqual({ parkedForVerification: false, finalStatus: 'done', outcome: 'done', transitionAction: 'executor_finish', reason: undefined });
    expect(decideExecutorOutcome({ execResult: execResult(), registrationFailed: true })).toEqual({ parkedForVerification: false, finalStatus: 'failed', outcome: 'failed', transitionAction: 'executor_finish', reason: 'evidence_registration_failed' });
    expect(decideExecutorOutcome({ execResult: execResult({ fallback_with_evidence: { reason: 'parse_failure' } }), registrationFailed: false })).toEqual({ parkedForVerification: true, finalStatus: 'done', outcome: 'needs_verification', transitionAction: 'executor_partial_finish', reason: 'fallback_with_evidence:parse_failure' });
  });

  it('builds the executor completion card patch', () => {
    const patch = buildExecutorCompletionPatch({
      execResult: execResult({ result: { changed: true } }),
      existingResult: { previous: true },
      existingCompletedAt: null,
      acceptedAt: '2026-01-01T00:00:00.000Z',
      lastSessionId: 'executor-card-a',
      terminalCompletedAt: '2026-01-01T00:00:01.000Z',
      registrationFailed: false,
      registrationError: null,
      artifactRegistrationErrors: [],
      attachmentRegistrationErrors: [],
      parkedForVerification: false,
    });

    expect(patch).toEqual(expect.objectContaining({
      completed_at: '2026-01-01T00:00:01.000Z',
      error: null,
      status_text: 'done',
      status_text_author_session_id: 'executor-card-a',
    }));
    expect(patch.result).toEqual(expect.objectContaining({
      previous: true,
      changed: true,
      executor: { changed: true },
      latest_self_report: expect.objectContaining({ result: 'done', summary: 'ok' }),
    }));
  });

  it('records evidence registration failures and verification fallback', () => {
    const patch = buildExecutorCompletionPatch({
      execResult: execResult({ fallback_with_evidence: { reason: 'tool_calls_envelope_recovery' } }),
      existingResult: null,
      existingCompletedAt: 'already-done',
      acceptedAt: '2026-01-01T00:00:00.000Z',
      lastSessionId: null,
      terminalCompletedAt: '2026-01-01T00:00:01.000Z',
      registrationFailed: true,
      registrationError: 'bad evidence',
      artifactRegistrationErrors: ['missing artifact'],
      attachmentRegistrationErrors: ['missing attachment'],
      parkedForVerification: true,
    });

    expect(patch.completed_at).toBe('already-done');
    expect(patch.error).toBe('bad evidence');
    expect(patch.result).toEqual(expect.objectContaining({
      evidence_registration_failures: {
        artifacts: ['missing artifact'],
        attachments: ['missing attachment'],
      },
      fallback_with_evidence: { reason: 'tool_calls_envelope_recovery' },
    }));
  });

  it('builds executor active-run runtime state patches', () => {
    expect(buildExecutorActiveRunPatch({
      card: { id: 'code-a', type: 'code' } as any,
      goalId: 'goal-a',
      callerEdge: { callerSessionId: 'planner:goal-a', callerToolCallId: 'call-a' },
      at: 'now',
    })).toEqual({
      current_card_id: 'code-a',
      active_card_run: expect.objectContaining({
        card_id: 'code-a',
        card_type: 'code',
        phase: 'executor',
        caller_session_id: 'planner:goal-a',
        caller_tool_call_id: 'call-a',
        executor_session_id: 'executor-code-a',
        started_at: 'now',
        last_turn_at: 'now',
      }),
    });
  });

  it('resolves executor last session id by precedence', () => {
    expect(resolveExecutorLastSessionId({ adapterLastSessionId: 'adapter', activeRunExecutorSessionId: 'active', currentAgentSessionId: 'current' })).toBe('adapter');
    expect(resolveExecutorLastSessionId({ adapterLastSessionId: null, activeRunExecutorSessionId: 'active', currentAgentSessionId: 'current' })).toBe('active');
    expect(resolveExecutorLastSessionId({ adapterLastSessionId: undefined, activeRunExecutorSessionId: null, currentAgentSessionId: 'current' })).toBe('current');
    expect(resolveExecutorLastSessionId({ adapterLastSessionId: undefined, activeRunExecutorSessionId: null, currentAgentSessionId: null })).toBeNull();
  });
});
