<template>
  <div class="agent-debug-detail" :data-session-id="sessionId" :data-detail-kind="kind">
    <div class="agent-debug-path mono">{{ endpointPath }}</div>

    <template v-if="kind === 'conversation'">
      <div class="agent-debug-toolbar">
        <label class="auto-scroll-pause-toggle">
          <input
            type="checkbox"
            :checked="timelineControls.autoScrollPaused.value"
            @change="timelineControls.toggleAutoScrollPause()"
          />
          Pause auto-scroll
        </label>
        <button
          class="sv-fetch-btn"
          :disabled="conversationLoading || conversationRefreshing"
          @click="refreshConversation"
        >
          Reload
        </button>
      </div>
      <StatusBanner
        v-if="conversationRefreshError"
        tone="warning"
        :message="conversationRefreshError"
      />
      <StatusBanner v-if="conversationRefreshing" tone="stale" message="Refreshing conversation…" />
      <StatusBanner v-if="conversationWarning" tone="warning" :message="conversationWarning" />
      <CompactionProgressBanner v-if="currentSession?.compaction" :progress="currentSession.compaction" :last-known="sessionSummaryRefreshError !== null" />
      <StatusBanner v-if="sessionSummaryRefreshError" tone="warning" :message="sessionSummaryRefreshError" />
      <StatusBanner v-if="sessionSummaryRefreshing" tone="stale" message="Refreshing session status…" />
      <StatusBanner v-if="sessionSummaryLoading && !currentSession" tone="stale" message="Loading session status…" />
      <StatusBanner v-else-if="sessionSummaryUnauthorized && !currentSession" tone="warning" message="Session status unavailable: provide a valid API token." />
      <StatusBanner v-else-if="sessionSummaryError && !currentSession" tone="warning" :message="sessionSummaryError" />
      <ViewState v-if="conversationLoading" state="loading" title="Loading agent conversation..." />
      <ViewState v-else-if="conversationUnauthorized && conversationError" state="unauthorized" title="Conversation unavailable" message="Provide a valid API token to load this conversation." />
      <ViewState v-else-if="conversationError" state="error" title="Failed to load" :message="conversationError" />
      <RetainedInstructionContext v-else :context="conversationSegmentContext" />
      <div
        v-if="!conversationLoading && !conversationError"
        ref="timelineControls.scrollAreaRef"
        class="agent-debug-conversation"
        @scroll="timelineControls.handleTimelineScroll"
      >
        <ConversationTimeline
          :timeline="timelineControls.timeline.value"
          :expanded-ids="timelineControls.expandedIds.value"
          @toggle="timelineControls.toggleExpanded"
        />
        <button
          v-if="!timelineControls.pinnedToLatest.value || timelineControls.unseenCount.value > 0"
          type="button"
          class="agent-debug-jump-latest"
          @click="timelineControls.jumpToLatest"
        >
          Jump to latest<span v-if="timelineControls.unseenCount.value > 0">
            · {{ timelineControls.unseenCount.value }} new</span
          >
        </button>
      </div>
    </template>

    <template v-else>
      <div class="agent-debug-toolbar">
        <button
          class="sv-fetch-btn"
          :disabled="llmExchangeLoading || llmExchangeRefreshing"
          @click="refreshExchange"
        >
          Reload
        </button>
      </div>
      <StatusBanner
        v-if="llmExchangeRefreshError"
        tone="warning"
        :message="llmExchangeRefreshError"
      />
      <StatusBanner v-if="llmExchangeRefreshing" tone="stale" message="Refreshing LLM exchange…" />
      <ViewState v-if="llmExchangeLoading" state="loading" title="Loading LLM exchange..." />
      <ViewState
        v-else-if="llmExchangeError"
        state="error"
        title="Failed to load"
        :message="llmExchangeError"
      />
      <ViewState
        v-else-if="llmExchangeLoaded && !currentLlmExchange"
        state="empty"
        title="No LLM exchange recorded"
      />
      <CodeBlock
        v-else-if="currentLlmExchange"
        :code="formatJson(currentLlmExchange)"
        language="json"
        copyable
        wrap
        max-height="70vh"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useAgentTimeline } from '../../composables/useAgentTimeline';
