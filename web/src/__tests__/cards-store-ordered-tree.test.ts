import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('../api/client', () => ({
  listCards: vi.fn(), getCard: vi.fn(),
  listCardHistory: vi.fn(), getCardHistoryEntry: vi.fn(), getCardDiff: vi.fn(),
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.status = status; this.body = body; } get isUnauthorized() { return this.status === 401; } get isNotFound() { return this.status === 404; } },
}));
import { useCardStore } from '../stores/cards';
import { cardView } from './card-view-fixtures';

describe('useCardStore ordered tree', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('projects committed parent children order from scrambled store rows', () => {
    const store = useCardStore();
    const childIds = [
      'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'card-bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'card-cccccccccccccccccccccccccccc',
    ];
    const root = cardView('project', { children: childIds });
    const first = cardView(childIds[0], { title: 'First' });
    const second = cardView(childIds[1], { title: 'Second' });
    const third = cardView(childIds[2], { title: 'Third' });
    store.cards = [second, root, third, first];

    expect(store.orderedCardTree.map((node) => node.card.id)).toEqual(['project']);
    expect(store.orderedCardTree[0]?.childNodes.map((node) => node.card.id)).toEqual(childIds);
  });
});
