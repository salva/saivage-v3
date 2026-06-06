<template><section class="compacted-cluster"><strong>Compacted context</strong><p v-for="entry in entries" :key="entry.id">{{ entry.content }}</p></section></template>
<script setup lang="ts">import type { AgentConversationEntry } from '../../api/types'; defineProps<{ entries: AgentConversationEntry[] }>();</script>
<style scoped>.compacted-cluster{border:1px dashed var(--border);border-radius:10px;padding:10px;color:var(--text-muted);font-size:12px;}.compacted-cluster p{white-space:pre-wrap;}</style>
