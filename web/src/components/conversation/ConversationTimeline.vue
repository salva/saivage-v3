<template>
  <div class="conversation-timeline">
    <p v-if="firstSourceRow && !firstSourceRow.activation">The activation start is outside this displayed segment or tail; this does not mean no instructions existed.</p>
    <section
      v-for="(round, index) in presentedRounds"
      :key="round.id"
      class="round-card"
      data-testid="round-card"
      :class="[`round-${round.kind}`, { 'continues-author': !isAuthorBoundary(index) }]"
    >
      <CompactedCluster v-if="round.kind === 'compacted'" :entries="round.entries" />
      <template v-else>
        <header v-if="isAuthorBoundary(index)" class="round-head">
          {{ round.kind }}
        </header>
        <template v-for="row in round.rows" :key="row.entry.id">
          <ContextBlock v-if="row.entry.kind === 'text' || row.entry.kind === 'record_prompt' || row.entry.kind === 'content_policy_refusal'" :entry="row.entry" />
          <div v-else-if="row.activation" :data-entry-id="row.entry.id" tabindex="-1" class="activation-marker">
            <strong>Activation entry recorded</strong>
            <template v-if="row.activation.instructions.kind === 'prepared'">
              <p>Prepared instructions · {{ row.activation.agentName }} · {{ row.entry.timestamp }} — historical rendered instructions prepared for this activation; not proof of model delivery or interpretation.</p>
              <InstructionDisclosure label="Role instructions" :text="row.activation.instructions.role_text" explanation="Prepared instructions" />
              <InstructionDisclosure v-if="row.activation.instructions.node" :label="`Node ${row.activation.instructions.node.node_id} instructions`" :text="row.activation.instructions.node.text" explanation="Prepared instructions" />
              <InstructionDisclosure v-if="row.activation.instructions.parent_direction" label="Parent activation direction" :text="row.activation.instructions.parent_direction.text" explanation="Activation-scoped advisory direction, not acceptance" />
              <p v-else>No parent direction · {{ row.activation.instructions.caller.kind }} caller</p>
              <InstructionDisclosure label="Caller and card orientation" :text="JSON.stringify({ activation_id: row.activation.instructions.activation_id, caller: row.activation.instructions.caller, card: row.activation.instructions.card }, null, 2)" explanation="Recorded preparation provenance" metadata />
            </template>
            <p v-else-if="row.activation.instructions.kind === 'unavailable'">Historical instructions unavailable — not recorded</p>
            <p v-else>No model invocation for this ingress</p>
            <details><summary>Recorded activation details</summary><p>{{ provenance(row.entry) }}</p><pre><JsonText :text="row.entry.content" /></pre></details>
          </div>
          <DiagnosticRow v-else-if="['model_issue', 'model_repair', 'model_recovered'].includes(row.entry.kind)" :entry="row.entry" />
          <ToolChip
            v-else-if="row.tool"
            :entry-id="row.entry.id"
            :display="row.tool.display"
            :call-content="row.entry.kind === 'tool_call' ? row.entry.content : null"
            :result-content="row.entry.kind === 'tool_result' ? row.entry.content : row.mate?.content ?? null"
            :result-entry-id="row.entry.kind === 'tool_result' ? row.entry.id : row.mate?.id"
            :request-provenance="row.entry.kind === 'tool_call' ? provenance(row.entry) : undefined"
            :result-provenance="row.entry.kind === 'tool_result' ? provenance(row.entry) : row.mate ? provenance(row.mate) : undefined"
            :intervening-entries="row.interveningEntries"
            :expanded="expandedIds.has(row.entry.id)"
            :details-id="`tool-${row.entry.id}`"
            :images="row.tool.images"
            @inspect="inspect(row.tool.images, $event)"
            @toggle="emit('toggle', row.entry.id)"
          />
          <div v-if="row.entry.kind === 'record_observation'" :data-entry-id="row.entry.id" tabindex="-1">Preparation observation recorded · {{ provenance(row.entry) }}</div>
          <RecordObservations v-if="observationEntry(row)?.record_observations" :observations="observationEntry(row)!.record_observations!" :timestamp="observationEntry(row)!.timestamp" :source-label="provenance(observationEntry(row)!)" />
        </template>
      </template>
    </section>
  </div>
  <ImagePreviewDialog v-if="inspection && previewSelection" :selection="previewSelection" :position="inspection.index" :count="inspection.images.length" @navigate="inspection.index += $event" @close="closeInspection" />
