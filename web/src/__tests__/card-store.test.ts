import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { CardRecord, CardListResponse, CardDetailResponse, CardCreateResponse, CardUpdateResponse } from '../api/types';

vi.mock('../api/client', () => ({
  listCards: vi.fn(), getCard: vi.fn(), createCard: vi.fn(), updateCard: vi.fn(), deleteCard: vi.fn(),
  ApiError: class extends Error { status: number; body: Record<string, unknown>;
    constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.name='ApiError'; this.status=status; this.body=body; }
  },
}));

import { listCards, getCard, createCard, updateCard, deleteCard } from '../api/client';

const wsTypeHandlers = new Map<string, Set<(e: any) => void>>();
function fireWsEvent(type: string, content: Record<string, unknown>) {
  const hs = wsTypeHandlers.get(type); if (hs) for (const h of hs) h({ type, content });
}
vi.mock('../stores/ws', () => ({
  useWsStore: vi.fn(() => ({
    onType: (type: string, handler: (e: any) => void) => {
      let set = wsTypeHandlers.get(type); if (!set) { set = new Set(); wsTypeHandlers.set(type, set); }
      set.add(handler); return () => set?.delete(handler);
    },
  })),
}));

import { useCardStore } from '../stores/cards';

function setupStore() {
  setActivePinia(createPinia()); wsTypeHandlers.clear(); vi.clearAllMocks(); return useCardStore();
}
function makeCard(overrides: Partial<CardRecord> = {}): CardRecord {
  const id = overrides.id || `c-${Math.random().toString(36).slice(2,6)}`;
  return { id, type: 'code', parent: null, depth: 0, title: `Card ${id}`, description: 'test',
    status: 'active', tags: [], priority: 5, urgency: 'normal', created_by: 'user',
    created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z',
    depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [],
    retries: 0, ...overrides };
}

const A = makeCard({ id: 'card-a', title: 'Alpha', type: 'code', status: 'active', priority: 7, tags: ['core'] });
const B = makeCard({ id: 'card-b', title: 'Beta', type: 'test', status: 'done', priority: 3, tags: ['core','regr'] });
const C = makeCard({ id: 'card-c', title: 'Gamma', type: 'doc', status: 'drafting', priority: 5, parent: 'card-a' });
const D = makeCard({ id: 'card-d', title: 'Delta', type: 'plan', status: 'blocked', priority: 9, tags: ['urgent'] });
const E = makeCard({ id: 'card-e', title: 'Epsilon', type: 'code', status: 'active', priority: 6, tags: ['core'] });

function mlr(cards: CardRecord[], total?: number): CardListResponse { return { cards, total: total ?? cards.length }; }
function mcr(card: CardRecord): CardCreateResponse { return { card }; }
function mur(card: CardRecord): CardUpdateResponse { return { card }; }
function mdr(card: CardRecord, children: CardRecord[] = [], ancestorIds: string[] = []): CardDetailResponse { return { card, children, ancestorIds }; }

