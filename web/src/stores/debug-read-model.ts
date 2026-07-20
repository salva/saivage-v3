import { getEventSeverity, type EventKind } from '@saivage/schemas/event-catalog';
import type { ContentReview, DebugErrorRecord, DebugTimelineEvent, DoctorCheck, DoctorIssue, ProcessView, RuntimeState } from '../api/types';
import { redactObservabilityText, redactObservabilityValue } from '../utils/observabilityRedaction';
import { selectRuntimeStatusLabel as selectSharedRuntimeStatusLabel } from './runtime-read-model';

export const OPERATOR_STALE_AGE_MS = 60_000;

export interface DebugErrorItem {
  id: string;
  source: string;
  type: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  details?: string;
  timestamp: string;
}

export interface DebugTimelineItem {
  id: string;
  kind: EventKind;
  timestamp: string;
  cardId?: string;
  goalId?: string;
  sessionId?: string;
  details: Record<string, unknown>;
}

function serializedDetails(value: Record<string, unknown> | undefined): string | undefined {
  if (!value || Object.keys(value).length === 0) return undefined;
  return JSON.stringify(redactObservabilityValue(value), null, 2);
}

export function projectErrorRecord(error: DebugErrorRecord): DebugErrorItem {
  return {
    id: error.id,
    source: error.cardId ?? error.goalId ?? error.phase ?? 'runtime',
    type: error.phase ?? error.kind,
    severity: 'error',
    message: redactObservabilityText(error.message),
    details: serializedDetails(error.metadata),
    timestamp: error.timestamp,
  };
}

export function projectTimelineEvent(event: DebugTimelineEvent): DebugTimelineItem {
  const { id, kind, timestamp, card_id, goal_id, session_id, ...details } = event;
  return {
    id,
    kind,
    timestamp,
    ...(card_id === undefined ? {} : { cardId: card_id }),
    ...(goal_id === undefined ? {} : { goalId: goal_id }),
    ...(typeof session_id !== 'string' ? {} : { sessionId: session_id }),
    details: redactObservabilityValue(details),
  };
}

function eventSource(event: DebugTimelineEvent): string {
  if (typeof event.session_id === 'string') return event.session_id;
  return event.card_id ?? event.goal_id ?? 'runtime';
}

function eventErrorItem(event: DebugTimelineEvent, message: string): DebugErrorItem {
  const timeline = projectTimelineEvent(event);
  return {
    id: event.id,
    source: eventSource(event),
    type: event.kind,
    severity: getEventSeverity(event.kind),
    message: redactObservabilityText(message),
    details: serializedDetails(timeline.details),
    timestamp: event.timestamp,
  };
}

function actionableErrorMessage(record: Record<string, unknown>): string {
  const message = record['message'];
  return typeof message === 'string' && message.trim().length > 0
    ? message
    : 'Runtime actionable error recorded';
}

export function projectTimelineError(event: DebugTimelineEvent): DebugErrorItem | null {
  switch (event.kind) {
    case 'runtime_diagnostic':
      return eventErrorItem(event, event.error_message);
    case 'runtime_actionable_error':
      return eventErrorItem(event, actionableErrorMessage(event.actionable_error));
    case 'subscriber_error':
      return eventErrorItem(event, event.error_message);
    case 'mcp_tool_invocation':
      return event.success ? null : eventErrorItem(event, event.error ?? `MCP tool ${event.tool} invocation failed`);
    case 'card_history_appended':
    case 'notification_added':
    case 'control_action_recorded':
    case 'analyst_tool_invoked':
    case 'conversation_changed':
    case 'control_action_record_appended':
    case 'event_log_record_appended':
    case 'error_log_record_appended':
      return null;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export function selectTimelineDerivedErrors(events: DebugTimelineEvent[]): DebugErrorItem[] {
  return events.flatMap((event) => {
    const item = projectTimelineError(event);
    return item === null ? [] : [item];
  });
}

export function selectErrorsBySource(errors: DebugErrorItem[]): Map<string, DebugErrorItem[]> {
  const map = new Map<string, DebugErrorItem[]>();
  for (const error of errors) {
    const list = map.get(error.source);
    if (list) list.push(error); else map.set(error.source, [error]);
  }
  for (const list of map.values()) list.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return map;
}

export function selectFailedChecks(checks: DoctorCheck[]): DoctorCheck[] {
  return checks.filter((check) => !check.passed);
}

export function selectDoctorIssuesBySeverity(issues: DoctorIssue[]): Map<'error' | 'warning', DoctorIssue[]> {
  const map = new Map<'error' | 'warning', DoctorIssue[]>();
  for (const issue of issues) {
    const list = map.get(issue.severity);
    if (list) list.push(issue); else map.set(issue.severity, [issue]);
  }
  return map;
}

export function selectReviewsByStatus(reviews: ContentReview[]): Map<string, ContentReview[]> {
  const map = new Map<string, ContentReview[]>();
  for (const review of reviews) {
    const list = map.get(review.status);
    if (list) list.push(review); else map.set(review.status, [review]);
  }
  return map;
}

export function selectSortedTimeline(events: DebugTimelineEvent[]): DebugTimelineItem[] {
  return events.map(projectTimelineEvent).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

export function selectOperatorDataFreshnessLabel(lastFetchedAt: string | null, nowMs = Date.now()): 'fresh' | 'stale' | null {
  if (!lastFetchedAt) return null;
  const ageMs = nowMs - new Date(lastFetchedAt).getTime();
  if (Number.isNaN(ageMs)) return null;
  return ageMs > OPERATOR_STALE_AGE_MS ? 'stale' : 'fresh';
}

export function selectRuntimeStatusLabel(runtime: RuntimeState | null): string {
  const label = selectSharedRuntimeStatusLabel(runtime);
  return label === 'unknown' ? 'Unavailable' : label.charAt(0).toUpperCase() + label.slice(1);
}

export function selectSortedProcesses(processes: ReadonlyArray<ProcessView>): ProcessView[] {
  return [...processes].sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (a.status !== 'running' && b.status === 'running') return 1;
    return new Date(b.started_at).getTime() - new Date(a.started_at).getTime();
  });
}

export function selectTimelineKindOptions(events: DebugTimelineItem[]): EventKind[] {
  return Array.from(new Set(events.map((event) => event.kind))).sort();
}

export function filterTimelineByKinds(events: DebugTimelineItem[], selectedKinds: EventKind[]): DebugTimelineItem[] {
  return selectedKinds.length === 0 ? events : events.filter((event) => selectedKinds.includes(event.kind));
}
