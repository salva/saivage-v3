import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import type { useCardStore } from '../stores/cards';
import { buildTree } from '../stores/card-presentation';

export function useCardBrowserReadModel(cardStore: ReturnType<typeof useCardStore>) {
  const refs = storeToRefs(cardStore);
  const expandedTreeIds = ref<Set<string>>(new Set());
  const orderedCards = computed(() => [...refs.cards.value].sort((a, b) => {
    const parent = (a.parent ?? '').localeCompare(b.parent ?? '');
    if (parent !== 0) return parent;
    const aPosition = a.position ?? Number.POSITIVE_INFINITY;
    const bPosition = b.position ?? Number.POSITIVE_INFINITY;
    if (aPosition !== bPosition) return aPosition - bPosition;
    return a.id.localeCompare(b.id);
  }));
  const orderedCardTree = computed(() => buildTree(orderedCards.value));
  const errorMsg = computed(() => refs.error.value);

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
    orderedCards,
    orderedCardTree,
    errorMsg,
    expandedTreeIds,
    toggleTreeNode,
    expandProjectByDefault,
  };
}
