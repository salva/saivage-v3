<template>
  <div class="cards-route" data-testid="route-cards">
    <EntityInspectorShell
      :selected="!!currentCardId"
      list-label="Card tree"
      detail-label="Card detail"
      empty-title="Select a card to inspect"
      back-label="Back to Cards"
      :detail-title="currentCardId"
      @back="backToCards"
    >
      <template #list>
        <div class="cards-md__tree">
          <ViewState v-if="rootLoadState.status === 'loading' || rootLoadState.status === 'idle'" state="loading" title="Loading cards" />
          <ViewState v-else-if="rootLoadState.status === 'error'" state="error" title="Could not load cards" :message="rootLoadState.error ?? undefined">
            <template #action><button type="button" @click="retryRoot">Retry</button></template>
          </ViewState>
          <CardsTreeView
            v-else
            :tree="orderedCardTree"
            :expanded-ids="effectiveExpandedTreeIds"
            :forced-expanded-ids="representedSelectedAncestorIds"
            :selected-card-id="currentCardId"
            :load-state-for="cardStore.childrenLoadState"
            @toggle="toggleTreeNode"
            @retry="retryChildren"
            @select="selectCard"
          />
        </div>
      </template>

      <template #detail>
        <CardDetailView v-if="currentCardId" :card-id="currentCardId" />
      </template>
    </EntityInspectorShell>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { cardRouteChain, useCardStore } from '../stores/cards';
import CardsTreeView from '../components/cards/CardsTreeView.vue';
import CardDetailView from '../components/cards/CardDetailView.vue';
import EntityInspectorShell from '../components/layout/EntityInspectorShell.vue';
import ViewState from '../components/ui/ViewState.vue';
import { useCardBrowserReadModel } from '../composables/useCardBrowserReadModel';

const route = useRoute();
const router = useRouter();

const cardStore = useCardStore();
const currentCardId = computed<string | null>(() => {
  const id = route.params.id as string;
  return id || null;
});

const {
  orderedCardTree,
  rootLoadState,
  effectiveExpandedTreeIds,
  representedSelectedAncestorIds,
  toggleTreeNode,
} = useCardBrowserReadModel(cardStore, () => currentCardId.value);

watch(currentCardId, (id) => { if (id) void cardStore.ensureRouteVisible(id); }, { immediate: true });
watch(() => cardStore.hierarchySlicesByParentId, (current, previous) => {
  const id = currentCardId.value;
  if (!id) return;
  const ancestors = new Set(cardRouteChain(id).slice(0, -1));
  if (Object.keys(current).some((parentId) => ancestors.has(parentId) && current[parentId] !== previous?.[parentId] && !cardStore.childrenLoadState(parentId).stale)) {
    void cardStore.ensureRouteVisible(id);
  }
}, { deep: false });

function retryRoot(): void { void cardStore.retryChildren('project').catch(() => {}); }
function retryChildren(id: string): void { void cardStore.retryChildren(id).catch(() => {}); }

function selectCard(id: string): void {
  router.push({ name: 'card-detail', params: { id } });
}

function backToCards(): void {
  router.push({ name: 'cards' });
}

</script>

<style scoped>
.cards-route { height: 100%; min-height: 0; overflow: hidden; }

.cards-md__tree { flex: 1; overflow-y: auto; min-height: 0; }
.cards-md__tree > :deep(.view-state) { padding: 24px; justify-content: center; text-align: center; }
</style>
