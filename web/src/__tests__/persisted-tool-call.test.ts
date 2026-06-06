import { describe, expect, it } from 'vitest';

import { parseToolCallMessage } from '../utils/persistedToolCall';

describe('persisted tool-call parser', () => {
  it('parses the backend persisted row shape', () => {
    expect(
      parseToolCallMessage({
        role: 'assistant',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'get_card', arguments: JSON.stringify({ id: 'card-1' }) },
          },
        ],
      }),
    ).toEqual({ id: 'call-1', name: 'get_card', args: { id: 'card-1' } });
  });

  it('rejects legacy wrapper rows and non-object arguments', () => {
    expect(() => parseToolCallMessage({ toolCalls: [] })).toThrow('deprecated {toolCalls:[...]} wrapper');
    expect(() =>
      parseToolCallMessage({
        role: 'assistant',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'get_card', arguments: JSON.stringify([]) },
          },
        ],
      }),
    ).toThrow('must parse to an object');
  });
});
