<template>
  <article class="document-frame">
    <header class="document-frame__header">
      <div class="document-frame__identity">
        <code v-if="name" class="document-frame__name">{{ name }}</code>
        <h3 class="document-frame__title">{{ title }}</h3>
      </div>
      <div v-if="version !== null || writer || timestamp" class="document-frame__meta">
        <span v-if="version !== null" class="document-frame__pill">v{{ version }}</span>
        <span v-if="writer" class="document-frame__writer">{{ writer }}</span>
        <time v-if="timestamp" class="document-frame__time" :datetime="timestamp">{{ timestamp }}</time>
      </div>
    </header>
    <div class="document-frame__body">
      <slot />
    </div>
  </article>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  title: string;
  name?: string | null;
  version?: number | string | null;
  writer?: string | null;
  timestamp?: string | null;
}>(), {
  name: null,
  version: null,
  writer: null,
  timestamp: null,
});
</script>

<style scoped>
.document-frame { border:1px solid var(--surface-3); border-left:3px solid var(--surface-3); border-radius:6px; background:var(--surface-1); overflow:hidden; }
.document-frame__header { display:flex; align-items:baseline; justify-content:space-between; gap:12px; padding:6px 12px; border-bottom:1px solid var(--surface-3); background:var(--surface-2); flex-wrap:wrap; }
.document-frame__identity { display:flex; align-items:baseline; gap:8px; min-width:0; flex-wrap:wrap; }
.document-frame__name { font-family:'SF Mono',monospace; font-size:11px; color:var(--text-muted); }
.document-frame__title { margin:0; font-size:12px; font-weight:600; color:var(--text); }
.document-frame__meta { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-left:auto; font-size:11px; color:var(--text-muted); }
.document-frame__pill { font-size:10px; padding:1px 6px; border-radius:999px; border:1px solid var(--border); color:var(--text-muted); }
.document-frame__writer, .document-frame__time { color:var(--text-muted); }
.document-frame__body { padding:10px 14px; font-size:13px; line-height:1.55; color:var(--text); }
.document-frame__body :deep(.markdown-text > *:first-child) { margin-top:0; }
.document-frame__body :deep(.markdown-text > *:last-child) { margin-bottom:0; }
</style>
