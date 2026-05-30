import { describe, it, expect } from '@jest/globals';
import { validateTerminalToolCall } from '../../src/agents/terminal-protocol.js';
import { unwrapFailure } from '../../src/agents/llm-failure.js';

describe('validateTerminalToolCall', () => {
  it('missing call ⇒ provider_protocol_error (terminal tool missing)', () => {
    let caught: unknown;
    try {
      validateTerminalToolCall(undefined, 'planner');
    } catch (err) {
      caught = err;
    }
    const failure = unwrapFailure(caught);
    expect(failure.kind).toBe('provider_protocol_error');
    expect(failure.message).toMatch(/terminal tool call missing/);
  });

  it('wrong tool name ⇒ provider_protocol_error (terminal tool unexpected)', () => {
    let caught: unknown;
    try {
      validateTerminalToolCall({ id: 'c1', name: 'emit_reviewer_result', args: {} }, 'planner');
    } catch (err) {
      caught = err;
    }
    const failure = unwrapFailure(caught);
    expect(failure.kind).toBe('provider_protocol_error');
    expect(failure.message).toMatch(/unexpected name/);
  });

  it('valid name but invalid args ⇒ provider_protocol_error (schema violation)', () => {
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
    expect(failure.kind).toBe('provider_protocol_error');
    expect(failure.message).toMatch(/failed schema validation/);
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
