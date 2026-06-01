import { describe, expect, it } from '@jest/globals';
import { handleOpenAICodexSseChunk } from '../../src/agents/llm-codex-parser.js';
import { LlmRequestError } from '../../src/agents/llm-errors.js';

describe('OpenAI Codex SSE parser context-length errors', () => {
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
});
