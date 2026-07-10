import { describe, expect, it } from '@jest/globals';
import { parseOpenAIResponsesJson, readOpenAIResponsesStream } from '../../src/agents/llm-openai-responses-parser.js';
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

describe('OpenAI Responses streaming parser', () => {
  it('accepts terminal completed event only when payload status is completed', async () => {
    const output = [{ type: 'reasoning', encrypted_content: 'opaque' }, { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'streamed' }] }];
    const stream = sseStream([
      { event: 'response.output_item.done', data: { item: output[0] } },
      { event: 'response.completed', data: { status: 'completed', output, usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 } } },
    ]);
    const parsed = await readOpenAIResponsesStream(stream, CTX);
    expect(parsed.result).toEqual({ kind: 'message', content: 'streamed', usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } });
    expect(parsed.privateContext.output).toEqual(output);
  });

  it('maps completed event with provider cancelled status to server_transient', async () => {
    await expect(readOpenAIResponsesStream(sseStream([{ event: 'response.completed', data: { status: 'cancelled', output: [] } }]), CTX)).rejects.toMatchObject({ failure: { kind: 'server_transient' } });
  });

  it('rejects invalid JSON frames and streams without terminal response', async () => {
    await expect(readOpenAIResponsesStream(rawStream('event: response.output_text.delta\ndata: {bad}\n\n'), CTX)).rejects.toMatchObject({ failure: { kind: 'parse_error' } });
    await expect(readOpenAIResponsesStream(sseStream([{ event: 'response.output_text.delta', data: { delta: 'partial' } }]), CTX)).rejects.toMatchObject({ failure: { kind: 'parse_error' } });
  });
});

function sseStream(frames: Array<{ event: string; data: unknown }>): ReadableStream<Uint8Array> {
  return rawStream(frames.map((frame) => `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`).join(''));
}

function rawStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}
