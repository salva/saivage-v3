import { describe, it, expect } from '@jest/globals';
import { createPlannerContract } from '../../src/contracts/planner-contract.js';
import { createDeferredActivationEnvelope } from '../../src/schemas/index.js';

const contract = createPlannerContract({ goalId: 'g1', parentSessionId: 's1' });

describe('planner contract', () => {
  it('exposes two terminals', () => {
    expect(contract.terminals.map((t) => t.name)).toEqual([
      'emit_planner_result',
      'emit_planner_deferred',
    ]);
    expect(contract.isTerminalToolName('emit_planner_result')).toBe(true);
    expect(contract.isTerminalToolName('emit_planner_deferred')).toBe(true);
    expect(contract.isTerminalToolName('other')).toBe(false);
  });

  it('round-trips emit_planner_result through verify/project', () => {
    const r = contract.verify({
      id: 'tc-1',
      name: 'emit_planner_result',
      args: { status: 'continue', summary: 'ok' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const projected = contract.project(r.envelope, r.terminalName);
    expect(projected.kind).toBe('result');
    if (projected.kind !== 'result') return;
    expect(projected.result.status).toBe('continue');
    expect(projected.result.summary).toBe('ok');
    expect(projected.result.created_cards).toEqual([]);
    expect(projected.result.updated_cards).toEqual([]);
  });

  it('round-trips emit_planner_deferred and surfaces activation', () => {
    const envelope = createDeferredActivationEnvelope({
      parent_card_id: 'p1',
      child_card_id: 'c2',
      planner_session_id: 's1',
      tool_call_id: 'tc-1',
      requested_at: '2026-01-01T00:00:00.000Z',
    });
    const r = contract.verify({
      id: 'tc-1',
      name: 'emit_planner_deferred',
      args: envelope as unknown as Record<string, unknown>,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const projected = contract.project(r.envelope, r.terminalName);
    expect(projected.kind).toBe('deferred');
    if (projected.kind !== 'deferred') return;
    expect(projected.activations).toEqual([envelope]);
    expect(projected.result.status).toBe('continue');
    expect(projected.result.summary).toContain('c2');
  });

  it('rejects unknown terminal names', () => {
    const r = contract.verify({ id: 'tc-1', name: 'bogus', args: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violation.code).toBe('terminal_tool_unexpected');
    expect(r.violation.locator).toBe('contract:planner');
  });
});
