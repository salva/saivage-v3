<template>
  <div class="dashboard-layout">
    <section class="chat-panel" aria-label="Analyst Chat">
      <div class="panel-header">
        <h2 class="panel-title">Analyst Chat</h2>
        <div class="chat-session-info">
          <span :class="['session-badge', chatConnectionBadge.class]">{{ chatConnectionBadge.label }}</span>
          <span v-if="wsStore.sessionId" class="session-id" :title="wsStore.sessionId">
            {{ wsStore.sessionId.slice(0, 8) }}
          </span>
        </div>
      </div>

      <div v-if="chatStatusMessage" class="chat-status-banner" :class="chatStatusClass">
        {{ chatStatusMessage }}
      </div>

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
          <div v-if="msg.tool" class="message-tool">
            <span class="tool-badge">🔧 {{ msg.tool }}</span>
          </div>
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

        <div v-if="chatLoading" class="chat-message role-assistant kind-text">
          <div class="message-content typing-indicator">
            <span></span><span></span><span></span>
          </div>
        </div>
      </div>

      <div class="chat-input-area">
        <textarea
          v-model="chatInput"
          class="chat-input"
          :placeholder="chatPlaceholder"
          :disabled="chatInputDisabled || chatLoading"
          rows="2"
          @keydown.enter.exact.prevent="sendChat"
          @keydown.enter.shift.exact="() => {}"
          @keydown="handleChatKeydown"
        ></textarea>
        <button
          class="send-btn"
          :disabled="!chatInput.trim() || chatInputDisabled || chatLoading"
          @click="sendChat"
          title="Send (Enter)"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M2 2l12 6-12 6 3-6-3-6z" stroke="currentColor" stroke-width="1.5" fill="none"/>
          </svg>
        </button>
      </div>
    </section>

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

      <div v-if="runtimeBannerMessage" class="runtime-banner" :class="runtimeBannerClass">{{ runtimeBannerMessage }}</div>
      <div v-if="runtimeLoading && !runtime" class="status-loading">Loading...</div>

      <template v-else-if="errorMsg" class="status-error">
        <div class="error-banner">{{ errorMsg }}</div>
      </template>

      <template v-else>
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

        <div class="status-section">
          <h3 class="section-label">
            Runtime Runs
            <span v-if="activeChildRuns.length" class="section-badge">{{ activeChildRuns.length }}</span>
          </h3>
          <div class="status-list">
            <div class="status-item">
              <span class="status-key">Intent</span>
              <span class="status-value">{{ intent?.status ?? 'unknown' }}</span>
            </div>
            <div class="status-item">
              <span class="status-key">Root Run</span>
              <span v-if="currentRun" class="status-value clickable" @click="goToCard(currentRun.card_id)">
                {{ currentRun.card_id }} · {{ currentRun.phase }}
              </span>
              <span v-else class="status-value dim">none</span>
            </div>
            <div class="status-item">
              <span class="status-key">Active Children</span>
              <span class="status-value">{{ activeChildRuns.length }}</span>
            </div>
            <div class="status-item">
              <span class="status-key">Activations</span>
              <span class="status-value">{{ activations.length }}</span>
            </div>
          </div>
        </div>

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

        <div class="status-section cardstore-health" :class="cardStoreHealthClass">
          <h3 class="section-label">CardStore Health</h3>
          <div class="status-grid">
            <div class="status-item">
              <span class="status-key">Snapshot State</span>
              <span class="status-value">{{ cardStoreHealthLabel }}</span>
            </div>
            <div class="status-item">
              <span class="status-key">Warnings</span>
              <span class="status-value">{{ cardStoreWarningCount }}</span>
            </div>
          </div>
          <p v-if="cardStoreHealthDetail" class="cardstore-health-detail">{{ cardStoreHealthDetail }}</p>
          <p v-if="cardStoreLastWarning" class="cardstore-warning">
            {{ cardStoreLastWarning.message }}
            <span v-if="cardStoreLastWarning.relativePath" class="dim">({{ cardStoreLastWarning.relativePath }})</span>
          </p>
        </div>

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
  ApiError,
} from '../api/client';
import { createLogger } from '../utils/logger';

const log = createLogger('view:dashboard');

const wsStore = useWsStore();
const runtimeStore = useRuntimeStore();
const router = useRouter();

