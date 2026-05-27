<template>
  <aside
    id="analyst-chat-panel"
    class="analyst-chat-panel"
    role="region"
    aria-label="Analyst chat"
  >
    <div class="chat-body">
      <div v-if="sessionsLoading" class="state-panel" role="status">Loading analyst sessions…</div>
      <div v-else-if="sessionsError" class="state-panel error" role="alert">{{ sessionsError.message }}</div>

      <section v-if="childrenOnScreen.length" class="on-screen-section" aria-labelledby="on-screen-title">
        <h3 id="on-screen-title">On screen</h3>
        <ul class="on-screen-children">
          <li v-for="child in childrenOnScreen" :key="child.id">{{ child.id }} — {{ child.title }}</li>
        </ul>
      </section>

      <div v-if="messagesLoading" class="state-panel loading-skeleton" role="status">Loading history…</div>
      <div v-else-if="messagesError" class="state-panel error" role="alert">{{ messagesErrorLabel }}</div>
      <div v-else-if="!messagesLoading && messages.length === 0 && timelineItems.length === 0 && pendingToolInvocationsForActiveSession.length === 0" class="state-panel" role="status">No messages yet. Ask the analyst something.</div>
      <div v-else class="message-list">
        <article
          v-for="item in timelineItems"
          :key="item.id"
          class="message-row"
          :class="[
            `role-${item.role}`,
            `kind-${item.kind}`,
            { expanded: expandedIds.has(item.id) },
          ]"
        >
          <template v-if="item.kind === 'tool_call' || item.kind === 'tool_result' || item.kind === 'tool_error'">
            <ToolChip
              v-bind="adaptChatMessageToToolChip(item, expandedIds.has(item.id))"
              @toggle="toggleExpanded(item.id)"
            />
          </template>
          <template v-else>
            <div class="message-bubble">{{ item.content }}</div>
          </template>
          <ul v-if="messageBadges[item.id]?.length" class="message-badges">
            <li v-for="badge in messageBadges[item.id]" :key="`${item.id}-${badge.timestamp}-${badge.label}`">{{ badge.label }}</li>
          </ul>
        </article>

        <article
          v-for="pending in pendingToolInvocationsForActiveSession"
          :key="pending.id"
          class="message-row kind-tool_call pending-tool"
        >
          <ToolChip
            v-bind="adaptPendingInvocationToToolChip({ id: pending.id, tool: pending.tool, started_at: new Date().toISOString(), summary: pending.summary }, expandedIds.has(pending.id))"
            @toggle="toggleExpanded(pending.id)"
          />
        </article>
      </div>
    </div>

    <form class="chat-composer" @submit.prevent="submitMessage">
      <textarea
        ref="composerRef"
        :value="draft"
        class="composer-input"
        rows="3"
        placeholder="Ask the analyst…"
        aria-label="Analyst chat composer"
        :disabled="!activeSessionWritable"
        :title="composerTitle"
        @input="handleDraftInput"
        @keydown="handleComposerKeydown"
      />
      <div class="composer-footer">
        <span class="subtle">Enter to send · Shift+Enter for newline</span>
        <button type="submit" class="primary-btn" :disabled="!activeSessionWritable || sending || !draft.trim()" :title="composerTitle">{{ sending ? 'Sending…' : 'Send' }}</button>
      </div>
      <div v-if="sendError" class="state-panel error" role="alert">{{ sendError.message }}</div>
    </form>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useAnalystChat } from '../../stores/analystChat';
import { useCardStore } from '../../stores/cards';
import { selectChildrenOf } from '../../stores/card-read-model';
import { useWorkspaceRouteStore } from '../../stores/workspaceRoute';
import ToolChip from '../conversation/ToolChip.vue';
import { adaptChatMessageToToolChip, adaptPendingInvocationToToolChip } from './tool-chip-adapter';

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
  messageBadges,
  activeSessionWritable,
} = storeToRefs(chat);

const expandedIds = ref(new Set<string>());
const composerRef = ref<HTMLTextAreaElement | null>(null);

const timelineItems = computed(() => [...messages.value].sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
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

function toggleExpanded(id: string): void {
  const next = new Set(expandedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedIds.value = next;
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

.composer-input,
.primary-btn {
  font: inherit;
}

.chat-body {
  flex: 1;
  overflow: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.on-screen-section {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--bg);
}

.on-screen-section h3 {
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

.message-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.message-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.message-bubble,
.state-panel {
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--surface-1);
  color: var(--text);
}

.role-user .message-bubble {
  background: var(--surface-3);
}


.message-badges {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--accent-2);
  font-size: 12px;
}

.chat-composer {
  border-top: 1px solid var(--border);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.composer-input {
  width: 100%;
  resize: vertical;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  padding: 10px;
}

.composer-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.primary-btn {
  border-radius: 8px;
  border: 1px solid var(--border);
  padding: 8px 12px;
  cursor: pointer;
  background: var(--surface-3);
  color: var(--text);
}

.primary-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.state-panel.error {
  color: var(--danger);
}
</style>
