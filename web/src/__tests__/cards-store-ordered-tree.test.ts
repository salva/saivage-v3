import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { CardRecord } from '../api/types';
type CardTreeNode = CardRecord & { children?: CardTreeNode[] };

vi.mock('../api/client', () => ({
  listCards: vi.fn(), getCard: vi.fn(),
  listCardHistory: vi.fn(), getCardHistoryEntry: vi.fn(), getCardDiff: vi.fn(),
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.status = status; this.body = body; } get isUnauthorized() { return this.status === 401; } get isNotFound() { return this.status === 404; } },
}));
import { useCardStore } from '../stores/cards';

function card(overrides: Partial<CardRecord>): CardRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111', type: 'code', parent: null, depth: 0, position: 0, title: 'Card', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', version_seq: 1, depends_on: [], related: [], pending_notifications: [], ...overrides,
    lifecycle: (overrides.lifecycle ?? { status: overrides.status ?? 'backlog', result: null, error: null, completed_at: null }) as CardRecord['lifecycle'],
  } as CardRecord;
}

describe('useCardStore ordered tree', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('preserves backend sibling order in orderedCardTree', () => {
    const store = useCardStore();
    const root = card({ id: 'project', type: 'project', title: 'Project', parent: null });
    const backendFirst = card({ id: '11111111-1111-4111-8111-111111111111', title: 'Backend first', parent: 'project', priority: 1, updated_at: '2025-01-01T00:00:00Z' });
    const backendSecond = card({ id: '22222222-2222-4222-8222-222222222222', title: 'Backend second', parent: 'project', priority: 5, updated_at: '2025-01-02T00:00:00Z' });
    const backendThird = card({ id: '33333333-3333-4333-8333-333333333333', title: 'Backend third', parent: 'project', priority: 10, updated_at: '2025-01-03T00:00:00Z' });
    store.cards = [root, backendFirst, backendSecond, backendThird];

    const orderedRoot = store.orderedCardTree[0] as CardTreeNode;
    expect(orderedRoot.children?.map((child: CardTreeNode) => child.id)).toEqual(['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']);
    expect(orderedRoot.children?.map((child: CardTreeNode) => child.id)).not.toEqual(['33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111']);
  });
});
