<template>
  <section class="raw-llm-panel" aria-label="Last raw LLM exchange">
    <header class="rlp-header">
      <div class="rlp-title">
        <span class="rlp-title-text">Last raw LLM exchange</span>
        <button
          type="button"
          class="rlp-refresh"
          :disabled="llmExchangeLoading"
          @click="onRefresh"
        >Refresh</button>
      </div>
      <div v-if="exchange" class="rlp-meta">
        <span class="rlp-meta-item">Completed: <span class="rlp-meta-value">{{ exchange.completed_at }}</span></span>
        <span class="rlp-meta-sep">·</span>
        <span class="rlp-meta-item">Transport: <span class="rlp-meta-value">{{ exchange.transport }}</span></span>
        <span class="rlp-meta-sep">·</span>
        <span class="rlp-meta-item">Model: <span class="rlp-meta-value">{{ exchange.model }}</span></span>
        <span class="rlp-meta-sep">·</span>
        <span class="rlp-meta-item">Attempt: <span class="rlp-meta-value">{{ exchange.attempt_index }}</span></span>
      </div>
      <p class="rlp-redaction-banner">
        Provider exchange metadata only. Raw HTTP request and response bodies are not persisted.
      </p>
    </header>

    <div v-if="llmExchangeLoading" class="rlp-status rlp-status--loading">
      Loading raw LLM exchange…
    </div>

    <div v-else-if="llmExchangeError" class="rlp-status rlp-status--error" role="alert">
      {{ llmExchangeError }}
    </div>

    <div v-else-if="!exchange" class="rlp-status rlp-status--empty">
      No LLM exchange recorded yet for this session.
    </div>

    <template v-else>
      <div class="rlp-attempt-meta">
        <span class="rlp-meta-item">Status: <span class="rlp-meta-value">{{ exchange.status }}</span></span>
        <span
          v-if="exchange.terminal_tool_fired"
          class="rlp-terminal-tool-badge"
          :title="`terminal tool emitted on this attempt`"
        >{{ exchange.terminal_tool_fired }}</span>
        <span class="rlp-meta-item">Input: <span class="rlp-meta-value">{{ exchange.source_input_id }}</span></span>
      </div>

      <div class="rlp-panes">
        <div class="rlp-pane">
          <h3 class="rlp-pane-title">Request parameters</h3>
          <CodeBlock
            :code="formatJson(exchange.request_params)"
            language="json"
            copyable
            max-height="60vh"
            aria-label="Last LLM request, JSON"
          />
        </div>

        <div class="rlp-pane">
          <h3 class="rlp-pane-title">Settlement</h3>

          <div v-if="exchange.status === 'error'" class="rlp-error-box">
            <div class="rlp-error-name">{{ exchange.error.name }}</div>
            <div class="rlp-error-message">{{ exchange.error.message }}</div>
          </div>

          <CodeBlock
            v-else
            :code="formatJson({ response_status: exchange.response_status, finish_reason: exchange.finish_reason, token_usage: exchange.token_usage, assistant_output_ids: exchange.assistant_output_ids })"
            language="json"
            copyable
            max-height="60vh"
            aria-label="Last LLM provider exchange metadata"
          />
        </div>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useAgentStore } from '../../stores/agents';
import { formatJson } from '../../utils/format-json';
import CodeBlock from '../content/CodeBlock.vue';

const props = defineProps<{ sessionId: string }>();

const agentStore = useAgentStore();
const {
  currentLlmExchange,
  llmExchangeLoading,
  llmExchangeError,
  llmExchangeSessionId,
} = storeToRefs(agentStore);

const exchange = computed(() => currentLlmExchange.value);

async function onRefresh(): Promise<void> {
  await agentStore.fetchLlmExchange(props.sessionId);
}

function maybeFetch(): void {
  if (llmExchangeSessionId.value !== props.sessionId) {
    void agentStore.fetchLlmExchange(props.sessionId);
  }
}

maybeFetch();
watch(() => props.sessionId, maybeFetch);
</script>

<style scoped>
.raw-llm-panel { margin: 12px 16px 0; background:var(--bg); border:1px solid var(--border); border-radius:6px; padding:12px; display:flex; flex-direction:column; gap:10px; }
.rlp-header { display:flex; flex-direction:column; gap:6px; }
.rlp-title { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.rlp-title-text { font-size:13px; font-weight:600; color:var(--text); }
.rlp-refresh { padding:3px 10px; background:var(--surface-3); border:1px solid var(--border); border-radius:4px; color:var(--text); font-size:11px; cursor:pointer; font-family:inherit; }
.rlp-refresh:hover:not(:disabled) { background:var(--border); }
.rlp-refresh:disabled { opacity:.5; cursor:default; }
.rlp-meta { display:flex; flex-wrap:wrap; gap:6px; font-size:11px; color:var(--text-muted); }
.rlp-meta-value { color:var(--text); font-family:'SF Mono',monospace; }
.rlp-meta-sep { color:var(--border-strong); }
.rlp-redaction-banner { margin:0; padding:8px 10px; background:var(--surface-1); border:1px solid var(--border); border-radius:4px; font-size:11px; color:var(--text-muted); line-height:1.5; }
.rlp-status { padding:16px; text-align:center; font-size:12px; color:var(--text-muted); }
.rlp-status--error { color:var(--danger); background:var(--entry-danger-bg); border:1px solid var(--entry-danger-border); border-radius:4px; }
.rlp-tabs { display:flex; gap:4px; border-bottom:1px solid var(--border); padding-bottom:6px; flex-wrap:wrap; }
.rlp-attempt-tab { padding:3px 10px; background:var(--surface-1); border:1px solid var(--border); border-radius:4px; color:var(--text-muted); font-size:11px; cursor:pointer; font-family:inherit; }
.rlp-attempt-meta { display:flex; flex-wrap:wrap; align-items:center; gap:8px; font-size:11px; color:var(--text-muted); }
.rlp-terminal-tool-badge { padding:2px 8px; background:var(--surface-3); border:1px solid var(--border); border-radius:10px; color:var(--accent-2); font-family:'SF Mono',monospace; font-size:10px; }

.rlp-panes { display:flex; gap:10px; }
.rlp-pane { flex:1; min-width:0; display:flex; flex-direction:column; gap:6px; }
.rlp-pane-title { margin:0; font-size:11px; font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:.05em; }
.rlp-notice { font-size:11px; color:var(--warn); padding:6px 8px; background:var(--entry-warn-bg); border:1px solid var(--entry-warn-border); border-radius:4px; }
.rlp-error-box { padding:10px; background:var(--entry-danger-bg); border:1px solid var(--entry-danger-border); border-radius:4px; display:flex; flex-direction:column; gap:6px; }
.rlp-error-name { font-size:11px; font-weight:600; color:var(--danger); font-family:'SF Mono',monospace; }
.rlp-error-message { font-size:12px; color:var(--text); }
.rlp-parsed-details { margin-top:6px; }
.rlp-parsed-details summary { cursor:pointer; font-size:11px; color:var(--accent-2); padding:4px 0; }
@media (max-width: 900px) {
  .rlp-panes { flex-direction:column; }
}
</style>
