import { describe, expect, it, jest } from '@jest/globals';

import { defaultInvocationRecoveryPolicy } from '../../src/agents/invocation-recovery-policy.js';
import { LlmRequestError } from '../../src/contracts/llm-failure.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import { parseOpenAIResponsesJson } from '../../src/agents/llm-openai-responses-parser.js';

const candidate: Candidate = { provider: 'openai-compatible', account: 'primary', model: 'gpt-test' };
const policy = defaultInvocationRecoveryPolicy;
const baseContext = { candidate, recoveryDelayMs: 25 };

describe('InvocationRecoveryPolicy', () => {
  it('returns only terminal/retry control and consumed availability state', () => {
    jest.useFakeTimers({ now: 1_000 });
    try {
      expect(policy.decideFailure(new LlmRequestError({ kind: 'auth_permanent', provider: 'openai-compatible', status: 401, message: 'bad token' }), baseContext)).toEqual({
        kind: 'terminal',
        availability: { state: 'BLOCKED_UNTIL', untilMs: 3_601_000, reason: 'auth_permanent' },
      });
      expect(policy.decideFailure(new LlmRequestError({ kind: 'rate_limit', provider: 'openai-compatible', status: 429, message: 'too many requests' }), baseContext)).toEqual({
        kind: 'retry',
        wait: 'rate-limit',
        availability: { state: 'BLOCKED_UNTIL', untilMs: 61_000, reason: 'rate_limit' },
      });
      expect(policy.decideFailure(new LlmRequestError({ kind: 'server_transient', provider: 'openai-compatible', status: 500, message: 'upstream 500' }), baseContext)).toEqual({
        kind: 'retry',
        wait: 'standard',
        retryDelayMs: 25,
        availability: { state: 'COOLING', untilMs: 6_000, reason: 'server_transient' },
      });
      expect(policy.decideFailure(new LlmRequestError({ kind: 'timeout', provider: 'openai-compatible', message: 'timed out' }), baseContext)).toEqual({
        kind: 'retry',
        wait: 'standard',
        retryDelayMs: 25,
        availability: { state: 'COOLING', untilMs: 6_000, reason: 'timeout' },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps capability mismatch and cancellation terminal without health mutation', () => {
    expect(policy.decideFailure(new LlmRequestError({kind:'content_policy',provider:'openai-compatible',message:'refused',providerResponse:'raw'}),baseContext)).toEqual({kind:'terminal'});
    expect(policy.decideFailure(new LlmRequestError({
      kind: 'capability_mismatch',
      provider: 'openai-compatible',
      model: 'gpt-test',
      requested: ['unsupported_tools_mode'],
      supported: [],
      message: 'unsupported',
    }), baseContext)).toEqual({ kind: 'terminal' });
    expect(policy.decideFailure(new LlmRequestError({
      kind: 'cancelled',
      provider: 'openai-compatible',
      reason: 'abort',
      message: 'cancelled',
    }), baseContext)).toEqual({ kind: 'terminal' });
  });

  it('uses standard retry control for parse errors without provider-health mutation', () => {
    expect(policy.decideFailure(
      new LlmRequestError({ kind: 'parse_error', provider: 'openai-compatible', message: 'invalid json', bodyPreview: '{' }),
      baseContext,
    )).toEqual({ kind: 'retry', wait: 'standard', retryDelayMs: 25 });
  });

  it('keeps unknown errors transient with cooling availability', () => {
    jest.useFakeTimers({ now: 1_000 });
    try {
      expect(policy.decideFailure(new Error('mystery outage'), baseContext)).toEqual({
        kind: 'retry',
        wait: 'standard',
        retryDelayMs: 25,
        availability: { state: 'COOLING', untilMs: 6_000, reason: 'unknown' },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps OpenAI Responses provider-cancelled noncompletion on the standard retry path', () => {
    const failure = responsesFailure({ status: 'cancelled', output: [] });
    expect(failure.failure.kind).toBe('server_transient');
    expect(policy.decideFailure(failure, baseContext)).toMatchObject({ kind: 'retry', wait: 'standard' });
  });

  it('maps OpenAI Responses noncompleted statuses to the minimal recovery decisions', () => {
    expect(policy.decideFailure(responsesFailure({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }), baseContext)).toEqual({ kind: 'terminal' });
    expect(policy.decideFailure(responsesFailure({ status: 'failed', error: { message: 'provider failed' }, output: [] }), baseContext)).toMatchObject({ kind: 'retry', wait: 'standard', availability: { reason: 'server_transient' } });
    expect(policy.decideFailure(responsesFailure({ status: 'in_progress', output: [] }), baseContext)).toEqual({ kind: 'terminal' });
    expect(policy.decideFailure(responsesFailure({ status: 'mystery', output: [] }), baseContext)).toEqual({ kind: 'retry', wait: 'standard', retryDelayMs: 25 });
  });

  it.each(['input_context_exhausted', 'output_token_limit_exceeded'] as const)(
    'returns terminal without provider-health mutation for %s',
    (kind) => {
      expect(policy.decideFailure(new LlmRequestError({ kind, provider: 'openai-compatible', status: 400, message: 'structured limit failure' }), baseContext))
        .toEqual({ kind: 'terminal' });
    },
  );
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
