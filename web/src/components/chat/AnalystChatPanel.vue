<template>
  <aside
    class="analyst-chat-panel"
    :class="{ open: drawerOpen }"
    :style="panelStyle"
    role="dialog"
    aria-label="Analyst chat panel"
    aria-modal="false"
  >
    <div class="chat-header">
      <div>
        <h2 id="analyst-chat-title">Analyst</h2>
        <p class="subtle">Persistent operator chat and inspection transcript.</p>
      </div>
      <div class="chat-header-actions">
        <select
          class="session-picker"
          :value="activeSessionId || ''"
          aria-label="Analyst chat session picker"
          @change="handleSessionChange"
        >
          <option value="">Select session</option>
          <option v-for="session in sessions" :key="session.id" :value="session.id">{{ session.id }}</option>
        </select>
        <button
          type="button"
          class="secondary-btn"
          aria-label="Start a new analyst chat"
          @click="handleNewChat"
        >
          New chat
        </button>
      </div>
    </div>

    <div class="chat-body">
      <div v-if="sessionsLoading" class="state-panel" role="status">Loading analyst sessions…</div>
      <div v-else-if="sessionsError" class="state-panel error" role="alert">{{ sessionsError.message }}</div>

      <div v-if="messagesLoading" class="state-panel" role="status">Loading analyst messages…</div>
      <div v-else-if="messagesError" class="state-panel error" role="alert">{{ messagesErrorLabel }}</div>
      <div v-else-if="!activeSessionId" class="state-panel" role="status">Select a session or start a new chat.</div>
      <div v-else-if="timelineItems.length === 0 && pendingToolInvocationsForActiveSession.length === 0" class="state-panel" role="status">No messages yet. Ask the analyst something.</div>
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
          <template v-if="item.kind === 'tool_call' || item.kind === 'tool_result'">
            <button
              type="button"
              class="tool-chip"
              :aria-expanded="expandedIds.has(item.id)"
              :aria-label="toolChipAriaLabel(item)"
              @click="toggleExpanded(item.id)"
            >
              <span>{{ toolChipLabel(item) }}</span>
              <span aria-hidden="true">{{ expandedIds.has(item.id) ? '▾' : '▸' }}</span>
            </button>
            <pre v-if="expandedIds.has(item.id)" class="tool-chip-detail">{{ toolChipDetail(item) }}</pre>
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
          <div class="tool-chip pending" role="status">🔧 {{ pending.tool }} — {{ pending.summary }}</div>
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
        @input="handleDraftInput"
        @keydown="handleComposerKeydown"
      />
      <div class="composer-footer">
        <span class="subtle">Enter to send · Shift+Enter for newline</span>
        <button type="submit" class="primary-btn" :disabled="sending || !draft.trim()">{{ sending ? 'Sending…' : 'Send' }}</button>
      </div>
      <div v-if="sendError" class="state-panel error" role="alert">{{ sendError.message }}</div>
    </form>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useAnalystChat } from '../../stores/analystChat';
import type { ChatMessage } from '../../api/types';

const chat = useAnalystChat();
const {
  sessions,
  activeSessionId,
  messages,
  draft,
  drawerOpen,
  drawerWidth,
  sessionsLoading,
  sessionsError,
  messagesLoading,
  messagesError,
  sending,
  sendError,
  pendingToolInvocations,
  messageBadges,
} = storeToRefs(chat);

const expandedIds = ref(new Set<string>());
const composerRef = ref<HTMLTextAreaElement | null>(null);

