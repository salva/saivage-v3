import { describe, expect, it } from '@jest/globals';
import { buildExecutorActiveRunPatch, decideExecutorOutcome, resolveExecutorLastSessionId, selectExecutorStartAction } from '../../src/runtime/phases/executor-phase.js';
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
    expect(decideExecutorOutcome({ execResult: execResult({ fallback_with_evidence: { reason: 'parse_failure' } }), registrationFailed: false })).toEqual({ parkedForVerification: true, finalStatus: 'needs_verification', outcome: 'needs_verification', transitionAction: 'executor_partial_finish', reason: 'fallback_with_evidence:parse_failure' });
  });

  it('builds executor active-run runtime state patches', () => {
    expect(buildExecutorActiveRunPatch({
      card: { id: 'code-a', type: 'code' } as any,
      goalId: 'goal-a',
      callerEdge: { callerSessionId: 'planner:goal-a', callerToolCallId: 'call-a' },
      at: 'now',
    })).toEqual({
      status: 'running',
      current_card_id: 'code-a',
      current_agent_session_id: 'executor-code-a',
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
