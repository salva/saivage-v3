<template>
  <div class="conversation-timeline">
    <div v-if="timeline.modelLabel" class="timeline-model" data-testid="timeline-model">via {{ timeline.modelLabel }}</div>
    <section
      v-for="(round, index) in timeline.rounds"
      :key="round.id"
      class="round-card"
      data-testid="round-card"
      :class="[`round-${round.kind}`, { 'continues-author': !isAuthorBoundary(index) }]"
    >
      <CompactedCluster v-if="round.kind === 'compacted'" :entries="round.entries" />
      <template v-else>
        <header v-if="isAuthorBoundary(index)" class="round-head">{{ round.kind }}<span class="round-position"> · {{ round.position }}</span></header>
        <ContextBlock v-for="entry in round.texts" :key="entry.id" :entry="entry" />
        <DiagnosticRow v-for="entry in round.diagnostics" :key="entry.id" :entry="entry" />
        <template v-for="item in round.items" :key="itemKey(item)">
          <ToolGroupRow v-if="isToolGroup(item)" :group="item" :expanded-ids="expandedIds" @toggle="emit('toggle', $event)" />
          <ToolChip
            v-else
            :display="buildToolDisplay(item)"
            :call-content="item.call.content"
            :result-content="item.result?.content ?? null"
            :expanded="expandedIds.has(item.call.id)"
            :details-id="`tool-${item.call.id}`"
            :timestamp="item.call.timestamp"
            @toggle="emit('toggle', item.call.id)"
          />
        </template>
        <PendingCallFooter v-if="round.activityStatus" :calls="round.activityStatus.pending_calls" :status="round.activityStatus.status" />
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import type { AgentTimeline, ToolListItem } from '../../utils/agent-timeline';
import { buildToolDisplay, isToolGroup } from '../../utils/tool-friendly';
import CompactedCluster from './CompactedCluster.vue';
import ContextBlock from './ContextBlock.vue';
import DiagnosticRow from './DiagnosticRow.vue';
import PendingCallFooter from './PendingCallFooter.vue';
import ToolChip from './ToolChip.vue';
import ToolGroupRow from './ToolGroupRow.vue';

const props = defineProps<{ timeline: AgentTimeline; expandedIds: Set<string> }>();
const emit = defineEmits<{ toggle: [id: string] }>();

function itemKey(item: ToolListItem): string { return isToolGroup(item) ? item.id : item.call.id; }
function isAuthorBoundary(index: number): boolean {
  if (index <= 0) return true;
  return props.timeline.rounds[index - 1].kind !== props.timeline.rounds[index].kind;
}
</script>

<style scoped>
.conversation-timeline { display:flex; flex-direction:column; gap:12px; }
.timeline-model { align-self:flex-start; font-size:11px; color:var(--text-muted); font-family:'SF Mono',monospace; background:var(--surface-2); border:1px solid var(--surface-3); border-radius:999px; padding:2px 8px; }
.round-card { display:flex; flex-direction:column; gap:6px; padding:4px 0; }
.round-card.round-user { padding-top:10px; border-top:1px solid var(--surface-3); }
.round-card.round-assistant { padding-top:8px; border-top:1px solid var(--surface-3); }
.round-card.round-diagnostic { padding-top:8px; }
.round-card.continues-author { padding-top:0; border-top:none; }
.round-head { font-size:11px; font-weight:600; color:var(--text-muted); text-transform:capitalize; }
.round-card.round-assistant .round-head { font-weight:500; opacity:.85; }
.round-head .round-position { color:var(--border-strong); font-weight:400; }
</style>
