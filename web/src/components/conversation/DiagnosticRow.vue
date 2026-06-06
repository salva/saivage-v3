<template><div class="diagnostic-row">{{ entry.content }}</div></template>
<script setup lang="ts">import type { AgentConversationEntry } from '../../api/types'; defineProps<{ entry: AgentConversationEntry }>();</script>
<style scoped>.diagnostic-row{padding:8px 10px;border:1px solid var(--entry-warn-border);background:var(--entry-warn-bg);color:var(--warn);border-radius:8px;font-size:12px;}</style>
