import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { AgentConversationEntry, AgentSession, FreshnessState } from '../api/types';
import {
  ApiError,
  getAgentConversation,
  getAgentLlmExchange,
  getAgentSession,
  getCardAgentSessions,
  listAgentSessions,
} from '../api/client';
import type { ConversationSessionId, ProviderExchangePayload } from '../api/contracts';
import type { LeaseInvalidation } from '../sync/client';

const abortError = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
declare const conversationBrand: unique symbol;
declare const exchangeBrand: unique symbol;
export type ConversationSelectionToken = object & { readonly [conversationBrand]: true };
export type LlmExchangeSelectionToken = object & { readonly [exchangeBrand]: true };

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
  const partitions = new Map<string, AgentSession[]>();
  let sessionsController: AbortController | null = null;
  let sessionsGeneration = 0;
  const membershipControllers = new Map<string, AbortController>();
  const membershipGenerations = new Map<string, number>();
  const selectedConversationSessionId = ref<ConversationSessionId | null>(null);
  const currentSession = ref<AgentSession | null>(null);
  const entries = ref<AgentConversationEntry[]>([]);
  const conversationWarning = ref<string | null>(null);
  const conversationLoading = ref(false);
  const conversationRefreshing = ref(false);
  const conversationError = ref<string | null>(null);
  const conversationRefreshError = ref<string | null>(null);
  const conversationUnauthorized = ref(false);
  let conversationController: AbortController | null = null;
  let conversationGeneration = 0;
  let conversationCursor: string | null = null;
  let activeConversationToken: ConversationSelectionToken | null = null;
  const conversationIds = new WeakMap<object, ConversationSessionId>();
  const llmExchangeSessionId = ref<ConversationSessionId | null>(null);
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
  const isStale = computed(() => false);
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
      lastFetchedAt.value = new Date().toISOString();
      return true;
    } catch (error) {
      if (generation !== sessionsGeneration || abortError(error)) return false;
      const message = error instanceof Error ? error.message : 'Failed to fetch agent sessions';
      sessionsLoaded.value
        ? (sessionsRefreshError.value = message)
        : (sessionsError.value = message);
      sessionsUnauthorized.value = error instanceof ApiError && error.isUnauthorized;
      throw error;
    } finally {
      if (generation === sessionsGeneration) {
        sessionsLoading.value = false;
        sessionsRefreshing.value = false;
      }
    }
  }
  async function reconcileMembership(frame: LeaseInvalidation): Promise<void> {
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
          if (error instanceof ApiError && error.isNotFound) partitions.delete(frame.card_id);
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
  function releaseSessions() {
    ++sessionsGeneration;
    sessionsController?.abort();
    sessionsController = null;
    abortMembershipRequests();
    sessionsLoaded.value = false;
    partitions.clear();
    sessions.value = [];
  }
  function markWsSync(timestamp = new Date().toISOString()) {
    lastWsEventAt.value = timestamp;
    lastUpdatedBy.value = 'ws';
  }

  function beginConversationSelection(id: ConversationSessionId): ConversationSelectionToken {
    ++conversationGeneration;
    conversationController?.abort();
    const token = Object.freeze({}) as ConversationSelectionToken;
    conversationIds.set(token, id);
    activeConversationToken = token;
    selectedConversationSessionId.value = id;
    currentSession.value = null;
    entries.value = [];
    conversationCursor = null;
    conversationError.value = null;
    return token;
  }
  async function fetchConversation(token: ConversationSelectionToken): Promise<void> {
    if (token !== activeConversationToken) return;
    const id = conversationIds.get(token)!;
    const generation = ++conversationGeneration;
    conversationController?.abort();
    const controller = new AbortController();
    conversationController = controller;
    conversationCursor ? (conversationRefreshing.value = true) : (conversationLoading.value = true);
    try {
      const [detail, response] = await Promise.all([
        getAgentSession(id, controller.signal),
        getAgentConversation(id, controller.signal, conversationCursor ?? undefined),
      ]);
      if (token !== activeConversationToken || generation !== conversationGeneration) return;
      currentSession.value = detail.session;
      if (conversationCursor === null) entries.value = response.entries;
      else entries.value = [...entries.value, ...response.entries];
      conversationCursor = response.cursor;
      conversationWarning.value = entries.value.some((entry) => entry.kind === 'model_issue')
        ? 'Conversation includes model/tool recovery events; inspect for incomplete or repaired output.'
        : null;
      conversationError.value = null;
      conversationRefreshError.value = null;
    } catch (error) {
      if (
        token !== activeConversationToken ||
        generation !== conversationGeneration ||
        abortError(error)
      )
        return;
      const message = error instanceof Error ? error.message : String(error);
      conversationCursor
        ? (conversationRefreshError.value = message)
        : (conversationError.value = message);
      conversationUnauthorized.value = error instanceof ApiError && error.isUnauthorized;
      throw error;
    } finally {
      if (token === activeConversationToken && generation === conversationGeneration) {
        conversationLoading.value = false;
        conversationRefreshing.value = false;
      }
    }
  }
  const refetchConversation = fetchConversation;
  function clearConversationSelection(token: ConversationSelectionToken) {
    if (token !== activeConversationToken) return;
    ++conversationGeneration;
    conversationController?.abort();
    activeConversationToken = null;
    selectedConversationSessionId.value = null;
    currentSession.value = null;
    entries.value = [];
    conversationCursor = null;
  }

  function beginLlmExchangeSelection(id: ConversationSessionId): LlmExchangeSelectionToken {
    ++exchangeGeneration;
    exchangeController?.abort();
    const token = Object.freeze({}) as LlmExchangeSelectionToken;
    exchangeIds.set(token, id);
    activeExchangeToken = token;
    llmExchangeSessionId.value = id;
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
      if (
        error instanceof ApiError &&
        error.isNotFound &&
        error.body['error'] === 'No LLM exchange recorded for this session yet.'
      ) {
        currentLlmExchange.value = null;
        llmExchangeLoaded.value = true;
        return;
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
    llmExchangeSessionId.value = null;
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
    lastFetchedAt,
    lastWsEventAt,
    lastUpdatedBy,
    sessionsByRole,
    isStale,
    fetchSessions,
    reconcileMembership,
    releaseSessions,
    markWsSync,
    selectedConversationSessionId,
    currentSession,
    entries,
    conversationWarning,
    conversationLoading,
    conversationRefreshing,
    conversationError,
    conversationRefreshError,
    conversationUnauthorized,
    beginConversationSelection,
    fetchConversation,
    refetchConversation,
    clearConversationSelection,
    llmExchangeSessionId,
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
