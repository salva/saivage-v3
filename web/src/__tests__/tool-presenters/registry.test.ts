import { describe, expect, it } from 'vitest';
import { presentToolCall, presentToolResult } from '../../utils/tool-presenters';
import { readToolCallMessage } from '../../utils/tool-presenters/helpers';
import { callEnvelope } from './_helpers';

describe('tool presenter registry', () => {
  it('loads the default registration and presents known tool names through public APIs', () => {
    expect(() => presentToolCall(callEnvelope('unknown_tool'))).not.toThrow();
    expect(presentToolCall(callEnvelope('read', { path: 'src/index.ts' }))).toMatchObject({ icon: '📖', name: 'read' });
    expect(presentToolCall(callEnvelope('run_command', { command: 'npm test' }))).toMatchObject({ icon: '⚡', name: 'run_command' });
    expect(presentToolResult(JSON.stringify({ content: 'a\nb', total_lines: 2 }), { tool: 'read' })).toMatchObject({ icon: '↩', name: 'read', status: 'ok' });
  });

  it('readToolCallMessage raises on legacy {toolCalls:[...]} wrapper', () => { // legacy_message_shape: negative-test
    const legacy = JSON.stringify({ toolCalls: [{ name: 'x', params: {} }] }); // legacy_message_shape: negative-test
    expect(() => readToolCallMessage(legacy)).toThrow(/toolCalls/);
  });

  it('readToolCallMessage raises on rows with more than one tool_call entry', () => {
    const multi = JSON.stringify({
      role: 'assistant',
      tool_calls: [
        { id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'y', arguments: '{}' } },
      ],
    });
    expect(() => readToolCallMessage(multi)).toThrow(/exactly one entry/);
  });
});