const { connectionState: wsConnectionState } = storeToRefs(wsStore);
const {
  runtime,
  cardIndex,
  loading: runtimeLoading,
  statusLabel,
  currentCardId,
  currentAgentSessionId,
  intent,
  currentRun,
  activeChildRuns,
  activations,
  runningProcessCount,
  doneGoals,
  failedBlocked,
  cardStoreHealth,
  isStale: runtimeIsStale,
  isFrozen,
  unauthorized: runtimeUnauthorized,
} = storeToRefs(runtimeStore);

const chatInput = ref('');
const chatMessages = ref<ChatMessage[]>([]);
const chatSessions = ref<ChatSession[]>([]);
const currentChatSessionId = ref<string | null>(null);
const chatLoading = ref(false);
const errorMsg = ref<string | null>(null);
const chatStatusMessage = ref<string | null>(null);
const chatScrollRef = ref<HTMLElement | null>(null);

const chatInputDisabled = computed(() => wsConnectionState.value !== 'connected');
const chatPlaceholder = computed(() => {
  switch (wsConnectionState.value) {
    case 'connected': return 'Message the analyst...';
    case 'connecting': return 'Live chat reconnecting...';
    case 'unauthorized': return 'Re-enter API token to chat with the analyst...';
    case 'no-token': return 'Enter API token to chat with the analyst...';
    default: return 'Connect to chat...';
  }
});
const chatConnectionBadge = computed(() => {
  switch (wsConnectionState.value) {
    case 'connected': return { label: 'LIVE', class: 'live' };
    case 'connecting': return { label: 'RECONNECTING', class: 'connecting' };
    case 'unauthorized': return { label: 'UNAUTHORIZED', class: 'unauthorized' };
    case 'no-token': return { label: 'NO TOKEN', class: 'offline' };
    default: return { label: 'OFFLINE', class: 'offline' };
  }
});
const chatStatusClass = computed(() => {
  return wsConnectionState.value === 'unauthorized' || wsConnectionState.value === 'no-token'
    ? 'chat-status-error'
    : 'chat-status-warning';
});
const runtimeBannerMessage = computed(() => {
  if (runtimeUnauthorized.value) return 'Runtime snapshot is unavailable because the API token was rejected.';
  if (isFrozen.value) return runtime.value?.frozen_reason || 'Runtime is frozen and needs operator attention.';
  if (statusLabel.value === 'error') return 'Runtime is degraded. Inspect Debug and current evidence before treating work as healthy.';
  if (runtimeIsStale.value) return 'Runtime snapshot is stale. Refresh to confirm the current REST state.';
  return null;
});
const runtimeBannerClass = computed(() => {
  if (runtimeUnauthorized.value || statusLabel.value === 'error') return 'runtime-banner-error';
  return 'runtime-banner-warning';
});
const cardStoreHealthState = computed<'unknown' | 'ok' | 'degraded'>(() => {
  const health = cardStoreHealth.value;
  if (!health) return 'unknown';
  return health.canonical === 'ok' && health.compatibilitySnapshots === 'ok' ? 'ok' : 'degraded';
});
const cardStoreHealthClass = computed(() => `cardstore-${cardStoreHealthState.value}`);
const cardStoreHealthLabel = computed(() => {
  switch (cardStoreHealthState.value) {
    case 'ok': return 'OK';
    case 'degraded': return 'Degraded';
    default: return 'Unknown / not available';
  }
});
const cardStoreWarningCount = computed(() => cardStoreHealth.value?.warnings.length ?? 0);
const cardStoreLastWarning = computed(() => cardStoreHealth.value?.lastCompatibilitySnapshotWarning ?? null);
const cardStoreHealthDetail = computed(() => {
  const health = cardStoreHealth.value;
  if (!health) return 'CardStore health was not included in the latest operator state snapshot.';
  if (cardStoreHealthState.value === 'ok') return 'Canonical cards and compatibility snapshots currently report healthy.';
  if (health.canonical === 'invalid') return 'Canonical card hierarchy validation is invalid; inspect server logs before trusting derived views.';
  return 'Compatibility snapshots are degraded; canonical card data remains the source of truth.';
});

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
  return escapeHtml(msg.content);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function simpleMarkdown(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="code-block"><code>$2</code></pre>');
  out = out.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/\n/g, '<br>');
  return out;
}

