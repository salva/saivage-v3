<template>
  <section class="selected-context" data-testid="conversation-segment-context">
    <strong>Compacted context — selected segment {{ version }} · source segment {{ context.source_version }} · {{ context.continuation.kind === 'between_rounds' ? 'between rounds' : 'inherited open round' }}</strong>
    <span>{{ context.protected_prompts.length }} retained instructions · recovery fact {{ context.required_model_facts.latestRecovery ? 'present' : 'absent' }} · refusal fact {{ context.required_model_facts.latestContentPolicyRefusal ? 'present' : 'absent' }}</span>
    <p>Current readers can include notices derived from compacted facts; these do not prove a newly recorded event.</p>
    <details data-testid="compacted-summary"><summary>Accumulated summary</summary>
      <p>Compacted historical summary, not a transcript row or execution/acceptance evidence.</p>
      <pre>{{ context.summary_text }}</pre>
    </details>
    <RetainedInstructionContext :context="context" />
    <details data-testid="compacted-facts"><summary>Required model facts</summary>
      <p>Facts retained by compaction, not new recovery/refusal occurrences or liveness.</p>
      <strong>Latest recovery notice — {{ context.required_model_facts.latestRecovery ? 'present' : 'absent' }}</strong>
      <pre v-if="context.required_model_facts.latestRecovery">{{ JSON.stringify(context.required_model_facts.latestRecovery, null, 2) }}</pre>
      <strong>Latest content-policy refusal — {{ context.required_model_facts.latestContentPolicyRefusal ? 'present' : 'absent' }}</strong>
      <pre v-if="context.required_model_facts.latestContentPolicyRefusal">{{ JSON.stringify(context.required_model_facts.latestContentPolicyRefusal, null, 2) }}</pre>
    </details>
    <details data-testid="compacted-source"><summary>Source and continuation</summary>
      <p>Source segment {{ context.source_version }} · covered through {{ context.covered_through_message_id }}</p>
      <p>Continuation context, not another activation entry.</p>
      <pre>{{ JSON.stringify(context.continuation, null, 2) }}</pre>
    </details>
  </section>
</template>
<script setup lang="ts">
import type { AgentConversationResponse } from '../../api/types';
import RetainedInstructionContext from './RetainedInstructionContext.vue';
defineProps<{ context: NonNullable<AgentConversationResponse['segment_context']>; version: number | null }>();
</script>
<style scoped>
.selected-context { display:grid; gap:6px; margin:10px 16px 0; padding:10px; border:1px solid var(--border); border-radius:6px; background:var(--surface-2); font-size:12px; overflow-wrap:anywhere; }
p { margin:4px 0; color:var(--text-muted); }
pre { white-space:pre-wrap; overflow-wrap:anywhere; margin:6px 0; }
summary { cursor:pointer; }
</style>
