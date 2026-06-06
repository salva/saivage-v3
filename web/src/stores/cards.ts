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
  DetailErrorState,
  DetailFreshnessState,
} from '../api/types';
import {
  listCards,
  getCard,
  ApiError,
} from '../api/client';
import { createLogger } from '../utils/logger';
import {
  buildDetailError,
  buildTree,
  createEmptyDetailState,
  createFreshDetailState,
  errorMessage,
  markDetailStaleState,
  selectBoardColumns,
  selectFilteredCards,
  selectOrderedFilteredCards,
} from './card-presentation';
import type {
  CardEvidence,
  CardLifecycleSummary,
  CardReviewSummary,
  CardPlanningSummary,
  DispatchSummary,
} from './card-detail-view-model';
import { toCardDetailViewModel } from './card-detail-view-model';
import { createCardHistoryState } from './card-history-state';

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

  function setCardStaleNotification(cardId: string | null | undefined, stale: boolean): void {
    if (!cardId) return;
    staleNotificationByCard.value = { ...staleNotificationByCard.value, [cardId]: stale };
  }

  function clearCurrentCardStaleNotification(cardId: string | null | undefined): void {
    if (!cardId) return;
    setCardStaleNotification(cardId, false);
  }

  const historyState = createCardHistoryState({
    currentVersionSeq: () => currentCard.value?.version_seq,
    clearCurrentCardStaleNotification,
  });
  const { clearCardHistoryState, fetchCardHistoryForCard, selectCardHistoryVersion } = historyState;


  function isStale(cardId: string): boolean {
    return staleNotificationByCard.value[cardId] === true;
  }

  async function fetchCardsInternal(): Promise<CardListResponse> {
    return listCards();
  }

  async function fetchCards(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const response = await fetchCardsInternal();
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
      const viewModel = toCardDetailViewModel(response);
      currentCard.value = viewModel.card;
      currentChildren.value = viewModel.children;
      currentAncestorIds.value = viewModel.ancestorIds;
      currentEvidence.value = viewModel.evidence ?? null;
      currentLifecycle.value = viewModel.lifecycle ?? null;
      currentReview.value = viewModel.review ?? null;
      currentPlanning.value = viewModel.planning ?? null;
      currentDispatches.value = viewModel.dispatches ?? null;
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

  async function refreshCardHistory(cardId?: string): Promise<void> {
    await historyState.refreshCardHistory(cardId ?? currentCard.value?.id);
  }


  async function applyFilters(): Promise<void> {
    await fetchCards();
  }

  function clearFilters(): void {
    filterStatus.value = '';
    filterType.value = '';
    filterParent.value = '';
    filterTag.value = '';
    searchQuery.value = '';
  }

  async function refetch(): Promise<void> {
    await fetchCards();
    const currentId = currentCard.value?.id;
    if (currentId) {
      await fetchCardDetail(currentId);
      await refreshCardHistory(currentId).catch(() => {});
    }
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
    cardHistory: historyState.cardHistory,
    cardHistoryLoading: historyState.cardHistoryLoading,
    cardHistoryError: historyState.cardHistoryError,
    cardHistorySelectedSeq: historyState.cardHistorySelectedSeq,
    cardHistoryEntry: historyState.cardHistoryEntry,
    cardHistoryEntryLoading: historyState.cardHistoryEntryLoading,
    cardHistoryEntryError: historyState.cardHistoryEntryError,
    cardHistoryDiff: historyState.cardHistoryDiff,
    cardHistoryDiffLoading: historyState.cardHistoryDiffLoading,
    cardHistoryDiffError: historyState.cardHistoryDiffError,
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
    refetch,
    markDetailStale,
    clearCardHistoryState,
    setCardStaleNotification,
  };
});
