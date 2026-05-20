/**
 * Pinia store for WebSocket connection state and event routing.
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
import { isAnalystActivityContent } from '../api/contracts';
import { useAnalystChat } from './analystChat';

const log = createLogger('store:ws');
const STALE_AFTER_MS = 30_000;

export const useWsStore = defineStore('ws', () => {
  const connectionState = ref<WsConnectionState>('offline');
  const sessionId = ref<string | null>(null);
  const reconnectAttempts = ref(0);
  const lastEventAt = ref<string | null>(null);
  const lastConnectedAt = ref<string | null>(null);
  const stale = ref(false);
  const typeHandlers = shallowRef<Map<WsEventType, Set<WsEventHandler>>>(new Map());
  const reconnectHandlers = shallowRef(new Set<() => void>());
  let conn: WsConnectionManager | null = null;

  function syncFromConnection(): void {
    if (!conn) return;
    connectionState.value = conn.state.value;
    sessionId.value = conn.sessionId.value;
    reconnectAttempts.value = conn.reconnectAttempts.value;
  }

  function markEventReceived(): void {
    lastEventAt.value = new Date().toISOString();
    stale.value = false;
  }

  function notifyReconnect(): void {
    for (const handler of reconnectHandlers.value) {
      try { handler(); } catch (err) { log.error('Reconnect handler error', err); }
    }
  }

  function refreshDerivedState(): void {
    syncFromConnection();
    if (connectionState.value === 'connected') {
      if (!lastConnectedAt.value) lastConnectedAt.value = new Date().toISOString();
      stale.value = lastEventAt.value ? Date.now() - new Date(lastEventAt.value).getTime() > STALE_AFTER_MS : false;
      return;
    }
    lastConnectedAt.value = null;
    stale.value = connectionState.value !== 'no-token' && connectionState.value !== 'unauthorized';
  }

  function connect(): void {
    if (!conn) {
      conn = getWsConnection();
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
    startSyncPolling();
  }

  function disconnect(): void {
    if (conn) conn.disconnect();
    stopSyncPolling();
    connectionState.value = 'offline';
    sessionId.value = null;
    reconnectAttempts.value = 0;
    lastConnectedAt.value = null;
    stale.value = false;
  }

  let syncTimer: ReturnType<typeof setInterval> | null = null;
  function startSyncPolling(): void {
    if (syncTimer) return;
    syncTimer = setInterval(() => {
      const prev = connectionState.value;
      refreshDerivedState();
      if (prev !== 'connected' && connectionState.value === 'connected') notifyReconnect();
    }, 250);
  }

  function stopSyncPolling(): void {
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
  }

  function routeEvent(envelope: WsEnvelope): void {
    refreshDerivedState();
    markEventReceived();

    if (envelope.type === 'error' && envelope.content?.code === 'unauthorized') {
      connectionState.value = 'unauthorized';
      stale.value = false;
    }

    const event = typeof envelope.content?.event === 'string' ? envelope.content.event : null;
    if (event === 'connected') {
      lastConnectedAt.value = new Date().toISOString();
      notifyReconnect();
    }

    if (isAnalystActivityContent(envelope.content)) {
      useAnalystChat().ingestWsEvent(envelope.content);
    }

    const handlers = typeHandlers.value.get(envelope.type);
    if (handlers) {
      for (const handler of handlers) {
        try { handler(envelope); } catch (err) { log.error('Store event handler error', err); }
      }
    }
  }

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
        if (current.size === 0) typeHandlers.value.delete(type);
      }
    };
  }

  function onReconnect(handler: () => void): () => void {
    reconnectHandlers.value.add(handler);
    return () => reconnectHandlers.value.delete(handler);
  }

  function sendMessage(text: string): void {
    if (!conn) {
      log.warn('sendMessage called before connect(); message dropped');
      return;
    }
    conn.sendMessage(text);
  }

  const isConnected = () => connectionState.value === 'connected';
  const isConnecting = () => connectionState.value === 'connecting';

  return {
    connectionState: readonly(connectionState),
    sessionId: readonly(sessionId),
    reconnectAttempts: readonly(reconnectAttempts),
    lastEventAt: readonly(lastEventAt),
    lastConnectedAt: readonly(lastConnectedAt),
    stale: readonly(stale),
    connect,
    disconnect,
    sendMessage,
    onType,
    onReconnect,
    isConnected,
    isConnecting,
  };
});
