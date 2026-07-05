<template>
  <div class="diagnostic-row" :class="severity">{{ entry.content }}</div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { AgentConversationEntry } from '../../types/view-models';

const props = defineProps<{ entry: AgentConversationEntry }>();

const severity = computed<'warn' | 'neutral'>(() =>
  props.entry.kind === 'model_issue' ? 'warn' : 'neutral',
);
</script>

<style scoped>
.diagnostic-row { padding:6px 10px; border-radius:6px; font-size:12px; }
.diagnostic-row.warn { border:1px solid var(--entry-warn-border); background:var(--entry-warn-bg); color:var(--warn); }
.diagnostic-row.neutral { border:1px solid var(--surface-3); background:var(--surface-1); color:var(--text-muted); }
</style>
