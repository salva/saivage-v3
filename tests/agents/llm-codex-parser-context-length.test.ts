import { describe, expect, it } from '@jest/globals';
import { handleOpenAICodexEvent } from '../../src/agents/llm-codex-parser.js';
import { LlmRequestError } from '../../src/contracts/llm-failure.js';

describe('OpenAI Codex SSE error classification', () => {
  function failureFor(event: Record<string, unknown>, responseStatus = 200) {
    const dataText = JSON.stringify(event);
    try {
      handleOpenAICodexEvent(dataText, responseStatus, new Map(), new Set(), [], () => { throw new Error('Unexpected completed message.'); });
    } catch (error) {
      expect(error).toBeInstanceOf(LlmRequestError);
      return (error as LlmRequestError).failure;
    }
    throw new Error('Expected Codex SSE event to fail');
  }

  it.each([
    { type: 'error', error: { code: 'context_length_exceeded' } },
    { type: 'error', error: { type: 'context_length_exceeded', code: null, param: 'input' } },
    { type: 'response.failed', response: { status: 'failed', error: { code: 'context_length_exceeded', type: 'invalid_request_error', param: 'input' } } },
  ])('accepts exact context event and retains opened HTTP 200 status: %#', (event) => {
    expect(failureFor(event)).toMatchObject({ kind: 'input_context_exhausted', provider: 'openai-codex', status: 200 });
  });

  it.each([
    { type: 'error', error: { message: 'context_length_exceeded context window input too large token budget' } },
    { type: 'error', error: { metadata: { code: 'context_length_exceeded' } } },
    { type: 'error', error: [{ code: 'context_length_exceeded' }] },
    { type: 'error', error: { code: 'CONTEXT_LENGTH_EXCEEDED' } },
    { type: 'error', error: { code: 'context_length_exceeded', type: 'other' } },
    { type: 'error', error: { code: 'context_length_exceeded', param: 'messages' } },
    { type: 'response.failed', response: { status: 400, error: { code: 'context_length_exceeded' } } },
    { type: 'response.failed', response: { status: 'failed', error: { code: 'max_output_tokens' } } },
    { type: 'response.failed', error: { code: 'context_length_exceeded' } },
  ])('does not classify non-authoritative event as input context: %#', (event) => {
    expect(failureFor(event).kind).not.toBe('input_context_exhausted');
  });

  it('preserves other structured SSE failure classes while retaining opened response status', () => {
    expect(failureFor({ type: 'error', error: { code: 'server_error', message: 'server failed' } })).toMatchObject({ kind: 'server_transient', status: 200 });
    expect(failureFor({ type: 'response.failed', response: { status: 503, error: { message: 'unavailable' } } })).toMatchObject({ kind: 'server_transient', status: 200 });
    expect(failureFor({ type: 'error', retry_after: 2, error: { code: 'rate_limit_exceeded', message: 'slow down' } }, 201)).toMatchObject({ kind: 'rate_limit', status: 201, retryAfterMs: 2000 });
    expect(failureFor({ type: 'error', retry_after_ms: 1250.4, error: { code: 'rate_limit_exceeded', message: 'slow down' } }, 201)).toMatchObject({ kind: 'rate_limit', status: 201, retryAfterMs: 1250 });
    expect(failureFor({ type: 'error', status: 401, error: { code: 'unauthorized', message: 'bad auth' } })).toMatchObject({ kind: 'auth_permanent', status: 200 });
    expect(failureFor({ type: 'error', error: { code: 'mystery', message: 'unknown' } })).toMatchObject({ kind: 'provider_protocol_error', status: 200 });
  });

  it('declines overflowing retry_after seconds without discarding explicit rate-limit evidence', () => {
    const failure = failureFor({ type: 'error', retry_after: Number.MAX_VALUE, error: { code: 'rate_limit_exceeded', message: 'slow down' } }, 201);
    expect(failure).toMatchObject({ kind: 'rate_limit', status: 201 });
    expect(failure).not.toHaveProperty('retryAfterMs');
  });

  it.each([
    { type: 'error', error: { code: 'server_is_overloaded', message: 'busy' } },
    { type: 'response.failed', response: { status: 'failed', error: { code: 'server_is_overloaded', message: 'busy' } } },
  ])('classifies exact direct server overload evidence at opened HTTP 200: %#', (event) => {
    expect(failureFor(event)).toMatchObject({
      kind: 'server_transient',
      provider: 'openai-codex',
      status: 200,
    });
  });

  it.each([
    { type: 'error', error: { message: 'server_is_overloaded' } },
    { type: 'error', error: { metadata: { code: 'server_is_overloaded' } } },
    { type: 'error', error: { code: 'server_is_overload' } },
    { type: 'error', error: { code: 'server_is_overloaded_extra' } },
  ])('does not infer overload from prose, nesting, or near matches: %#', (event) => {
    expect(failureFor(event)).toMatchObject({ kind: 'provider_protocol_error', status: 200 });
  });

  it('classifies content evidence with exact normalized event data',()=>{
    const event={type:'response.failed',response:{status:'failed',error:{code:'content_filter',message:'content policy refusal'}}};
    const failure=failureFor(event);
    expect(failure).toMatchObject({kind:'content_policy',providerResponse:JSON.stringify(event)});
  });
});
