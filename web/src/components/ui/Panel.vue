<template>
  <component :is="as" class="ui-panel" :class="{ 'ui-panel--padded': padded, 'ui-panel--scroll': scroll }">
    <slot />
  </component>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  as?: 'section' | 'div' | 'aside';
  padded?: boolean;
  scroll?: boolean;
}>(), { as: 'section', padded: true, scroll: false });
</script>

<style scoped>
.ui-panel { background:var(--surface-1); border:1px solid var(--border); border-radius:8px; }
.ui-panel--padded { padding:16px; }
.ui-panel--scroll { overflow:auto; }
</style>
