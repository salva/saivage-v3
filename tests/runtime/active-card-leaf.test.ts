import { describe, expect, it } from '@jest/globals';

import { ActiveCardLeaf } from '../../src/runtime/active-card-leaf.js';

describe('ActiveCardLeaf', () => {
  it('tracks only the scheduler leaf while entering and resuming a child', () => {
    const leaf = new ActiveCardLeaf();
    leaf.startRoot('project');
    leaf.enterChild('project', '11111111-1111-4111-8111-111111111111');
    expect(leaf.activeCardId()).toBe('11111111-1111-4111-8111-111111111111');
    leaf.resumeParent('11111111-1111-4111-8111-111111111111', 'project');
    expect(leaf.activeCardId()).toBe('project');
    leaf.clear();
    expect(leaf.activeCardId()).toBeNull();
  });

  it('fails when a transition does not originate at the active leaf', () => {
    const leaf = new ActiveCardLeaf();
    leaf.startRoot('project');
    expect(() => leaf.enterChild('22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333')).toThrow('not the current autonomous leaf');
  });
});
