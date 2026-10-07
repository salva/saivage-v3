<template>
  <div class="conversation-timeline">
    <section
      v-for="(round, index) in timeline.rounds"
      :key="round.id"
      class="round-card"
      data-testid="round-card"
      :class="[`round-${round.kind}`, { 'continues-author': !isAuthorBoundary(index) }]"
    >
      <CompactedCluster v-if="round.kind === 'compacted'" :entries="round.entries" />
      <template v-else>
        <header v-if="isAuthorBoundary(index)" class="round-head">
          {{ round.kind }}<span class="round-position"> — turn {{ round.position }}</span>
        </header>
        <template v-for="row in round.rows" :key="row.entry.id">
          <ContextBlock v-if="row.entry.kind === 'text' || row.entry.kind === 'content_policy_refusal'" :entry="row.entry" />
          <div v-else-if="activationEntry(row.entry)" :data-entry-id="row.entry.id" tabindex="-1" class="activation-marker">
            <strong>Activation entry recorded</strong>
            <pre><JsonText :text="row.entry.content" /></pre>
          </div>
          <DiagnosticRow v-else-if="['model_issue', 'model_repair', 'model_recovered'].includes(row.entry.kind)" :entry="row.entry" />
          <ToolChip
            v-else
            :entry-id="row.entry.id"
            :display="buildToolDisplay(row)"
            :call-content="row.entry.kind === 'tool_call' ? row.entry.content : null"
            :result-content="row.entry.kind === 'tool_result' ? row.entry.content : null"
            :expanded="expandedIds.has(row.entry.id)"
            :details-id="`tool-${row.entry.id}`"
            :timestamp="row.entry.timestamp"
            @toggle="emit('toggle', row.entry.id)"
          />
        </template>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import type { AgentTimeline } from '../../utils/agent-timeline';
import { activationEntry } from '../../utils/agent-timeline/activation';
import { buildToolDisplay } from '../../utils/tool-friendly';
import CompactedCluster from './CompactedCluster.vue';
import ContextBlock from './ContextBlock.vue';
import DiagnosticRow from './DiagnosticRow.vue';
import ToolChip from './ToolChip.vue';
import JsonText from '../content/JsonText.vue';

const props = defineProps<{ timeline: AgentTimeline; expandedIds: Set<string> }>();
const emit = defineEmits<{ toggle: [id: string] }>();

function isAuthorBoundary(index: number): boolean {
  if (index <= 0) return true;
  return props.timeline.rounds[index - 1].kind !== props.timeline.rounds[index].kind;
}
</script>

<style scoped>
.conversation-timeline {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.activation-marker { padding: 8px; border: 1px solid var(--border); font-size: 12px; color: var(--text); }
.activation-marker pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.round-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px 0;
}
.round-card.round-user {
  padding-top: 10px;
  border-top: 1px solid var(--surface-3);
}
.round-card.round-assistant {
  padding-top: 8px;
  border-top: 1px solid var(--surface-3);
}
.round-card.continues-author {
  padding-top: 0;
  border-top: none;
}
.round-head {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: capitalize;
}
.round-card.round-assistant .round-head {
  font-weight: 500;
  opacity: 0.85;
}
.round-head .round-position {
  color: var(--border-strong);
  font-weight: 400;
}
</style>
