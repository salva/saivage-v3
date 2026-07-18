import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import type { useCardStore } from '../stores/cards';

export function useCardBrowserReadModel(cardStore: ReturnType<typeof useCardStore>, selectedCardId: () => string | null) {
  const refs = storeToRefs(cardStore);
  const explicitlyExpandedTreeIds = ref<Set<string>>(new Set());

  const representedSelectedAncestorIds = computed(() => {
    const selectedId = selectedCardId();
    const ancestors = new Set<string>();
    if (!selectedId || !cardStore.isHierarchyCardRepresented(selectedId)) return ancestors;
    const walk = (nodes: typeof refs.orderedCardTree.value, lineage: string[]): boolean => {
      for (const node of nodes) {
        if (node.card.id === selectedId) {
          for (const id of lineage) ancestors.add(id);
          return true;
        }
        if (walk(node.childNodes, [...lineage, node.card.id])) return true;
      }
      return false;
    };
    walk(refs.orderedCardTree.value, []);
    return ancestors;
  });

  const effectiveExpandedTreeIds = computed(() => {
    const ids = new Set(explicitlyExpandedTreeIds.value);
    for (const id of representedSelectedAncestorIds.value) ids.add(id);
    return ids;
  });

  async function toggleTreeNode(id: string): Promise<void> {
    const expanded = new Set(explicitlyExpandedTreeIds.value);
    if (effectiveExpandedTreeIds.value.has(id)) {
      expanded.delete(id);
    } else {
      expanded.add(id);
      const state = cardStore.childrenLoadState(id);
      if (state.status === 'idle') await cardStore.ensureChildren(id).catch(() => {});
    }
    explicitlyExpandedTreeIds.value = expanded;
  }

  return {
    orderedCardTree: refs.orderedCardTree,
    rootLoadState: computed(() => cardStore.childrenLoadState('project')),
    effectiveExpandedTreeIds,
    representedSelectedAncestorIds,
    toggleTreeNode,
  };
}
