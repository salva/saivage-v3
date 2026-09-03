import { describe, expect, it } from '@jest/globals';

import { readOpenAICodexStream } from '../../src/agents/llm-codex-parser.js';
import { LlmRequestError, type LlmTransportFailure } from '../../src/contracts/llm-failure.js';

const encoder = new TextEncoder();

function stream(...chunks: string[]): ReadableStream<Uint8Array> {
  return byteStream(...chunks.map((chunk) => encoder.encode(chunk)));
}

function byteStream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function event(value: Record<string, unknown>): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function message(text: string | string[], extra: Record<string, unknown> = {}): string {
  const parts = (Array.isArray(text) ? text : [text]).map((value) => ({ type: 'output_text', text: value }));
  return event({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: parts, ...extra } });
}

function completion(id = 'resp_test'): string {
  return event({ type: 'response.completed', response: { id } });
}

function finalizedTool(): string {
  return event({
    type: 'response.output_item.done',
    item: { type: 'function_call', id: 'item-1', call_id: 'call-original', name: 'lookup', arguments: '{"city":"Madrid"}' },
  });
}

async function expectParseError(body: ReadableStream<Uint8Array>): Promise<void> {
  try {
    await readOpenAICodexStream(body, 200);
  } catch (error) {
    expect(error).toBeInstanceOf(LlmRequestError);
    const failure = (error as LlmRequestError).failure;
    expect(failure.kind).toBe('parse_error');
    expect(failure.provider).toBe('openai-codex');
    return;
  }
  throw new Error('Expected OpenAI Codex stream parse failure.');
}

async function expectFailure(body: ReadableStream<Uint8Array>, expected: LlmTransportFailure): Promise<void> {
  try {
    await readOpenAICodexStream(body, 200);
  } catch (error) {
    expect(error).toBeInstanceOf(LlmRequestError);
    expect((error as LlmRequestError).failure).toEqual(expected);
    return;
  }
  throw new Error(`Expected OpenAI Codex ${expected.kind} failure.`);
}

