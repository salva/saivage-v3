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
        <span class="rlp-meta-item">Captured: <span class="rlp-meta-value">{{ exchange.capturedAt }}</span></span>
        <span class="rlp-meta-sep">·</span>
        <span class="rlp-meta-item">Transport: <span class="rlp-meta-value">{{ exchange.transport }}</span></span>
        <span class="rlp-meta-sep">·</span>
        <span class="rlp-meta-item">Model: <span class="rlp-meta-value">{{ exchange.candidate.model }}</span></span>
        <span class="rlp-meta-sep">·</span>
        <span class="rlp-meta-item">Attempts: <span class="rlp-meta-value">{{ exchange.attempts.length }}</span></span>
      </div>
      <p class="rlp-redaction-banner">
        Raw exchange after server-side redaction. Operator-domain text (prompts, tool args)
        appears unmodified; credential-shaped values, secret-named keys, and credentials in
        headers/URLs are replaced with [REDACTED].
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
      <nav v-if="exchange.attempts.length > 1" class="rlp-tabs" aria-label="Attempts">
        <button
          v-for="(att, idx) in exchange.attempts"
          :key="att.attempt"
          type="button"
          class="rlp-tab"
          :class="{ 'rlp-tab--active': idx === selectedIndex }"
          :aria-pressed="idx === selectedIndex"
          @click="selectedIndex = idx"
        >Attempt {{ att.attempt }}</button>
      </nav>

      <div v-if="selectedAttempt" class="rlp-panes">
        <div class="rlp-pane">
          <h3 class="rlp-pane-title">Request</h3>
          <CodeBlock
            :code="formatJson(selectedAttempt.request)"
            language="json"
            copyable
            max-height="60vh"
            aria-label="Last LLM request, JSON"
          />
        </div>

        <div class="rlp-pane">
          <h3 class="rlp-pane-title">Response</h3>

          <div v-if="selectedAttempt.error" class="rlp-error-box">
            <div class="rlp-error-name">{{ selectedAttempt.error.errorName }}</div>
            <div class="rlp-error-message">{{ selectedAttempt.error.message }}</div>
            <CodeBlock
              v-if="selectedAttempt.error.bodyRaw"
              :code="selectedAttempt.error.bodyRaw"
              language="text"
              copyable
              wrap
              max-height="60vh"
              aria-label="Last LLM error body, raw text"
            />
          </div>

          <template v-else-if="selectedAttempt.response">
            <template v-if="isStreaming">
              <CodeBlock
                :code="selectedAttempt.response.bodyRaw ?? ''"
                language="text"
                copyable
                wrap
                max-height="60vh"
                aria-label="Last LLM response, raw stream"
              />
              <details v-if="selectedAttempt.response.bodyParsed !== null" class="rlp-parsed-details">
                <summary>Parsed result</summary>
                <CodeBlock
                  :code="formatJson(selectedAttempt.response.bodyParsed)"
                  language="json"
                  copyable
                  max-height="60vh"
                  aria-label="Last LLM response, parsed JSON"
                />
              </details>
            </template>
            <template v-else-if="selectedAttempt.response.bodyParsed !== null">
              <CodeBlock
                :code="formatJson(selectedAttempt.response.bodyParsed)"
                language="json"
                copyable
                max-height="60vh"
                aria-label="Last LLM response, JSON"
              />
            </template>
            <template v-else>
              <div class="rlp-notice">Response was not valid JSON — showing raw text.</div>
              <CodeBlock
                :code="selectedAttempt.response.bodyRaw ?? ''"
                language="text"
                copyable
                wrap
                max-height="60vh"
                aria-label="Last LLM response, raw text"
              />
            </template>
          </template>

          <div v-else class="rlp-notice">No response captured for this attempt.</div>
        </div>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
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
const selectedIndex = ref(0);

watch(
  () => exchange.value,
  (ex) => {
    selectedIndex.value = ex && ex.attempts.length > 0 ? ex.attempts.length - 1 : 0;
  },
  { immediate: true },
);

const selectedAttempt = computed(() => {
  const ex = exchange.value;
  if (!ex) return null;
  return ex.attempts[selectedIndex.value] ?? ex.attempts[ex.attempts.length - 1] ?? null;
});

const isStreaming = computed(() => {
  const ex = exchange.value;
  const att = selectedAttempt.value;
  if (!ex || !att || !att.response) return false;
  if (ex.transport === 'codex') return true;
  const raw = att.response.bodyRaw;
  return typeof raw === 'string' && raw.includes('data: ');
});

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
.rlp-tab { padding:3px 10px; background:var(--surface-1); border:1px solid var(--border); border-radius:4px; color:var(--text-muted); font-size:11px; cursor:pointer; font-family:inherit; }
.rlp-tab--active { background:var(--entry-user-bg); color:var(--accent-2); border-color:var(--accent-2); }
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
