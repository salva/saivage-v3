/**
 * Pinia store for runtime state.
 *
 * Tracks the Saivage runtime snapshot,
 * card index, and lifecycle status.
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
  selectCurrentAgentSessionId,
  selectCurrentCardId,
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
  const refreshing = ref(false);
  const refreshError = ref<string | null>(null);
  const error = ref<string | null>(null);
  const lastFetchedAt = ref<string | null>(null);
  const lastWsEventAt = ref<string | null>(null);
  const lastUpdatedBy = ref<FreshnessState['lastUpdatedBy']>('unknown');
  const unauthorized = ref(false);
  const lastActionableError = ref<ActionableErrorEnvelope | null>(null);
  let requestEpoch = 0;
  let requestController: AbortController | null = null;

  const status = computed<RuntimeStatus>(() => runtime.value?.status ?? 'stopped');
  const isRunning = computed(() => status.value === 'running');
  const currentCardId = computed(() => selectCurrentCardId(runtime.value));
  const currentAgentSessionId = computed(() => selectCurrentAgentSessionId(runtime.value));
  const commandDisabledReason = computed(() => {
    if (loading.value) return 'Runtime state is still loading.';
    if (unauthorized.value) return 'Runtime commands require a valid API token.';
    return null;
  });
  const isStale = computed(() => {
    const latest = lastWsEventAt.value ?? lastFetchedAt.value;
    if (!latest) return false;
    return Date.now() - new Date(latest).getTime() > STALE_AFTER_MS;
  });

  const statusLabel = computed<string>(() => selectRuntimeStatusLabel(runtime.value));
  const syncConnectionState = computed(() => useSyncStore().connectionState ?? 'offline');

  const doneGoals = computed<number>(() => cardIndex.value.byStatus['done'] ?? 0);
  const failedBlocked = computed<number>(
    () => (cardIndex.value.byStatus['failed'] ?? 0) + (cardIndex.value.byStatus['blocked'] ?? 0),
  );
  const runtimeModeLabel = computed(() => selectRuntimeModeLabel({ statusLabel: statusLabel.value }));
  const availabilityDetail = computed(() => selectAvailabilityDetail(serverAvailability.value));
  const runtimeDetail = computed(() => selectRuntimeDetail({
    unauthorized: unauthorized.value,
    runtime: runtime.value,
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
    if (status.value === 'error') return 'Runtime is in an error state; inspect Debug before pausing.';
    return null;
  });


  function applyRuntimeSummaryFromState(nextRuntime: RuntimeState | null): void {
    const summary = selectRuntimeSummary(nextRuntime);
    lastActionableError.value = summary.lastActionableError;
  }

  function markRestSync(): void {
    lastFetchedAt.value = nowIso();
    lastUpdatedBy.value = 'rest';
  }

  function markWsSync(timestamp = nowIso()): void {
    lastWsEventAt.value = timestamp;
    lastUpdatedBy.value = 'ws';
  }

  async function fetchState(): Promise<void> {
    const epoch = ++requestEpoch;
    requestController?.abort();
    requestController = new AbortController();
    const initial = runtime.value === null;
    if (initial) loading.value = true; else refreshing.value = true;
    if (initial) error.value = null; else refreshError.value = null;
    unauthorized.value = false;
    try {
      const response = await getRuntimeState(requestController.signal);
      if (epoch !== requestEpoch) return;
      runtime.value = response.runtime;
      projectRoot.value = response.projectRoot;
      projectId.value = response.projectId;
      applyRuntimeSummaryFromState(response.runtime);
      cardIndex.value = response.cardIndex;
      serverAvailability.value = response.serverAvailability ?? null;
      markRestSync();
      error.value = null;
      refreshError.value = null;
    } catch (err) {
      if (epoch !== requestEpoch || (err instanceof DOMException && err.name === 'AbortError')) return;
      const msg = err instanceof ApiError ? err.message : 'Failed to fetch runtime state';
      if (initial) error.value = msg; else refreshError.value = msg;
      unauthorized.value = err instanceof ApiError && err.isUnauthorized;
      if (unauthorized.value) {
        projectRoot.value = null;
        projectId.value = null;
      }
      log.error('fetchState', msg);
      throw err;
    } finally {
      if (epoch === requestEpoch) {
        loading.value = false;
        refreshing.value = false;
      }
    }
  }
  const refetch = fetchState;

  return {
    runtime: readonly(runtime),
    projectRoot: readonly(projectRoot),
    projectId: readonly(projectId),
    cardIndex: readonly(cardIndex),
    serverAvailability: readonly(serverAvailability),
    lastActionableError: readonly(lastActionableError),
    loading: readonly(loading),
    refreshing: readonly(refreshing),
    refreshError: readonly(refreshError),
    error: readonly(error),
    lastFetchedAt: readonly(lastFetchedAt),
    lastWsEventAt: readonly(lastWsEventAt),
    lastUpdatedBy: readonly(lastUpdatedBy),
    unauthorized: readonly(unauthorized),
    status,
    isRunning,
    currentCardId,
    currentAgentSessionId,
    statusLabel,
    syncConnectionState,
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
    markWsSync,
    refetch,
  };
});
