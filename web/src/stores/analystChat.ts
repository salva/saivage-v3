import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import type { CardRecord, ChatMessage, ChatSession, DetailErrorState } from '../api/types';
import {
  ApiError,
  getChatMessages,
  listChatSessions,
  sendChatMessage,
} from '../api/client';

const DRAWER_STORAGE_KEY = 'analyst-chat:drawer-state';
const DEFAULT_DRAWER_WIDTH = 420;

interface DrawerState {
  open: boolean;
  width: number;
}

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

function parseStoredDrawerState(): DrawerState {
  if (typeof window === 'undefined') {
    return { open: false, width: DEFAULT_DRAWER_WIDTH };
  }
  try {
    const raw = window.localStorage.getItem(DRAWER_STORAGE_KEY);
    if (!raw) {
      return { open: false, width: DEFAULT_DRAWER_WIDTH };
    }
    const parsed = JSON.parse(raw) as Partial<DrawerState>;
    return {
      open: parsed.open === true,
      width: typeof parsed.width === 'number' && Number.isFinite(parsed.width)
        ? Math.min(720, Math.max(320, parsed.width))
        : DEFAULT_DRAWER_WIDTH,
    };
  } catch {
    return { open: false, width: DEFAULT_DRAWER_WIDTH };
  }
}

function persistDrawerState(open: boolean, width: number): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(DRAWER_STORAGE_KEY, JSON.stringify({ open, width }));
}

function mintSessionId(): string {
  return `chat-${Date.now()}`;
}

export const useAnalystChat = defineStore('analyst-chat', () => {
  const storedDrawer = parseStoredDrawerState();

  const sessions = ref<ChatSession[]>([]);
  const activeSessionId = ref<string | null>(null);
  const messages = ref<ChatMessage[]>([]);
  const draft = ref('');
  const drawerOpen = ref(storedDrawer.open);
  const drawerWidth = ref(storedDrawer.width);
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

  watch([drawerOpen, drawerWidth], ([open, width]) => {
    persistDrawerState(open, width);
  }, { immediate: true });

  function ensureSessionInList(sessionId: string): void {
    if (sessions.value.some((session) => session.id === sessionId)) {
      return;
    }
    sessions.value = [{
      id: sessionId,
      role: 'analyst',
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

  function setDrawerOpen(open: boolean): void {
    drawerOpen.value = open;
  }

  function toggleDrawer(): void {
    drawerOpen.value = !drawerOpen.value;
  }

  function setDrawerWidth(width: number): void {
    drawerWidth.value = Math.min(720, Math.max(320, width));
  }

  function setDraft(value: string): void {
    draft.value = value;
  }

  async function fetchSessions(): Promise<void> {
    sessionsLoading.value = true;
    sessionsError.value = null;
    try {
      const response = await listChatSessions();
      sessions.value = response.sessions;
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
      messages.value = [...response.messages].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      pendingToolInvocations.value = pendingToolInvocations.value.filter((item) => item.sessionId !== sessionId);
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

  function seedCardContext(card: CardRecord): string {
    const sessionId = `card-${card.id}-${Date.now()}`;
    const hint = `Operator opened analyst from card ${card.id} '${card.title}'. Current version_seq=${card.version_seq ?? 'unknown'}, status=${card.status}. Treat the card as the default subject of this conversation.`;
    syntheticHint.value = { sessionId, content: hint };
    pendingCardSeed.value = { sessionId, cardId: card.id };
    activeSessionId.value = sessionId;
    messages.value = [];
    ensureSessionInList(sessionId);
    markSessionUnsaved(sessionId);
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
      const tool = typeof payload.tool === 'string' ? payload.tool : 'tool';
      const success = payload.success === true;
      const summary = typeof payload.summary === 'string' ? payload.summary : 'tool invoked';
      const classifiedAs = typeof payload.classified_as === 'string' ? payload.classified_as : null;
      const relatedCardId = typeof payload.related_card_id === 'string' ? payload.related_card_id : null;
      const next = pendingToolInvocations.value.filter((item) => !(item.sessionId === payloadSessionId && item.tool === tool && item.summary === summary));
      next.push({
        id: `${payloadSessionId}-${tool}-${Date.now()}`,
        sessionId: payloadSessionId,
        tool,
        classifiedAs,
        success,
        summary,
        relatedCardId,
      });
      pendingToolInvocations.value = next.slice(-12);
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
    drawerOpen,
    drawerWidth,
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
    setDrawerOpen,
    toggleDrawer,
    setDrawerWidth,
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
