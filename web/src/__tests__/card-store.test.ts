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

  describe('WS-triggered background refresh with active filters', () => {
    it('passes active filter params to background refresh after card-created', async () => {
      const s = setupStore();
      // Set up filtered state
      s.filterStatus = 'active';
      s.filterType = 'code';
      s.cards = [A, E]; // only active+code cards
      s.total = 2;

      // The background refresh is async; mock listCards to return all cards
      // (simulating what happens when filters are NOT passed)
      const allCards = [A, B, C, D, E];
      vi.mocked(listCards).mockResolvedValue(mlr(allCards, 5));

      s.setupWsListener();

      // Fire a WS card-updated event, which triggers safeBackgroundRefresh
      fireWsEvent('status', { event: 'card-updated', card: { ...A, title: 'Alpha WS' } });

      // The optimistic update should have applied synchronously
      expect(s.cards[0].title).toBe('Alpha WS');

      // Wait for the background refresh promise to settle
      // Use a microtask flush: await a resolved promise
      await Promise.resolve();
      // Need to wait for the .then() chain to execute
      await new Promise(r => setTimeout(r, 10));

      // After the background refresh resolves, verify that listCards was called
      // WITH the active filter params (status=active, type=code), NOT without params.
      // This is the key assertion: the background refresh must preserve filters.
      const calls = vi.mocked(listCards).mock.calls;
      // The last call should be from the background refresh
      const lastCall = calls[calls.length - 1];
      // If the bug is present, lastCall would be [undefined] or [{}]
      // If fixed, lastCall should be [{ status: 'active', type: 'code' }]
      expect(lastCall).toBeDefined();
      const params = lastCall[0];
      expect(params).toBeDefined();
      expect(params).toHaveProperty('status', 'active');
      expect(params).toHaveProperty('type', 'code');
    });

    it('passes active filter params to background refresh after card-deleted', async () => {
      const s = setupStore();
      s.filterStatus = 'done';
      s.cards = [B]; // only done card
      s.total = 1;

      vi.mocked(listCards).mockResolvedValue(mlr([A, B, E], 3));

      s.setupWsListener();
      fireWsEvent('status', { event: 'card-deleted', id: 'card-x' });

      await Promise.resolve();
      await new Promise(r => setTimeout(r, 10));

      const calls = vi.mocked(listCards).mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toBeDefined();
      const params = lastCall[0];
      expect(params).toBeDefined();
      expect(params).toHaveProperty('status', 'done');
    });

    it('passes active filter params to background refresh after card-created', async () => {
      const s = setupStore();
      s.filterTag = 'urgent';
      s.cards = [D];
      s.total = 1;

      vi.mocked(listCards).mockResolvedValue(mlr([A, B, C, D, E], 5));

      s.setupWsListener();
      const newCard = makeCard({ id: 'card-f', tags: ['urgent'], status: 'active' });
      fireWsEvent('status', { event: 'card-created', card: newCard });

      await Promise.resolve();
      await new Promise(r => setTimeout(r, 10));

      const calls = vi.mocked(listCards).mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toBeDefined();
      const params = lastCall[0];
      expect(params).toBeDefined();
      expect(params).toHaveProperty('tag', 'urgent');
    });

    it('background refresh with no active filters calls listCards with no params', async () => {
      const s = setupStore();
      // No filters set
      s.cards = [A, B, E];
      s.total = 3;

      vi.mocked(listCards).mockResolvedValue(mlr([A, B, C, D, E], 5));

      s.setupWsListener();
      fireWsEvent('status', { event: 'card-updated', card: { ...A, title: 'Changed' } });

      await Promise.resolve();
      await new Promise(r => setTimeout(r, 10));

      const calls = vi.mocked(listCards).mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toBeDefined();
      const params = lastCall[0];
      // With no active filters, params should be undefined or empty
      expect(params == null || Object.keys(params).length === 0).toBe(true);
    });

    it('filteredCards still returns correct results after background refresh with filters', async () => {
      const s = setupStore();
      s.filterStatus = 'active';
      s.cards = [A, E]; // active cards only
      s.total = 2;

      // Background refresh returns all cards
      vi.mocked(listCards).mockResolvedValue(mlr([A, E], 2)); // server respects filters

      s.setupWsListener();
      fireWsEvent('status', { event: 'card-updated', card: { ...A, title: 'Updated Alpha' } });

      await Promise.resolve();
      await new Promise(r => setTimeout(r, 10));

      // filteredCards should still only show active cards
      const filtered = s.filteredCards;
      expect(filtered.map(c => c.id)).toEqual(['card-a', 'card-e']);
      expect(filtered.every(c => c.status === 'active')).toBe(true);
    });

    it('board reflects filtered cards after background refresh', async () => {
      const s = setupStore();
      s.filterStatus = 'done';
      s.cards = [B]; // only done card
      s.total = 1;

      // Server returns only done cards (respects filter)
      vi.mocked(listCards).mockResolvedValue(mlr([B], 1));

      s.setupWsListener();
      fireWsEvent('status', { event: 'card-updated', card: { ...B, title: 'Updated Beta' } });

      await Promise.resolve();
      await new Promise(r => setTimeout(r, 10));

      // board should only contain the filtered cards
      const b = s.board;
      // All non-done columns should be empty
      expect(b.get('active')).toEqual([]);
      expect(b.get('drafting')).toEqual([]);
      expect(b.get('blocked')).toEqual([]);
      // Done column should have B
      expect(b.get('done')?.map(c => c.id)).toEqual(['card-b']);
    });
  });

  // ── Search versus derived views ─────────────────────────────

  describe('search and derived views alignment', () => {
    it('cardTree derives from filteredCards (respects searchQuery)', () => {
      const s = setupStore();
      // A and C are a parent-child pair; B is unrelated
      s.cards = [A, B, C]; // A = parent, C = child-of-A, B = unrelated

      // Without search, tree has A and B as roots, C as child of A
      expect(s.cardTree).toHaveLength(2);
      const nodeA = s.cardTree.find(c => c.id === 'card-a') as any;
      expect(nodeA.children).toHaveLength(1);
      expect(nodeA.children[0].id).toBe('card-c');

      // Apply a search that only matches card B ("Beta")
      s.searchQuery = 'beta';

      // filteredCards should only have B
      expect(s.filteredCards.map(c => c.id)).toEqual(['card-b']);

      // cardTree must derive from filteredCards — only B appears
      expect(s.cardTree).toHaveLength(1);
      expect(s.cardTree[0].id).toBe('card-b');
    });

    it('cardTree derives from filteredCards (respects filterStatus)', () => {
      const s = setupStore();
      const root = makeCard({ id: 'root', type: 'project', status: 'active' });
      const child = makeCard({ id: 'child', type: 'code', status: 'done', parent: 'root' });
      const other = makeCard({ id: 'other', type: 'test', status: 'done' });
      s.cards = [root, child, other];

      // Filter to only 'done' cards — root (active) drops out
      s.filterStatus = 'done';

      // filteredCards: child (done) and other (done), sorted by priority
      expect(s.filteredCards.map(c => c.id).sort()).toEqual(['child', 'other']);

      // cardTree from filteredCards: child should NOT be nested under root
      // because root is not in the filtered set
      const tree = s.cardTree;
      // Count how many cards appear in the tree (flat)
      const countInTree = (nodes: any[]): number => {
        let n = nodes.length;
        for (const node of nodes) {
          if (node.children?.length) n += countInTree(node.children);
        }
        return n;
      };
      expect(countInTree(tree)).toBe(2); // child + other, both as roots
    });

    it('board derives from filteredCards (respects searchQuery)', () => {
      const s = setupStore();
      s.cards = [A, B, C, D, E];
      // A=active, B=done, C=drafting, D=blocked, E=active

      // No filters — all columns populated
      expect(s.board.get('active')?.length).toBe(2); // A, E
      expect(s.board.get('done')?.length).toBe(1);   // B

      // Search for "alpha" only
      s.searchQuery = 'alpha';

      // filteredCards: only A
      expect(s.filteredCards.map(c => c.id)).toEqual(['card-a']);

      // board: only active column has A, all others empty
      expect(s.board.get('active')?.map(c => c.id)).toEqual(['card-a']);
      expect(s.board.get('done')).toEqual([]);
      expect(s.board.get('drafting')).toEqual([]);
      expect(s.board.get('blocked')).toEqual([]);
      expect(s.board.get('running')).toEqual([]);
    });

    it('board derives from filteredCards (respects filterStatus)', () => {
      const s = setupStore();
      s.cards = [A, B, C, D, E];
      // Filter to only done cards
      s.filterStatus = 'done';

      // board: only done column has B
      expect(s.board.get('active')).toEqual([]);
      expect(s.board.get('done')?.map(c => c.id)).toEqual(['card-b']);
      expect(s.board.get('drafting')).toEqual([]);
    });

    it('board derives from filteredCards (respects combined status+search)', () => {
      const s = setupStore();
      const activeAlpha = makeCard({ id: 'aa', title: 'Alpha code', status: 'active', priority: 8 });
      const activeOther = makeCard({ id: 'ao', title: 'Zebra', status: 'active', priority: 3 });
      const doneAlpha = makeCard({ id: 'da', title: 'Alpha doc', status: 'done', priority: 5 });
      s.cards = [activeAlpha, activeOther, doneAlpha];

      // Filter status=active AND searchQuery=alpha
      s.filterStatus = 'active';
      s.searchQuery = 'alpha';

      // filteredCards: only activeAlpha
      expect(s.filteredCards.map(c => c.id)).toEqual(['aa']);

      // board: only active column has activeAlpha
      expect(s.board.get('active')?.map(c => c.id)).toEqual(['aa']);
      expect(s.board.get('done')).toEqual([]);
    });

    it('filteredCards + board + cardTree all align on WS live refresh', async () => {
      const s = setupStore();
      s.filterStatus = 'active';
      s.cards = [A, E]; // A and E are active
      s.total = 2;

      // Mock server to return only active cards (respects filter)
      vi.mocked(listCards).mockResolvedValue(mlr([A, E], 2));

      s.setupWsListener();

      // Fire WS update — this triggers safeBackgroundRefresh
      fireWsEvent('status', { event: 'card-updated', card: { ...A, title: 'Alpha Live' } });

      await Promise.resolve();
      await new Promise(r => setTimeout(r, 10));

      // All three derived views should agree
      const filtered = s.filteredCards;
      expect(filtered.map(c => c.id)).toEqual(['card-a', 'card-e']);
      expect(filtered.every(c => c.status === 'active')).toBe(true);

      // cardTree from filteredCards
      expect(s.cardTree).toHaveLength(2);

      // board from filteredCards — only active column populated
      expect(s.board.get('active')?.length).toBe(2);
      expect(s.board.get('done')).toEqual([]);
      expect(s.board.get('drafting')).toEqual([]);
      expect(s.board.get('blocked')).toEqual([]);
    });

    it('searchQuery is client-side only — does not trigger server fetch', () => {
      const s = setupStore();
      s.cards = [A, B, C, D, E];

      // Clear any previous mock calls
      vi.mocked(listCards).mockClear();

      // Set searchQuery (client-side only)
      s.searchQuery = 'alpha';

      // filteredCards should filter client-side
      expect(s.filteredCards.map(c => c.id)).toEqual(['card-a']);

      // But listCards should NOT have been called — searchQuery is client-side
      expect(listCards).not.toHaveBeenCalled();
    });
  });
});
