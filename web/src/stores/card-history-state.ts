import { ref } from 'vue';
import type { CardDiffRow, CardHistoryEntry, CardHistoryHeader, DetailErrorState } from '../api/types';
import { getCardDiff, getCardHistoryEntry, listCardHistory } from '../api/client';
import { buildDetailError as buildPanelError } from './card-presentation';

export interface CardHistoryStateOptions {
  currentVersionSeq: () => number | null | undefined;
  clearCurrentCardStaleNotification: (cardId: string | null | undefined) => void;
}

export function createCardHistoryState(options: CardHistoryStateOptions) {
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
    cardHistoryLoading.value = true;
    cardHistoryError.value = null;
    try {
      const response = await listCardHistory(cardId);
      cardHistory.value = response.history;
      options.clearCurrentCardStaleNotification(cardId);
      if (response.history.length === 0) {
        cardHistorySelectedSeq.value = null;
        cardHistoryEntry.value = null;
        cardHistoryDiff.value = [];
      }
    } catch (err) {
      cardHistoryError.value = buildPanelError(err, 'Failed to load card history');
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
        getCardDiff(cardId, seq, options.currentVersionSeq() ?? seq + 1),
      ]);
      cardHistoryEntry.value = entryResponse.entry;
      cardHistoryDiff.value = diffResponse.diff;
    } catch (err) {
      const panelError = buildPanelError(err, 'Failed to load card history details');
      cardHistoryEntryError.value = panelError;
      cardHistoryDiffError.value = panelError;
    } finally {
      cardHistoryEntryLoading.value = false;
      cardHistoryDiffLoading.value = false;
    }
  }

  async function refreshCardHistory(cardId?: string | null): Promise<void> {
    if (!cardId) return;
    await fetchCardHistoryForCard(cardId);
    if (cardHistorySelectedSeq.value != null) {
      await selectCardHistoryVersion(cardId, cardHistorySelectedSeq.value);
    }
  }

  return {
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
    clearCardHistoryState,
    fetchCardHistoryForCard,
    selectCardHistoryVersion,
    refreshCardHistory,
  };
}
