<template>
  <span class="inline-parts">
    <template v-for="(part, index) in parts" :key="index">
      <RouterLink
        v-if="part.kind === 'file'"
        class="inline-part inline-part-file"
        :to="{ name: 'files', query: { root: part.root, path: part.path } }"
      >{{ part.label || part.path }}</RouterLink>
      <RouterLink
        v-else-if="part.kind === 'card'"
        class="inline-part inline-part-card"
        :to="{ name: 'card-detail', params: { id: part.id } }"
        :title="cardTitle(part.id)"
      >{{ cardLabel(part.id, part.fallbackLabel) }}</RouterLink>
      <RouterLink v-else-if="part.kind === 'session'" class="inline-part inline-part-card" :to="{ name: 'agent-detail', params: { id: part.id } }">{{ part.label }}</RouterLink>
      <button v-else-if="part.kind === 'entry'" type="button" class="inline-part inline-part-entry" @click="revealEntry($event, part.id)">{{ part.label }}</button>
      <span v-else class="inline-part inline-part-text">{{ part.text }}</span>
    </template>
  </span>
</template>

<script setup lang="ts">
import type { InlinePart } from '../../utils/tool-presenters';

defineProps<{ parts: InlinePart[] }>();

function revealEntry(event: MouseEvent, id: string): void {
  const timeline = (event.currentTarget as HTMLElement).closest('.conversation-timeline');
  const row = [...(timeline?.querySelectorAll<HTMLElement>('[data-entry-id]') ?? [])].find((element) => element.dataset.entryId === id);
  if (!row) return;
  row.tabIndex = -1;
  row.scrollIntoView({ block: 'center' });
  row.focus({ preventScroll: true });
}

function cardLabel(id: string, fallbackLabel?: string): string {
  return fallbackLabel ?? id;
}

function cardTitle(id: string): string {
  return id;
}
</script>

<style scoped>
.inline-parts { display:inline-flex; align-items:baseline; gap:4px; min-width:0; }
.inline-part { min-width:0; overflow-wrap:anywhere; }
.inline-part-entry { border:0; background:transparent; color:var(--accent-2); cursor:pointer; font:inherit; padding:0; text-decoration:underline; }
.inline-part-file,.inline-part-card { color:var(--accent-2); text-decoration:none; border-bottom:1px solid color-mix(in srgb, var(--accent-2) 55%, transparent); }
.inline-part-file:hover,.inline-part-card:hover { color:var(--accent); border-bottom-color:var(--accent); }
</style>
