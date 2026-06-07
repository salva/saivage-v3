import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { cardStatusValues, cardTypeValues, type CardStatus, type CardType } from '../api/types';
import type { useCardStore } from '../stores/cards';
import { selectAvailableTags } from '../stores/card-presentation';

export type CardBrowserView = 'tree' | 'board' | 'leaderboard' | 'timeline';

export function useCardBrowserReadModel(cardStore: ReturnType<typeof useCardStore>) {
  const refs = storeToRefs(cardStore);
  const activeView = ref<CardBrowserView>('tree');
  const expandedTreeIds = ref<Set<string>>(new Set());
  const viewTabs = [
    { id: 'tree' as const, label: 'Tree' },
    { id: 'board' as const, label: 'Board' },
    { id: 'leaderboard' as const, label: 'Leaderboard' },
    { id: 'timeline' as const, label: 'Timeline' },
  ];

  const statuses: CardStatus[] = [...cardStatusValues];
  const cardTypes: CardType[] = [...cardTypeValues];
  const allTags = computed<string[]>(() => selectAvailableTags(refs.cards.value));
  const errorMsg = computed(() => refs.error.value);

  function applyFilters(): void {
    cardStore.applyFilters().catch(() => {});
  }

  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  function onSearchChange(): void {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      applyFilters();
    }, 300);
  }

  function toggleTreeNode(id: string): void {
    const set = new Set(expandedTreeIds.value);
    if (set.has(id)) {
      set.delete(id);
    } else {
      set.add(id);
    }
    expandedTreeIds.value = set;
  }

  function expandProjectByDefault(): void {
    if (refs.cards.value.length === 0) return;
    const projectCard = refs.cards.value.find((card) => card.type === 'project');
    if (projectCard) expandedTreeIds.value = new Set([projectCard.id]);
  }

  return {
    ...refs,
    activeView,
    viewTabs,
    statuses,
    cardTypes,
    allTags,
    errorMsg,
    expandedTreeIds,
    applyFilters,
    onSearchChange,
    toggleTreeNode,
    expandProjectByDefault,
  };
}
