<template>
  <section class="raw-llm-panel" aria-label="Provider exchange metadata">
    <header class="rlp-header">
      <div class="rlp-title">
        <span class="rlp-title-text">Provider exchange metadata</span>
        <button
          type="button"
          class="rlp-refresh"
          :disabled="llmExchangeLoading || llmExchangeRefreshing"
          @click="onRefresh"
        >
          Refresh
        </button>
      </div>
      <div v-if="exchange" class="rlp-meta">
        <span class="rlp-meta-item"
          >Completed: <span class="rlp-meta-value" :title="timestampTitle(exchange.completed_at)">{{ fmtDate(exchange.completed_at) }}</span></span
        >
        <span class="rlp-meta-sep">·</span>
        <span class="rlp-meta-item"
          >Transport: <span class="rlp-meta-value">{{ exchange.transport }}</span></span
        >
        <span class="rlp-meta-sep">·</span>
        <span class="rlp-meta-item"
          >Model: <span class="rlp-meta-value">{{ exchange.model }}</span></span
        >
        <span class="rlp-meta-sep">·</span>
        <span class="rlp-meta-item"
          >Attempt: <span class="rlp-meta-value">{{ exchange.attempt_index }}</span></span
        >
      </div>
      <p class="rlp-redaction-banner">
        Provider exchange metadata only. Raw HTTP request and response bodies are not persisted.
      </p>
    </header>

    <div v-if="llmExchangeRefreshing" class="rlp-status rlp-status--loading">
      Refreshing provider exchange metadata…
    </div>
    <div v-if="llmExchangeRefreshError" class="rlp-status rlp-status--error" role="alert">
      {{ llmExchangeRefreshError }}
    </div>

    <div v-if="llmExchangeLoading" class="rlp-status rlp-status--loading">
      Loading provider exchange metadata…
    </div>

    <div v-else-if="llmExchangeError" class="rlp-status rlp-status--error" role="alert">
      {{ llmExchangeError }}
    </div>

    <div v-else-if="llmExchangeLoaded && !exchange" class="rlp-status rlp-status--empty">
      No LLM exchange recorded
    </div>

    <template v-else-if="exchange">
      <div class="rlp-attempt-meta">
        <span class="rlp-meta-item"
          >Status: <span class="rlp-meta-value">{{ exchange.status }}</span></span
        >
        <span
          v-if="exchange.terminal_tool_fired"
          class="rlp-terminal-tool-badge"
          :title="`terminal tool emitted on this attempt`"
          >{{ exchange.terminal_tool_fired }}</span
        >
        <span class="rlp-meta-item"
          >Input: <span class="rlp-meta-value">{{ exchange.source_input_id }}</span></span
        >
      </div>

      <div class="rlp-panes">
        <div class="rlp-pane">
          <h3 class="rlp-pane-title">Request parameters</h3>
          <CodeBlock
            :code="formatJson(exchange.request_params)"
            language="json"
            copyable
            max-height="none"
            wrap
            aria-label="Last LLM request, JSON"
          />
        </div>

        <div class="rlp-pane">
          <h3 class="rlp-pane-title">Settlement</h3>
          <p v-if="exchange.status === 'ok'">
            Counts are provider-reported. Unreported values are unknown, not zero.
            Cached input is part of input; reasoning output is part of output.
          </p>
          <p v-if="exchange.status === 'ok' && !exchange.token_usage">Token usage not reported</p>

          <div v-if="exchange.status === 'error'" class="rlp-error-box">
            <div class="rlp-error-name">{{ exchange.error.name }}</div>
            <div class="rlp-error-message">{{ exchange.error.message }}</div>
            <div class="rlp-error-output">Terminal conversation output: {{ exchange.terminal_conversation_output_id ?? 'none' }}</div>
          </div>

          <CodeBlock
            v-else
            :code="
              formatJson({
                response_status: exchange.response_status,
                finish_reason: exchange.finish_reason,
                token_usage: exchange.token_usage,
                assistant_output_ids: exchange.assistant_output_ids,
              })
            "
            language="json"
            copyable
            max-height="none"
            wrap
            aria-label="Last LLM provider exchange metadata"
          />
        </div>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useAgentStore } from '../../stores/agents';
import { useSyncStore } from '../../stores/sync';
import { formatJson } from '../../utils/format-json';
import { formatRecentTimestamp, timestampTitle } from '../../utils/timestamp';
import CodeBlock from '../content/CodeBlock.vue';

import type { ConversationSessionId } from '../../api/contracts';
const props = defineProps<{ sessionId: ConversationSessionId }>();

const agentStore = useAgentStore();
const liveSync = useSyncStore();
const {
  currentLlmExchange: exchange,
  llmExchangeLoaded,
  llmExchangeLoading,
  llmExchangeRefreshing,
  llmExchangeError,
  llmExchangeRefreshError,
} = storeToRefs(agentStore);

let exchangeToken: ReturnType<typeof agentStore.beginLlmExchangeSelection> | null = null;
let closeExchange: (() => void) | null = null;
const leaseReady = ref(false);

async function onRefresh(): Promise<void> {
  if (exchangeToken && leaseReady.value) await agentStore.fetchLlmExchange(exchangeToken);
}

onMounted(() => {
  exchangeToken = agentStore.beginLlmExchangeSelection(props.sessionId);
  const token = exchangeToken;
  closeExchange = liveSync.openLlmExchange(props.sessionId, () => {
    leaseReady.value = true;
    return agentStore.fetchLlmExchange(token);
  });
});
onUnmounted(() => {
  closeExchange?.();
  if (exchangeToken) agentStore.clearLlmExchange(exchangeToken);
});

function fmtDate(ts: string): string { return ts ? formatRecentTimestamp(ts) : ''; }
</script>

<style scoped>
.raw-llm-panel {
  font-size:15px;
  line-height:1.5;
  overflow-wrap:anywhere;
  margin: 12px 16px 0;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.rlp-header {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rlp-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.rlp-title-text {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.rlp-refresh {
  padding: 3px 10px;
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font-size: 15px;
  cursor: pointer;
  font-family: inherit;
}
.rlp-refresh:hover:not(:disabled) {
  background: var(--border);
}
.rlp-refresh:disabled {
  opacity: 0.5;
  cursor: default;
}
.rlp-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 15px;
  color: var(--text);
}
.rlp-meta-value {
  color: var(--text);
  font-family: 'SF Mono', monospace;
}
.rlp-meta-sep {
  color: var(--border-strong);
}
.rlp-redaction-banner {
  margin: 0;
  padding: 8px 10px;
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 15px;
  color: var(--text);
  line-height: 1.5;
}
.rlp-status {
  padding: 16px;
  text-align: center;
  font-size: 15px;
  color: var(--text);
}
.rlp-status--error {
  color: var(--danger);
  background: var(--entry-danger-bg);
  border: 1px solid var(--entry-danger-border);
  border-radius: 4px;
}
.rlp-attempt-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  color: var(--text);
}
.rlp-terminal-tool-badge {
  padding: 2px 8px;
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--accent-2);
  font-family: 'SF Mono', monospace;
  font-size: 10px;
}

.rlp-panes {
  display: flex;
  gap: 10px;
}
.rlp-pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rlp-pane-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.rlp-error-box {
  padding: 10px;
  background: var(--entry-danger-bg);
  border: 1px solid var(--entry-danger-border);
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rlp-error-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--danger);
  font-family: 'SF Mono', monospace;
}
.rlp-error-message {
  font-size: 15px;
  color: var(--text);
}
@media (max-width: 900px) {
  .rlp-panes {
    flex-direction: column;
  }
}
</style>
