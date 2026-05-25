import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { CardRecord, ChatMessage, ChatSession, DetailErrorState } from '../api/types';
import {
  ApiError,
  getChatMessages,
  listAgentSessions,
  sendChatMessage,
} from '../api/client';

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
  kind: 'card-history' | 'notification' | 'notification-ack' | 'control-action' | 'tool-invoked';
  label: string;
  timestamp: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isWritableSession(session: ChatSession | null): boolean {
  if (!session) return true;
  return session.role === 'analyst' || session.role === 'card' || session.id.startsWith('card-');
}

function inferSessionRole(sessionId: string): string {
  if (sessionId.startsWith('card-')) return 'card';
  return 'analyst';
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

function mintSessionId(): string {
  return `chat-${Date.now()}`;
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

function toolInvocationMatchesMessage(invocation: PendingToolInvocation, message: ChatMessage): boolean {
  if (message.role !== 'tool' || message.tool !== invocation.tool) {
    return false;
  }

  if (message.kind === 'tool_call') {
    try {
      const parsed = JSON.parse(message.content) as { toolCalls?: Array<{ tool?: unknown }> };
      return Array.isArray(parsed.toolCalls)
        && parsed.toolCalls.some((call) => String(call.tool ?? invocation.tool) === invocation.tool);
    } catch {
      return true;
    }
  }

  return message.kind === 'tool_result';
}

function dedupePendingToolInvocations(
  pending: PendingToolInvocation[],
  sessionId: string,
  fetchedMessages: ChatMessage[],
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
  const activeSessionId = ref<string | null>(null);
  const messages = ref<ChatMessage[]>([]);
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
  const unsavedSessionIds = ref<Set<string>>(new Set());

  const hasDraft = computed(() => draft.value.trim().length > 0);
  const activeSession = computed(() => sessions.value.find((session) => session.id === activeSessionId.value) ?? null);

  function ensureSessionInList(sessionId: string, role = inferSessionRole(sessionId)): void {
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

  function markSessionUnsaved(sessionId: string): void {
    const next = new Set(unsavedSessionIds.value);
    next.add(sessionId);
    unsavedSessionIds.value = next;
  }

  function markSessionSaved(sessionId: string): void {
    if (!unsavedSessionIds.value.has(sessionId)) return;
    const next = new Set(unsavedSessionIds.value);
    next.delete(sessionId);
    unsavedSessionIds.value = next;
  }

  function isUnsavedSession(sessionId: string | null): boolean {
    return Boolean(sessionId && unsavedSessionIds.value.has(sessionId));
  }

  function setDraft(value: string): void {
    draft.value = value;
  }

  async function fetchSessions(): Promise<void> {
    sessionsLoading.value = true;
    sessionsError.value = null;
    try {
      const response = await listAgentSessions();
      sessions.value = response.sessions.map((session) => ({
        id: session.id,
        role: session.id.startsWith('card-') ? 'card' : session.role,
        status: session.status,
        started_at: session.started_at,
      }));
      if (!activeSessionId.value && response.sessions.length > 0) {
        activeSessionId.value = response.sessions[0].id;
      }
    } catch (err) {
      sessionsError.value = buildErrorState(err, 'Failed to load analyst chat sessions.');
      throw err;
    } finally {
      sessionsLoading.value = false;
    }
  }

  async function selectSession(sessionId: string): Promise<void> {
    activeSessionId.value = sessionId;
    ensureSessionInList(sessionId);
    if (isUnsavedSession(sessionId)) {
      messages.value = [];
      messagesError.value = null;
      messagesLoading.value = false;
      return;
    }
    await fetchMessages(sessionId);
  }

  async function fetchMessages(sessionId = activeSessionId.value): Promise<void> {
    if (!sessionId) {
      messages.value = [];
      return;
    }
    if (isUnsavedSession(sessionId)) {
      activeSessionId.value = sessionId;
      messages.value = [];
      messagesError.value = null;
      messagesLoading.value = false;
      return;
    }
    activeSessionId.value = sessionId;
    messagesLoading.value = true;
    messagesError.value = null;
    try {
      const response = await getChatMessages(sessionId);
      const fetchedMessages = [...response.messages].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      messages.value = fetchedMessages;
      pendingToolInvocations.value = dedupePendingToolInvocations(
        pendingToolInvocations.value,
        sessionId,
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
    const sessionId = mintSessionId();
    activeSessionId.value = sessionId;
    messages.value = [];
    messagesError.value = null;
    ensureSessionInList(sessionId);
    markSessionUnsaved(sessionId);
    return sessionId;
  }

  function buildCardContextSeed(card: CardRecord): string {
    const blockers = [
      ...(Array.isArray(card.blocks) ? card.blocks.map((id) => `blocks:${id}`) : []),
      ...(Array.isArray(card.depends_on) ? card.depends_on.map((id) => `depends_on:${id}`) : []),
      ...(card.error ? [`error:${card.error}`] : []),
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
    const sessionId = `card-${card.id}`;
    const existingSession = sessions.value.find((session) => session.id === sessionId) ?? null;
    activeSessionId.value = sessionId;
    messages.value = [];
    ensureSessionInList(sessionId, 'card');
    if (!existingSession && !unsavedSessionIds.value.has(sessionId)) {
      syntheticHint.value = { sessionId, content: buildCardContextSeed(card) };
      pendingCardSeed.value = { sessionId, cardId: card.id };
      markSessionUnsaved(sessionId);
    }
    return sessionId;
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
    const sessionId = activeSessionId.value ?? createNewChat();
    ensureSessionInList(sessionId);
    if (!isWritableSession(activeSession.value)) {
      sendError.value = { kind: 'unknown', status: null, message: 'Read-only — switch to analyst to send messages' };
      return;
    }

    sending.value = true;
    sendError.value = null;
    try {
      const hint = consumeSyntheticHint(sessionId);
      const payload = hint ? `${hint}\n\n${content}` : content;
      draft.value = '';
      const response = await sendChatMessage(sessionId, payload);
      markSessionSaved(sessionId);
      const baseTimestamp = nowIso();
      const optimistic = {
        id: String((response.message as { id?: string }).id ?? `${sessionId}-assistant-${Date.now()}`),
        session_id: sessionId,
        role: 'assistant' as const,
        kind: 'text' as const,
        content: String((response.message as { content?: string }).content ?? ''),
        tool: typeof (response.message as { tool?: string }).tool === 'string'
          ? String((response.message as { tool?: string }).tool)
          : undefined,
        timestamp: typeof (response.message as { timestamp?: string }).timestamp === 'string'
          ? String((response.message as { timestamp?: string }).timestamp)
          : baseTimestamp,
        links: Array.isArray((response.message as { links?: unknown[] }).links)
          ? (response.message as { links?: [] }).links
          : undefined,
      } satisfies ChatMessage;
      messages.value = [...messages.value, optimistic];

      if (Array.isArray(response.toolInvocations)) {
        const toolMessages: ChatMessage[] = response.toolInvocations.flatMap((invocation, index) => {
          const messageBaseId = `${sessionId}-tool-${Date.now()}-${index}`;
          const toolCallContent = JSON.stringify({ toolCalls: [{ tool: invocation.tool, params: invocation.params }] });
          const resultContent = JSON.stringify(invocation.result ?? {});
          return [
            {
              id: `${messageBaseId}-call`,
              session_id: sessionId,
              role: 'tool',
              kind: 'tool_call',
              content: toolCallContent,
              tool: invocation.tool,
              timestamp: new Date(Date.now() + index).toISOString(),
            },
            {
              id: `${messageBaseId}-result`,
              session_id: sessionId,
              role: 'tool',
              kind: 'tool_result',
              content: resultContent,
              tool: invocation.tool,
              timestamp: new Date(Date.now() + index + 1).toISOString(),
            },
          ];
        });
        messages.value = [...messages.value, ...toolMessages];
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

  function ingestWsEvent(payload: Record<string, unknown>): void {
    const event = typeof payload.event === 'string' ? payload.event : null;
    const payloadSessionId = typeof payload.session_id === 'string'
      ? payload.session_id
      : typeof payload.sessionId === 'string'
        ? payload.sessionId
        : null;

    if (event === 'analyst_tool_invoked' && payloadSessionId) {
      const tool = normalizeToolName(payload.tool);
      const success = payload.success === true;
      const summary = normalizePendingSummary(payload.summary);
      const classifiedAs = typeof payload.classified_as === 'string' ? payload.classified_as : null;
      const relatedCardId = typeof payload.related_card_id === 'string' ? payload.related_card_id : null;
      pendingToolInvocations.value = pushPendingToolInvocation(pendingToolInvocations.value, {
        sessionId: payloadSessionId,
        tool,
        classifiedAs,
        success,
        summary,
        relatedCardId,
      });
      if (payloadSessionId === activeSessionId.value) {
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
    if (event === 'notification_acknowledged') {
      addBadgeForActiveSession('notification acknowledged', 'notification-ack');
      return;
    }
    if (event === 'control_action_recorded') {
      addBadgeForActiveSession('control action recorded', 'control-action');
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
    unsavedSessionIds,
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
  };
});
