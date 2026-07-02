import { describe, it, expect } from '@jest/globals';
import { createReviewerContract } from '../../src/contracts/reviewer-contract.js';

const contract = createReviewerContract();

describe('reviewer contract', () => {
  it('exposes single terminal emit_result', () => {
    expect(contract.terminals.map((t) => t.name)).toEqual(['emit_result']);
    expect(contract.isTerminalToolName('emit_result')).toBe(true);
    expect(contract.isTerminalToolName('other')).toBe(false);
  });

  it('projects the common reviewer result envelope', () => {
    const r = contract.verify({
      id: 'tc-1',
      name: 'emit_result',
      args: { status: 'rework', summary: 'needs changes' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const projected = contract.project(r.envelope, r.terminalName);
    expect(projected).toEqual({ status: 'rework', summary: 'needs changes' });
  });

  it('rejects unknown terminal names', () => {
    const r = contract.verify({ id: 'tc-1', name: 'bogus', args: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violation.code).toBe('terminal_tool_unexpected');
    expect(r.violation.locator).toBe('contract:reviewer');
  });
});
