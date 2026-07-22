<template>
  <div class="conversation-container">
    <ViewState v-if="loading" state="loading" title="Loading conversation" />
    <ViewState v-else-if="conversationUnauthorized" state="unauthorized" title="Conversation unavailable" message="Provide a valid API token to load this conversation." />
    <ViewState v-else-if="errorMsg" state="error" title="Could not load conversation" :message="errorMsg" />
    <ViewState v-else-if="!currentSession" state="empty" title="Select a session to view its conversation" />
    <template v-else>
      <div class="conv-header">
        <PanelHeader :title="currentSession.agent_name">
          <template #meta><span class="conv-model">{{ currentSession.model || 'default' }}</span><StatusBadge :status="statusForAgentSession(currentSession.status)" /></template>
          <template #actions><div class="conv-toolbar"><div class="conv-toolbar-group"><button class="conv-tb-btn" @click="timelineControls.expandAll()">Expand all</button><button class="conv-tb-btn" @click="timelineControls.collapseAll()">Collapse all</button></div><div class="conv-toolbar-group"><label class="auto-scroll-pause-toggle"><input type="checkbox" :checked="timelineControls.autoScrollPaused.value" @change="timelineControls.toggleAutoScrollPause()" />Pause auto-scroll</label></div><div class="conv-toolbar-group"><button class="conv-tb-btn" :aria-pressed="rawPanelOpen" @click="rawPanelOpen = !rawPanelOpen">{{ rawPanelOpen ? 'Hide raw exchange' : 'Raw exchange' }}</button></div></div></template>
        </PanelHeader>
      </div>
      <RawLlmExchangePanel v-if="rawPanelOpen" :key="props.sessionId" :session-id="props.sessionId" />
      <StatusBanner v-if="conversationWarning" tone="warning" :message="conversationWarning" />
      <StatusBanner v-if="conversationRefreshError" tone="warning" :message="conversationRefreshError" />
      <StatusBanner v-if="conversationRefreshing" tone="stale" message="Refreshing conversation…" />
      <div :ref="setTimelineScrollArea" class="conv-rounds" @scroll="timelineControls.handleTimelineScroll">
        <ConversationTimeline :timeline="timelineControls.timeline.value" :expanded-ids="timelineControls.expandedIds.value" @toggle="timelineControls.toggleExpanded" />
      </div>
      <button
        v-if="!timelineControls.pinnedToLatest.value || timelineControls.unseenCount.value > 0"
        type="button"
        class="conv-jump-latest"
        @click="timelineControls.jumpToLatest"
      >Jump to latest<span v-if="timelineControls.unseenCount.value > 0"> · {{ timelineControls.unseenCount.value }} new</span></button>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import type { ComponentPublicInstance } from 'vue';
import { storeToRefs } from 'pinia';
import { useAgentStore } from '../../stores/agents';
import { useLiveSyncStore } from '../../stores/liveSync';
import { createLogger } from '../../utils/logger';
import { statusForAgentSession } from '../../utils/status';
import { useAgentTimeline } from '../../composables/useAgentTimeline';
import ConversationTimeline from '../conversation/ConversationTimeline.vue';
import PanelHeader from '../ui/PanelHeader.vue';
import StatusBadge from '../ui/StatusBadge.vue';
import StatusBanner from '../ui/StatusBanner.vue';
import ViewState from '../ui/ViewState.vue';
import RawLlmExchangePanel from './RawLlmExchangePanel.vue';
const log = createLogger('comp:agent-conv');
import type { ConversationSessionId } from '../../api/contracts';
const props = defineProps<{ sessionId: ConversationSessionId }>();
const agentStore = useAgentStore();
const liveSyncStore = useLiveSyncStore();
const { currentSession, entries, activityStatus, conversationLoading: loading, conversationError, conversationRefreshError, conversationRefreshing, conversationUnauthorized, conversationWarning } = storeToRefs(agentStore);
const errorMsg = computed(() => conversationError.value);
const rawPanelOpen = ref(false);
const sessionModel = computed(() => currentSession.value?.model ?? null);
const timelineControls = useAgentTimeline(entries, activityStatus, sessionModel);
let unsubscribeConversation: (() => void) | null = null;
let conversationToken: ReturnType<typeof agentStore.beginConversationSelection> | null = null;
function setTimelineScrollArea(el: Element | ComponentPublicInstance | null): void { timelineControls.scrollAreaRef.value = el instanceof HTMLElement ? el : null; }
onMounted(async () => {
  conversationToken = agentStore.beginConversationSelection(props.sessionId);
  const token = conversationToken;
  unsubscribeConversation = liveSyncStore.openConversation(props.sessionId, () => agentStore.refetchConversation(token));
  try {
    await agentStore.fetchConversation(token);
    timelineControls.resetScrollState();
  } catch (err) {
    log.error('fetch', err);
  }
});
onUnmounted(() => {
  unsubscribeConversation?.();
  if (conversationToken) agentStore.clearConversationSelection(conversationToken);
});
</script>
<style scoped>.conversation-container{flex:1;display:flex;flex-direction:column;overflow:hidden}.conversation-container > :deep(.view-state){padding:32px;justify-content:center;text-align:center}.conversation-container > :deep(.status-banner){margin:12px 16px 0}.conv-header{padding:8px 16px;background:var(--surface-1);border-bottom:1px solid var(--border);flex-shrink:0}.conv-header :deep(.ui-panel-header){margin-bottom:0}.conv-header :deep(.ui-panel-header__title){text-transform:capitalize}.conv-header :deep(.ui-panel-header__meta){display:flex;align-items:center;gap:8px}.conv-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px}.conv-toolbar-group{display:flex;align-items:center;gap:6px}.auto-scroll-pause-toggle{display:inline-flex;align-items:center;gap:4px;color:var(--text-muted);cursor:pointer;font-size:12px}.auto-scroll-pause-toggle input{margin:0}.conv-model{font-size:11px;color:var(--text-muted);font-family:'SF Mono',monospace}.conv-tb-btn{padding:3px 8px;background:var(--surface-3);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:11px;cursor:pointer;font-family:inherit}.conv-rounds{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}.conv-jump-latest{align-self:center;margin:0 0 10px;border:1px solid var(--border);border-radius:999px;background:var(--surface-3);color:var(--accent-2);cursor:pointer;font:inherit;font-size:12px;padding:6px 12px}</style>
