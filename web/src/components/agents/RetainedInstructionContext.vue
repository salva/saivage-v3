<template>
  <details v-if="context" class="retained-instructions" data-testid="retained-instruction-context">
    <summary>Retained instructions ({{ context.protected_prompts.length }})</summary>
    <p>Covered instructions are retained separately; their original adjacency to summarized prose is not preserved.</p>
    <ol>
      <li v-for="entry in context.protected_prompts" :key="`${entry.source.segment_version}:${entry.source.row_index}:${entry.message.id}`">
        <details><summary>Segment {{ entry.source.segment_version }}, row {{ entry.source.row_index }} · {{ entry.message.id }}</summary>
        <pre><JsonText :text="metadata(entry.message)" /></pre>
        <pre>{{ entry.message.content }}</pre>
        <span class="declaration">compactable: false<span v-if="entry.message.context_policy.kind === 'content' && entry.message.context_policy.compaction_key !== undefined"> · key: {{ entry.message.context_policy.compaction_key }}</span></span>
        </details>
      </li>
    </ol>
  </details>
</template>
<script setup lang="ts">
import type { AgentConversationEntry, AgentConversationResponse } from '../../api/types';
import JsonText from '../content/JsonText.vue';
defineProps<{ context: AgentConversationResponse['segment_context'] }>();
function metadata(message: AgentConversationEntry): string {
  const { content: _content, ...recorded } = message;
  return JSON.stringify(recorded, null, 2);
}
</script>
<style scoped>
.retained-instructions { font-size: 15px; line-height:1.5; color:var(--text); }
summary { cursor: pointer; overflow-wrap: anywhere; }
.retained-instructions p { margin: 0; color: var(--text); }
.retained-instructions ol { display: grid; gap: 8px; margin: 0; padding-left: 22px; }
.retained-instructions pre { margin: 3px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.declaration { color: var(--text); }
</style>
