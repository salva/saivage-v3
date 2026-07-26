import { describe, expect, it } from '@jest/globals';

import { readOpenAIChatStream } from '../../src/agents/llm-stream-parser.js';

function stream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('OpenAI Chat stream parser', () => {
  it('assembles message content across streamed chunks', async () => {
    const body = stream(
      'data: {"choices":[{"delta":{"content":"hel',
      'lo "}}]}\n',
      'data: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}]}\n',
      'data: [DONE]\n',
    );

    await expect(readOpenAIChatStream(body)).resolves.toEqual({ kind: 'message', content: 'hello world' });
  });

  it('assembles a tool call whose JSON arguments are fragmented across chunks', async () => {
    const first = JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-original', type: 'function', function: { name: 'lookup', arguments: '{"city":' } }] } }] });
    const second = JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Madrid"}' } }] }, finish_reason: 'tool_calls' }] });
    const body = stream(`data: ${first}\nda`, `ta: ${second}\ndata: [DONE]\n`);

    await expect(readOpenAIChatStream(body)).resolves.toEqual({
      kind: 'tool_calls',
      tool_calls: [{
        id: 'call-original',
        type: 'function',
        function: { name: 'lookup', arguments: '{"city":"Madrid"}' },
      }],
    });
  });
});
