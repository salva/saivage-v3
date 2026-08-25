<template>
  <section class="ui-panel" :class="{ 'ui-panel--padded': padded, 'ui-panel--scroll': scroll }">
    <slot />
  </section>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  padded?: boolean;
  scroll?: boolean;
}>(), { padded: true, scroll: false });
</script>

<style scoped>
.ui-panel { background:var(--surface-1); border:1px solid var(--border); border-radius:8px; }
.ui-panel--padded { padding:16px; }
.ui-panel--scroll { overflow:auto; }
</style>
