import { describe, it, expect } from '@jest/globals';
import { createPlannerContract } from '../../src/contracts/planner-contract.js';

describe('describeTerminals via planner contract', () => {
  const prose = createPlannerContract().describe();

  it('renders a numbered list', () => {
    expect(prose).toMatch(/^1\. `emit_planner_result`/);
    expect(prose).not.toContain('emit_planner_deferred');
  });

  it('includes terminal descriptions and field prose', () => {
    expect(prose).toContain('Emit the planner result envelope');
    expect(prose).not.toContain('deferred_activate_card');
    expect(prose).toContain('object with fields:');
    expect(prose).toContain('status');
  });
});
