<template>
  <div class="timeline-layout">
    <div class="timeline-content">
      <ViewState v-if="loading" state="loading" title="Loading timeline" />
      <ViewState v-else-if="error" state="error" title="Could not load timeline" :message="error" />
      <CardsTimelineView v-else :cards="cards" @select="selectCard" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useRouter } from 'vue-router';
import CardsTimelineView from '../components/cards/CardsTimelineView.vue';
import ViewState from '../components/ui/ViewState.vue';
import { useCardStore } from '../stores/cards';

const router = useRouter();
const cardStore = useCardStore();
const { cards, loading, error } = storeToRefs(cardStore);

function selectCard(id: string): void {
  router.push({ name: 'card-detail', params: { id } });
}

onMounted(() => {
  cardStore.fetchCards().catch(() => {});
});
</script>

<style scoped>
.timeline-layout {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.timeline-content {
  flex: 1;
  overflow: hidden;
}

.timeline-content > :deep(.view-state) { padding: 32px; justify-content: center; text-align: center; }
</style>
