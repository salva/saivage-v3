import { createPinia, setActivePinia } from 'pinia';
import { describe, expect, it, vi } from 'vitest';
import type { CardRecord } from '../api/types';
import { useCardBrowserReadModel } from '../composables/useCardBrowserReadModel';
import { buildTree, selectChildrenOf } from '../stores/cards';
import { useCardStore } from '../stores/cards';

function card(overrides: Partial<CardRecord>): CardRecord {
  return {
    id: overrides.id ?? '11111111-1111-4111-8111-111111111111',
    type: 'code',
    parent: null,
    depth: 0,
    position: 0,
    children: [],
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
    logical_path: null,
    ...overrides,
    lifecycle: (overrides.lifecycle ?? { status: overrides.status ?? 'running', result: null, error: null, completed_at: null }) as CardRecord['lifecycle'],
  } as CardRecord;
}

describe('card selectors', () => {
  it('builds trees and ordered child projections from authoritative card records', () => {
    const cards = [
      card({ id: 'project', type: 'project', position: 0 }),
      card({ id: '22222222-2222-4222-8222-222222222222', parent: 'project', position: 2 }),
      card({ id: '11111111-1111-4111-8111-111111111111', parent: 'project', position: 1 }),
    ];

    expect(buildTree(cards).map((entry) => entry.card.id)).toEqual(['project']);
    expect(selectChildrenOf(cards, 'project').map((entry) => entry.id)).toEqual(['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']);
  });

  it('derives late project expansion and preserves explicit collapse across canonical refreshes without fetching', () => {
    setActivePinia(createPinia());
    const store = useCardStore();
    const fetchCards = vi.spyOn(store, 'fetchCards');
    const model = useCardBrowserReadModel(store);

    expect(model.effectiveExpandedTreeIds.value).toEqual(new Set());
    store.cards = [card({ id: 'project', type: 'project' })];
    expect(model.effectiveExpandedTreeIds.value).toEqual(new Set(['project']));

    model.toggleTreeNode('project');
    expect(model.effectiveExpandedTreeIds.value).toEqual(new Set());
    store.cards = [card({ id: 'project', type: 'project', title: 'Refreshed project' })];
    expect(model.effectiveExpandedTreeIds.value).toEqual(new Set());

    model.toggleTreeNode('project');
    expect(model.effectiveExpandedTreeIds.value).toEqual(new Set(['project']));
    expect(fetchCards).not.toHaveBeenCalled();
  });
});
