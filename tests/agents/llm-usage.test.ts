import { describe, expect, it } from '@jest/globals';
import { extractChatUsage, extractResponsesUsage } from '../../src/agents/llm-usage.js';
import { llmUsageSchema, LlmRequestError } from '../../src/contracts/index.js';

// Synthetic fixtures following public OpenAI completion_usage.py and response_usage.py:
// https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/completion_usage.py
// https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/responses/response_usage.py
describe.each<[typeof extractChatUsage, string, string, string, string]>([
  [extractChatUsage, 'prompt_tokens', 'completion_tokens', 'prompt_tokens_details', 'completion_tokens_details'],
  [extractResponsesUsage, 'input_tokens', 'output_tokens', 'input_tokens_details', 'output_tokens_details'],
])('allowlisted usage extraction %#', (extract, input, output, inputDetails, outputDetails) => {
  it('preserves five facts without adding subsets or unconsumed metadata', () => {
    expect(extract({ [input]: 100, [output]: 10, total_tokens: 110,
      [inputDetails]: { cached_tokens: 40, audio_tokens: 'unvalidated' },
      [outputDetails]: { reasoning_tokens: 5, prediction_tokens: {} }, vendor: 'private' }, 'test'))
      .toEqual({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cached_input_tokens: 40, reasoning_output_tokens: 5 });
  });
  it.each([undefined, null, {}, { [input]: null, [inputDetails]: null, [outputDetails]: {} }, { vendor: 8 }])('omits unknown-only usage %#', value => {
    expect(extract(value, 'test')).toBeUndefined();
  });
  it('preserves detail-only zero without deriving totals', () => {
    expect(extract({ [inputDetails]: { cached_tokens: 0 }, [outputDetails]: { reasoning_tokens: null } }, 'test')).toEqual({ cached_input_tokens: 0 });
  });
  it.each<[string, unknown]>([
    ['usage', []], ['usage', 'secret'],
    [`usage.${inputDetails}`, { [inputDetails]: [] }],
    [`usage.${outputDetails}`, { [outputDetails]: 'secret' }],
    ...[-1, 1.5, Infinity, NaN, 'secret', false, {}].map((value): [string, unknown] => [`usage.${input}`, { [input]: value }]),
    [`usage.${inputDetails}.cached_tokens`, { [inputDetails]: { cached_tokens: 'secret' } }],
    [`usage.${outputDetails}.reasoning_tokens`, { [outputDetails]: { reasoning_tokens: -1 } }],
  ])('fails safely at consumed path %s', (path, value) => {
    try { extract(value, 'test'); } catch (error) {
      expect(error).toBeInstanceOf(LlmRequestError);
      expect((error as LlmRequestError).failure).toEqual({ kind: 'parse_error', provider: 'test', message: `Invalid provider token usage at ${path}.` });
      return;
    }
    throw new Error('Expected parse failure');
  });
});

describe('strict normalized usage contract', () => {
  it.each([{}, { cached_input_tokens: 0 }, { prompt_tokens: 1, reasoning_output_tokens: 9 }])('accepts partial facts without accounting equality %#', usage => {
    expect(llmUsageSchema.parse(usage)).toEqual(usage);
  });
  it.each(['prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_input_tokens', 'reasoning_output_tokens'])('rejects invalid %s', key => {
    for (const value of [-1, 0.5, Infinity, NaN, null, '1']) expect(llmUsageSchema.safeParse({ [key]: value }).success).toBe(false);
  });
  it('rejects extra durable keys', () => {
    expect(llmUsageSchema.safeParse({ cached_tokens: 1 }).success).toBe(false);
  });
});
