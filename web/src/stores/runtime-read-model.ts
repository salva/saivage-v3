import type {
  RuntimeStatus,
  ServerAvailability,
  WsConnectionState,
} from '../api/types';

export function selectRuntimeStatusLabel(options: { loaded: boolean; statusSnapshot: { runtime: RuntimeStatus } | null }): string {
  if (!options.loaded) return 'unknown';
  return options.statusSnapshot?.runtime ?? 'stopped';
}

export function selectStatusCurrentCardId(statusSnapshot: { currentCardId: string | null } | null): string | null {
  return statusSnapshot?.currentCardId ?? null;
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
  if (runtimeComponent.state === 'degraded') parts.push(runtimeComponent.diagnostic?.summary ?? 'Runtime availability is degraded.');
  else if (runtimeComponent.state === 'unknown') parts.push('Runtime availability is unknown.');
  if (mcpComponent.state === 'degraded') parts.push(mcpComponent.diagnostic?.summary ?? 'MCP manager is degraded or empty.');
  else if (mcpComponent.state === 'unknown') parts.push('MCP availability is unknown.');
  return parts.length > 0 ? parts.join(' ') : null;
}

export function selectLifecycleGuidance(options: {
  loaded: boolean;
  unauthorized: boolean;
  status: RuntimeStatus | null;
}): { description: string; detail: string } | null {
  if (!options.loaded || options.unauthorized || options.status === null) return null;
  const qualification = 'Operations recheck current state and their own permissions; other holds may still refuse them.';
  const controls = 'Use the enabled Analyst conversation or configured external runtime controls.';
  let description: string;
  let detail: string;
  switch (options.status) {
    case 'running':
      description = 'Last observed lifecycle: Running. Ordinary Analyst record edits are unavailable.';
      detail = `Request Pause and wait for observed Paused before requesting edits. Running already has a Run; no new Start is needed. ${controls}`;
      break;
    case 'pausing':
      description = 'Last observed lifecycle: Pausing. Cooperative Pause is requested, not settled; ordinary Analyst record edits remain unavailable.';
      detail = 'Autonomous execution parks at its next provider-admission frontier. Already-admitted provider attempts/retries, tools and processes may continue; the wait has no time bound. Resume is for settled Paused, not a way to skip Pausing.';
      break;
    case 'paused':
      description = 'Last observed lifecycle: Paused. Ordinary Analyst record edits may be requested, subject to current per-operation admission.';
      detail = `Autonomous execution is parked at the provider frontier; this does not mean all processes or global work have stopped. Request Resume to continue the same Run, not a new Run/Start. ${controls}`;
      break;
    case 'stopped':
      description = 'Last observed lifecycle: Stopped. Ordinary Analyst record edits may be requested, subject to current per-operation admission.';
      detail = `Start is a separate authorized operation, not Resume, and has its own admission rules. ${controls}`;
      break;
    case 'starting':
    case 'closing':
    case 'error':
      description = `Last observed lifecycle: ${selectRuntimeModeLabel({ statusLabel: options.status })}. Ordinary Analyst record-edit intervention is unavailable.`;
      detail = options.status === 'error'
        ? 'Inspect System for recovery evidence. Pause or Resume is not an automatic remedy.'
        : 'Pause or Resume is not an automatic remedy.';
      break;
  }
  return { description, detail: `${detail} ${qualification}` };
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
