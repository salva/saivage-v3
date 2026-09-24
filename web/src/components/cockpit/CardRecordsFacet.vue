<template>
  <div class="records-facet" data-testid="facet-records">
    <CardRecordsSection :card-id="cardId" />
    <details class="records-history" open>
      <summary class="records-history-summary">Card versions &amp; publication history</summary>
      <CardHistoryPanel :card-id="cardId" />
    </details>
  </div>
</template>

<script setup lang="ts">
import CardRecordsSection from '../cards/CardRecordsSection.vue';
import CardHistoryPanel from '../cards/CardHistoryPanel.vue';

defineProps<{ cardId: string }>();
</script>

<style scoped>
.records-facet { display: flex; flex-direction: column; padding: 16px; gap: 16px; overflow-y: auto; }
.records-history { border-top: 1px solid var(--surface-3); padding-top: 12px; }
.records-history-summary { cursor: pointer; font-size: 13px; font-weight: 600; color: var(--text); }
</style>
