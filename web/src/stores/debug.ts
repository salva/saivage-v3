/**
 * Pinia store for debug information.
 *
 * Exposes errors, timeline, process, and Doctor
 * diagnostics. All data is read-only
 * for inspection purposes — actions should link back to the
 * relevant card or process.
 */

import { defineStore } from 'pinia';
import { ref, computed, readonly } from 'vue';
import type {
  DebugErrorRecord,
  DebugTimelineEvent,
  DebugErrorsResponse,
  EventsResponse,
  DoctorCheck,
  DoctorIssue,
  DoctorResponse,
  ProcessView,
  ProcessListResponse,
} from '../api/types';
import {
  getDebugErrors,
  getNewestEvents,
  getDoctor,
  listProcesses,
  ApiError,
} from '../api/client';
import { createLogger } from '../utils/logger';
import {
  projectErrorRecord,
  type DebugErrorItem,
  type DebugTimelineItem,
  selectErrorsBySource,
  selectSortedTimeline,
} from './debug-read-model';

const log = createLogger('store:debug');

export const useDebugStore = defineStore('debug', () => {
  const errors = ref<DebugErrorRecord[]>([]);
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

  const loading = ref(false);
  const error = ref<string | null>(null);


  const projectedErrors = computed<DebugErrorItem[]>(() => errors.value.map(projectErrorRecord));
  const errorsBySource = computed<Map<string, DebugErrorItem[]>>(() => selectErrorsBySource(projectedErrors.value));

  const sortedTimeline = computed<DebugTimelineItem[]>(() => selectSortedTimeline(timelineEvents.value));

  async function fetchErrors(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const response: DebugErrorsResponse = await getDebugErrors();
      errors.value = response.errors;
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
      const response: EventsResponse = await getNewestEvents();
      timelineEvents.value = response.events;
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

  async function refreshObservability(): Promise<void> {
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
      loading.value = false;
      throw results.find((result): result is PromiseRejectedResult => result.status === 'rejected')!.reason;
    }

    loading.value = false;
  }

  const refetchTimeline = refreshObservability;
  const refetchProcesses = fetchProcesses;

  return {
    errors: readonly(projectedErrors),
    errorsTotal: readonly(computed(() => projectedErrors.value.length)),
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
    refreshObservability,
  };
});
