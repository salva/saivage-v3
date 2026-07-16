<template>
  <div class="agent-debug-detail" :data-session-id="sessionId" :data-detail-kind="kind">
    <div class="agent-debug-path mono">{{ endpointPath }}</div>

    <template v-if="kind === 'conversation'">
      <div class="agent-debug-toolbar">
        <label class="auto-scroll-pause-toggle">
          <input type="checkbox" :checked="timelineControls.autoScrollPaused.value" @change="timelineControls.toggleAutoScrollPause()" />
          Pause auto-scroll
        </label>
        <button class="sv-fetch-btn" :disabled="conversationLoading || conversationRefreshing" @click="refreshConversation">Reload</button>
      </div>
      <StatusBanner v-if="conversationRefreshError" tone="warning" :message="conversationRefreshError" />
      <StatusBanner v-if="conversationRefreshing" tone="stale" message="Refreshing conversation…" />
      <StatusBanner v-if="conversationWarning" tone="warning" :message="conversationWarning" />
      <ViewState v-if="conversationLoading" state="loading" title="Loading agent conversation..." />
      <ViewState v-else-if="conversationUnauthorized" state="unauthorized" title="Conversation unavailable" message="Provide a valid API token to load this conversation." />
      <ViewState v-else-if="conversationError" state="error" title="Failed to load" :message="conversationError" />
      <ViewState v-else-if="!currentSession" state="empty" title="No agent conversation recorded" />
      <div v-else ref="timelineControls.scrollAreaRef" class="agent-debug-conversation" @scroll="timelineControls.handleTimelineScroll">
        <ConversationTimeline :timeline="timelineControls.timeline.value" :expanded-ids="timelineControls.expandedIds.value" @toggle="timelineControls.toggleExpanded" />
        <button
          v-if="!timelineControls.pinnedToLatest.value || timelineControls.unseenCount.value > 0"
          type="button"
          class="agent-debug-jump-latest"
          @click="timelineControls.jumpToLatest"
        >Jump to latest<span v-if="timelineControls.unseenCount.value > 0"> · {{ timelineControls.unseenCount.value }} new</span></button>
      </div>
    </template>

    <template v-else>
      <div class="agent-debug-toolbar">
        <button class="sv-fetch-btn" :disabled="llmExchangeLoading || llmExchangeRefreshing" @click="refreshExchange">Reload</button>
      </div>
      <StatusBanner v-if="llmExchangeRefreshError" tone="warning" :message="llmExchangeRefreshError" />
      <StatusBanner v-if="llmExchangeRefreshing" tone="stale" message="Refreshing LLM exchange…" />
      <ViewState v-if="llmExchangeLoading" state="loading" title="Loading LLM exchange..." />
      <ViewState v-else-if="llmExchangeError" state="error" title="Failed to load" :message="llmExchangeError" />
      <ViewState v-else-if="llmExchangeLoaded && !currentLlmExchange" state="empty" title="No LLM exchange recorded" />
      <CodeBlock v-else-if="currentLlmExchange" :code="formatJson(currentLlmExchange)" language="json" copyable wrap max-height="70vh" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useAgentTimeline } from '../../composables/useAgentTimeline';
import { useAgentStore } from '../../stores/agents';
import { useLiveSyncStore } from '../../stores/liveSync';
import { formatJson } from '../../utils/format-json';
import CodeBlock from '../content/CodeBlock.vue';
import ConversationTimeline from '../conversation/ConversationTimeline.vue';
import StatusBanner from '../ui/StatusBanner.vue';
import ViewState from '../ui/ViewState.vue';

const props = defineProps<{ sessionId: string; kind: 'conversation' | 'llmExchange' }>();
const agentStore = useAgentStore();
const liveSyncStore = useLiveSyncStore();
const {
  currentSession, entries, activityStatus,
  conversationLoading, conversationRefreshing, conversationError, conversationRefreshError,
  conversationUnauthorized, conversationWarning,
  currentLlmExchange, llmExchangeLoaded, llmExchangeLoading, llmExchangeRefreshing,
  llmExchangeError, llmExchangeRefreshError,
} = storeToRefs(agentStore);
const sessionModel = computed(() => currentSession.value?.model ?? null);
const timelineControls = useAgentTimeline(entries, activityStatus, sessionModel);
const endpointPath = computed(() => `/api/agents/${encodeURIComponent(props.sessionId)}/${props.kind === 'conversation' ? 'conversation' : 'llm-exchange'}`);

let conversationToken: ReturnType<typeof agentStore.beginConversationSelection> | null = null;
let exchangeToken: ReturnType<typeof agentStore.beginLlmExchangeSelection> | null = null;
let unregisterConversation: (() => void) | null = null;

async function refreshConversation(): Promise<void> {
  if (conversationToken) await agentStore.fetchConversation(conversationToken).catch(() => {});
}
async function refreshExchange(): Promise<void> {
  if (exchangeToken) await agentStore.fetchLlmExchange(exchangeToken);
}

onMounted(() => {
  if (props.kind === 'conversation') {
    conversationToken = agentStore.beginConversationSelection(props.sessionId);
    const token = conversationToken;
    unregisterConversation = liveSyncStore.openConversation(props.sessionId, () => agentStore.refetchConversation(token));
    void agentStore.fetchConversation(token).catch(() => {});
    return;
  }
  exchangeToken = agentStore.beginLlmExchangeSelection(props.sessionId);
  void agentStore.fetchLlmExchange(exchangeToken);
});

onUnmounted(() => {
  if (conversationToken) {
    unregisterConversation?.();
    agentStore.clearConversationSelection(conversationToken);
  }
  if (exchangeToken) agentStore.clearLlmExchange(exchangeToken);
});
</script>

<style scoped>
.agent-debug-detail { min-width:0; }
.agent-debug-toolbar { display:flex; gap:8px; align-items:center; justify-content:flex-end; flex-wrap:wrap; margin-bottom:10px; }
.auto-scroll-pause-toggle { display:inline-flex; align-items:center; gap:4px; font-size:12px; color:var(--text-muted); cursor:pointer; }
.auto-scroll-pause-toggle input { margin:0; }
.agent-debug-path { margin-bottom:10px; color:var(--text-muted); word-break:break-all; }
.agent-debug-conversation { max-height:70vh; overflow:auto; padding-right:4px; }
.agent-debug-jump-latest { position:sticky; bottom:10px; left:50%; transform:translateX(-50%); border:1px solid var(--border); border-radius:999px; background:var(--surface-3); color:var(--accent-2); cursor:pointer; font:inherit; font-size:12px; padding:6px 12px; }
.sv-fetch-btn { margin-left:8px; padding:4px 8px; font-size:11px; color:var(--accent-2); background:var(--bg); border:1px solid var(--border); border-radius:4px; cursor:pointer; }
.sv-fetch-btn:disabled { opacity:.5; cursor:not-allowed; }
.mono { font-family:'SF Mono',monospace; font-size:11px; }
</style>
