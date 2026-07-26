import { describe, expect, it } from '@jest/globals';

import { readOpenAICodexStream } from '../../src/agents/llm-codex-parser.js';

function stream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function event(value: Record<string, unknown>): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

describe('OpenAI Codex stream parser', () => {
  it('assembles message content across streamed events and physical chunks', async () => {
    const events = event({ type: 'response.output_text.delta', delta: 'hello ' })
      + event({ type: 'response.output_text.delta', delta: 'world' });
    const body = stream(events.slice(0, 19), events.slice(19, 57), events.slice(57));

    await expect(readOpenAICodexStream(body, 200)).resolves.toEqual({ kind: 'message', content: 'hello world' });
  });

  it('assembles a function call with fragmented arguments and original identity', async () => {
    const events = event({
      type: 'response.output_item.added',
      item: { type: 'function_call', id: 'item-1', call_id: 'call-original', name: 'lookup', arguments: '' },
    }) + event({ type: 'response.function_call_arguments.delta', item_id: 'item-1', delta: '{"city":' })
      + event({ type: 'response.function_call_arguments.delta', item_id: 'item-1', delta: '"Madrid"}' })
      + event({ type: 'response.function_call_arguments.done', item_id: 'item-1', call_id: 'call-original' });
    const body = stream(events.slice(0, 73), events.slice(73, 181), events.slice(181));

    await expect(readOpenAICodexStream(body, 200)).resolves.toEqual({
      kind: 'tool_calls',
      tool_calls: [{
        id: 'call-original',
        type: 'function',
        function: { name: 'lookup', arguments: '{"city":"Madrid"}' },
      }],
    });
  });
});
