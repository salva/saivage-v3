import { getEventSeverity } from '@saivage/schemas/event-catalog';
import type { DebugErrorRecord, ProcessView, RuntimeState } from '../api/types';
import { redactObservabilityText, redactObservabilityValue } from '../utils/observabilityRedaction';
import { selectRuntimeModeLabel, selectRuntimeStatusLabel as selectSharedRuntimeStatusLabel } from './runtime-read-model';

export interface DebugErrorItem {
  id: string;
  source: string;
  type: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  details?: string;
  timestamp: string;
}

function serializedDetails(value: Record<string, unknown> | undefined): string | undefined {
  if (!value || Object.keys(value).length === 0) return undefined;
  return JSON.stringify(redactObservabilityValue(value), null, 2);
}

export function projectErrorRecord(error: DebugErrorRecord): DebugErrorItem {
  const { id: _id, kind: _kind, timestamp: _timestamp, ...details } = error;
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
    details: serializedDetails(details),
    timestamp: error.timestamp,
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

export function selectRuntimeStatusLabel(loaded: boolean, runtime: RuntimeState | null): string {
  return selectRuntimeModeLabel({ statusLabel: selectSharedRuntimeStatusLabel({ loaded, runtime }) });
}

export function selectSortedProcesses(processes: ReadonlyArray<ProcessView>): ProcessView[] {
  return [...processes].sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (a.status !== 'running' && b.status === 'running') return 1;
    return new Date(b.started_at).getTime() - new Date(a.started_at).getTime();
  });
}
