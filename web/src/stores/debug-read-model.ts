import type { CardRecord, DebugError, DebugTimelineEvent, ProcessView, RuntimeState } from '../api/types';
import { redactObservabilityText, redactObservabilityValue } from '../utils/observabilityRedaction';
import { selectChildrenOf } from './card-presentation';
import { selectRuntimeStatusLabel as selectSharedRuntimeStatusLabel, selectRuntimeStatusTone as selectSharedRuntimeStatusTone } from './runtime-read-model';
import { eventKindValues } from '@saivage/schemas/event-catalog';

const CANONICAL_EVENT_KINDS = new Set<string>(eventKindValues as readonly string[]);
export function isCanonicalEventKind(kind: string): boolean { return CANONICAL_EVENT_KINDS.has(kind); }
export function filterCanonicalEvents(events: DebugTimelineEvent[]): DebugTimelineEvent[] {
  return events.filter((event) => isCanonicalEventKind(event.kind));
}

const FAILURE_EVENT_KIND_RE = /^llm_attempt$|_error$|_failed$/;
export const OPERATOR_STALE_AGE_MS = 60_000;

function eventFieldAsString(event: DebugTimelineEvent, field: string): string | null {
  const value = event[field];
  return typeof value === 'string' && value.trim() ? redactObservabilityText(value) : null;
}

export function isErrorTimelineEvent(event: DebugTimelineEvent): boolean {
  return FAILURE_EVENT_KIND_RE.test(event.kind) || Boolean(eventFieldAsString(event, 'error_message') || eventFieldAsString(event, 'error'));
}

export function errorMessageFromEvent(event: DebugTimelineEvent): string {
  return eventFieldAsString(event, 'error_message')
    || eventFieldAsString(event, 'error')
    || eventFieldAsString(event, 'message')
    || `${event.kind} event recorded`;
}

export function sessionFromEvent(event: DebugTimelineEvent): string {
  return eventFieldAsString(event, 'session_id') || 'unknown-session';
}

export function eventErrorDetails(event: DebugTimelineEvent): string | undefined {
  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (['id', 'kind', 'timestamp', 'session_id', 'error_message', 'error', 'message'].includes(key)) continue;
    if (value === undefined || value === null) continue;
    details[key] = value;
  }
  const redacted = redactObservabilityValue(details);
  return Object.keys(redacted).length > 0 ? JSON.stringify(redacted, null, 2) : undefined;
}

export function selectTimelineDerivedErrors(events: DebugTimelineEvent[]): DebugError[] {
  return filterCanonicalEvents(events)
    .filter(isErrorTimelineEvent)
    .map((event) => ({
      source: sessionFromEvent(event),
      type: event.kind,
      severity: (event.kind === 'llm_attempt' && (event as { outcome?: { kind?: string } }).outcome?.kind === 'failed') || event.kind.endsWith('_failed') ? 'warning' : 'error',
      message: errorMessageFromEvent(event),
      details: eventErrorDetails(event),
      timestamp: event.timestamp,
    }));
}

export function selectErrorsBySource(errors: DebugError[]): Map<string, DebugError[]> {
  const map = new Map<string, DebugError[]>();
  for (const error of errors) {
    const list = map.get(error.source);
    if (list) list.push(error); else map.set(error.source, [error]);
  }
  for (const list of map.values()) {
    list.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }
  return map;
}

export function selectErrorsBySeverity(errors: DebugError[]): Map<string, DebugError[]> {
  const map = new Map<string, DebugError[]>();
  for (const error of errors) {
    const list = map.get(error.severity);
    if (list) list.push(error); else map.set(error.severity, [error]);
  }
  return map;
}

export function selectSortedTimeline(events: DebugTimelineEvent[]): DebugTimelineEvent[] {
  return filterCanonicalEvents(events)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

export function selectOperatorDataFreshnessLabel(lastFetchedAt: string | null, nowMs = Date.now()): 'fresh' | 'stale' | null {
  if (!lastFetchedAt) return null;
  const ageMs = nowMs - new Date(lastFetchedAt).getTime();
  if (Number.isNaN(ageMs)) return null;
  return ageMs > OPERATOR_STALE_AGE_MS ? 'stale' : 'fresh';
}

export interface CardStatusEntry { status: string; count: number }

export function selectCardStatusEntries(cards: ReadonlyArray<{ status: string }>): CardStatusEntry[] {
  const counts: Record<string, number> = {};
  for (const card of cards) counts[card.status] = (counts[card.status] || 0) + 1;
  return Object.entries(counts).map(([status, count]) => ({ status, count }));
}

export function selectMaxStatusCount(entries: CardStatusEntry[]): number {
  return Math.max(...entries.map((entry) => entry.count), 1);
}

export interface DebugCardChildrenProjection {
  cardId: string;
  children: CardRecord[];
}

export function selectDebugCardChildren(cards: CardRecord[], debugCardIds: string[]): DebugCardChildrenProjection[] {
  return debugCardIds.map((cardId) => ({ cardId, children: selectChildrenOf(cards, cardId) }));
}

export function selectRuntimeStatusLabel(runtime: RuntimeState | null): string {
  const label = selectSharedRuntimeStatusLabel(runtime);
  return label === 'unknown' ? 'Unavailable' : label.charAt(0).toUpperCase() + label.slice(1);
}

export function selectRuntimeStatusTone(runtime: RuntimeState | null): string {
  return runtime ? selectSharedRuntimeStatusTone(runtime) : 'unavailable';
}

export function selectSortedProcesses(processes: ReadonlyArray<ProcessView>): ProcessView[] {
  return [...processes].sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (a.status !== 'running' && b.status === 'running') return 1;
    return new Date(b.started_at).getTime() - new Date(a.started_at).getTime();
  });
}

export function selectTimelineKindOptions(events: DebugTimelineEvent[]): string[] {
  const present = new Set(events.map((event) => event.kind).filter(isCanonicalEventKind));
  return Array.from(present).sort();
}

export function filterTimelineByKinds(events: DebugTimelineEvent[], selectedKinds: string[]): DebugTimelineEvent[] {
  return selectedKinds.length === 0 ? events : events.filter((event) => selectedKinds.includes(event.kind));
}
