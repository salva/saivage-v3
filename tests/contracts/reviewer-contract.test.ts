import { describe, it, expect } from '@jest/globals';
import { createReviewerContract } from '../../src/contracts/reviewer-contract.js';

const contract = createReviewerContract({ goalId: 'g1', assessmentId: 'a1' });

describe('reviewer contract', () => {
  it('exposes single terminal emit_reviewer_result', () => {
    expect(contract.terminals.map((t) => t.name)).toEqual(['emit_reviewer_result']);
    expect(contract.isTerminalToolName('emit_reviewer_result')).toBe(true);
    expect(contract.isTerminalToolName('other')).toBe(false);
  });

  it('passes assessment straight through projection', () => {
    const assessment = {
      result: 'pass' as const,
      summary: 'looks good',
      achieved: ['x'],
      issues: [],
      evidence_card_ids: ['c1'],
    };
    const r = contract.verify({
      id: 'tc-1',
      name: 'emit_reviewer_result',
      args: { assessment },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const projected = contract.project(r.envelope, r.terminalName);
    expect(projected.assessment).toEqual(assessment);
  });

  it('rejects unknown terminal names', () => {
    const r = contract.verify({ id: 'tc-1', name: 'bogus', args: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violation.code).toBe('terminal_tool_unexpected');
    expect(r.violation.locator).toBe('contract:reviewer');
  });
});
