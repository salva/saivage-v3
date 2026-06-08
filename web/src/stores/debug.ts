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
  ControlActionAuditEntry,
  ControlActionsListResponse,
} from '../api/types';
import {
  getDebugState,
  getDebugErrors,
  getDebugTimeline,
  getDoctor,
  getDebugSupervision,
  listProcesses,
  listControlActions,
  ApiError,
} from '../api/client';
import { createLogger } from '../utils/logger';
import { redactObservabilityValue } from '../utils/observabilityRedaction';
import {
  selectErrorsBySeverity,
  selectErrorsBySource,
  selectOperatorDataFreshnessLabel,
  selectSortedTimeline,
  selectTimelineDerivedErrors,
} from './debug-read-model';

const log = createLogger('store:debug');
function operatorErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) {
      return 'Unauthorized. Provide a valid Saivage API token and refresh the page.';
    }
    if (err.status === 503) {
      return 'Runtime control is unavailable because runtime state is not initialized. Start the runtime or restore runtime state first.';
    }
    if (typeof err.message === 'string' && err.message.trim()) {
      return err.message;
    }
  }
  return 'Operator control request failed.';
}

function buildPanelState(err: unknown): 'unauthorized' | 'error' {
  return err instanceof ApiError && err.status === 401 ? 'unauthorized' : 'error';
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
  const processTerminateLoading = ref<Record<string, boolean>>({});
  const processControlError = ref<string | null>(null);
  const processControlSuccess = ref<string | null>(null);
  const processUnauthorized = ref(false);
  const processStale = ref(false);

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


  const controlActions = ref<ControlActionAuditEntry[]>([]);
  const controlActionsTotal = ref(0);
  const controlActionsLoading = ref(false);
  const controlActionsError = ref<string | null>(null);
  const controlActionsState = ref<'idle' | 'success' | 'empty' | 'unauthorized' | 'error'>('idle');

  const runtimeControlLoading = ref<'pause' | 'resume' | null>(null);
  const runtimeControlError = ref<string | null>(null);
  const runtimeControlSuccess = ref<string | null>(null);
  const operatorNoteActionLoading = ref<Record<string, 'acknowledge' | 'delete'>>({});
  const operatorClearLoading = ref(false);
  const operatorLastFetchedAt = ref<string | null>(null);
  const operatorStale = ref(false);
  const operatorUnauthorized = ref(false);
  const operatorPartialWarning = ref<string | null>(null);

  const loading = ref(false);
  const error = ref<string | null>(null);
  const activeTab = ref<'state' | 'errors' | 'timeline' | 'supervision'>('state');


  const eventDerivedErrors = computed<DebugError[]>(() => selectTimelineDerivedErrors(timelineEvents.value));

  const combinedErrors = computed<DebugError[]>(() => [...errors.value, ...eventDerivedErrors.value]);

  const errorsBySource = computed<Map<string, DebugError[]>>(() => selectErrorsBySource(combinedErrors.value));

  const errorsBySeverity = computed<Map<string, DebugError[]>>(() => selectErrorsBySeverity(combinedErrors.value));

  const sortedTimeline = computed<DebugTimelineEvent[]>(() => selectSortedTimeline(timelineEvents.value));

  const problemCards = computed(() => debugCards.value.filter((c) => c.status === 'failed' || c.status === 'blocked'));
  const failedChecks = computed(() => doctorChecks.value.filter((c) => !c.passed));

  const doctorIssuesBySeverity = computed(() => {
    const map = new Map<'error' | 'warning', DoctorIssue[]>();
    for (const issue of doctorIssues.value) {
      const list = map.get(issue.severity);
      if (list) list.push(issue); else map.set(issue.severity, [issue]);
    }
    return map;
  });

  const reviewsByStatus = computed(() => {
    const map = new Map<string, ContentReview[]>();
    for (const r of supervisionReviews.value) {
      const list = map.get(r.status);
      if (list) list.push(r); else map.set(r.status, [r]);
    }
    return map;
  });

  const operatorDataFreshnessLabel = computed(() => selectOperatorDataFreshnessLabel(operatorLastFetchedAt.value));

  function markOperatorSuccess(message: string): void {
    runtimeControlSuccess.value = message;
    runtimeControlError.value = null;
  }

  function markOperatorError(message: string): void {
    runtimeControlError.value = message;
    runtimeControlSuccess.value = null;
  }

  function upsertProcess(process: ProcessView): void {
    const index = processes.value.findIndex((entry) => entry.id === process.id);
    if (index >= 0) {
      processes.value = [...processes.value.slice(0, index), process, ...processes.value.slice(index + 1)];
      return;
    }
    processes.value = [...processes.value, process];
  }

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
    processControlError.value = null;
    try {
      const response: ProcessListResponse = await listProcesses();
      processes.value = response.processes;
      processUnauthorized.value = false;
      processStale.value = false;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to fetch processes';
      processesError.value = msg;
      if (err instanceof ApiError && err.status === 401) processUnauthorized.value = true;
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

  async function fetchControlActions(): Promise<void> {
    controlActionsLoading.value = true;
    controlActionsError.value = null;
    try {
      const response: ControlActionsListResponse = await listControlActions();
      controlActions.value = response.control_actions;
      controlActionsTotal.value = response.total;
      controlActionsState.value = response.control_actions.length === 0 ? 'empty' : 'success';
    } catch (err) {
      controlActionsError.value = operatorErrorMessage(err);
      controlActionsState.value = buildPanelState(err);
      throw err;
    } finally {
      controlActionsLoading.value = false;
    }
  }

  async function fetchOperatorControl(): Promise<void> {
    operatorPartialWarning.value = null;
    const hadPriorData = controlActions.value.length > 0 || debugRuntime.value !== null || operatorLastFetchedAt.value !== null;

    const [stateResult, controlActionsResult] = await Promise.allSettled([
      fetchState(),
      fetchControlActions(),
    ]);

    const failures = [stateResult, controlActionsResult].filter((result) => result.status === 'rejected');
    if (failures.length === 0) {
      operatorStale.value = false;
      operatorLastFetchedAt.value = new Date().toISOString();
      return;
    }

    if (hadPriorData) operatorStale.value = true;
    operatorPartialWarning.value = 'This panel may be stale. Refresh to reconcile with server state.';
    if (failures.length < 2) operatorLastFetchedAt.value = new Date().toISOString();
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

  function setActiveTab(tab: 'state' | 'errors' | 'timeline' | 'supervision'): void {
    activeTab.value = tab;
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
    processTerminateLoading: readonly(processTerminateLoading),
    processControlError: readonly(processControlError),
    processControlSuccess: readonly(processControlSuccess),
    processUnauthorized: readonly(processUnauthorized),
    processStale: readonly(processStale),
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
    controlActions: readonly(controlActions),
    controlActionsTotal: readonly(controlActionsTotal),
    controlActionsLoading: readonly(controlActionsLoading),
    controlActionsError: readonly(controlActionsError),
    controlActionsState: readonly(controlActionsState),
    runtimeControlLoading: readonly(runtimeControlLoading),
    runtimeControlError: readonly(runtimeControlError),
    runtimeControlSuccess: readonly(runtimeControlSuccess),
    operatorNoteActionLoading: readonly(operatorNoteActionLoading),
    operatorClearLoading: readonly(operatorClearLoading),
    operatorLastFetchedAt: readonly(operatorLastFetchedAt),
    operatorStale: readonly(operatorStale),
    operatorUnauthorized: readonly(operatorUnauthorized),
    operatorPartialWarning: readonly(operatorPartialWarning),
    operatorDataFreshnessLabel,
    loading: readonly(loading),
    error: readonly(error),
    activeTab,
    errorsBySource,
    errorsBySeverity,
    sortedTimeline,
    problemCards,
    failedChecks,
    doctorIssuesBySeverity,
    reviewsByStatus,
    fetchState,
    fetchErrors,
    fetchTimeline,
    fetchProcesses,
    refetchTimeline,
    refetchProcesses,
    fetchDoctor,
    fetchSupervision,
    fetchControlActions,
    fetchOperatorControl,
    fetchAll,
    refetch,
    setActiveTab,
  };
});
