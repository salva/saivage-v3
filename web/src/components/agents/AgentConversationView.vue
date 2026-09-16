<template>
  <div class="conversation-container">
    <StatusBanner v-if="sessionSummaryLoading && !currentSession" tone="stale" message="Loading session status…" />
    <StatusBanner v-else-if="sessionSummaryUnauthorized && !currentSession" tone="warning" message="Session status unavailable: provide a valid API token." />
    <StatusBanner v-else-if="sessionSummaryError && !currentSession" tone="warning" :message="sessionSummaryError" />
    <template v-if="currentSession">
      <div class="conv-header">
        <PanelHeader :title="currentSession.agent_name">
          <template #actions
            ><div class="conv-toolbar">
              <div class="conv-toolbar-group">
                <button class="conv-tb-btn" @click="timelineControls.expandAll()">Expand all</button
                ><button class="conv-tb-btn" @click="timelineControls.collapseAll()">
                  Collapse all
                </button>
              </div>
              <div class="conv-toolbar-group">
                <label class="auto-scroll-pause-toggle"
                  ><input
                    type="checkbox"
                    :checked="timelineControls.autoScrollPaused.value"
                    @change="timelineControls.toggleAutoScrollPause()"
                  />Pause auto-scroll</label
                >
              </div>
              <div class="conv-toolbar-group">
                <button
                  class="conv-tb-btn"
                  :aria-pressed="rawPanelOpen"
                  @click="rawPanelOpen = !rawPanelOpen"
                >
                  {{ rawPanelOpen ? 'Hide raw exchange' : 'Raw exchange' }}
                </button>
              </div>
            </div></template
          >
        </PanelHeader>
      </div>
      <CompactionProgressBanner v-if="currentSession.compaction" :progress="currentSession.compaction" :last-known="sessionSummaryRefreshError !== null" />
      <StatusBanner v-if="sessionSummaryRefreshError" tone="warning" :message="sessionSummaryRefreshError" />
      <StatusBanner v-if="sessionSummaryRefreshing" tone="stale" message="Refreshing session status…" />
    </template>
      <ViewState v-if="loading" state="loading" title="Loading conversation" />
      <ViewState v-else-if="conversationUnauthorized && errorMsg" state="unauthorized" title="Conversation unavailable" message="Provide a valid API token to load this conversation." />
      <ViewState v-else-if="errorMsg" state="error" title="Could not load conversation" :message="errorMsg" />
      <ViewState
        v-else-if="!conversationBaselineAccepted"
        state="loading"
        title="Waiting for conversation"
        :message="socketWaitingMessage"
      />
      <template v-else>
      <RawLlmExchangePanel
        v-if="rawPanelOpen"
        :key="props.sessionId"
        :session-id="props.sessionId"
      />
      <section v-if="conversationSegmentContext" class="segment-context" data-testid="conversation-segment-context">
        <strong>Compacted segment {{ conversationSegmentContext.source_version + 1 }}</strong>
        <span>History covered through {{ conversationSegmentContext.covered_through_message_id }}</span>
        <span v-if="conversationSegmentContext.continuation.kind === 'inherited_open_round'">
          Inherited open activation {{ conversationSegmentContext.continuation.activation.marker_id }} · input {{ conversationSegmentContext.continuation.activation.input_id }} · {{ conversationSegmentContext.continuation.active_segment_kind }}
        </span>
        <span v-else>Compacted between rounds</span>
      </section>
      <details class="version-history" @toggle="onVersionHistoryToggle">
        <summary>Segment history</summary>
        <ViewState v-if="conversationVersionsLoading" state="loading" title="Loading segment history" />
        <StatusBanner v-else-if="conversationVersionsError" tone="warning" :message="conversationVersionsError" />
        <div v-else class="version-list">
          <button v-for="version in conversationVersions" :key="version.entry_id" class="conv-tb-btn" @click="selectVersion(version.version)">Segment {{ version.version }} · {{ version.genesis_kind }}</button>
        </div>
        <ViewState v-if="selectedConversationVersionLoading" state="loading" title="Loading selected segment" />
        <StatusBanner v-else-if="selectedConversationVersionError" tone="warning" :message="selectedConversationVersionError" />
        <div v-else-if="selectedConversationVersion" class="selected-version">
          <strong>Historical segment {{ selectedConversationVersion.version }}</strong>
          <ConversationTimeline :timeline="historicalTimeline" :expanded-ids="historicalExpandedIds" @toggle="toggleHistoricalExpanded" />
        </div>
      </details>
      <StatusBanner v-if="conversationWarning" tone="warning" :message="conversationWarning" />
      <StatusBanner
        v-if="conversationRefreshError"
        tone="warning"
        :message="conversationRefreshError"
      />
      <StatusBanner v-if="conversationRefreshing" tone="stale" message="Refreshing conversation…" />
      <StatusBanner v-if="entryId && entryTargetState === 'missing'" tone="warning" message="The requested conversation entry was not found in this session." />
      <div
        :ref="setTimelineScrollArea"
        class="conv-rounds"
        @scroll="timelineControls.handleTimelineScroll"
      >
        <ConversationTimeline
          :timeline="timelineControls.timeline.value"
          :expanded-ids="timelineControls.expandedIds.value"
          @toggle="timelineControls.toggleExpanded"
        />
      </div>
      <button
        v-if="!timelineControls.pinnedToLatest.value || timelineControls.unseenCount.value > 0"
        type="button"
        class="conv-jump-latest"
        @click="timelineControls.jumpToLatest"
      >
        Jump to latest<span v-if="timelineControls.unseenCount.value > 0">
          · {{ timelineControls.unseenCount.value }} new</span
        >
      </button>
      </template>
  </div>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ComponentPublicInstance } from 'vue';