const panelStyle = computed(() => ({ width: `${drawerWidth.value}px` }));
const timelineItems = computed(() => [...messages.value].sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
const pendingToolInvocationsForActiveSession = computed(() => pendingToolInvocations.value.filter((item) => item.sessionId === activeSessionId.value));
const messagesErrorLabel = computed(() => {
  if (!messagesError.value) return '';
  if (messagesError.value.kind === 'unauthorized') {
    return 'Unauthorized. Provide a valid Saivage API token and retry.';
  }
  return messagesError.value.message;
});

function safeJsonParse(content: string): Record<string, unknown> | null {
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toolChipLabel(message: ChatMessage): string {
  if (message.kind === 'tool_call') {
    const parsed = safeJsonParse(message.content);
    const toolCalls = Array.isArray(parsed?.toolCalls) ? parsed?.toolCalls as Array<Record<string, unknown>> : [];
    const first = toolCalls[0] ?? {};
    const tool = String(first.tool ?? message.tool ?? 'tool');
    const params = first.params && typeof first.params === 'object'
      ? JSON.stringify(first.params).slice(0, 48)
      : '{}';
    return `🔧 ${tool}(${params})`;
  }
  const parsed = safeJsonParse(message.content);
  const summary = parsed ? JSON.stringify(parsed).slice(0, 64) : message.content.slice(0, 64);
  return `✅ ${message.tool ?? 'result'} ${summary}`;
}

function toolChipAriaLabel(message: ChatMessage): string {
  const action = expandedIds.value.has(message.id) ? 'Collapse' : 'Expand';
  return `${action} analyst ${message.kind.replace('_', ' ')} details: ${toolChipLabel(message)}`;
}

function toolChipDetail(message: ChatMessage): string {
  const parsed = safeJsonParse(message.content);
  return JSON.stringify(parsed ?? message.content, null, 2);
}

function toggleExpanded(id: string): void {
  const next = new Set(expandedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedIds.value = next;
}

async function handleSessionChange(event: Event): Promise<void> {
  const value = (event.target as HTMLSelectElement).value;
  if (!value) return;
  await chat.selectSession(value);
}

function focusComposer(): void {
  composerRef.value?.focus();
}

function handleNewChat(): void {
  chat.createNewChat();
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
  await chat.sendMessage();
  await nextTick();
  focusComposer();
}

watch(drawerOpen, (open) => {
  if (open) {
    void nextTick(() => focusComposer());
  }
});

onMounted(() => {
  chat.fetchSessions().catch(() => {});
  if (activeSessionId.value) {
    chat.fetchMessages(activeSessionId.value).catch(() => {});
  }
  if (drawerOpen.value) {
    void nextTick(() => focusComposer());
  }
});
</script>

<style scoped>
.analyst-chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 320px;
  max-width: 720px;
  border-left: 1px solid #30363d;
  background: #0f141b;
}

.chat-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px;
  border-bottom: 1px solid #30363d;
}

.chat-header h2 {
  margin: 0;
  color: #f0f6fc;
  font-size: 16px;
}

.subtle {
  color: #8b949e;
  font-size: 12px;
}

.chat-header-actions {
  display: flex;
  gap: 8px;
}

.session-picker,
.composer-input,
.primary-btn,
.secondary-btn {
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
.tool-chip,
.state-panel {
  border-radius: 10px;
  padding: 10px 12px;
  background: #161b22;
  color: #c9d1d9;
}

.role-user .message-bubble {
  background: #1f2937;
}

.tool-chip {
  display: flex;
  justify-content: space-between;
  width: 100%;
  border: 1px solid #30363d;
  cursor: pointer;
}

.tool-chip.pending {
  cursor: default;
  border-color: #58a6ff;
}

.tool-chip-detail {
  margin: 0;
  padding: 12px;
  border-radius: 8px;
  background: #0d1117;
  color: #8b949e;
  overflow: auto;
}

.message-badges {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: #79c0ff;
  font-size: 12px;
}

.chat-composer {
  border-top: 1px solid #30363d;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.composer-input {
  width: 100%;
  resize: vertical;
  border-radius: 8px;
  border: 1px solid #30363d;
  background: #0d1117;
  color: #f0f6fc;
  padding: 10px;
}

.composer-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.primary-btn,
.secondary-btn {
  border-radius: 8px;
  border: 1px solid #30363d;
  padding: 8px 12px;
  cursor: pointer;
  background: #21262d;
  color: #f0f6fc;
}

.primary-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.state-panel.error {
  color: #ff7b72;
}
</style>
