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
import { parseToolCallMessage } from '../utils/persistedToolCall';

export const ANALYST_SESSION_ID = 'analyst';
const MAX_PENDING_TOOL_INVOCATIONS = 12;
const MAX_PENDING_SUMMARY_LENGTH = 200;
const FALLBACK_PENDING_SUMMARY = 'tool invoked';

interface PendingToolInvocation {
  id: string;
  sessionId: string;
  tool: string;
  classifiedAs?: string | null;
  success: boolean;
  summary: string;
  relatedCardId?: string | null;
}

interface SyntheticHintState {
  sessionId: string | null;
  content: string | null;
}

interface TimelineBadge {
  kind: 'card-history' | 'notification' | 'control-action' | 'tool-invoked';
  label: string;
  timestamp: string;
}

export interface AnalystToastItem { id: string; label: string; }

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

function normalizePendingSummary(summary: unknown): string {
  if (typeof summary !== 'string') {
    return FALLBACK_PENDING_SUMMARY;
  }
  const normalized = summary.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return FALLBACK_PENDING_SUMMARY;
  }
  return normalized.slice(0, MAX_PENDING_SUMMARY_LENGTH);
}

function normalizeToolName(tool: unknown): string {
  if (typeof tool !== 'string') {
    return 'tool';
  }
  const normalized = tool.trim();
  return normalized || 'tool';
}

function buildPendingInvocationId(invocation: Omit<PendingToolInvocation, 'id'>): string {
  return [
    invocation.sessionId,
    invocation.tool,
    invocation.summary,
    invocation.success ? 'ok' : 'error',
    invocation.classifiedAs ?? '',
    invocation.relatedCardId ?? '',
  ].join(':');
}

function toolInvocationMatchesMessage(invocation: PendingToolInvocation, message: AgentConversationEntry): boolean {
  if (message.tool !== invocation.tool) return false;
  if (message.kind === 'tool_call' && message.role === 'assistant') {
    try {
      const call = parseToolCallMessage(JSON.parse(message.content));
      return call.name === invocation.tool;
    } catch {
      return false;
    }
  }
  if ((message.kind === 'tool_result' || message.kind === 'tool_error') && message.role === 'tool') {
    return true;
  }
  return false;
}

function dedupePendingToolInvocations(
  pending: PendingToolInvocation[],
  sessionId: string,
  fetchedMessages: AgentConversationEntry[],
): PendingToolInvocation[] {
  return pending.filter((invocation) => {
    if (invocation.sessionId !== sessionId) {
      return true;
    }
    return !fetchedMessages.some((message) => toolInvocationMatchesMessage(invocation, message));
  });
}

