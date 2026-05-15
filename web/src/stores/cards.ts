/**
 * Pinia store for card data.
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
  CardEvidence,
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

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

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

function sortCards(a: CardRecord, b: CardRecord): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
}

export const useCardStore = defineStore('cards', () => {
  const cards = ref<CardRecord[]>([]);
  const total = ref(0);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const currentCard = ref<CardRecord | null>(null);
  const currentChildren = ref<CardRecord[]>([]);
  const currentAncestorIds = ref<string[]>([]);
  const currentEvidence = ref<CardEvidence | null>(null);

  const filterStatus = ref<CardStatus | ''>('');
  const filterType = ref<CardType | ''>('');
  const filterParent = ref<string>('');
  const filterTag = ref<string>('');
  const searchQuery = ref<string>('');

  const filteredCards = computed<CardRecord[]>(() => {
    let result = cards.value;

    if (filterStatus.value) result = result.filter((c) => c.status === filterStatus.value);
    if (filterType.value) result = result.filter((c) => c.type === filterType.value);
    if (filterTag.value) result = result.filter((c) => c.tags.includes(filterTag.value));
    if (searchQuery.value) {
      const q = searchQuery.value.toLowerCase();
      result = result.filter((c) =>
        c.title.toLowerCase().includes(q)
        || c.description.toLowerCase().includes(q)
        || c.id.toLowerCase().includes(q));
    }
    if (filterParent.value) result = result.filter((c) => c.parent === filterParent.value);

    return [...result].sort(sortCards);
  });

  const cardTree = computed<CardRecord[]>(() => buildTree(filteredCards.value));

  const board = computed<Map<CardStatus, CardRecord[]>>(() => {
    const columns = new Map<CardStatus, CardRecord[]>();
    const statuses: CardStatus[] = ['drafting', 'backlog', 'active', 'running', 'blocked', 'done', 'failed', 'cancelled'];
    for (const s of statuses) columns.set(s, []);
    for (const card of filteredCards.value) {
      const col = columns.get(card.status);
      if (col) col.push(card);
    }
    for (const col of columns.values()) col.sort(sortCards);
    return columns;
  });

  let mutationGen = 0;
  function bumpGen(): number { return ++mutationGen; }

  function safeBackgroundRefresh(genAtStart: number): void {
    const params: { status?: string; type?: string; parent?: string; tag?: string } = {};
    if (filterStatus.value) params.status = filterStatus.value;
    if (filterType.value) params.type = filterType.value;
    if (filterParent.value) params.parent = filterParent.value;
    if (filterTag.value) params.tag = filterTag.value;

    fetchCardsInternal(Object.keys(params).length > 0 ? params : undefined)
      .then((response) => {
        if (mutationGen !== genAtStart) return;
        cards.value = response.cards;
        total.value = response.total;
      })
      .catch(() => {});
  }

  async function fetchCardsInternal(params?: { status?: string; type?: string; parent?: string; tag?: string }): Promise<CardListResponse> {
    return listCards(params);
  }

  async function fetchCards(params?: { status?: string; type?: string; parent?: string; tag?: string }): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const response = await fetchCardsInternal(params);
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

  async function fetchCardDetail(id: string): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const response: CardDetailResponse = await getCard(id);
      currentCard.value = response.card;
      currentChildren.value = response.children;
      currentAncestorIds.value = response.ancestorIds;
      currentEvidence.value = response.evidence ?? null;
    } catch (err) {
      const msg = errorMessage(err, 'Failed to fetch card detail');
      error.value = msg;
      log.error('fetchCardDetail', msg);
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function addCard(payload: CreateCardPayload): Promise<CardRecord> {
    error.value = null;
    try {
      const response = await createCard(payload);
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

  async function editCard(id: string, payload: UpdateCardPayload): Promise<CardRecord> {
    error.value = null;
    try {
      const response = await updateCard(id, payload);
      const idx = cards.value.findIndex((c) => c.id === id);
      if (idx !== -1) cards.value[idx] = response.card;
      if (currentCard.value?.id === id) currentCard.value = response.card;
      return response.card;
    } catch (err) {
      const msg = errorMessage(err, 'Failed to update card');
      error.value = msg;
      log.error('editCard', msg);
      throw err;
    }
  }

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
        currentEvidence.value = null;
      }
    } catch (err) {
      const msg = errorMessage(err, 'Failed to delete card');
      error.value = msg;
      log.error('removeCard', msg);
      throw err;
    }
  }

  async function applyFilters(): Promise<void> {
    await fetchCards({
      status: filterStatus.value || undefined,
      type: filterType.value || undefined,
      parent: filterParent.value || undefined,
      tag: filterTag.value || undefined,
    });
  }

  function clearFilters(): void {
    filterStatus.value = '';
    filterType.value = '';
    filterParent.value = '';
    filterTag.value = '';
    searchQuery.value = '';
  }

  let wsUnsubscribe: (() => void) | null = null;
  function setupWsListener(): void {
    if (wsUnsubscribe) return;
    const ws = useWsStore();
    wsUnsubscribe = ws.onType('status', (envelope) => {
      const content = envelope.content || {};
      const event = content.event as string;

      if (event === 'card-created' && content.card) {
        const newCard = content.card as CardRecord;
        const exists = cards.value.some((c) => c.id === newCard.id);
        if (!exists) {
          cards.value = [newCard, ...cards.value];
          total.value++;
        }
        const gen = bumpGen();
        safeBackgroundRefresh(gen);
      } else if (event === 'card-updated' && content.card) {
        const updated = content.card as CardRecord;
        const idx = cards.value.findIndex((c) => c.id === updated.id);
        if (idx !== -1) {
          cards.value[idx] = updated;
          cards.value = [...cards.value];
        }
        if (currentCard.value?.id === updated.id) currentCard.value = updated;
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
          currentEvidence.value = null;
        }
        const gen = bumpGen();
        safeBackgroundRefresh(gen);
      }
    });
  }

  return {
    cards,
    total,
    loading,
    error,
    currentCard,
    currentChildren,
    currentAncestorIds,
    currentEvidence,
    filterStatus,
    filterType,
    filterParent,
    filterTag,
    searchQuery,
    filteredCards,
    cardTree,
    board,
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
