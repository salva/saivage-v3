<template>
  <div class="diagnostic-anchor" :data-entry-id="entry.id" tabindex="-1">
  <details class="diagnostic-row" :class="{ warn: entry.kind !== 'model_repair' }">
    <summary tabindex="0"><strong>{{ label }}</strong><span v-if="entry.kind === 'model_issue'"> · {{ excerpt }}</span></summary>
    <p>{{ entry.role }} · {{ entry.timestamp }} · {{ entry.id }} · source {{ entry.round_id }}, message {{ entry.message_index }}, block {{ entry.block_index }}</p>
    <pre>{{ entry.content }}</pre>
  </details>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { AgentConversationEntry } from '../../api/types';
const props = defineProps<{ entry: AgentConversationEntry }>();
const label = computed(() => props.entry.kind === 'model_issue' ? 'Model issue' : props.entry.kind === 'model_repair' ? 'Repair instruction recorded' : 'Interrupted activation · effects uncertain');
const excerpt = computed(() => { const text = props.entry.content.replace(/\s+/g, ' ').trim(); return text.length > 160 ? `${text.slice(0, 160)}…` : text; });
</script>
<style scoped>
.diagnostic-row { padding:10px 12px; border:1px solid var(--border-strong); border-radius:4px; background:var(--surface-1); color:var(--text); font-size:15px; line-height:1.5; overflow-wrap:anywhere; }
.diagnostic-row.warn { border-left:3px solid var(--warn); }
summary { cursor:pointer; }
summary:focus-visible { outline:2px solid var(--text); }
pre { white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; }
</style>
