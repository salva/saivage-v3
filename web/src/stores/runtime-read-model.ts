import type {
  ActionableErrorEnvelope,
  RuntimeState,
  RuntimeStatus,
  ServerAvailability,
  WsConnectionState,
} from '../api/types';

export interface RuntimeSummaryProjection {
  lastActionableError: ActionableErrorEnvelope | null;
}

export type LiveUpdateState = 'live' | 'connecting' | 'offline' | 'unauthorized' | 'no-token' | 'stale';

/** Selects raw runtime summary state; presentation labels are derived by selectRuntimeStatusLabel/selectRuntimeModeLabel. */
export function selectRuntimeSummary(runtime: RuntimeState | null): RuntimeSummaryProjection {
  if (!runtime) {
    return {
      lastActionableError: null,
    };
  }

  return {
    lastActionableError: null,
  };
}

export function selectRuntimeStatusLabel(runtime: RuntimeState | null): string {
  if (!runtime) return 'unknown';
  return runtime.status;
}

export function selectCurrentCardId(runtime: RuntimeState | null): string | null {
  return runtime?.current_card_id ?? null;
}

export function selectRuntimeStatusTone(runtime: RuntimeState | null): string {
  const label = selectRuntimeStatusLabel(runtime);
  if (label === 'error') return 'danger';
  if (label === 'paused') return 'warning';
  if (label === 'running') return 'success';
  return 'neutral';
}

export function selectRuntimeModeLabel(options: { statusLabel: string }): string {
  return options.statusLabel === 'unknown'
    ? 'Unknown'
    : options.statusLabel.charAt(0).toUpperCase() + options.statusLabel.slice(1);
}

export function selectAvailabilityDetail(availability: ServerAvailability | null): string | null {
  if (!availability) return null;
  const runtimeComponent = availability.components.runtime;
  const mcpComponent = availability.components.mcp;
  const parts: string[] = [];
  if (runtimeComponent.state === 'unavailable') parts.push(`Runtime unavailable: ${runtimeComponent.diagnostic?.summary ?? runtimeComponent.source}.`);
  else if (runtimeComponent.state === 'degraded') parts.push(runtimeComponent.diagnostic?.summary ?? 'Runtime availability is degraded.');
  else if (runtimeComponent.state === 'unknown') parts.push('Runtime startup availability is unknown.');
  if (mcpComponent.state === 'unavailable') parts.push(`MCP unavailable: ${mcpComponent.diagnostic?.summary ?? mcpComponent.source}.`);
  else if (mcpComponent.state === 'degraded') parts.push(mcpComponent.diagnostic?.summary ?? 'MCP manager is degraded or empty.');
  else if (mcpComponent.state === 'unknown') parts.push('MCP startup availability is unknown.');
  return parts.length > 0 ? parts.join(' ') : null;
}

export function selectRuntimeDetail(options: {
  unauthorized: boolean;
  runtime: RuntimeState | null;
  stale: boolean;
  status: RuntimeStatus;
  availabilityDetail: string | null;
}): string {
  if (options.unauthorized) return 'Runtime snapshot unavailable until a valid API token is provided.';
  if (options.status === 'error') return 'Runtime reported an error state. Inspect Debug for recovery evidence.';
  if (options.status === 'paused') return 'Runtime is paused. Ask the Analyst to Run when work should continue.';
  if (options.stale) return 'Runtime snapshot is stale. Refresh to resync with the authoritative REST state.';
  if (!options.runtime) return options.availabilityDetail ?? 'Runtime state has not been loaded yet.';
  return options.availabilityDetail ?? 'REST snapshot is authoritative; live updates may accelerate status changes.';
}

export function selectLiveUpdateState(options: {
  connectionState: WsConnectionState;
  unauthorized: boolean;
  stale: boolean;
  wsStale: boolean;
}): LiveUpdateState {
  if (options.connectionState === 'unauthorized' || options.unauthorized) return 'unauthorized';
  if (options.connectionState === 'no-token') return options.stale ? 'stale' : 'offline';
  if (options.connectionState === 'connecting') return 'connecting';
  if (options.connectionState === 'offline') return options.stale ? 'stale' : 'offline';
  if (options.stale || options.wsStale) return 'stale';
  return 'live';
}

export function selectLiveUpdateLabel(state: LiveUpdateState): string {
  switch (state) {
    case 'live': return 'Live updates connected';
    case 'connecting': return 'Live updates reconnecting';
    case 'offline': return 'Live updates offline';
    case 'unauthorized': return 'Live updates unauthorized';
    case 'no-token': return 'Live updates offline';
    case 'stale': return 'Live updates stale';
  }
}

export function selectLiveUpdateDetail(state: LiveUpdateState): string {
  switch (state) {
    case 'live': return 'WebSocket is connected. REST remains the source of truth after refresh/reconnect.';
    case 'connecting': return 'Trying to reconnect WebSocket live updates.';
    case 'offline': return 'Using the last REST snapshot only until live updates reconnect.';
    case 'unauthorized': return 'Token was rejected for API/WebSocket access.';
    case 'no-token': return 'Using the last REST snapshot only until live updates reconnect.';
    case 'stale': return 'Live updates have gone quiet; refresh to confirm current runtime truth.';
  }
}
