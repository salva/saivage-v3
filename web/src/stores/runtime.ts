/**
 * Pinia store for runtime state.
 *
 * Tracks the Saivage runtime: status, current active card, queue,
 * running processes, card index, and global pause state.
 * Subscribes to WebSocket status events for live updates.
 */

import { defineStore } from 'pinia';
import { ref, computed, readonly } from 'vue';
import type {
  RuntimeState,
  RuntimeStatus,
  CardIndex,
  FreshnessState,
} from '../api/types';
import {
  getRuntimeState,
  pauseRuntime,
  resumeRuntime,
  ApiError,
} from '../api/client';
import { getAuthToken } from '../api/auth';
import { useWsStore } from './ws';
import { createLogger } from '../utils/logger';
import { parseCoveredRuntimeStatusContent } from '../api/contracts';

const log = createLogger('store:runtime');
const STALE_AFTER_MS = 30_000;

function nowIso(): string {
  return new Date().toISOString();
}

export const useRuntimeStore = defineStore('runtime', () => {
  const runtime = ref<RuntimeState | null>(null);
  const cardIndex = ref<CardIndex>({ total: 0, byStatus: {}, byType: {} });
  const loading = ref(false);
  const error = ref<string | null>(null);
  const lastFetchedAt = ref<string | null>(null);
  const lastWsEventAt = ref<string | null>(null);
  const lastUpdatedBy = ref<FreshnessState['lastUpdatedBy']>('unknown');
  const unauthorized = ref(false);

  let statusBeforePause: RuntimeStatus | null = null;

  const status = computed<RuntimeStatus>(() => runtime.value?.status ?? 'idle');
  const isRunning = computed(() => status.value === 'running');
  const isPaused = computed(() => runtime.value?.paused ?? false);
  const isFrozen = computed(() => runtime.value?.status === 'frozen');
  const currentCardId = computed(() => runtime.value?.current_card_id ?? null);
  const currentAgentSessionId = computed(() => runtime.value?.current_agent_session_id ?? null);
  const queueLength = computed(() => runtime.value?.queue?.length ?? 0);
  const runningProcessCount = computed(() => runtime.value?.running_processes?.length ?? 0);
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
  const runtimeDetail = computed(() => {
    if (unauthorized.value) return 'Runtime snapshot unavailable until a valid API token is provided.';
    if (!getAuthToken()) return 'Enter an API token to load runtime state and receive live updates.';
    if (isFrozen.value) return runtime.value?.frozen_reason || 'Runtime is frozen and needs operator attention.';
    if (status.value === 'error') return 'Runtime reported an error state. Inspect Debug for recovery evidence.';
    if (isPaused.value) return 'Runtime is paused. Resume to continue queued work.';
    if (isStale.value) return 'Runtime snapshot is stale. Refresh to resync with the authoritative REST state.';
    if (!runtime.value) return 'Runtime state has not been loaded yet.';
    return 'REST snapshot is authoritative; live updates may accelerate status changes.';
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
      cardIndex.value = response.cardIndex;
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

  async function pause(): Promise<void> {
    error.value = null;
    try {
      const response = await pauseRuntime();
      log.info('Runtime paused:', response.status);
      runtime.value = response;
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

  function setupWsListener(): void {
    const ws = useWsStore();
    if (!reconnectUnsubscribe) {
      reconnectUnsubscribe = ws.onReconnect(() => {
        fetchState().catch(() => {});
      });
    }
    if (wsUnsubscribe) return;
    wsUnsubscribe = ws.onType('status', (envelope) => {
      const parsedContent = parseCoveredRuntimeStatusContent(envelope.content);
      const content = parsedContent ?? (envelope.content || {});
      const event = typeof content.event === 'string' ? content.event : '';
      markWsSync();

      if (event === 'runtime-state') {
        if (content.runtime) {
          runtime.value = content.runtime as RuntimeState;
        }
        if (content.cardIndex) {
          cardIndex.value = content.cardIndex as CardIndex;
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

      if (event === 'card-status-changed' && content.card) {
        fetchState().catch(() => {});
      }
    });
  }

  return {
    runtime: readonly(runtime),
    cardIndex: readonly(cardIndex),
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
    queueLength,
    runningProcessCount,
    statusLabel,
    doneGoals,
    failedBlocked,
    isStale,
    runtimeModeLabel,
    runtimeDetail,
    liveUpdateState,
    liveUpdateLabel,
    liveUpdateDetail,
    pauseActionDisabledReason,
    fetchState,
    pause,
    resume,
    setupWsListener,
  };
});
