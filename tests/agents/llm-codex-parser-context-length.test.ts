import { describe, expect, it } from '@jest/globals';
import { handleOpenAICodexSseChunk } from '../../src/agents/llm-codex-parser.js';
import { LlmRequestError } from '../../src/agents/llm-errors.js';

describe('OpenAI Codex SSE error classification', () => {
  function failureFor(event: Record<string, unknown>, responseStatus = 200) {
    const chunk = `data: ${JSON.stringify(event)}\n`;
    try {
      handleOpenAICodexSseChunk(chunk, responseStatus, new Map(), new Set(), [], () => undefined, () => undefined);
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
    expect(failureFor({ type: 'error', status: 401, error: { code: 'unauthorized', message: 'bad auth' } })).toMatchObject({ kind: 'auth_permanent', status: 200 });
    expect(failureFor({ type: 'error', error: { code: 'mystery', message: 'unknown' } })).toMatchObject({ kind: 'provider_protocol_error', status: 200 });
  });
});
