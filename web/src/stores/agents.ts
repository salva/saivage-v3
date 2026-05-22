/**
 * Pinia store for agent sessions and conversations.
 *
 * Manages agent session list and conversation detail with
 * expandable tool calls and results. Supports the four agent
 * roles: analyst, planner, executor, reviewer.
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type {
  AgentSession,
  AgentMessage,
  AgentRole,
  AgentStatus,
  AgentConversationResponse,
  FreshnessState,
} from '../api/types';
import { listAgentSessions, getAgentConversation, ApiError } from '../api/client';
import { useWsStore } from './ws';
import { createLogger } from '../utils/logger';

const log = createLogger('store:agents');
const STALE_AFTER_MS = 30_000;

// ── Helpers ────────────────────────────────────────────────────

/** Group messages into reasoning → tool-call → tool-result steps. */
interface MessageStep {
  /** The reasoning/text message that preceded a tool call. */
  reasoning?: AgentMessage;
  /** The tool call message. */
  toolCall?: AgentMessage;
  /** The tool result (or error) that followed. */
  toolResult?: AgentMessage;
}

function groupIntoSteps(messages: AgentMessage[]): MessageStep[] {
  const steps: MessageStep[] = [];
  let current: MessageStep = {};

  for (const msg of messages) {
    if (msg.kind === 'tool_call') {
      if (current.toolCall) {
        steps.push(current);
        current = { toolCall: msg };
      } else {
        current.toolCall = msg;
      }
    } else if (msg.kind === 'tool_result' || msg.kind === 'tool_error') {
      current.toolResult = msg;
      steps.push(current);
      current = {};
    } else if (msg.kind === 'text' || msg.kind === 'activity') {
      if (current.reasoning || current.toolCall) {
        steps.push(current);
        current = {};
      }
      current.reasoning = msg;
    } else if (msg.kind === 'model_issue' || msg.kind === 'model_repair' || msg.kind === 'model_recovered') {
      if (current.reasoning || current.toolCall) {
        steps.push(current);
        current = {};
      }
      steps.push({ reasoning: msg });
    }
  }

  if (current.reasoning || current.toolCall || current.toolResult) {
    steps.push(current);
  }

  return steps;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── Store ──────────────────────────────────────────────────────

export const useAgentStore = defineStore('agents', () => {
  // ── State ──────────────────────────────────────────────────

  const sessions = ref<AgentSession[]>([]);
  /** Currently viewed session messages. */
  const messages = ref<AgentMessage[]>([]);
  const currentSession = ref<AgentSession | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const lastFetchedAt = ref<string | null>(null);
  const lastWsEventAt = ref<string | null>(null);
  const lastUpdatedBy = ref<FreshnessState['lastUpdatedBy']>('unknown');
  const unauthorized = ref(false);
  const conversationWarning = ref<string | null>(null);

  /** Which tool calls are expanded (by message id). */
  const expandedToolCalls = ref<Set<string>>(new Set());

  // ── Getters ────────────────────────────────────────────────

  const steps = computed<MessageStep[]>(() => groupIntoSteps(messages.value));
  const isStale = computed(() => {
    const latest = lastWsEventAt.value ?? lastFetchedAt.value;
    if (!latest) return false;
    return Date.now() - new Date(latest).getTime() > STALE_AFTER_MS;
  });

  /** Sessions grouped by role. */
  const sessionsByRole = computed<Map<AgentRole, AgentSession[]>>(() => {
    const map = new Map<AgentRole, AgentSession[]>();
    for (const session of sessions.value) {
      const list = map.get(session.role);
      if (list) {
        list.push(session);
      } else {
        map.set(session.role, [session]);
      }
    }
    return map;
  });

  function isLiveStatus(status: AgentStatus): boolean {
    return status === 'active' || status === 'waiting';
  }

  const activeSessions = computed<AgentSession[]>(() =>
    sessions.value.filter((s) => isLiveStatus(s.status)),
  );

  const completedSessions = computed<AgentSession[]>(() =>
    sessions.value.filter((s) => !isLiveStatus(s.status)),
  );

  const attentionSessions = computed<AgentSession[]>(() =>
    sessions.value.filter((s) => s.status === 'failed' || s.status === 'blocked'),
  );

  function markRestSync(): void {
    lastFetchedAt.value = nowIso();
    lastUpdatedBy.value = 'rest';
  }

  function markWsSync(): void {
    lastWsEventAt.value = nowIso();
    lastUpdatedBy.value = lastFetchedAt.value ? 'mixed' : 'ws';
  }

  // ── Actions ────────────────────────────────────────────────

  /** Fetch persisted agent sessions for initial page load or refresh. */
  async function fetchSessions(): Promise<void> {
    loading.value = true;
    error.value = null;
    unauthorized.value = false;
    try {
      const response = await listAgentSessions();
      sessions.value = response.sessions;
      markRestSync();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to fetch agent sessions';
      error.value = msg;
      unauthorized.value = err instanceof ApiError && err.isUnauthorized;
      log.error('fetchSessions', msg);
      throw err;
    } finally {
      loading.value = false;
    }
  }

  /** Fetch conversation for a specific agent session. */
  async function fetchConversation(sessionId: string): Promise<void> {
    loading.value = true;
    error.value = null;
    conversationWarning.value = null;
    unauthorized.value = false;
    try {
      const response: AgentConversationResponse = await getAgentConversation(sessionId);
      currentSession.value = response.session;
      messages.value = response.messages;
      if (response.messages.length === 0) {
        conversationWarning.value = 'No recorded conversation messages were returned for this session.';
      } else if (response.messages.some((msg) => msg.kind === 'model_issue')) {
        conversationWarning.value = 'Conversation includes model/tool recovery events; inspect for incomplete or repaired output.';
      }
      markRestSync();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to fetch agent conversation';
      error.value = msg;
      unauthorized.value = err instanceof ApiError && err.isUnauthorized;
      log.error('fetchConversation', msg);
      throw err;
    } finally {
      loading.value = false;
    }
  }

  /** Add a session to the local list (from WS or initial fetch). */
  function addSession(session: AgentSession): void {
    const idx = sessions.value.findIndex((s) => s.id === session.id);
    if (idx !== -1) {
      sessions.value[idx] = session;
    } else {
      sessions.value.push(session);
    }
    sessions.value = [...sessions.value];
  }

  /** Update session status. */
  function updateSessionStatus(sessionId: string, status: AgentStatus): void {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (session) {
      session.status = status;
      session.completed_at = isLiveStatus(status) ? null : new Date().toISOString();
      sessions.value = [...sessions.value];
    }
    if (currentSession.value?.id === sessionId) {
      currentSession.value = {
        ...currentSession.value,
        status,
        completed_at: isLiveStatus(status) ? null : new Date().toISOString(),
      };
      if (status === 'failed') {
        conversationWarning.value = 'This session failed. Inspect tool/model messages and linked evidence before treating work as complete.';
      }
    }
  }

  /** Append a message to the current conversation view. */
  function appendMessage(message: AgentMessage): void {
    if (currentSession.value && message.session_id === currentSession.value.id) {
      messages.value = [...messages.value, message];
      markWsSync();
      if (message.kind === 'tool_error' || message.kind === 'model_issue') {
        conversationWarning.value = 'Conversation includes tool/model failures or repairs; inspect linked evidence carefully.';
      }
    }
  }

  // ── Tool Call Expansion ────────────────────────────────────

  function toggleToolCall(messageId: string): void {
    const set = new Set(expandedToolCalls.value);
    if (set.has(messageId)) {
      set.delete(messageId);
    } else {
      set.add(messageId);
    }
    expandedToolCalls.value = set;
  }

  function expandAll(): void {
    const set = new Set<string>();
    for (const msg of messages.value) {
      if (msg.kind === 'tool_call' || msg.kind === 'tool_result' || msg.kind === 'tool_error') {
        set.add(msg.id);
      }
    }
    expandedToolCalls.value = set;
  }

  function collapseAll(): void {
    expandedToolCalls.value = new Set();
  }

  // ── WebSocket Integration ──────────────────────────────────

  let statusUnsubscribe: (() => void) | null = null;
  let thinkingUnsubscribe: (() => void) | null = null;
  let activityUnsubscribe: (() => void) | null = null;
  let reconnectUnsubscribe: (() => void) | null = null;

  function setupWsListener(): void {
    const ws = useWsStore();
    if (!reconnectUnsubscribe) {
      reconnectUnsubscribe = ws.onReconnect(() => {
        fetchSessions().catch(() => {});
        if (currentSession.value?.id) {
          fetchConversation(currentSession.value.id).catch(() => {});
        }
      });
    }
    if (statusUnsubscribe) return;

    statusUnsubscribe = ws.onType('status', (envelope) => {
      const content = envelope.content || {};
      const event = content.event as string;
      markWsSync();

      if (event === 'agent-session-started' && content.session) {
        addSession(content.session as AgentSession);
      }

      if (event === 'agent-session-completed' && content.sessionId) {
        updateSessionStatus(content.sessionId as string, 'done');
      }

      if (event === 'agent-session-failed' && content.sessionId) {
        updateSessionStatus(content.sessionId as string, 'failed');
      }
    });

    thinkingUnsubscribe = ws.onType('thinking', (envelope) => {
      const content = envelope.content || {};
      if (content.sessionId && content.message) {
        const msg = content.message as AgentMessage;
        if (currentSession.value && msg.session_id === currentSession.value.id) {
          appendMessage(msg);
        }
      }
    });

    activityUnsubscribe = ws.onType('activity', (envelope) => {
      const content = envelope.content || {};
      if (content.sessionId && content.message) {
        const msg = content.message as AgentMessage;
        if (currentSession.value && msg.session_id === currentSession.value.id) {
          appendMessage(msg);
        }
      }
    });
  }

  return {
    // State
    sessions,
    messages,
    currentSession,
    loading,
    error,
    expandedToolCalls,
    lastFetchedAt,
    lastWsEventAt,
    lastUpdatedBy,
    unauthorized,
    conversationWarning,

    // Getters
    steps,
    sessionsByRole,
    activeSessions,
    completedSessions,
    attentionSessions,
    isStale,

    // Actions
    fetchSessions,
    fetchConversation,
    addSession,
    updateSessionStatus,
    appendMessage,
    toggleToolCall,
    expandAll,
    collapseAll,
    setupWsListener,
  };
});
