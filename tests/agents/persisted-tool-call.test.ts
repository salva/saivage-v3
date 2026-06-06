import { describe, it, expect } from '@jest/globals';
import {
  parseToolCallMessage,
  serializeToolCallMessage,
  PersistedRowCorruptError,
} from '../../src/contracts/persisted-tool-call.js';

describe('parseToolCallMessage', () => {
  it('rejects legacy {toolCalls:[...]} wrapper as PersistedRowCorruptError(legacy_tool_calls_wrapper)', () => {
    const legacy = { toolCalls: [{ id: 'c1', name: 'emit_planner_result', args: {} }] };
    let caught: unknown;
    try {
      parseToolCallMessage(legacy);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PersistedRowCorruptError);
    expect((caught as PersistedRowCorruptError).code).toBe('legacy_tool_calls_wrapper');
  });

  it('rejects malformed JSON in arguments as PersistedRowCorruptError(invalid_json)', () => {
    const row = {
      role: 'assistant',
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'emit_planner_result', arguments: '{not json' },
        },
      ],
    };
    let caught: unknown;
    try {
      parseToolCallMessage(row);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PersistedRowCorruptError);
    expect((caught as PersistedRowCorruptError).code).toBe('invalid_json');
  });

  it('round-trips a valid tool call through serialize/parse', () => {
    const original = { id: 'call_xyz', name: 'emit_executor_result', args: { card_id: 'c-1', status: 'done', status_text: 'ok' } };
    const row = serializeToolCallMessage(original);
    const parsed = parseToolCallMessage(row);
    expect(parsed).toEqual(original);
  });
});
