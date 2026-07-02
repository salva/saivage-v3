import { describe, it, expect } from '@jest/globals';
import { createPlannerContract } from '../../src/contracts/planner-contract.js';

const contract = createPlannerContract();

describe('planner contract', () => {
  it('exposes the planner result terminal', () => {
    expect(contract.terminals.map((t) => t.name)).toEqual(['emit_result']);
    expect(contract.isTerminalToolName('emit_result')).toBe(true);
    expect(contract.isTerminalToolName('emit_planner_deferred')).toBe(false);
    expect(contract.isTerminalToolName('other')).toBe(false);
  });

  it('round-trips emit_result through verify/project', () => {
    const r = contract.verify({
      id: 'tc-1',
      name: 'emit_result',
      args: { status: 'done', summary: 'ok' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const projected = contract.project(r.envelope, r.terminalName);
    expect(projected.kind).toBe('result');
    if (projected.kind !== 'result') return;
    expect(projected.result.status).toBe('done');
    expect(projected.result.summary).toBe('ok');
    expect(projected.result).not.toHaveProperty('created_cards');
    expect(projected.result).not.toHaveProperty('updated_cards');
  });

  it('rejects removed emit_planner_deferred terminal', () => {
    const r = contract.verify({
      id: 'tc-1',
      name: 'emit_planner_deferred',
      args: { kind: 'deferred_activate_card' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violation.code).toBe('terminal_tool_unexpected');
  });

  it('rejects unknown terminal names', () => {
    const r = contract.verify({ id: 'tc-1', name: 'bogus', args: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violation.code).toBe('terminal_tool_unexpected');
    expect(r.violation.locator).toBe('contract:planner');
  });
});
