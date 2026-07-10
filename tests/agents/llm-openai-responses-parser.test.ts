import { describe, expect, it } from '@jest/globals';
import { parseOpenAIResponsesJson } from '../../src/agents/llm-openai-responses-parser.js';
import { LlmRequestError } from '../../src/agents/llm-errors.js';

const CTX = { provider: 'openai', model: 'gpt-5.6', sourceInputId: 'input-1' };

describe('OpenAI Responses parser', () => {
  it('accepts only completed responses and preserves raw output in private context', () => {
    const output = [
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' },
      { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'done' }] },
    ];
    const parsed = parseOpenAIResponsesJson(JSON.stringify({ status: 'completed', output, usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } }), CTX);
    expect(parsed.result).toEqual({ kind: 'message', content: 'done', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
    expect(parsed.privateContext.output).toEqual(output);
  });

  it('maps provider returned cancelled to server_transient, not local cancelled', () => {
    expect(() => parseOpenAIResponsesJson(JSON.stringify({ status: 'cancelled', output: [] }), CTX)).toThrow(LlmRequestError);
    try {
      parseOpenAIResponsesJson(JSON.stringify({ status: 'cancelled', output: [] }), CTX);
    } catch (error) {
      expect((error as LlmRequestError).failure.kind).toBe('server_transient');
    }
  });

  it('maps incomplete max output to token budget exceeded', () => {
    try {
      parseOpenAIResponsesJson(JSON.stringify({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }), CTX);
    } catch (error) {
      expect((error as LlmRequestError).failure.kind).toBe('token_budget_exceeded');
    }
  });
});
