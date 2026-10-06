import { describe, expect, it } from '@jest/globals';
import { parseOpenAIResponsesJson } from '../../src/agents/llm-openai-responses-parser.js';
import { responsesProducerAccountId } from '../../src/agents/llm-openai-responses-account.js';
import { LlmRequestError } from '../../src/contracts/llm-failure.js';

const CTX = { provider: 'openai', producerAccountId: responsesProducerAccountId({ provider: 'openai', account: null }), model: 'gpt-5.6', sourceInputId: 'input-1', responseStatus: 200 };

describe('OpenAI Responses parser', () => {
  it.each([undefined, null, {}, { input_tokens: null, output_tokens_details: null }])('keeps omitted Responses usage unknown %#', usage => {
    expect(parseOpenAIResponsesJson(JSON.stringify({ status: 'completed', output: [], usage }), CTX).result.usage).toBeUndefined();
  });
  it('retains Responses detail-only zero without deriving totals', () => {
    expect(parseOpenAIResponsesJson(JSON.stringify({ status: 'completed', output: [], usage: { output_tokens_details: { reasoning_tokens: 0 } } }), CTX).result.usage).toEqual({ reasoning_output_tokens: 0 });
  });
  it.each(['failed', 'cancelled', 'incomplete'])('does not consume usage on noncompleted %s response', status => {
    const failure = failureFor({ status, output: [], usage: { input_tokens: 'private-invalid-count' } });
    expect(failure.kind).not.toBe('parse_error');
    expect(failure).not.toHaveProperty('usage');
  });
  it.each([
    [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }],
    [{ type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{}' }],
  ])('retains terminal usage for message and tool results %#', (item) => {
    const parsed = parseOpenAIResponsesJson(JSON.stringify({ status: 'completed', output: [item], usage: {
      input_tokens: 100, output_tokens: 10, total_tokens: 110,
      input_tokens_details: { cached_tokens: 40, cache_write_tokens: 99 },
      output_tokens_details: { reasoning_tokens: 5 }, private_marker: 'ignored',
    } }), CTX);
    expect(parsed.result.usage).toEqual({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cached_input_tokens: 40, reasoning_output_tokens: 5 });
  });
  it('accepts only completed responses and preserves raw output in private context', () => {
    const output = [
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' },
      { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'done' }] },
    ];
    const parsed = parseOpenAIResponsesJson(JSON.stringify({ status: 'completed', output, usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } }), CTX);
    expect(parsed.result).toEqual({ kind: 'message', content: 'done', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
    expect(parsed.privateContext.output).toEqual(output);
    expect(parsed.assistantOutputIds).toEqual(['rs_1', 'msg_1']);
    expect(parsed.responseStatus).toBe('completed');
  });

  it('preserves complete JSON function calls and their output ids', () => {
    const output = [{ type: 'function_call', id: 'fc_1', call_id: 'call-1', name: 'read_file', arguments: '{"path":"a"}' }];
    const parsed = parseOpenAIResponsesJson(JSON.stringify({ status: 'completed', output }), CTX);
    expect(parsed.result).toEqual({ kind: 'tool_calls', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }], usage: undefined });
    expect(parsed.privateContext.output).toEqual(output);
    expect(parsed.assistantOutputIds).toEqual(['fc_1']);
  });

  it('maps provider returned cancelled to server_transient, not local cancelled', () => {
    expect(() => parseOpenAIResponsesJson(JSON.stringify({ status: 'cancelled', output: [] }), CTX)).toThrow(LlmRequestError);
    try {
      parseOpenAIResponsesJson(JSON.stringify({ status: 'cancelled', output: [] }), CTX);
    } catch (error) {
      expect((error as LlmRequestError).failure.kind).toBe('server_transient');
    }
  });

  it('maps incomplete max output to output exhaustion, never input-context exhaustion', () => {
    expect(failureFor({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }))
      .toMatchObject({ kind: 'output_token_limit_exceeded', status: 200 });
  });

  it.each([
    { code: 'context_length_exceeded' },
    { code: 'context_length_exceeded', type: null, param: null },
    { code: 'context_length_exceeded', type: 'invalid_request_error', param: 'input' },
    { type: 'context_length_exceeded', code: null },
  ])('maps exact failed response context evidence: %#', (error) => {
    expect(failureFor({ status: 'failed', error })).toMatchObject({ kind: 'input_context_exhausted', status: 200 });
  });

  it.each([
    { message: 'context_length_exceeded context window input too large token budget' },
    { metadata: { code: 'context_length_exceeded' } },
    { code: 'CONTEXT_LENGTH_EXCEEDED' },
    { code: 'context_length_exceeded', type: 'other' },
    { code: 'context_length_exceeded', param: 'messages' },
    { code: 'max_tokens' },
    { code: 'max_output_tokens' },
    { code: 'token_budget' },
  ])('does not map non-authoritative failed response evidence: %#', (error) => {
    expect(failureFor({ status: 'failed', error }).kind).toBe('server_transient');
  });

  it('does not authorize terminal context classification from a non-200 HTTP response', () => {
    expect(failureFor(
      { status: 'failed', error: { code: 'context_length_exceeded' } },
      { ...CTX, responseStatus: 201 },
    )).toMatchObject({ kind: 'server_transient', status: 201 });
  });

  it('classifies HTTP-200 failed content evidence and preserves the original body',()=>{
    const body=JSON.stringify({status:'failed',error:{type:'content_filter',message:'blocked'}});
    try{parseOpenAIResponsesJson(body,CTX);}catch(error){expect((error as LlmRequestError).failure).toMatchObject({kind:'content_policy',status:200,message:'OpenAI Responses provider failed response before completion: blocked',providerResponse:body});return;}
    throw new Error('Expected content refusal');
  });
});

function failureFor(payload: Record<string, unknown>, ctx = CTX) {
  try {
    parseOpenAIResponsesJson(JSON.stringify(payload), ctx);
  } catch (error) {
    expect(error).toBeInstanceOf(LlmRequestError);
    return (error as LlmRequestError).failure;
  }
  throw new Error('Expected Responses payload to fail');
}
