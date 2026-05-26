<template>
  <section class="ui-card" :class="{ 'ui-card--padded': padded }"><slot /></section>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ padded?: boolean }>(), { padded: true });
</script>

<style scoped>
.ui-card { background:var(--surface-1); border:1px solid var(--border); border-radius:8px; }
.ui-card--padded { padding:16px; }
</style>
