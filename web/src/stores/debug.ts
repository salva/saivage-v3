/**
 * Pinia store for debug information.
 *
 * Exposes runtime state dump, errors list, timeline view, doctor
 * diagnostics, and content supervision data. All data is read-only
 * for inspection purposes — actions should link back to the
 * relevant card or process.
 */

import { defineStore } from 'pinia';
import { ref, computed, readonly } from 'vue';
import type {
  RuntimeState,
  CardType,
  CardStatus,
  DebugError,
  DebugTimelineEvent,
  DebugStateResponse,
  DebugErrorsResponse,
  DebugTimelineResponse,
  DoctorCheck,
  DoctorIssue,
  DoctorResponse,
  ContentReview,
  QuarantineSummaryEntry,
  SupervisionStats,
  SupervisionResponse,
  ProcessView,
  ProcessListResponse,
  AgentSession,
  AgentConversationResponse,
  FileEntry,
} from '../api/types';
import {
  getDebugState,
  getDebugErrors,
  getDebugTimeline,
  getDoctor,
  getDebugSupervision,
  listProcesses,
  listAgentSessions,
  listFiles,
  getAgentConversation,
  getAgentLlmExchange,
  getFileContent,
  ApiError,
} from '../api/client';
import { createLogger } from '../utils/logger';
import { redactObservabilityValue } from '../utils/observabilityRedaction';
import {
  selectErrorsBySource,
  selectOperatorDataFreshnessLabel,
  selectSortedTimeline,
  selectTimelineDerivedErrors,
} from './debug-read-model';

const log = createLogger('store:debug');

export type AgentDebugKind = 'conversation' | 'toolDeliveries' | 'llmExchange';
type RawAgentDebugKind = Exclude<AgentDebugKind, 'conversation'>;
interface AgentDebugSession extends Pick<AgentSession, 'id' | 'role' | 'status'> {
  files: Partial<Record<AgentDebugKind, string>>;
}

export const agentDebugKinds: Array<{ id: AgentDebugKind; label: string }> = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'toolDeliveries', label: 'Tool Deliveries' },
  { id: 'llmExchange', label: 'Raw LLM Exchange' },
];

function sessionIdFromAgentDebugFile(name: string): string {
  const withoutExtension = name.replace(/\.jsonl?$/i, '');
  try { return decodeURIComponent(withoutExtension); } catch { return withoutExtension; }
}

function formatAgentDebugContent(content: string, path: string | null): string {
  if (!content) return '';
  if (path?.endsWith('.jsonl')) {
    return content.split('\n').filter((line) => line.trim().length > 0).map((line) => {
      try { return JSON.stringify(JSON.parse(line), null, 2); } catch { return line; }
    }).join('\n\n');
  }
  try { return JSON.stringify(JSON.parse(content), null, 2); } catch { return content; }
}

