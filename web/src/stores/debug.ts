/**
 * Pinia store for debug information.
 *
 * Exposes errors, timeline, process, doctor, and content-supervision
 * diagnostics. All data is read-only
 * for inspection purposes — actions should link back to the
 * relevant card or process.
 */

import { defineStore } from 'pinia';
import { ref, computed, readonly } from 'vue';
import type {
  DebugError,
  DebugTimelineEvent,
  DebugErrorsResponse,
  DebugTimelineResponse,
  DoctorCheck,
  DoctorIssue,
  DoctorResponse,
  ContentReview,
  SupervisionStats,
  SupervisionResponse,
  ProcessView,
  ProcessListResponse,
} from '../api/types';
import {
  getDebugErrors,
  getDebugTimeline,
  getDoctor,
  getDebugSupervision,
  listProcesses,
  ApiError,
} from '../api/client';
import { createLogger } from '../utils/logger';
import { redactObservabilityValue } from '../utils/observabilityRedaction';
import {
  selectErrorsBySource,
  selectSortedTimeline,
  selectTimelineDerivedErrors,
} from './debug-read-model';

const log = createLogger('store:debug');

export const useDebugStore = defineStore('debug', () => {
  const errors = ref<DebugError[]>([]);
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
  const supervisionStats = ref<SupervisionStats | null>(null);
  const supervisionLoading = ref(false);
  const supervisionError = ref<string | null>(null);

  const loading = ref(false);
  const error = ref<string | null>(null);


  const eventDerivedErrors = computed<DebugError[]>(() => selectTimelineDerivedErrors(timelineEvents.value));

  const combinedErrors = computed<DebugError[]>(() => [...errors.value, ...eventDerivedErrors.value]);

  const errorsBySource = computed<Map<string, DebugError[]>>(() => selectErrorsBySource(combinedErrors.value));

  const sortedTimeline = computed<DebugTimelineEvent[]>(() => selectSortedTimeline(timelineEvents.value));

  async function fetchErrors(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const response: DebugErrorsResponse = await getDebugErrors();
      errors.value = response.errors.map((entry) => redactObservabilityValue(entry));
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
      fetchErrors(),
      fetchTimeline(),
    ]);

    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => (result.reason instanceof ApiError ? result.reason.message : 'Failed to fetch debug data'));

    if (failures.length > 0) {
      error.value = failures.length >= 2 ? 'Failed to fetch debug data' : failures.join('; ');
    }

    loading.value = false;
  }

  const refetch = fetchAll;
  const refetchTimeline = fetchTimeline;
  const refetchProcesses = fetchProcesses;

  return {
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
    supervisionStats: readonly(supervisionStats),
    supervisionLoading: readonly(supervisionLoading),
    supervisionError: readonly(supervisionError),
    loading: readonly(loading),
    error: readonly(error),
    errorsBySource,
    sortedTimeline,
    fetchErrors,
    fetchTimeline,
    fetchProcesses,
    refetchTimeline,
    refetchProcesses,
    fetchDoctor,
    fetchSupervision,
    fetchAll,
    refetch,
  };
});
