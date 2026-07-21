import { getEventSeverity, type EventKind } from '@saivage/schemas/event-catalog';
import type { DebugErrorRecord, DebugTimelineEvent, DoctorCheck, DoctorIssue, ProcessView, RuntimeState } from '../api/types';
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
  const projected = projectTimelineEvent(error);
  const source = error.kind === 'runtime_diagnostic'
    ? error.card_id ?? error.goal_id ?? error.phase ?? 'runtime'
    : error.kind === 'runtime_actionable_error'
      ? error.actionable_error.cardId ?? error.actionable_error.sessionId ?? 'runtime'
      : `mcp:${error.server}`;
  const message = error.kind === 'runtime_diagnostic'
    ? error.error_message
    : error.kind === 'runtime_actionable_error'
      ? error.actionable_error.message
      : error.error ?? `MCP tool ${error.tool} invocation failed`;
  return {
    id: error.id,
    source,
    type: error.kind === 'runtime_diagnostic' ? error.phase ?? error.kind : error.kind,
    severity: getEventSeverity(error.kind),
    message: redactObservabilityText(message),
    details: serializedDetails(projected.details),
    timestamp: error.timestamp,
  };
}

export function projectTimelineEvent(event: DebugTimelineEvent): DebugTimelineItem {
  const { id, kind, timestamp, ...details } = event;
  const card_id = event.kind === 'runtime_diagnostic' ? event.card_id : undefined;
  const goal_id = event.kind === 'runtime_diagnostic' ? event.goal_id : undefined;
  return {
    id,
    kind,
    timestamp,
    ...(card_id === undefined ? {} : { cardId: card_id }),
    ...(goal_id === undefined ? {} : { goalId: goal_id }),
    details: redactObservabilityValue(details),
  };
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
