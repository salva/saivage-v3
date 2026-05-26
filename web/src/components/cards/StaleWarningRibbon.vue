<template>
  <div v-if="cardsStore.isStale(cardId)" class="stale-warning-ribbon" role="status">
    <strong>Card update available.</strong>
    <span>This card changed after the current detail snapshot loaded. Refresh card history before trusting the completion state.</span>
  </div>
</template>

<script setup lang="ts">
import { useCardStore } from '../../stores/cards';

defineProps<{ cardId: string }>();

const cardsStore = useCardStore();
</script>

<style scoped>
.stale-warning-ribbon {
  margin: 0 0 12px 0;
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid var(--entry-warn-border);
  background: var(--entry-warn-bg);
  color: var(--warn);
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
</style>
