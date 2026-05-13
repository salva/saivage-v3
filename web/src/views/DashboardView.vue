<template>
  <div class="dashboard-layout">
    <!-- Left: Analyst Chat -->
    <section class="chat-panel" aria-label="Analyst Chat">
      <div class="panel-header">
        <h2 class="panel-title">Analyst Chat</h2>
        <div class="chat-session-info">
          <span v-if="wsConnectionState === 'connected'" class="session-badge live">LIVE</span>
          <span v-else class="session-badge offline">OFFLINE</span>
          <span v-if="wsStore.sessionId" class="session-id" :title="wsStore.sessionId">
            {{ wsStore.sessionId.slice(0, 8) }}
          </span>
        </div>
      </div>

      <!-- Chat Messages -->
      <div ref="chatScrollRef" class="chat-messages">
        <div v-if="chatMessages.length === 0" class="chat-empty">
          <div class="empty-icon">💬</div>
          <p>Send a message to the analyst to get started.</p>
          <p class="empty-hint">The analyst can help manage cards, inspect runtime state, and more.</p>
        </div>

        <div
          v-for="(msg, idx) in chatMessages"
          :key="idx"
          class="chat-message"
          :class="[`role-${msg.role}`, `kind-${msg.kind}`]"
        >
          <div class="message-meta">
            <span class="message-role">{{ roleLabel(msg.role) }}</span>
            <span class="message-time">{{ formatTime(msg.timestamp) }}</span>
          </div>
          <div
            class="message-content"
            :class="{ markdown: msg.kind === 'text' && msg.role === 'assistant' }"
            v-html="renderContent(msg)"
          ></div>
          <!-- Tool invocations -->
          <div v-if="msg.tool" class="message-tool">
            <span class="tool-badge">🔧 {{ msg.tool }}</span>
          </div>
          <!-- Entity links -->
          <div v-if="msg.links && msg.links.length" class="message-links">
            <span
              v-for="link in msg.links"
              :key="link.entity_id"
              class="entity-link"
              :class="link.entity_type"
              @click="navigateToEntity(link)"
            >
              {{ link.label || link.entity_id }}
            </span>
          </div>
        </div>

        <!-- Loading indicator for streaming response -->
        <div v-if="chatLoading" class="chat-message role-assistant kind-text">
          <div class="message-content typing-indicator">
            <span></span><span></span><span></span>
          </div>
        </div>
      </div>

      <!-- Input -->
      <div class="chat-input-area">
        <textarea
          v-model="chatInput"
          class="chat-input"
          :placeholder="wsConnectionState === 'connected' ? 'Message the analyst...' : 'Connect to chat...'"
          :disabled="wsConnectionState !== 'connected' || chatLoading"
          rows="2"
          @keydown.enter.exact.prevent="sendChat"
          @keydown.enter.shift.exact="() => {}"
          @keydown="handleChatKeydown"
        ></textarea>
        <button
          class="send-btn"
          :disabled="!chatInput.trim() || wsConnectionState !== 'connected' || chatLoading"
          @click="sendChat"
          title="Send (Enter)"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M2 2l12 6-12 6 3-6-3-6z" stroke="currentColor" stroke-width="1.5" fill="none"/>
          </svg>
        </button>
      </div>
    </section>

    <!-- Right: Runtime Status -->
    <section class="status-panel" aria-label="Runtime Status">
      <div class="panel-header">
        <h2 class="panel-title">Runtime Status</h2>
        <button
          class="refresh-btn"
          :disabled="runtimeLoading"
          @click="refreshRuntime"
          title="Refresh"
        >
          ↻
        </button>
      </div>

      <div v-if="runtimeLoading && !runtime" class="status-loading">Loading...</div>

      <template v-else-if="errorMsg" class="status-error">
        <div class="error-banner">{{ errorMsg }}</div>
      </template>

      <template v-else>
        <!-- Current Work -->
        <div class="status-section">
          <h3 class="section-label">Current Work</h3>
          <div class="status-grid">
            <div class="status-item">
              <span class="status-key">Status</span>
              <span class="status-chip" :class="`rt-${statusLabel}`">
                <span class="chip-dot"></span>
                {{ statusLabel }}
              </span>
            </div>
            <div class="status-item">
              <span class="status-key">Active Card</span>
              <span v-if="currentCardId" class="status-value clickable" @click="goToCard(currentCardId)">
                {{ currentCardId }}
              </span>
              <span v-else class="status-value dim">none</span>
            </div>
          </div>
        </div>

        <!-- Workers -->
        <div class="status-section">
          <h3 class="section-label">
            Workers
            <span v-if="runningProcessCount" class="section-badge">{{ runningProcessCount }}</span>
          </h3>
          <div class="status-list">
            <div class="status-item">
              <span class="status-key">Processes</span>
              <span class="status-value">{{ runningProcessCount }} running</span>
            </div>
            <div class="status-item">
              <span class="status-key">Agent Session</span>
              <span v-if="currentAgentSessionId" class="status-value clickable" @click="goToAgent(currentAgentSessionId)">
                {{ currentAgentSessionId.slice(0, 12) }}...
              </span>
              <span v-else class="status-value dim">none</span>
            </div>
          </div>
        </div>

        <!-- Queue -->
        <div class="status-section">
          <h3 class="section-label">
            Queue
            <span v-if="queueLength" class="section-badge">{{ queueLength }}</span>
          </h3>
          <div v-if="queueLength === 0" class="status-value dim">Queue empty</div>
          <ul v-else class="queue-list">
            <li v-for="cardId in runtime?.queue?.slice(0, 10)" :key="cardId" class="queue-item clickable" @click="goToCard(cardId)">
              {{ cardId }}
            </li>
            <li v-if="(runtime?.queue?.length || 0) > 10" class="queue-more">
              +{{ (runtime?.queue?.length || 0) - 10 }} more
            </li>
          </ul>
        </div>

        <!-- Recent History -->
        <div class="status-section">
          <h3 class="section-label">Recent History</h3>
          <div class="status-grid history-grid">
            <div class="status-item">
              <span class="status-key">Done Goals</span>
              <span class="status-value success">{{ doneGoals }}</span>
            </div>
            <div class="status-item">
              <span class="status-key">Failed/Blocked</span>
              <span class="status-value" :class="failedBlocked ? 'danger' : ''">{{ failedBlocked }}</span>
            </div>
            <div class="status-item">
              <span class="status-key">Total Cards</span>
              <span class="status-value">{{ cardIndex.total }}</span>
            </div>
          </div>
        </div>

        <!-- Card Index Summary -->
        <div class="status-section">
          <h3 class="section-label">Card Index</h3>
          <div class="index-bars">
            <div v-for="(count, name) in cardIndex.byType" :key="name" class="index-bar-row">
              <span class="index-label">{{ name }}</span>
              <div class="index-bar-track">
                <div class="index-bar-fill" :style="{ width: barWidth(count) }"></div>
              </div>
              <span class="index-count">{{ count }}</span>
            </div>
          </div>
        </div>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { storeToRefs } from 'pinia';
