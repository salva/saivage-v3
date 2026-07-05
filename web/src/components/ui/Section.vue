<template>
  <section class="section" :class="{ 'section--first': first }">
    <header v-if="title || $slots.meta" class="section__head">
      <h2 v-if="title" class="section__title">{{ title }}</h2>
      <div v-if="$slots.meta" class="section__meta"><slot name="meta" /></div>
    </header>
    <div class="section__body"><slot /></div>
  </section>
</template>

<script setup lang="ts">
defineProps<{ title?: string; first?: boolean }>();
</script>

<style scoped>
.section { padding: 16px 0; border-top: 1px solid var(--surface-3); }
.section--first { border-top: 0; padding-top: 0; }
.section__head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.section__title { font-size: 13px; font-weight: 600; color: var(--text); margin: 0; }
.section__meta { font-size: 12px; color: var(--text-muted); display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
</style>
