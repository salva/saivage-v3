/**
 * Pinia store for runtime state.
 *
 * Tracks the Saivage runtime snapshot plus command/run/activation summary state,
 * card index, and global pause state.
 * Live updates are driven by SyncClient invalidation + REST refetch.
 */

import { defineStore } from 'pinia';
import { ref, computed, readonly } from 'vue';
import type {
  RuntimeState,
  RuntimeStatus,
  CardIndex,
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
  ApiError,
} from '../api/client';
import { useSyncStore } from './sync';
import { createLogger } from '../utils/logger';
import {
  selectAvailabilityDetail,
  selectLiveUpdateDetail,
  selectLiveUpdateLabel,
  selectLiveUpdateState,
  selectRuntimeDetail,
  selectRuntimeModeLabel,
  selectRuntimeStatusLabel,
  selectRuntimeSummary,
} from './runtime-read-model';

const log = createLogger('store:runtime');
const STALE_AFTER_MS = 30_000;

function nowIso(): string {
  return new Date().toISOString();
}

export const useRuntimeStore = defineStore('runtime', () => {
  const runtime = ref<RuntimeState | null>(null);
  const projectRoot = ref<string | null>(null);
  const projectId = ref<string | null>(null);
  const cardIndex = ref<CardIndex>({ total: 0, byStatus: {}, byType: {} });
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

  const status = computed<RuntimeStatus>(() => runtime.value?.status ?? 'idle');
  const isRunning = computed(() => status.value === 'running');
  const isPaused = computed(() => runtime.value?.paused ?? false);
  const isFrozen = computed(() => runtime.value?.status === 'frozen');
  const currentCardId = computed(() => runtime.value?.current_card_id ?? null);
  const currentAgentSessionId = computed(() => runtime.value?.current_agent_session_id ?? null);
  const rootRun = computed(() => currentRun.value);
  const commandDisabledReason = computed(() => {
    if (loading.value) return 'Runtime state is still loading.';
    if (commandInFlight.value) return `Runtime command ${commandInFlight.value} is already in flight.`;
    if (unauthorized.value) return 'Runtime commands require a valid API token.';
    return null;
  });
  const isStale = computed(() => {
    const latest = lastWsEventAt.value ?? lastFetchedAt.value;
    if (!latest) return false;
    return Date.now() - new Date(latest).getTime() > STALE_AFTER_MS;
  });

  const statusLabel = computed<string>(() => selectRuntimeStatusLabel(runtime.value));

  const doneGoals = computed<number>(() => cardIndex.value.byStatus['done'] ?? 0);
  const failedBlocked = computed<number>(
    () => (cardIndex.value.byStatus['failed'] ?? 0) + (cardIndex.value.byStatus['blocked'] ?? 0),
  );
  const runtimeModeLabel = computed(() => selectRuntimeModeLabel({ frozen: isFrozen.value, paused: isPaused.value, statusLabel: statusLabel.value }));
  const availabilityDetail = computed(() => selectAvailabilityDetail(serverAvailability.value));
  const runtimeDetail = computed(() => selectRuntimeDetail({
    unauthorized: unauthorized.value,
    runtime: runtime.value,
    frozen: isFrozen.value,
    paused: isPaused.value,
    stale: isStale.value,
    status: status.value,
    availabilityDetail: availabilityDetail.value,
  }));
  const liveUpdateState = computed(() => {
    const sync = useSyncStore();
    return selectLiveUpdateState({
      connectionState: sync.connectionState ?? 'offline',
      unauthorized: unauthorized.value,
      stale: isStale.value,
      wsStale: false,
    });
  });
  const liveUpdateLabel = computed(() => selectLiveUpdateLabel(liveUpdateState.value));
  const liveUpdateDetail = computed(() => selectLiveUpdateDetail(liveUpdateState.value));
  const pauseActionDisabledReason = computed(() => {
    if (loading.value) return 'Runtime state is still loading.';
    if (unauthorized.value) return 'Pause/resume requires a valid API token.';
    if (!runtime.value) return 'Runtime state is unavailable.';
    if (status.value === 'error' && !isPaused.value) return 'Runtime is in an error state; inspect Debug before pausing.';
    return null;
  });


  function applyRuntimeSummaryFromState(nextRuntime: RuntimeState | null): void {
    const summary = selectRuntimeSummary(nextRuntime);
    intent.value = summary.intent;
    currentRun.value = summary.currentRun;
    activeChildRuns.value = summary.activeChildRuns;
    activations.value = summary.activations;
    lastCommand.value = summary.lastCommand;
    lastActionableError.value = summary.lastActionableError;
  }

  function markRestSync(): void {
    lastFetchedAt.value = nowIso();
    lastUpdatedBy.value = 'rest';
  }

  async function fetchState(): Promise<void> {
    loading.value = true;
    error.value = null;
    unauthorized.value = false;
    try {
      const response = await getRuntimeState();
      runtime.value = response.runtime;
      projectRoot.value = response.projectRoot;
      projectId.value = response.projectId;
      applyRuntimeSummaryFromState(response.runtime);
      cardIndex.value = response.cardIndex;
      serverAvailability.value = response.serverAvailability ?? null;
      markRestSync();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to fetch runtime state';
      error.value = msg;
      unauthorized.value = err instanceof ApiError && err.isUnauthorized;
      if (unauthorized.value) {
        projectRoot.value = null;
        projectId.value = null;
      }
      log.error('fetchState', msg);
      throw err;
    } finally {
      loading.value = false;
    }
  }
  const refetch = fetchState;

  return {
    runtime: readonly(runtime),
    projectRoot: readonly(projectRoot),
    projectId: readonly(projectId),
    cardIndex: readonly(cardIndex),
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
    refetch,
  };
});
