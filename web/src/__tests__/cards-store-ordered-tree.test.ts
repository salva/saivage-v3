import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { CardRecord } from '../api/types';

vi.mock('../api/client', () => ({
  listCards: vi.fn(), getCard: vi.fn(),
  listCardHistory: vi.fn(), getCardHistoryEntry: vi.fn(), getCardDiff: vi.fn(),
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.status = status; this.body = body; } get isUnauthorized() { return this.status === 401; } get isNotFound() { return this.status === 404; } },
}));
import { useCardStore } from '../stores/cards';

function card(overrides: Partial<CardRecord>): CardRecord {
  return {
    id: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', type: 'code', parent: null, depth: 0, position: 0, children: [], title: 'Card', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', version_seq: 1, depends_on: [], related: [], pending_notifications: [], logical_path: null, ...overrides,
    lifecycle: (overrides.lifecycle ?? { status: overrides.status ?? 'backlog', result: null, error: null, completed_at: null }) as CardRecord['lifecycle'],
  } as CardRecord;
}

describe('useCardStore ordered tree', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('preserves backend sibling order in orderedCardTree', () => {
    const store = useCardStore();
    const childIds = [
      'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'card-bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'card-cccccccccccccccccccccccccccc',
    ];
    const root = card({ id: 'project', type: 'project', title: 'Project', parent: null, children: childIds });
    const backendFirst = card({ id: childIds[0], title: 'Backend first', parent: 'project', priority: 1, updated_at: '2025-01-01T00:00:00Z' });
    const backendSecond = card({ id: childIds[1], title: 'Backend second', parent: 'project', priority: 5, updated_at: '2025-01-02T00:00:00Z' });
    const backendThird = card({ id: childIds[2], title: 'Backend third', parent: 'project', priority: 10, updated_at: '2025-01-03T00:00:00Z' });
    store.cards = [root, backendFirst, backendSecond, backendThird];

    expect(store.orderedCardTree.map((node) => node.card.id)).toEqual(['project']);
    expect(store.orderedCardTree[0]?.childNodes.map((node) => node.card.id)).toEqual(childIds);
    expect(store.cards.filter((card) => card.parent === 'project').map((card) => card.id)).toEqual(childIds);
  });
});
