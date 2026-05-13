/**
 * Pinia store for card data.
 *
 * Manages the cards list, detail view, tree structure, board layout,
 * filters, and all CRUD actions. Subscribes to WebSocket status events
 * for live card updates.
 *
 * ── Search / Derived View Semantics ────────────────────────────
 *
 * filteredCards is the single source of truth for what the operator
 * sees.  It applies server-backed filters (status, type, tag, parent)
 * first, then the client-side searchQuery, then sorts.
 *
 * All derived views — cardTree, board, and the views that consume them
 * (Tree, Board, Leaderboard, Timeline) — derive exclusively from
 * filteredCards so that any active filter or search term is
 * predictably reflected in every presentation.
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type {
  CardRecord,
  CardType,
  CardStatus,
  CardListResponse,
  CardDetailResponse,
  CardCreateResponse,
  CardUpdateResponse,
  CreateCardPayload,
  UpdateCardPayload,
} from '../api/types';
import {
  listCards,
  getCard,
  createCard,
  updateCard,
  deleteCard,
  ApiError,
} from '../api/client';
import { useWsStore } from './ws';
import { createLogger } from '../utils/logger';

const log = createLogger('store:cards');

/** Extract a human-readable error message from any thrown value. */
function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

// ── Helpers ────────────────────────────────────────────────────

/** Build a tree from a flat card list using parent/children relationships. */
function buildTree(cards: CardRecord[]): CardRecord[] {
  const byId = new Map<string, CardRecord & { children?: CardRecord[] }>();
  const roots: CardRecord[] = [];

  for (const card of cards) {
    byId.set(card.id, { ...card, children: [] });
  }

  for (const card of byId.values()) {
    if (card.parent && byId.has(card.parent)) {
      const parent = byId.get(card.parent)!;
      if (!parent.children) parent.children = [];
      parent.children.push(card);
    } else {
      roots.push(card);
    }
  }

  return roots;
}

/** Sort cards by priority (descending), then by updated_at (descending). */
function sortCards(a: CardRecord, b: CardRecord): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
}

// ── Store ──────────────────────────────────────────────────────

