<template>
  <details class="compacted-cluster">
    <summary class="compacted-summary"><span class="compacted-label">Compacted context</span><span class="compacted-count">{{ entries.length }} entries</span><span class="compacted-breakdown">{{ breakdown }}</span></summary>
    <ul class="compacted-list">
      <li v-for="entry in visibleEntries" :key="entry.id" class="compacted-item">
        <span class="compacted-role" :class="`role-${entry.role}`">{{ entry.role }}</span>
        <span class="compacted-kind">{{ entry.kind }}</span>
        <span class="compacted-preview">{{ preview(entry.content) }}</span>
      </li>
      <li v-if="hiddenCount > 0" class="compacted-more">{{ hiddenCount }} more compacted entries hidden</li>
    </ul>
  </details>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { AgentConversationEntry } from '../../types/view-models';

const props = defineProps<{ entries: AgentConversationEntry[] }>();
const VISIBLE_ENTRY_LIMIT = 5;
const PREVIEW_CHARACTER_LIMIT = 96;

const visibleEntries = computed(() => props.entries.slice(0, VISIBLE_ENTRY_LIMIT));
const hiddenCount = computed(() => Math.max(0, props.entries.length - VISIBLE_ENTRY_LIMIT));
const breakdown = computed(() => {
  const roleCounts = new Map<string, number>();
  for (const entry of props.entries) roleCounts.set(entry.role, (roleCounts.get(entry.role) ?? 0) + 1);
  return [...roleCounts.entries()].map(([role, count]) => `${count} ${role}`).join(' / ');
});

function preview(content: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  return oneLine.length > PREVIEW_CHARACTER_LIMIT ? `${oneLine.slice(0, PREVIEW_CHARACTER_LIMIT)}...` : oneLine;
}
</script>
<style scoped>
.compacted-cluster { border:1px solid var(--surface-3); border-radius:8px; padding:6px 10px; color:var(--text-muted); font-size:12px; }
.compacted-summary { list-style:none; cursor:pointer; display:flex; gap:8px; align-items:baseline; }
.compacted-summary::-webkit-details-marker { display:none; }
.compacted-summary::before { content:'▸'; color:var(--text-muted); }
.compacted-cluster[open] .compacted-summary::before { content:'▾'; }
.compacted-label { color:var(--text); font-weight:600; }
.compacted-count { color:var(--text-muted); }
.compacted-breakdown { color:var(--border-strong); }
.compacted-list { list-style:none; margin:8px 0 0; padding:0; display:flex; flex-direction:column; gap:4px; }
.compacted-item { display:flex; gap:8px; align-items:baseline; min-width:0; }
.compacted-role { font-size:10px; text-transform:capitalize; color:var(--text-muted); flex-shrink:0; }
.compacted-role.role-user { color:var(--accent-2); }
.compacted-role.role-assistant { color:var(--accent); }
.compacted-kind { font-size:10px; color:var(--border-strong); flex-shrink:0; }
.compacted-preview { color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.compacted-more { color:var(--border-strong); font-size:11px; padding-top:2px; }
</style>
