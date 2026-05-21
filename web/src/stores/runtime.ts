/**
 * Pinia store for runtime state.
 *
 * Tracks the Saivage runtime snapshot plus command/run/activation summary state,
 * card index, and global pause state.
 * Subscribes to WebSocket status events for live updates.
 */

import { defineStore } from 'pinia';
import { ref, computed, readonly } from 'vue';
import type {
  RuntimeState,
  RuntimeStatus,
  CardIndex,
  CardStoreHealth,
  ServerAvailability,
  FreshnessState,
  RuntimeIntent,
  RuntimeRunRecord,
  RuntimeActivationRecord,
  RuntimeCommandRecord,
  ActionableErrorEnvelope,
} from '../api/types';
import {
  getRuntimeState,
  pauseRuntime,
  resumeRuntime,
  startProject as startProjectRequest,
  stopProject as stopProjectRequest,
  ApiError,
} from '../api/client';
import { getAuthToken } from '../api/auth';
import { useWsStore } from './ws';
import { createLogger } from '../utils/logger';
import { parseCoveredRuntimeStatusContent, parseKnownWsContent } from '../api/contracts';

const log = createLogger('store:runtime');
const STALE_AFTER_MS = 30_000;

function nowIso(): string {
  return new Date().toISOString();
}

export const useRuntimeStore = defineStore('runtime', () => {
  const runtime = ref<RuntimeState | null>(null);
  const cardIndex = ref<CardIndex>({ total: 0, byStatus: {}, byType: {} });
  const cardStoreHealth = ref<CardStoreHealth | null>(null);
  const serverAvailability = ref<ServerAvailability | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const lastFetchedAt = ref<string | null>(null);
  const lastWsEventAt = ref<string | null>(null);
  const lastUpdatedBy = ref<FreshnessState['lastUpdatedBy']>('unknown');
  const unauthorized = ref(false);
  const intent = ref<RuntimeIntent | null>(null);
  const currentRun = ref<RuntimeRunRecord | null>(null);
  const activeChildRuns = ref<RuntimeRunRecord[]>([]);
  const activations = ref<RuntimeActivationRecord[]>([]);
  const lastCommand = ref<RuntimeCommandRecord | null>(null);
  const lastActionableError = ref<ActionableErrorEnvelope | null>(null);
  const commandInFlight = ref<RuntimeCommandRecord['command'] | null>(null);

  let statusBeforePause: RuntimeStatus | null = null;

  const status = computed<RuntimeStatus>(() => runtime.value?.status ?? 'idle');
  const isRunning = computed(() => status.value === 'running');
  const isPaused = computed(() => runtime.value?.paused ?? false);
  const isFrozen = computed(() => runtime.value?.status === 'frozen');
  const currentCardId = computed(() => runtime.value?.current_card_id ?? null);
  const currentAgentSessionId = computed(() => runtime.value?.current_agent_session_id ?? null);
  const queueLength = computed(() => runtime.value?.queue?.length ?? 0);
  const runningProcessCount = computed(() => runtime.value?.running_processes?.length ?? 0);
  // Temporary compatibility for legacy debug panes only. Runtime Console controls must use intent/runs/activations.
  const legacyQueueLength = queueLength;
  const rootRun = computed(() => currentRun.value);
  const commandDisabledReason = computed(() => {
    if (loading.value) return 'Runtime state is still loading.';
    if (commandInFlight.value) return `Runtime command ${commandInFlight.value} is already in flight.`;
    if (unauthorized.value) return 'Runtime commands require a valid API token.';
    if (!getAuthToken()) return 'Enter an API token before controlling runtime.';
    return null;
  });
  const isStale = computed(() => {
    const latest = lastWsEventAt.value ?? lastFetchedAt.value;
    if (!latest) return false;
    return Date.now() - new Date(latest).getTime() > STALE_AFTER_MS;
  });

  const statusLabel = computed<string>(() => {
    if (!runtime.value) return 'unknown';
    if (runtime.value.status === 'frozen') return 'frozen';
    if (runtime.value.paused) return 'paused';
    return runtime.value.status;
  });

  const doneGoals = computed<number>(() => cardIndex.value.byStatus['done'] ?? 0);
  const failedBlocked = computed<number>(
    () => (cardIndex.value.byStatus['failed'] ?? 0) + (cardIndex.value.byStatus['blocked'] ?? 0),
  );
  const runtimeModeLabel = computed(() => {
    if (isFrozen.value) return 'Frozen';
    if (isPaused.value) return 'Paused';
    return statusLabel.value === 'unknown'
      ? 'Unknown'
      : statusLabel.value.charAt(0).toUpperCase() + statusLabel.value.slice(1);
  });
  const availabilityDetail = computed(() => {
    const availability = serverAvailability.value;
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
  });
  const runtimeDetail = computed(() => {
    if (unauthorized.value) return 'Runtime snapshot unavailable until a valid API token is provided.';
    if (!getAuthToken()) return 'Enter an API token to load runtime state and receive live updates.';
    if (isFrozen.value) return runtime.value?.frozen_reason || 'Runtime is frozen and needs operator attention.';
    if (status.value === 'error') return 'Runtime reported an error state. Inspect Debug for recovery evidence.';
    if (isPaused.value) return 'Runtime is paused. Resume to continue queued work.';
    if (isStale.value) return 'Runtime snapshot is stale. Refresh to resync with the authoritative REST state.';
    if (!runtime.value) return availabilityDetail.value ?? 'Runtime state has not been loaded yet.';
    return availabilityDetail.value ?? 'REST snapshot is authoritative; live updates may accelerate status changes.';
  });
  const liveUpdateState = computed<'live' | 'connecting' | 'offline' | 'unauthorized' | 'no-token' | 'stale'>(() => {
    const ws = useWsStore();
    if (!getAuthToken()) return 'no-token';
    if (ws.connectionState === 'unauthorized' || unauthorized.value) return 'unauthorized';
    if (ws.connectionState === 'connecting') return 'connecting';
    if (ws.connectionState === 'offline') return isStale.value ? 'stale' : 'offline';
    if (isStale.value || ws.stale) return 'stale';
    return 'live';
  });
  const liveUpdateLabel = computed(() => {
    switch (liveUpdateState.value) {
      case 'live': return 'Live updates connected';
      case 'connecting': return 'Live updates reconnecting';
      case 'offline': return 'Live updates offline';
      case 'unauthorized': return 'Live updates unauthorized';
      case 'no-token': return 'No API token';
      case 'stale': return 'Live updates stale';
    }
  });
  const liveUpdateDetail = computed(() => {
    switch (liveUpdateState.value) {
      case 'live': return 'WebSocket is connected. REST remains the source of truth after refresh/reconnect.';
      case 'connecting': return 'Trying to reconnect WebSocket live updates.';
      case 'offline': return 'Using the last REST snapshot only until live updates reconnect.';
      case 'unauthorized': return 'Token was rejected for API/WebSocket access.';
      case 'no-token': return 'Docs are public, but API and WebSocket access require a token.';
      case 'stale': return 'Live updates have gone quiet; refresh to confirm current runtime truth.';
    }
  });
  const pauseActionDisabledReason = computed(() => {
    if (loading.value) return 'Runtime state is still loading.';
    if (unauthorized.value) return 'Pause/resume requires a valid API token.';
    if (!getAuthToken()) return 'Enter an API token before controlling runtime.';
    if (!runtime.value) return 'Runtime state is unavailable.';
    if (status.value === 'error' && !isPaused.value) return 'Runtime is in an error state; inspect Debug before pausing.';
    return null;
  });


  function applyRuntimeSummaryFromState(nextRuntime: RuntimeState | null): void {
    if (!nextRuntime) {
      intent.value = null;
      currentRun.value = null;
      activeChildRuns.value = [];
      activations.value = [];
      lastCommand.value = null;
      return;
    }
    intent.value = nextRuntime.runtime_intent ?? null;
    const runs = nextRuntime.runtime_runs ?? [];
    currentRun.value = runs.find((run) => run.kind === 'root' && !run.finished_at) ?? runs.find((run) => run.kind === 'root') ?? null;
    activeChildRuns.value = runs.filter((run) => run.kind === 'child' && !run.finished_at);
    activations.value = nextRuntime.runtime_activations ?? [];
    const commands = nextRuntime.runtime_commands ?? [];
    lastCommand.value = commands.length > 0 ? commands[commands.length - 1] : null;
    lastActionableError.value = lastCommand.value?.error ?? activations.value.find((activation) => activation.error)?.error ?? null;
  }

  function mergeRuntimeSummary(content: Record<string, unknown>): void {
    if ('summary' in content || 'runtimeSummary' in content) {
      const summary = (content.runtimeSummary ?? content.summary) as {
        intent?: RuntimeIntent;
        currentRun?: RuntimeRunRecord | null;
        activeChildRuns?: RuntimeRunRecord[];
        activations?: RuntimeActivationRecord[];
        lastCommand?: RuntimeCommandRecord | null;
        actionable_error?: ActionableErrorEnvelope;
      } | null;
      if (summary) {
        if ('intent' in summary) intent.value = summary.intent ?? null;
        if ('currentRun' in summary) currentRun.value = summary.currentRun ?? null;
        if ('activeChildRuns' in summary) activeChildRuns.value = summary.activeChildRuns ?? [];
        if ('activations' in summary) activations.value = summary.activations ?? [];
        if ('lastCommand' in summary) lastCommand.value = summary.lastCommand ?? null;
        if (summary.actionable_error) lastActionableError.value = summary.actionable_error;
      }
    }
    if ('intent' in content) intent.value = (content.intent ?? null) as RuntimeIntent | null;
    if ('currentRun' in content) currentRun.value = (content.currentRun ?? null) as RuntimeRunRecord | null;
    if ('activeChildRuns' in content) activeChildRuns.value = (content.activeChildRuns ?? []) as RuntimeRunRecord[];
    if ('activations' in content) activations.value = (content.activations ?? []) as RuntimeActivationRecord[];
    if ('lastCommand' in content) lastCommand.value = (content.lastCommand ?? null) as RuntimeCommandRecord | null;
    if ('actionable_error' in content) lastActionableError.value = (content.actionable_error ?? null) as ActionableErrorEnvelope | null;
  }

  function upsertRun(run: RuntimeRunRecord): void {
    if (run.kind === 'root') currentRun.value = run.finished_at ? currentRun.value?.run_id === run.run_id ? run : currentRun.value : run;
    if (run.kind === 'child') {
      const others = activeChildRuns.value.filter((existing) => existing.run_id !== run.run_id);
      activeChildRuns.value = run.finished_at ? others : [...others, run];
    }
  }

  function upsertActivation(activation: RuntimeActivationRecord): void {
    activations.value = [
      ...activations.value.filter((existing) => existing.activation_id !== activation.activation_id),
      activation,
    ];
    if (activation.error) lastActionableError.value = activation.error;
  }

  function markRestSync(): void {
    lastFetchedAt.value = nowIso();
    lastUpdatedBy.value = 'rest';
  }

  function markWsSync(): void {
    lastWsEventAt.value = nowIso();
    lastUpdatedBy.value = lastFetchedAt.value ? 'mixed' : 'ws';
  }

  async function fetchState(): Promise<void> {
    loading.value = true;
    error.value = null;
    unauthorized.value = false;
    try {
      const response = await getRuntimeState();
      runtime.value = response.runtime;
      applyRuntimeSummaryFromState(response.runtime);
      cardIndex.value = response.cardIndex;
      cardStoreHealth.value = response.cardStoreHealth ?? null;
      serverAvailability.value = response.serverAvailability ?? null;
      markRestSync();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to fetch runtime state';
      error.value = msg;
      unauthorized.value = err instanceof ApiError && err.isUnauthorized;
      log.error('fetchState', msg);
      throw err;
    } finally {
      loading.value = false;
    }
  }


  async function startProject(): Promise<void> {
    error.value = null;
    lastActionableError.value = null;
    commandInFlight.value = 'start_project';
    try {
      const response = await startProjectRequest();
      intent.value = response.intent;
      lastCommand.value = response.command;
      if (response.run) upsertRun(response.run);
      markRestSync();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to start project runtime';
      error.value = msg;
      unauthorized.value = err instanceof ApiError && err.isUnauthorized;
      if (err instanceof ApiError && err.body?.actionable_error) {
        lastActionableError.value = err.body.actionable_error as ActionableErrorEnvelope;
      }
      log.error('startProject', msg);
      throw err;
    } finally {
      commandInFlight.value = null;
    }
  }

  async function stopProject(): Promise<void> {
    error.value = null;
    lastActionableError.value = null;
    commandInFlight.value = 'stop_project';
    try {
      const response = await stopProjectRequest();
      intent.value = response.intent;
      lastCommand.value = response.command;
      if (response.run) upsertRun(response.run);
      markRestSync();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to stop project runtime';
      error.value = msg;
      unauthorized.value = err instanceof ApiError && err.isUnauthorized;
      if (err instanceof ApiError && err.body?.actionable_error) {
        lastActionableError.value = err.body.actionable_error as ActionableErrorEnvelope;
      }
      log.error('stopProject', msg);
      throw err;
    } finally {
      commandInFlight.value = null;
    }
  }

  async function pause(): Promise<void> {
    error.value = null;
    try {
      const response = await pauseRuntime();
      log.info('Runtime paused:', response.status);
      runtime.value = response;
      applyRuntimeSummaryFromState(response);
      statusBeforePause = response.status;
      markRestSync();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to pause runtime';
      error.value = msg;
      unauthorized.value = err instanceof ApiError && err.isUnauthorized;
      log.error('pause', msg);
      throw err;
    }
  }

  async function resume(): Promise<void> {
    error.value = null;
    try {
      const response = await resumeRuntime();
      log.info('Runtime resumed:', response.status);
      runtime.value = response;
      applyRuntimeSummaryFromState(response);
      statusBeforePause = null;
      markRestSync();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to resume runtime';
      error.value = msg;
      unauthorized.value = err instanceof ApiError && err.isUnauthorized;
      log.error('resume', msg);
      throw err;
    }
  }

  let wsUnsubscribe: (() => void) | null = null;
  let reconnectUnsubscribe: (() => void) | null = null;
  let wsStatusBeforePause: RuntimeStatus | null = null;

  function handleWsRuntimeEnvelope(envelope: { content?: Record<string, unknown> }): void {
    const parsedContent = parseCoveredRuntimeStatusContent(envelope.content);
    const content = parsedContent ?? (envelope.content || {});
    const event = typeof content.event === 'string' ? content.event : '';
    markWsSync();

    if (event === 'runtime-state') {
      if (content.runtime) {
        runtime.value = content.runtime as RuntimeState;
        applyRuntimeSummaryFromState(runtime.value);
      }
      if (content.cardIndex) {
        cardIndex.value = content.cardIndex as CardIndex;
      }
      if ('cardStoreHealth' in content) {
        cardStoreHealth.value = (content.cardStoreHealth ?? null) as CardStoreHealth | null;
      }
      if ('serverAvailability' in content) {
        serverAvailability.value = (content.serverAvailability ?? null) as ServerAvailability | null;
      }
    }

    if (event === 'runtime-paused' || event === 'runtime-resumed') {
      if (runtime.value) {
        if (event === 'runtime-paused') {
          if (!runtime.value.paused) {
            wsStatusBeforePause = runtime.value.status;
          }
        }
        const restoredStatus = event === 'runtime-resumed'
          ? (wsStatusBeforePause ?? runtime.value.status)
          : 'paused';
        runtime.value = {
          ...runtime.value,
          paused: event === 'runtime-paused',
          status: restoredStatus,
          paused_at: event === 'runtime-paused' ? new Date().toISOString() : null,
        };
        if (event === 'runtime-resumed') {
          wsStatusBeforePause = null;
        }
      }
    }

    mergeRuntimeSummary(content as Record<string, unknown>);

    if (event === 'runtime.run' && content.run) {
      upsertRun(content.run as RuntimeRunRecord);
    }

    const knownContent = parseKnownWsContent(envelope.content);
    if (knownContent?.event === 'runtime.command') {
      lastCommand.value = knownContent.command as RuntimeCommandRecord;
      if (lastCommand.value.error) lastActionableError.value = lastCommand.value.error;
    }
    if (knownContent?.event === 'runtime.activation') {
      upsertActivation(knownContent.activation as RuntimeActivationRecord);
    }
    if (knownContent?.event === 'runtime.actionable_error') {
      lastActionableError.value = knownContent.actionable_error as ActionableErrorEnvelope;
    }

    if (event === 'card-status-changed' && content.card) {
      fetchState().catch(() => {});
    }
  }

  function setupWsListener(): void {
    const ws = useWsStore();
    if (!reconnectUnsubscribe) {
      reconnectUnsubscribe = ws.onReconnect(() => {
        fetchState().catch(() => {});
      });
    }
    if (wsUnsubscribe) return;
    const unsubscribers = [
      ws.onType('status', handleWsRuntimeEnvelope),
      ws.onType('activity', handleWsRuntimeEnvelope),
      ws.onType('error', handleWsRuntimeEnvelope),
    ];
    wsUnsubscribe = () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }

  return {
    runtime: readonly(runtime),
    cardIndex: readonly(cardIndex),
    cardStoreHealth: readonly(cardStoreHealth),
    serverAvailability: readonly(serverAvailability),
    intent: readonly(intent),
    currentRun: readonly(currentRun),
    rootRun,
    activeChildRuns: readonly(activeChildRuns),
    activations: readonly(activations),
    lastCommand: readonly(lastCommand),
    lastActionableError: readonly(lastActionableError),
    commandInFlight: readonly(commandInFlight),
    loading: readonly(loading),
    error: readonly(error),
    lastFetchedAt: readonly(lastFetchedAt),
    lastWsEventAt: readonly(lastWsEventAt),
    lastUpdatedBy: readonly(lastUpdatedBy),
    unauthorized: readonly(unauthorized),
    status,
    isRunning,
    isPaused,
    isFrozen,
    currentCardId,
    currentAgentSessionId,
    legacyQueueLength,
    runningProcessCount,
    statusLabel,
    doneGoals,
    failedBlocked,
    isStale,
    runtimeModeLabel,
    availabilityDetail,
    runtimeDetail,
    liveUpdateState,
    liveUpdateLabel,
    liveUpdateDetail,
    pauseActionDisabledReason,
    commandDisabledReason,
    fetchState,
    startProject,
    stopProject,
    pause,
    resume,
    setupWsListener,
  };
});