import { useRouter } from 'vue-router';
import { useWsStore } from '../stores/ws';
import { useRuntimeStore } from '../stores/runtime';
import type {
  ChatMessage,
  ChatSession,
  WsConnectionState,
  EntityLink,
} from '../api/types';
import {
  listChatSessions,
  getChatMessages,
  sendChatMessage,
} from '../api/client';
import { createLogger } from '../utils/logger';

const log = createLogger('view:dashboard');

// ── Stores ─────────────────────────────────────────────────

const wsStore = useWsStore();
const runtimeStore = useRuntimeStore();
const router = useRouter();

const { connectionState: wsConnectionState } = storeToRefs(wsStore);
const {
  runtime,
  cardIndex,
  loading: runtimeLoading,
  statusLabel,
  isPaused,
  currentCardId,
  currentAgentSessionId,
  queueLength,
  runningProcessCount,
  doneGoals,
  failedBlocked,
} = storeToRefs(runtimeStore);

// ── Chat State ─────────────────────────────────────────────

const chatInput = ref('');
const chatMessages = ref<ChatMessage[]>([]);
const chatSessions = ref<ChatSession[]>([]);
const currentChatSessionId = ref<string | null>(null);
const chatLoading = ref(false);
const errorMsg = ref<string | null>(null);
const chatScrollRef = ref<HTMLElement | null>(null);

