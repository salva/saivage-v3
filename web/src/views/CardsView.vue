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
          <ViewState v-if="collectionLoading" state="loading" title="Loading cards" />
          <ViewState v-else-if="collectionError" state="error" title="Could not load cards" :message="collectionError" />
          <CardsTreeView
            v-else
            :cards="orderedCards"
            :tree="orderedCardTree"
            :expanded-ids="effectiveExpandedTreeIds"
            :selected-card-id="currentCardId"
            @toggle="toggleTreeNode"
            @select="selectCard"
          />
        </div>
      </template>

      <template #detail>
        <CardDetailView v-if="currentCardId" :card-id="currentCardId" @navigate="handleNavigate" />
      </template>
    </EntityInspectorShell>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useCardStore } from '../stores/cards';
import CardsTreeView from '../components/cards/CardsTreeView.vue';
import CardDetailView from '../components/cards/CardDetailView.vue';
import EntityInspectorShell from '../components/layout/EntityInspectorShell.vue';
import ViewState from '../components/ui/ViewState.vue';
import { useCardBrowserReadModel } from '../composables/useCardBrowserReadModel';

const route = useRoute();
const router = useRouter();

const cardStore = useCardStore();
const {
  orderedCards,
  orderedCardTree,
  collectionLoading,
  collectionError,
  effectiveExpandedTreeIds,
  toggleTreeNode,
} = useCardBrowserReadModel(cardStore);

const currentCardId = computed<string | null>(() => {
  const id = route.params.id as string;
  return id || null;
});

function selectCard(id: string): void {
  router.push({ name: 'card-detail', params: { id } });
}

function handleNavigate(id: string): void {
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
