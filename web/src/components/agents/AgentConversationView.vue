<template>
  <div class="conversation-container">
    <ViewState v-if="loading" state="loading" title="Loading conversation" />
    <ViewState v-else-if="errorMsg" state="error" title="Could not load conversation" :message="errorMsg" />
    <ViewState v-else-if="!currentSession" state="empty" title="Select a session to view its conversation" />
    <template v-else>
      <div class="conv-header">
        <PanelHeader :title="currentSession.role">
          <template #meta><span class="conv-model">{{ currentSession.model || 'default' }}</span><StatusBadge :status="statusForAgentSession(currentSession.status)" /></template>
          <template #actions><div class="conv-toolbar"><div class="conv-toolbar-group"><button class="conv-tb-btn" @click="timelineControls.expandAll()">Expand all</button><button class="conv-tb-btn" @click="timelineControls.collapseAll()">Collapse all</button></div><div class="conv-toolbar-group"><button class="conv-tb-btn" :aria-pressed="rawPanelOpen" @click="rawPanelOpen = !rawPanelOpen">{{ rawPanelOpen ? 'Hide raw exchange' : 'Raw exchange' }}</button></div></div></template>
        </PanelHeader>
      </div>
      <RawLlmExchangePanel v-if="rawPanelOpen" :session-id="props.sessionId" />
      <StatusBanner v-if="conversationWarning" tone="warning" :message="conversationWarning" />
      <div class="conv-rounds"><ConversationTimeline :timeline="timelineControls.timeline.value" :expanded-ids="timelineControls.expandedIds.value" @toggle="timelineControls.toggleExpanded" /></div>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
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
const props = defineProps<{ sessionId: string }>();
const agentStore = useAgentStore();
const liveSyncStore = useLiveSyncStore();
const { currentSession, entries, activityStatus, loading, error, conversationWarning } = storeToRefs(agentStore);
const errorMsg = computed(() => error.value);
const rawPanelOpen = ref(false);
const timelineControls = useAgentTimeline(entries, activityStatus);
let unsubscribeConversation: (() => void) | null = null;
function subscribeConversation(sessionId: string): void { unsubscribeConversation?.(); unsubscribeConversation = liveSyncStore.openConversation(sessionId, () => agentStore.refetchConversation(sessionId)); }
onMounted(async () => { subscribeConversation(props.sessionId); try { await agentStore.fetchConversation(props.sessionId); } catch (err) { log.error('fetch', err); } });
onUnmounted(() => { unsubscribeConversation?.(); });
watch(() => props.sessionId, async (nid) => { rawPanelOpen.value = false; if (nid) { subscribeConversation(nid); try { await agentStore.fetchConversation(nid); } catch (err) { log.error('fetch', err); } } });
</script>
<style scoped>.conversation-container{flex:1;display:flex;flex-direction:column;overflow:hidden}.conversation-container > :deep(.view-state){padding:32px;justify-content:center;text-align:center}.conversation-container > :deep(.status-banner){margin:12px 16px 0}.conv-header{padding:8px 16px;background:var(--surface-1);border-bottom:1px solid var(--border);flex-shrink:0}.conv-header :deep(.ui-panel-header){margin-bottom:0}.conv-header :deep(.ui-panel-header__title){text-transform:capitalize}.conv-header :deep(.ui-panel-header__meta){display:flex;align-items:center;gap:8px}.conv-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px}.conv-toolbar-group{display:flex;align-items:center;gap:6px}.conv-model{font-size:11px;color:var(--text-muted);font-family:'SF Mono',monospace}.conv-tb-btn{padding:3px 8px;background:var(--surface-3);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:11px;cursor:pointer;font-family:inherit}.conv-rounds{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}</style>
