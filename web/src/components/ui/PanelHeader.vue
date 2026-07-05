<template>
  <header class="ui-panel-header">
    <div class="ui-panel-header__body">
      <h2 :id="titleId" class="ui-panel-header__title">{{ title }}</h2>
      <p v-if="subtitle" class="ui-panel-header__subtitle">{{ subtitle }}</p>
      <div v-if="$slots.meta" class="ui-panel-header__meta"><slot name="meta" /></div>
    </div>
    <div v-if="$slots.actions" class="ui-panel-header__actions"><slot name="actions" /></div>
  </header>
</template>

<script setup lang="ts">
defineProps<{ title: string; subtitle?: string; titleId?: string }>();
</script>

<style scoped>
.ui-panel-header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:12px; }
.ui-panel-header__body { min-width:0; }
.ui-panel-header__title { margin:0; font-size:14px; font-weight:700; color:var(--text); }
.ui-panel-header__subtitle { margin:4px 0 0; font-size:12px; color:var(--text-muted); }
.ui-panel-header__meta { margin-top:6px; }
.ui-panel-header__actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
</style>
