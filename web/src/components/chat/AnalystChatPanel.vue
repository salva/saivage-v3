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
import { useCardStore } from '../../stores/cards';
import { useWorkspaceRouteStore } from '../../stores/workspaceRoute';
import type { ChatMessage } from '../../api/types';
import { presentToolCall, presentToolResult, safeJsonParse } from '../../utils/tool-presenters';
import { formatJson } from '../../utils/format-json';
import CodeBlock from '../code/CodeBlock.vue';

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
    ? cards.childrenOf(workspaceRoute.entityId)
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
.tool-chip,
.state-panel {
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--surface-1);
  color: var(--text);
}

.role-user .message-bubble {
  background: var(--surface-3);
}

.tool-chip {
  display: flex;
  justify-content: space-between;
  width: 100%;
  border: 1px solid var(--border);
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
.tool-chip-name { font-weight: 600; color: var(--purple); flex-shrink: 0; }
.tool-chip-headline { color: var(--text); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-chip-tag {
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  white-space: nowrap;
}
.tool-chip-caret { color: var(--text-muted); margin-left: auto; flex-shrink: 0; }

.tool-chip-call .tool-chip-name { color: var(--purple); }
.tool-chip-ok .tool-chip-name { color: var(--accent); }
.tool-chip-error { border-color: var(--danger); }
.tool-chip-error .tool-chip-name { color: var(--danger); }
.tool-chip-error .tool-chip-headline { color: var(--danger); }

.tool-chip.pending {
  cursor: default;
  border-color: var(--accent-2);
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
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 8px;
  color: var(--accent-2);
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
