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
  NoteQueueEntry,
  NotesListResponse,
  NotificationRecord,
  NotificationsListResponse,
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
  terminateProcess,
  listNotes,
  acknowledgeNote,
  deleteNote,
  clearAllNotes,
  pauseRuntime,
  resumeRuntime,
  listNotifications,
  acknowledgeNotification,
  listControlActions,
  ApiError,
} from '../api/client';
import { useWsStore } from './ws';
import { createLogger } from '../utils/logger';

const log = createLogger('store:debug');
const OPERATOR_STALE_AGE_MS = 60_000;

const FAILURE_EVENT_KIND_RE = /^invocation_failed$|_error$|_failed$/;

function eventFieldAsString(event: DebugTimelineEvent, field: string): string | null {
  const value = event[field];
  return typeof value === 'string' && value.trim() ? value : null;
}

function isErrorTimelineEvent(event: DebugTimelineEvent): boolean {
  return FAILURE_EVENT_KIND_RE.test(event.kind) || Boolean(eventFieldAsString(event, 'error_message') || eventFieldAsString(event, 'error'));
}

function errorMessageFromEvent(event: DebugTimelineEvent): string {
  return eventFieldAsString(event, 'error_message')
    || eventFieldAsString(event, 'error')
    || eventFieldAsString(event, 'message')
    || `${event.kind} event recorded`;
}

function sessionFromEvent(event: DebugTimelineEvent): string {
  return eventFieldAsString(event, 'session_id') || 'unknown-session';
}

function minuteBucket(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return timestamp.slice(0, 16);
  parsed.setSeconds(0, 0);
  return parsed.toISOString();
}

function eventErrorDetails(event: DebugTimelineEvent): string | undefined {
  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (['id', 'kind', 'timestamp', 'session_id', 'error_message', 'error', 'message'].includes(key)) continue;
    if (value === undefined || value === null) continue;
    details[key] = value;
  }
  return Object.keys(details).length > 0 ? JSON.stringify(details, null, 2) : undefined;
}


function operatorErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) {
      return 'Unauthorized. Provide a valid Saivage API token and refresh the page.';
    }
    if (err.status === 503) {
      return 'Runtime control is unavailable because runtime state is not initialized. Start the runtime or restore runtime state first.';
    }
    if (err.status === 400 && err.body.action === 'resume-from-freeze') {
      return 'Runtime is frozen. Generic resume is blocked. Use the resume-from-freeze workflow to restore from the freeze manifest before resuming dispatch.';
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
    blocks: string[];
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

  const operatorNotes = ref<NoteQueueEntry[]>([]);
  const operatorNotesTotal = ref(0);
  const operatorNotesLoading = ref(false);
  const operatorNotesError = ref<string | null>(null);

  const serverNotifications = ref<NotificationRecord[]>([]);
  const notificationsLoading = ref(false);
  const notificationsError = ref<string | null>(null);
  const notificationsState = ref<'idle' | 'success' | 'empty' | 'unauthorized' | 'error'>('idle');
  const notificationActionLoading = ref<Record<string, boolean>>({});

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

  const pendingConfirmations = computed(() => {
    return controlActions.value.filter((entry) => entry.outcome === 'rejected' && entry.outcome_summary.toLowerCase().includes('preview-only'));
  });

  const eventDerivedErrors = computed<DebugError[]>(() =>
    timelineEvents.value
      .filter(isErrorTimelineEvent)
      .map((event) => ({
        source: sessionFromEvent(event),
        type: event.kind,
        severity: event.kind === 'invocation_failed' || event.kind.endsWith('_failed') ? 'warning' : 'error',
        message: errorMessageFromEvent(event),
        details: eventErrorDetails(event),
        timestamp: event.timestamp,
      })),
  );

  const combinedErrors = computed<DebugError[]>(() => [...errors.value, ...eventDerivedErrors.value]);

  const errorsBySource = computed<Map<string, DebugError[]>>(() => {
    const map = new Map<string, DebugError[]>();
    for (const e of combinedErrors.value) {
      const list = map.get(e.source);
      if (list) list.push(e); else map.set(e.source, [e]);
    }
    for (const list of map.values()) {
      list.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    }
    return map;
  });

  const errorsBySeverity = computed<Map<string, DebugError[]>>(() => {
    const map = new Map<string, DebugError[]>();
    for (const e of combinedErrors.value) {
      const list = map.get(e.severity);
      if (list) list.push(e); else map.set(e.severity, [e]);
    }
    return map;
  });

  const sortedTimeline = computed<DebugTimelineEvent[]>(() =>
    [...timelineEvents.value].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()),
  );

  const eventNotificationRollups = computed<NotificationRecord[]>(() => {
    const buckets = new Map<string, { sessionId: string; minute: string; count: number; latest: DebugTimelineEvent }>();
    for (const event of timelineEvents.value.filter(isErrorTimelineEvent)) {
      const sessionId = sessionFromEvent(event);
      const minute = minuteBucket(event.timestamp);
      const key = `${sessionId}:${minute}`;
      const existing = buckets.get(key);
      if (!existing) {
        buckets.set(key, { sessionId, minute, count: 1, latest: event });
      } else {
        existing.count += 1;
        if (new Date(event.timestamp).getTime() >= new Date(existing.latest.timestamp).getTime()) existing.latest = event;
      }
    }
    return Array.from(buckets.values()).map((bucket) => ({
      id: `event-rollup:${bucket.sessionId}:${bucket.minute}`,
      session_id: bucket.sessionId,
      kind: 'runtime_error' as NotificationRecord['kind'],
      severity: 'warn' as NotificationRecord['severity'],
      payload_summary: `${bucket.count} failure/error event${bucket.count === 1 ? '' : 's'} for ${bucket.sessionId}: ${errorMessageFromEvent(bucket.latest)}`,
      source_actor: 'system' as NotificationRecord['source_actor'],
      source_surface: 'runtime' as NotificationRecord['source_surface'],
      created_at: bucket.latest.timestamp,
      delivered_at: null,
      acknowledged_at: null,
    }));
  });

  const notifications = computed<NotificationRecord[]>(() => [...serverNotifications.value, ...eventNotificationRollups.value]);
  const notificationsTotal = computed(() => notifications.value.length);

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

  const operatorDataFreshnessLabel = computed(() => {
    if (!operatorLastFetchedAt.value) return null;
    const ageMs = Date.now() - new Date(operatorLastFetchedAt.value).getTime();
    if (Number.isNaN(ageMs)) return null;
    return ageMs > OPERATOR_STALE_AGE_MS ? 'stale' : 'fresh';
  });

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
      errors.value = response.errors;
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

  async function terminateOperatorProcess(processId: string): Promise<void> {
    processTerminateLoading.value = { ...processTerminateLoading.value, [processId]: true };
    processControlError.value = null;
    processControlSuccess.value = null;
    try {
      const response = await terminateProcess(processId);
      upsertProcess(response.process);
      processUnauthorized.value = false;
      processStale.value = false;
      processControlSuccess.value = response.message;
      await fetchProcesses();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          processUnauthorized.value = true;
          processControlError.value = 'Unauthorized. Provide a valid Saivage API token and refresh the page.';
        } else if (err.status === 404) {
          processControlError.value = `Process ${processId} was not found. Refreshing process list.`;
          processStale.value = true;
          await fetchProcesses();
        } else if (err.status === 409 || err.status === 503) {
          const process = err.body['process'] as ProcessView | undefined;
          if (process) upsertProcess(process);
          if (err.status === 409) {
            processControlError.value = 'Process has already ended. Refreshing process list.';
            processStale.value = false;
            await fetchProcesses();
          } else {
            processControlError.value = 'Process is recorded as running, but this server has no live child process attached. Refresh, then inspect host process state before manual cleanup.';
            processStale.value = true;
          }
        } else {
          processControlError.value = err.message || 'Process control request failed.';
          processStale.value = true;
        }
      } else {
        processControlError.value = 'Process control request failed.';
        processStale.value = true;
      }
    } finally {
      const next = { ...processTerminateLoading.value };
      delete next[processId];
      processTerminateLoading.value = next;
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

  async function fetchNotes(): Promise<void> {
    operatorNotesLoading.value = true;
    operatorNotesError.value = null;
    try {
      const response: NotesListResponse = await listNotes();
      operatorNotes.value = response.notes;
      operatorNotesTotal.value = response.total;
      operatorUnauthorized.value = false;
      if (!runtimeControlLoading.value && !operatorStale.value) runtimeControlError.value = null;
    } catch (err) {
      const msg = operatorErrorMessage(err);
      operatorNotesError.value = msg;
      if (err instanceof ApiError && err.status === 401) {
        operatorUnauthorized.value = true;
        runtimeControlError.value = msg;
      }
      log.error('fetchNotes', msg);
      throw err;
    } finally {
      operatorNotesLoading.value = false;
    }
  }

  async function fetchNotifications(): Promise<void> {
    notificationsLoading.value = true;
    notificationsError.value = null;
    try {
      const response: NotificationsListResponse = await listNotifications();
      serverNotifications.value = response.notifications;
      notificationsState.value = notifications.value.length === 0 ? 'empty' : 'success';
    } catch (err) {
      notificationsError.value = operatorErrorMessage(err);
      notificationsState.value = buildPanelState(err);
      throw err;
    } finally {
      notificationsLoading.value = false;
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
    const hadPriorData = operatorNotes.value.length > 0 || notifications.value.length > 0 || controlActions.value.length > 0 || debugRuntime.value !== null || operatorLastFetchedAt.value !== null;

    const [notesResult, stateResult, notificationsResult, controlActionsResult] = await Promise.allSettled([
      fetchNotes(),
      fetchState(),
      fetchNotifications(),
      fetchControlActions(),
    ]);

    const failures = [notesResult, stateResult, notificationsResult, controlActionsResult].filter((result) => result.status === 'rejected');
    if (failures.length === 0) {
      operatorStale.value = false;
      operatorLastFetchedAt.value = new Date().toISOString();
      return;
    }

    if (hadPriorData) operatorStale.value = true;
    operatorPartialWarning.value = 'This panel may be stale. Refresh to reconcile with server state.';
    if (failures.length < 4) operatorLastFetchedAt.value = new Date().toISOString();
  }

  async function acknowledgeOperatorNote(noteId: string): Promise<void> {
    runtimeControlError.value = null;
    runtimeControlSuccess.value = null;
    operatorNoteActionLoading.value = { ...operatorNoteActionLoading.value, [noteId]: 'acknowledge' };
    try {
      await acknowledgeNote(noteId);
      operatorNotes.value = operatorNotes.value.filter((entry) => entry.note_id !== noteId);
      operatorNotesTotal.value = operatorNotes.value.length;
      operatorUnauthorized.value = false;
      operatorStale.value = false;
      markOperatorSuccess('Note acknowledged.');
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        operatorStale.value = true;
        markOperatorError('That note is no longer in the unhandled queue. Refreshing notes.');
        await fetchNotes().catch(() => {});
      } else if (err instanceof ApiError && err.status === 401) {
        operatorUnauthorized.value = true;
        markOperatorError('Unauthorized. Provide a valid Saivage API token and refresh the page.');
      } else {
        markOperatorError(operatorErrorMessage(err));
      }
    } finally {
      const next = { ...operatorNoteActionLoading.value };
      delete next[noteId];
      operatorNoteActionLoading.value = next;
    }
  }

  async function deleteOperatorNote(noteId: string): Promise<void> {
    runtimeControlError.value = null;
    runtimeControlSuccess.value = null;
    operatorNoteActionLoading.value = { ...operatorNoteActionLoading.value, [noteId]: 'delete' };
    try {
      await deleteNote(noteId);
      operatorNotes.value = operatorNotes.value.filter((entry) => entry.note_id !== noteId);
      operatorNotesTotal.value = operatorNotes.value.length;
      operatorUnauthorized.value = false;
      operatorStale.value = false;
      markOperatorSuccess('Note deleted.');
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        operatorStale.value = true;
        markOperatorError('That note is no longer in the unhandled queue. Refreshing notes.');
        await fetchNotes().catch(() => {});
      } else if (err instanceof ApiError && err.status === 400) {
        operatorStale.value = true;
        markOperatorError('This note was already handled. Refreshing notes.');
        await fetchNotes().catch(() => {});
      } else if (err instanceof ApiError && err.status === 401) {
        operatorUnauthorized.value = true;
        markOperatorError('Unauthorized. Provide a valid Saivage API token and refresh the page.');
      } else {
        markOperatorError(operatorErrorMessage(err));
      }
    } finally {
      const next = { ...operatorNoteActionLoading.value };
      delete next[noteId];
      operatorNoteActionLoading.value = next;
    }
  }

  async function clearOperatorNotes(): Promise<void> {
    runtimeControlError.value = null;
    runtimeControlSuccess.value = null;
    operatorClearLoading.value = true;
    try {
      const response = await clearAllNotes();
      operatorNotes.value = [];
      operatorNotesTotal.value = 0;
      operatorUnauthorized.value = false;
      operatorStale.value = false;
      markOperatorSuccess(`Cleared ${response.deleted} unhandled notes.`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) operatorUnauthorized.value = true;
      markOperatorError(operatorErrorMessage(err));
    } finally {
      operatorClearLoading.value = false;
    }
  }

  async function acknowledgeOperatorNotification(notificationId: string): Promise<void> {
    notificationActionLoading.value = { ...notificationActionLoading.value, [notificationId]: true };
    try {
      await acknowledgeNotification(notificationId);
      serverNotifications.value = serverNotifications.value.filter((item) => item.id !== notificationId);
      notificationsState.value = notifications.value.length === 0 ? 'empty' : 'success';
    } catch (err) {
      notificationsError.value = operatorErrorMessage(err);
      notificationsState.value = buildPanelState(err);
    } finally {
      const next = { ...notificationActionLoading.value };
      delete next[notificationId];
      notificationActionLoading.value = next;
    }
  }

  async function pauseOperatorRuntime(): Promise<void> {
    runtimeControlLoading.value = 'pause';
    runtimeControlError.value = null;
    runtimeControlSuccess.value = null;
    try {
      await pauseRuntime();
      operatorUnauthorized.value = false;
      markOperatorSuccess('Runtime pause requested successfully.');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) operatorUnauthorized.value = true;
      markOperatorError(operatorErrorMessage(err));
    } finally {
      runtimeControlLoading.value = null;
      await fetchState().catch(() => {});
    }
  }

  async function resumeOperatorRuntime(): Promise<void> {
    runtimeControlLoading.value = 'resume';
    runtimeControlError.value = null;
    runtimeControlSuccess.value = null;
    try {
      await resumeRuntime();
      operatorUnauthorized.value = false;
      markOperatorSuccess('Runtime resume requested successfully.');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) operatorUnauthorized.value = true;
      markOperatorError(operatorErrorMessage(err));
    } finally {
      runtimeControlLoading.value = null;
      await fetchState().catch(() => {});
    }
  }

  async function fetchAll(): Promise<void> {
    loading.value = true;
    error.value = null;

    const results = await Promise.allSettled([
      (async () => {
        const response: DebugStateResponse = await getDebugState();
        debugRuntime.value = response.runtime;
        debugCards.value = response.cards;
        debugTotalCards.value = response.totalCards;
      })(),
      (async () => {
        const response: DebugErrorsResponse = await getDebugErrors();
        errors.value = response.errors;
        errorsTotal.value = response.total;
      })(),
      (async () => {
        const response: DebugTimelineResponse = await getDebugTimeline();
        timelineEvents.value = response.events;
        timelineTotal.value = response.total;
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

    wsUnsubscribe = ws.onType('activity', (envelope) => {
      const content = envelope.content || {};
      const event = content.event as string;

      timelineEvents.value = [{ kind: `ws:${event}`, card_id: content.cardId as string | undefined, timestamp: new Date().toISOString(), ...content }, ...timelineEvents.value].slice(0, 500);

      if (event === 'notification_added' || event === 'notification_acknowledged') {
        void fetchNotifications().catch(() => {});
      }
      if (event === 'control_action_recorded') {
        void fetchControlActions().catch(() => {});
      }
      if (event === 'error' && content.message) {
        errors.value = [{
          source: content.source as string || 'runtime',
          type: content.errorType as string || 'runtime-error',
          severity: content.severity as string || 'error',
          message: content.message as string,
          details: content.details as string | undefined,
          timestamp: new Date().toISOString(),
        }, ...errors.value].slice(0, 200);
      }
    });
  }

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
    operatorNotes: readonly(operatorNotes),
    operatorNotesTotal: readonly(operatorNotesTotal),
    operatorNotesLoading: readonly(operatorNotesLoading),
    operatorNotesError: readonly(operatorNotesError),
    notifications: readonly(notifications),
    notificationsTotal: readonly(notificationsTotal),
    notificationsLoading: readonly(notificationsLoading),
    notificationsError: readonly(notificationsError),
    notificationsState: readonly(notificationsState),
    notificationActionLoading: readonly(notificationActionLoading),
    controlActions: readonly(controlActions),
    controlActionsTotal: readonly(controlActionsTotal),
    controlActionsLoading: readonly(controlActionsLoading),
    controlActionsError: readonly(controlActionsError),
    controlActionsState: readonly(controlActionsState),
    pendingConfirmations,
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
    terminateOperatorProcess,
    fetchDoctor,
    fetchSupervision,
    fetchNotes,
    fetchNotifications,
    fetchControlActions,
    fetchOperatorControl,
    acknowledgeOperatorNote,
    deleteOperatorNote,
    clearOperatorNotes,
    acknowledgeOperatorNotification,
    pauseOperatorRuntime,
    resumeOperatorRuntime,
    fetchAll,
    setActiveTab,
    setupWsListener,
  };
});
