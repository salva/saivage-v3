import { describe, expect, it } from '@jest/globals';
import { selectRunningCardChain } from '../../src/runtime/running-card-chain.js';
import type { CardRecord } from '../../src/schemas/index.js';

function card(id: string, parent: string | null, type: CardRecord['type'], status: CardRecord['status']): CardRecord {
  return { id, parent, type, status } as CardRecord;
}

describe('running card restart selection', () => {
  it('selects the unique deepest running leaf', () => {
    const root = card('project', null, 'project', 'running');
    const goal = card('card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'project', 'goal', 'running');
    const code = card('card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbbbbbb', goal.id, 'code', 'running');
    expect(selectRunningCardChain([code, root, goal]).map((entry) => entry.id)).toEqual([root.id, goal.id, code.id]);
  });

  it('rejects disconnected and branching running sets', () => {
    const root = card('project', null, 'project', 'running');
    const left = card('card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'project', 'goal', 'running');
    const right = card('card-bbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'project', 'goal', 'running');
    expect(() => selectRunningCardChain([root, left, right])).toThrow('strict ancestor chain');
    expect(() => selectRunningCardChain([left])).toThrow('no running parent');
  });
});
