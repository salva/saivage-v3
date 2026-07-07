import { describe, expect, it } from 'vitest';
import type { CardRecord } from '../api/types';
import { applyCardFilters, buildTree, selectChildrenOf } from '../stores/cards';

function card(overrides: Partial<CardRecord>): CardRecord {
  return {
    id: overrides.id ?? 'card',
    type: 'code',
    parent: null,
    depth: 0,
    position: 0,
    title: 'Card',
    status: 'running',
    tags: [],
    priority: 1,
    urgency: 'normal',
    created_by: 'user',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    version_seq: 1,
    depends_on: [],
    related: [],
    retries: 0,
    ...overrides,
    lifecycle: (overrides.lifecycle ?? { status: overrides.status ?? 'running', result: null, error: null, completed_at: null }) as CardRecord['lifecycle'],
  } as CardRecord;
}

describe('card selectors', () => {
  it('filters cards without owning fetch state', () => {
    const cards = [
      card({ id: 'low', title: 'Alpha', priority: 1, tags: ['ui'] }),
      card({ id: 'high', title: 'Beta', priority: 9, tags: ['ui'] }),
      card({ id: 'other', title: 'Gamma', priority: 10, tags: ['api'] }),
    ];

    expect(applyCardFilters(cards, { status: '', type: '', query: 'a' }).map((entry) => entry.id)).toEqual(['low', 'high', 'other']);
  });

  it('builds trees and ordered child projections from authoritative card records', () => {
    const cards = [
      card({ id: 'root', type: 'project', position: 0 }),
      card({ id: 'child-b', parent: 'root', position: 2 }),
      card({ id: 'child-a', parent: 'root', position: 1 }),
    ];

    expect((buildTree(cards)[0].children ?? []).map((entry) => entry.id)).toEqual(['child-b', 'child-a']);
    expect(selectChildrenOf(cards, 'root').map((entry) => entry.id)).toEqual(['child-a', 'child-b']);
  });
});
