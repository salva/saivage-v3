import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { ActivityStatus, AgentConversationEntry, AnalystSession, DetailErrorState, RestartChatAcknowledgement } from '../api/types';
import {
  ApiError,
  getChatEntries,
  sendChatMessage,
} from '../api/client';
import { useWorkspaceRouteStore } from './workspaceRoute';
import { useFeedbackStore } from './feedback';
import type { ConversationSessionId } from '../api/contracts';

function nowIso(): string {
  return new Date().toISOString();
}

function isWritableSession(session: AnalystSession | null,sessionId:ConversationSessionId|null): boolean {
  if (!session) return true;
  return session.id === sessionId && session.session_scope === 'global';
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

function optimisticUserMessage(sessionId:ConversationSessionId,content: string, timestamp: string, index: number): AgentConversationEntry {
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

type PendingMessage = {
  owner: symbol;
  entry: AgentConversationEntry;
};

function authoritativeContainsPending(entries: AgentConversationEntry[], pending: AgentConversationEntry): boolean {
  return entries.some((entry) => entry.id === pending.id || (
    entry.session_id === pending.session_id
    && entry.role === 'user'
    && entry.content === pending.content
  ));
}

export const useAnalystChat = defineStore('analyst-chat', () => {
  let messagesRequestSeq = 0;
  let messagesAbort: AbortController | null = null;
  const detailSession = ref<AnalystSession | null>(null);
  const activityStatus = ref<ActivityStatus>({ status: 'inactive', pending_calls: [] });
  const activeSessionId = ref<ConversationSessionId | null>(null);
  const authoritativeMessages = ref<AgentConversationEntry[]>([]);
  const pendingMessages = ref<PendingMessage[]>([]);
  const messages = computed(() => [
    ...authoritativeMessages.value,
    ...pendingMessages.value.map((pending) => pending.entry),
  ]);
  const draft = ref('');
  const messagesLoading = ref(false);
  const messagesError = ref<DetailErrorState | null>(null);
  const sending = ref(false);
  const sendError = ref<DetailErrorState | null>(null);
  const restartAcknowledgement = ref<RestartChatAcknowledgement | null>(null);

  const activeSession = computed(() => detailSession.value);

  function setDraft(value: string): void {
    draft.value = value;
  }

  function presentRestartAcknowledgement(restart: RestartChatAcknowledgement | null): void {
    restartAcknowledgement.value = restart?.status === 'confirmation_required' ? restart : null;
    if (restart?.status === 'scheduled') {
      useFeedbackStore().notify({
        tone: 'warning',
        title: 'Server restart scheduled',
        message: 'The server is shutting down. This does not confirm that a replacement is running.',
      });
    }
  }

  async function fetchMessages(): Promise<void> {
    const requestSeq = ++messagesRequestSeq;
    messagesAbort?.abort();
    const abort = new AbortController();
    messagesAbort = abort;
    messagesLoading.value = true;
    messagesError.value = null;
    try {
      const response = await getChatEntries(abort.signal);
      if (requestSeq !== messagesRequestSeq) return;
      activeSessionId.value=response.session_id;
      const reconciled = pendingMessages.value.filter(
        (pending) => !authoritativeContainsPending(response.entries, pending.entry),
      );
      detailSession.value = response.session;
      activityStatus.value = response.activity_status;
      authoritativeMessages.value = [...response.entries];
      pendingMessages.value = reconciled;
      messagesError.value = null;
    } catch (err) {
      if (requestSeq !== messagesRequestSeq) return;
      detailSession.value = null;
      activityStatus.value = { status: 'inactive', pending_calls: [] };
      authoritativeMessages.value = [];
      messagesError.value = buildErrorState(err, 'Failed to load analyst chat messages.');
      throw err;
    } finally {
      if (requestSeq === messagesRequestSeq) {
        messagesLoading.value = false;
        messagesAbort = null;
      }
    }
  }

  function createNewChat(): string {
    if(!activeSessionId.value)throw new Error('Analyst session identity is not loaded.');
    messagesError.value = null;
    return activeSessionId.value;
  }

  async function sendMessage(): Promise<void> {
    if (sending.value) return;
    const content = draft.value.trim();
    if (!content) return;
    if (!activeSessionId.value)throw new Error('Analyst session identity is not loaded.');
    if (!isWritableSession(activeSession.value,activeSessionId.value)) {
      sendError.value = { kind: 'unknown', status: null, message: 'Read-only — switch to analyst to send messages' };
      return;
    }

    sending.value = true;
    sendError.value = null;
    const previousDraft = draft.value;
    const pendingOwner = Symbol('analyst-send');
    let sendAccepted = false;
    try {
      const workspaceRoute = useWorkspaceRouteStore();
      const workspaceContext = workspaceRoute.current ?? { view: null, entityId: null, refinement: null };
      draft.value = '';
       const optimisticMessage = optimisticUserMessage(activeSessionId.value,content, nowIso(), messages.value.length);
      pendingMessages.value = [...pendingMessages.value, { owner: pendingOwner, entry: optimisticMessage }];
      const response = await sendChatMessage(content, workspaceContext);
      sendAccepted = true;
      presentRestartAcknowledgement(response.restart);

      for (const rawInvocation of response.toolInvocations) {
        const invocation = asRecord(rawInvocation);
        if (!invocation || (invocation.tool !== 'navigate_workspace' && invocation.tool !== 'navigate_back')) continue;
        const result = asRecord(invocation.result);
        if (!result || result.success !== true || !result.data || typeof result.data !== 'object') continue;
        workspaceRoute.apply(result.data as Parameters<typeof workspaceRoute.apply>[0]);
      }

      try {
        await fetchMessages();
      } catch {
        // The send was accepted. Refresh state is reported independently by fetchMessages.
      }
    } catch (err) {
      if (sendAccepted) throw err;
      sendError.value = buildErrorState(err, 'Failed to send analyst chat message.');
      pendingMessages.value = pendingMessages.value.filter((pending) => pending.owner !== pendingOwner);
      if (draft.value === '') draft.value = previousDraft;
      useFeedbackStore().notifyError('Failed to send Analyst message', sendError.value.message);
      throw err;
    } finally {
      sending.value = false;
    }
  }

  function ingestWsEvent(payload: Record<string, unknown>): void {
    const event = typeof payload.event === 'string' ? payload.event : null;
    if (event === 'card_history_appended') {
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
    }
  }

  function ingestRestartAcknowledgement(restart: RestartChatAcknowledgement | null): void {
    presentRestartAcknowledgement(restart);
  }

  return {
    activeSessionId,
    activeSession,
    detailSession,
    activityStatus,
    messages,
    draft,
    messagesLoading,
    messagesError,
    sending,
    sendError,
    restartAcknowledgement,
    activeSessionWritable: computed(() => isWritableSession(activeSession.value,activeSessionId.value)),
    setDraft,
    fetchMessages,
    createNewChat,
    sendMessage,
    ingestWsEvent,
    ingestRestartAcknowledgement,
  };
});
