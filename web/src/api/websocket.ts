/**
 * Saivage v3 WebSocket Connection Manager
 *
 * Manages a single WebSocket connection to the server at /ws,
 * with auto-reconnect, visible connection state, and event
 * dispatching to registered listeners.
 *
 * All messages use the JSON envelope per docs/design/server-api.md:
 *   { "type": "message | activity | thinking | status | error", "content": { ... } }
 */

import type { WsConnectionState, WsEnvelope, WsEventType } from './types';
import { issueWebSocketTicket } from './client';
import { getAuthToken } from './auth';
import { buildInboundAnalystMessageEnvelope, LiveSyncInvalidateFrameSchema, parseKnownWsEnvelope, parseWsEnvelope, type LiveSyncInvalidateFrame } from './contracts';
import { createLogger } from '../utils/logger';

// ── Re-export auth helper ────────────────────────────────────

export { getAuthToken };

// ── Types ─────────────────────────────────────────────────────

export type WsEventHandler = (envelope: WsEnvelope) => void;
export type WsStateHandler = (state: WsConnectionState) => void;
export type WsOpenHandler = () => void;
export type WsSyncFrameHandler = (frame: LiveSyncInvalidateFrame) => void;

export interface WsConnectionManager {
  /** Current connection state (reactive ref). */
  readonly state: { value: WsConnectionState };

  /** The session ID assigned by the server on connect. */
  readonly sessionId: { value: string | null };

  /** Number of reconnection attempts in the current sequence. */
  readonly reconnectAttempts: { value: number };

  /** Connect (or reconnect) the WebSocket. */
  connect(): void;

  /** Disconnect and stop auto-reconnect. */
  disconnect(): void;

  /** Send a chat message to the analyst via WebSocket. */
  sendMessage(text: string): void;

  /** Send a low-level JSON payload over the socket. */
  sendRaw(payload: unknown): boolean;

  /** Register an event handler for all incoming events. */
  onEvent(handler: WsEventHandler): () => void;

  /** Register a handler for live-sync invalidate frames. */
  onSyncFrame(handler: WsSyncFrameHandler): () => void;

  /** Register a handler fired when the socket opens. */
  onOpen(handler: WsOpenHandler): () => void;

  /** Register a handler fired whenever connection state changes. */
  onState(handler: WsStateHandler): () => void;

  /** Register a handler for a specific event type. */
  onType(type: WsEventType, handler: WsEventHandler): () => void;
}

// ── Configuration ─────────────────────────────────────────────

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_MULTIPLIER = 1.5;

// ── Reactive Helpers ──────────────────────────────────────────
// (Simple reactive refs without Pinia dependency, usable before store init.)

function makeRef<T>(initial: T): { value: T } {
  return { value: initial };
}

// ── Implementation ────────────────────────────────────────────

