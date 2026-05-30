import { describe, expect, it } from 'vitest';
import { presentToolCall } from '../../utils/tool-presenters';
import { readToolCallMessage } from '../../utils/tool-presenters/helpers';
import { registeredCallToolNamesForTest, registeredResultToolNamesForTest, registeredToolNamesForTest } from '../../utils/tool-presenters/registry';
import { callEnvelope } from './_helpers';

describe('tool presenter registry', () => {
  it('loads the default registration and resolves known tool names', () => {
    expect(() => presentToolCall(callEnvelope('unknown_tool'))).not.toThrow();
    expect(registeredToolNamesForTest()).toContain('read_project_file');
    expect(registeredCallToolNamesForTest()).toContain('run_project_command');
    expect(registeredResultToolNamesForTest()).toContain('read_file');
  });

  it('readToolCallMessage raises on legacy {toolCalls:[...]} wrapper', () => {
    const legacy = JSON.stringify({ toolCalls: [{ name: 'x', params: {} }] });
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
