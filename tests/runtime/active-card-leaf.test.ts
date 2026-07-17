import { describe, expect, it } from '@jest/globals';

import { ActiveCardLeaf } from '../../src/runtime/active-card-leaf.js';

describe('ActiveCardLeaf', () => {
  it('publishes exact post-mutation leaves while setting, entering, resuming, and clearing', () => {
    const snapshots: Array<string | null> = [];
    let leaf!: ActiveCardLeaf;
    leaf = new ActiveCardLeaf(() => snapshots.push(leaf.activeCardId()));
    leaf.setChain(['project']);
    leaf.enterChild('project', 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    leaf.resumeParent('card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'project');
    leaf.clear();
    expect(leaf.activeCardId()).toBeNull();
    expect(snapshots).toEqual(['project', 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'project', null]);
  });

  it('is silent for the same leaf and fails before publication for invalid transitions', () => {
    const snapshots: Array<string | null> = [];
    let leaf!: ActiveCardLeaf;
    leaf = new ActiveCardLeaf(() => snapshots.push(leaf.activeCardId()));
    expect(() => leaf.setChain([])).toThrow('must begin at project');
    expect(() => leaf.setChain(['wrong'])).toThrow('must begin at project');
    leaf.setChain(['project']);
    leaf.setChain(['project']);
    expect(() => leaf.enterChild('card-bbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'card-cccccccccccccccccccccccccccc')).toThrow('not the current autonomous leaf');
    expect(snapshots).toEqual(['project']);
  });

  it('allows a chain replacement without an intermediate null and rejects clearing null', () => {
    const snapshots: Array<string | null> = [];
    let leaf!: ActiveCardLeaf;
    leaf = new ActiveCardLeaf(() => snapshots.push(leaf.activeCardId()));
    leaf.setChain(['project', 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
    leaf.setChain(['project', 'card-bbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
    leaf.clear();
    expect(() => leaf.clear()).toThrow('no active leaf');
    expect(snapshots).toEqual(['card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'card-bbbbbbbbbbbbbbbbbbbbbbbbbbbb', null]);
  });
});
