import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { AgentConversationEntry, CardRecord, ChatSession, DetailErrorState } from '../api/types';
import {
  ApiError,
  getChatEntries,
  listChatSessions,
  sendChatMessage,
} from '../api/client';
import { useWorkspaceRouteStore } from './workspaceRoute';
import { useFeedbackStore } from './feedback';
import { ANALYST_SESSION_ID, buildCardContextSeed } from './analyst-chat-context';
import {
  dedupePendingToolInvocations,
  normalizePendingSummary,
  normalizeToolName,
  pushPendingToolInvocation,
  type PendingToolInvocation,
} from './analyst-chat-pending-tools';

export { ANALYST_SESSION_ID } from './analyst-chat-context';

function nowIso(): string {
  return new Date().toISOString();
}

function isWritableSession(session: ChatSession | null): boolean {
  if (!session) return true;
  return session.id === ANALYST_SESSION_ID && session.role === 'analyst';
}

function buildErrorState(err: unknown, fallback: string): DetailErrorState {
  if (err instanceof ApiError) {
    if (err.isUnauthorized) {
      return { kind: 'unauthorized', status: err.status, message: err.message || 'Unauthorized.' };
    }
    if (err.status >= 500) {
      return { kind: 'server', status: err.status, message: err.message || fallback };
    }
    return { kind: 'unknown', status: err.status, message: err.message || fallback };
  }
  if (err instanceof Error) {
    return { kind: 'network', status: null, message: err.message || fallback };
  }
  return { kind: 'unknown', status: null, message: fallback };
}


function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function optimisticUserMessage(sessionId: string, content: string, timestamp: string, index: number): AgentConversationEntry {
  return {
    id: `${sessionId}-user-optimistic-${Date.now()}`,
    session_id: sessionId,
    role: 'user',
    kind: 'text',
    content,
    round_id: `r-user-${Date.now().toString(16).padStart(32, '0').slice(-32)}`,
    message_index: index,
    block_index: 0,
    timestamp,
  };
}

