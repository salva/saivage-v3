import type {
  RuntimeState,
  RuntimeStatus,
  ServerAvailability,
  WsConnectionState,
} from '../api/types';

export function selectRuntimeStatusLabel(options: { loaded: boolean; runtime: RuntimeState | null }): string {
  if (!options.loaded) return 'unknown';
  return options.runtime?.status ?? 'stopped';
}

export function selectCurrentCardId(runtime: RuntimeState | null): string | null {
  return runtime?.current_card_id ?? null;
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
  loaded: boolean;
  unauthorized: boolean;
  runtime: RuntimeState | null;
  status: RuntimeStatus | null;
  availabilityDetail: string | null;
}): string {
  if (options.unauthorized) return 'Runtime snapshot unavailable until a valid API token is provided.';
  if (!options.loaded) return 'Runtime state has not been loaded yet.';
  if (!options.runtime) return 'No live runtime.';
  if (options.status === 'error') return 'Runtime reported an error state. Inspect Debug for recovery evidence.';
  if (options.status === 'paused') return 'Runtime is paused. Ask the Analyst to Run when work should continue.';
  return options.availabilityDetail ?? 'Runtime snapshot comes from the latest accepted REST response.';
}

export function selectSocketLabel(state: WsConnectionState): string {
  switch (state) {
    case 'connected': return 'Connected';
    case 'connecting': return 'Connecting';
    case 'offline': return 'Offline';
    case 'unauthorized': return 'Unauthorized';
  }
}

export function selectSocketDetail(state: WsConnectionState): string {
  switch (state) {
    case 'connected': return 'WebSocket invalidations are connected; displayed runtime data still comes from REST.';
    case 'connecting': return 'WebSocket is connecting or reconnecting.';
    case 'offline': return 'WebSocket invalidations are unavailable; accepted REST state remains visible.';
    case 'unauthorized': return 'WebSocket ticket or connection authorization was rejected.';
  }
}
