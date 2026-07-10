import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { AgentConversationEntry, AgentRole, AgentSession, ActivityStatus, FreshnessState, SessionStatus } from '../api/types';
import { listAgentSessions, getAgentConversation, getAgentLlmExchange, ApiError } from '../api/client';
import type { ProviderExchangePayload } from '../api/contracts';
import { createLogger } from '../utils/logger';

const log = createLogger('store:agents');
const STALE_AFTER_MS = 30_000;
let conversationRequestSeq = 0;
const idleActivity = (): ActivityStatus => ({ status: 'idle', pending_calls: [], updated_at: new Date(0).toISOString() });
function nowIso(): string { return new Date().toISOString(); }
function isLiveStatus(status: SessionStatus): boolean { return status === 'active' || status === 'waiting'; }
export const useAgentStore = defineStore('agents', () => {
  const sessions = ref<AgentSession[]>([]);
  const entries = ref<AgentConversationEntry[]>([]);
  const activityStatus = ref<ActivityStatus>(idleActivity());
  const currentSession = ref<AgentSession | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const lastFetchedAt = ref<string | null>(null);
  const lastWsEventAt = ref<string | null>(null);
  const lastUpdatedBy = ref<FreshnessState['lastUpdatedBy']>('unknown');
  const unauthorized = ref(false);
  const conversationWarning = ref<string | null>(null);
  const currentLlmExchange = ref<ProviderExchangePayload | null>(null);
  const llmExchangeLoading = ref(false);
  const llmExchangeError = ref<string | null>(null);
  const llmExchangeSessionId = ref<string | null>(null);

  const isStale = computed(() => { const latest = lastWsEventAt.value ?? lastFetchedAt.value; return latest ? Date.now() - new Date(latest).getTime() > STALE_AFTER_MS : false; });
  const sessionsByRole = computed<Map<AgentRole, AgentSession[]>>(() => { const map = new Map<AgentRole, AgentSession[]>(); for (const session of sessions.value) { const list = map.get(session.role) ?? []; list.push(session); map.set(session.role, list); } return map; });
  const activeSessions = computed(() => sessions.value.filter((s) => isLiveStatus(s.status)));
  const completedSessions = computed(() => sessions.value.filter((s) => !isLiveStatus(s.status)));
  const attentionSessions = computed(() => sessions.value.filter((s) => s.status === 'failed' || s.status === 'blocked'));

  function markRestSync(): void { lastFetchedAt.value = nowIso(); lastUpdatedBy.value = 'rest'; }
  function markWsSync(timestamp = nowIso()): void { lastWsEventAt.value = timestamp; lastUpdatedBy.value = 'ws'; }

  async function fetchSessions(): Promise<void> {
    loading.value = true; error.value = null; unauthorized.value = false;
    try { const response = await listAgentSessions(); sessions.value = response.sessions; markRestSync(); }
    catch (err) { const msg = err instanceof ApiError ? err.message : 'Failed to fetch agent sessions'; error.value = msg; unauthorized.value = err instanceof ApiError && err.isUnauthorized; log.error('fetchSessions', msg); throw err; }
    finally { loading.value = false; }
  }

  async function fetchConversation(sessionId: string): Promise<void> {
    const requestSeq = ++conversationRequestSeq;
    clearLlmExchange(); loading.value = true; error.value = null; conversationWarning.value = null; unauthorized.value = false;
    try {
      const response = await getAgentConversation(sessionId);
      if (requestSeq !== conversationRequestSeq) return;
      const conversationEntries = response.entries;
      currentSession.value = response.session;
      entries.value = conversationEntries;
      activityStatus.value = response.activity_status;
      if (conversationEntries.length === 0) conversationWarning.value = 'No recorded conversation entries were returned for this session.';
      else if (conversationEntries.some((entry) => entry.kind === 'model_issue')) conversationWarning.value = 'Conversation includes model/tool recovery events; inspect for incomplete or repaired output.';
      markRestSync();
    } catch (err) { if (requestSeq !== conversationRequestSeq) return; const msg = err instanceof ApiError ? err.message : 'Failed to fetch agent conversation'; error.value = msg; unauthorized.value = err instanceof ApiError && err.isUnauthorized; log.error('fetchConversation', msg); throw err; }
    finally { if (requestSeq === conversationRequestSeq) loading.value = false; }
  }
  const refreshConversation = fetchConversation;

  async function fetchLlmExchange(sessionId: string): Promise<void> { llmExchangeSessionId.value = sessionId; llmExchangeLoading.value = true; llmExchangeError.value = null; try { const { exchange } = await getAgentLlmExchange(sessionId); if (llmExchangeSessionId.value === sessionId) currentLlmExchange.value = exchange; } catch (err) { if (llmExchangeSessionId.value !== sessionId) return; currentLlmExchange.value = null; llmExchangeError.value = err instanceof ApiError && err.isNotFound ? null : err instanceof Error ? err.message : String(err); } finally { if (llmExchangeSessionId.value === sessionId) llmExchangeLoading.value = false; } }
  function clearLlmExchange(): void { currentLlmExchange.value = null; llmExchangeLoading.value = false; llmExchangeError.value = null; llmExchangeSessionId.value = null; }

  async function refetchConversation(sessionId = currentSession.value?.id): Promise<void> { if (sessionId) await fetchConversation(sessionId); }
  async function refetch(): Promise<void> { await fetchSessions(); if (currentSession.value?.id) await refetchConversation(currentSession.value.id); }

  return { sessions, entries, activityStatus, currentSession, loading, error, lastFetchedAt, lastWsEventAt, lastUpdatedBy, unauthorized, conversationWarning, currentLlmExchange, llmExchangeLoading, llmExchangeError, llmExchangeSessionId, sessionsByRole, activeSessions, completedSessions, attentionSessions, isStale, fetchSessions, fetchConversation, refreshConversation, refetchConversation, refetch, fetchLlmExchange, clearLlmExchange, markWsSync };
});
