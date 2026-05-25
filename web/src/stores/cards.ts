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
  CreateCardPayload,
  UpdateCardPayload,
  CardEvidence,
  CardLifecycleSummary,
  CardReviewSummary,
  CardPlanningSummary,
  DispatchSummary,
  DetailErrorState,
  DetailFreshnessState,
  CardHistoryHeader,
  CardHistoryEntry,
  CardDiffRow,
} from '../api/types';
import {
  listCards,
  getCard,
  createCard,
  updateCard,
  deleteCard,
  listCardHistory,
  getCardHistoryEntry,
  getCardDiff,
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

function buildDetailError(err: unknown, fallback: string): DetailErrorState {
  if (err instanceof ApiError) {
    if (err.isUnauthorized) {
      return { kind: 'unauthorized', status: err.status, message: err.message || 'Unauthorized.' };
    }
    if (err.isNotFound) {
      return { kind: 'not-found', status: err.status, message: err.message || 'Card not found.' };
    }
    if (err.status >= 500) {
      return { kind: 'server', status: err.status, message: err.message || fallback };
    }
    return { kind: 'unknown', status: err.status, message: err.message || fallback };
  }
  if (err instanceof Error) {
    return { kind: 'network', status: null, message: err.message || fallback };
  }
  return { kind: 'unknown', status: null, message: fallback };
}

function buildPanelError(err: unknown, fallback: string): DetailErrorState {
  return buildDetailError(err, fallback);
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
  const currentLifecycle = ref<CardLifecycleSummary | null>(null);
  const currentReview = ref<CardReviewSummary | null>(null);
  const currentPlanning = ref<CardPlanningSummary | null>(null);
  const currentDispatches = ref<DispatchSummary | null>(null);
  const currentDetailError = ref<DetailErrorState | null>(null);
  const currentDetailFreshness = ref<DetailFreshnessState>({
    isStale: false,
    lastLoadedAt: null,
    staleReason: null,
  });

  const cardHistory = ref<CardHistoryHeader[]>([]);
  const cardHistoryLoading = ref(false);
  const cardHistoryError = ref<DetailErrorState | null>(null);
  const cardHistorySelectedSeq = ref<number | null>(null);
  const cardHistoryEntry = ref<CardHistoryEntry | null>(null);
  const cardHistoryEntryLoading = ref(false);
  const cardHistoryEntryError = ref<DetailErrorState | null>(null);
  const cardHistoryDiff = ref<CardDiffRow[]>([]);
  const cardHistoryDiffLoading = ref(false);
  const cardHistoryDiffError = ref<DetailErrorState | null>(null);
  const staleNotificationByCard = ref<Record<string, boolean>>({});

  const filterStatus = ref<CardStatus | ''>('');
  const filterType = ref<CardType | ''>('');
  const filterParent = ref<string>('');
  const filterTag = ref<string>('');
  const searchQuery = ref<string>('');

  function applyCardFilters(source: CardRecord[]): CardRecord[] {
    let result = source;

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

    return result;
  }

  const filteredCards = computed<CardRecord[]>(() => [...applyCardFilters(cards.value)].sort(sortCards));

  const orderedFilteredCards = computed<CardRecord[]>(() => applyCardFilters(cards.value));

  const cardTree = computed<CardRecord[]>(() => buildTree(filteredCards.value));

  const orderedCardTree = computed<CardRecord[]>(() => buildTree(orderedFilteredCards.value));

  const board = computed<Map<CardStatus, CardRecord[]>>(() => {
    const columns = new Map<CardStatus, CardRecord[]>();
    const statuses: CardStatus[] = ['drafting', 'backlog', 'active', 'running', 'blocked', 'changed', 'done', 'failed', 'cancelled', 'needs_verification'];
    for (const s of statuses) columns.set(s, []);
    for (const card of filteredCards.value) {
      const col = columns.get(card.status);
      if (col) col.push(card);
    }
    for (const col of columns.values()) col.sort(sortCards);
    return columns;
  });

  const currentCardHasStaleWarning = computed(() => {
    const cardId = currentCard.value?.id;
    return cardId ? staleNotificationByCard.value[cardId] === true : false;
  });

  let mutationGen = 0;
  function bumpGen(): number { return ++mutationGen; }

  function resetDetailFreshness(): void {
    currentDetailFreshness.value = {
      isStale: false,
      lastLoadedAt: new Date().toISOString(),
      staleReason: null,
    };
  }

  function markDetailStale(reason: DetailFreshnessState['staleReason']): void {
    currentDetailFreshness.value = {
      ...currentDetailFreshness.value,
      isStale: true,
      staleReason: reason,
    };
  }

  function clearCurrentDetail(): void {
    currentCard.value = null;
    currentChildren.value = [];
    currentAncestorIds.value = [];
    currentEvidence.value = null;
    currentLifecycle.value = null;
    currentReview.value = null;
    currentPlanning.value = null;
    currentDispatches.value = null;
    currentDetailError.value = null;
    currentDetailFreshness.value = {
      isStale: false,
      lastLoadedAt: null,
      staleReason: null,
    };
    clearCardHistoryState();
  }

  function clearCardHistoryState(): void {
    cardHistory.value = [];
    cardHistoryLoading.value = false;
    cardHistoryError.value = null;
    cardHistorySelectedSeq.value = null;
    cardHistoryEntry.value = null;
    cardHistoryEntryLoading.value = false;
    cardHistoryEntryError.value = null;
    cardHistoryDiff.value = [];
    cardHistoryDiffLoading.value = false;
    cardHistoryDiffError.value = null;
  }

  function setCardStaleNotification(cardId: string | null | undefined, stale: boolean): void {
    if (!cardId) return;
    staleNotificationByCard.value = { ...staleNotificationByCard.value, [cardId]: stale };
  }

  function clearCurrentCardStaleNotification(cardId: string | null | undefined): void {
    if (!cardId) return;
    setCardStaleNotification(cardId, false);
  }

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
    currentDetailError.value = null;
    try {
      const response: CardDetailResponse = await getCard(id);
      currentCard.value = response.card;
      currentChildren.value = response.children;
      currentAncestorIds.value = response.ancestorIds;
      currentEvidence.value = response.evidence ?? null;
      currentLifecycle.value = response.lifecycle;
      currentReview.value = response.review;
      currentPlanning.value = response.planning;
      currentDispatches.value = response.dispatches;
      resetDetailFreshness();
      clearCurrentCardStaleNotification(response.card.id);
    } catch (err) {
      const detailErr = buildDetailError(err, 'Failed to fetch card detail');
      error.value = detailErr.message;
      if (currentCard.value?.id === id) {
        currentDetailError.value = detailErr;
        markDetailStale('refresh-failed');
      } else {
        clearCurrentDetail();
        currentDetailError.value = detailErr;
      }
      log.error('fetchCardDetail', detailErr.message);
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function fetchCardHistoryForCard(cardId: string): Promise<void> {
    cardHistoryLoading.value = true;
    cardHistoryError.value = null;
    try {
      const response = await listCardHistory(cardId);
      cardHistory.value = response.history;
      clearCurrentCardStaleNotification(cardId);
      if (response.history.length === 0) {
        cardHistorySelectedSeq.value = null;
        cardHistoryEntry.value = null;
        cardHistoryDiff.value = [];
      }
    } catch (err) {
      cardHistoryError.value = buildPanelError(err, 'Failed to load card history');
      throw err;
    } finally {
      cardHistoryLoading.value = false;
    }
  }

  async function selectCardHistoryVersion(cardId: string, seq: number): Promise<void> {
    cardHistorySelectedSeq.value = seq;
    cardHistoryEntryLoading.value = true;
    cardHistoryEntryError.value = null;
    cardHistoryDiffLoading.value = true;
    cardHistoryDiffError.value = null;
    try {
      const [entryResponse, diffResponse] = await Promise.all([
        getCardHistoryEntry(cardId, seq),
        getCardDiff(cardId, seq, currentCard.value?.version_seq ?? seq + 1),
      ]);
      cardHistoryEntry.value = entryResponse.entry;
      cardHistoryDiff.value = diffResponse.diff;
    } catch (err) {
      const panelError = buildPanelError(err, 'Failed to load card history details');
      cardHistoryEntryError.value = panelError;
      cardHistoryDiffError.value = panelError;
      throw err;
    } finally {
      cardHistoryEntryLoading.value = false;
      cardHistoryDiffLoading.value = false;
    }
  }

  async function refreshCardHistory(cardId?: string): Promise<void> {
    const id = cardId ?? currentCard.value?.id;
    if (!id) return;
    await fetchCardHistoryForCard(id);
    if (cardHistorySelectedSeq.value != null) {
      await selectCardHistoryVersion(id, cardHistorySelectedSeq.value);
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
      clearCurrentCardStaleNotification(id);
      return response.card;
    } catch (err) {
      const msg = errorMessage(err, 'Failed to update card');
      error.value = msg;
      log.error('editCard', msg);
      throw err;
    } finally {
      if (currentCard.value?.id === id) {
        clearCurrentCardStaleNotification(id);
      }
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
        clearCurrentDetail();
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
    wsUnsubscribe = ws.onType('activity', (envelope) => {
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
        if (currentCard.value?.id === updated.id) {
          currentCard.value = { ...currentCard.value, ...updated };
          clearCurrentCardStaleNotification(updated.id);
          markDetailStale('ws-card-updated');
        }
        const gen = bumpGen();
        safeBackgroundRefresh(gen);
      } else if (event === 'card-deleted' && content.id) {
        const deletedId = content.id as string;
        const beforeLen = cards.value.length;
        cards.value = cards.value.filter((c) => c.id !== deletedId && c.parent !== deletedId);
        const removedCount = beforeLen - cards.value.length;
        total.value = Math.max(0, total.value - removedCount);
        if (currentCard.value?.id === deletedId) {
          clearCurrentDetail();
        }
        const gen = bumpGen();
        safeBackgroundRefresh(gen);
      } else if (event === 'card_history_appended') {
        const cardId = content.card_id as string | undefined;
        if (cardId && currentCard.value?.id === cardId) {
          void refreshCardHistory(cardId).catch(() => {});
          clearCurrentCardStaleNotification(cardId);
          markDetailStale('ws-card-updated');
        }
      } else if (event === 'notification_added') {
        const relatedCardId = (content.related_card_id as string | undefined) ?? null;
        if (relatedCardId) {
          setCardStaleNotification(relatedCardId, true);
        }
      } else if (event === 'notification_acknowledged') {
        const relatedCardId = (content.related_card_id as string | undefined) ?? null;
        if (relatedCardId) {
          setCardStaleNotification(relatedCardId, false);
        }
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
    currentLifecycle,
    currentReview,
    currentPlanning,
    currentDispatches,
    currentDetailError,
    currentDetailFreshness,
    cardHistory,
    cardHistoryLoading,
    cardHistoryError,
    cardHistorySelectedSeq,
    cardHistoryEntry,
    cardHistoryEntryLoading,
    cardHistoryEntryError,
    cardHistoryDiff,
    cardHistoryDiffLoading,
    cardHistoryDiffError,
    staleNotificationByCard,
    currentCardHasStaleWarning,
    filterStatus,
    filterType,
    filterParent,
    filterTag,
    searchQuery,
    filteredCards,
    orderedFilteredCards,
    cardTree,
    orderedCardTree,
    board,
    fetchCards,
    fetchCardDetail,
    fetchCardHistoryForCard,
    selectCardHistoryVersion,
    refreshCardHistory,
    addCard,
    editCard,
    removeCard,
    applyFilters,
    clearFilters,
    setupWsListener,
    markDetailStale,
    clearCardHistoryState,
    setCardStaleNotification,
  };
});
