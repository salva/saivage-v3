<template>
  <article class="record-doc">
    <header class="record-doc__head">
      <code class="record-doc__name">{{ name }}</code>
      <span v-if="humanLabel" class="record-doc__label">{{ humanLabel }}</span>
      <span v-if="version !== null && version !== undefined" class="record-doc__version">v{{ version }}</span>
      <span v-if="writer" class="record-doc__writer">{{ writer }}</span>
    </header>
    <div class="record-doc__body">
      <slot />
    </div>
  </article>
</template>

<script setup lang="ts">
defineProps<{ name: string; humanLabel?: string; version?: number | null; writer?: string | null }>();
</script>

<style scoped>
.record-doc { border: 1px solid var(--surface-3); border-left: 3px solid var(--surface-3); border-radius: 6px; background: var(--surface-1); }
.record-doc__head { display: flex; align-items: baseline; gap: 8px; padding: 6px 12px; border-bottom: 1px solid var(--surface-3); background: var(--surface-2); flex-wrap: wrap; }
.record-doc__name { font-family: 'SF Mono', monospace; font-size: 11px; color: var(--text-muted); }
.record-doc__label { font-size: 12px; font-weight: 600; color: var(--text); }
.record-doc__version { font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border); color: var(--text-muted); }
.record-doc__writer { font-size: 11px; color: var(--text-muted); margin-left: auto; }
.record-doc__body { padding: 10px 14px; font-size: 13px; line-height: 1.55; color: var(--text); }
.record-doc__body :deep(.markdown-text > *:first-child) { margin-top: 0; }
.record-doc__body :deep(.markdown-text > *:last-child) { margin-bottom: 0; }
</style>