describe('OpenAI Codex stream parser', () => {
  it('uses the completed message instead of repeated, overlapping, or nested done text across chunk and multibyte boundaries', async () => {
    const source = event({ type: 'response.output_text.delta', delta: 'a' })
      + event({ type: 'response.output_text.delta', delta: 'a' })
      + event({ type: 'response.output_text.delta', delta: 'ab' })
      + event({ type: 'response.output_text.delta', delta: 'b' })
      + event({ type: 'response.content_part.done', part: { type: 'output_text', text: 'nested wrong' } })
      + event({ type: 'response.output_text.done', text: 'also wrong' })
      + message('authoritative résumé 🚀')
      + completion();
    const bytes = encoder.encode(source);
    const accentedByte = bytes.indexOf(0xc3);
    const rocketByte = bytes.indexOf(0xf0);
    const body = byteStream(
      bytes.slice(0, 17),
      bytes.slice(17, accentedByte + 1),
      bytes.slice(accentedByte + 1, rocketByte + 2),
      bytes.slice(rocketByte + 2),
    );

    await expect(readOpenAICodexStream(body, 200)).resolves.toEqual({ kind: 'message', content: 'authoritative résumé 🚀' });
  });

  it('replaces commentary with the later final-answer message', async () => {
    const body = stream(message('working', { phase: 'commentary' }) + message('done', { phase: 'final_answer' }) + completion());
    await expect(readOpenAICodexStream(body, 200)).resolves.toEqual({ kind: 'message', content: 'done' });
  });

  it('replaces one unphased completed message with the next', async () => {
    await expect(readOpenAICodexStream(stream(message('first') + message('second') + completion()), 200))
      .resolves.toEqual({ kind: 'message', content: 'second' });
  });

  it('concatenates output_text members of one completed message in array order', async () => {
    await expect(readOpenAICodexStream(stream(message(['one', 'two', 'three']) + completion()), 200))
      .resolves.toEqual({ kind: 'message', content: 'onetwothree' });
  });

  it('completes without physical closure and releases the reader lock', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(message('done') + completion()));
      },
    });

    await expect(readOpenAICodexStream(body, 200)).resolves.toEqual({ kind: 'message', content: 'done' });
    expect(body.locked).toBe(false);
  });

  it('consumes a valid completion event dispatched only by EOF finalization', async () => {
    const unterminatedCompletion = 'data: {"type":"response.completed","response":{"id":"resp_test"}}';
    await expect(readOpenAICodexStream(stream(message('done') + unterminatedCompletion), 200))
      .resolves.toEqual({ kind: 'message', content: 'done' });
  });

  it('fails physical EOF after a completed message but before valid completion', async () => {
    await expectParseError(stream(message('candidate')));
  });

  it.each([
    ['message', message('candidate')],
    ['finalized tool call', finalizedTool()],
  ])('treats [DONE] after a %s candidate as truncation', async (_name, candidate) => {
    await expectParseError(stream(candidate + 'data: [DONE]\n\n' + completion()));
  });

  it('fails physical EOF after deltas without a completed result', async () => {
    await expectParseError(stream(event({ type: 'response.output_text.delta', delta: 'provisional' })));
  });

  it('fails valid completion without a finalized tool call or completed message', async () => {
    await expectParseError(stream(completion()));
  });

  it.each([
    ['missing response', { type: 'response.completed' }],
    ['null response', { type: 'response.completed', response: null }],
    ['array response', { type: 'response.completed', response: [] }],
    ['non-object response', { type: 'response.completed', response: 'resp_test' }],
    ['missing response id', { type: 'response.completed', response: {} }],
    ['non-string response id', { type: 'response.completed', response: { id: 7 } }],
  ])('rejects completion with %s after both candidate kinds and cannot be rescued', async (_name, invalidCompletion) => {
    for (const candidate of [message('candidate'), finalizedTool()]) {
      await expectParseError(stream(candidate + event(invalidCompletion) + completion('resp_later')));
    }
  });

  it('returns finalized tools before a completed message', async () => {
    await expect(readOpenAICodexStream(stream(finalizedTool() + message('ignored') + completion()), 200)).resolves.toEqual({
      kind: 'tool_calls',
      tool_calls: [{
        id: 'call-original',
        type: 'function',
        function: { name: 'lookup', arguments: '{"city":"Madrid"}' },
      }],
    });
  });

  it('preserves fragmented function-call assembly and original identity until valid completion', async () => {
    const source = event({
      type: 'response.output_item.added',
      item: { type: 'function_call', id: 'item-1', call_id: 'call-original', name: 'lookup', arguments: '' },
    }) + event({ type: 'response.function_call_arguments.delta', item_id: 'item-1', delta: '{"city":' })
      + event({ type: 'response.function_call_arguments.delta', item_id: 'item-1', delta: '"Madrid"}' })
      + event({ type: 'response.function_call_arguments.done', item_id: 'item-1', call_id: 'call-original' })
      + completion();
    const body = stream(source.slice(0, 73), source.slice(73, 181), source.slice(181));

    await expect(readOpenAICodexStream(body, 200)).resolves.toEqual({
      kind: 'tool_calls',
      tool_calls: [{ id: 'call-original', type: 'function', function: { name: 'lookup', arguments: '{"city":"Madrid"}' } }],
    });
  });

  it.each([
    ['error', event({ type: 'error', error: { code: 'server_is_overloaded', message: 'busy' } }), {
      kind: 'server_transient', provider: 'openai-codex', status: 200, message: 'OpenAI Codex stream error: server_is_overloaded: busy',
    } satisfies LlmTransportFailure],
    ['response.failed', event({ type: 'response.failed', response: { status: 'failed', error: { code: 'server_is_overloaded', message: 'busy' } } }), {
      kind: 'server_transient', provider: 'openai-codex', status: 200, message: 'OpenAI Codex response failed: server_is_overloaded: busy',
    } satisfies LlmTransportFailure],
  ])('lets pre-completion %s supersede message and tool candidates and prevents rescue', async (_name, failureEvent, expected) => {
    await expectFailure(stream(message('candidate') + finalizedTool() + failureEvent + completion('resp_later')), expected);
  });

  it.each([
    ['malformed JSON', 'data: {bad}\n\n'],
    ['classified failure', event({ type: 'error', error: { code: 'server_is_overloaded', message: 'late' } })],
  ])('does not consume post-terminal %s already framed in one chunk', async (_name, suffix) => {
    await expect(readOpenAICodexStream(stream(message('done') + completion() + suffix), 200))
      .resolves.toEqual({ kind: 'message', content: 'done' });
  });

  it('does not request another physical chunk after valid completion and releases the reader lock', async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls === 1) controller.enqueue(encoder.encode(message('done') + completion()));
        else controller.enqueue(encoder.encode(event({ type: 'error', error: { code: 'server_error', message: 'late' } })));
      },
    }, { highWaterMark: 0 });

    await expect(readOpenAICodexStream(body, 200)).resolves.toEqual({ kind: 'message', content: 'done' });
    expect(pulls).toBe(1);
    expect(body.locked).toBe(false);
  });

  it.each([
    ['missing item', { type: 'response.output_item.done' }],
    ['null item', { type: 'response.output_item.done', item: null }],
    ['array item', { type: 'response.output_item.done', item: [] }],
    ['non-assistant message', { type: 'response.output_item.done', item: { type: 'message', role: 'user', content: [] } }],
    ['non-array message content', { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: 'text' } }],
    ['non-string output text', { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 7 }] } }],
  ])('fails fast for completed-message shape: %s', async (_name, malformedEvent) => {
    await expectParseError(stream(event(malformedEvent) + completion()));
  });

  it('fails fast for a non-string output text delta', async () => {
    await expectParseError(stream(event({ type: 'response.output_text.delta', delta: 7 }) + completion()));
  });

  it('fails malformed normalized multiline JSON instead of skipping it', async () => {
    await expectParseError(stream('event: ignored\r\ndata: {"type":\r\ndata: bad}\r\n\r\n' + completion()));
  });
});
