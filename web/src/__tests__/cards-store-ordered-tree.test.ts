import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { CardRecord } from '../api/types';
type CardTreeNode = CardRecord & { children?: CardTreeNode[] };

vi.mock('../api/client', () => ({
  listCards: vi.fn(), getCard: vi.fn(),
  listCardHistory: vi.fn(), getCardHistoryEntry: vi.fn(), getCardDiff: vi.fn(),
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.status = status; this.body = body; } get isUnauthorized() { return this.status === 401; } get isNotFound() { return this.status === 404; } },
}));
vi.mock('../stores/ws', () => ({ useWsStore: () => ({ onType: vi.fn(() => vi.fn()) }) }));

import { useCardStore } from '../stores/cards';

function card(overrides: Partial<CardRecord>): CardRecord {
  return {
    id: 'card', type: 'code', parent: null, depth: 0, position: 0, title: 'Card', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', version_seq: 1, depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0,
    ...overrides,
  };
}

describe('useCardStore ordered tree', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('preserves backend sibling order in orderedCardTree while cardTree keeps priority sorting', () => {
    const store = useCardStore();
    const root = card({ id: 'project', type: 'project', title: 'Project', parent: null });
    const backendFirst = card({ id: 'child-low', title: 'Backend first', parent: 'project', priority: 1, updated_at: '2025-01-01T00:00:00Z' });
    const backendSecond = card({ id: 'child-mid', title: 'Backend second', parent: 'project', priority: 5, updated_at: '2025-01-02T00:00:00Z' });
    const backendThird = card({ id: 'child-high', title: 'Backend third', parent: 'project', priority: 10, updated_at: '2025-01-03T00:00:00Z' });
    store.cards = [root, backendFirst, backendSecond, backendThird];

    const orderedRoot = store.orderedCardTree[0] as CardTreeNode;
    const sortedRoot = store.cardTree[0] as CardTreeNode;
    expect(orderedRoot.children?.map((child: CardTreeNode) => child.id)).toEqual(['child-low', 'child-mid', 'child-high']);
    expect(orderedRoot.children?.map((child: CardTreeNode) => child.id)).not.toEqual(['child-high', 'child-mid', 'child-low']);
    expect(sortedRoot.children?.map((child: CardTreeNode) => child.id)).toEqual(['child-high', 'child-mid', 'child-low']);
  });
});
