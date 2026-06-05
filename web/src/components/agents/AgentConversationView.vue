<template>
  <div class="conversation-container">
    <div v-if="loading" class="conv-loading">Loading conversation...</div>
    <div v-else-if="errorMsg" class="conv-error">{{ errorMsg }}</div>
    <div v-else-if="!currentSession" class="conv-empty">Select a session to view its conversation.</div>
    <template v-else>
      <div class="conv-header">
        <div class="conv-info"><span class="conv-role">{{ currentSession.role }}</span><span class="conv-model">{{ currentSession.model || 'default' }}</span><span class="conv-status-badge" :class="'s-' + currentSession.status">{{ currentSession.status }}</span></div>
        <div class="conv-toolbar"><button class="conv-tb-btn" @click="timelineControls.expandAll()">Expand all</button><button class="conv-tb-btn" @click="timelineControls.collapseAll()">Collapse all</button><button class="conv-tb-btn" :aria-pressed="rawPanelOpen" @click="rawPanelOpen = !rawPanelOpen">{{ rawPanelOpen ? 'Hide raw LLM exchange' : 'Last raw LLM exchange' }}</button></div>
      </div>
      <RawLlmExchangePanel v-if="rawPanelOpen" :session-id="props.sessionId" />
      <div v-if="conversationWarning" class="conv-warning">{{ conversationWarning }}</div>
      <div class="conv-rounds"><RoundCard v-for="round in timelineControls.timeline.value.rounds" :key="round.id" :round="round" :expanded-ids="timelineControls.expandedIds.value" @toggle="timelineControls.toggleExpanded" /></div>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useAgentStore } from '../../stores/agents';
import { useSyncStore } from '../../stores/sync';
import { createLogger } from '../../utils/logger';
import { useAgentTimeline } from '../../composables/useAgentTimeline';
import RoundCard from '../conversation/RoundCard.vue';
import RawLlmExchangePanel from './RawLlmExchangePanel.vue';
const log = createLogger('comp:agent-conv');
const props = defineProps<{ sessionId: string }>();
const agentStore = useAgentStore();
const syncStore = useSyncStore();
const { currentSession, entries, activityStatus, loading, error, conversationWarning } = storeToRefs(agentStore);
const errorMsg = computed(() => error.value);
const rawPanelOpen = ref(false);
const timelineControls = useAgentTimeline(entries, activityStatus, () => agentStore.currentSession?.id ?? null);
let unsubscribeConversation: (() => void) | null = null;
function subscribeConversation(sessionId: string): void { unsubscribeConversation?.(); unsubscribeConversation = syncStore.openConversation(sessionId, () => agentStore.refetchConversation(sessionId)); }
onMounted(async () => { subscribeConversation(props.sessionId); try { await agentStore.fetchConversation(props.sessionId); } catch (err) { log.error('fetch', err); } });
onUnmounted(() => { unsubscribeConversation?.(); });
watch(() => props.sessionId, async (nid) => { rawPanelOpen.value = false; if (nid) { subscribeConversation(nid); try { await agentStore.fetchConversation(nid); } catch (err) { log.error('fetch', err); } } });
</script>
<style scoped>.conversation-container{flex:1;display:flex;flex-direction:column;overflow:hidden}.conv-loading,.conv-error,.conv-empty{padding:32px;text-align:center;color:var(--text-muted);font-size:13px}.conv-error{color:var(--danger)}.conv-warning{margin:12px 16px 0;padding:10px 12px;border:1px solid var(--entry-warn-border);background:var(--entry-warn-bg);color:var(--warn);border-radius:6px;font-size:12px}.conv-header{display:flex;align-items:center;justify-content:space-between;padding:8px 16px;background:var(--surface-1);border-bottom:1px solid var(--border);flex-shrink:0}.conv-info,.conv-toolbar{display:flex;align-items:center;gap:8px}.conv-role{font-size:12px;font-weight:600;color:var(--text);text-transform:capitalize}.conv-model{font-size:11px;color:var(--text-muted);font-family:'SF Mono',monospace}.conv-status-badge{font-size:10px;font-weight:600;padding:1px 6px;border-radius:8px}.conv-tb-btn{padding:3px 8px;background:var(--surface-3);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:11px;cursor:pointer;font-family:inherit}.conv-rounds{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}</style>
