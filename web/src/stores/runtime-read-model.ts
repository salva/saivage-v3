import type {
  ActionableErrorEnvelope,
  CardIndex,
  RuntimeActivationRecord,
  RuntimeCommandRecord,
  RuntimeIntent,
  RuntimeRunRecord,
  RuntimeState,
  RuntimeStatus,
  ServerAvailability,
  WsConnectionState,
} from '../api/types';

export interface RuntimeSummaryProjection {
  intent: RuntimeIntent | null;
  currentRun: RuntimeRunRecord | null;
  activeChildRuns: RuntimeRunRecord[];
  activations: RuntimeActivationRecord[];
  lastCommand: RuntimeCommandRecord | null;
  lastActionableError: ActionableErrorEnvelope | null;
}

export interface RuntimeWsSummaryState extends RuntimeSummaryProjection {
  runtime: RuntimeState | null;
  cardIndex: CardIndex;
  serverAvailability: ServerAvailability | null;
  statusBeforePause: RuntimeStatus | null;
}

export interface RuntimeWsReduction {
  state: RuntimeWsSummaryState;
  shouldRefreshState: boolean;
}

export type LiveUpdateState = 'live' | 'connecting' | 'offline' | 'unauthorized' | 'no-token' | 'stale';

/** Selects raw runtime summary state; presentation labels are derived by selectRuntimeStatusLabel/selectRuntimeModeLabel. */
export function selectRuntimeSummary(runtime: RuntimeState | null): RuntimeSummaryProjection {
  if (!runtime) {
    return {
      intent: null,
      currentRun: null,
      activeChildRuns: [],
      activations: [],
      lastCommand: null,
      lastActionableError: null,
    };
  }

  const runs = runtime.runtime_runs ?? [];
  const currentRun = runs.find((run) => run.kind === 'root' && !run.finished_at)
    ?? runs.find((run) => run.kind === 'root')
    ?? null;
  const activeChildRuns = runs.filter((run) => run.kind === 'child' && !run.finished_at);
  const activations = runtime.runtime_activations ?? [];
  const commands = runtime.runtime_commands ?? [];
  const lastCommand = commands.length > 0 ? commands[commands.length - 1] : null;

  return {
    intent: runtime.runtime_intent ?? null,
    currentRun,
    activeChildRuns,
    activations,
    lastCommand,
    lastActionableError: lastCommand?.error ?? activations.find((activation) => activation.error)?.error ?? null,
  };
}

export function selectRuntimeStatusLabel(runtime: RuntimeState | null): string {
  if (!runtime) return 'unknown';
  if (runtime.status === 'frozen') return 'frozen';
  if (runtime.paused) return 'paused';
  return runtime.status;
}

export function selectRuntimeModeLabel(options: { frozen: boolean; paused: boolean; statusLabel: string }): string {
  if (options.frozen) return 'Frozen';
  if (options.paused) return 'Paused';
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
  else if (runtimeComponent.state === 'degraded') parts.push('Runtime is using persisted state fallback.');
  else if (runtimeComponent.state === 'unknown') parts.push('Runtime startup availability is unknown.');
  if (mcpComponent.state === 'unavailable') parts.push(`MCP unavailable: ${mcpComponent.diagnostic?.summary ?? mcpComponent.source}.`);
  else if (mcpComponent.state === 'degraded') parts.push(mcpComponent.diagnostic?.summary ?? 'MCP manager is degraded or empty.');
  else if (mcpComponent.state === 'unknown') parts.push('MCP startup availability is unknown.');
  return parts.length > 0 ? parts.join(' ') : null;
}

export function selectRuntimeDetail(options: {
  unauthorized: boolean;
  runtime: RuntimeState | null;
  frozen: boolean;
  paused: boolean;
  stale: boolean;
  status: RuntimeStatus;
  availabilityDetail: string | null;
}): string {
  if (options.unauthorized) return 'Runtime snapshot unavailable until a valid API token is provided.';
  if (options.frozen) return options.runtime?.frozen_reason || 'Runtime is frozen and needs operator attention.';
  if (options.status === 'error') return 'Runtime reported an error state. Inspect Debug for recovery evidence.';
  if (options.paused) return 'Runtime is paused. Use Runtime Console to resume active runs and activation edges when appropriate.';
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

export function upsertRuntimeRun(activeChildRuns: RuntimeRunRecord[], currentRun: RuntimeRunRecord | null, run: RuntimeRunRecord): Pick<RuntimeSummaryProjection, 'currentRun' | 'activeChildRuns'> {
  if (run.kind === 'root') {
    return {
      currentRun: run.finished_at ? (currentRun?.run_id === run.run_id ? run : currentRun) : run,
      activeChildRuns,
    };
  }
  const others = activeChildRuns.filter((existing) => existing.run_id !== run.run_id);
  return {
    currentRun,
    activeChildRuns: run.finished_at ? others : [...others, run],
  };
}

export function upsertRuntimeActivation(activations: RuntimeActivationRecord[], activation: RuntimeActivationRecord): RuntimeActivationRecord[] {
  return [
    ...activations.filter((existing) => existing.activation_id !== activation.activation_id),
    activation,
  ];
}

export function reduceRuntimeWsEvent(
  state: RuntimeWsSummaryState,
  content: Record<string, unknown>,
  knownContent: Record<string, unknown> | null | undefined,
): RuntimeWsReduction {
  const event = typeof content.event === 'string' ? content.event : '';
  let next: RuntimeWsSummaryState = { ...state };
  let shouldRefreshState = false;

  if (event === 'runtime-state') {
    if (content.runtime) {
      const runtime = content.runtime as RuntimeState;
      next = { ...next, runtime, ...selectRuntimeSummary(runtime) };
    }
    if (content.cardIndex) next.cardIndex = content.cardIndex as CardIndex;
    if ('serverAvailability' in content) next.serverAvailability = (content.serverAvailability ?? null) as ServerAvailability | null;
  }

  if ((event === 'runtime-paused' || event === 'runtime-resumed') && next.runtime) {
    const statusBeforePause = event === 'runtime-paused' && !next.runtime.paused
      ? next.runtime.status
      : next.statusBeforePause;
    const restoredStatus = event === 'runtime-resumed'
      ? (statusBeforePause ?? next.runtime.status)
      : 'paused';
    next = {
      ...next,
      statusBeforePause: event === 'runtime-resumed' ? null : statusBeforePause,
      runtime: {
        ...next.runtime,
        paused: event === 'runtime-paused',
        status: restoredStatus,
        paused_at: event === 'runtime-paused' ? new Date().toISOString() : null,
      },
    };
  }

  if (event === 'runtime.run' && content.run) {
    const updated = upsertRuntimeRun(next.activeChildRuns, next.currentRun, content.run as RuntimeRunRecord);
    next = { ...next, ...updated };
  }

  if (knownContent?.event === 'runtime.command') {
    const lastCommand = knownContent.command as RuntimeCommandRecord;
    next = { ...next, lastCommand, lastActionableError: lastCommand.error ?? next.lastActionableError };
  }
  if (knownContent?.event === 'runtime.activation') {
    const activation = knownContent.activation as RuntimeActivationRecord;
    next = {
      ...next,
      activations: upsertRuntimeActivation(next.activations, activation),
      lastActionableError: activation.error ?? next.lastActionableError,
    };
  }
  if (knownContent?.event === 'runtime.actionable_error') {
    next = { ...next, lastActionableError: knownContent.actionable_error as ActionableErrorEnvelope };
  }

  if (event === 'card-status-changed' && content.card) shouldRefreshState = true;

  return { state: next, shouldRefreshState };
}
