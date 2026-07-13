import { describe, expect, it, jest } from '@jest/globals';
import {
  AnalystTurnCurrentness,
  McpRevisionCurrentness,
  RootCurrentness,
  createMcpInvocationAuthority,
  type MutationAuthority,
} from '../../src/application/mutation-authority.js';
import { createMutationLane, type McpInvocationAdmission } from '../../src/application/mutation-lane.js';

describe('MutationLane', () => {
  it('applies current authorities synchronously and rejects stale authorities without effects', () => {
    const composition = createMutationLane();
    const roots = new RootCurrentness();
    const root = roots.installRoot();
    const leaf = roots.installLeaf(root);
    const effects: string[] = [];

    expect(composition.lane.apply(leaf, 'current', () => effects.push('current'))).toEqual({ applied: true, value: 1 });
    roots.clearLeaf(leaf);
    expect(composition.lane.apply(leaf, 'stale', () => effects.push('stale'))).toEqual({ applied: false, reason: 'stale' });
    expect(composition.lane.apply(composition.authority, 'composition', () => effects.push('composition'))).toEqual({ applied: true, value: 2 });
    expect(effects).toEqual(['current', 'composition']);
  });

  it('fails fast for foreign authority, recursion, and a thenable callback', () => {
    const composition = createMutationLane();
    const mutation = jest.fn(() => undefined);
    expect(() => composition.lane.apply({ kind: 'composition' } as MutationAuthority, 'foreign', mutation)).toThrow(/foreign or invalid/);
    expect(mutation).not.toHaveBeenCalled();
    expect(() => composition.lane.apply(composition.authority, 'outer', () => composition.lane.apply(composition.authority, 'inner', () => undefined))).toThrow(/Recursive/);
    expect(() => composition.lane.apply(composition.authority, 'async', (() => Promise.resolve()) as () => never)).toThrow(/synchronous/);
  });

  it('delivers MCP results only while caller and revision are exact-current and admitted', () => {
    let admission: McpInvocationAdmission = 'analyst';
    const composition = createMutationLane(() => admission);
    const analyst = new AnalystTurnCurrentness();
    const turn = analyst.begin();
    const revisions = new McpRevisionCurrentness();
    const revision = revisions.install('workspace');
    const invocation = createMcpInvocationAuthority({ kind: 'analyst', authority: turn }, revision);
    const effect = jest.fn(() => 'persisted');

    expect(composition.lane.deliverMcpToolResult(invocation, 'tool result', effect)).toEqual({ kind: 'delivered', value: 'persisted' });
    admission = 'autonomous';
    expect(composition.lane.deliverMcpToolResult(invocation, 'wrong mode', effect)).toEqual({ kind: 'stale_delivery' });
    admission = 'analyst';
    revisions.install('workspace');
    expect(composition.lane.deliverMcpToolResult(invocation, 'old revision', effect)).toEqual({ kind: 'stale_delivery' });
    expect(effect).toHaveBeenCalledTimes(1);
  });
});
