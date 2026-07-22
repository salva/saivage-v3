<template>
  <aside
    id="analyst-chat-panel"
    class="analyst-chat-panel"
    role="region"
    aria-label="Analyst chat"
  >
    <div :ref="setTimelineScrollArea" class="chat-scroll-area" data-testid="chat-scroll-container" @scroll="timelineControls.handleTimelineScroll">
      <section v-if="childrenOnScreen.length" class="chat-context-card" aria-labelledby="on-screen-title">
        <h3 id="on-screen-title">On screen</h3>
        <ul class="on-screen-children">
          <li v-for="child in childrenOnScreen" :key="child.id">{{ child.id }} — {{ child.title }}</li>
        </ul>
      </section>

      <div v-if="messagesLoading" class="chat-status-card loading-skeleton" role="status">Loading history…</div>
      <div v-else-if="messagesError" class="chat-status-card chat-status-error" role="alert">{{ messagesErrorLabel }}</div>
      <div v-else-if="!messagesLoading && messages.length === 0 && timelineControls.timeline.value.rounds.length === 0" class="chat-status-card" role="status">No messages yet. Ask the analyst something.</div>
      <div v-else class="chat-rounds">
        <ConversationTimeline :timeline="timelineControls.timeline.value" :expanded-ids="timelineControls.expandedIds.value" @toggle="timelineControls.toggleExpanded" />
      </div>
    </div>
    <button
      v-if="!timelineControls.pinnedToLatest.value || timelineControls.unseenCount.value > 0"
      type="button"
      class="jump-to-latest"
      @click="timelineControls.jumpToLatest"
    >Jump to latest<span v-if="timelineControls.unseenCount.value > 0"> · {{ timelineControls.unseenCount.value }} new</span></button>

    <form class="chat-input-panel" @submit.prevent="submitMessage">
      <div v-if="restartAcknowledgement" class="chat-status-card chat-status-warning" role="status">Restart confirmation required. Send exactly <code>RESTART SERVER</code> to schedule server shutdown.</div>
      <textarea
        ref="composerRef"
        :value="draft"
        class="chat-input-field"
        rows="3"
        placeholder="Ask the analyst…"
        aria-label="Analyst chat composer"
        :disabled="!activeSessionWritable"
        :title="composerTitle"
        @input="handleDraftInput"
        @keydown="handleComposerKeydown"
      />
      <div class="chat-input-footer">
        <div class="chat-input-hints">
          <span class="subtle">Enter to send · Shift+Enter for newline</span>
          <label class="auto-scroll-pause-toggle">
            <input
              type="checkbox"
              :checked="timelineControls.autoScrollPaused.value"
              @change="timelineControls.toggleAutoScrollPause()"
            />
            Pause auto-scroll
          </label>
        </div>
        <button type="submit" class="chat-send-button" :disabled="!activeSessionWritable || sending || !draft.trim()" :title="composerTitle">{{ sending ? 'Sending…' : 'Send' }}</button>
      </div>
      <div v-if="sendError" class="chat-status-card chat-status-error" role="alert">{{ sendError.message }}</div>
    </form>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ComponentPublicInstance } from 'vue';
import { storeToRefs } from 'pinia';
import type { AgentConversationEntry } from '../../types/view-models';
import { useAnalystChat } from '../../stores/analystChat';
import { useCardStore } from '../../stores/cards';
import { useWorkspaceRouteStore } from '../../stores/workspaceRoute';
import { useLiveSyncStore } from '../../stores/liveSync';
import { useAgentTimeline } from '../../composables/useAgentTimeline';
import ConversationTimeline from '../conversation/ConversationTimeline.vue';

const chat = useAnalystChat();
const cards = useCardStore();
const workspaceRoute = useWorkspaceRouteStore();
const liveSync = useLiveSyncStore();
const {
  activeSessionId,
  messages,
  draft,
  messagesLoading,
  messagesError,
  sending,
  sendError,
  restartAcknowledgement,
  activeSessionWritable,
  activityStatus,
} = storeToRefs(chat);

