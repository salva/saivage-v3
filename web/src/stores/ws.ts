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
import { getAuthToken } from '../api/auth';
import { createLogger } from '../utils/logger';

const log = createLogger('store:ws');
const STALE_AFTER_MS = 30_000;

// ── Store ──────────────────────────────────────────────────────

export const useWsStore = defineStore('ws', () => {
  // ── State ──────────────────────────────────────────────────

  const connectionState = ref<WsConnectionState>('offline');
  const sessionId = ref<string | null>(null);
  const reconnectAttempts = ref(0);
  const lastEventAt = ref<string | null>(null);
  const lastConnectedAt = ref<string | null>(null);
  const stale = ref(false);

  /** Map of event-type → list of handlers registered by other stores. */
  const typeHandlers = shallowRef<Map<WsEventType, Set<WsEventHandler>>>(new Map());
  const reconnectHandlers = shallowRef(new Set<() => void>());

  /** Raw connection manager instance (held for lifecycle purposes). */
  let conn: WsConnectionManager | null = null;

  // ── Sync from connection ───────────────────────────────────

  function syncFromConnection(): void {
    if (!conn) return;
    connectionState.value = conn.state.value;
    sessionId.value = conn.sessionId.value;
    reconnectAttempts.value = conn.reconnectAttempts.value;
  }

  function markEventReceived(): void {
    const now = new Date().toISOString();
    lastEventAt.value = now;
    stale.value = false;
  }

  function notifyReconnect(): void {
    for (const handler of reconnectHandlers.value) {
      try {
        handler();
      } catch (err) {
        log.error('Reconnect handler error', err);
      }
    }
  }

  function refreshDerivedState(): void {
    syncFromConnection();

    if (connectionState.value === 'connected') {
      if (!lastConnectedAt.value) {
        lastConnectedAt.value = new Date().toISOString();
      }
      if (lastEventAt.value) {
        stale.value = Date.now() - new Date(lastEventAt.value).getTime() > STALE_AFTER_MS;
      } else {
        stale.value = false;
      }
      return;
    }

    lastConnectedAt.value = null;
    stale.value = connectionState.value !== 'no-token' && connectionState.value !== 'unauthorized';
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

    refreshDerivedState();
    conn.connect();

    if (!getAuthToken()) {
      connectionState.value = 'no-token';
      stale.value = false;
    }

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
    lastConnectedAt.value = null;
    stale.value = false;
  }

  // ── Sync polling ───────────────────────────────────────────

  let syncTimer: ReturnType<typeof setInterval> | null = null;
  let lastConnectionSnapshot: WsConnectionState | null = null;

  function startSyncPolling(): void {
    if (syncTimer) return;
    syncTimer = setInterval(() => {
      const prev = connectionState.value;
      refreshDerivedState();
      if (prev !== 'connected' && connectionState.value === 'connected') {
        notifyReconnect();
      }
      lastConnectionSnapshot = connectionState.value;
    }, 250);
  }

  function stopSyncPolling(): void {
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
    lastConnectionSnapshot = null;
  }

  // ── Event Routing ──────────────────────────────────────────

  function routeEvent(envelope: WsEnvelope): void {
    refreshDerivedState();
    markEventReceived();

    if (
      envelope.type === 'error'
      && envelope.content?.code === 'unauthorized'
    ) {
      connectionState.value = 'unauthorized';
      stale.value = false;
    }

    const event = typeof envelope.content?.event === 'string' ? envelope.content.event : null;
    if (event === 'connected') {
      lastConnectedAt.value = new Date().toISOString();
      notifyReconnect();
    }

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

  function onReconnect(handler: () => void): () => void {
    reconnectHandlers.value.add(handler);
    return () => {
      reconnectHandlers.value.delete(handler);
    };
  }

  // ── Send Message ───────────────────────────────────────────

  /**
   * Send a chat message via the WebSocket connection.
   *
   * Only sends when the connection manager has been initialized
   * (via connect()) and the underlying WebSocket is open.  If
   * called before connect(), the message is silently dropped
   * with a warning — callers should guard with isConnected().
   */
  function sendMessage(text: string): void {
    if (!conn) {
      log.warn('sendMessage called before connect(); message dropped');
      return;
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
    lastEventAt: readonly(lastEventAt),
    lastConnectedAt: readonly(lastConnectedAt),
    stale: readonly(stale),

    // Actions
    connect,
    disconnect,
    sendMessage,
    onType,
    onReconnect,

    // Getters
    isConnected,
    isConnecting,
  };
});