function pushPendingToolInvocation(
  pending: PendingToolInvocation[],
  invocation: Omit<PendingToolInvocation, 'id'>,
): PendingToolInvocation[] {
  const normalizedInvocation = {
    ...invocation,
    id: buildPendingInvocationId(invocation),
  } satisfies PendingToolInvocation;
  const next = pending.filter((item) => item.id !== normalizedInvocation.id);
  next.push(normalizedInvocation);
  return next.slice(-MAX_PENDING_TOOL_INVOCATIONS);
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
  const syntheticHint = ref<SyntheticHintState>({ sessionId: null, content: null });
  const pendingToolInvocations = ref<PendingToolInvocation[]>([]);
  const messageBadges = ref<Record<string, TimelineBadge[]>>({});
  const pendingCardSeed = ref<{ sessionId: string; cardId: string } | null>(null);
  const toasts = ref<AnalystToastItem[]>([]);

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

  function buildCardContextSeed(card: CardRecord): string {
    const blockers = [
      ...(Array.isArray(card.depends_on) ? card.depends_on.map((id) => `depends_on:${id}`) : []),
      ...(card.lifecycle.error ? [`error:${card.lifecycle.error}`] : []),
    ];
    const toolResult = {
      tool: 'get_card',
      ok: true,
      card: {
        id: card.id,
        title: card.title,
        description: card.description ?? '',
        status: card.status,
        blockers,
        version_seq: card.version_seq ?? null,
      },
    };
    return [
      'System context: this per-card analyst discussion was opened from the card detail view.',
      `Card title: ${card.title}`,
      `Card description: ${card.description ?? ''}`,
      `Card status: ${card.status}`,
      `Card blockers: ${blockers.length ? blockers.join(', ') : 'none'}`,
      `Tool result get_card: ${JSON.stringify(toolResult)}`,
      'Use this seeded card context as the default subject unless the operator asks otherwise.',
    ].join('\n');
  }

  function seedCardContext(card: CardRecord): string {
    activeSessionId.value = ANALYST_SESSION_ID;
    ensureSessionInList();
    syntheticHint.value = { sessionId: ANALYST_SESSION_ID, content: buildCardContextSeed(card) };
    pendingCardSeed.value = { sessionId: ANALYST_SESSION_ID, cardId: card.id };
    return ANALYST_SESSION_ID;
  }

  function consumeSyntheticHint(sessionId: string): string | null {
    if (syntheticHint.value.sessionId !== sessionId || !syntheticHint.value.content) {
      return null;
    }
    const hint = syntheticHint.value.content;
    syntheticHint.value = { sessionId: null, content: null };
    return hint;
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
    try {
      const workspaceRoute = useWorkspaceRouteStore();
      const workspaceContext = workspaceRoute.current ?? { view: null, entityId: null, refinement: null };
      const hint = consumeSyntheticHint(sessionId);
      const payload = hint ? `${hint}\n\n${content}` : content;
      draft.value = '';
      const response = await sendChatMessage(sessionId, payload, workspaceContext);
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
      throw err;
    } finally {
      sending.value = false;
    }
  }

  function addBadgeForActiveSession(label: string, kind: TimelineBadge['kind']): void {
    const message = messages.value[messages.value.length - 1];
    if (!message) return;
    const next = { ...messageBadges.value };
    const existing = next[message.id] ?? [];
    next[message.id] = [...existing, { kind, label, timestamp: nowIso() }];
    messageBadges.value = next;
  }

  function addToast(item: AnalystToastItem): void {
    toasts.value = [...toasts.value.filter((toast) => toast.id !== item.id), item].slice(-3);
  }

  function removeToast(id: string): void {
    toasts.value = toasts.value.filter((toast) => toast.id !== id);
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
      if (eventSessionId === activeSessionId.value) {
        addBadgeForActiveSession(`${tool}: ${summary}`, 'tool-invoked');
      }
      return;
    }

    if (payloadSessionId && payloadSessionId !== activeSessionId.value) {
      return;
    }

    if (event === 'card_history_appended') {
      addBadgeForActiveSession('card history updated', 'card-history');
      void fetchMessages().catch(() => {});
      return;
    }
    if (event === 'notification_added') {
      addBadgeForActiveSession('notification added', 'notification');
      return;
    }
    if (event === 'control_action_recorded') {
      addBadgeForActiveSession('control action recorded', 'control-action');
      if (payload.actor === 'analyst' && payload.surface === 'web-chat') {
        const action = typeof payload.action === 'string' ? payload.action : 'action';
        const targetId = typeof payload.target_id === 'string' ? payload.target_id : 'unknown';
        const id = typeof payload.id === 'string' ? payload.id : `${Date.now()}`;
        addToast({ id, label: `Analyst ${action} on ${targetId}` });
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
    syntheticHint,
    pendingToolInvocations,
    messageBadges,
    pendingCardSeed,
    toasts,
    activeSessionWritable: computed(() => isWritableSession(activeSession.value)),
    setDraft,
    fetchSessions,
    selectSession,
    fetchMessages,
    createNewChat,
    seedCardContext,
    consumeSyntheticHint,
    sendMessage,
    ingestWsEvent,
    removeToast,
  };
});