const composerRef = ref<HTMLTextAreaElement | null>(null);
const timelineEntries = computed<AgentConversationEntry[]>(() => messages.value);
const timelineControls = useAgentTimeline(timelineEntries, activityStatus);
const childrenOnScreen = computed(() =>
  workspaceRoute.view === 'cards' && workspaceRoute.entityId
    ? cards.loadedChildrenFor(workspaceRoute.entityId) ?? []
    : [],
);
const READ_ONLY_TOOLTIP = 'Read-only — switch to analyst to send messages';
const composerTitle = computed(() => activeSessionWritable.value ? 'Ask the analyst…' : READ_ONLY_TOOLTIP);
const messagesErrorLabel = computed(() => {
  if (!messagesError.value) return '';
  if (messagesError.value.kind === 'unauthorized') {
    return 'Unauthorized. Provide a valid Saivage API token and retry.';
  }
  return messagesError.value.message;
});
let closeAnalystConversation: (() => void) | null = null;
let rootSettled = false;
let refreshPending = false;
let mounted = false;

function setTimelineScrollArea(el: Element | ComponentPublicInstance | null): void {
  timelineControls.scrollAreaRef.value = el instanceof HTMLElement ? el : null;
}

function focusComposer(): void {
  composerRef.value?.focus();
}

function handleFocusChat(): void {
  void nextTick(() => focusComposer());
}

function handleDraftInput(event: Event): void {
  chat.setDraft((event.target as HTMLTextAreaElement).value);
}

function handleComposerKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void submitMessage();
  }
}

async function submitMessage(): Promise<void> {
  if (!activeSessionWritable.value) return;
  await chat.sendMessage();
  await nextTick();
  focusComposer();
}

async function refreshConversation(): Promise<void> {
  if (!rootSettled) {
    refreshPending = true;
    return;
  }
  await chat.fetchMessages();
  await nextTick();
  timelineControls.scrollToLatest();
}

function settleRootGate(): void {
  if (!mounted) return;
  rootSettled = true;
  if (!refreshPending) return;
  refreshPending = false;
  void refreshConversation().catch(() => {});
}

onMounted(() => {
  mounted = true;
  window.addEventListener('saivage:focus-chat', handleFocusChat);
  void refreshConversation();
  void cards.ensureRoot().then(settleRootGate, settleRootGate);
});

watch(activeSessionId, (sessionId) => {
  closeAnalystConversation?.();
  closeAnalystConversation=sessionId?liveSync.openConversation(sessionId,refreshConversation):null;
  timelineControls.resetScrollState();
});

onBeforeUnmount(() => {
  mounted = false;
  window.removeEventListener('saivage:focus-chat', handleFocusChat);
  closeAnalystConversation?.();
  closeAnalystConversation = null;
});
</script>

<style scoped>
.analyst-chat-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  flex: 1;
  min-height: 0;
  background: var(--surface-1);
  border-left: 1px solid var(--border);
  overflow: hidden;
}

.subtle {
  color: var(--text-muted);
  font-size: 12px;
}

.chat-input-field,
.chat-send-button {
  font: inherit;
}

.chat-scroll-area {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.chat-context-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--bg);
}

.chat-context-card h3 {
  margin: 0 0 8px;
  color: var(--text);
  font-size: 13px;
}

.on-screen-children {
  margin: 0;
  padding-left: 18px;
  color: var(--text);
  font-size: 12px;
}

.chat-rounds {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.chat-status-card {
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--surface-1);
  color: var(--text);
}

.chat-status-warning {
  color: var(--warning, var(--text));
}

.chat-input-panel {
  border-top: 1px solid var(--border);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.jump-to-latest {
  align-self: center;
  margin: 0 0 -1px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface-3);
  color: var(--accent-2);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  padding: 6px 12px;
  z-index: 1;
}

.chat-input-field {
  width: 100%;
  resize: vertical;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  padding: 10px;
}

.chat-input-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.chat-input-hints {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
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

.chat-send-button {
  border-radius: 8px;
  border: 1px solid var(--border);
  padding: 8px 12px;
  cursor: pointer;
  background: var(--surface-3);
  color: var(--text);
}

.chat-send-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.chat-status-error {
  color: var(--danger);
}
</style>
