import { describe, it, expect } from '@jest/globals';
import { validateTerminalToolCall } from '../../src/agents/terminal-protocol.js';
import { unwrapFailure } from '../../src/agents/llm-failure.js';

describe('validateTerminalToolCall', () => {
  it('missing call ⇒ contract_mismatch / terminal_tool_missing', () => {
    let caught: unknown;
    try {
      validateTerminalToolCall(undefined, 'planner');
    } catch (err) {
      caught = err;
    }
    const failure = unwrapFailure(caught);
    expect(failure).toMatchObject({ kind: 'contract_mismatch', subtype: 'terminal_tool_missing' });
  });

  it('wrong tool name ⇒ contract_mismatch / terminal_tool_unexpected', () => {
    let caught: unknown;
    try {
      validateTerminalToolCall({ id: 'c1', name: 'emit_reviewer_result', args: {} }, 'planner');
    } catch (err) {
      caught = err;
    }
    const failure = unwrapFailure(caught);
    expect(failure).toMatchObject({ kind: 'contract_mismatch', subtype: 'terminal_tool_unexpected' });
  });

  it('valid name but invalid args ⇒ contract_mismatch / tool_arguments_schema_violation', () => {
    let caught: unknown;
    try {
      validateTerminalToolCall(
        { id: 'c1', name: 'emit_planner_result', args: { status: 'not_a_valid_enum' } },
        'planner',
      );
    } catch (err) {
      caught = err;
    }
    const failure = unwrapFailure(caught);
    expect(failure).toMatchObject({ kind: 'contract_mismatch', subtype: 'tool_arguments_schema_violation' });
  });

  it('valid name and valid args returns parsed object', () => {
    const result = validateTerminalToolCall(
      {
        id: 'c1',
        name: 'emit_executor_result',
        args: { card_id: 'c-1', status: 'done', status_text: 'ok' },
      },
      'executor',
    );
    expect(result).toMatchObject({ card_id: 'c-1', status: 'done', status_text: 'ok' });
  });
});