import { useSelectedConversation } from '../../composables/useSelectedConversation';
import { useAgentStore } from '../../stores/agents';
import { useSyncStore } from '../../stores/sync';
import { formatJson } from '../../utils/format-json';
import CodeBlock from '../content/CodeBlock.vue';
import ConversationTimeline from '../conversation/ConversationTimeline.vue';
import StatusBanner from '../ui/StatusBanner.vue';
import ViewState from '../ui/ViewState.vue';
import CompactionProgressBanner from './CompactionProgressBanner.vue';
import RetainedInstructionContext from './RetainedInstructionContext.vue';

import type { ConversationSessionId } from '../../api/contracts';
const props = defineProps<{
  sessionId: ConversationSessionId;
  kind: 'conversation' | 'llmExchange';
}>();
const agentStore = useAgentStore();
const liveSyncStore = useSyncStore();
const {
  currentSession,
  sessionSummaryLoading,
  sessionSummaryRefreshing,
  sessionSummaryError,
  sessionSummaryRefreshError,
  sessionSummaryUnauthorized,
  entries,
  conversationLoading,
  conversationRefreshing,
  conversationError,
  conversationRefreshError,
  conversationUnauthorized,
  conversationWarning,
  conversationSegmentContext,
  currentLlmExchange,
  llmExchangeLoaded,
  llmExchangeLoading,
  llmExchangeRefreshing,
  llmExchangeError,
  llmExchangeRefreshError,
} = storeToRefs(agentStore);
const timelineControls = useAgentTimeline(entries);
const endpointPath = computed(
  () =>
    `/api/agents/${encodeURIComponent(props.sessionId)}/${props.kind === 'conversation' ? 'conversation' : 'llm-exchange'}`,
);

const selectedConversation =
  props.kind === 'conversation' ? useSelectedConversation(props.sessionId) : null;
let exchangeToken: ReturnType<typeof agentStore.beginLlmExchangeSelection> | null = null;
let unregisterExchange: (() => void) | null = null;
const exchangeLeaseReady = ref(false);

async function refreshConversation(): Promise<void> {
  if (!selectedConversation)
    throw new Error('Conversation reload invoked for an LLM exchange detail.');
  await selectedConversation.reload();
}
async function refreshExchange(): Promise<void> {
  if (exchangeToken && exchangeLeaseReady.value) await agentStore.fetchLlmExchange(exchangeToken);
}

onMounted(() => {
  if (props.kind === 'conversation') return;
  exchangeToken = agentStore.beginLlmExchangeSelection(props.sessionId);
  const token = exchangeToken;
  unregisterExchange = liveSyncStore.openLlmExchange(props.sessionId, () => {
    exchangeLeaseReady.value = true;
    return agentStore.fetchLlmExchange(token);
  });
});

onUnmounted(() => {
  if (exchangeToken) {
    unregisterExchange?.();
    agentStore.clearLlmExchange(exchangeToken);
  }
});
</script>

<style scoped>
.agent-debug-detail {
  min-width: 0;
}
.agent-debug-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.auto-scroll-pause-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-muted);
  cursor: pointer;
}
.auto-scroll-pause-toggle input {
  margin: 0;
}
.agent-debug-path {
  margin-bottom: 10px;
  color: var(--text-muted);
  word-break: break-all;
}
.agent-debug-conversation {
  max-height: 70vh;
  overflow: auto;
  padding-right: 4px;
}
.agent-debug-jump-latest {
  position: sticky;
  bottom: 10px;
  left: 50%;
  transform: translateX(-50%);
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface-3);
  color: var(--accent-2);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  padding: 6px 12px;
}
.mono {
  font-family: 'SF Mono', monospace;
  font-size: 11px;
}
</style>
