import { describe, expect, it } from 'vitest';
import type { CardRecord } from '../api/types';
import { buildTree, selectAvailableTags, selectBoardColumns, selectChildrenOf, selectFilteredCards } from '../stores/card-presentation';

function card(overrides: Partial<CardRecord>): CardRecord {
  return {
    id: overrides.id ?? 'card',
    type: 'code',
    parent: null,
    depth: 0,
    position: 0,
    title: 'Card',
    description: 'Description',
    status: 'active',
    tags: [],
    priority: 1,
    urgency: 'normal',
    created_by: 'user',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    version_seq: 1,
    depends_on: [],
    blocks: [],
    related: [],
    acceptance: '',
    artifacts: [],
    attachments: [],
    retries: 0,
    ...overrides,
    lifecycle: (overrides.lifecycle ?? { status: overrides.status ?? 'active', result: null, error: null, completed_at: null }) as CardRecord['lifecycle'],
  } as CardRecord;
}

describe('card-presentation', () => {
  it('filters and priority-sorts cards without owning fetch state', () => {
    const cards = [
      card({ id: 'low', title: 'Alpha', priority: 1, tags: ['ui'] }),
      card({ id: 'high', title: 'Beta', priority: 9, tags: ['ui'] }),
      card({ id: 'other', title: 'Gamma', priority: 10, tags: ['api'] }),
    ];

    expect(selectFilteredCards(cards, { status: '', type: '', parent: '', tag: 'ui', query: '' }).map((entry) => entry.id)).toEqual(['high', 'low']);
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

  it('selects board columns and available tags as pure projections', () => {
    const cards = [
      card({ id: 'done', status: 'done', tags: ['z', 'a'] }),
      card({ id: 'blocked', status: 'blocked', tags: ['a'] }),
    ];

    expect(selectBoardColumns(cards).get('done')?.map((entry) => entry.id)).toEqual(['done']);
    expect(selectAvailableTags(cards)).toEqual(['a', 'z']);
  });
});
