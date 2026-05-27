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
  listCardHistory,
  getCardHistoryEntry,
  getCardDiff,
  ApiError,
} from '../api/client';
import { useWsStore } from './ws';
import { createLogger } from '../utils/logger';
import {
  buildDetailError,
  buildDetailError as buildPanelError,
  buildTree,
  createEmptyDetailState,
  createFreshDetailState,
  errorMessage,
  markDetailStaleState,
  selectBoardColumns,
  selectFilteredCards,
  selectOrderedFilteredCards,
} from './card-read-model';

const log = createLogger('store:cards');

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
  const currentDetailFreshness = ref<DetailFreshnessState>(createEmptyDetailState());

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

  const activeFilters = computed(() => ({
    status: filterStatus.value,
    type: filterType.value,
    parent: filterParent.value,
    tag: filterTag.value,
    query: searchQuery.value,
  }));

  const filteredCards = computed<CardRecord[]>(() => selectFilteredCards(cards.value, activeFilters.value));

  const orderedFilteredCards = computed<CardRecord[]>(() => selectOrderedFilteredCards(cards.value, activeFilters.value));

  const cardTree = computed<CardRecord[]>(() => buildTree(filteredCards.value));

  const orderedCardTree = computed<CardRecord[]>(() => buildTree(orderedFilteredCards.value));

  const board = computed<Map<CardStatus, CardRecord[]>>(() => selectBoardColumns(filteredCards.value));

  const currentCardHasStaleWarning = computed(() => {
    const cardId = currentCard.value?.id;
    return cardId ? staleNotificationByCard.value[cardId] === true : false;
  });

  let mutationGen = 0;
  function bumpGen(): number { return ++mutationGen; }

  function resetDetailFreshness(): void {
    currentDetailFreshness.value = createFreshDetailState(new Date().toISOString());
  }

  function markDetailStale(reason: DetailFreshnessState['staleReason']): void {
    currentDetailFreshness.value = markDetailStaleState(currentDetailFreshness.value, reason);
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
    currentDetailFreshness.value = createEmptyDetailState();
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


  function isStale(cardId: string): boolean {
    return staleNotificationByCard.value[cardId] === true;
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
    isStale,
    fetchCards,
    fetchCardDetail,
    fetchCardHistoryForCard,
    selectCardHistoryVersion,
    refreshCardHistory,
    applyFilters,
    clearFilters,
    setupWsListener,
    markDetailStale,
    clearCardHistoryState,
    setCardStaleNotification,
  };
});
