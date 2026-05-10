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
} from '../api/types';
import { getAgentConversation, ApiError } from '../api/client';
import { useWsStore } from './ws';
import { createLogger } from '../utils/logger';

const log = createLogger('store:agents');

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
      // If there's already a tool_call in current, push and start new
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
    } else if (msg.kind === 'text' || msg.kind === 'activity' || msg.kind === 'model_issue' || msg.kind === 'model_repair' || msg.kind === 'model_recovered') {
      // If we have an existing partial step, push it first
      if (current.reasoning || current.toolCall) {
        steps.push(current);
        current = {};
      }
      // For standalone messages, create a step with just reasoning
      if (msg.role === 'assistant' || msg.role === 'system') {
        steps.push({ reasoning: msg });
      } else if (msg.role === 'user') {
        steps.push({ reasoning: msg });
      }
    }
  }

  // Don't lose a trailing partial step
  if (current.reasoning || current.toolCall || current.toolResult) {
    steps.push(current);
  }

  return steps;
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

  /** Which tool calls are expanded (by message id). */
  const expandedToolCalls = ref<Set<string>>(new Set());

  // ── Getters ────────────────────────────────────────────────

  const steps = computed<MessageStep[]>(() => groupIntoSteps(messages.value));

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

  const activeSessions = computed<AgentSession[]>(() =>
    sessions.value.filter((s) => s.status === 'active'),
  );

  const completedSessions = computed<AgentSession[]>(() =>
    sessions.value.filter((s) => s.status !== 'active'),
  );

  // ── Actions ────────────────────────────────────────────────

  /** Fetch conversation for a specific agent session. */
  async function fetchConversation(sessionId: string): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const response: AgentConversationResponse = await getAgentConversation(sessionId);
      currentSession.value = response.session;
      messages.value = response.messages;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to fetch agent conversation';
      error.value = msg;
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
    // Trigger reactivity
    sessions.value = [...sessions.value];
  }

  /** Update session status. */
  function updateSessionStatus(sessionId: string, status: AgentStatus): void {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (session) {
      session.status = status;
      session.completed_at = status !== 'active' ? new Date().toISOString() : null;
      sessions.value = [...sessions.value];
    }
    if (currentSession.value?.id === sessionId) {
      currentSession.value = {
        ...currentSession.value,
        status,
        completed_at: status !== 'active' ? new Date().toISOString() : null,
      };
    }
  }

  /** Append a message to the current conversation view. */
  function appendMessage(message: AgentMessage): void {
    if (currentSession.value && message.session_id === currentSession.value.id) {
      messages.value = [...messages.value, message];
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

  let wsUnsubscribe: (() => void) | null = null;

  function setupWsListener(): void {
    if (wsUnsubscribe) return;
    const ws = useWsStore();
    wsUnsubscribe = ws.onType('status', (envelope) => {
      const content = envelope.content || {};
      const event = content.event as string;

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

    // Listen for thinking/activity events for agent messages
    ws.onType('thinking', (envelope) => {
      const content = envelope.content || {};
      if (content.sessionId && content.message) {
        const msg = content.message as AgentMessage;
        if (currentSession.value && msg.session_id === currentSession.value.id) {
          appendMessage(msg);
        }
      }
    });

    ws.onType('activity', (envelope) => {
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

    // Getters
    steps,
    sessionsByRole,
    activeSessions,
    completedSessions,

    // Actions
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
