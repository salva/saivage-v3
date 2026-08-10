/**
 * Pinia store for runtime state.
 *
 * Tracks the Saivage runtime snapshot and lifecycle status.
 * Live updates are driven by SyncClient invalidation + REST refetch.
 */

import { defineStore } from 'pinia';
import { ref, computed, readonly } from 'vue';
import type {
  RuntimeState,
  RuntimeStatus,
  ServerAvailability,
} from '../api/types';
import {
  getRuntimeState,
  getRuntimeStatus,
  stopProject as stopProjectRequest,
  restartServer as restartServerRequest,
  OperatorApiError,
} from '../api/client';
import { createLogger } from '../utils/logger';
import {
  selectAvailabilityDetail,
  selectRuntimeDetail,
  selectRuntimeModeLabel,
  selectRuntimeStatusLabel,
  selectCurrentCardId,
} from './runtime-read-model';

const log = createLogger('store:runtime');
function nowIso(): string {
  return new Date().toISOString();
}

export const useRuntimeStore = defineStore('runtime', () => {
  const runtime = ref<RuntimeState | null>(null);
  const projectRoot = ref<string | null>(null);
  const projectId = ref<string | null>(null);
  const serverAvailability = ref<ServerAvailability | null>(null);
  const loaded = ref(false);
  const loading = ref(false);
  const refreshing = ref(false);
  const refreshError = ref<string | null>(null);
  const error = ref<string | null>(null);
  const lastFetchedAt = ref<string | null>(null);
  const unauthorized = ref(false);
  const restartServerAvailable = ref(false);
  let requestEpoch = 0;
  let requestController: AbortController | null = null;

  const status = computed<RuntimeStatus | null>(() => loaded.value ? runtime.value?.status ?? 'stopped' : null);
  const isRunning = computed(() => status.value === 'running');
  const currentCardId = computed(() => selectCurrentCardId(runtime.value));
  const commandDisabledReason = computed(() => {
    if (!loaded.value || loading.value) return 'Runtime state is still loading.';
    if (unauthorized.value) return 'Runtime commands require a valid API token.';
    return null;
  });
  const statusLabel = computed<string>(() => selectRuntimeStatusLabel({ loaded: loaded.value, runtime: runtime.value }));

  const runtimeModeLabel = computed(() => selectRuntimeModeLabel({ statusLabel: statusLabel.value }));
  const availabilityDetail = computed(() => selectAvailabilityDetail(serverAvailability.value));
  const runtimeDetail = computed(() => selectRuntimeDetail({
    loaded: loaded.value,
    unauthorized: unauthorized.value,
    runtime: runtime.value,
    status: status.value,
    availabilityDetail: availabilityDetail.value,
  }));
  function markRestSync(): void {
    lastFetchedAt.value = nowIso();
  }

  async function fetchState(): Promise<void> {
    const epoch = ++requestEpoch;
    requestController?.abort();
    requestController = new AbortController();
    const initial = !loaded.value;
    if (initial) loading.value = true; else refreshing.value = true;
    if (initial) error.value = null; else refreshError.value = null;
    unauthorized.value = false;
    try {
      const [response, liveStatus] = await Promise.all([getRuntimeState(requestController.signal), getRuntimeStatus(requestController.signal)]);
      if (epoch !== requestEpoch) return;
      runtime.value = response.runtime;
      projectRoot.value = response.projectRoot;
      projectId.value = response.projectId;
      serverAvailability.value = response.serverAvailability ?? null;
      restartServerAvailable.value = liveStatus.restart_server_available;
      loaded.value = true;
      markRestSync();
      error.value = null;
      refreshError.value = null;
    } catch (err) {
      if (epoch !== requestEpoch || (err instanceof DOMException && err.name === 'AbortError')) return;
      const msg = err instanceof OperatorApiError ? err.message : 'Failed to fetch runtime state';
      if (initial) error.value = msg; else refreshError.value = msg;
      unauthorized.value = err instanceof OperatorApiError && err.isUnauthorized;
      if (unauthorized.value && initial) {
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

  async function stopProject(): Promise<void> {
    await stopProjectRequest();
    try { await fetchState(); } catch { /* RuntimeStore already classified the resource failure. */ }
  }
  async function restartServer(): Promise<void> { if (!restartServerAvailable.value) throw new Error('restart unavailable: operator authentication disabled'); await restartServerRequest(); }

  return {
    runtime: readonly(runtime),
    projectRoot: readonly(projectRoot),
    projectId: readonly(projectId),
    serverAvailability: readonly(serverAvailability),
    loaded: readonly(loaded),
    restartServerAvailable: readonly(restartServerAvailable),
    loading: readonly(loading),
    refreshing: readonly(refreshing),
    refreshError: readonly(refreshError),
    error: readonly(error),
    lastFetchedAt: readonly(lastFetchedAt),
    unauthorized: readonly(unauthorized),
    status,
    isRunning,
    currentCardId,
    statusLabel,
    runtimeModeLabel,
    availabilityDetail,
    runtimeDetail,
    commandDisabledReason,
    fetchState,
    refetch,
    stopProject,
    restartServer,
  };
});
