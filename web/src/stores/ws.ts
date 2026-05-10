/**
 * Pinia store for WebSocket connection state and event routing.
 *
 * Wraps the connection manager from web/src/api/websocket.ts and
 * routes incoming events to the appropriate domain stores (cards,
 * runtime, agents, debug) when they are initialized.
 */

import { defineStore } from 'pinia';
import { ref, readonly, shallowRef } from 'vue';
import type { WsConnectionState, WsEnvelope, WsEventType } from '../api/types';
import {
  getWsConnection,
  type WsConnectionManager,
  type WsEventHandler,
} from '../api/websocket';
import { createLogger } from '../utils/logger';

const log = createLogger('store:ws');

// ── Store ──────────────────────────────────────────────────────

export const useWsStore = defineStore('ws', () => {
  // ── State ──────────────────────────────────────────────────

  const connectionState = ref<WsConnectionState>('offline');
  const sessionId = ref<string | null>(null);
  const reconnectAttempts = ref(0);

  /** Map of event-type → list of handlers registered by other stores. */
  const typeHandlers = shallowRef<Map<WsEventType, Set<WsEventHandler>>>(new Map());

  /** Raw connection manager instance (held for lifecycle purposes). */
  let conn: WsConnectionManager | null = null;

  // ── Sync from connection ───────────────────────────────────

  function syncFromConnection(): void {
    if (!conn) return;
    connectionState.value = conn.state.value;
    sessionId.value = conn.sessionId.value;
    reconnectAttempts.value = conn.reconnectAttempts.value;
  }

  // ── Connect / Disconnect ───────────────────────────────────

  function connect(): void {
    if (!conn) {
      conn = getWsConnection();

      // Hook into the connection's global event stream.
      conn.onEvent((envelope: WsEnvelope) => {
        routeEvent(envelope);
      });
    }

    syncFromConnection();
    conn.connect();

    // Poll the connection object periodically since its refs
    // are plain mutable objects, not Vue refs.
    startSyncPolling();
  }

  function disconnect(): void {
    if (conn) {
      conn.disconnect();
    }
    stopSyncPolling();
    connectionState.value = 'offline';
    sessionId.value = null;
    reconnectAttempts.value = 0;
  }

  // ── Sync polling ───────────────────────────────────────────

  let syncTimer: ReturnType<typeof setInterval> | null = null;

  function startSyncPolling(): void {
    if (syncTimer) return;
    syncTimer = setInterval(() => {
      syncFromConnection();
    }, 250);
  }

  function stopSyncPolling(): void {
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
  }

  // ── Event Routing ──────────────────────────────────────────

  function routeEvent(envelope: WsEnvelope): void {
    // Update local state
    syncFromConnection();

    // Route to type-specific handlers
    const handlers = typeHandlers.value.get(envelope.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(envelope);
        } catch (err) {
          log.error('Store event handler error', err);
        }
      }
    }
  }

  /**
   * Register a handler for a specific event type.
   * Returns an unregister function. Other stores call this
   * to receive WebSocket events.
   */
  function onType(type: WsEventType, handler: WsEventHandler): () => void {
    const map = typeHandlers.value;
    let set = map.get(type);
    if (!set) {
      set = new Set();
      map.set(type, set);
    }
    set.add(handler);

    return () => {
      const current = typeHandlers.value.get(type);
      if (current) {
        current.delete(handler);
        if (current.size === 0) {
          typeHandlers.value.delete(type);
        }
      }
    };
  }

  // ── Send Message ───────────────────────────────────────────

  function sendMessage(text: string): void {
    if (!conn) {
      conn = getWsConnection();
    }
    conn.sendMessage(text);
  }

  // ── Computed / Getters ─────────────────────────────────────

  const isConnected = () => connectionState.value === 'connected';
  const isConnecting = () => connectionState.value === 'connecting';

  return {
    // State (exposed as read-only outside the store)
    connectionState: readonly(connectionState),
    sessionId: readonly(sessionId),
    reconnectAttempts: readonly(reconnectAttempts),

    // Actions
    connect,
    disconnect,
    sendMessage,
    onType,

    // Getters
    isConnected,
    isConnecting,
  };
});
