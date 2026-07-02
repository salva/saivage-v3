import { describe, it, expect } from '@jest/globals';
import { createExecutorContract } from '../../src/contracts/executor-contract.js';

const contract = createExecutorContract();

describe('executor contract', () => {
  it('exposes single terminal emit_result', () => {
    expect(contract.terminals.map((t) => t.name)).toEqual(['emit_result']);
    expect(contract.isTerminalToolName('emit_result')).toBe(true);
    expect(contract.isTerminalToolName('other')).toBe(false);
  });

  it('projects the common executor result envelope', () => {
    const r = contract.verify({
      id: 'tc-1',
      name: 'emit_result',
      args: { status: 'done', summary: 'ok' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const result = contract.project(r.envelope, r.terminalName);
    expect(result.status).toBe('done');
    expect(result.summary).toBe('ok');
  });

  it('rejects unknown terminal names', () => {
    const r = contract.verify({ id: 'tc-1', name: 'bogus', args: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violation.code).toBe('terminal_tool_unexpected');
    expect(r.violation.locator).toBe('contract:executor');
  });
});
