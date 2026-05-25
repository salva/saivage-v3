<template>
  <aside
    id="analyst-chat-panel"
    class="analyst-chat-panel"
    role="region"
    aria-labelledby="analyst-chat-title"
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
          <optgroup v-for="group in groupedSessions" :key="group.label" :label="group.label">
            <option v-for="session in group.sessions" :key="session.id" :value="session.id">{{ session.id }}</option>
          </optgroup>
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

      <div v-if="messagesLoading" class="state-panel loading-skeleton" role="status">Loading history…</div>
      <div v-else-if="messagesError" class="state-panel error" role="alert">{{ messagesErrorLabel }}</div>
      <div v-else-if="!activeSessionId" class="state-panel" role="status">Select a session or start a new chat.</div>
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
          <template v-if="item.kind === 'tool_call' || item.kind === 'tool_result'">
            <button
              type="button"
              class="tool-chip"
              :class="toolChipClasses(item)"
              :aria-expanded="expandedIds.has(item.id)"
              :aria-label="toolChipAriaLabel(item)"
              @click="toggleExpanded(item.id)"
            >
              <span class="tool-chip-row">
                <span class="tool-chip-icon" aria-hidden="true">{{ toolChipParts(item).icon }}</span>
                <span class="tool-chip-name">{{ toolChipParts(item).name }}</span>
                <span v-if="toolChipParts(item).headline" class="tool-chip-headline">{{ toolChipParts(item).headline }}</span>
                <span v-if="toolChipParts(item).detail" class="tool-chip-tag">{{ toolChipParts(item).detail }}</span>
                <span class="tool-chip-caret" aria-hidden="true">{{ expandedIds.has(item.id) ? '▾' : '▸' }}</span>
              </span>
            </button>
            <CodeBlock
              v-if="expandedIds.has(item.id)"
              :code="toolChipDetail(item)"
              language="json"
              copyable
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
          <div class="tool-chip pending" role="status">
            <span class="pending-tool-main">🔧 {{ pending.tool }} — {{ pending.summary }}</span>
            <span v-if="pending.classifiedAs || pending.relatedCardId" class="pending-tool-meta">
              <span v-if="pending.classifiedAs" class="pending-tool-tag">{{ pending.classifiedAs }}</span>
              <span v-if="pending.relatedCardId" class="pending-tool-tag">card {{ pending.relatedCardId }}</span>
            </span>
          </div>
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
import type { ChatMessage } from '../../api/types';
import { presentToolCall, presentToolResult, safeJsonParse } from '../../utils/tool-presenters';
import { formatJson } from '../../utils/format-json';
import CodeBlock from '../code/CodeBlock.vue';

const chat = useAnalystChat();
const {
  sessions,
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
const pendingToolInvocationsForActiveSession = computed(() => pendingToolInvocations.value.filter((item) => item.sessionId === activeSessionId.value));
const READ_ONLY_TOOLTIP = 'Read-only — switch to analyst to send messages';
const composerTitle = computed(() => activeSessionWritable.value ? 'Ask the analyst…' : READ_ONLY_TOOLTIP);
const groupedSessions = computed(() => {
  const labels: Record<string, string> = {
    analyst: 'Analyst',
    card: 'Card discussions',
    planner: 'Planner',
    reviewer: 'Reviewer',
    executor: 'Executor',
  };
  const order = ['analyst', 'card', 'planner', 'reviewer', 'executor'];
  const groups = new Map<string, typeof sessions.value>();
  for (const session of sessions.value) {
    const key = session.id.startsWith('card-') ? 'card' : String(session.role).split(':')[0];
    groups.set(key, [...(groups.get(key) ?? []), session]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)))
    .map(([key, groupSessions]) => ({ label: labels[key] ?? key, sessions: groupSessions }));
});
const messagesErrorLabel = computed(() => {
  if (!messagesError.value) return '';
  if (messagesError.value.kind === 'unauthorized') {
    return 'Unauthorized. Provide a valid Saivage API token and retry.';
  }
  return messagesError.value.message;
});

interface ChipParts {
  icon: string;
  name: string;
  headline: string;
  detail?: string;
  status: 'call' | 'ok' | 'error';
}

function toolChipParts(message: ChatMessage): ChipParts {
  if (message.kind === 'tool_call') {
    const view = presentToolCall(message.content, message.tool);
    return { icon: view.icon, name: view.name, headline: view.headline, detail: view.detail, status: 'call' };
  }
  const view = presentToolResult(message.content, { tool: message.tool, kind: message.kind });
  return { icon: view.icon, name: view.name, headline: view.headline, detail: view.detail, status: view.status };
}

function toolChipClasses(message: ChatMessage): Record<string, boolean> {
  const parts = toolChipParts(message);
  return {
    'tool-chip-call': parts.status === 'call',
    'tool-chip-ok': parts.status === 'ok',
    'tool-chip-error': parts.status === 'error',
  };
}

function toolChipAriaLabel(message: ChatMessage): string {
  const action = expandedIds.value.has(message.id) ? 'Collapse' : 'Expand';
  const parts = toolChipParts(message);
  return `${action} analyst ${message.kind.replace('_', ' ')} details: ${parts.icon} ${parts.name} ${parts.headline}`.trim();
}

function toolChipDetail(message: ChatMessage): string {
  const parsed = safeJsonParse(message.content);
  return parsed === null ? message.content : formatJson(parsed);
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

function handleFocusChat(): void {
  void nextTick(() => focusComposer());
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
  if (!activeSessionWritable.value) return;
  await chat.sendMessage();
  await nextTick();
  focusComposer();
}

onMounted(() => {
  window.addEventListener('saivage:focus-chat', handleFocusChat);
  chat.fetchSessions().catch(() => {});
  if (activeSessionId.value) {
    chat.fetchMessages(activeSessionId.value).catch(() => {});
  }
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
  background: #161b22;
  border-left: 1px solid #30363d;
  overflow: hidden;
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

.tool-chip-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  min-width: 0;
  font-size: 12px;
  font-family: 'SF Mono', monospace;
}

.tool-chip-icon { font-size: 13px; }
.tool-chip-name { font-weight: 600; color: #d2a8ff; flex-shrink: 0; }
.tool-chip-headline { color: #c9d1d9; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-chip-tag {
  color: #8b949e;
  border: 1px solid #30363d;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  white-space: nowrap;
}
.tool-chip-caret { color: #8b949e; margin-left: auto; flex-shrink: 0; }

.tool-chip-call .tool-chip-name { color: #d2a8ff; }
.tool-chip-ok .tool-chip-name { color: #7ee787; }
.tool-chip-error { border-color: #f85149; }
.tool-chip-error .tool-chip-name { color: #f85149; }
.tool-chip-error .tool-chip-headline { color: #ffa198; }

.tool-chip.pending {
  cursor: default;
  border-color: #58a6ff;
  align-items: flex-start;
  gap: 8px;
}

.pending-tool-main {
  min-width: 0;
  overflow-wrap: anywhere;
}

.pending-tool-meta {
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.pending-tool-tag {
  border: 1px solid #30363d;
  border-radius: 999px;
  padding: 2px 8px;
  color: #79c0ff;
  font-size: 12px;
  white-space: nowrap;
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