// ── Helpers ────────────────────────────────────────────────

function roleLabel(role: string): string {
  const labels: Record<string, string> = {
    user: 'You',
    assistant: 'Analyst',
    system: 'System',
    tool: 'Tool',
  };
  return labels[role] || role;
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return ts;
  }
}

function renderContent(msg: ChatMessage): string {
  if (msg.kind === 'text' && (msg.role === 'assistant' || msg.role === 'system')) {
    return simpleMarkdown(msg.content);
  }
  // Escape HTML for non-markdown content
  return escapeHtml(msg.content);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function simpleMarkdown(text: string): string {
  // Very basic markdown: code blocks, inline code, bold, italic, links
  let out = escapeHtml(text);
  // Code blocks
  out = out.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="code-block"><code>$2</code></pre>');
  // Inline code
  out = out.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  // Bold
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Line breaks
  out = out.replace(/\n/g, '<br>');
  return out;
}

function navigateToEntity(link: EntityLink): void {
  if (link.entity_type === 'card') {
    router.push({ name: 'card-detail', params: { id: link.entity_id } });
  } else if (link.entity_type === 'process' || link.entity_type === 'artifact' || link.entity_type === 'attachment') {
    router.push({ name: 'files' });
  }
}

function goToCard(id: string): void {
  router.push({ name: 'card-detail', params: { id } });
}

function goToAgent(id: string): void {
  router.push({ name: 'agent-detail', params: { id } });
}

function barWidth(count: number): string {
  const max = Math.max(...Object.values(cardIndex.value.byType), 1);
  return `${Math.round((count / max) * 100)}%`;
}

// ── Chat Actions ───────────────────────────────────────────

async function initChat(): Promise<void> {
  try {
    const sessionsResp = await listChatSessions();
    chatSessions.value = sessionsResp.sessions;

    // Use the most recent session, or create a new one
    if (sessionsResp.sessions.length > 0) {
      const latest = sessionsResp.sessions[0];
      currentChatSessionId.value = latest.id;
      await loadChatHistory(latest.id);
    } else {
      // Send an initial message to create a session
      await sendChat(); // This will create a session
    }
  } catch (err) {
    log.error('Failed to init chat', err);
    errorMsg.value = 'Failed to load chat sessions';
  }
}

async function loadChatHistory(sessionId: string): Promise<void> {
  try {
    const resp = await getChatMessages(sessionId);
    chatMessages.value = resp.messages;
    scrollToBottom();
  } catch (err) {
    log.error('Failed to load chat history', err);
  }
}

async function sendChat(): Promise<void> {
  const text = chatInput.value.trim();
  if (!text) return;

  chatInput.value = '';
  chatLoading.value = true;

  // Optimistic add user message
  const userMsg: ChatMessage = {
    id: `local-${Date.now()}`,
    session_id: currentChatSessionId.value || '',
    role: 'user',
    kind: 'text',
    content: text,
    timestamp: new Date().toISOString(),
  };
  chatMessages.value = [...chatMessages.value, userMsg];
  scrollToBottom();

  try {
    // Create a session if none exists (first message auto-creates one)
    const sessionId = currentChatSessionId.value || 'analyst';

    // Send via WebSocket for real-time streaming when connected
    if (wsStore.isConnected()) {
      wsStore.sendMessage(text);
    }

    // Also send via REST for persistence
    const resp = await sendChatMessage(sessionId, text);

    if (!currentChatSessionId.value) {
      currentChatSessionId.value = resp.sessionId;
    }

    // Add the response message
    if (resp.message) {
      const msg = resp.message as unknown as ChatMessage;
      chatMessages.value = [...chatMessages.value, msg];

      // Handle tool invocations
      if (resp.toolInvocations) {
        for (const ti of resp.toolInvocations) {
          const toolCall: ChatMessage = {
            id: `tool-${Date.now()}-${ti.tool}`,
            session_id: resp.sessionId,
            role: 'assistant',
            kind: 'tool_call',
            content: JSON.stringify(ti.params, null, 2),
            tool: ti.tool,
            timestamp: new Date().toISOString(),
          };
          chatMessages.value = [...chatMessages.value, toolCall];

          if (ti.result) {
            const toolResult: ChatMessage = {
              id: `tool-result-${Date.now()}-${ti.tool}`,
              session_id: resp.sessionId,
              role: 'tool',
              kind: 'tool_result',
              content: typeof ti.result === 'string' ? ti.result : JSON.stringify(ti.result, null, 2),
              tool: ti.tool,
              timestamp: new Date().toISOString(),
            };
            chatMessages.value = [...chatMessages.value, toolResult];
          }
        }
      }
    }

    scrollToBottom();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to send message';
    const errMsg: ChatMessage = {
      id: `err-${Date.now()}`,
      session_id: currentChatSessionId.value || '',
      role: 'system',
      kind: 'activity',
      content: `Error: ${msg}`,
      timestamp: new Date().toISOString(),
    };
    chatMessages.value = [...chatMessages.value, errMsg];
    log.error('sendChat', msg);
  } finally {
    chatLoading.value = false;
  }
}

function handleChatKeydown(e: KeyboardEvent): void {
  // Allow Shift+Enter for newline (default behavior), Enter only to send
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
}

function scrollToBottom(): void {
  nextTick(() => {
    const el = chatScrollRef.value;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  });
}

// ── Runtime ────────────────────────────────────────────────

async function refreshRuntime(): Promise<void> {
  errorMsg.value = null;
  try {
    await runtimeStore.fetchState();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed';
    errorMsg.value = msg;
  }
}

// ── WebSocket Messages ─────────────────────────────────────

let wsUnsubscribe: (() => void) | null = null;

function setupWsListeners(): void {
  if (wsUnsubscribe) return;

  wsUnsubscribe = wsStore.onType('message', (envelope) => {
    const content = envelope.content || {};
    if (content.message) {
      const msg = content.message as ChatMessage;
      chatMessages.value = [...chatMessages.value, msg];
      scrollToBottom();
    }
    if (content.text && content.role) {
      // Alternative format
      const msg: ChatMessage = {
        id: `ws-${Date.now()}`,
        session_id: currentChatSessionId.value || '',
        role: content.role as ChatMessage['role'],
        kind: content.kind as ChatMessage['kind'] || 'text',
        content: content.text as string,
        timestamp: new Date().toISOString(),
      };
      chatMessages.value = [...chatMessages.value, msg];
      scrollToBottom();
    }
  });

  // Add analyst activity notifications to chat
  wsStore.onType('activity', (envelope) => {
    const content = envelope.content || {};
    if (content.text) {
      const msg: ChatMessage = {
        id: `ws-activity-${Date.now()}`,
        session_id: currentChatSessionId.value || '',
        role: 'system',
        kind: 'activity',
        content: content.text as string,
        timestamp: new Date().toISOString(),
      };
      chatMessages.value = [...chatMessages.value, msg];
      scrollToBottom();
    }
  });
}

// ── Global focus-chat event listener ───────────────────────

function handleFocusChat(): void {
  // Focus the chat input (/) shortcut
  const textarea = document.querySelector('.chat-input') as HTMLTextAreaElement;
  if (textarea) {
    textarea.focus();
  }
}

// ── Lifecycle ──────────────────────────────────────────────

onMounted(async () => {
  setupWsListeners();
  window.addEventListener('saivage:focus-chat', handleFocusChat);
  await Promise.all([initChat(), refreshRuntime()]);
  runtimeStore.setupWsListener();
});

onUnmounted(() => {
  if (wsUnsubscribe) wsUnsubscribe();
  window.removeEventListener('saivage:focus-chat', handleFocusChat);
});
</script>

<style scoped>
.dashboard-layout {
  display: flex;
  height: 100%;
  gap: 0;
}

/* ── Chat Panel ──────────────────────────────────────────── */

.chat-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-right: 1px solid #30363d;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #8b949e;
  text-align: center;
  padding: 32px;
}

