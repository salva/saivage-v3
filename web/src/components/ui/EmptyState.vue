<template>
  <div class="empty-state" role="status">
    <span class="empty-state__message">{{ message }}</span>
    <span v-if="$slots.action" class="empty-state__action"><slot name="action" /></span>
  </div>
</template>

<script setup lang="ts">
defineProps<{ message: string }>();
</script>

<style scoped>
.empty-state { font-size: 13px; color: var(--text-muted); display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.empty-state__action { font-size: 12px; }
</style>
