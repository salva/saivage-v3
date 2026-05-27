<template>
  <section class="round-card" :class="`round-${round.kind}`">
    <CompactedCluster v-if="round.kind === 'compacted'" :entries="round.entries" />
    <template v-else>
      <header class="round-head">{{ round.kind }} round {{ round.ordinal }}</header>
      <ContextBlock v-for="entry in round.texts" :key="entry.id" :entry="entry" />
      <DiagnosticRow v-for="entry in round.diagnostics" :key="entry.id" :entry="entry" />
      <ToolChip v-for="pair in round.toolPairs" :key="pair.call.id" v-bind="toolPairProps(pair)" :expanded="expandedIds.has(pair.call.id)" @toggle="$emit('toggle', pair.call.id)" />
      <PendingCallFooter v-if="round.activityStatus" :calls="round.activityStatus.pending_calls" />
    </template>
  </section>
</template>
<script setup lang="ts">
import type { TimelineRound, ToolPair } from '../../utils/agent-timeline';
import { presentToolCall, presentToolResult } from '../../utils/tool-presenters';
import ToolChip from './ToolChip.vue';
import DiagnosticRow from './DiagnosticRow.vue';
import PendingCallFooter from './PendingCallFooter.vue';
import CompactedCluster from './CompactedCluster.vue';
import ContextBlock from './ContextBlock.vue';
defineProps<{ round: TimelineRound; expandedIds: Set<string> }>();
defineEmits<{ (event: 'toggle', id: string): void }>();
function toolPairProps(pair: ToolPair) { return { call: presentToolCall(pair.call.content, pair.call.tool), result: pair.result ? presentToolResult(pair.result.content, { tool: pair.result.tool, kind: pair.result.kind }) : null, callContent: pair.call.content, resultContent: pair.result?.content ?? null, status: pair.status, detailsId: `tool-${pair.call.id}`, timestamp: pair.call.timestamp }; }
</script>
<style scoped>.round-card{display:flex;flex-direction:column;gap:8px;border:1px solid var(--border);border-radius:12px;padding:12px;background:var(--bg);}.round-head{font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;}</style>