import { storeToRefs } from 'pinia';
import { useSelectedConversation } from '../../composables/useSelectedConversation';
import { useAgentStore } from '../../stores/agents';
import { useSyncStore } from '../../stores/sync';
import { useAgentTimeline } from '../../composables/useAgentTimeline';
import ConversationTimeline from '../conversation/ConversationTimeline.vue';
import PanelHeader from '../ui/PanelHeader.vue';
import StatusBanner from '../ui/StatusBanner.vue';
import ViewState from '../ui/ViewState.vue';
import RawLlmExchangePanel from './RawLlmExchangePanel.vue';
import CompactionProgressBanner from './CompactionProgressBanner.vue';
import type { ConversationSessionId } from '../../api/contracts';
import { entriesToTimeline } from '../../utils/agent-timeline/timeline';
const props = defineProps<{ sessionId: ConversationSessionId; entryId: string | null }>();
const agentStore = useAgentStore();
const liveSync = useSyncStore();
const {
  currentSession,
  sessionSummaryLoading,
  sessionSummaryRefreshing,
  sessionSummaryError,
  sessionSummaryRefreshError,
  sessionSummaryUnauthorized,
  entries,
  conversationBaselineAccepted,
  conversationLoading: loading,
  conversationError: errorMsg,
  conversationRefreshError,
  conversationRefreshing,
  conversationUnauthorized,
  conversationWarning,
  conversationSegmentContext,
  conversationVersions,
  conversationVersionsLoading,
  conversationVersionsError,
  selectedConversationVersion,
  selectedConversationVersionLoading,
  selectedConversationVersionError,
} = storeToRefs(agentStore);
const selectedConversation = useSelectedConversation(props.sessionId);
const rawPanelOpen = ref(false);
const timelineControls = useAgentTimeline(entries);
const entryTargetState = ref<'idle' | 'found' | 'missing'>('idle');
const historicalExpandedIds = ref(new Set<string>());
const historicalTimeline = computed(() => entriesToTimeline(selectedConversationVersion.value?.entries ?? []));
const socketWaitingMessage = computed(() =>
  liveSync.connectionState === 'unauthorized'
    ? 'Live connection unauthorized. Open Token and save a valid API token to reconnect.'
    : liveSync.connectionState === 'connected'
    ? 'Waiting for the live conversation subscription acknowledgement.'
    : 'Live sync is not connected. The conversation will load when the live connection is re-established.',
);
function toggleHistoricalExpanded(id: string): void { const next = new Set(historicalExpandedIds.value); next.has(id) ? next.delete(id) : next.add(id); historicalExpandedIds.value = next; }
function onVersionHistoryToggle(event: Event): void { if ((event.currentTarget as HTMLDetailsElement).open) void selectedConversation.fetchVersions(); }
function selectVersion(version: number): void { void selectedConversation.selectVersion(version); }
function setTimelineScrollArea(el: Element | ComponentPublicInstance | null): void {
  timelineControls.scrollAreaRef.value = el instanceof HTMLElement ? el : null;
}
watch(
  [entries, loading, conversationRefreshing],
  (current, previous) => {
    if (
      current[0] === previous[0] ||
      current[1] ||
      current[2] ||
      currentSession.value?.id !== props.sessionId ||
      !props.entryId
    )
      return;
    const row =
      timelineControls.scrollAreaRef.value?.querySelector<HTMLElement>(
        `[data-entry-id="${props.entryId}"]`,
      ) ?? null;
    entryTargetState.value = row ? 'found' : 'missing';
    if (row) {
      row.classList.add('targeted-conversation-entry');
      row.scrollIntoView({ block: 'center' });
    }
  },
  { flush: 'post' },
);
</script>
<style scoped>
.conversation-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.conversation-container > :deep(.view-state) {
  padding: 32px;
  justify-content: center;
  text-align: center;
}
.conversation-container > :deep(.status-banner) {
  margin: 12px 16px 0;
}
.conv-header {
  padding: 8px 16px;
  background: var(--surface-1);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.conv-header :deep(.ui-panel-header) {
  margin-bottom: 0;
}
.conv-header :deep(.ui-panel-header__title) {
  text-transform: capitalize;
}
.conv-header :deep(.ui-panel-header__meta) {
  display: flex;
  align-items: center;
  gap: 8px;
}
.conv-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.conv-toolbar-group {
  display: flex;
  align-items: center;
  gap: 6px;
}
.auto-scroll-pause-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
}
.auto-scroll-pause-toggle input {
  margin: 0;
}
.conv-tb-btn {
  padding: 3px 8px;
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font-size: 11px;
  cursor: pointer;
  font-family: inherit;
}
.conv-rounds {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.segment-context, .version-history { margin:10px 16px 0; padding:10px; border:1px solid var(--border); border-radius:6px; background:var(--surface-2); }
.segment-context { display:flex; flex-direction:column; gap:4px; font-size:12px; }
.version-list { display:flex; flex-wrap:wrap; gap:6px; margin:8px 0; }
.selected-version { margin-top:10px; }
.conv-rounds :deep(.targeted-conversation-entry) { outline:2px solid var(--warn); outline-offset:2px; }
.conv-jump-latest {
  align-self: center;
  margin: 0 0 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface-3);
  color: var(--accent-2);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  padding: 6px 12px;
}
</style>
