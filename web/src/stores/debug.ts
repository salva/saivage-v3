/**
 * Pinia store for debug information.
 *
 * Exposes runtime state dump, errors list, and timeline view.
 * All data is read-only for inspection purposes — actions should
 * link back to the relevant card or process.
 */

import { defineStore } from 'pinia';
import { ref, computed, readonly } from 'vue';
import type {
  RuntimeState,
  CardType,
  CardStatus,
  DebugError,
  DebugTimelineEvent,
  DebugStateResponse,
  DebugErrorsResponse,
  DebugTimelineResponse,
} from '../api/types';
import {
  getDebugState,
  getDebugErrors,
  getDebugTimeline,
  ApiError,
} from '../api/client';
import { useWsStore } from './ws';
import { createLogger } from '../utils/logger';

const log = createLogger('store:debug');

// ── Store ──────────────────────────────────────────────────────

export const useDebugStore = defineStore('debug', () => {
  // ── State ──────────────────────────────────────────────────

  // State dump
  const debugRuntime = ref<RuntimeState | null>(null);
  const debugCards = ref<Array<{
    id: string;
    type: CardType;
    parent: string | null;
    status: CardStatus;
    title: string;
    priority: number;
    depends_on: string[];
    blocks: string[];
  }>>([]);
  const debugTotalCards = ref(0);

  // Errors
  const errors = ref<DebugError[]>([]);
  const errorsTotal = ref(0);

  // Timeline
  const timelineEvents = ref<DebugTimelineEvent[]>([]);
  const timelineTotal = ref(0);

  // Shared
  const loading = ref(false);
  const error = ref<string | null>(null);

  /** Which debug tab is active. */
  const activeTab = ref<'state' | 'errors' | 'timeline'>('state');

  // ── Getters ────────────────────────────────────────────────

  /** Errors grouped by source for the errors list. */
  const errorsBySource = computed<Map<string, DebugError[]>>(() => {
    const map = new Map<string, DebugError[]>();
    for (const e of errors.value) {
      const list = map.get(e.source);
      if (list) {
        list.push(e);
      } else {
        map.set(e.source, [e]);
      }
    }
    return map;
  });

  /** Errors grouped by severity. */
  const errorsBySeverity = computed<Map<string, DebugError[]>>(() => {
    const map = new Map<string, DebugError[]>();
    for (const e of errors.value) {
      const list = map.get(e.severity);
      if (list) {
        list.push(e);
      } else {
        map.set(e.severity, [e]);
      }
    }
    return map;
  });

  /** Timeline events sorted by timestamp (newest first). */
  const sortedTimeline = computed<DebugTimelineEvent[]>(() =>
    [...timelineEvents.value].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    ),
  );

  /** Cards with errors or blocked status. */
  const problemCards = computed(() =>
    debugCards.value.filter(
      (c) => c.status === 'failed' || c.status === 'blocked',
    ),
  );

  // ── Actions ────────────────────────────────────────────────

  /** Fetch the full debug state dump. */
  async function fetchState(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const response: DebugStateResponse = await getDebugState();
      debugRuntime.value = response.runtime;
      debugCards.value = response.cards;
      debugTotalCards.value = response.totalCards;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to fetch debug state';
      error.value = msg;
      log.error('fetchState', msg);
    } finally {
      loading.value = false;
    }
  }

  /** Fetch the errors list. */
  async function fetchErrors(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const response: DebugErrorsResponse = await getDebugErrors();
      errors.value = response.errors;
      errorsTotal.value = response.total;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to fetch debug errors';
      error.value = msg;
      log.error('fetchErrors', msg);
    } finally {
      loading.value = false;
    }
  }

  /** Fetch timeline events. */
  async function fetchTimeline(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const response: DebugTimelineResponse = await getDebugTimeline();
      timelineEvents.value = response.events;
      timelineTotal.value = response.total;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to fetch debug timeline';
      error.value = msg;
      log.error('fetchTimeline', msg);
    } finally {
      loading.value = false;
    }
  }

  /** Fetch all debug data at once. */
  async function fetchAll(): Promise<void> {
    await Promise.allSettled([fetchState(), fetchErrors(), fetchTimeline()]);
  }

  function setActiveTab(tab: 'state' | 'errors' | 'timeline'): void {
    activeTab.value = tab;
  }

  // ── WebSocket Integration ──────────────────────────────────

  let wsUnsubscribe: (() => void) | null = null;

  function setupWsListener(): void {
    if (wsUnsubscribe) return;
    const ws = useWsStore();

    // Route all incoming events to the timeline for debugging
    wsUnsubscribe = ws.onType('status', (envelope) => {
      const content = envelope.content || {};
      const event = content.event as string;

      // Add to timeline
      timelineEvents.value = [
        {
          type: `ws:${event}`,
          card_id: content.cardId as string | undefined,
          timestamp: new Date().toISOString(),
          data: content,
        },
        ...timelineEvents.value,
      ].slice(0, 500); // Cap at 500 events

      // Track errors from status events
      if (event === 'error' && content.message) {
        errors.value = [
          {
            source: content.source as string || 'runtime',
            type: content.errorType as string || 'runtime-error',
            severity: content.severity as string || 'error',
            message: content.message as string,
            details: content.details as string | undefined,
            timestamp: new Date().toISOString(),
          },
          ...errors.value,
        ].slice(0, 200);
      }
    });
  }

  return {
    // State
    debugRuntime: readonly(debugRuntime),
    debugCards: readonly(debugCards),
    debugTotalCards: readonly(debugTotalCards),
    errors: readonly(errors),
    errorsTotal: readonly(errorsTotal),
    timelineEvents: readonly(timelineEvents),
    timelineTotal: readonly(timelineTotal),
    loading: readonly(loading),
    error: readonly(error),
    activeTab,

    // Getters
    errorsBySource,
    errorsBySeverity,
    sortedTimeline,
    problemCards,

    // Actions
    fetchState,
    fetchErrors,
    fetchTimeline,
    fetchAll,
    setActiveTab,
    setupWsListener,
  };
});
