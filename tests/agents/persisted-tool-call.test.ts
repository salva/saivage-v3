import { describe, it, expect } from '@jest/globals';
import {
  parseToolCallMessage,
  serializeToolCallMessage,
} from '../../src/agents/persisted-tool-call.js';
import { unwrapFailure } from '../../src/agents/llm-failure.js';

describe('parseToolCallMessage', () => {
  it('rejects legacy {toolCalls:[...]} wrapper as contract_mismatch / legacy_message_shape', () => { // legacy_message_shape: negative-test
    const legacy = { toolCalls: [{ id: 'c1', name: 'emit_planner_result', args: {} }] }; // legacy_message_shape: negative-test
    let caught: unknown;
    try {
      parseToolCallMessage(legacy);
    } catch (err) {
      caught = err;
    }
    const failure = unwrapFailure(caught);
    expect(failure.kind).toBe('contract_mismatch');
    expect(failure).toMatchObject({ kind: 'contract_mismatch', subtype: 'legacy_message_shape' });
  });

  it('rejects malformed JSON in arguments as tool_arguments_invalid_json', () => {
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
    const failure = unwrapFailure(caught);
    expect(failure.kind).toBe('contract_mismatch');
    expect(failure).toMatchObject({ kind: 'contract_mismatch', subtype: 'tool_arguments_invalid_json' });
  });

  it('round-trips a valid tool call through serialize/parse', () => {
    const original = { id: 'call_xyz', name: 'emit_executor_result', args: { card_id: 'c-1', status: 'done', status_text: 'ok' } };
    const row = serializeToolCallMessage(original);
    const parsed = parseToolCallMessage(row);
    expect(parsed).toEqual(original);
  });
});
