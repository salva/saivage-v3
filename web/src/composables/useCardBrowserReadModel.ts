import { ref, computed } from 'vue';
import { storeToRefs } from 'pinia';
import type { useCardStore } from '../stores/cards';

export function useCardBrowserReadModel(cardStore: ReturnType<typeof useCardStore>) {
  const refs = storeToRefs(cardStore);
  const explicitlyExpandedTreeIds = ref<Set<string>>(new Set());
  const explicitlyCollapsedTreeIds = ref<Set<string>>(new Set());
  const projectCardId = computed(() => refs.cards.value.find((card) => card.type === 'project')?.id ?? null);
  const effectiveExpandedTreeIds = computed(() => {
    const ids = new Set(explicitlyExpandedTreeIds.value);
    const projectId = projectCardId.value;
    if (projectId && !explicitlyCollapsedTreeIds.value.has(projectId)) ids.add(projectId);
    return ids;
  });

  function toggleTreeNode(id: string): void {
    const expanded = new Set(explicitlyExpandedTreeIds.value);
    const collapsed = new Set(explicitlyCollapsedTreeIds.value);
    if (effectiveExpandedTreeIds.value.has(id)) {
      expanded.delete(id);
      collapsed.add(id);
    } else {
      collapsed.delete(id);
      expanded.add(id);
    }
    explicitlyExpandedTreeIds.value = expanded;
    explicitlyCollapsedTreeIds.value = collapsed;
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
    effectiveExpandedTreeIds,
    toggleTreeNode,
  };
}
