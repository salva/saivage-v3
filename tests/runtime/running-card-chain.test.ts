import { describe, expect, it } from '@jest/globals';
import { selectLinkedRunningChain } from '../../src/runtime/running-card-chain.js';
import type { CardRecord } from '../../src/schemas/index.js';

function card(id: string, type: CardRecord['type'], status: 'running' | 'stopped', children: string[] = []): CardRecord {
  return { id, type, children, title: id, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: '2026-07-20T00:00:00.000Z', updated_at: '2026-07-20T00:00:00.000Z', version_seq: 1, depends_on: [], related: [], lifecycle: { status, result: null, error: null, completed_at: null }, pending_notifications: [] };
}

describe('running card restart selection', () => {
  it('selects the unique deepest running leaf', () => {
    const code = card('card-a-b', 'code', 'running');
    const goal = card('card-a', 'goal', 'running', [code.id]);
    const root = card('project', 'project', 'running', [goal.id]);
    expect(selectLinkedRunningChain(reader([code, root, goal])).map((entry) => entry.id)).toEqual([root.id, goal.id, code.id]);
  });

  it('rejects disconnected and branching running sets', () => {
    const left = card('card-a', 'goal', 'running');
    const right = card('card-b', 'goal', 'running');
    const root = card('project', 'project', 'running', [left.id, right.id]);
    expect(() => selectLinkedRunningChain(reader([root, left, right]))).toThrow('more than one running direct child');
  });

  it('excludes stopped linked history from active chain membership', () => {
    const stopped = card('card-a', 'goal', 'stopped');
    const root = card('project', 'project', 'running', [stopped.id]);
    expect(selectLinkedRunningChain(reader([root, stopped])).map((entry) => entry.id)).toEqual(['project']);
    expect(selectLinkedRunningChain(reader([card('project', 'project', 'stopped', [stopped.id]), stopped]))).toEqual([]);
  });
});

function reader(cards: readonly CardRecord[]) {
  const byId = new Map(cards.map((entry) => [entry.id, entry]));
  return { read: (id: string) => byId.get(id) ?? null, listChildren: (id: string) => byId.get(id)?.children ?? [] };
}
