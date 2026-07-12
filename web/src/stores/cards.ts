/**
 * Card domain store — single authoritative source for card data, selectors, and detail view models.
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
  CardDiffRow,
  CardHistoryEntry,
  CardHistoryHeader,
} from '../api/types';
import {
  listCards,
  getCard,
  getCardDiff,
  getCardHistoryEntry,
  listCardHistory,
  ApiError,
} from '../api/client';
import { createLogger } from '../utils/logger';

const log = createLogger('store:cards');

/* ─── Selectors ───────────────────────────────────────────────────────────── */

export interface CardFilterState {
  status: CardStatus | '';
  type: CardType | '';
  query: string;
}

export function buildDetailError(err: unknown, fallback: string): DetailErrorState {
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

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export function buildTree(cards: CardRecord[]): CardRecord[] {
  const byId = new Map<string, CardRecord & { children?: CardRecord[] }>();
  const roots: CardRecord[] = [];

  for (const card of cards) {
    const node = card as CardRecord & { children?: CardRecord[] };
    node.children = [];
    byId.set(card.id, node);
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

export function sortCardsByParentPosition(a: CardRecord, b: CardRecord): number {
  const pa = a.position ?? Number.POSITIVE_INFINITY;
  const pb = b.position ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa - pb;
  return a.id.localeCompare(b.id);
}

export function applyCardFilters(source: CardRecord[], filters: CardFilterState): CardRecord[] {
  let result = source;

  if (filters.status) result = result.filter((card) => card.status === filters.status);
  if (filters.type) result = result.filter((card) => card.type === filters.type);
  if (filters.query) {
    const q = filters.query.toLowerCase();
    result = result.filter((card) =>
      card.title.toLowerCase().includes(q)
      || card.id.toLowerCase().includes(q));
  }

  return result;
}

export function selectOrderedFilteredCards(source: CardRecord[], filters: CardFilterState): CardRecord[] {
  const matched = applyCardFilters(source, filters);
  if (matched.length === source.length) return matched;
  const byId = new Map(source.map((card) => [card.id, card]));
  const included = new Set(matched.map((card) => card.id));
  for (const card of matched) {
    let parentId = card.parent;
    while (parentId) {
      const parent = byId.get(parentId);
      if (!parent) break;
      included.add(parent.id);
      parentId = parent.parent;
    }
  }
  return source.filter((card) => included.has(card.id));
}

export function selectChildrenOf(cards: CardRecord[], parentId: string): CardRecord[] {
  return cards.filter((card) => card.parent === parentId).slice().sort(sortCardsByParentPosition);
}

export function createFreshDetailState(nowIso: string): DetailFreshnessState {
  return {
    isStale: false,
    lastLoadedAt: nowIso,
    staleReason: null,
  };
}

export function createEmptyDetailState(): DetailFreshnessState {
  return {
    isStale: false,
    lastLoadedAt: null,
    staleReason: null,
  };
}

export function markDetailStaleState(state: DetailFreshnessState, reason: DetailFreshnessState['staleReason']): DetailFreshnessState {
  return {
    ...state,
    isStale: true,
    staleReason: reason,
  };
}

/* ─── Detail View Model ───────────────────────────────────────────────────── */

export interface CardLifecycleSummary {
  status: CardStatus;
  terminal: boolean;
  phase: 'planned' | 'ready' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';
  explanation: string;
  completionState: 'not-started' | 'in-progress' | 'blocked' | 'failed' | 'cancelled' | 'marked-done';
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  retries: number;
  childCounts: Record<CardStatus, number>;
  hasActiveChildren: boolean;
  hasBlockingChildren: boolean;
  dependencyIds: string[];
  blockedByDependencyIds: string[];
}

export interface DispatchSummaryItem {
  dispatchId: string;
  direction: 'outgoing' | 'incoming';
  parentCardId: string;
  targetCardId: string;
  targetKind: 'goal' | 'terminal_card';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled' | 'timed_out';
  outcome: 'done' | 'failed' | 'blocked' | 'cancelled' | 'timed_out' | null;
  summary: string | null;
  error: string | null;
  evidenceCardIds: string[];
  completedAt: string | null;
}

export interface DispatchSummary {
  outgoing: DispatchSummaryItem[];
  incoming: DispatchSummaryItem[];
}

export interface CardDetailViewModel {
  card: CardRecord;
  children: CardRecord[];
  lifecycle?: CardLifecycleSummary | null;
  dispatches?: DispatchSummary | null;
}

const terminalStatuses = new Set<CardStatus>(['done', 'failed', 'cancelled']);

function lifecyclePhase(status: CardStatus): CardLifecycleSummary['phase'] {
  switch (status) {
    case 'backlog': return 'planned';
    case 'running': return 'running';
    case 'blocked': return 'blocked';
    case 'done': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    default: return 'ready';
  }
}

function completionState(status: CardStatus): CardLifecycleSummary['completionState'] {
  switch (status) {
    case 'backlog': return 'not-started';
    case 'blocked': return 'blocked';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'done': return 'marked-done';
    default: return 'in-progress';
  }
}

export function deriveCardLifecycleSummary(card: CardRecord, children: CardRecord[] = []): CardLifecycleSummary {
  const childCounts = {
    backlog: 0,
    running: 0,
    blocked: 0,
    changed: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
  } satisfies Record<CardStatus, number>;
  for (const child of children) childCounts[child.status] += 1;
  return {
    status: card.status,
    terminal: terminalStatuses.has(card.status),
    phase: lifecyclePhase(card.status),
    explanation: '',
    completionState: completionState(card.status),
    error: card.lifecycle?.error ?? null,
    startedAt: card.started_at ?? null,
    completedAt: card.lifecycle?.completed_at ?? null,
    durationMs: null,
    retries: card.retries,
    childCounts,
    hasActiveChildren: children.some((child) => child.status === 'running'),
    hasBlockingChildren: children.some((child) => child.status === 'blocked' || child.status === 'failed'),
    dependencyIds: card.depends_on,
    blockedByDependencyIds: [],
  };
}

export function toCardDetailViewModel(response: { card: CardRecord; children: CardRecord[] }): CardDetailViewModel {
  return {
    card: response.card,
    children: response.children,
    lifecycle: deriveCardLifecycleSummary(response.card, response.children),
    dispatches: null,
  };
}

/* ─── Pinia Store ─────────────────────────────────────────────────────────── */

export const useCardStore = defineStore('cards', () => {
  let cardDetailRequestSeq = 0;
  let cardsRequestSeq = 0;
  let cardsRequestController: AbortController | null = null;
  let detailRequestController: AbortController | null = null;
  let cardHistoryRequestSeq = 0;
  let cardHistoryEntryRequestSeq = 0;
  const cards = ref<CardRecord[]>([]);
  const total = ref(0);
  const loading = ref(false);
  const refreshing = ref(false);
  const refreshError = ref<string | null>(null);
  const error = ref<string | null>(null);

  const currentCard = ref<CardRecord | null>(null);
  const currentChildren = ref<CardRecord[]>([]);
  const currentLifecycle = ref<CardLifecycleSummary | null>(null);
  const currentDispatches = ref<DispatchSummary | null>(null);
  const currentDetailError = ref<DetailErrorState | null>(null);
  const currentDetailFreshness = ref<DetailFreshnessState>(createEmptyDetailState());

  const staleNotificationByCard = ref<Record<string, boolean>>({});

  const filterStatus = ref<CardStatus | ''>('');
  const filterType = ref<CardType | ''>('');
  const searchQuery = ref<string>('');

  const activeFilters = computed(() => ({
    status: filterStatus.value,
    type: filterType.value,
    query: searchQuery.value,
  }));

  const orderedFilteredCards = computed<CardRecord[]>(() => selectOrderedFilteredCards(cards.value, activeFilters.value));

  const orderedCardTree = computed<CardRecord[]>(() => buildTree(orderedFilteredCards.value));

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
    ++cardHistoryRequestSeq;
    ++cardHistoryEntryRequestSeq;
    currentCard.value = null;
    currentChildren.value = [];
    currentLifecycle.value = null;
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

  function isStale(cardId: string): boolean {
    return staleNotificationByCard.value[cardId] === true;
  }

  /* ── Card History (inlined) ── */

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

  async function fetchCardHistoryForCard(cardId: string): Promise<void> {
    const requestSeq = ++cardHistoryRequestSeq;
    cardHistoryLoading.value = true;
    cardHistoryError.value = null;
    try {
      const response = await listCardHistory(cardId);
      if (requestSeq !== cardHistoryRequestSeq || currentCard.value?.id !== cardId) return;
      cardHistory.value = response.history;
      clearCurrentCardStaleNotification(cardId);
      if (response.history.length === 0) {
        cardHistorySelectedSeq.value = null;
        cardHistoryEntry.value = null;
        cardHistoryDiff.value = [];
      }
    } catch (err) {
      if (requestSeq !== cardHistoryRequestSeq || currentCard.value?.id !== cardId) return;
      cardHistoryError.value = buildDetailError(err, 'Failed to load card history');
    } finally {
      if (requestSeq === cardHistoryRequestSeq && currentCard.value?.id === cardId) cardHistoryLoading.value = false;
    }
  }

  async function selectCardHistoryVersion(cardId: string, seq: number): Promise<void> {
    const requestSeq = ++cardHistoryEntryRequestSeq;
    const versionSeq = currentCard.value?.id === cardId ? currentCard.value.version_seq : null;
    cardHistorySelectedSeq.value = seq;
    cardHistoryEntryLoading.value = true;
    cardHistoryEntryError.value = null;
    cardHistoryDiffLoading.value = true;
    cardHistoryDiffError.value = null;
    try {
      const [entryResponse, diffResponse] = await Promise.all([
        getCardHistoryEntry(cardId, seq),
        getCardDiff(cardId, seq, versionSeq ?? seq + 1),
      ]);
      if (requestSeq !== cardHistoryEntryRequestSeq || currentCard.value?.id !== cardId || cardHistorySelectedSeq.value !== seq) return;
      cardHistoryEntry.value = entryResponse.entry;
      cardHistoryDiff.value = diffResponse.diff;
    } catch (err) {
      if (requestSeq !== cardHistoryEntryRequestSeq || currentCard.value?.id !== cardId || cardHistorySelectedSeq.value !== seq) return;
      const panelError = buildDetailError(err, 'Failed to load card history details');
      cardHistoryEntryError.value = panelError;
      cardHistoryDiffError.value = panelError;
    } finally {
      if (requestSeq === cardHistoryEntryRequestSeq && currentCard.value?.id === cardId && cardHistorySelectedSeq.value === seq) {
        cardHistoryEntryLoading.value = false;
        cardHistoryDiffLoading.value = false;
      }
    }
  }

  async function refreshCardHistory(cardId?: string | null): Promise<void> {
    if (!cardId) return;
    const selectedSeq = currentCard.value?.id === cardId ? cardHistorySelectedSeq.value : null;
    await fetchCardHistoryForCard(cardId);
    if (currentCard.value?.id === cardId && selectedSeq != null && cardHistorySelectedSeq.value === selectedSeq) {
      await selectCardHistoryVersion(cardId, selectedSeq);
    }
  }

  /* ── Fetch actions ── */

  async function fetchCards(): Promise<void> {
    const requestSeq = ++cardsRequestSeq;
    cardsRequestController?.abort();
    cardsRequestController = new AbortController();
    const initial = cards.value.length === 0;
    if (initial) loading.value = true; else refreshing.value = true;
    if (initial) error.value = null; else refreshError.value = null;
    try {
      const response: CardListResponse = await listCards(cardsRequestController.signal);
      if (requestSeq !== cardsRequestSeq) return;
      const existing = new Map(cards.value.map((card) => [card.id, card]));
      cards.value = response.cards.map((next) => {
        const current = existing.get(next.id);
        if (!current) return next;
        Object.assign(current, next);
        return current;
      });
      total.value = response.total;
      error.value = null;
      refreshError.value = null;
    } catch (err) {
      if (requestSeq !== cardsRequestSeq || (err instanceof DOMException && err.name === 'AbortError')) return;
      const msg = errorMessage(err, 'Failed to fetch cards');
      if (initial) error.value = msg; else refreshError.value = msg;
      log.error('fetchCards', msg);
      throw err;
    } finally {
      if (requestSeq === cardsRequestSeq) { loading.value = false; refreshing.value = false; }
    }
  }

  async function fetchCardDetail(id: string): Promise<void> {
    const requestSeq = ++cardDetailRequestSeq;
    detailRequestController?.abort();
    detailRequestController = new AbortController();
    ++cardHistoryRequestSeq;
    ++cardHistoryEntryRequestSeq;
    if (currentCard.value?.id !== id) clearCurrentDetail();
    loading.value = true;
    error.value = null;
    currentDetailError.value = null;
    try {
      const response: CardDetailResponse = await getCard(id, detailRequestController.signal);
      if (requestSeq !== cardDetailRequestSeq) return;
      const viewModel = toCardDetailViewModel(response);
      currentCard.value = viewModel.card;
      currentChildren.value = viewModel.children;
      currentLifecycle.value = viewModel.lifecycle ?? null;
      currentDispatches.value = viewModel.dispatches ?? null;
      resetDetailFreshness();
      clearCurrentCardStaleNotification(response.card.id);
    } catch (err) {
      if (requestSeq !== cardDetailRequestSeq) return;
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
      if (requestSeq === cardDetailRequestSeq) loading.value = false;
    }
  }

  async function applyFilters(): Promise<void> {
    await fetchCards();
  }

  function clearFilters(): void {
    filterStatus.value = '';
    filterType.value = '';
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
    refreshing,
    refreshError,
    error,
    currentCard,
    currentChildren,
    currentLifecycle,
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
    searchQuery,
    orderedFilteredCards,
    orderedCardTree,
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
