<template>
  <div class="conversation-container">
    <StatusBanner v-if="sessionSummaryLoading && !currentSession" tone="stale" message="Loading session status…" />
    <StatusBanner v-else-if="sessionSummaryUnauthorized && !currentSession" tone="warning" message="Session status unavailable: this browser is not authorized for the operator API." />
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
                  {{ rawPanelOpen ? 'Hide provider exchange metadata' : 'Provider exchange metadata' }}
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
      <ViewState v-if="invalidSegment" state="error" title="Invalid segment selection" message="Select an exact positive safe integer segment. No replacement is searched." />
      <ViewState v-else-if="readerLoading" state="loading" title="Loading conversation" />
      <ViewState v-else-if="!segmentVersion && conversationUnauthorized && readerError" state="unauthorized" title="Conversation unavailable" message="This browser is not authorized for the operator API, so the conversation cannot be loaded." />
      <ViewState v-else-if="readerError" state="error" title="Could not load selected segment" :message="readerError" />
      <ViewState
        v-else-if="!readerAccepted"
        state="loading"
        title="Waiting for conversation"
        :message="socketWaitingMessage"
      />
      <template v-else>
      <div class="conversation-context" tabindex="0" aria-label="Selected segment context and activation entries">
      <RawLlmExchangePanel
        v-if="rawPanelOpen"
        :key="props.sessionId"
        :session-id="props.sessionId"
      />
      <section v-if="readerContext" class="segment-context" data-testid="conversation-segment-context">
        <strong>Compacted segment {{ readerVersion }}</strong>
        <span>Earlier history was compacted; this segment begins after message <span class="mono" :title="readerContext.covered_through_message_id">{{ compactUuid(readerContext.covered_through_message_id) }}</span>.</span>
        <span v-if="readerContext.continuation.kind === 'inherited_open_round'">
          Continuation context: an open activation from the previous segment continues here; this is not another activation entry.
          <span class="segment-context-ids">Marker <ExactValue :value="readerContext.continuation.activation.marker_id" label="continuation marker ID" /> · input <ExactValue :value="readerContext.continuation.activation.input_id" label="continuation input ID" /> · active segment kind {{ readerContext.continuation.active_segment_kind }}</span>
        </span>
        <span v-else>Compacted between rounds</span>
      </section>
      <RetainedInstructionContext :context="readerContext" />
      <details class="version-history" :open="segmentVersion !== null && segmentVersion !== undefined" @toggle="onVersionHistoryToggle">
        <summary>Segment history</summary>
        <ViewState v-if="conversationVersionsLoading" state="loading" title="Loading segment history" />
        <StatusBanner v-else-if="conversationVersionsError" tone="warning" :message="conversationVersionsError" />
        <div v-else class="version-list">
          <button v-for="version in conversationVersions" :key="version.entry_id" class="conv-tb-btn" @click="selectVersion(version.version)">Segment {{ version.version }}<span class="segment-genesis mono"> · {{ version.genesis_kind }}</span></button>
          <button class="conv-tb-btn" @click="selectVersion(null)">Current segment</button>
        </div>
      </details>
      <section class="activation-index segment-context" data-testid="activation-index">
        <strong>Activation entries — this segment</strong>
        <span>Session {{ sessionId }} · segment {{ readerVersion }}{{ segmentVersion ? ' (exact selection)' : ' (current)' }}</span>
        <span>Markers retained in this segment only; earlier entries may have been compacted. Entry does not prove a provider call or completion.</span>
        <StatusBanner v-if="projection.error" tone="warning" :message="projection.error" />
        <span v-else-if="projection.markers.length === 0">No activation markers retained in this segment</span>
        <ol v-else>
          <li v-for="marker in projection.markers" :key="marker.entry.id">
            Activation entry recorded · {{ marker.agentName }} · {{ marker.entry.timestamp }}
            <router-link :to="{ name: 'agent-detail', params: { id: sessionId }, query: { segment: String(readerVersion), entry: marker.entry.id } }">Open entry</router-link>
            <details><summary>Recorded identities</summary>
              <ExactValue :value="marker.entry.session_id" label="session ID" /> · <ExactValue :value="marker.entry.id" label="marker ID" /> · <ExactValue :value="marker.inputId" label="input ID" />
              <ExactValue v-if="marker.cardId" :value="marker.cardId" label="card ID" />
            </details>
          </li>
        </ol>
      </section>
      <StatusBanner v-if="!segmentVersion && conversationWarning" tone="warning" :message="conversationWarning" />
      <StatusBanner
        v-if="!segmentVersion && conversationRefreshError"
        tone="warning"
        :message="conversationRefreshError"
      />
      <StatusBanner v-if="!segmentVersion && conversationRefreshing" tone="stale" message="Refreshing conversation…" />
      <StatusBanner v-if="entryId && entryTargetState === 'missing' && !projection.error" tone="warning" :message="`The requested conversation entry was not found in ${segmentVersion ? 'the selected exact' : 'the current'} segment.`" />
      </div>
      <div
        :ref="setTimelineScrollArea"
        class="conv-rounds"
        @scroll="timelineControls.handleTimelineScroll"
      >
        <ConversationTimeline v-if="!projection.error"
          :timeline="timelineControls.timeline.value"
          :expanded-ids="timelineControls.expandedIds.value"
          @toggle="timelineControls.toggleExpanded"
        />
      </div>
      <button
        v-if="!segmentVersion && (!timelineControls.pinnedToLatest.value || timelineControls.unseenCount.value > 0)"
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
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { ComponentPublicInstance } from 'vue';
import { storeToRefs } from 'pinia';
import { useSelectedConversation } from '../../composables/useSelectedConversation';
import { useAgentStore } from '../../stores/agents';
import { useSyncStore } from '../../stores/sync';
import { useAgentTimeline } from '../../composables/useAgentTimeline';
import { compactUuid } from '../../utils/legibility';
import ConversationTimeline from '../conversation/ConversationTimeline.vue';
import PanelHeader from '../ui/PanelHeader.vue';
import StatusBanner from '../ui/StatusBanner.vue';
import ViewState from '../ui/ViewState.vue';
import RawLlmExchangePanel from './RawLlmExchangePanel.vue';
import CompactionProgressBanner from './CompactionProgressBanner.vue';
import RetainedInstructionContext from './RetainedInstructionContext.vue';
import ExactValue from '../ui/ExactValue.vue';
import type { ConversationSessionId } from '../../api/contracts';
import { activationEntries } from '../../utils/agent-timeline/activation';
const props = defineProps<{ sessionId: ConversationSessionId; entryId: string | null; segmentVersion?: number | null; invalidSegment?: boolean }>();
const route = useRoute();
const router = useRouter();
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
  conversationSegmentVersion,
  conversationVersions,
  conversationVersionsLoading,
  conversationVersionsError,
  selectedConversationVersion,
  selectedConversationVersionLoading,
  selectedConversationVersionError,
} = storeToRefs(agentStore);
const exactVersion = computed(() => props.segmentVersion ?? null);
const selectedConversation = useSelectedConversation(props.sessionId, exactVersion);
const rawPanelOpen = ref(false);
const readerEntries = computed(() => exactVersion.value ? selectedConversationVersion.value?.entries ?? [] : entries.value);
const readerVersion = computed(() => exactVersion.value ? selectedConversationVersion.value?.version ?? null : conversationSegmentVersion.value);
const readerContext = computed(() => exactVersion.value ? selectedConversationVersion.value?.segment_context ?? null : conversationSegmentContext.value);
const readerLoading = computed(() => exactVersion.value ? selectedConversationVersionLoading.value : loading.value);
const readerError = computed(() => exactVersion.value ? selectedConversationVersionError.value : errorMsg.value);
const readerAccepted = computed(() => exactVersion.value ? selectedConversationVersion.value !== null : conversationBaselineAccepted.value);
const projection = computed(() => {
  try { return { markers: activationEntries(readerEntries.value), error: null }; }
  catch (error) { return { markers: [], error: error instanceof Error ? error.message : String(error) }; }
});
const displayEntries = computed(() => projection.value.error ? [] : readerEntries.value);
const timelineControls = useAgentTimeline(displayEntries);
const entryTargetState = ref<'idle' | 'found' | 'missing'>('idle');
const socketWaitingMessage = computed(() =>
  liveSync.connectionState === 'unauthorized'
    ? 'Live connection unauthorized. The conversation loads when an authorized browser connection is available.'
    : liveSync.connectionState === 'connected'
    ? 'Waiting for the live conversation subscription acknowledgement.'
    : 'Live sync is not connected. The conversation will load when the live connection is re-established.',
);
function onVersionHistoryToggle(event: Event): void { if ((event.currentTarget as HTMLDetailsElement).open) void selectedConversation.fetchVersions(); }
function selectVersion(version: number | null): void {
  const query = { ...route.query };
  delete query.entry;
  if (version === null) delete query.segment;
  else query.segment = String(version);
  void router.push({ name: 'agent-detail', params: { id: props.sessionId }, query });
}
function setTimelineScrollArea(el: Element | ComponentPublicInstance | null): void {
  timelineControls.scrollAreaRef.value = el instanceof HTMLElement ? el : null;
}
watch([readerEntries, readerAccepted, readerLoading, readerError, () => props.sessionId, () => props.segmentVersion, () => props.entryId, () => props.invalidSegment], async (_values, _previous, onCleanup) => {
  let cancelled = false;
  onCleanup(() => { cancelled = true; });
  const container = timelineControls.scrollAreaRef.value;
  container?.querySelectorAll('.targeted-conversation-entry').forEach((row) => row.classList.remove('targeted-conversation-entry'));
  if (!props.entryId || !readerAccepted.value || readerLoading.value || readerError.value || props.invalidSegment || projection.value.error) { entryTargetState.value = 'idle'; return; }
  const entryId = props.entryId;
  entryTargetState.value = 'idle';
  await nextTick();
  if (cancelled) return;
  const row = [...(container?.querySelectorAll<HTMLElement>('[data-entry-id]') ?? [])].find((row) => row.dataset.entryId === entryId) ?? null;
  entryTargetState.value = row ? 'found' : 'missing';
  if (row) {
    row.tabIndex = -1;
    row.classList.add('targeted-conversation-entry');
    row.scrollIntoView({ block: 'center' });
    row.focus({ preventScroll: true });
  }
}, { flush: 'post', immediate: true });
watch([exactVersion, () => props.entryId], () => { timelineControls.autoScrollPaused.value = exactVersion.value !== null || props.entryId !== null; }, { immediate: true });
</script>
<style scoped>
.conversation-container {
  flex: 1;
  min-height: 0;
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
  flex-wrap: wrap;
}
.conv-header :deep(.ui-panel-header__title) {
  text-transform: capitalize;
}
.conv-header :deep(.ui-panel-header__meta) {
  display: flex;
  align-items: center;
  gap: 8px;
}
.conv-header :deep(.ui-panel-header__actions) { min-width: 0; max-width: 100%; }
.conv-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.conv-toolbar-group {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
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
  flex: 1 0 160px;
  min-height: 160px;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.segment-context, .version-history { margin:10px 16px 0; padding:10px; border:1px solid var(--border); border-radius:6px; background:var(--surface-2); color:var(--text); }
.segment-context { display:flex; flex-direction:column; gap:4px; font-size:12px; }
.conversation-context { flex: 0 1 auto; min-height: 0; max-height: 35%; overflow-y: auto; }
.conversation-context > :deep(.status-banner) { margin: 12px 16px 0; }
.activation-index { overflow-wrap: anywhere; }
.activation-index ol { margin: 4px 0; padding-left: 20px; }
.activation-index a { margin-left: 8px; color: var(--accent-2); }
.segment-context-ids { color:var(--text-muted); font-size:11px; }
.segment-genesis { font-size:10px; color:var(--text-muted); }
.version-list { display:flex; flex-wrap:wrap; gap:6px; margin:8px 0; }
.conv-rounds :deep(.targeted-conversation-entry) { outline:2px solid var(--warn); outline-offset:2px; }
.conv-jump-latest {
  flex-shrink: 0;
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
