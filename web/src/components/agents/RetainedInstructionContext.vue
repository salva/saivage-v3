<template>
  <section v-if="context?.protected_prompts.length" class="retained-instructions" data-testid="retained-instruction-context">
    <strong>Retained instruction context</strong>
    <p>Covered instructions are retained separately; their original adjacency to summarized prose is not preserved.</p>
    <ol>
      <li v-for="entry in context.protected_prompts" :key="`${entry.source.segment_version}:${entry.source.row_index}:${entry.message.id}`">
        <span class="provenance">Segment {{ entry.source.segment_version }}, row {{ entry.source.row_index }}</span>
        <pre>{{ entry.message.content }}</pre>
        <span class="declaration">compactable: false<span v-if="entry.message.context_policy.kind === 'content' && entry.message.context_policy.compaction_key !== undefined"> · key: {{ entry.message.context_policy.compaction_key }}</span></span>
      </li>
    </ol>
  </section>
</template>
<script setup lang="ts">
import type { AgentConversationResponse } from '../../api/types';
defineProps<{ context: AgentConversationResponse['segment_context'] }>();
</script>
<style scoped>
.retained-instructions { display: grid; gap: 6px; margin: 10px 16px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-2); font-size: 12px; }
.retained-instructions p { margin: 0; color: var(--text-muted); }
.retained-instructions ol { display: grid; gap: 8px; margin: 0; padding-left: 22px; }
.retained-instructions pre { margin: 3px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.provenance, .declaration { color: var(--text-muted); }
</style>