export function createWsConnection(): WsConnectionManager {
  // ── State ─────────────────────────────────────────────────

  const state = makeRef<WsConnectionState>('offline');
  const sessionId = makeRef<string | null>(null);
  const reconnectAttempts = makeRef<number>(0);

  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let shouldReconnect = true;
  let connectAttempt = 0;
  const handlers = new Set<WsEventHandler>();
  const syncHandlers = new Set<WsSyncFrameHandler>();
  const openHandlers = new Set<WsOpenHandler>();
  const stateHandlers = new Set<WsStateHandler>();

  const log = createLogger('ws');

  function setState(next: WsConnectionState): void {
    if (state.value === next) return;
    state.value = next;
    for (const handler of stateHandlers) {
      try { handler(next); } catch (err) { log.error('WS state handler error', err); }
    }
  }

  // ── Connection ────────────────────────────────────────────

  function connect(): void {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    shouldReconnect = true;
    setState('connecting');
    const attempt = ++connectAttempt;

    void openWithFreshTicket(attempt);
  }

  async function openWithFreshTicket(attempt: number): Promise<void> {
    try {
      const { ticket } = await issueWebSocketTicket();
      if (!shouldReconnect || attempt !== connectAttempt) {
        return;
      }

      // Build WebSocket URL with a short-lived one-use ticket. API bearer tokens
      // must never be placed in WebSocket URLs.
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = new URL('/ws', `${protocol}//${window.location.host}`);
      wsUrl.searchParams.set('ticket', ticket);

      ws = new WebSocket(wsUrl.toString());

      ws.onopen = () => {
        setState('connected');
        reconnectAttempts.value = 0;
        log.info('WebSocket connected');
        for (const handler of openHandlers) {
          try { handler(); } catch (err) { log.error('WS open handler error', err); }
        }
      };

      ws.onclose = (event) => {
        log.warn(`WebSocket closed: code=${event.code} reason=${event.reason}`);
        ws = null;

        if (event.code === 1008) {
          // Policy violation — authentication failure
          setState('unauthorized');
          sessionId.value = null;
          shouldReconnect = false;
        } else if (shouldReconnect) {
          setState('connecting');
          scheduleReconnect();
        } else {
          setState('offline');
        }
      };

      ws.onerror = () => {
        log.error('WebSocket error');
        // onclose will fire after onerror
      };

      ws.onmessage = (event) => {
        try {
          const data = typeof event.data === 'string'
            ? event.data
            : new TextDecoder().decode(event.data as ArrayBuffer);
          const rawEnvelope = JSON.parse(data) as unknown;
          const syncFrame = LiveSyncInvalidateFrameSchema.safeParse(rawEnvelope);
          if (syncFrame.success) {
            for (const handler of syncHandlers) {
              try { handler(syncFrame.data); } catch (err) { log.error('WS sync frame handler error', err); }
            }
            return;
          }

          const envelope = parseWsEnvelope(rawEnvelope);
          if (!envelope) {
            log.warn('Dropped structurally invalid WS envelope');
            return;
          }
          try {
            parseKnownWsEnvelope(envelope);
          } catch (err) {
            log.error('Dropped malformed known WS envelope', err);
            return;
          }

          // Extract session ID from connect status event
          if (envelope.type === 'status' && envelope.content?.event === 'connected') {
            sessionId.value = envelope.content.sessionId as string;
          }

          // Dispatch to all handlers
          for (const handler of handlers) {
            try {
              handler(envelope);
            } catch (err) {
              log.error('WS event handler error', err);
            }
          }
        } catch (err) {
          log.error('Failed to parse WS message', err);
        }
      };
    } catch (err) {
      log.error('Failed to create WebSocket', err);
      setState('unauthorized');
      sessionId.value = null;
      shouldReconnect = false;
    }
  }

  // ── Reconnection ──────────────────────────────────────────

  function scheduleReconnect(): void {
    if (reconnectTimer) clearTimeout(reconnectTimer);

    const attempt = reconnectAttempts.value + 1;
    reconnectAttempts.value = attempt;

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(RECONNECT_MULTIPLIER, attempt - 1),
      RECONNECT_MAX_MS,
    );

    log.info(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempt})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (shouldReconnect) {
        connect();
      }
    }, delay);
  }

  // ── Disconnect ────────────────────────────────────────────

  function disconnect(): void {
    shouldReconnect = false;
    connectAttempt++;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.close(1000, 'Client disconnect');
      ws = null;
    }
    setState('offline');
    sessionId.value = null;
    reconnectAttempts.value = 0;
  }

  // ── Send Message ──────────────────────────────────────────

  function sendMessage(text: string): void {
    sendRaw(buildInboundAnalystMessageEnvelope(text));
  }

  function sendRaw(payload: unknown): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      log.warn('Cannot send payload: WebSocket not connected');
      return false;
    }
    ws.send(JSON.stringify(payload));
    return true;
  }

  // ── Event Handlers ────────────────────────────────────────

  function onEvent(handler: WsEventHandler): () => void {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }

  function onSyncFrame(handler: WsSyncFrameHandler): () => void {
    syncHandlers.add(handler);
    return () => syncHandlers.delete(handler);
  }

  function onOpen(handler: WsOpenHandler): () => void {
    openHandlers.add(handler);
    return () => openHandlers.delete(handler);
  }

  function onState(handler: WsStateHandler): () => void {
    stateHandlers.add(handler);
    return () => stateHandlers.delete(handler);
  }

  function onType(type: WsEventType, handler: WsEventHandler): () => void {
    const wrapped: WsEventHandler = (envelope) => {
      if (envelope.type === type) {
        handler(envelope);
      }
    };
    handlers.add(wrapped);
    return () => {
      handlers.delete(wrapped);
    };
  }

  return {
    state,
    sessionId,
    reconnectAttempts,
    connect,
    disconnect,
    sendMessage,
    sendRaw,
    onEvent,
    onSyncFrame,
    onOpen,
    onState,
    onType,
  };
}

// ── Module Singleton ──────────────────────────────────────────

let _instance: WsConnectionManager | null = null;

export function getWsConnection(): WsConnectionManager {
  if (!_instance) {
    _instance = createWsConnection();
  }
  return _instance;
}
