<template>
  <aside
    id="analyst-chat-panel"
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
  activeSessionWritable,
} = storeToRefs(chat);

const expandedIds = ref(new Set<string>());
const composerRef = ref<HTMLTextAreaElement | null>(null);

const panelStyle = computed(() => ({ width: `${drawerWidth.value}px` }));
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

function safeJsonParse(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseArgs(value: unknown): unknown {
  if (typeof value === 'string') return safeJsonParse(value) ?? value;
  return value;
}

function oneLine(value: unknown, max = 72): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.replace(/\s+/g, ' ').slice(0, max);
}

function firstToolCall(message: ChatMessage): { name: string; args: unknown } {
  const parsed = asRecord(safeJsonParse(message.content));
  const toolCalls = Array.isArray(parsed?.toolCalls) ? parsed.toolCalls : [];
  const first = asRecord(toolCalls[0]);
  const fn = asRecord(first?.function);
  const name = typeof fn?.name === 'string'
    ? fn.name
    : typeof first?.tool === 'string'
      ? first.tool
      : message.tool ?? 'tool';
  const args = fn && 'arguments' in fn ? parseArgs(fn.arguments) : parseArgs(first?.params ?? {});
  return { name, args };
}

function resultToolName(message: ChatMessage): string {
  const parsed = asRecord(safeJsonParse(message.content));
  return message.tool
    ?? (typeof parsed?.tool === 'string' ? parsed.tool : undefined)
    ?? (typeof parsed?.toolName === 'string' ? parsed.toolName : undefined)
    ?? 'tool';
}

function resultStatus(message: ChatMessage, parsed: unknown): 'ok' | 'error' {
  if (message.kind === 'tool_error') return 'error';
  const record = asRecord(parsed);
  if (record?.ok === false || typeof record?.error === 'string') return 'error';
  return 'ok';
}

function resultSummary(parsed: unknown, content: string): string {
  const record = asRecord(parsed);
  const candidate = record?.summary ?? record?.message ?? record?.error ?? record?.content ?? parsed ?? content;
  return oneLine(candidate);
}

function toolChipLabel(message: ChatMessage): string {
  if (message.kind === 'tool_call') {
    const call = firstToolCall(message);
    return `🔧 ${call.name}(${oneLine(call.args, 56)})`;
  }
  const parsed = safeJsonParse(message.content);
  const status = resultStatus(message, parsed);
  return `📤 ${resultToolName(message)} → ${status} (${resultSummary(parsed, message.content)})`;
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
  if (!activeSessionWritable.value) return;
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
