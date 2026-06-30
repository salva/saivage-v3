<template>
  <div class="timeline-layout">
    <div class="timeline-content">
      <div v-if="loading" class="timeline-loading">Loading timeline...</div>
      <div v-else-if="error" class="timeline-error">{{ error }}</div>
      <CardsTimelineView v-else :cards="cards" @select="selectCard" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useRouter } from 'vue-router';
import CardsTimelineView from '../components/cards/CardsTimelineView.vue';
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

.timeline-loading,
.timeline-error {
  padding: 32px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.timeline-error { color: var(--danger); }
</style>
