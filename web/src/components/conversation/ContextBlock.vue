<template><component :is="isSystemPrompt ? 'details' : 'article'" class="context-block" :class="`role-${entry.role}`" data-testid="context-block"><summary v-if="isSystemPrompt" class="context-role">System prompt</summary><MarkdownText class="msg-body" :source="entry.content" /><div v-if="entry.links?.length" class="msg-links"><button v-for="link in entry.links" :key="`${link.entity_type}:${link.entity_id}`" type="button" class="msg-link" @click="navigate(link)">{{ link.label ?? link.entity_id }}</button></div></component></template>
<script setup lang="ts">import { computed } from 'vue'; import { useRouter } from 'vue-router'; import type { AgentConversationEntry, EntityLink } from '../../types/view-models'; import MarkdownText from '../content/MarkdownText.vue'; const props = defineProps<{ entry: AgentConversationEntry }>(); const router = useRouter(); const isSystemPrompt = computed(() => props.entry.kind === 'system_prompt'); function navigate(link: EntityLink): void { if (link.entity_type === 'card') void router.push({ name: 'card-detail', params: { id: link.entity_id } }); else if (link.entity_type === 'process') void router.push({ name: 'debug', query: { tab: 'processes', process: link.entity_id } }); else if (link.entity_type === 'artifact' || link.entity_type === 'attachment') void router.push({ name: 'files', query: { path: link.entity_id } }); }</script>
<style scoped>
.context-block { padding:6px 10px; border-radius:6px; }
.context-block.role-user { border-left:2px solid var(--accent-2); padding-left:10px; background:var(--entry-user-bg); }
.context-block.role-assistant { border-left:2px solid var(--accent); padding-left:10px; background:var(--entry-accent-bg); }
details.context-block:not([open]) .msg-body { display:none; }
.context-role { font-size:11px; font-weight:600; color:var(--text-muted); margin-bottom:4px; cursor:pointer; text-transform:capitalize; user-select:none; }
.context-block .msg-body { font-size:13px; line-height:1.55; color:var(--text); }
.msg-links { display:flex; gap:6px; flex-wrap:wrap; margin-top:6px; }
.msg-link { border:1px solid var(--border); background:var(--surface-2); color:var(--accent); border-radius:999px; padding:2px 8px; font:inherit; font-size:12px; cursor:pointer; }
details.context-block > summary { list-style:none; }
details.context-block > summary::-webkit-details-marker { display:none; }
details.context-block > summary::before { content:'▸ '; }
details.context-block[open] > summary::before { content:'▾ '; }
</style>