function navigateToEntity(link: EntityLink): void {
  if (link.entity_type === 'card') {
    router.push({ name: 'card-detail', params: { id: link.entity_id } });
  } else if (link.entity_type === 'process') {
    router.push({ name: 'debug', query: { tab: 'processes', process: link.entity_id } });
  } else if (link.entity_type === 'artifact' || link.entity_type === 'attachment' || link.entity_type === 'quarantine') {
    router.push({ name: 'files', query: { path: link.entity_id } });
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

function syncChatStatusMessage(): void {
  switch (wsConnectionState.value) {
    case 'connecting':
      chatStatusMessage.value = 'Analyst chat is reconnecting. REST runtime snapshots remain available while live chat is unavailable.';
      return;
    case 'offline':
      chatStatusMessage.value = 'Analyst chat is offline. Refresh runtime data manually until live chat reconnects.';
      return;
    case 'unauthorized':
      chatStatusMessage.value = 'Analyst chat is unauthorized. Re-enter a valid API token; public docs at /docs/ do not require one.';
      return;
    case 'no-token':
      chatStatusMessage.value = 'Enter an API token to use analyst chat. Public docs at /docs/ remain available without a token.';
      return;
    default:
      if (!chatMessages.value.length) {
        chatStatusMessage.value = null;
      }
  }
}

async function initChat(): Promise<void> {
  try {
    const sessionsResp = await listChatSessions();
    chatSessions.value = sessionsResp.sessions;

    if (sessionsResp.sessions.length > 0) {
      const latest = sessionsResp.sessions[0];
      currentChatSessionId.value = latest.id;
      await loadChatHistory(latest.id);
    } else {
      chatMessages.value = [];
      syncChatStatusMessage();
    }
  } catch (err) {
    log.error('Failed to init chat', err);
    chatStatusMessage.value = err instanceof ApiError && err.isUnauthorized
      ? 'Chat history is unavailable until a valid API token is provided.'
      : 'Failed to load chat sessions';
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
  chatStatusMessage.value = null;

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
    const sessionId = currentChatSessionId.value || 'analyst';

    if (wsStore.isConnected()) {
      wsStore.sendMessage(text);
      scrollToBottom();
      return;
    }

    const resp = await sendChatMessage(sessionId, text);

    if (!currentChatSessionId.value) {
      currentChatSessionId.value = resp.sessionId;
    }

    if (resp.message) {
      const msg = resp.message as unknown as ChatMessage;
      chatMessages.value = [...chatMessages.value, msg];

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
    syncChatStatusMessage();
  }
}

function handleChatKeydown(e: KeyboardEvent): void {
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

async function refreshRuntime(): Promise<void> {
  errorMsg.value = null;
  try {
    await runtimeStore.fetchState();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed';
    errorMsg.value = msg;
  }
}

let wsUnsubscribe: (() => void) | null = null;
let wsActivityUnsubscribe: (() => void) | null = null;
let wsErrorUnsubscribe: (() => void) | null = null;

function setupWsListeners(): void {
  if (wsUnsubscribe) return;

  wsUnsubscribe = wsStore.onType('message', (envelope) => {
    const content = envelope.content || {};
    if (content.role && content.content) {
      const msg = content as unknown as ChatMessage;
      chatMessages.value = [...chatMessages.value, msg];
      chatLoading.value = false;
      syncChatStatusMessage();
      scrollToBottom();
      return;
    }
    if (content.message) {
      const msg = content.message as ChatMessage;
      chatMessages.value = [...chatMessages.value, msg];
      chatLoading.value = false;
      syncChatStatusMessage();
      scrollToBottom();
      return;
    }
    if (content.text && content.role) {
      const msg: ChatMessage = {
        id: `ws-${Date.now()}`,
        session_id: currentChatSessionId.value || '',
        role: content.role as ChatMessage['role'],
        kind: content.kind as ChatMessage['kind'] || 'text',
        content: content.text as string,
        timestamp: new Date().toISOString(),
      };
      chatMessages.value = [...chatMessages.value, msg];
      chatLoading.value = false;
      syncChatStatusMessage();
      scrollToBottom();
    }
  });

  wsActivityUnsubscribe = wsStore.onType('activity', (envelope) => {
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

  wsErrorUnsubscribe = wsStore.onType('error', (envelope) => {
    chatLoading.value = false;
    const message = typeof envelope.content?.message === 'string'
      ? envelope.content.message
      : 'Live chat request failed';
    chatStatusMessage.value = message;
  });
}

function handleFocusChat(): void {
  const textarea = document.querySelector('.chat-input') as HTMLTextAreaElement;
  if (textarea) {
    textarea.focus();
  }
}

watch(wsConnectionState, () => {
  syncChatStatusMessage();
}, { immediate: true });

onMounted(async () => {
  setupWsListeners();
  window.addEventListener('saivage:focus-chat', handleFocusChat);
  await Promise.all([initChat(), refreshRuntime()]);
  runtimeStore.setupWsListener();
});

onUnmounted(() => {
  if (wsUnsubscribe) wsUnsubscribe();
  if (wsActivityUnsubscribe) wsActivityUnsubscribe();
  if (wsErrorUnsubscribe) wsErrorUnsubscribe();
  window.removeEventListener('saivage:focus-chat', handleFocusChat);
});
</script>

<style scoped>
.dashboard-layout { display: flex; height: 100%; gap: 0; }
.chat-panel { flex: 1; display: flex; flex-direction: column; min-width: 0; border-right: 1px solid #30363d; }
.chat-messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.chat-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: #8b949e; text-align: center; padding: 32px; }
.chat-empty .empty-icon { font-size: 2rem; margin-bottom: 8px; }
.chat-empty .empty-hint { font-size: 12px; color: #484f58; margin-top: 4px; }
.chat-message { padding: 10px 12px; border-radius: 6px; background: #161b22; border: 1px solid #21262d; max-width: 100%; word-wrap: break-word; overflow-wrap: break-word; }
.chat-message.role-user { background: #1c2738; border-color: #30363d; align-self: flex-end; max-width: 80%; }
.chat-message.role-system { background: #161b22; border-color: #30363d; opacity: 0.85; font-size: 12px; }
.chat-message.kind-activity { background: #1a1f2b; border-color: #30363d; opacity: 0.8; }
.message-meta { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.message-role { font-size: 11px; font-weight: 600; color: #58a6ff; text-transform: uppercase; }
.role-user .message-role { color: #7ee787; }
.role-system .message-role { color: #8b949e; }
.message-time { font-size: 10px; color: #484f58; }
.message-content { font-size: 13px; line-height: 1.6; color: #c9d1d9; }
.message-content :deep(.code-block) { background: #0d1117; border: 1px solid #30363d; border-radius: 4px; padding: 10px 12px; margin: 8px 0; overflow-x: auto; font-size: 12px; line-height: 1.5; font-family: 'SF Mono', 'Fira Code', monospace; }
.message-content :deep(.inline-code) { background: #21262d; padding: 1px 5px; border-radius: 3px; font-size: 12px; font-family: 'SF Mono', 'Fira Code', monospace; color: #d2a8ff; }
.message-content :deep(strong) { color: #f0f6fc; }
.message-tool { margin-top: 6px; }
.tool-badge { font-size: 11px; padding: 2px 6px; background: #21262d; border: 1px solid #30363d; border-radius: 4px; color: #d2a8ff; }
.message-links { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px; }
.entity-link { font-size: 11px; padding: 2px 6px; border-radius: 4px; cursor: pointer; border: 1px solid #30363d; transition: background 0.15s; }
.entity-link.card { background: #1c2738; color: #58a6ff; }
.entity-link.process { background: #1a2418; color: #7ee787; }
.entity-link.artifact { background: #241a18; color: #f0883e; }
.entity-link.attachment, .entity-link.quarantine { background: #1a1824; color: #d2a8ff; }
.entity-link:hover { filter: brightness(1.3); }
.typing-indicator { display: flex; gap: 4px; padding: 4px 0; }
.typing-indicator span { width: 6px; height: 6px; border-radius: 50%; background: #484f58; animation: pulse 1.4s infinite ease-in-out both; }
.typing-indicator span:nth-child(1) { animation-delay: 0s; }
.typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
.typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
@keyframes pulse { 0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); } 40% { opacity: 1; transform: scale(1); } }
.chat-input-area { display: flex; align-items: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid #30363d; background: #161b22; }
.chat-input { flex: 1; resize: none; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 8px 12px; color: #c9d1d9; font-size: 13px; font-family: inherit; line-height: 1.5; min-height: 38px; max-height: 120px; }
.chat-input:focus { outline: none; border-color: #58a6ff; box-shadow: 0 0 0 2px rgba(88, 166, 255, 0.15); }
.chat-input:disabled { opacity: 0.5; cursor: not-allowed; }
.chat-input::placeholder { color: #484f58; }
.send-btn { display: flex; align-items: center; justify-content: center; width: 38px; height: 38px; border: 1px solid #30363d; border-radius: 6px; background: #21262d; color: #58a6ff; cursor: pointer; flex-shrink: 0; transition: background 0.15s, border-color 0.15s; }
.send-btn:hover:not(:disabled) { background: #30363d; border-color: #58a6ff; }
.send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.status-panel { width: 320px; flex-shrink: 0; overflow-y: auto; background: #0d1117; display: flex; flex-direction: column; }
.panel-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #30363d; flex-shrink: 0; }
.panel-title { font-size: 13px; font-weight: 600; color: #f0f6fc; margin: 0; }
.chat-session-info { display: flex; align-items: center; gap: 6px; }
.chat-status-banner, .runtime-banner { margin: 12px 16px 0; padding: 10px 12px; border-radius: 6px; font-size: 12px; }
.chat-status-warning, .runtime-banner-warning { background: #241f18; border: 1px solid #9e6a03; color: #d29922; }
.chat-status-error, .runtime-banner-error { background: #241818; border: 1px solid #da3633; color: #f85149; }
.session-badge { font-size: 10px; padding: 2px 6px; border-radius: 8px; font-weight: 600; }
.session-badge.live { background: #1a2418; color: #7ee787; border: 1px solid #238636; }
.session-badge.offline { background: #241818; color: #f85149; border: 1px solid #da3633; }
.session-badge.connecting { background: #241f18; color: #d29922; border: 1px solid #9e6a03; }
.session-badge.unauthorized { background: #241818; color: #f85149; border: 1px solid #da3633; }
.session-id { font-size: 10px; color: #484f58; font-family: 'SF Mono', monospace; }
.refresh-btn { background: none; border: 1px solid #30363d; border-radius: 4px; color: #8b949e; cursor: pointer; width: 28px; height: 28px; font-size: 14px; display: flex; align-items: center; justify-content: center; transition: color 0.15s, border-color 0.15s; }
.refresh-btn:hover:not(:disabled) { color: #58a6ff; border-color: #58a6ff; }
.refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.status-loading,.status-error { padding: 16px; color: #8b949e; font-size: 12px; }
.error-banner { padding: 10px 12px; background: #241818; border: 1px solid #da3633; border-radius: 4px; color: #f85149; font-size: 12px; margin: 12px; }
.status-section { padding: 12px 16px; border-bottom: 1px solid #21262d; }
.section-label { font-size: 11px; font-weight: 600; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 8px 0; display: flex; align-items: center; gap: 6px; }
.section-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 16px; padding: 0 4px; border-radius: 8px; background: #21262d; color: #c9d1d9; font-size: 10px; font-weight: 600; }
.status-grid { display: grid; grid-template-columns: 1fr auto; gap: 6px; }
.status-item { display: contents; }
.status-key { font-size: 12px; color: #8b949e; padding: 2px 0; }
.status-value { font-size: 12px; color: #c9d1d9; text-align: right; font-family: 'SF Mono', monospace; }
.status-value.dim { color: #484f58; }
.status-value.success { color: #7ee787; }
.status-value.danger { color: #f85149; }
.status-value.clickable { color: #58a6ff; cursor: pointer; text-decoration: underline; text-decoration-color: transparent; transition: text-decoration-color 0.15s; }
.status-value.clickable:hover { text-decoration-color: #58a6ff; }
.queue-list { list-style: none; padding: 0; margin: 0; }
.queue-item { font-size: 12px; color: #58a6ff; font-family: 'SF Mono', monospace; padding: 3px 0; cursor: pointer; text-decoration: underline; text-decoration-color: transparent; transition: text-decoration-color 0.15s; }
.queue-item:hover { text-decoration-color: #58a6ff; }
.queue-more { font-size: 11px; color: #484f58; padding: 2px 0; }
.status-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; font-family: inherit; border: 1px solid transparent; }
.chip-dot { width: 5px; height: 5px; border-radius: 50%; }
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
.index-bars { display: flex; flex-direction: column; gap: 6px; }
.index-bar-row { display: grid; grid-template-columns: 60px 1fr 30px; align-items: center; gap: 8px; }
.index-label { font-size: 11px; color: #8b949e; text-align: right; }
.index-bar-track { height: 6px; background: #21262d; border-radius: 3px; overflow: hidden; }
.index-bar-fill { height: 100%; background: linear-gradient(90deg, #58a6ff, #3fb950); border-radius: 3px; min-width: 2px; transition: width 0.3s ease; }
.index-count { font-size: 11px; color: #c9d1d9; font-family: 'SF Mono', monospace; text-align: right; }
.history-grid .status-key { font-size: 11px; }
</style>
