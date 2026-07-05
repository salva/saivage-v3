import { ref, computed } from 'vue';
import { storeToRefs } from 'pinia';
import type { useCardStore } from '../stores/cards';

export function useCardBrowserReadModel(cardStore: ReturnType<typeof useCardStore>) {
  const refs = storeToRefs(cardStore);
  const expandedTreeIds = ref<Set<string>>(new Set());

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
    cards: refs.cards,
    orderedCards: refs.orderedFilteredCards,
    orderedCardTree: refs.orderedCardTree,
    loading: refs.loading,
    errorMsg: computed(() => refs.error.value),
    filterStatus: refs.filterStatus,
    filterType: refs.filterType,
    searchQuery: refs.searchQuery,
    expandedTreeIds,
    toggleTreeNode,
    expandProjectByDefault,
  };
}