export const useCardStore = defineStore('cards', () => {
  // ── State ──────────────────────────────────────────────────

  const cards = ref<CardRecord[]>([]);
  const total = ref(0);
  const loading = ref(false);
  const error = ref<string | null>(null);

  /** Card detail for the currently inspected card. */
  const currentCard = ref<CardRecord | null>(null);
  const currentChildren = ref<CardRecord[]>([]);
  const currentAncestorIds = ref<string[]>([]);

  // ── Filters ────────────────────────────────────────────────

  const filterStatus = ref<CardStatus | ''>('');
  const filterType = ref<CardType | ''>('');
  const filterParent = ref<string>('');
  const filterTag = ref<string>('');
  const searchQuery = ref<string>('');

  // ── Getters ────────────────────────────────────────────────

  const filteredCards = computed<CardRecord[]>(() => {
    let result = cards.value;

    if (filterStatus.value) {
      result = result.filter((c) => c.status === filterStatus.value);
    }
    if (filterType.value) {
      result = result.filter((c) => c.type === filterType.value);
    }
    if (filterTag.value) {
      result = result.filter((c) => c.tags.includes(filterTag.value));
    }
    if (searchQuery.value) {
      const q = searchQuery.value.toLowerCase();
      result = result.filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q) ||
          c.id.toLowerCase().includes(q),
      );
    }
    if (filterParent.value) {
      result = result.filter((c) => c.parent === filterParent.value);
    }

    return [...result].sort(sortCards);
  });

  /**
   * Cards organized into rows by depth for tree rendering.
   * Derived from filteredCards so that any active filter or search
   * consistently reduces the visible tree.
   */
  const cardTree = computed<CardRecord[]>(() => {
    return buildTree(filteredCards.value);
  });

  /**
   * Board view: cards grouped by status.
   * Derived from filteredCards so that the board reflects active
   * filters instead of always showing every card.
   */
  const board = computed<Map<CardStatus, CardRecord[]>>(() => {
    const columns = new Map<CardStatus, CardRecord[]>();
    const statuses: CardStatus[] = [
      'drafting',
      'backlog',
      'active',
      'running',
      'blocked',
      'done',
      'failed',
      'cancelled',
    ];
    for (const s of statuses) {
      columns.set(s, []);
    }
    for (const card of filteredCards.value) {
      const col = columns.get(card.status);
      if (col) col.push(card);
    }
    // Sort each column
    for (const col of columns.values()) {
      col.sort(sortCards);
    }
    return columns;
  });

  // ── Optimistic mutation guard ──────────────────────────────

  /**
   * Monotonically-increasing generation counter incremented on every
   * optimistic mutation.  Background fetchCards calls capture the current
   * generation when they start; they discard their response if the
   * generation has moved on by the time the response arrives.
   */
  let mutationGen = 0;

  /** Bump the generation counter and return the new value. */
  function bumpGen(): number {
    return ++mutationGen;
  }

  /**
   * Execute a background fetchCards, but only apply the result if no
   * optimistic mutations have occurred since the fetch was initiated.
   * Preserves active filter parameters so filtered views are not replaced
   * by the full card list after a WS-triggered refresh.
   */
  function safeBackgroundRefresh(genAtStart: number): void {
    // Capture the current filter values so the background refresh
    // respects whatever filter is active in the UI.
    const params: {
      status?: string;
      type?: string;
      parent?: string;
      tag?: string;
    } = {};
    if (filterStatus.value) params.status = filterStatus.value;
    if (filterType.value) params.type = filterType.value;
    if (filterParent.value) params.parent = filterParent.value;
    if (filterTag.value) params.tag = filterTag.value;

    fetchCardsInternal(Object.keys(params).length > 0 ? params : undefined)
      .then((response) => {
        if (mutationGen !== genAtStart) return; // stale — discard
        cards.value = response.cards;
        total.value = response.total;
      })
      .catch(() => {
        // Background refresh failure is non-fatal; optimistic state stands.
      });
  }

  // ── Actions ────────────────────────────────────────────────

  /** Internal helper: perform the API call and return the response. */
  async function fetchCardsInternal(params?: {
    status?: string;
    type?: string;
    parent?: string;
    tag?: string;
  }): Promise<CardListResponse> {
    return listCards(params);
  }

  /** Fetch the full card list (optionally with filters). */
  async function fetchCards(params?: {
    status?: string;
    type?: string;
    parent?: string;
    tag?: string;
  }): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const response: CardListResponse = await fetchCardsInternal(params);
      cards.value = response.cards;
      total.value = response.total;
    } catch (err) {
      const msg = errorMessage(err, 'Failed to fetch cards');
      error.value = msg;
      log.error('fetchCards', msg);
      throw err;
    } finally {
      loading.value = false;
    }
  }

  /** Fetch a single card with its children and ancestor chain. */
  async function fetchCardDetail(id: string): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const response: CardDetailResponse = await getCard(id);
      currentCard.value = response.card;
      currentChildren.value = response.children;
      currentAncestorIds.value = response.ancestorIds;
    } catch (err) {
      const msg = errorMessage(err, 'Failed to fetch card detail');
      error.value = msg;
      log.error('fetchCardDetail', msg);
      throw err;
    } finally {
      loading.value = false;
    }
  }

  /** Create a new card. */
  async function addCard(payload: CreateCardPayload): Promise<CardRecord> {
    error.value = null;
    try {
      const response: CardCreateResponse = await createCard(payload);
      // Prepend to local list
      cards.value = [response.card, ...cards.value];
      total.value++;
      return response.card;
    } catch (err) {
      const msg = errorMessage(err, 'Failed to create card');
      error.value = msg;
      log.error('addCard', msg);
      throw err;
    }
  }

  /** Update an existing card. */
  async function editCard(id: string, payload: UpdateCardPayload): Promise<CardRecord> {
    error.value = null;
    try {
      const response: CardUpdateResponse = await updateCard(id, payload);
      // Update local list
      const idx = cards.value.findIndex((c) => c.id === id);
      if (idx !== -1) {
        cards.value[idx] = response.card;
      }
      if (currentCard.value?.id === id) {
        currentCard.value = response.card;
      }
      return response.card;
    } catch (err) {
      const msg = errorMessage(err, 'Failed to update card');
      error.value = msg;
      log.error('editCard', msg);
      throw err;
    }
  }

  /** Delete a card. */
  async function removeCard(id: string): Promise<void> {
    error.value = null;
    try {
      await deleteCard(id);
      const beforeLen = cards.value.length;
      cards.value = cards.value.filter((c) => c.id !== id && c.parent !== id);
      const removedCount = beforeLen - cards.value.length;
      total.value = Math.max(0, total.value - removedCount);
      if (currentCard.value?.id === id) {
        currentCard.value = null;
        currentChildren.value = [];
        currentAncestorIds.value = [];
      }
    } catch (err) {
      const msg = errorMessage(err, 'Failed to delete card');
      error.value = msg;
      log.error('removeCard', msg);
      throw err;
    }
  }

  /** Apply current UI filters and re-fetch. */
  async function applyFilters(): Promise<void> {
    await fetchCards({
      status: filterStatus.value || undefined,
      type: filterType.value || undefined,
      parent: filterParent.value || undefined,
      tag: filterTag.value || undefined,
    });
  }

  /** Clear all filters. */
  function clearFilters(): void {
    filterStatus.value = '';
    filterType.value = '';
    filterParent.value = '';
    filterTag.value = '';
    searchQuery.value = '';
  }

  // ── WebSocket Integration ──────────────────────────────────

  let wsUnsubscribe: (() => void) | null = null;

  function setupWsListener(): void {
    if (wsUnsubscribe) return;
    const ws = useWsStore();
    wsUnsubscribe = ws.onType('status', (envelope) => {
      const content = envelope.content || {};
      const event = content.event as string;

      // ── Optimistic local updates for card mutations ──────
      // Apply optimistic updates first (synchronous, instant UI feedback),
      // then fire a background refresh gated by a generation counter so
      // stale responses cannot overwrite more recent optimistic / refresh state.

      if (event === 'card-created' && content.card) {
        const newCard = content.card as CardRecord;
        const exists = cards.value.some((c) => c.id === newCard.id);
        if (!exists) {
          cards.value = [newCard, ...cards.value];
          total.value++;
        }
        // Background truth refresh — discard if a newer mutation happened
        const gen = bumpGen();
        safeBackgroundRefresh(gen);
      } else if (event === 'card-updated' && content.card) {
        const updated = content.card as CardRecord;
        const idx = cards.value.findIndex((c) => c.id === updated.id);
        if (idx !== -1) {
          cards.value[idx] = updated;
          cards.value = [...cards.value]; // trigger reactivity
        }
        if (currentCard.value?.id === updated.id) {
          currentCard.value = updated;
        }
        // Background truth refresh — discard if a newer mutation happened
        const gen = bumpGen();
        safeBackgroundRefresh(gen);
      } else if (event === 'card-deleted' && content.id) {
        const deletedId = content.id as string;
        const beforeLen = cards.value.length;
        cards.value = cards.value.filter((c) => c.id !== deletedId && c.parent !== deletedId);
        const removedCount = beforeLen - cards.value.length;
        total.value = Math.max(0, total.value - removedCount);
        if (currentCard.value?.id === deletedId) {
          currentCard.value = null;
          currentChildren.value = [];
          currentAncestorIds.value = [];
        }
        // Background truth refresh — discard if a newer mutation happened
        const gen = bumpGen();
        safeBackgroundRefresh(gen);
      }
    });
  }

  // ── Return ─────────────────────────────────────────────────

  return {
    // State
    cards,
    total,
    loading,
    error,
    currentCard,
    currentChildren,
    currentAncestorIds,

    // Filters
    filterStatus,
    filterType,
    filterParent,
    filterTag,
    searchQuery,

    // Getters
    filteredCards,
    cardTree,
    board,

    // Actions
    fetchCards,
    fetchCardDetail,
    addCard,
    editCard,
    removeCard,
    applyFilters,
    clearFilters,
    setupWsListener,
  };
});
