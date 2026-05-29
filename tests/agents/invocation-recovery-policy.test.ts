import { describe, expect, it } from '@jest/globals';

import {
  InvocationRecoveryPolicy,
  sanitizeRecoveryMessage,
} from '../../src/agents/invocation-recovery-policy.js';
import { LlmRequestError } from '../../src/agents/llm-failure.js';
import type { Candidate } from '../../src/agents/provider.js';

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
      action: 'failover_without_cooldown',
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
        requested: ['unsupported_tool_calls'],
        supported: [],
        message: 'Candidate p/_/m does not support requested LLM capabilities: unsupported_tool_calls',
      }),
      {
        ...baseContext,
        capabilitySkips: [{ candidate, reasons: ['unsupported_tool_calls'] }],
      },
    );

    expect(decision).toMatchObject({
      failure: { kind: 'capability_mismatch' },
      action: 'failover_without_cooldown',
      markFailed: false,
      appendModelIssue: true,
    });
    expect(decision.eventPayload.capabilitySkipReasons).toEqual(['unsupported_tool_calls']);
  });

  it('distinguishes capability-only no-candidate exhaustion from health exhaustion', () => {
    const capabilityDecision = policy.decideNoCandidates({
      ...baseContext,
      candidate: undefined,
      capabilitySkips: [{ candidate, reasons: ['unsupported_tool_choice'] }],
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
});
