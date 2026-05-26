<template>
  <header class="ui-panel-heading">
    <div class="ui-panel-heading__body">
      <h3 class="ui-panel-heading__title"><slot name="title">{{ title }}</slot></h3>
      <p v-if="$slots.description || description" class="ui-panel-heading__description"><slot name="description">{{ description }}</slot></p>
    </div>
    <div v-if="$slots.actions" class="ui-panel-heading__actions"><slot name="actions" /></div>
  </header>
</template>

<script setup lang="ts">
defineProps<{ title?: string; description?: string }>();
</script>

<style scoped>
.ui-panel-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
.ui-panel-heading__title { margin:0; font-size:13px; font-weight:600; color:var(--text); }
.ui-panel-heading__description { margin:4px 0 0; font-size:12px; color:var(--text-muted); line-height:1.5; }
.ui-panel-heading__actions { display:flex; gap:8px; flex-shrink:0; }
</style>
