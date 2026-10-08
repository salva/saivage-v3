<template>
  <details class="current-instructions" :open="open" @toggle="onToggle">
    <summary>Currently configured instructions</summary>
    <div class="current-instructions__body">
      <p v-if="historical">Current server configuration — not the instructions recorded for this historical segment.</p>
      <p v-else>Current server configuration — not a snapshot or the exact model request.</p>
      <p>Configuration loaded by this server, not unactivated edits on disk. This is the last fetched observation; Refresh reads it again. Dynamic context and tool definitions are not included.</p>
      <button type="button" :disabled="pending || !validSessionId" @click="refresh">Refresh</button>
      <p v-if="pending" role="status">Loading currently configured instructions…</p>
      <p v-else-if="error" role="alert">{{ error }}</p>
      <template v-else-if="instructions">
        <p v-if="instructions.scope.kind === 'card'">
          {{ instructions.scope.ownership === 'retained_tombstone' ? 'Retained-card orientation' : 'Card' }}
          · {{ instructions.scope.card_id }} · {{ instructions.scope.card_type }}
        </p>
        <p v-else>Global session · {{ instructions.session_id }}</p>
        <section v-for="binding in instructions.bindings" :key="binding.kind === 'global' ? 'global' : binding.node_id">
          <h4>{{ binding.kind === 'global' ? 'Global instructions' : `Workflow node · ${binding.node_id}` }}</h4>
          <CodeBlock :code="binding.instructions" language="text" copyable wrap max-height="none" />
        </section>
      </template>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { getAgentCurrentInstructions, isOperatorApiError } from '../../api/client';
import { ConversationSessionIdSchema } from '../../api/contracts';
import type { AgentCurrentInstructionsResponse } from '../../api/types';
import { createOwnedFetch } from '../../stores/owned-fetch';
import CodeBlock from '../content/CodeBlock.vue';

const props = withDefaults(defineProps<{ sessionId: string; historical?: boolean }>(), { historical: false });
const open = ref(false);
const instructions = ref<AgentCurrentInstructionsResponse | null>(null);
const error = ref<string | null>(null);
const request = createOwnedFetch();
const pending = request.pending;
const validSessionId = computed(() => {
  const parsed = ConversationSessionIdSchema.safeParse(props.sessionId);
  return parsed.success ? parsed.data : null;
});

function discard() {
  request.cancel();
  instructions.value = null;
  error.value = null;
}
function refresh() {
  discard();
  const sessionId = validSessionId.value;
  if (!sessionId) {
    error.value = 'Currently configured instructions unavailable: invalid session identity.';
    return;
  }
  void request.run(signal => getAgentCurrentInstructions(sessionId, signal), value => {
    instructions.value = value;
  }, failure => {
    error.value = isOperatorApiError(failure, 'agents.currentInstructions', 401)
      ? 'Currently configured instructions unavailable: this browser is not authorized.'
      : isOperatorApiError(failure, 'agents.currentInstructions', 404)
        ? 'Currently configured instructions unavailable: session is absent or unconfigured.'
        : isOperatorApiError(failure, 'agents.currentInstructions', 503)
          ? 'Currently configured instructions unavailable: required current state cannot be read.'
          : 'Currently configured instructions could not be loaded.';
  });
}
function onToggle(event: Event) {
  const next = (event.target as HTMLDetailsElement).open;
  if (next === open.value) return;
  open.value = next;
  if (next) refresh(); else discard();
}
watch(() => props.sessionId, () => { open.value = false; discard(); }, { flush: 'sync' });
onUnmounted(discard);
</script>

<style scoped>
.current-instructions { color: var(--text); font-size: 15px; line-height: 1.5; min-width: 0; overflow-wrap: anywhere; }
summary { cursor: pointer; padding: 5px 0; }
.current-instructions__body { padding: 0 8px 12px; }
h4 { margin-bottom: 8px; }
.current-instructions :deep(.code-block) { font-size: 15px; padding-top: 32px; overflow: visible; }
.current-instructions :deep(.code-block__pre) { overflow: visible; max-height: none; }
summary:focus-visible, button:focus-visible { outline: 2px solid var(--text); outline-offset: 3px; }
</style>
