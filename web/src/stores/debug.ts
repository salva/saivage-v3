/**
 * Pinia store for debug information.
 *
 * Exposes runtime state dump, errors list, timeline view, doctor
 * diagnostics, and content supervision data. All data is read-only
 * for inspection purposes — actions should link back to the
 * relevant card or process.
 *
 * Error handling is per-fetch where possible:
 *  - fetchState / fetchErrors / fetchTimeline share `loading` and `error`
 *    (they are loaded together via fetchAll on mount).
 *  - fetchProcesses, fetchDoctor, fetchSupervision each have their own
 *    loading AND error ref so a failed fetch in one pane does not bleed
 *    into unrelated operator views.
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
  ProcessRecord,
  ProcessListResponse,
} from '../api/types';
import {
  getDebugState,
  getDebugErrors,
  getDebugTimeline,
  getDoctor,
  getDebugSupervision,
  listProcesses,
  ApiError,
} from '../api/client';
import { useWsStore } from './ws';
import { createLogger } from '../utils/logger';

const log = createLogger('store:debug');

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
    blocks: string[];
  }>>([]);
  const debugTotalCards = ref(0);

  const errors = ref<DebugError[]>([]);
  const errorsTotal = ref(0);

  const timelineEvents = ref<DebugTimelineEvent[]>([]);
  const timelineTotal = ref(0);

  const processes = ref<ProcessRecord[]>([]);
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

  const loading = ref(false);
  const error = ref<string | null>(null);

  const activeTab = ref<'state' | 'errors' | 'timeline' | 'supervision'>('state');

  const errorsBySource = computed<Map<string, DebugError[]>>(() => {
    const map = new Map<string, DebugError[]>();
    for (const e of errors.value) {
      const list = map.get(e.source);
      if (list) {
        list.push(e);
      } else {
        map.set(e.source, [e]);
      }
    }
    return map;
  });

  const errorsBySeverity = computed<Map<string, DebugError[]>>(() => {
    const map = new Map<string, DebugError[]>();
    for (const e of errors.value) {
      const list = map.get(e.severity);
      if (list) {
        list.push(e);
      } else {
        map.set(e.severity, [e]);
      }
    }
    return map;
  });

  const sortedTimeline = computed<DebugTimelineEvent[]>(() =>
    [...timelineEvents.value].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    ),
  );

  const problemCards = computed(() =>
    debugCards.value.filter((c) => c.status === 'failed' || c.status === 'blocked'),
  );

  const failedChecks = computed(() => doctorChecks.value.filter((c) => !c.passed));

  const doctorIssuesBySeverity = computed(() => {
    const map = new Map<'error' | 'warning', DoctorIssue[]>();
    for (const issue of doctorIssues.value) {
      const list = map.get(issue.severity);
      if (list) {
        list.push(issue);
      } else {
        map.set(issue.severity, [issue]);
      }
    }
    return map;
  });

  const reviewsByStatus = computed(() => {
    const map = new Map<string, ContentReview[]>();
    for (const r of supervisionReviews.value) {
      const list = map.get(r.status);
      if (list) {
        list.push(r);
      } else {
        map.set(r.status, [r]);
      }
    }
    return map;
  });

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
    } finally {
      loading.value = false;
    }
  }

  async function fetchErrors(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const response: DebugErrorsResponse = await getDebugErrors();
      errors.value = response.errors;
      errorsTotal.value = response.total;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to fetch debug errors';
      error.value = msg;
      log.error('fetchErrors', msg);
    } finally {
      loading.value = false;
    }
  }

  async function fetchTimeline(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const response: DebugTimelineResponse = await getDebugTimeline();
      timelineEvents.value = response.events;
      timelineTotal.value = response.total;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to fetch debug timeline';
      error.value = msg;
      log.error('fetchTimeline', msg);
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

  async function fetchAll(): Promise<void> {
    loading.value = true;
    error.value = null;

    const results = await Promise.allSettled([
      (async () => {
        try {
          const response: DebugStateResponse = await getDebugState();
          debugRuntime.value = response.runtime;
          debugCards.value = response.cards;
          debugTotalCards.value = response.totalCards;
        } catch (err) {
          const msg = err instanceof ApiError ? err.message : 'Failed to fetch debug state';
          log.error('fetchState', msg);
          throw err;
        }
      })(),
      (async () => {
        try {
          const response: DebugErrorsResponse = await getDebugErrors();
          errors.value = response.errors;
          errorsTotal.value = response.total;
        } catch (err) {
          const msg = err instanceof ApiError ? err.message : 'Failed to fetch debug errors';
          log.error('fetchErrors', msg);
          throw err;
        }
      })(),
      (async () => {
        try {
          const response: DebugTimelineResponse = await getDebugTimeline();
          timelineEvents.value = response.events;
          timelineTotal.value = response.total;
        } catch (err) {
          const msg = err instanceof ApiError ? err.message : 'Failed to fetch debug timeline';
          log.error('fetchTimeline', msg);
          throw err;
        }
      })(),
    ]);

    const failures = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason instanceof ApiError ? r.reason.message : 'Failed to fetch debug data'));

    if (failures.length > 0) {
      error.value = failures.length >= 3 ? 'Failed to fetch debug data' : failures.join('; ');
    }

    loading.value = false;
  }

  function setActiveTab(tab: 'state' | 'errors' | 'timeline' | 'supervision'): void {
    activeTab.value = tab;
  }

  let wsUnsubscribe: (() => void) | null = null;

  function setupWsListener(): void {
    if (wsUnsubscribe) return;
    const ws = useWsStore();

    wsUnsubscribe = ws.onType('status', (envelope) => {
      const content = envelope.content || {};
      const event = content.event as string;

      timelineEvents.value = [
        {
          kind: `ws:${event}`,
          card_id: content.cardId as string | undefined,
          timestamp: new Date().toISOString(),
          ...content,
        },
        ...timelineEvents.value,
      ].slice(0, 500);

      if (event === 'error' && content.message) {
        errors.value = [
          {
            source: content.source as string || 'runtime',
            type: content.errorType as string || 'runtime-error',
            severity: content.severity as string || 'error',
            message: content.message as string,
            details: content.details as string | undefined,
            timestamp: new Date().toISOString(),
          },
          ...errors.value,
        ].slice(0, 200);
      }
    });
  }

  return {
    debugRuntime: readonly(debugRuntime),
    debugCards: readonly(debugCards),
    debugTotalCards: readonly(debugTotalCards),
    errors: readonly(errors),
    errorsTotal: readonly(errorsTotal),
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
    fetchDoctor,
    fetchSupervision,
    fetchAll,
    setActiveTab,
    setupWsListener,
  };
});
