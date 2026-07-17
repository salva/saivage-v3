import { describe, expect, it } from '@jest/globals';

import {
  InvocationRecoveryPolicy,
  sanitizeRecoveryMessage,
} from '../../src/agents/invocation-recovery-policy.js';
import { LlmRequestError } from '../../src/contracts/llm-failure.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import { parseOpenAIResponsesJson } from '../../src/agents/llm-openai-responses-parser.js';

const candidate: Candidate = { provider: 'openai-compatible', account: 'primary', model: 'gpt-test' };
const policy = new InvocationRecoveryPolicy();
const baseContext = {
  role: 'planner',
  candidate,
  attempt: 1,
  maxAttempts: 4,
  recoveryDelayMs: 25,
  maxRecoveryRetries: 2,
};

describe('InvocationRecoveryPolicy', () => {
  it('maps structured Llm errors to explicit recovery classes and health decisions', () => {
    expect(policy.decideFailure(new LlmRequestError({ kind: 'auth_permanent', provider: 'openai-compatible', status: 401, message: 'bad token' }), baseContext)).toMatchObject({
      failure: { kind: 'auth_permanent' },
      action: 'fail_invocation',
      markFailed: true,
      availability: { state: 'BLOCKED_UNTIL', reason: 'auth_permanent' },
    });
    expect(policy.decideFailure(new LlmRequestError({ kind: 'rate_limit', provider: 'openai-compatible', status: 429, message: 'too many requests' }), baseContext)).toMatchObject({
      failure: { kind: 'rate_limit' },
      action: 'cooldown_and_failover',
      markFailed: true,
      availability: { state: 'BLOCKED_UNTIL', reason: 'rate_limit' },
    });
    expect(policy.decideFailure(new LlmRequestError({ kind: 'server_transient', provider: 'openai-compatible', status: 500, message: 'upstream 500' }), baseContext)).toMatchObject({
      failure: { kind: 'server_transient' },
      action: 'cooldown_and_failover',
      markFailed: true,
    });
    expect(policy.decideFailure(new LlmRequestError({ kind: 'timeout', provider: 'openai-compatible', message: 'timed out' }), baseContext)).toMatchObject({
      failure: { kind: 'timeout' },
      action: 'cooldown_and_failover',
      markFailed: true,
    });
  });

  it('treats ARCH-008 capability diagnostics as static non-health failures', () => {
    const decision = policy.decideFailure(
      new LlmRequestError({
        kind: 'capability_mismatch',
        provider: 'openai-compatible',
        model: 'gpt-test',
        requested: ['unsupported_tools_mode'],
        supported: [],
        message: 'Candidate p/_/m does not support requested LLM capabilities: unsupported_tools_mode',
      }),
      {
        ...baseContext,
        capabilitySkips: [{ candidate, reasons: ['unsupported_tools_mode'] }],
      },
    );

    expect(decision).toMatchObject({
      failure: { kind: 'capability_mismatch' },
      action: 'fail_invocation',
      markFailed: false,
      appendModelIssue: true,
    });
    expect(decision.eventPayload.capabilitySkipReasons).toEqual(['unsupported_tools_mode']);
  });

  it('distinguishes capability-only no-candidate exhaustion from health exhaustion', () => {
    const capabilityDecision = policy.decideNoCandidates({
      ...baseContext,
      candidate: undefined,
      capabilitySkips: [{ candidate, reasons: ['unsupported_exclusive_tool_choice'] }],
    });
    expect(capabilityDecision).toMatchObject({
      failure: { kind: 'capability_mismatch' },
      action: 'abort_without_retry',
      markFailed: false,
      abort: true,
    });
    expect(capabilityDecision.message).toContain('No capability-compatible candidates');

    const healthDecision = policy.decideNoCandidates({ ...baseContext, candidate: undefined, capabilitySkips: [] });
    expect(healthDecision).toMatchObject({
      failure: { kind: 'unknown' },
      action: 'abort_without_retry',
      markFailed: false,
    });
    expect(healthDecision.message).toContain('No healthy candidates');
  });

  it('bounds parse/contract retry by maxRecoveryRetries without poisoning provider health', () => {
    const retryDecision = policy.decideFailure(
      new LlmRequestError({ kind: 'parse_error', provider: 'openai-compatible', message: 'invalid json', bodyPreview: '{' }),
      baseContext,
    );
    expect(retryDecision).toMatchObject({
      failure: { kind: 'parse_error' },
      action: 'retry_same_after_delay',
      markFailed: false,
      retryDelayMs: 25,
    });

    const exhaustedDecision = policy.decideFailure(
      new LlmRequestError({ kind: 'parse_error', provider: 'openai-compatible', message: 'Unexpected token' }),
      {
        ...baseContext,
        attempt: 3,
        maxRecoveryRetries: 2,
      },
    );
    expect(exhaustedDecision).toMatchObject({
      failure: { kind: 'parse_error' },
      action: 'failover_without_cooldown',
      markFailed: false,
    });
  });

  it('keeps cancellation abortive and unknown errors compatibility-transient', () => {
    expect(
      policy.decideFailure(
        new LlmRequestError({ kind: 'cancelled', provider: 'openai-compatible', reason: 'abort', message: 'Agent invocation cancelled for session s1' }),
        baseContext,
      ),
    ).toMatchObject({
      failure: { kind: 'cancelled' },
      action: 'abort_without_retry',
      abort: true,
      markFailed: false,
    });
    expect(policy.decideFailure(new Error('mystery outage'), baseContext)).toMatchObject({
      failure: { kind: 'unknown' },
      action: 'cooldown_and_failover',
      markFailed: true,
    });
  });

  it('redacts synthetic secrets from policy messages and payloads', () => {
    const decision = policy.decideFailure(
      new LlmRequestError({
        kind: 'server_transient',
        provider: 'openai-compatible',
        status: 500,
        message: 'failed with api_key=sk-testSECRET123456 and Authorization: Bearer ghp_syntheticSECRET123456',
      }),
      baseContext,
    );

    expect(decision.message).not.toContain('sk-testSECRET123456');
    expect(decision.message).not.toContain('ghp_syntheticSECRET123456');
    expect(JSON.stringify(decision.eventPayload)).not.toContain('sk-testSECRET123456');
    expect(sanitizeRecoveryMessage('token=abc1234567890')).toContain('[REDACTED]');
  });

  it('marks success only through explicit success decisions', () => {
    expect(policy.decideSuccess(baseContext)).toMatchObject({
      action: 'mark_succeeded',
      markSucceeded: true,
      markFailed: false,
      appendModelIssue: false,
    });
  });

  it('keeps OpenAI Responses provider-cancelled noncompletion on failover path, not local abort path', () => {
    const failure = responsesFailure({ status: 'cancelled', output: [] });
    expect(failure.failure.kind).toBe('server_transient');
    expect(policy.decideFailure(failure, baseContext)).toMatchObject({
      action: 'cooldown_and_failover',
      markFailed: true,
      abort: false,
    });
  });

  it('maps OpenAI Responses noncompleted statuses to planned recovery policy decisions', () => {
    expect(policy.decideFailure(responsesFailure({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }), baseContext)).toMatchObject({ action: 'fail_invocation', markFailed: false, appendModelIssue: true });
    expect(policy.decideFailure(responsesFailure({ status: 'failed', error: { message: 'provider failed' }, output: [] }), baseContext)).toMatchObject({ action: 'cooldown_and_failover', markFailed: true, appendModelIssue: true });
    expect(policy.decideFailure(responsesFailure({ status: 'in_progress', output: [] }), baseContext)).toMatchObject({ action: 'fail_invocation', markFailed: true, appendModelIssue: true });
    expect(policy.decideFailure(responsesFailure({ status: 'mystery', output: [] }), baseContext)).toMatchObject({ action: 'retry_same_after_delay', markFailed: false, appendModelIssue: true });
  });

  it.each(['input_context_exhausted', 'output_token_limit_exceeded'] as const)('fails invocation without provider-health mutation for %s', (kind) => {
    expect(policy.decideFailure(new LlmRequestError({ kind, provider: 'openai-compatible', status: 400, message: 'structured limit failure' }), baseContext)).toMatchObject({
      failure: { kind },
      action: 'fail_invocation',
      markFailed: false,
      appendModelIssue: true,
    });
  });
});

function responsesFailure(payload: Record<string, unknown>): LlmRequestError {
  try {
    parseOpenAIResponsesJson(JSON.stringify(payload), { provider: 'openai-compatible', model: 'gpt-test', sourceInputId: 'input-1', responseStatus: 200 });
  } catch (error) {
    if (error instanceof LlmRequestError) return error;
    throw error;
  }
  throw new Error('Expected Responses payload to fail');
}
