<template>
  <details class="record-observations" data-testid="record-observations">
    <summary>Recorded record observations · {{ observations.length }}</summary>
    <p>Observed selection and recorded exposure only; not delivery, body recall, currentness or acceptance.</p>
    <section v-for="(item, index) in observations" :key="index">
      <strong>{{ item.observed.card_id }} / {{ item.observed.record_name }} · {{ item.observed.view }} view · {{ item.observed.selection_kind }}</strong>
      <p>Source: {{ item.source.kind }} · {{ timestamp }} · {{ sourceLabel }}</p>
      <p>Selection: {{ item.observed.selection.kind }} · Exposure: {{ item.observed.exposure.kind }}<template v-if="item.observed.exposure.kind === 'slice'"> · bytes {{ item.observed.exposure.offset_bytes }} + {{ item.observed.exposure.utf8_bytes }} of {{ item.observed.exposure.total_bytes }}</template></p>
      <p v-if="item.observed.selection.kind === 'draft' && accepted(item)">Accepted backing only; the current draft has no immutable body locator.</p>
      <p v-if="item.observed.selection.kind === 'draft'">{{ item.observed.selection.unfilled ? 'Unfilled scaffold — not authored or accepted' : 'Draft' }}</p>
      <button v-if="accepted(item)" type="button" @click="openEvidence(accepted(item)!.locator)">Inspect immutable record evidence · v{{ accepted(item)!.version }}</button>
      <p v-if="item.source.kind === 'preparation'">Descriptor only: no historical full prepared record text was recorded.</p>
      <InstructionDisclosure label="Observation descriptor" :text="JSON.stringify(item, null, 2)" explanation="Descriptor only, not a reconstructed request" metadata />
    </section>
  </details>
</template>
<script setup lang="ts">
import { useRouter } from 'vue-router';
import type { AgentConversationEntry } from '../../api/types';
import InstructionDisclosure from './InstructionDisclosure.vue';
type Observation = NonNullable<AgentConversationEntry['record_observations']>[number];
defineProps<{ observations: readonly Observation[]; timestamp: string; sourceLabel: string }>();
const router = useRouter();
function accepted(item: Observation) { return item.observed.selection.kind === 'accepted' ? item.observed.selection : item.observed.selection.kind === 'draft' ? item.observed.selection.accepted_backing : null; }
function openEvidence(path: string) { void router.push({ name: 'files', query: { path } }); }
</script>
<style scoped>
.record-observations { padding:6px 10px; border:1px solid var(--border); overflow-wrap:anywhere; }
summary { cursor:pointer; } p { margin:4px 0; } button { color:var(--accent); background:var(--surface-2); border:1px solid var(--border); font:inherit; }
</style>
