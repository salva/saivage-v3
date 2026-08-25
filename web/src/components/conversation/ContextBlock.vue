<template><article class="context-block" :class="`role-${entry.role}`" data-testid="context-block" :data-entry-id="entry.id"><MarkdownText class="msg-body" :source="entry.content" /><div v-if="entry.links?.length" class="msg-links"><button v-for="link in entry.links" :key="`${link.entity_type}:${link.entity_id}`" type="button" class="msg-link" @click="navigate(link)">{{ link.label ?? link.entity_id }}</button></div></article></template>
<script setup lang="ts">import { useRouter } from 'vue-router'; import type { AgentConversationEntry, EntityLink } from '../../api/types'; import MarkdownText from '../content/MarkdownText.vue'; defineProps<{ entry: AgentConversationEntry }>(); const router = useRouter(); function navigate(link: EntityLink): void { if (link.entity_type === 'card') void router.push({ name: 'card-detail', params: { id: link.entity_id } }); else if (link.entity_type === 'process') void router.push({ name: 'debug', query: { tab: 'processes', process: link.entity_id } }); else if (link.entity_type === 'artifact' || link.entity_type === 'attachment') void router.push({ name: 'files', query: { path: link.entity_id } }); }</script>
<style scoped>
.context-block { padding:6px 10px; border-radius:6px; }
.context-block.role-user { border-left:2px solid var(--accent-2); padding-left:10px; background:var(--entry-user-bg); }
.context-block.role-assistant { border-left:2px solid var(--accent); padding-left:10px; background:var(--entry-accent-bg); }
.context-block .msg-body { font-size:13px; line-height:1.55; color:var(--text); }
.msg-links { display:flex; gap:6px; flex-wrap:wrap; margin-top:6px; }
.msg-link { border:1px solid var(--border); background:var(--surface-2); color:var(--accent); border-radius:999px; padding:2px 8px; font:inherit; font-size:12px; cursor:pointer; }
</style>