.chat-empty .empty-icon {
  font-size: 2rem;
  margin-bottom: 8px;
}

.chat-empty .empty-hint {
  font-size: 12px;
  color: #484f58;
  margin-top: 4px;
}

.chat-message {
  padding: 10px 12px;
  border-radius: 6px;
  background: #161b22;
  border: 1px solid #21262d;
  max-width: 100%;
  word-wrap: break-word;
  overflow-wrap: break-word;
}

.chat-message.role-user {
  background: #1c2738;
  border-color: #30363d;
  align-self: flex-end;
  max-width: 80%;
}

.chat-message.role-system {
  background: #161b22;
  border-color: #30363d;
  opacity: 0.85;
  font-size: 12px;
}

.chat-message.kind-activity {
  background: #1a1f2b;
  border-color: #30363d;
  opacity: 0.8;
}

.message-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.message-role {
  font-size: 11px;
  font-weight: 600;
  color: #58a6ff;
  text-transform: uppercase;
}

.role-user .message-role {
  color: #7ee787;
}

.role-system .message-role {
  color: #8b949e;
}

.message-time {
  font-size: 10px;
  color: #484f58;
}

.message-content {
  font-size: 13px;
  line-height: 1.6;
  color: #c9d1d9;
}

.message-content :deep(.code-block) {
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 10px 12px;
  margin: 8px 0;
  overflow-x: auto;
  font-size: 12px;
  line-height: 1.5;
  font-family: 'SF Mono', 'Fira Code', monospace;
}

