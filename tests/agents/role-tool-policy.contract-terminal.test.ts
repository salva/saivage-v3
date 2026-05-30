import { describe, expect, it } from '@jest/globals';

import { RoleToolPolicy } from '../../src/agents/role-tool-policy.js';

describe('RoleToolPolicy contract-terminal surface', () => {
  it('allows a tool name listed in contractTerminals', () => {
    const decision = RoleToolPolicy.decide({
      role: 'planner',
      action: 'invoke',
      surface: 'contract-terminal',
      toolName: 'emit_planner_result',
      contractTerminals: ['emit_planner_result'],
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reasonCode).toBe('allowed');
  });

  it('denies a tool name not listed in contractTerminals', () => {
    const decision = RoleToolPolicy.decide({
      role: 'planner',
      action: 'invoke',
      surface: 'contract-terminal',
      toolName: 'emit_executor_result',
      contractTerminals: ['emit_planner_result'],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe('unknown_tool');
  });

  it('denies when contractTerminals is empty or missing', () => {
    const empty = RoleToolPolicy.decide({
      role: 'executor',
      action: 'invoke',
      surface: 'contract-terminal',
      toolName: 'emit_executor_result',
      contractTerminals: [],
    });
    expect(empty.allowed).toBe(false);
    expect(empty.reasonCode).toBe('unknown_tool');

    const missing = RoleToolPolicy.decide({
      role: 'executor',
      action: 'invoke',
      surface: 'contract-terminal',
      toolName: 'emit_executor_result',
    });
    expect(missing.allowed).toBe(false);
    expect(missing.reasonCode).toBe('unknown_tool');
  });

  it('denies an unknown role on the contract-terminal surface', () => {
    const decision = RoleToolPolicy.decide({
      role: 'nobody' as never,
      action: 'invoke',
      surface: 'contract-terminal',
      toolName: 'emit_planner_result',
      contractTerminals: ['emit_planner_result'],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe('unknown_role');
  });
});
