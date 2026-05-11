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
} from '../api/types';
import {
  getRuntimeState,
  pauseRuntime,
  resumeRuntime,
  ApiError,
} from '../api/client';
import { useWsStore } from './ws';
import { createLogger } from '../utils/logger';

const log = createLogger('store:runtime');

// ── Store ──────────────────────────────────────────────────────

export const useRuntimeStore = defineStore('runtime', () => {
  // ── State ──────────────────────────────────────────────────

  const runtime = ref<RuntimeState | null>(null);
  const cardIndex = ref<CardIndex>({ total: 0, byStatus: {}, byType: {} });
  const loading = ref(false);
  const error = ref<string | null>(null);

  // ── Convenience getters ────────────────────────────────────

  const status = computed<RuntimeStatus>(() => runtime.value?.status ?? 'idle');
  const isRunning = computed(() => status.value === 'running');
  const isPaused = computed(() => runtime.value?.paused ?? false);
  const isFrozen = computed(() => runtime.value?.status === 'frozen');
  const currentCardId = computed(() => runtime.value?.current_card_id ?? null);
  const currentAgentSessionId = computed(() => runtime.value?.current_agent_session_id ?? null);
  const queueLength = computed(() => runtime.value?.queue?.length ?? 0);
  const runningProcessCount = computed(() => runtime.value?.running_processes?.length ?? 0);

  /** Status display chip: running / idle / paused / frozen / error. */
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

  // ── Actions ────────────────────────────────────────────────

  /** Fetch current runtime state from the API. */
  async function fetchState(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const response = await getRuntimeState();
      runtime.value = response.runtime;
      cardIndex.value = response.cardIndex;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to fetch runtime state';
      error.value = msg;
      log.error('fetchState', msg);
      throw err;
    } finally {
      loading.value = false;
    }
  }

  /** Pause the runtime globally. */
  async function pause(): Promise<void> {
    error.value = null;
    try {
      const response = await pauseRuntime();
      log.info('Runtime paused:', response.status);
      // Optimistic update
      if (runtime.value) {
        runtime.value = { ...runtime.value, paused: true, status: 'paused' };
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to pause runtime';
      error.value = msg;
      log.error('pause', msg);
      throw err;
    }
  }

  /** Resume the runtime. */
  async function resume(): Promise<void> {
    error.value = null;
    try {
      const response = await resumeRuntime();
      log.info('Runtime resumed:', response.status);
      if (runtime.value) {
        runtime.value = { ...runtime.value, paused: false };
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to resume runtime';
      error.value = msg;
      log.error('resume', msg);
      throw err;
    }
  }

  // ── WebSocket Integration ──────────────────────────────────

  let wsUnsubscribe: (() => void) | null = null;

  function setupWsListener(): void {
    if (wsUnsubscribe) return;
    const ws = useWsStore();
    wsUnsubscribe = ws.onType('status', (envelope) => {
      const content = envelope.content || {};
      const event = content.event as string;

      // Full state update
      if (event === 'runtime-state') {
        if (content.runtime) {
          runtime.value = content.runtime as RuntimeState;
        }
        if (content.cardIndex) {
          cardIndex.value = content.cardIndex as CardIndex;
        }
      }

      // Runtime paused/resumed
      if (event === 'runtime-paused' || event === 'runtime-resumed') {
        if (runtime.value) {
          runtime.value = {
            ...runtime.value,
            paused: event === 'runtime-paused',
            status: event === 'runtime-paused' ? 'paused' : runtime.value.status,
            paused_at: event === 'runtime-paused' ? new Date().toISOString() : null,
          };
        }
      }

      // Card-level updates that affect runtime view
      if (event === 'card-status-changed' && content.card) {
        // Refresh to get updated card index
        fetchState().catch(() => {});
      }
    });
  }

  return {
    // State
    runtime: readonly(runtime),
    cardIndex: readonly(cardIndex),
    loading: readonly(loading),
    error: readonly(error),

    // Getters
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

    // Actions
    fetchState,
    pause,
    resume,
    setupWsListener,
  };
});