export const useAnalystChat = defineStore('analyst-chat', () => {
  const sessions = ref<ChatSession[]>([]);
  const activeSessionId = ref<string | null>(ANALYST_SESSION_ID);
  const messages = ref<AgentConversationEntry[]>([]);
  const draft = ref('');
  const sessionsLoading = ref(false);
  const sessionsError = ref<DetailErrorState | null>(null);
  const messagesLoading = ref(false);
  const messagesError = ref<DetailErrorState | null>(null);
  const sending = ref(false);
  const sendError = ref<DetailErrorState | null>(null);
  const pendingToolInvocations = ref<PendingToolInvocation[]>([]);

  const hasDraft = computed(() => draft.value.trim().length > 0);
  const activeSession = computed(() => sessions.value.find((session) => session.id === activeSessionId.value) ?? null);

  function ensureSessionInList(sessionId = ANALYST_SESSION_ID, role = 'analyst'): void {
    if (sessions.value.some((session) => session.id === sessionId)) {
      return;
    }
    sessions.value = [{
      id: sessionId,
      role,
      status: 'active',
      started_at: nowIso(),
    }, ...sessions.value];
  }

  function setDraft(value: string): void {
    draft.value = value;
  }

  async function fetchSessions(): Promise<void> {
    sessionsLoading.value = true;
    sessionsError.value = null;
    try {
      const response = await listChatSessions();
      const canonical = response.sessions.find((session) => session.id === ANALYST_SESSION_ID)
        ?? { id: ANALYST_SESSION_ID, role: 'analyst', status: 'active', started_at: nowIso() };
      sessions.value = [{ ...canonical, role: 'analyst' }];
      activeSessionId.value = ANALYST_SESSION_ID;
    } catch (err) {
      sessionsError.value = buildErrorState(err, 'Failed to load analyst chat sessions.');
      throw err;
    } finally {
      sessionsLoading.value = false;
    }
  }

  async function selectSession(_sessionId = ANALYST_SESSION_ID): Promise<void> {
    activeSessionId.value = ANALYST_SESSION_ID;
    ensureSessionInList();
    await fetchMessages(ANALYST_SESSION_ID);
  }

  async function fetchMessages(sessionId = activeSessionId.value): Promise<void> {
    const canonicalSessionId = sessionId === ANALYST_SESSION_ID ? sessionId : ANALYST_SESSION_ID;
    activeSessionId.value = ANALYST_SESSION_ID;
    ensureSessionInList();
    messagesLoading.value = true;
    messagesError.value = null;
    try {
      const response = await getChatEntries(canonicalSessionId);
      const fetchedMessages = [...response.entries].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      messages.value = fetchedMessages;
      pendingToolInvocations.value = dedupePendingToolInvocations(
        pendingToolInvocations.value,
        canonicalSessionId,
        fetchedMessages,
      );
    } catch (err) {
      messages.value = [];
      messagesError.value = buildErrorState(err, 'Failed to load analyst chat messages.');
      throw err;
    } finally {
      messagesLoading.value = false;
    }
  }

  function createNewChat(): string {
    activeSessionId.value = ANALYST_SESSION_ID;
    messagesError.value = null;
    ensureSessionInList();
    return ANALYST_SESSION_ID;
  }

  function seedCardContext(card: CardRecord): string {
    activeSessionId.value = ANALYST_SESSION_ID;
    ensureSessionInList();
    draft.value = buildCardContextSeed(card);
    return ANALYST_SESSION_ID;
  }

  async function sendMessage(): Promise<void> {
    if (sending.value) return;
    const content = draft.value.trim();
    if (!content) return;
    const sessionId = ANALYST_SESSION_ID;
    activeSessionId.value = ANALYST_SESSION_ID;
    ensureSessionInList();
    if (!isWritableSession(activeSession.value)) {
      sendError.value = { kind: 'unknown', status: null, message: 'Read-only — switch to analyst to send messages' };
      return;
    }

    sending.value = true;
    sendError.value = null;
    const previousDraft = draft.value;
    const previousMessages = messages.value;
    try {
      const workspaceRoute = useWorkspaceRouteStore();
      const workspaceContext = workspaceRoute.current ?? { view: null, entityId: null, refinement: null };
      draft.value = '';
      messages.value = [...messages.value, optimisticUserMessage(sessionId, content, nowIso(), messages.value.length)];
      const response = await sendChatMessage(sessionId, content, workspaceContext);
      const baseTimestamp = nowIso();
      const responseMessage = response.message as { id?: unknown; content?: unknown; round_id?: unknown; message_index?: unknown; block_index?: unknown; tool?: unknown; timestamp?: unknown; links?: unknown };
      const optimistic = {
        id: String(responseMessage.id ?? `${sessionId}-assistant-${Date.now()}`),
        session_id: sessionId,
        role: 'assistant' as const,
        kind: 'text' as const,
        content: String(responseMessage.content ?? ''),
        round_id: typeof responseMessage.round_id === 'string'
          ? responseMessage.round_id
          : `r-assistant-${Date.now().toString(16).padStart(32, '0').slice(-32)}`,
        message_index: typeof responseMessage.message_index === 'number' && Number.isFinite(responseMessage.message_index)
          ? responseMessage.message_index
          : messages.value.length,
        block_index: typeof responseMessage.block_index === 'number' && Number.isFinite(responseMessage.block_index)
          ? responseMessage.block_index
          : 0,
        tool: typeof responseMessage.tool === 'string'
          ? responseMessage.tool
          : undefined,
        timestamp: typeof responseMessage.timestamp === 'string'
          ? responseMessage.timestamp
          : baseTimestamp,
        links: Array.isArray(responseMessage.links)
          ? responseMessage.links
          : undefined,
      } satisfies AgentConversationEntry;
      messages.value = [...messages.value, optimistic];

      for (const rawInvocation of response.toolInvocations) {
        const invocation = asRecord(rawInvocation);
        if (!invocation || (invocation.tool !== 'navigate_workspace' && invocation.tool !== 'navigate_back')) continue;
        const result = asRecord(invocation.result);
        if (!result || result.success !== true || !result.data || typeof result.data !== 'object') continue;
        workspaceRoute.apply(result.data as Parameters<typeof workspaceRoute.apply>[0]);
      }

      await fetchMessages(response.sessionId);
    } catch (err) {
      sendError.value = buildErrorState(err, 'Failed to send analyst chat message.');
      draft.value = previousDraft;
      messages.value = previousMessages;
      useFeedbackStore().notifyError('Failed to send Analyst message', sendError.value.message);
      throw err;
    } finally {
      sending.value = false;
    }
  }

  function ingestWsEvent(payload: Record<string, unknown>): void {
    const event = typeof payload.event === 'string' ? payload.event : null;
    const payloadSessionId = typeof payload.session_id === 'string'
      ? payload.session_id
      : typeof payload.sessionId === 'string'
        ? payload.sessionId
        : null;

    if (event === 'analyst_tool_invoked' && payloadSessionId) {
      const eventSessionId = ANALYST_SESSION_ID;
      const tool = normalizeToolName(payload.tool);
      const success = payload.success === true;
      const summary = normalizePendingSummary(payload.summary);
      const classifiedAs = typeof payload.classified_as === 'string' ? payload.classified_as : null;
      const relatedCardId = typeof payload.related_card_id === 'string' ? payload.related_card_id : null;
      pendingToolInvocations.value = pushPendingToolInvocation(pendingToolInvocations.value, {
        sessionId: eventSessionId,
        tool,
        classifiedAs,
        success,
        summary,
        relatedCardId,
      });
      return;
    }

    if (payloadSessionId && payloadSessionId !== activeSessionId.value) {
      return;
    }

    if (event === 'card_history_appended') {
      void fetchMessages().catch(() => {});
      return;
    }
    if (event === 'notification_added') {
      return;
    }
    if (event === 'control_action_recorded') {
      if (payload.actor === 'analyst' && payload.surface === 'web-chat') {
        const action = typeof payload.action === 'string' ? payload.action : 'action';
        const targetId = typeof payload.target_id === 'string' ? payload.target_id : 'unknown';
        const id = typeof payload.id === 'string' ? payload.id : `${Date.now()}`;
        useFeedbackStore().notify({ id, tone: 'neutral', title: `Analyst ${action}`, message: targetId });
      }
      if (payloadSessionId === activeSessionId.value || activeSessionId.value) {
        void fetchMessages().catch(() => {});
      }
    }
  }

  return {
    sessions,
    activeSessionId,
    activeSession,
    messages,
    draft,
    hasDraft,
    sessionsLoading,
    sessionsError,
    messagesLoading,
    messagesError,
    sending,
    sendError,
    pendingToolInvocations,
    activeSessionWritable: computed(() => isWritableSession(activeSession.value)),
    setDraft,
    fetchSessions,
    selectSession,
    fetchMessages,
    createNewChat,
    seedCardContext,
    sendMessage,
    ingestWsEvent,
  };
});