</template>

<script setup lang="ts">
import type { AgentTimeline } from '../../utils/agent-timeline';
import { activationEntry } from '../../utils/agent-timeline/activation';
import { buildToolDisplay } from '../../utils/tool-friendly';
import CompactedCluster from './CompactedCluster.vue';
import ContextBlock from './ContextBlock.vue';
import InstructionDisclosure from './InstructionDisclosure.vue';
import RecordObservations from './RecordObservations.vue';
import DiagnosticRow from './DiagnosticRow.vue';
import ToolChip from './ToolChip.vue';
import JsonText from '../content/JsonText.vue';
import type { AgentConversationEntry } from '../../api/types';
import { computed, onBeforeUnmount, ref } from 'vue';
import type { TimelineRow } from '../../utils/agent-timeline';
import { conversationImages, type ImageContext, type ImageSelection } from '../../utils/conversation-images';
import ImagePreviewDialog from '../../files/ImagePreviewDialog.vue';
function provenance(entry: AgentConversationEntry): string {
  return `${entry.role} · ${entry.timestamp} · ${entry.id} · source ${entry.round_id}, message ${entry.message_index}, block ${entry.block_index}`;
}
function observationEntry(row: TimelineRow): AgentConversationEntry | null { return row.entry.kind === 'tool_call' ? row.mate : row.entry; }

const props = defineProps<{ timeline: AgentTimeline; expandedIds: Set<string>; imageContext?: ImageContext }>();
const presentedRounds = computed(() => props.timeline.rounds.map(round => ({
  ...round,
  rows: round.kind === 'compacted' ? [] : round.rows.map(row => {
    const activation = activationEntry(row.entry);
    if (row.entry.kind !== 'tool_call' && row.entry.kind !== 'tool_result') return { ...row, activation, tool: null };
    const display = buildToolDisplay(row);
    const result = row.entry.kind === 'tool_result' ? row.entry : row.mate;
    return { ...row, activation, tool: { display, images: conversationImages(result, props.imageContext, display.toolName) } };
  }),
})));
const firstSourceRow = computed(() => presentedRounds.value.find(round => round.kind !== 'compacted')?.rows[0]);
const emit = defineEmits<{ toggle: [id: string]; inspecting: [open: boolean] }>();
const inspection = ref<{ images: ImageSelection[]; index: number } | null>(null);
const previewSelection = computed(() => inspection.value ? { kind: 'conversation' as const, image: inspection.value.images[inspection.value.index] } : null);
function inspect(images: ImageSelection[], index: number): void {
  inspection.value = { images, index };
  emit('inspecting', true);
}
function closeInspection(): void { inspection.value = null; emit('inspecting', false); }
onBeforeUnmount(() => { if (inspection.value) emit('inspecting', false); });

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
.activation-marker { padding: 8px; border: 1px solid var(--border); font-size: 15px; color: var(--text); }
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
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  text-transform: capitalize;
}
.round-card.round-assistant .round-head {
  font-weight: 500;
}
.conversation-timeline { font-size:15px; line-height:1.5; color:var(--text); min-width:0; overflow-wrap:anywhere; }
.conversation-timeline :deep(.code-block__pre), .conversation-timeline :deep(.markdown-text pre) { max-height:none !important; overflow:visible; white-space:pre-wrap; overflow-wrap:anywhere; }
.conversation-timeline :deep(.code-block), .conversation-timeline :deep(.context-block), .conversation-timeline :deep(.markdown-text), .conversation-timeline :deep(.semantic-section) { font-size:15px; line-height:1.5; }
.conversation-timeline :deep(.code-block--copyable) { padding-top:32px; }
.conversation-timeline :deep(.markdown-text blockquote) { color:var(--text); }
.conversation-timeline :deep(.markdown-text a) { color:var(--accent-2); }
.conversation-timeline :deep(.markdown-text table) { width:100%; table-layout:fixed; overflow-wrap:anywhere; }
</style>
