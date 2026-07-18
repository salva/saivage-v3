import { describe, expect, it } from '@jest/globals';
import { selectLinkedRunningChain } from '../../src/runtime/running-card-chain.js';
import type { CardRecord } from '../../src/schemas/index.js';

function card(id: string, parent: string | null, type: CardRecord['type'], status: CardRecord['status']): CardRecord {
  return { id, parent, type, status } as CardRecord;
}

describe('running card restart selection', () => {
  it('selects the unique deepest running leaf', () => {
    const root = card('project', null, 'project', 'running');
    const goal = card('card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'project', 'goal', 'running');
    const code = card('card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbbbbbb', goal.id, 'code', 'running');
    expect(selectLinkedRunningChain(reader([code, root, goal])).map((entry) => entry.id)).toEqual([root.id, goal.id, code.id]);
  });

  it('rejects disconnected and branching running sets', () => {
    const root = card('project', null, 'project', 'running');
    const left = card('card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'project', 'goal', 'running');
    const right = card('card-bbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'project', 'goal', 'running');
    expect(() => selectLinkedRunningChain(reader([root, left, right]))).toThrow('more than one running direct child');
  });

  it('excludes stopped linked history from active chain membership', () => {
    const root = card('project', null, 'project', 'running');
    const stopped = card('card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'project', 'goal', 'stopped');
    expect(selectLinkedRunningChain(reader([root, stopped])).map((entry) => entry.id)).toEqual(['project']);
    expect(selectLinkedRunningChain(reader([card('project', null, 'project', 'stopped'), stopped]))).toEqual([]);
  });
});

function reader(cards: readonly CardRecord[]) {
  const byId = new Map(cards.map((entry) => [entry.id, entry]));
  return { read: (id: string) => byId.get(id) ?? null, listChildren: (id: string) => cards.filter((entry) => entry.parent === id).map((entry) => entry.id) };
}