export const useDebugStore = defineStore('debug', () => {
  const debugRuntime = ref<RuntimeState | null>(null);
  const debugCards = ref<Array<{
    id: string;
    type: CardType;
    parent: string | null;
    status: CardStatus;
    title: string;
    priority: number;
    depends_on: string[];
  }>>([]);
  const debugTotalCards = ref(0);

  const errors = ref<DebugError[]>([]);
  const errorsTotal = ref(0);

  const timelineEvents = ref<DebugTimelineEvent[]>([]);
  const timelineTotal = ref(0);

  const processes = ref<ProcessView[]>([]);
  const processesLoading = ref(false);
  const processesError = ref<string | null>(null);

  const doctorStatus = ref<'ok' | 'issues_found' | null>(null);
  const doctorChecks = ref<DoctorCheck[]>([]);
  const doctorIssues = ref<DoctorIssue[]>([]);
  const doctorLoading = ref(false);
  const doctorError = ref<string | null>(null);

  const supervisionReviews = ref<ContentReview[]>([]);
  const supervisionQuarantine = ref<QuarantineSummaryEntry[]>([]);
  const supervisionStats = ref<SupervisionStats | null>(null);
  const supervisionLoading = ref(false);
  const supervisionError = ref<string | null>(null);

  const operatorLastFetchedAt = ref<string | null>(null);

  const agentDebugSessions = ref<AgentDebugSession[]>([]);
  const selectedAgentDebugSessionId = ref<string | null>(null);
  const selectedAgentDebugKind = ref<AgentDebugKind>('conversation');
  const agentDebugLoading = ref(false);
  const agentDebugError = ref<string | null>(null);
  const agentDebugContent = ref('');
  const selectedAgentDebugConversation = ref<AgentConversationResponse | null>(null);
  const agentDebugContentLoading = ref(false);
  const agentDebugContentError = ref<string | null>(null);

  const loading = ref(false);
  const error = ref<string | null>(null);


  const eventDerivedErrors = computed<DebugError[]>(() => selectTimelineDerivedErrors(timelineEvents.value));

  const combinedErrors = computed<DebugError[]>(() => [...errors.value, ...eventDerivedErrors.value]);

  const errorsBySource = computed<Map<string, DebugError[]>>(() => selectErrorsBySource(combinedErrors.value));

  const sortedTimeline = computed<DebugTimelineEvent[]>(() => selectSortedTimeline(timelineEvents.value));

  const operatorDataFreshnessLabel = computed(() => selectOperatorDataFreshnessLabel(operatorLastFetchedAt.value));
  const selectedAgentDebugSession = computed(() => agentDebugSessions.value.find((session) => session.id === selectedAgentDebugSessionId.value) ?? null);
  const selectedAgentDebugPath = computed(() => {
    const session = selectedAgentDebugSession.value;
    if (!session) return null;
    if (selectedAgentDebugKind.value === 'conversation') return `/api/agents/${encodeURIComponent(session.id)}/conversation`;
    if (selectedAgentDebugKind.value === 'llmExchange') return session.files.llmExchange ? `/api/agents/${encodeURIComponent(session.id)}/llm-exchange` : null;
    return session.files[selectedAgentDebugKind.value] ?? null;
  });
  const formattedAgentDebugContent = computed(() => formatAgentDebugContent(agentDebugContent.value, selectedAgentDebugPath.value));

  async function fetchState(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const response: DebugStateResponse = await getDebugState();
      debugRuntime.value = response.runtime;
      debugCards.value = response.cards;
      debugTotalCards.value = response.totalCards;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to fetch debug state';
      error.value = msg;
      log.error('fetchState', msg);
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function fetchErrors(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const response: DebugErrorsResponse = await getDebugErrors();
      errors.value = response.errors.map((entry) => redactObservabilityValue(entry));
      errorsTotal.value = response.total;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to fetch debug errors';
      error.value = msg;
      log.error('fetchErrors', msg);
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function fetchTimeline(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const response: DebugTimelineResponse = await getDebugTimeline();
      timelineEvents.value = response.events.map((entry) => redactObservabilityValue(entry));
      timelineTotal.value = response.total;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to fetch debug timeline';
      error.value = msg;
      log.error('fetchTimeline', msg);
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function fetchProcesses(): Promise<void> {
    processesLoading.value = true;
    processesError.value = null;
    try {
      const response: ProcessListResponse = await listProcesses();
      processes.value = response.processes;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to fetch processes';
      processesError.value = msg;
      log.error('fetchProcesses', msg);
    } finally {
      processesLoading.value = false;
    }
  }


  async function fetchDoctor(): Promise<void> {
    doctorLoading.value = true;
    doctorError.value = null;
    try {
      const response: DoctorResponse = await getDoctor();
      doctorStatus.value = response.status;
      doctorChecks.value = response.checks;
      doctorIssues.value = response.issues;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to fetch doctor diagnostics';
      doctorError.value = msg;
      log.error('fetchDoctor', msg);
    } finally {
      doctorLoading.value = false;
    }
  }

  async function fetchSupervision(): Promise<void> {
    supervisionLoading.value = true;
    supervisionError.value = null;
    try {
      const response: SupervisionResponse = await getDebugSupervision();
      supervisionReviews.value = response.reviews;
      supervisionQuarantine.value = response.quarantine;
      supervisionStats.value = response.stats;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to fetch supervision data';
      supervisionError.value = msg;
      log.error('fetchSupervision', msg);
    } finally {
      supervisionLoading.value = false;
    }
  }

  async function fetchOperatorControl(): Promise<void> {
    await fetchState();
    operatorLastFetchedAt.value = new Date().toISOString();
  }

  async function listAgentDebugFiles(path: string): Promise<FileEntry[]> {
    try {
      const response = await listFiles(path);
      return response.files.filter((file) => file.type === 'file');
    } catch {
      return [];
    }
  }

  function addAgentDebugFiles(bySession: Map<string, AgentDebugSession>, files: FileEntry[], kind: RawAgentDebugKind): void {
    for (const file of files) {
      const id = sessionIdFromAgentDebugFile(file.name);
      const session = bySession.get(id);
      if (!session) continue;
      session.files[kind] = file.path;
    }
  }

  function normalizeSelectedAgentDebugKind(): void {
    const session = selectedAgentDebugSession.value;
    if (!session) return;
    if (agentDebugKindAvailable(selectedAgentDebugKind.value)) return;
    selectedAgentDebugKind.value = 'conversation';
  }

  function agentDebugKindAvailable(kind: AgentDebugKind): boolean {
    const session = selectedAgentDebugSession.value;
    if (!session) return false;
    if (kind === 'conversation') return true;
    return Boolean(session.files[kind]);
  }

  async function loadSelectedAgentDebugContent(): Promise<void> {
    agentDebugContent.value = '';
    selectedAgentDebugConversation.value = null;
    agentDebugContentError.value = null;
    const session = selectedAgentDebugSession.value;
    const path = selectedAgentDebugPath.value;
    if (!session || !path) return;
    agentDebugContentLoading.value = true;
    try {
      if (selectedAgentDebugKind.value === 'conversation') {
        selectedAgentDebugConversation.value = await getAgentConversation(session.id);
      } else if (selectedAgentDebugKind.value === 'llmExchange') {
        agentDebugContent.value = JSON.stringify(await getAgentLlmExchange(session.id), null, 2);
      } else {
        const file = await getFileContent(path);
        agentDebugContent.value = file.content;
      }
    } catch (err) {
      agentDebugContentError.value = err instanceof Error ? err.message : String(err);
    } finally {
      agentDebugContentLoading.value = false;
    }
  }

  async function refetchSelectedAgentDebugConversation(): Promise<void> {
    const session = selectedAgentDebugSession.value;
    if (!session || selectedAgentDebugKind.value !== 'conversation') return;
    const sessionId = session.id;
    try {
      const conversation = await getAgentConversation(sessionId);
      if (
        selectedAgentDebugSession.value?.id === sessionId &&
        selectedAgentDebugKind.value === 'conversation'
      ) {
        selectedAgentDebugConversation.value = conversation;
      }
    } catch (err) {
      log.warn('refetchSelectedAgentDebugConversation', err);
    }
  }

  async function refreshAgentDebug(): Promise<void> {
    agentDebugLoading.value = true;
    agentDebugError.value = null;
    try {
      const [sessionResponse, toolDeliveries, llmExchanges] = await Promise.all([
        listAgentSessions(),
        listAgentDebugFiles('.saivage/agents/tool-deliveries'),
        listAgentDebugFiles('.saivage/agents/llm-exchanges'),
      ]);
      const bySession = new Map<string, AgentDebugSession>();
      for (const session of sessionResponse.sessions) bySession.set(session.id, { id: session.id, role: session.role, status: session.status, files: {} });
      addAgentDebugFiles(bySession, toolDeliveries, 'toolDeliveries');
      addAgentDebugFiles(bySession, llmExchanges, 'llmExchange');
      agentDebugSessions.value = [...bySession.values()].sort((a, b) => a.id.localeCompare(b.id));
      if (!selectedAgentDebugSessionId.value || !bySession.has(selectedAgentDebugSessionId.value)) selectedAgentDebugSessionId.value = agentDebugSessions.value[0]?.id ?? null;
      normalizeSelectedAgentDebugKind();
      await loadSelectedAgentDebugContent();
    } catch (err) {
      agentDebugError.value = err instanceof Error ? err.message : String(err);
    } finally {
      agentDebugLoading.value = false;
    }
  }

  function selectAgentDebugSession(sessionId: string): void {
    selectedAgentDebugSessionId.value = sessionId;
    normalizeSelectedAgentDebugKind();
    loadSelectedAgentDebugContent().catch(() => {});
  }

  function selectAgentDebugKind(kind: AgentDebugKind): void {
    selectedAgentDebugKind.value = kind;
    loadSelectedAgentDebugContent().catch(() => {});
  }







  async function fetchAll(): Promise<void> {
    loading.value = true;
    error.value = null;

    const results = await Promise.allSettled([
      fetchState(),
      fetchErrors(),
      fetchTimeline(),
    ]);

    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => (result.reason instanceof ApiError ? result.reason.message : 'Failed to fetch debug data'));

    if (failures.length > 0) {
      error.value = failures.length >= 3 ? 'Failed to fetch debug data' : failures.join('; ');
    }

    loading.value = false;
  }

  const refetch = fetchAll;
  const refetchTimeline = fetchTimeline;
  const refetchProcesses = fetchProcesses;

  return {
    debugRuntime: readonly(debugRuntime),
    debugCards: readonly(debugCards),
    debugTotalCards: readonly(debugTotalCards),
    errors: readonly(combinedErrors),
    errorsTotal: readonly(computed(() => combinedErrors.value.length)),
    timelineEvents: readonly(timelineEvents),
    timelineTotal: readonly(timelineTotal),
    processes: readonly(processes),
    processesLoading: readonly(processesLoading),
    processesError: readonly(processesError),
    doctorStatus: readonly(doctorStatus),
    doctorChecks: readonly(doctorChecks),
    doctorIssues: readonly(doctorIssues),
    doctorLoading: readonly(doctorLoading),
    doctorError: readonly(doctorError),
    supervisionReviews: readonly(supervisionReviews),
    supervisionQuarantine: readonly(supervisionQuarantine),
    supervisionStats: readonly(supervisionStats),
    supervisionLoading: readonly(supervisionLoading),
    supervisionError: readonly(supervisionError),
    operatorLastFetchedAt: readonly(operatorLastFetchedAt),
    operatorDataFreshnessLabel,
    agentDebugKinds,
    agentDebugSessions: readonly(agentDebugSessions),
    selectedAgentDebugSessionId,
    selectedAgentDebugKind,
    selectedAgentDebugSession,
    selectedAgentDebugPath,
    selectedAgentDebugConversation: readonly(selectedAgentDebugConversation),
    formattedAgentDebugContent,
    agentDebugLoading: readonly(agentDebugLoading),
    agentDebugError: readonly(agentDebugError),
    agentDebugContentLoading: readonly(agentDebugContentLoading),
    agentDebugContentError: readonly(agentDebugContentError),
    loading: readonly(loading),
    error: readonly(error),
    errorsBySource,
    sortedTimeline,
    fetchState,
    fetchErrors,
    fetchTimeline,
    fetchProcesses,
    refetchTimeline,
    refetchProcesses,
    fetchDoctor,
    fetchSupervision,
    fetchOperatorControl,
    refreshAgentDebug,
    selectAgentDebugSession,
    selectAgentDebugKind,
    agentDebugKindAvailable,
    loadSelectedAgentDebugContent,
    refetchSelectedAgentDebugConversation,
    fetchAll,
    refetch,
  };
});
