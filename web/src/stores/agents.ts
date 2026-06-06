import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { AgentConversationEntry, AgentConversationResponse, AgentRole, AgentSession, ActivityStatus, FreshnessState, SessionStatus } from '../api/types';
import { listAgentSessions, getAgentConversation, getAgentLlmExchange, ApiError } from '../api/client';
import type { LlmExchange } from '../api/contracts';
import { createLogger } from '../utils/logger';

const log = createLogger('store:agents');
const STALE_AFTER_MS = 30_000;
const idleActivity = (): ActivityStatus => ({ status: 'idle', pending_calls: [], updated_at: new Date(0).toISOString() });
function nowIso(): string { return new Date().toISOString(); }
function isLiveStatus(status: SessionStatus): boolean { return status === 'active' || status === 'waiting'; }
function normalizeConversationEntries(items: AgentConversationResponse['entries']): AgentConversationResponse['entries'] {
  let lastToolCallId: string | null = null;
  return items.map((entry, index) => {
    const normalized = {
      ...entry,
      round_id: entry.round_id ?? 'r-assistant-00000000000000000000000000000001',
      message_index: entry.message_index ?? index,
      block_index: entry.block_index ?? 0,
      tool_call_id: entry.tool_call_id,
    };
    if (normalized.kind === 'tool_call') {
      lastToolCallId = normalized.tool_call_id ?? normalized.id;
      normalized.tool_call_id = lastToolCallId;
    } else if ((normalized.kind === 'tool_result' || normalized.kind === 'tool_error') && !normalized.tool_call_id && lastToolCallId) {
      normalized.tool_call_id = lastToolCallId;
    }
    return normalized;
  });
}

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
  const currentLlmExchange = ref<LlmExchange | null>(null);
  const llmExchangeLoading = ref(false);
  const llmExchangeError = ref<string | null>(null);
  const llmExchangeSessionId = ref<string | null>(null);

  const isStale = computed(() => { const latest = lastWsEventAt.value ?? lastFetchedAt.value; return latest ? Date.now() - new Date(latest).getTime() > STALE_AFTER_MS : false; });
  const sessionsByRole = computed<Map<AgentRole, AgentSession[]>>(() => { const map = new Map<AgentRole, AgentSession[]>(); for (const session of sessions.value) { const list = map.get(session.role) ?? []; list.push(session); map.set(session.role, list); } return map; });
  const activeSessions = computed(() => sessions.value.filter((s) => isLiveStatus(s.status)));
  const completedSessions = computed(() => sessions.value.filter((s) => !isLiveStatus(s.status)));
  const attentionSessions = computed(() => sessions.value.filter((s) => s.status === 'failed' || s.status === 'blocked'));

  function markRestSync(): void { lastFetchedAt.value = nowIso(); lastUpdatedBy.value = 'rest'; }
  function markWsSync(): void { lastWsEventAt.value = nowIso(); lastUpdatedBy.value = lastFetchedAt.value ? 'mixed' : 'ws'; }
  function setActivityStatus(next: ActivityStatus): void { activityStatus.value = next; }

  async function fetchSessions(): Promise<void> {
    loading.value = true; error.value = null; unauthorized.value = false;
    try { const response = await listAgentSessions(); sessions.value = response.sessions; markRestSync(); }
    catch (err) { const msg = err instanceof ApiError ? err.message : 'Failed to fetch agent sessions'; error.value = msg; unauthorized.value = err instanceof ApiError && err.isUnauthorized; log.error('fetchSessions', msg); throw err; }
    finally { loading.value = false; }
  }

  async function fetchConversation(sessionId: string): Promise<void> {
    clearLlmExchange(); loading.value = true; error.value = null; conversationWarning.value = null; unauthorized.value = false;
    try {
      const response = await getAgentConversation(sessionId);
      const conversationEntries = normalizeConversationEntries(response.entries);
      currentSession.value = response.session;
      entries.value = conversationEntries;
      activityStatus.value = response.activity_status;
      if (conversationEntries.length === 0) conversationWarning.value = 'No recorded conversation entries were returned for this session.';
      else if (conversationEntries.some((entry) => entry.kind === 'model_issue')) conversationWarning.value = 'Conversation includes model/tool recovery events; inspect for incomplete or repaired output.';
      markRestSync();
    } catch (err) { const msg = err instanceof ApiError ? err.message : 'Failed to fetch agent conversation'; error.value = msg; unauthorized.value = err instanceof ApiError && err.isUnauthorized; log.error('fetchConversation', msg); throw err; }
    finally { loading.value = false; }
  }
  const refreshConversation = fetchConversation;

  function addSession(session: AgentSession): void { const idx = sessions.value.findIndex((s) => s.id === session.id); if (idx !== -1) sessions.value[idx] = session; else sessions.value.push(session); sessions.value = [...sessions.value]; }
  function updateSessionStatus(sessionId: string, status: SessionStatus): void { const session = sessions.value.find((s) => s.id === sessionId); if (session) { session.status = status; session.completed_at = isLiveStatus(status) ? null : new Date().toISOString(); sessions.value = [...sessions.value]; } if (currentSession.value?.id === sessionId) currentSession.value = { ...currentSession.value, status, completed_at: isLiveStatus(status) ? null : new Date().toISOString() }; }
  function appendEntry(entry: AgentConversationEntry): void { if (currentSession.value && entry.session_id === currentSession.value.id) { entries.value = [...entries.value, entry]; markWsSync(); if (entry.kind === 'tool_error' || entry.kind === 'model_issue') conversationWarning.value = 'Conversation includes tool/model failures or repairs; inspect linked evidence carefully.'; } }

  async function fetchLlmExchange(sessionId: string): Promise<void> { llmExchangeSessionId.value = sessionId; llmExchangeLoading.value = true; llmExchangeError.value = null; try { const { exchange } = await getAgentLlmExchange(sessionId); if (llmExchangeSessionId.value === sessionId) currentLlmExchange.value = exchange; } catch (err) { if (llmExchangeSessionId.value !== sessionId) return; currentLlmExchange.value = null; llmExchangeError.value = err instanceof ApiError && err.isNotFound ? null : err instanceof Error ? err.message : String(err); } finally { if (llmExchangeSessionId.value === sessionId) llmExchangeLoading.value = false; } }
  function clearLlmExchange(): void { currentLlmExchange.value = null; llmExchangeLoading.value = false; llmExchangeError.value = null; llmExchangeSessionId.value = null; }

  async function refetchConversation(sessionId = currentSession.value?.id): Promise<void> { if (sessionId) await fetchConversation(sessionId); }
  async function refetch(): Promise<void> { await fetchSessions(); if (currentSession.value?.id) await refetchConversation(currentSession.value.id); }

  return { sessions, entries, activityStatus, currentSession, loading, error, lastFetchedAt, lastWsEventAt, lastUpdatedBy, unauthorized, conversationWarning, currentLlmExchange, llmExchangeLoading, llmExchangeError, llmExchangeSessionId, sessionsByRole, activeSessions, completedSessions, attentionSessions, isStale, fetchSessions, fetchConversation, refreshConversation, refetchConversation, refetch, addSession, updateSessionStatus, appendEntry, setActivityStatus, fetchLlmExchange, clearLlmExchange };
});
