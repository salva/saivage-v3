<template>
  <article class="context-block" :class="`role-${entry.role}`" data-testid="context-block" :data-entry-id="entry.id">
    <details v-if="entry.role === 'system' && entry.kind === 'text'" class="recorded-system-context">
      <summary>Recorded system context</summary>
      <p>Role {{ entry.role }} · {{ entry.timestamp }} · {{ entry.id }}</p>
      <pre class="msg-body">{{ content }}</pre>
      <div v-if="entry.links?.length" class="msg-links"><button v-for="link in entry.links" :key="`${link.entity_type}:${link.entity_id}`" type="button" class="msg-link" @click="navigate(link)">{{ link.label ?? link.entity_id }}</button></div>
    </details>
    <template v-else>
      <MarkdownText class="msg-body" :source="content" />
      <div v-if="entry.links?.length" class="msg-links"><button v-for="link in entry.links" :key="`${link.entity_type}:${link.entity_id}`" type="button" class="msg-link" @click="navigate(link)">{{ link.label ?? link.entity_id }}</button></div>
    </template>
  </article>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import type { AgentConversationEntry } from '../../api/types';
import MarkdownText from '../content/MarkdownText.vue';
const props = defineProps<{ entry: AgentConversationEntry }>();
const content = computed(() => props.entry.kind === 'content_policy_refusal'
  ? `A prior activation ended after repeated provider content-policy refusal. Reassess the task decomposition and use only assistance the provider can give within its safety requirements. Operator evidence: /agents/${encodeURIComponent(props.entry.session_id)}?entry=${encodeURIComponent(props.entry.id)}.`
  : props.entry.content);
const router = useRouter();
type EntityLink = NonNullable<AgentConversationEntry['links']>[number];
function navigate(link: EntityLink): void {
  if (link.entity_type === 'card') void router.push({ name: 'card-detail', params: { id: link.entity_id } });
  else if (link.entity_type === 'process') void router.push({ name: 'debug', query: { tab: 'processes', process: link.entity_id } });
  else if (link.entity_type === 'artifact' || link.entity_type === 'attachment') void router.push({ name: 'files', query: { path: link.entity_id } });
}
</script>
<style scoped>
.context-block { padding:6px 10px; border-radius:6px; }
summary { cursor:pointer; font-size:12px; }
.recorded-system-context p { font-size:11px; color:var(--text-muted); overflow-wrap:anywhere; }
.recorded-system-context pre { white-space:pre-wrap; overflow-wrap:anywhere; margin:6px 0; }
.context-block.role-user { border-left:2px solid var(--accent-2); padding-left:10px; background:var(--entry-user-bg); }
.context-block.role-assistant { border-left:2px solid var(--accent); padding-left:10px; background:var(--entry-accent-bg); }
.context-block .msg-body { font-size:13px; line-height:1.55; color:var(--text); }
.msg-links { display:flex; gap:6px; flex-wrap:wrap; margin-top:6px; }
.msg-link { border:1px solid var(--border); background:var(--surface-2); color:var(--accent); border-radius:999px; padding:2px 8px; font:inherit; font-size:12px; cursor:pointer; }
</style>
