import { describe, expect, it } from '@jest/globals';

import { isAuthorityCurrent } from '../../src/application/mutation-authority.js';
import { AutonomousCardCurrentness } from '../../src/runtime/card-currentness.js';

describe('AutonomousCardCurrentness', () => {
  it('admits exactly one root-to-leaf card owner and issues a fresh parent leaf after child settlement', () => {
    const currentness = new AutonomousCardCurrentness();
    const root = currentness.startRoot('project');
    const firstRootLeaf = root.current();

    const child = currentness.enterChild('project', 'child');
    const childLeaf = child.current();
    expect(isAuthorityCurrent(firstRootLeaf)).toBe(false);
    expect(() => root.current()).toThrow(/does not own the current autonomous leaf/);

    currentness.resumeParent('child', 'project');
    const resumedRootLeaf = root.current();
    expect(isAuthorityCurrent(childLeaf)).toBe(false);
    expect(resumedRootLeaf.leaf).not.toBe(firstRootLeaf.leaf);
    expect(() => child.current()).toThrow(/does not own the current autonomous leaf/);
  });

  it('revokes root and leaf together on clear', () => {
    const currentness = new AutonomousCardCurrentness();
    const root = currentness.startRoot('project');
    const authority = root.current();
    currentness.clear();
    expect(isAuthorityCurrent(authority)).toBe(false);
    expect(() => root.current()).toThrow(/does not own/);
  });
});
