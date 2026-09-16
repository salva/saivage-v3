import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { AgentConversationResponse, AgentConversationVersionListResponse, AgentConversationVersionResponse, AgentSession } from '../api/types';
import {
  OperatorApiError,
  getAgentConversation,
  getAgentLlmExchange,
  getAgentSession,
  getCardAgentSessions,
  getAgentConversationVersion,
  isOperatorApiError,
  listAgentSessions,
  listAgentConversationVersions,
} from '../api/client';
import type { ConversationSessionId, ProviderExchangePayload } from '../api/contracts';
import type { LeaseInvalidation } from '../sync/client';
import { createConversationFetch } from './conversation-fetch';

const abortError = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
declare const conversationBrand: unique symbol;
declare const exchangeBrand: unique symbol;
type ConversationSelectionToken = object & { readonly [conversationBrand]: true };
type LlmExchangeSelectionToken = object & { readonly [exchangeBrand]: true };

export const useAgentStore = defineStore('agents', () => {
  const sessions = ref<AgentSession[]>([]);
  const sessionsLoaded = ref(false);
  const sessionsLoading = ref(false);
  const sessionsRefreshing = ref(false);
  const sessionsError = ref<string | null>(null);
  const sessionsRefreshError = ref<string | null>(null);
  const sessionsUnauthorized = ref(false);
  const partitions = new Map<string, AgentSession[]>();
  let sessionsController: AbortController | null = null;
  let sessionsGeneration = 0;
  const membershipControllers = new Map<string, AbortController>();
  const membershipGenerations = new Map<string, number>();
  const selectedConversationSessionId = ref<ConversationSessionId | null>(null);
  const currentSession = ref<AgentSession | null>(null);
  const sessionSummaryLoading = ref(false);
  const sessionSummaryRefreshing = ref(false);
  const sessionSummaryError = ref<string | null>(null);
  const sessionSummaryRefreshError = ref<string | null>(null);
  const sessionSummaryUnauthorized = ref(false);
  const conversationWarning = ref<string | null>(null);
  const conversationUnauthorized = ref(false);
  const conversationSegmentContext = ref<AgentConversationResponse['segment_context']>(null);
  const conversationVersions = ref<AgentConversationVersionListResponse['versions']>([]);
  const conversationVersionsLoading = ref(false);
  const conversationVersionsError = ref<string | null>(null);
  const selectedConversationVersion = ref<AgentConversationVersionResponse | null>(null);
  const selectedConversationVersionLoading = ref(false);
  const selectedConversationVersionError = ref<string | null>(null);
  let activeConversationToken: ConversationSelectionToken | null = null;
  const conversationIds = new WeakMap<object, ConversationSessionId>();
  let sessionSummaryController: AbortController | null = null;
  let sessionSummaryFlight: Promise<void> | null = null;
  let sessionSummaryRefreshRequested = false;
  const conversation = createConversationFetch<null, string>({
    isOwnerCurrent: () => activeConversationToken !== null,
    async request(signal, requestCursor) {
      const token = activeConversationToken;
      if (!token) throw new Error('Conversation request has no current selection owner.');
      const id = conversationIds.get(token);
      if (!id) throw new Error('Conversation selection owner has no session identity.');
      const response = await getAgentConversation(
          id,
          signal,
          requestCursor?.message_id
            ? { segmentVersion: requestCursor.segment_version, messageId: requestCursor.message_id }
            : undefined,
        );
      return { response, metadata: null };
    },
    projectError: (error) => error instanceof Error ? error.message : String(error),
    onFailure(error) {
      conversationUnauthorized.value = error instanceof OperatorApiError && error.isUnauthorized;
    },
    onAccepted({ acceptedEntries, response }) {
      conversationSegmentContext.value = response.segment_context;
      conversationWarning.value = acceptedEntries.some((entry) => entry.kind === 'model_issue')
        ? 'Conversation includes model/tool recovery events; inspect for incomplete or repaired output.'
        : null;
      conversationUnauthorized.value = false;
    },
  });
  const entries = conversation.entries;
  const conversationBaselineAccepted = conversation.baselineAccepted;
  const conversationLoading = conversation.coldLoading;
  const conversationRefreshing = conversation.refreshing;
  const conversationError = conversation.initialError;
  const conversationRefreshError = conversation.refreshError;
  const currentLlmExchange = ref<ProviderExchangePayload | null>(null);
  const llmExchangeLoaded = ref(false);
  const llmExchangeLoading = ref(false);
  const llmExchangeRefreshing = ref(false);
  const llmExchangeError = ref<string | null>(null);
  const llmExchangeRefreshError = ref<string | null>(null);
  let exchangeController: AbortController | null = null;
  let exchangeGeneration = 0;
  let activeExchangeToken: LlmExchangeSelectionToken | null = null;
  const exchangeIds = new WeakMap<object, ConversationSessionId>();

  const sessionsByRole = computed(() => {
    const map = new Map<string, AgentSession[]>();
    for (const session of sessions.value) {
      const values = map.get(session.agent_name) ?? [];
      values.push(session);
      map.set(session.agent_name, values);
    }
    return map;
  });
  function publishPartitions() {
    const seen = new Set<string>();
    const merged = [...partitions.values()].flat();
    for (const session of merged) {
      if (seen.has(session.id))
        throw new Error(`Agent session '${session.id}' occurs in multiple partitions.`);
      seen.add(session.id);
      const key = session.card_id ?? 'global';
      if (!partitions.get(key)?.some((candidate) => candidate.id === session.id))
        throw new Error('Agent partition identity mismatch.');
    }
    sessions.value = merged.sort((a, b) => a.id.localeCompare(b.id));
  }
  function acceptBaseline(values: AgentSession[]) {
    const next = new Map<string, AgentSession[]>();
    for (const session of values) {
      const key = session.card_id ?? 'global';
      next.set(key, [...(next.get(key) ?? []), session]);
    }
    partitions.clear();
    for (const [key, value] of next) partitions.set(key, value);
    publishPartitions();
  }
  function abortMembershipRequests() {
    for (const controller of membershipControllers.values()) controller.abort();
    membershipControllers.clear();
    membershipGenerations.clear();
  }
  async function fetchSessions(): Promise<boolean> {
    const generation = ++sessionsGeneration;
    sessionsController?.abort();
    abortMembershipRequests();
    const controller = new AbortController();
    sessionsController = controller;
    sessionsLoaded.value ? (sessionsRefreshing.value = true) : (sessionsLoading.value = true);
    try {
      const response = await listAgentSessions(controller.signal);
      if (generation !== sessionsGeneration) return false;
      acceptBaseline(response.sessions);
      sessionsLoaded.value = true;
      sessionsError.value = null;
      sessionsRefreshError.value = null;
      return true;
    } catch (error) {
      if (generation !== sessionsGeneration || abortError(error)) return false;
      const message = error instanceof Error ? error.message : 'Failed to fetch agent sessions';
      sessionsLoaded.value
        ? (sessionsRefreshError.value = message)
        : (sessionsError.value = message);
      sessionsUnauthorized.value = error instanceof OperatorApiError && error.isUnauthorized;
      throw error;
    } finally {
      if (generation === sessionsGeneration) {
        sessionsLoading.value = false;
        sessionsRefreshing.value = false;
      }
    }
  }
  async function reconcileMembership(frame: LeaseInvalidation): Promise<void> {
    void selectedSummaryHint(frame);
    if (!frame || frame.resource !== 'agent-membership') return void (await fetchSessions());
    const key = frame.scope === 'card' ? frame.card_id : 'global';
    const baselineGeneration = sessionsGeneration;
    const requestGeneration = (membershipGenerations.get(key) ?? 0) + 1;
    membershipGenerations.set(key, requestGeneration);
    membershipControllers.get(key)?.abort();
    const controller = new AbortController();
    membershipControllers.set(key, controller);
    try {
      if (frame.scope === 'card') {
        try {
          const response = await getCardAgentSessions(frame.card_id, controller.signal);
          if (
            baselineGeneration !== sessionsGeneration ||
            membershipGenerations.get(key) !== requestGeneration
          )
            return;
          partitions.set(frame.card_id, response.sessions);
        } catch (error) {
          if (
            abortError(error) ||
            baselineGeneration !== sessionsGeneration ||
            membershipGenerations.get(key) !== requestGeneration
          )
            return;
          if (error instanceof OperatorApiError && error.isNotFound) partitions.delete(frame.card_id);
          else throw error;
        }
      } else {
        const response = await getAgentSession(frame.session_id, controller.signal);
        if (
          baselineGeneration !== sessionsGeneration ||
          membershipGenerations.get(key) !== requestGeneration
        )
          return;
        partitions.set('global', [response.session]);
      }
      publishPartitions();
    } finally {
      if (membershipGenerations.get(key) === requestGeneration) membershipControllers.delete(key);
    }
  }
  function selectedSummaryHint(frame: LeaseInvalidation): Promise<void> {
    const token = activeConversationToken;
    if (!token || (frame !== null && frame.resource !== 'agent-membership')) return Promise.resolve();
    const selectedId = conversationIds.get(token);
    if (!selectedId) throw new Error('Conversation selection owner has no session identity.');
    const known = currentSession.value;
    const relevant = frame === null || (frame.scope === 'global-session'
      ? frame.session_id === selectedId
      : known === null || (known.session_scope === 'card' && known.card_id === frame.card_id));
    return relevant ? fetchSelectedSession(token) : Promise.resolve();
  }
  function releaseSessions() {
    ++sessionsGeneration;
    sessionsController?.abort();
    sessionsController = null;
    abortMembershipRequests();
    sessionsLoaded.value = false;
    partitions.clear();
    sessions.value = [];
  }
  function beginConversationSelection(id: ConversationSessionId): ConversationSelectionToken {
    conversation.reset();
    const token = Object.freeze({}) as ConversationSelectionToken;
    conversationIds.set(token, id);
    activeConversationToken = token;
    selectedConversationSessionId.value = id;
    currentSession.value = null;
    sessionSummaryController?.abort();
    sessionSummaryController = null;
    sessionSummaryFlight = null;
    sessionSummaryRefreshRequested = false;
    sessionSummaryLoading.value = false;
    sessionSummaryRefreshing.value = false;
    sessionSummaryError.value = null;
    sessionSummaryRefreshError.value = null;
    sessionSummaryUnauthorized.value = false;
    conversationWarning.value = null;
    conversationUnauthorized.value = false;
    conversationSegmentContext.value = null;
    conversationVersions.value = [];
    conversationVersionsLoading.value = false;
    conversationVersionsError.value = null;
    selectedConversationVersion.value = null;
    selectedConversationVersionLoading.value = false;
    selectedConversationVersionError.value = null;
    return token;
  }
  async function fetchConversation(token: ConversationSelectionToken, frame?: { segment_version: number; visible_message_id: string | null } | null): Promise<void> {
    if (token !== activeConversationToken) return;
    if (frame) await conversation.onFrame(frame);
    else await conversation.fetch();
  }
  function fetchSelectedSession(token: ConversationSelectionToken): Promise<void> {
    if (token !== activeConversationToken) return Promise.resolve();
    if (sessionSummaryFlight) {
      sessionSummaryRefreshRequested = true;
      return sessionSummaryFlight;
    }
    const run = async () => {
      do {
        sessionSummaryRefreshRequested = false;
        if (token !== activeConversationToken) return;
        const id = conversationIds.get(token);
        if (!id) throw new Error('Conversation selection owner has no session identity.');
        const controller = new AbortController();
        sessionSummaryController = controller;
        currentSession.value ? (sessionSummaryRefreshing.value = true) : (sessionSummaryLoading.value = true);
        try {
          const response = await getAgentSession(id, controller.signal);
          if (token !== activeConversationToken) return;
          currentSession.value = response.session;
          sessionSummaryError.value = null;
          sessionSummaryRefreshError.value = null;
          sessionSummaryUnauthorized.value = false;
        } catch (error) {
          if (token !== activeConversationToken || abortError(error)) return;
          const message = error instanceof Error ? error.message : String(error);
          currentSession.value ? (sessionSummaryRefreshError.value = message) : (sessionSummaryError.value = message);
          sessionSummaryUnauthorized.value = error instanceof OperatorApiError && error.isUnauthorized;
        } finally {
          if (token === activeConversationToken) {
            sessionSummaryLoading.value = false;
            sessionSummaryRefreshing.value = false;
            if (sessionSummaryController === controller) sessionSummaryController = null;
          }
        }
      } while (token === activeConversationToken && sessionSummaryRefreshRequested);
    };
    let flight!: Promise<void>;
    flight = run().finally(() => {
      if (token === activeConversationToken && sessionSummaryFlight === flight) sessionSummaryFlight = null;
    });
    sessionSummaryFlight = flight;
    return flight;
  }
  const refetchConversation = fetchConversation;
  async function fetchConversationVersions(token: ConversationSelectionToken): Promise<void> {
    if (token !== activeConversationToken) return;
    const id = conversationIds.get(token)!;
    conversationVersionsLoading.value = true;
    try {
      const response = await listAgentConversationVersions(id);
      if (token !== activeConversationToken) return;
      conversationVersions.value = response.versions;
      conversationVersionsError.value = null;
    } catch (error) {
      if (token !== activeConversationToken) return;
      conversationVersionsError.value = error instanceof Error ? error.message : String(error);
    } finally { if (token === activeConversationToken) conversationVersionsLoading.value = false; }
  }
  async function selectConversationVersion(token: ConversationSelectionToken, version: number): Promise<void> {
    if (token !== activeConversationToken) return;
    const id = conversationIds.get(token)!;
    if (conversation.cursor.value?.segment_version === version) {
      selectedConversationVersion.value = null;
      selectedConversationVersionError.value = null;
      return;
    }
    selectedConversationVersionLoading.value = true;
    try {
      const response = await getAgentConversationVersion(id, version);
      if (token !== activeConversationToken) return;
      selectedConversationVersion.value = response;
      selectedConversationVersionError.value = null;
    } catch (error) {
      if (token !== activeConversationToken) return;
      selectedConversationVersion.value = null;
      selectedConversationVersionError.value = error instanceof Error ? error.message : String(error);
    } finally { if (token === activeConversationToken) selectedConversationVersionLoading.value = false; }
  }
  function clearConversationSelection(token: ConversationSelectionToken) {
    if (token !== activeConversationToken) return;
    conversation.reset();
    sessionSummaryController?.abort();
    sessionSummaryController = null;
    sessionSummaryFlight = null;
    sessionSummaryRefreshRequested = false;
    activeConversationToken = null;
    selectedConversationSessionId.value = null;
    currentSession.value = null;
    sessionSummaryLoading.value = false;
    sessionSummaryRefreshing.value = false;
    sessionSummaryError.value = null;
    sessionSummaryRefreshError.value = null;
    sessionSummaryUnauthorized.value = false;
    conversationWarning.value = null;
    conversationUnauthorized.value = false;
    conversationError.value = null;
    conversationRefreshError.value = null;
    conversationSegmentContext.value = null;
    conversationVersions.value = [];
    conversationVersionsLoading.value = false;
    conversationVersionsError.value = null;
    selectedConversationVersion.value = null;
    selectedConversationVersionLoading.value = false;
    selectedConversationVersionError.value = null;
  }

  function beginLlmExchangeSelection(id: ConversationSessionId): LlmExchangeSelectionToken {
    ++exchangeGeneration;
    exchangeController?.abort();
    const token = Object.freeze({}) as LlmExchangeSelectionToken;
    exchangeIds.set(token, id);
    activeExchangeToken = token;
    currentLlmExchange.value = null;
    llmExchangeLoaded.value = false;
    llmExchangeError.value = null;
    return token;
  }
  async function fetchLlmExchange(token: LlmExchangeSelectionToken): Promise<void> {
    if (token !== activeExchangeToken) return;
    const id = exchangeIds.get(token)!;
    const generation = ++exchangeGeneration;
    exchangeController?.abort();
    const controller = new AbortController();
    exchangeController = controller;
    llmExchangeLoaded.value
      ? (llmExchangeRefreshing.value = true)
      : (llmExchangeLoading.value = true);
    try {
      const response = await getAgentLlmExchange(id, controller.signal);
      if (token !== activeExchangeToken || generation !== exchangeGeneration) return;
      currentLlmExchange.value = response.exchange;
      llmExchangeLoaded.value = true;
      llmExchangeError.value = null;
      llmExchangeRefreshError.value = null;
    } catch (error) {
      if (token !== activeExchangeToken || generation !== exchangeGeneration || abortError(error))
        return;
      if (isOperatorApiError(error, 'agents.llmExchange', 404)) {
        if (error.data.error === 'No LLM exchange recorded for this session yet.') {
          currentLlmExchange.value = null;
          llmExchangeLoaded.value = true;
          llmExchangeError.value = null;
          llmExchangeRefreshError.value = null;
          return;
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      llmExchangeLoaded.value
        ? (llmExchangeRefreshError.value = message)
        : (llmExchangeError.value = message);
    } finally {
      if (token === activeExchangeToken && generation === exchangeGeneration) {
        llmExchangeLoading.value = false;
        llmExchangeRefreshing.value = false;
      }
    }
  }
  function clearLlmExchange(token: LlmExchangeSelectionToken) {
    if (token !== activeExchangeToken) return;
    ++exchangeGeneration;
    exchangeController?.abort();
    activeExchangeToken = null;
    currentLlmExchange.value = null;
    llmExchangeLoaded.value = false;
  }

  return {
    sessions,
    sessionsLoaded,
    sessionsLoading,
    sessionsRefreshing,
    sessionsError,
    sessionsRefreshError,
    sessionsUnauthorized,
    sessionsByRole,
    fetchSessions,
    reconcileMembership,
    releaseSessions,
    selectedConversationSessionId,
    currentSession,
    sessionSummaryLoading,
    sessionSummaryRefreshing,
    sessionSummaryError,
    sessionSummaryRefreshError,
    sessionSummaryUnauthorized,
    entries,
    conversationWarning,
    conversationBaselineAccepted,
    conversationLoading,
    conversationRefreshing,
    conversationError,
    conversationRefreshError,
    conversationUnauthorized,
    conversationSegmentContext,
    conversationVersions,
    conversationVersionsLoading,
    conversationVersionsError,
    selectedConversationVersion,
    selectedConversationVersionLoading,
    selectedConversationVersionError,
    beginConversationSelection,
    fetchConversation,
    fetchSelectedSession,
    selectedSummaryHint,
    refetchConversation,
    fetchConversationVersions,
    selectConversationVersion,
    clearConversationSelection,
    currentLlmExchange,
    llmExchangeLoaded,
    llmExchangeLoading,
    llmExchangeRefreshing,
    llmExchangeError,
    llmExchangeRefreshError,
    beginLlmExchangeSelection,
    fetchLlmExchange,
    clearLlmExchange,
  };
});
