import { describe, expect, it } from '@jest/globals';
import { handleOpenAICodexSseChunk } from '../../src/agents/llm-codex-parser.js';
import { LlmRequestError } from '../../src/agents/llm-errors.js';

describe('OpenAI Codex SSE parser context-length errors', () => {
  function failureFor(event: Record<string, unknown>) {
    const chunk = `data: ${JSON.stringify(event)}\n`;
    try {
      handleOpenAICodexSseChunk(chunk, new Map(), new Set(), [], () => undefined, () => undefined);
    } catch (error) {
      expect(error).toBeInstanceOf(LlmRequestError);
      return (error as LlmRequestError).failure;
    }
    throw new Error('Expected Codex SSE event to fail');
  }

  it('classifies stream context_length_exceeded errors as token budget failures', () => {
    const chunk = [
      'data: {"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Your input exceeds the context window of this model. Please adjust your input and try again.","param":"input"},"sequence_number":2}',
      '',
    ].join('\n');

    expect(() => handleOpenAICodexSseChunk(
      chunk,
      new Map(),
      new Set(),
      [],
      () => undefined,
      () => undefined,
    )).toThrow(LlmRequestError);

    try {
      handleOpenAICodexSseChunk(chunk, new Map(), new Set(), [], () => undefined, () => undefined);
    } catch (error) {
      expect(error).toBeInstanceOf(LlmRequestError);
      expect((error as LlmRequestError).failure).toEqual(expect.objectContaining({
        kind: 'token_budget_exceeded',
        provider: 'openai-codex',
        status: 400,
      }));
      expect((error as LlmRequestError).message).toContain('context_length_exceeded');
    }
  });

  it('classifies well-formed provider SSE errors by explicit temporary and permanent evidence', () => {
    expect(failureFor({ type: 'error', error: { code: 'server_error', message: 'server failed' } })).toMatchObject({ kind: 'server_transient' });
    expect(failureFor({ type: 'response.failed', response: { status: 503, error: { message: 'unavailable' } } })).toMatchObject({ kind: 'server_transient', status: 503 });
    expect(failureFor({ type: 'error', retry_after: 2, error: { code: 'rate_limit_exceeded', message: 'slow down' } })).toMatchObject({ kind: 'rate_limit', retryAfterMs: 2000 });
    expect(failureFor({ type: 'error', status: 401, error: { code: 'unauthorized', message: 'bad auth' } })).toMatchObject({ kind: 'auth_permanent' });
    expect(failureFor({ type: 'response.failed', response: { error: { code: 'invalid_request_error', message: 'invalid model' } } })).toMatchObject({ kind: 'provider_protocol_error' });
    expect(failureFor({ type: 'error', error: { code: 'mystery', message: 'well formed but unknown' } })).toMatchObject({ kind: 'provider_protocol_error' });
  });
});
