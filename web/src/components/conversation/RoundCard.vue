<template>
  <section class="round-card" data-testid="round-card" :class="`round-${round.kind}`">
    <CompactedCluster v-if="round.kind === 'compacted'" :entries="round.entries" />
    <template v-else>
      <header v-if="showHeader" class="round-head">{{ round.kind }}<span class="round-position"> · {{ round.position }}</span></header>
      <ContextBlock v-for="entry in round.texts" :key="entry.id" :entry="entry" />
      <DiagnosticRow v-for="entry in round.diagnostics" :key="entry.id" :entry="entry" />
      <template v-for="item in round.items" :key="itemKey(item)">
        <ToolGroupRow v-if="isToolGroup(item)" :group="item" :expanded-ids="expandedIds" @toggle="$emit('toggle', $event)" />
        <ToolChip
          v-else
          :display="buildToolDisplay(item)"
          :call-content="item.call.content"
          :result-content="item.result?.content ?? null"
          :expanded="expandedIds.has(item.call.id)"
          :details-id="`tool-${item.call.id}`"
          :timestamp="item.call.timestamp"
          @toggle="$emit('toggle', item.call.id)"
        />
      </template>
      <PendingCallFooter v-if="round.activityStatus" :calls="round.activityStatus.pending_calls" :status="round.activityStatus.status" />
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { TimelineRound, ToolListItem } from '../../utils/agent-timeline';
import { isToolGroup, buildToolDisplay } from '../../utils/tool-friendly';
import ToolChip from './ToolChip.vue';
import ToolGroupRow from './ToolGroupRow.vue';
import DiagnosticRow from './DiagnosticRow.vue';
import PendingCallFooter from './PendingCallFooter.vue';
import CompactedCluster from './CompactedCluster.vue';
import ContextBlock from './ContextBlock.vue';

const props = defineProps<{ round: TimelineRound; expandedIds: Set<string> }>();
defineEmits<{ (event: 'toggle', id: string): void }>();
function itemKey(item: ToolListItem): string { return isToolGroup(item) ? item.id : item.call.id; }

const showHeader = computed(() => props.round.kind !== 'compacted');
</script>
<style scoped>
.round-card { display:flex; flex-direction:column; gap:6px; padding:4px 0; }
.round-card.round-user { padding-top:10px; border-top:1px solid var(--surface-3); }
.round-card.round-assistant { padding-top:8px; border-top:1px solid var(--surface-3); }
.round-card.round-diagnostic { padding-top:8px; }
.round-head { font-size:11px; font-weight:600; color:var(--text-muted); text-transform:capitalize; }
.round-card.round-assistant .round-head { font-weight:500; opacity:.85; }
.round-head .round-position { color:var(--border-strong); font-weight:400; }
</style>
