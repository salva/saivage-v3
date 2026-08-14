import { describe, it, expect } from '@jest/globals';
import {
  parseToolCallMessageForModel,
  PersistedRowCorruptError,
} from '../../src/contracts/persisted-tool-call.js';

describe('parseToolCallMessageForModel', () => {
  it('projects a valid canonical row for the model', () => {
    const row = {
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_xyz',
          type: 'function',
          function: { name: 'emit_result', arguments: '{"status":"done","summary":"ok"}' },
        },
      ],
    };

    expect(parseToolCallMessageForModel(row)).toEqual({
      id: 'call_xyz',
      name: 'emit_result',
      arguments: '{"status":"done","summary":"ok"}',
    });
  });

  it('rejects legacy {toolCalls:[...]} wrapper as PersistedRowCorruptError(legacy_tool_calls_wrapper)', () => {
    const legacy = { toolCalls: [{ id: 'c1', name: 'emit_result', args: {} }] };
    let caught: unknown;
    try {
      parseToolCallMessageForModel(legacy);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PersistedRowCorruptError);
    expect((caught as PersistedRowCorruptError).code).toBe('legacy_tool_calls_wrapper');
  });

  it('rejects a current row with no tool call as PersistedRowCorruptError(malformed_tool_call)', () => {
    let caught: unknown;
    try {
      parseToolCallMessageForModel({ role: 'assistant', tool_calls: [] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PersistedRowCorruptError);
    expect((caught as PersistedRowCorruptError).code).toBe('malformed_tool_call');
  });
});
