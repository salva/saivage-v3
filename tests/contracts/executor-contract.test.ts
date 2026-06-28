import { describe, it, expect } from '@jest/globals';
import { createExecutorContract } from '../../src/contracts/executor-contract.js';

const contract = createExecutorContract();

describe('executor contract', () => {
  it('exposes single terminal emit_executor_result', () => {
    expect(contract.terminals.map((t) => t.name)).toEqual(['emit_executor_result']);
    expect(contract.isTerminalToolName('emit_executor_result')).toBe(true);
    expect(contract.isTerminalToolName('other')).toBe(false);
  });

  it('projects envelope including default card_id and null fallback_with_evidence', () => {
    const r = contract.verify({
      id: 'tc-1',
      name: 'emit_executor_result',
      args: { status: 'done', status_text: 'ok' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const result = contract.project(r.envelope, r.terminalName);
    expect(result.card_id).toBe('');
    expect(result.status).toBe('done');
    expect(result.status_text).toBe('ok');
    expect(result.fallback_with_evidence).toBeNull();
  });

  it('rejects unknown terminal names', () => {
    const r = contract.verify({ id: 'tc-1', name: 'bogus', args: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violation.code).toBe('terminal_tool_unexpected');
    expect(r.violation.locator).toBe('contract:executor');
  });
});
