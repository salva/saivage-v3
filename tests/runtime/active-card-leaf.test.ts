import { describe, expect, it } from '@jest/globals';

import { ActiveCardLeaf } from '../../src/runtime/active-card-leaf.js';

describe('ActiveCardLeaf', () => {
  it('publishes exact post-mutation leaves while setting, entering, resuming, and clearing', () => {
    const snapshots: Array<string | null> = [];
    let leaf!: ActiveCardLeaf;
    leaf = new ActiveCardLeaf(() => snapshots.push(leaf.activeCardId()));
    leaf.setChain(['project']);
    leaf.enterChild('project', '11111111-1111-4111-8111-111111111111');
    leaf.resumeParent('11111111-1111-4111-8111-111111111111', 'project');
    leaf.clear();
    expect(leaf.activeCardId()).toBeNull();
    expect(snapshots).toEqual(['project', '11111111-1111-4111-8111-111111111111', 'project', null]);
  });

  it('is silent for the same leaf and fails before publication for invalid transitions', () => {
    const snapshots: Array<string | null> = [];
    let leaf!: ActiveCardLeaf;
    leaf = new ActiveCardLeaf(() => snapshots.push(leaf.activeCardId()));
    expect(() => leaf.setChain([])).toThrow('must begin at project');
    expect(() => leaf.setChain(['wrong'])).toThrow('must begin at project');
    leaf.setChain(['project']);
    leaf.setChain(['project']);
    expect(() => leaf.enterChild('22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333')).toThrow('not the current autonomous leaf');
    expect(snapshots).toEqual(['project']);
  });

  it('allows a chain replacement without an intermediate null and rejects clearing null', () => {
    const snapshots: Array<string | null> = [];
    let leaf!: ActiveCardLeaf;
    leaf = new ActiveCardLeaf(() => snapshots.push(leaf.activeCardId()));
    leaf.setChain(['project', '11111111-1111-4111-8111-111111111111']);
    leaf.setChain(['project', '22222222-2222-4222-8222-222222222222']);
    leaf.clear();
    expect(() => leaf.clear()).toThrow('no active leaf');
    expect(snapshots).toEqual(['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', null]);
  });
});
