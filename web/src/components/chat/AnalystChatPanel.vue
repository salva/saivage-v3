<template>
  <aside
    id="analyst-chat-panel"
    class="analyst-chat-panel"
    role="region"
    aria-label="Analyst chat"
  >
    <div class="chat-scroll-area">
      <div v-if="sessionsLoading" class="chat-status-card" role="status">Loading analyst sessions…</div>
      <div v-else-if="sessionsError" class="chat-status-card chat-status-error" role="alert">{{ sessionsError.message }}</div>

      <section v-if="childrenOnScreen.length" class="chat-context-card" aria-labelledby="on-screen-title">
        <h3 id="on-screen-title">On screen</h3>
        <ul class="on-screen-children">
          <li v-for="child in childrenOnScreen" :key="child.id">{{ child.id }} — {{ child.title }}</li>
        </ul>
      </section>

      <div v-if="messagesLoading" class="chat-status-card loading-skeleton" role="status">Loading history…</div>
      <div v-else-if="messagesError" class="chat-status-card chat-status-error" role="alert">{{ messagesErrorLabel }}</div>
      <div v-else-if="!messagesLoading && messages.length === 0 && timelineControls.timeline.value.rounds.length === 0 && pendingToolInvocationsForActiveSession.length === 0" class="chat-status-card" role="status">No messages yet. Ask the analyst something.</div>
      <div v-else class="chat-rounds">
        <RoundCard
          v-for="round in timelineControls.timeline.value.rounds"
          :key="round.id"
          :round="round"
          :expanded-ids="timelineControls.expandedIds.value"
          @toggle="timelineControls.toggleExpanded"
        />
        <div
          v-for="pending in pendingToolInvocationsForActiveSession"
          :key="pending.id"
          class="chat-pending-call"
        >
          <ToolChip
            v-bind="adaptPendingInvocationToToolChip({ id: pending.id, tool: pending.tool, started_at: new Date().toISOString(), summary: pending.summary }, timelineControls.expandedIds.value.has(pending.id))"
            @toggle="timelineControls.toggleExpanded(pending.id)"
          />
          <span class="chat-pending-summary">{{ pending.summary }}</span>
        </div>
      </div>
    </div>

    <form class="chat-input-panel" @submit.prevent="submitMessage">
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
        <span class="subtle">Enter to send · Shift+Enter for newline</span>
        <button type="submit" class="chat-send-button" :disabled="!activeSessionWritable || sending || !draft.trim()" :title="composerTitle">{{ sending ? 'Sending…' : 'Send' }}</button>
      </div>
      <div v-if="sendError" class="chat-status-card chat-status-error" role="alert">{{ sendError.message }}</div>
    </form>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import type { ActivityStatus, ConversationEntry } from '../../api/types';
import { useAnalystChat } from '../../stores/analystChat';
import { useCardStore } from '../../stores/cards';
import { selectChildrenOf } from '../../stores/card-read-model';
import { useWorkspaceRouteStore } from '../../stores/workspaceRoute';
import { useAgentTimeline } from '../../composables/useAgentTimeline';
import RoundCard from '../conversation/RoundCard.vue';
import ToolChip from '../conversation/ToolChip.vue';
import { adaptPendingInvocationToToolChip } from './tool-chip-adapter';

const chat = useAnalystChat();
const cards = useCardStore();
const workspaceRoute = useWorkspaceRouteStore();
const {
  activeSessionId,
  messages,
  draft,
  sessionsLoading,
  sessionsError,
  messagesLoading,
  messagesError,
  sending,
  sendError,
  pendingToolInvocations,
  activeSessionWritable,
} = storeToRefs(chat);

const composerRef = ref<HTMLTextAreaElement | null>(null);

const timelineEntries = computed<ConversationEntry[]>(() => messages.value);
const idleActivityStatus = computed<ActivityStatus | null>(() => null);
const timelineControls = useAgentTimeline(timelineEntries, idleActivityStatus, () => activeSessionId.value);
const childrenOnScreen = computed(() =>
  workspaceRoute.view === 'cards' && workspaceRoute.entityId
    ? selectChildrenOf([...cards.cards], workspaceRoute.entityId)
    : [],
);
const pendingToolInvocationsForActiveSession = computed(() => pendingToolInvocations.value.filter((item) => item.sessionId === activeSessionId.value));
const READ_ONLY_TOOLTIP = 'Read-only — switch to analyst to send messages';
const composerTitle = computed(() => activeSessionWritable.value ? 'Ask the analyst…' : READ_ONLY_TOOLTIP);
const messagesErrorLabel = computed(() => {
  if (!messagesError.value) return '';
  if (messagesError.value.kind === 'unauthorized') {
    return 'Unauthorized. Provide a valid Saivage API token and retry.';
  }
  return messagesError.value.message;
});

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

onMounted(() => {
  window.addEventListener('saivage:focus-chat', handleFocusChat);
  chat.fetchSessions()
    .then(() => chat.fetchMessages())
    .catch(() => {});
  handleFocusChat();
});

onBeforeUnmount(() => {
  window.removeEventListener('saivage:focus-chat', handleFocusChat);
});
</script>

<style scoped>
.analyst-chat-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
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

.chat-pending-call {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.chat-pending-summary {
  color: var(--text-muted);
  font-size: 12px;
  padding: 0 12px;
}

.chat-input-panel {
  border-top: 1px solid var(--border);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
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
