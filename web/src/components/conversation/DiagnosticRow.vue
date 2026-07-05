<template>
  <div class="diagnostic-row" :class="severity">
    <span class="diagnostic-label">{{ label }}</span>
    {{ entry.content }}
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { AgentConversationEntry } from '../../types/view-models';

const props = defineProps<{ entry: AgentConversationEntry }>();

const severity = computed<'warn' | 'success' | 'neutral'>(() => {
  if (props.entry.kind === 'model_issue') return 'warn';
  if (props.entry.kind === 'model_recovered' || props.entry.kind === 'model_repair') return 'success';
  return 'neutral';
});

const label = computed(() => {
  if (props.entry.kind === 'model_issue') return 'Issue';
  if (props.entry.kind === 'model_recovered') return 'Recovered';
  if (props.entry.kind === 'model_repair') return 'Repaired';
  if (props.entry.kind === 'context_compaction') return 'Compacted';
  return props.entry.kind;
});
</script>

<style scoped>
.diagnostic-row { padding:var(--space-3) var(--space-4); border-radius:var(--radius-sm); font-size:var(--font-size-md); }
.diagnostic-label { font-weight:600; text-transform:uppercase; font-size:var(--font-size-xs); margin-right:var(--space-3); }
.diagnostic-row.warn { border:1px solid var(--entry-warn-border); background:var(--entry-warn-bg); color:var(--warn); }
.diagnostic-row.success { border:1px solid var(--entry-accent-border); background:var(--entry-accent-bg); color:var(--accent); }
.diagnostic-row.neutral { border:1px solid var(--surface-3); background:var(--surface-1); color:var(--text-muted); }
</style>
