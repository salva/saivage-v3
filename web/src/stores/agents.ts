import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { ActivityStatus, AgentConversationEntry, AgentRole, AgentSession, FreshnessState, SessionStatus } from '../api/types';
import { ApiError, getAgentConversation, getAgentLlmExchange, listAgentSessions } from '../api/client';
import type { ProviderExchangePayload } from '../api/contracts';
import type { ConversationSessionId } from '../api/contracts';
import { createLogger } from '../utils/logger';

const log = createLogger('store:agents');
const STALE_AFTER_MS = 30_000;
const inactiveActivity = (): ActivityStatus => ({ status: 'inactive', pending_calls: [] });
function nowIso(): string { return new Date().toISOString(); }
function isLiveStatus(status: SessionStatus): boolean { return status === 'active' || status === 'waiting'; }
function isAbortError(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError'; }

declare const conversationSelectionBrand: unique symbol;
declare const llmExchangeSelectionBrand: unique symbol;
export type ConversationSelectionToken = object & { readonly [conversationSelectionBrand]: true };
export type LlmExchangeSelectionToken = object & { readonly [llmExchangeSelectionBrand]: true };

export const useAgentStore = defineStore('agents', () => {
  const sessions = ref<AgentSession[]>([]);
  const sessionsLoaded = ref(false);
  const sessionsLoading = ref(false);
  const sessionsRefreshing = ref(false);
  const sessionsError = ref<string | null>(null);
  const sessionsRefreshError = ref<string | null>(null);
  const sessionsUnauthorized = ref(false);
  const lastFetchedAt = ref<string | null>(null);
  const lastWsEventAt = ref<string | null>(null);
  const lastUpdatedBy = ref<FreshnessState['lastUpdatedBy']>('unknown');

  const selectedConversationSessionId = ref<ConversationSessionId | null>(null);
  const currentSession = ref<AgentSession | null>(null);
  const entries = ref<AgentConversationEntry[]>([]);
  const activityStatus = ref<ActivityStatus>(inactiveActivity());
  const conversationWarning = ref<string | null>(null);
  const conversationLoading = ref(false);
  const conversationRefreshing = ref(false);
  const conversationError = ref<string | null>(null);
  const conversationRefreshError = ref<string | null>(null);
  const conversationUnauthorized = ref(false);

  const llmExchangeSessionId = ref<ConversationSessionId | null>(null);
  const currentLlmExchange = ref<ProviderExchangePayload | null>(null);
  const llmExchangeLoaded = ref(false);
  const llmExchangeLoading = ref(false);
  const llmExchangeRefreshing = ref(false);
  const llmExchangeError = ref<string | null>(null);
  const llmExchangeRefreshError = ref<string | null>(null);

  let sessionsRequestSeq = 0;
  let sessionsController: AbortController | null = null;
  let conversationEpoch = 0;
  let conversationController: AbortController | null = null;
  let activeConversationToken: ConversationSelectionToken | null = null;
  const conversationTokenSessions = new WeakMap<ConversationSelectionToken, ConversationSessionId>();
  let llmExchangeEpoch = 0;
  let llmExchangeController: AbortController | null = null;
  let activeLlmExchangeToken: LlmExchangeSelectionToken | null = null;
  const llmExchangeTokenSessions = new WeakMap<LlmExchangeSelectionToken, ConversationSessionId>();

  const isStale = computed(() => {
    const latest = lastWsEventAt.value ?? lastFetchedAt.value;
    return latest ? Date.now() - new Date(latest).getTime() > STALE_AFTER_MS : false;
  });
  const sessionsByRole = computed<Map<AgentRole, AgentSession[]>>(() => {
    const map = new Map<AgentRole, AgentSession[]>();
    for (const session of sessions.value) {
      const list = map.get(session.role) ?? [];
      list.push(session);
      map.set(session.role, list);
    }
    return map;
  });
  const activeSessions = computed(() => sessions.value.filter((session) => isLiveStatus(session.status)));
  const inactiveSessions = computed(() => sessions.value.filter((session) => !isLiveStatus(session.status)));

  function markRestSync(): void { lastFetchedAt.value = nowIso(); lastUpdatedBy.value = 'rest'; }
  function markWsSync(timestamp = nowIso()): void { lastWsEventAt.value = timestamp; lastUpdatedBy.value = 'ws'; }

  async function fetchSessions(): Promise<void> {
    const requestSeq = ++sessionsRequestSeq;
    sessionsController?.abort();
    const controller = new AbortController();
    sessionsController = controller;
    const initial = !sessionsLoaded.value;
    if (initial) sessionsLoading.value = true;
    else sessionsRefreshing.value = true;
    if (initial) sessionsError.value = null;
    else sessionsRefreshError.value = null;
    sessionsUnauthorized.value = false;
    try {
      const response = await listAgentSessions(controller.signal);
      if (requestSeq !== sessionsRequestSeq) return;
      const existing = new Map(sessions.value.map((session) => [session.id, session]));
      sessions.value = response.sessions.map((next) => {
        const current = existing.get(next.id);
        if (!current) return next;
        Object.assign(current, next);
        return current;
      });
      sessionsLoaded.value = true;
      sessionsError.value = null;
      sessionsRefreshError.value = null;
      markRestSync();
    } catch (error) {
      if (requestSeq !== sessionsRequestSeq || isAbortError(error)) return;
      const message = error instanceof ApiError ? error.message : 'Failed to fetch agent sessions';
      if (initial) sessionsError.value = message;
      else sessionsRefreshError.value = message;
      sessionsUnauthorized.value = error instanceof ApiError && error.isUnauthorized;
      log.error('fetchSessions', message);
      throw error;
    } finally {
      if (requestSeq === sessionsRequestSeq) {
        sessionsLoading.value = false;
        sessionsRefreshing.value = false;
      }
    }
  }

  function clearConversationData(): void {
    currentSession.value = null;
    entries.value = [];
    activityStatus.value = inactiveActivity();
    conversationWarning.value = null;
  }

  function beginConversationSelection(sessionId: ConversationSessionId): ConversationSelectionToken {
    conversationController?.abort();
    conversationController = null;
    ++conversationEpoch;
    const changedIdentity = selectedConversationSessionId.value !== sessionId;
    const token = Object.freeze({}) as ConversationSelectionToken;
    conversationTokenSessions.set(token, sessionId);
    activeConversationToken = token;
    selectedConversationSessionId.value = sessionId;
    conversationLoading.value = false;
    conversationRefreshing.value = false;
    conversationUnauthorized.value = false;
    if (changedIdentity) {
      clearConversationData();
      conversationError.value = null;
      conversationRefreshError.value = null;
    }
    return token;
  }

  function conversationRequestIsCurrent(token: ConversationSelectionToken, epoch: number, sessionId: ConversationSessionId): boolean {
    return activeConversationToken === token
      && conversationEpoch === epoch
      && selectedConversationSessionId.value === sessionId;
  }

  async function fetchConversation(token: ConversationSelectionToken): Promise<void> {
    if (activeConversationToken !== token) return;
    const sessionId = conversationTokenSessions.get(token);
    if (sessionId === undefined) return;
    conversationController?.abort();
    const controller = new AbortController();
    conversationController = controller;
    const epoch = ++conversationEpoch;
    const refreshing = currentSession.value?.id === sessionId;
    if (refreshing) conversationRefreshing.value = true;
    else conversationLoading.value = true;
    if (refreshing) conversationRefreshError.value = null;
    else conversationError.value = null;
    conversationUnauthorized.value = false;
    try {
      const response = await getAgentConversation(sessionId, controller.signal);
      if (!conversationRequestIsCurrent(token, epoch, sessionId)) return;
      if (response.session.id !== sessionId) {
        throw new Error(`Conversation response session ${response.session.id} does not match selected session ${sessionId}`);
      }
      if (currentSession.value?.id === response.session.id) Object.assign(currentSession.value, response.session);
      else currentSession.value = response.session;
      entries.value = response.entries;
      activityStatus.value = response.activity_status;
      if (response.entries.length === 0) conversationWarning.value = 'No recorded conversation entries were returned for this session.';
      else if (response.entries.some((entry) => entry.kind === 'model_issue')) conversationWarning.value = 'Conversation includes model/tool recovery events; inspect for incomplete or repaired output.';
      else conversationWarning.value = null;
      conversationError.value = null;
      conversationRefreshError.value = null;
    } catch (error) {
      if (!conversationRequestIsCurrent(token, epoch, sessionId) || isAbortError(error)) return;
      const message = error instanceof Error ? error.message : 'Failed to fetch agent conversation';
      if (refreshing) conversationRefreshError.value = message;
      else conversationError.value = message;
      conversationUnauthorized.value = error instanceof ApiError && error.isUnauthorized;
      log.error('fetchConversation', message);
      throw error;
    } finally {
      if (conversationRequestIsCurrent(token, epoch, sessionId)) {
        conversationLoading.value = false;
        conversationRefreshing.value = false;
      }
    }
  }

  async function refetchConversation(token: ConversationSelectionToken): Promise<void> {
    if (activeConversationToken === token) await fetchConversation(token);
  }

  function clearConversationSelection(token: ConversationSelectionToken): void {
    if (activeConversationToken !== token) return;
    conversationController?.abort();
    conversationController = null;
    ++conversationEpoch;
    activeConversationToken = null;
    selectedConversationSessionId.value = null;
    clearConversationData();
    conversationLoading.value = false;
    conversationRefreshing.value = false;
    conversationError.value = null;
    conversationRefreshError.value = null;
    conversationUnauthorized.value = false;
  }

  function clearLlmExchangeData(): void {
    currentLlmExchange.value = null;
    llmExchangeLoaded.value = false;
  }

  function beginLlmExchangeSelection(sessionId: ConversationSessionId): LlmExchangeSelectionToken {
    llmExchangeController?.abort();
    llmExchangeController = null;
    ++llmExchangeEpoch;
    const changedIdentity = llmExchangeSessionId.value !== sessionId;
    const token = Object.freeze({}) as LlmExchangeSelectionToken;
    llmExchangeTokenSessions.set(token, sessionId);
    activeLlmExchangeToken = token;
    llmExchangeSessionId.value = sessionId;
    llmExchangeLoading.value = false;
    llmExchangeRefreshing.value = false;
    if (changedIdentity) {
      clearLlmExchangeData();
      llmExchangeError.value = null;
      llmExchangeRefreshError.value = null;
    }
    return token;
  }

  function llmExchangeRequestIsCurrent(token: LlmExchangeSelectionToken, epoch: number, sessionId: ConversationSessionId): boolean {
    return activeLlmExchangeToken === token
      && llmExchangeEpoch === epoch
      && llmExchangeSessionId.value === sessionId;
  }

  async function fetchLlmExchange(token: LlmExchangeSelectionToken): Promise<void> {
    if (activeLlmExchangeToken !== token) return;
    const sessionId = llmExchangeTokenSessions.get(token);
    if (sessionId === undefined) return;
    llmExchangeController?.abort();
    const controller = new AbortController();
    llmExchangeController = controller;
    const epoch = ++llmExchangeEpoch;
    const refreshing = llmExchangeLoaded.value;
    if (refreshing) llmExchangeRefreshing.value = true;
    else llmExchangeLoading.value = true;
    if (refreshing) llmExchangeRefreshError.value = null;
    else llmExchangeError.value = null;
    try {
      const response = await getAgentLlmExchange(sessionId, controller.signal);
      if (!llmExchangeRequestIsCurrent(token, epoch, sessionId)) return;
      if (response.sessionId !== sessionId) throw new Error(`LLM exchange response session ${response.sessionId} does not match selected session ${sessionId}`);
      currentLlmExchange.value = response.exchange;
      llmExchangeLoaded.value = true;
      llmExchangeError.value = null;
      llmExchangeRefreshError.value = null;
    } catch (error) {
      if (!llmExchangeRequestIsCurrent(token, epoch, sessionId) || isAbortError(error)) return;
      if (error instanceof ApiError && error.isNotFound) {
        currentLlmExchange.value = null;
        llmExchangeLoaded.value = true;
        llmExchangeError.value = null;
        llmExchangeRefreshError.value = null;
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (refreshing) llmExchangeRefreshError.value = message;
      else {
        currentLlmExchange.value = null;
        llmExchangeLoaded.value = false;
        llmExchangeError.value = message;
      }
      log.error('fetchLlmExchange', message);
    } finally {
      if (llmExchangeRequestIsCurrent(token, epoch, sessionId)) {
        llmExchangeLoading.value = false;
        llmExchangeRefreshing.value = false;
      }
    }
  }

  function clearLlmExchange(token: LlmExchangeSelectionToken): void {
    if (activeLlmExchangeToken !== token) return;
    llmExchangeController?.abort();
    llmExchangeController = null;
    ++llmExchangeEpoch;
    activeLlmExchangeToken = null;
    llmExchangeSessionId.value = null;
    clearLlmExchangeData();
    llmExchangeLoading.value = false;
    llmExchangeRefreshing.value = false;
    llmExchangeError.value = null;
    llmExchangeRefreshError.value = null;
  }

  async function refetch(): Promise<void> {
    const token = activeConversationToken;
    await Promise.all([
      fetchSessions(),
      token ? refetchConversation(token) : Promise.resolve(),
    ]);
  }

  return {
    sessions,
    sessionsLoaded,
    sessionsLoading,
    sessionsRefreshing,
    sessionsError,
    sessionsRefreshError,
    sessionsUnauthorized,
    lastFetchedAt,
    lastWsEventAt,
    lastUpdatedBy,
    selectedConversationSessionId,
    currentSession,
    entries,
    activityStatus,
    conversationWarning,
    conversationLoading,
    conversationRefreshing,
    conversationError,
    conversationRefreshError,
    conversationUnauthorized,
    llmExchangeSessionId,
    currentLlmExchange,
    llmExchangeLoaded,
    llmExchangeLoading,
    llmExchangeRefreshing,
    llmExchangeError,
    llmExchangeRefreshError,
    sessionsByRole,
    activeSessions,
    inactiveSessions,
    isStale,
    fetchSessions,
    beginConversationSelection,
    fetchConversation,
    refetchConversation,
    clearConversationSelection,
    beginLlmExchangeSelection,
    fetchLlmExchange,
    clearLlmExchange,
    refetch,
    markWsSync,
  };
});