.message-content :deep(.inline-code) {
  background: #21262d;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 12px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  color: #d2a8ff;
}

.message-content :deep(strong) {
  color: #f0f6fc;
}

.message-tool {
  margin-top: 6px;
}

.tool-badge {
  font-size: 11px;
  padding: 2px 6px;
  background: #21262d;
  border: 1px solid #30363d;
  border-radius: 4px;
  color: #d2a8ff;
}

.message-links {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.entity-link {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
  border: 1px solid #30363d;
  transition: background 0.15s;
}

.entity-link.card { background: #1c2738; color: #58a6ff; }
.entity-link.process { background: #1a2418; color: #7ee787; }
.entity-link.artifact { background: #241a18; color: #f0883e; }
.entity-link.attachment { background: #1a1824; color: #d2a8ff; }
.entity-link:hover { filter: brightness(1.3); }

/* Typing indicator */
.typing-indicator {
  display: flex;
  gap: 4px;
  padding: 4px 0;
}

.typing-indicator span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #484f58;
  animation: pulse 1.4s infinite ease-in-out both;
}

.typing-indicator span:nth-child(1) { animation-delay: 0s; }
.typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
.typing-indicator span:nth-child(3) { animation-delay: 0.4s; }

@keyframes pulse {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1); }
}

/* ── Chat Input ──────────────────────────────────────────── */

.chat-input-area {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid #30363d;
  background: #161b22;
}

.chat-input {
  flex: 1;
  resize: none;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 8px 12px;
  color: #c9d1d9;
  font-size: 13px;
  font-family: inherit;
  line-height: 1.5;
  min-height: 38px;
  max-height: 120px;
}

.chat-input:focus {
  outline: none;
  border-color: #58a6ff;
  box-shadow: 0 0 0 2px rgba(88, 166, 255, 0.15);
}

.chat-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.chat-input::placeholder {
  color: #484f58;
}

.send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border: 1px solid #30363d;
  border-radius: 6px;
  background: #21262d;
  color: #58a6ff;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s, border-color 0.15s;
}

.send-btn:hover:not(:disabled) {
  background: #30363d;
  border-color: #58a6ff;
}

.send-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ── Status Panel ────────────────────────────────────────── */

.status-panel {
  width: 320px;
  flex-shrink: 0;
  overflow-y: auto;
  background: #0d1117;
  display: flex;
  flex-direction: column;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid #30363d;
  flex-shrink: 0;
}

.panel-title {
  font-size: 13px;
  font-weight: 600;
  color: #f0f6fc;
  margin: 0;
}

.chat-session-info {
  display: flex;
  align-items: center;
  gap: 6px;
}

.session-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 8px;
  font-weight: 600;
}

.session-badge.live {
  background: #1a2418;
  color: #7ee787;
  border: 1px solid #238636;
}

.session-badge.offline {
  background: #241818;
  color: #f85149;
  border: 1px solid #da3633;
}

