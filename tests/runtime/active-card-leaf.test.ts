import { describe, expect, it } from '@jest/globals';

import { ActiveCardLeaf } from '../../src/runtime/active-card-leaf.js';

describe('ActiveCardLeaf', () => {
  it('tracks only the scheduler leaf while entering and resuming a child', () => {
    const leaf = new ActiveCardLeaf();
    leaf.startRoot('project');
    leaf.enterChild('project', 'card-1');
    expect(leaf.activeCardId()).toBe('card-1');
    leaf.resumeParent('card-1', 'project');
    expect(leaf.activeCardId()).toBe('project');
    leaf.clear();
    expect(leaf.activeCardId()).toBeNull();
  });

  it('fails when a transition does not originate at the active leaf', () => {
    const leaf = new ActiveCardLeaf();
    leaf.startRoot('project');
    expect(() => leaf.enterChild('card-2', 'card-3')).toThrow('not the current autonomous leaf');
  });
});
