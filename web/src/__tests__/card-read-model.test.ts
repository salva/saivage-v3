import { describe, expect, it } from 'vitest';
import type { CardRecord } from '../api/types';
import { applyCardFilters, buildTree, selectChildrenOf } from '../stores/cards';

function card(overrides: Partial<CardRecord>): CardRecord {
  return {
    id: overrides.id ?? '11111111-1111-4111-8111-111111111111',
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
    pending_notifications: [],
    ...overrides,
    lifecycle: (overrides.lifecycle ?? { status: overrides.status ?? 'running', result: null, error: null, completed_at: null }) as CardRecord['lifecycle'],
  } as CardRecord;
}

describe('card selectors', () => {
  it('filters cards without owning fetch state', () => {
    const cards = [
      card({ id: '11111111-1111-4111-8111-111111111111', title: 'Alpha', priority: 1, tags: ['ui'] }),
      card({ id: '22222222-2222-4222-8222-222222222222', title: 'Beta', priority: 9, tags: ['ui'] }),
      card({ id: '33333333-3333-4333-8333-333333333333', title: 'Gamma', priority: 10, tags: ['api'] }),
    ];

    expect(applyCardFilters(cards, { status: '', type: '', query: 'a' }).map((entry) => entry.id)).toEqual(['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']);
  });

  it('builds trees and ordered child projections from authoritative card records', () => {
    const cards = [
      card({ id: 'project', type: 'project', position: 0 }),
      card({ id: '22222222-2222-4222-8222-222222222222', parent: 'project', position: 2 }),
      card({ id: '11111111-1111-4111-8111-111111111111', parent: 'project', position: 1 }),
    ];

    expect((buildTree(cards)[0].children ?? []).map((entry) => entry.id)).toEqual(['22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111']);
    expect(selectChildrenOf(cards, 'project').map((entry) => entry.id)).toEqual(['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']);
  });
});
