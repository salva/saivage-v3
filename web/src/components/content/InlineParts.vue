<template>
  <span class="inline-parts">
    <template v-for="(part, index) in parts" :key="index">
      <RouterLink
        v-if="part.kind === 'file'"
        class="inline-part inline-part-file"
        :title="part.path"
        :to="{ name: 'files', query: { root: part.root, path: part.path } }"
      >{{ part.label || part.path }}</RouterLink>
      <RouterLink
        v-else-if="part.kind === 'card'"
        class="inline-part inline-part-card"
        :to="{ name: 'card-detail', params: { id: part.id } }"
        :title="cardTitle(part.id)"
      >{{ cardLabel(part.id, part.fallbackLabel) }}</RouterLink>
      <RouterLink v-else-if="part.kind === 'session'" class="inline-part inline-part-card" :title="part.id" :to="{ name: 'agent-detail', params: { id: part.id } }">{{ part.label }}</RouterLink>
      <button v-else-if="part.kind === 'entry'" type="button" class="inline-part inline-part-entry" @click="revealEntry(part.id)">{{ part.label }}</button>
      <span v-else class="inline-part inline-part-text"><JsonText v-if="part.language === 'json'" :text="part.text" /><template v-else>{{ part.text }}</template></span>
    </template>
  </span>
</template>

<script setup lang="ts">
import type { InlinePart } from '../../utils/tool-presenters';
import JsonText from './JsonText.vue';
import { inject } from 'vue';
import { revealConversationEntry } from '../../composables/useAgentTimeline';

defineProps<{ parts: InlinePart[] }>();
const reveal = inject(revealConversationEntry, undefined);

function revealEntry(id: string): void {
  void reveal?.(id);
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
.inline-part-text :deep(.json-text) { white-space:pre-wrap; }
.inline-part-entry { border:0; background:transparent; color:var(--accent-2); cursor:pointer; font:inherit; padding:0; text-decoration:underline; }
.inline-part-file,.inline-part-card { color:var(--accent-2); text-decoration:none; border-bottom:1px solid color-mix(in srgb, var(--accent-2) 55%, transparent); }
.inline-part-file:hover,.inline-part-card:hover { color:var(--accent); border-bottom-color:var(--accent); }
</style>