.session-id {
  font-size: 10px;
  color: #484f58;
  font-family: 'SF Mono', monospace;
}

.refresh-btn {
  background: none;
  border: 1px solid #30363d;
  border-radius: 4px;
  color: #8b949e;
  cursor: pointer;
  width: 28px;
  height: 28px;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s, border-color 0.15s;
}

.refresh-btn:hover:not(:disabled) {
  color: #58a6ff;
  border-color: #58a6ff;
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.status-loading,
.status-error {
  padding: 16px;
  color: #8b949e;
  font-size: 12px;
}

.error-banner {
  padding: 10px 12px;
  background: #241818;
  border: 1px solid #da3633;
  border-radius: 4px;
  color: #f85149;
  font-size: 12px;
  margin: 12px;
}

/* ── Status Sections ─────────────────────────────────────── */

.status-section {
  padding: 12px 16px;
  border-bottom: 1px solid #21262d;
}

.section-label {
  font-size: 11px;
  font-weight: 600;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin: 0 0 8px 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.section-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: #21262d;
  color: #c9d1d9;
  font-size: 10px;
  font-weight: 600;
}

.status-grid {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px;
}

.status-item {
  display: contents;
}

.status-key {
  font-size: 12px;
  color: #8b949e;
  padding: 2px 0;
}

.status-value {
  font-size: 12px;
  color: #c9d1d9;
  text-align: right;
  font-family: 'SF Mono', monospace;
}

.status-value.dim {
  color: #484f58;
}

.status-value.success {
  color: #7ee787;
}

.status-value.danger {
  color: #f85149;
}

.status-value.clickable {
  color: #58a6ff;
  cursor: pointer;
  text-decoration: underline;
  text-decoration-color: transparent;
  transition: text-decoration-color 0.15s;
}

.status-value.clickable:hover {
  text-decoration-color: #58a6ff;
}

.queue-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.queue-item {
  font-size: 12px;
  color: #58a6ff;
  font-family: 'SF Mono', monospace;
  padding: 3px 0;
  cursor: pointer;
  text-decoration: underline;
  text-decoration-color: transparent;
  transition: text-decoration-color 0.15s;
}

.queue-item:hover {
  text-decoration-color: #58a6ff;
}

.queue-more {
  font-size: 11px;
  color: #484f58;
  padding: 2px 0;
}

/* ── Status Chip ─────────────────────────────────────────── */

.status-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  font-family: inherit;
  border: 1px solid transparent;
}

.chip-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
}

.rt-running { color: #7ee787; border-color: #238636; background: #1a2418; }
.rt-idle { color: #8b949e; border-color: #484f58; background: #21262d; }
.rt-paused { color: #d29922; border-color: #9e6a03; background: #241f18; }
.rt-frozen { color: #79c0ff; border-color: #1f6feb; background: #0d1c33; }
.rt-error { color: #f85149; border-color: #da3633; background: #241818; }
.rt-unknown { color: #8b949e; border-color: #484f58; background: #21262d; }

.rt-running .chip-dot { background: #7ee787; }
.rt-idle .chip-dot { background: #8b949e; }
.rt-paused .chip-dot { background: #d29922; }
.rt-frozen .chip-dot { background: #79c0ff; }
.rt-error .chip-dot { background: #f85149; }
.rt-unknown .chip-dot { background: #8b949e; }

/* ── Index Bars ──────────────────────────────────────────── */

.index-bars {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.index-bar-row {
  display: grid;
  grid-template-columns: 60px 1fr 30px;
  align-items: center;
  gap: 8px;
}

.index-label {
  font-size: 11px;
  color: #8b949e;
  text-align: right;
}

.index-bar-track {
  height: 6px;
  background: #21262d;
  border-radius: 3px;
  overflow: hidden;
}

.index-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, #58a6ff, #3fb950);
  border-radius: 3px;
  min-width: 2px;
  transition: width 0.3s ease;
}

.index-count {
  font-size: 11px;
  color: #c9d1d9;
  font-family: 'SF Mono', monospace;
  text-align: right;
}

/* ── History Grid ────────────────────────────────────────── */

.history-grid .status-key {
  font-size: 11px;
}
</style>