describe('useCardStore', () => {
  beforeEach(() => { vi.clearAllMocks(); wsTypeHandlers.clear(); });
  afterEach(() => { vi.restoreAllMocks(); });

  describe('initial state', () => {
    it('has empty defaults', () => {
      const s = setupStore();
      expect(s.cards).toEqual([]); expect(s.total).toBe(0); expect(s.loading).toBe(false);
      expect(s.error).toBeNull(); expect(s.currentCard).toBeNull();
      expect(s.currentChildren).toEqual([]); expect(s.currentAncestorIds).toEqual([]);
      expect(s.filteredCards).toEqual([]); expect(s.cardTree).toEqual([]);
      expect(s.board).toBeInstanceOf(Map);
    });
  });

  describe('fetchCards()', () => {
    it('populates cards and total', async () => {
      const s = setupStore();
      vi.mocked(listCards).mockResolvedValue(mlr([A,B,C,D,E]));
      await s.fetchCards();
      expect(s.cards).toHaveLength(5); expect(s.total).toBe(5); expect(s.error).toBeNull();
    });
    it('handles empty list', async () => {
      const s = setupStore();
      vi.mocked(listCards).mockResolvedValue(mlr([], 0));
      await s.fetchCards();
      expect(s.cards).toEqual([]); expect(s.total).toBe(0);
    });
    it('sets error on failure', async () => {
      const s = setupStore();
      vi.mocked(listCards).mockRejectedValue(new Error('net'));
      await expect(s.fetchCards()).rejects.toThrow('net');
      expect(s.error).toBe('net');
    });
    it('clears previous error on success', async () => {
      const s = setupStore();
      vi.mocked(listCards).mockRejectedValueOnce(new Error('fail'));
      await expect(s.fetchCards()).rejects.toThrow('fail');
      vi.mocked(listCards).mockResolvedValue(mlr([A]));
      await s.fetchCards();
      expect(s.error).toBeNull();
    });
  });

  describe('fetchCardDetail()', () => {
    it('populates currentCard + children + ancestors', async () => {
      const s = setupStore();
      vi.mocked(getCard).mockResolvedValue(mdr(A, [C], ['root','card-a']));
      await s.fetchCardDetail('card-a');
      expect(s.currentCard).toEqual(A); expect(s.currentChildren).toEqual([C]);
      expect(s.currentAncestorIds).toEqual(['root','card-a']);
    });
    it('sets error on failure', async () => {
      const s = setupStore();
      vi.mocked(getCard).mockRejectedValue(new Error('nf'));
      await expect(s.fetchCardDetail('x')).rejects.toThrow('nf');
      expect(s.error).toBe('nf');
    });
  });

  describe('addCard()', () => {
    it('creates and prepends', async () => {
      const s = setupStore();
      vi.mocked(listCards).mockResolvedValue(mlr([B]));
      await s.fetchCards();
      vi.mocked(createCard).mockResolvedValue(mcr(A));
      await s.addCard({ type: 'code', title: 'Alpha' });
      expect(s.cards.map(c=>c.id)).toEqual(['card-a','card-b']);
      expect(s.total).toBe(2);
    });
    it('handles error', async () => {
      const s = setupStore();
      vi.mocked(createCard).mockRejectedValue(new Error('bad'));
      await expect(s.addCard({ type: 'code', title: 'X' })).rejects.toThrow('bad');
      expect(s.error).toBe('bad');
    });
  });

  describe('editCard()', () => {
    it('updates list and currentCard', async () => {
      const s = setupStore();
      vi.mocked(listCards).mockResolvedValue(mlr([A,B]));
      await s.fetchCards();
      vi.mocked(getCard).mockResolvedValue(mdr(A));
      await s.fetchCardDetail('card-a');
      const up = { ...A, title: 'Alpha++' };
      vi.mocked(updateCard).mockResolvedValue(mur(up));
      await s.editCard('card-a', { title: 'Alpha++' });
      expect(s.cards[0].title).toBe('Alpha++');
      expect(s.currentCard?.title).toBe('Alpha++');
    });
    it('does not update currentCard when editing different card', async () => {
      const s = setupStore();
      vi.mocked(listCards).mockResolvedValue(mlr([A,B]));
      await s.fetchCards();
      s.currentCard = A;
      const up = { ...B, title: 'Beta++' };
      vi.mocked(updateCard).mockResolvedValue(mur(up));
      await s.editCard('card-b', { title: 'Beta++' });
      expect(s.currentCard?.title).toBe('Alpha');
    });
    it('handles error', async () => {
      const s = setupStore();
      vi.mocked(updateCard).mockRejectedValue(new Error('conflict'));
      await expect(s.editCard('x', {})).rejects.toThrow('conflict');
      expect(s.error).toBe('conflict');
    });
  });

  describe('removeCard()', () => {
    it('deletes card and children, updates total', async () => {
      const s = setupStore();
      vi.mocked(listCards).mockResolvedValue(mlr([A,B,C]));
      await s.fetchCards(); expect(s.total).toBe(3);
      vi.mocked(deleteCard).mockResolvedValue(undefined);
      await s.removeCard('card-a');
      expect(s.cards).toEqual([B]); expect(s.total).toBe(1);
    });
    it('clears currentCard when deleting inspected card', async () => {
      const s = setupStore();
      s.currentCard = A; s.currentChildren = [C];
      vi.mocked(deleteCard).mockResolvedValue(undefined);
      await s.removeCard('card-a');
      expect(s.currentCard).toBeNull(); expect(s.currentChildren).toEqual([]);
    });
    it('handles error', async () => {
      const s = setupStore();
      vi.mocked(deleteCard).mockRejectedValue(new Error('nf'));
      await expect(s.removeCard('x')).rejects.toThrow('nf');
      expect(s.error).toBe('nf');
    });
  });

  describe('filteredCards', () => {
    it('filters by status', () => {
      const s = setupStore(); s.cards = [A,B,C];
      s.filterStatus = 'active';
      expect(s.filteredCards.map(c=>c.id)).toEqual(['card-a']);
    });
    it('filters by type', () => {
      const s = setupStore(); s.cards = [A,B,C];
      s.filterType = 'test';
      expect(s.filteredCards.map(c=>c.id)).toEqual(['card-b']);
    });
    it('filters by tag', () => {
      const s = setupStore(); s.cards = [A,B,C];
      s.filterTag = 'core';
      expect(s.filteredCards.map(c=>c.id).sort()).toEqual(['card-a','card-b']);
    });
    it('filters by search query', () => {
      const s = setupStore(); s.cards = [A,B];
      s.searchQuery = 'alpha';
      expect(s.filteredCards.map(c=>c.id)).toEqual(['card-a']);
    });
    it('filters by parent', () => {
      const s = setupStore(); s.cards = [A,C];
      s.filterParent = 'card-a';
      expect(s.filteredCards.map(c=>c.id)).toEqual(['card-c']);
    });
    it('combines filters', () => {
      const s = setupStore(); s.cards = [A,B,E];
      s.filterStatus = 'active'; s.filterType = 'code'; s.searchQuery = 'alpha';
      expect(s.filteredCards.map(c=>c.id)).toEqual(['card-a']);
    });
    it('sorts by priority desc then updated_at desc', () => {
      const s = setupStore();
      const lo = makeCard({ id: 'lo', priority: 1, updated_at: '2025-01-03T00:00:00Z' });
      const hi = makeCard({ id: 'hi', priority: 10, updated_at: '2025-01-01T00:00:00Z' });
      const md1 = makeCard({ id: 'md1', priority: 5, updated_at: '2025-01-04T00:00:00Z' });
      const md2 = makeCard({ id: 'md2', priority: 5, updated_at: '2025-01-02T00:00:00Z' });
      s.cards = [lo, hi, md1, md2];
      expect(s.filteredCards.map(c=>c.id)).toEqual(['hi','md1','md2','lo']);
    });
  });

  describe('cardTree', () => {
    it('builds tree from flat list', () => {
      const s = setupStore(); s.cards = [A,B,C];
      const t = s.cardTree;
      expect(t).toHaveLength(2);
      const node = t.find(c=>c.id==='card-a') as any;
      expect(node.children).toHaveLength(1);
      expect(node.children[0].id).toBe('card-c');
    });
    it('orphaned child becomes root', () => {
      const s = setupStore();
      const orphan = makeCard({ id: 'orphan', parent: 'nonexistent' });
      s.cards = [A, orphan];
      expect(s.cardTree).toHaveLength(2);
    });
    it('multi-level nesting', () => {
      const s = setupStore();
      const r = makeCard({ id: 'root' });
      const ch = makeCard({ id: 'child', parent: 'root' });
      const gc = makeCard({ id: 'gc', parent: 'child' });
      s.cards = [r, ch, gc];
      const t = s.cardTree;
      expect(t).toHaveLength(1);
      const rn = t[0] as any;
      expect(rn.children[0].id).toBe('child');
      expect(rn.children[0].children[0].id).toBe('gc');
    });
  });

  describe('board', () => {
    it('groups by status with sorted columns', () => {
      const s = setupStore(); s.cards = [A,B,C,D];
      expect(s.board.get('active')?.map(c=>c.id)).toEqual(['card-a']);
      expect(s.board.get('done')?.map(c=>c.id)).toEqual(['card-b']);
      expect(s.board.get('drafting')?.map(c=>c.id)).toEqual(['card-c']);
      expect(s.board.get('blocked')?.map(c=>c.id)).toEqual(['card-d']);
      expect(s.board.get('running')).toEqual([]);
    });
  });

  describe('applyFilters / clearFilters', () => {
    it('applyFilters calls fetchCards with current filters', async () => {
      const s = setupStore();
      vi.mocked(listCards).mockResolvedValue(mlr([A]));
      s.filterStatus = 'active'; s.filterType = 'code';
      await s.applyFilters();
      expect(listCards).toHaveBeenCalledWith({ status: 'active', type: 'code' });
    });
    it('clearFilters resets all', () => {
      const s = setupStore();
      s.filterStatus = 'active'; s.filterType = 'code'; s.filterParent = 'x'; s.filterTag = 't'; s.searchQuery = 'q';
      s.clearFilters();
      expect(s.filterStatus).toBe(''); expect(s.filterType).toBe(''); expect(s.filterParent).toBe('');
      expect(s.filterTag).toBe(''); expect(s.searchQuery).toBe('');
    });
  });

  describe('WebSocket mutations', () => {
    it('card-created: prepends new card', () => {
      const s = setupStore(); s.cards = [B]; s.total = 1; s.setupWsListener();
      fireWsEvent('status', { event: 'card-created', card: A });
      expect(s.cards.map(c=>c.id)).toEqual(['card-a','card-b']);
      expect(s.total).toBe(2);
    });
    it('card-created: skips duplicate', () => {
      const s = setupStore(); s.cards = [A,B]; s.total = 2; s.setupWsListener();
      fireWsEvent('status', { event: 'card-created', card: A });
      expect(s.cards).toHaveLength(2); expect(s.total).toBe(2);
    });
    it('card-updated: updates list and currentCard', () => {
      const s = setupStore(); s.cards = [A,B]; s.currentCard = A; s.setupWsListener();
      const up = { ...A, title: 'Alpha WS', priority: 99 };
      fireWsEvent('status', { event: 'card-updated', card: up });
      expect(s.cards[0].title).toBe('Alpha WS'); expect(s.cards[0].priority).toBe(99);
      expect(s.currentCard?.title).toBe('Alpha WS');
    });
    it('card-deleted: removes card and children', () => {
      const s = setupStore(); s.cards = [A,B,C]; s.total = 3;
      s.currentCard = A; s.currentChildren = [C]; s.setupWsListener();
      fireWsEvent('status', { event: 'card-deleted', id: 'card-a' });
      expect(s.cards).toEqual([B]); expect(s.total).toBe(1);
      expect(s.currentCard).toBeNull();
    });
    it('card-deleted: total never below 0', () => {
      const s = setupStore(); s.total = 0; s.setupWsListener();
      fireWsEvent('status', { event: 'card-deleted', id: 'x' });
      expect(s.total).toBe(0);
    });
    it('create → update → delete sequence', () => {
      const s = setupStore(); s.setupWsListener();
      fireWsEvent('status', { event: 'card-created', card: A });
      expect(s.cards).toHaveLength(1); expect(s.total).toBe(1);
      const up = { ...A, title: 'Modified' };
      fireWsEvent('status', { event: 'card-updated', card: up });
      expect(s.cards[0].title).toBe('Modified');
      fireWsEvent('status', { event: 'card-deleted', id: 'card-a' });
      expect(s.cards).toEqual([]); expect(s.total).toBe(0);
    });
    it('setupWsListener is idempotent', () => {
      const s = setupStore(); s.setupWsListener(); s.setupWsListener();
      expect(wsTypeHandlers.get('status')?.size).toBe(1);
    });
    it('graceful on missing content fields', () => {
      const s = setupStore(); s.cards = [A]; s.total = 1; s.setupWsListener();
      expect(() => fireWsEvent('status', { event: 'card-created' })).not.toThrow();
      expect(() => fireWsEvent('status', { event: 'card-updated' })).not.toThrow();
      expect(() => fireWsEvent('status', { event: 'card-deleted' })).not.toThrow();
      expect(() => fireWsEvent('status', {})).not.toThrow();
      expect(s.cards).toEqual([A]); expect(s.total).toBe(1);
    });
  });
});
