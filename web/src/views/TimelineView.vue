<template>
  <div class="timeline-layout">
    <div class="timeline-header">
      <div>
        <h1 class="timeline-title">Timeline</h1>
        <p class="timeline-subtitle">Recent card activity ordered by the latest card timestamp.</p>
      </div>
      <router-link class="cards-link" :to="{ name: 'cards' }">Back to Card Tree</router-link>
    </div>

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

.timeline-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  background: var(--surface-1);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.timeline-title {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  color: var(--text);
}

.timeline-subtitle {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}

.cards-link {
  color: var(--accent-2);
  font-size: 12px;
  text-decoration: none;
  white-space: nowrap;
}

.cards-link:hover { text-decoration: underline; }

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
