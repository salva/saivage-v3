/**
 * Bounded client-layer unit tests for the WebSocket Pinia store and
 * connection manager foundation.
 *
 * Tests cover:
 *  1. Event routing by envelope.type and unsubscribe behavior via onType()
 *  2. Connection lifecycle (connect/disconnect state transitions)
 *  3. sendMessage delegation behavior
 *  4. Duplicate connect listener registration
 *  5. Connection-state synchronization (sync polling behavior)
 *  6. Bounded defect fix: sendMessage does not lazily create conn without connecting
 *
 * These tests mock the WebSocket connection manager (../api/websocket)
 * so we verify store-side logic without a real WebSocket.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// ── Mock the WebSocket connection manager ────────────────────
// We mock createWsConnection/getWsConnection so the store does not
// create real WebSocket objects. The mock returns a fully controllable
// connection manager with reactive refs.

let mockConnState: { value: string };
let mockConnSessionId: { value: string | null };
let mockConnReconnectAttempts: { value: number };
let mockConnHandlers: Set<(envelope: any) => void>;
let mockConnTypeHandlers: Map<string, Set<(envelope: any) => void>>;
let mockSendMessageCalls: string[];
let mockConnConnectCalls: number;
let mockConnDisconnectCalls: number;

function resetMockConn() {
  mockConnState = { value: 'offline' };
  mockConnSessionId = { value: null };
  mockConnReconnectAttempts = { value: 0 };
  mockConnHandlers = new Set();
  mockConnTypeHandlers = new Map();
  mockSendMessageCalls = [];
  mockConnConnectCalls = 0;
  mockConnDisconnectCalls = 0;
}

function createMockConnectionManager() {
  return {
    state: mockConnState,
    sessionId: mockConnSessionId,
    reconnectAttempts: mockConnReconnectAttempts,
    connect: vi.fn(() => {
      mockConnConnectCalls++;
      mockConnState.value = 'connecting';
      // Simulate async connection — in tests we control state manually
    }),
    disconnect: vi.fn(() => {
      mockConnDisconnectCalls++;
      mockConnState.value = 'offline';
      mockConnSessionId.value = null;
      mockConnReconnectAttempts.value = 0;
    }),
    sendMessage: vi.fn((text: string) => {
      mockSendMessageCalls.push(text);
    }),
    onEvent: vi.fn((handler: (envelope: any) => void) => {
      mockConnHandlers.add(handler);
      return () => {
        mockConnHandlers.delete(handler);
      };
    }),
    onType: vi.fn((type: string, handler: (envelope: any) => void) => {
      let set = mockConnTypeHandlers.get(type);
      if (!set) {
        set = new Set();
        mockConnTypeHandlers.set(type, set);
      }
      const wrapped = (envelope: any) => {
        if (envelope.type === type) {
          handler(envelope);
        }
      };
      set.add(wrapped);
      return () => {
        set?.delete(wrapped);
      };
    }),
  };
}

let mockConnManager: ReturnType<typeof createMockConnectionManager>;

vi.mock('../api/websocket', () => ({
  getWsConnection: vi.fn(() => mockConnManager),
  createWsConnection: vi.fn(() => mockConnManager),
}));

// Must import AFTER the mock is set up
import { useWsStore } from '../stores/ws';
import { getWsConnection } from '../api/websocket';

// ── Helpers ───────────────────────────────────────────────────

function setupStore() {
  resetMockConn();
  mockConnManager = createMockConnectionManager();
  setActivePinia(createPinia());
  return useWsStore();
}

/** Dispatch an event through the mock connection manager's global handlers,
 *  simulating what the real WebSocket would do. */
function fireWsEvent(type: string, content: Record<string, unknown> = {}) {
  const envelope = { type, content };
  for (const handler of mockConnHandlers) {
    handler(envelope);
  }
}

/** Dispatch an event through the mock's type-specific handlers. */
function fireWsTypedEvent(type: string, content: Record<string, unknown> = {}) {
  const envelope = { type, content };
  const handlers = mockConnTypeHandlers.get(type);
  if (handlers) {
    for (const h of handlers) {
      h(envelope);
    }
  }
}

// ── Tests ─────────────────────────────────────────────────────

describe('useWsStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Initial State ───────────────────────────────────────────

  describe('initial state', () => {
    it('has offline/null/0 defaults', () => {
      const store = setupStore();
      expect(store.connectionState).toBe('offline');
      expect(store.sessionId).toBeNull();
      expect(store.reconnectAttempts).toBe(0);
      expect(store.isConnected()).toBe(false);
      expect(store.isConnecting()).toBe(false);
    });
  });

  // ── Connection Lifecycle ────────────────────────────────────

  describe('connect()', () => {
    it('creates the connection manager on first call', () => {
      const store = setupStore();
      store.connect();
      expect(getWsConnection).toHaveBeenCalledOnce();
    });

    it('registers a global onEvent handler on the connection manager', () => {
      const store = setupStore();
      store.connect();
      expect(mockConnManager.onEvent).toHaveBeenCalledOnce();
      expect(mockConnHandlers.size).toBe(1);
    });

    it('calls conn.connect() to initiate the WebSocket', () => {
      const store = setupStore();
      store.connect();
      expect(mockConnConnectCalls).toBe(1);
    });

    it('syncs state from the connection manager after connect', () => {
      const store = setupStore();
      // Set mock state to simulate a connected WebSocket
      mockConnState.value = 'connected';
      mockConnSessionId.value = 'sess-123';
      mockConnReconnectAttempts.value = 0;

      store.connect();

      expect(store.connectionState).toBe('connected');
      expect(store.sessionId).toBe('sess-123');
      expect(store.reconnectAttempts).toBe(0);
    });

    it('does NOT create a second connection manager on repeated calls', () => {
      const store = setupStore();
      store.connect();
      store.connect();
      // getWsConnection should only be called once (first connect)
      expect(getWsConnection).toHaveBeenCalledTimes(1);
      // onEvent should only be registered once
      expect(mockConnManager.onEvent).toHaveBeenCalledTimes(1);
      // connect on the manager should be called twice though
      expect(mockConnConnectCalls).toBe(2);
    });

    it('does not register duplicate onEvent handlers on repeated connect', () => {
      const store = setupStore();
      store.connect();
      const handlerCount = mockConnHandlers.size;
      store.connect();
      expect(mockConnHandlers.size).toBe(handlerCount);
    });

    it('starts sync polling on connect', () => {
      vi.useFakeTimers();
      const store = setupStore();
      store.connect();

      // Change mock state after connect
      mockConnState.value = 'connected';
      mockConnSessionId.value = 'polled-session';

      // Advance time past the polling interval (250ms)
      vi.advanceTimersByTime(300);

      expect(store.connectionState).toBe('connected');
      expect(store.sessionId).toBe('polled-session');

      vi.useRealTimers();
    });

    it('isConnected() returns true when connectionState is connected', () => {
      const store = setupStore();
      mockConnState.value = 'connected';
      store.connect();
      expect(store.isConnected()).toBe(true);
      expect(store.isConnecting()).toBe(false);
    });

    it('isConnecting() returns true when connectionState is connecting', () => {
      const store = setupStore();
      mockConnState.value = 'connecting';
      store.connect();
      expect(store.isConnecting()).toBe(true);
      expect(store.isConnected()).toBe(false);
    });
  });

  describe('disconnect()', () => {
    it('calls conn.disconnect() on the connection manager', () => {
      const store = setupStore();
      store.connect();
      store.disconnect();
      expect(mockConnDisconnectCalls).toBe(1);
    });

    it('resets store state to offline/null/0', () => {
      const store = setupStore();
      mockConnState.value = 'connected';
      mockConnSessionId.value = 'sess-456';
      mockConnReconnectAttempts.value = 3;
      store.connect();

      store.disconnect();

      expect(store.connectionState).toBe('offline');
      expect(store.sessionId).toBeNull();
      expect(store.reconnectAttempts).toBe(0);
    });

    it('stops sync polling on disconnect', () => {
      vi.useFakeTimers();
      const store = setupStore();
      store.connect();
      store.disconnect();

      // Change mock state — shouldn't be picked up
      mockConnState.value = 'connected';
      vi.advanceTimersByTime(500);

      expect(store.connectionState).toBe('offline');

      vi.useRealTimers();
    });

    it('is idempotent — calling disconnect twice does not crash', () => {
      const store = setupStore();
      store.connect();
      store.disconnect();
      store.disconnect();
      // Should not throw
      expect(mockConnDisconnectCalls).toBe(2);
    });

    it('handles disconnect before connect (no-op)', () => {
      const store = setupStore();
      store.disconnect();
      // No connection manager created, disconnect should be a no-op
      expect(store.connectionState).toBe('offline');
    });
  });

  describe('connect → disconnect → reconnect cycle', () => {
    it('reuses the same connection manager across cycles', () => {
      const store = setupStore();
      store.connect();
      store.disconnect();
      store.connect();

      // getWsConnection should only be called once total
      expect(getWsConnection).toHaveBeenCalledTimes(1);
      // onEvent should only be registered once
      expect(mockConnManager.onEvent).toHaveBeenCalledTimes(1);
      // connect on manager called twice
      expect(mockConnConnectCalls).toBe(2);
    });

    it('syncs fresh state after reconnect', () => {
      const store = setupStore();
      store.connect();
      store.disconnect();

      // Simulate server assigning a new session on reconnect
      mockConnState.value = 'connected';
      mockConnSessionId.value = 'sess-new';
      store.connect();

      expect(store.connectionState).toBe('connected');
      expect(store.sessionId).toBe('sess-new');
    });

    it('restarts sync polling after reconnect', () => {
      vi.useFakeTimers();
      const store = setupStore();
      store.connect();
      store.disconnect();

      // Reconnect and change state
      mockConnState.value = 'connected';
      mockConnSessionId.value = 'reconnected-sess';
      store.connect();

      vi.advanceTimersByTime(300);
      expect(store.sessionId).toBe('reconnected-sess');

      vi.useRealTimers();
    });
  });

  // ── Event Routing via onType() ──────────────────────────────

  describe('onType() — event routing', () => {
    it('registers a handler for a specific event type', () => {
      const store = setupStore();
      const handler = vi.fn();
      const unsubscribe = store.onType('message', handler);

      expect(unsubscribe).toBeTypeOf('function');
    });

    it('routes events to the correct type handler', () => {
      const store = setupStore();
      store.connect(); // sets up global onEvent → routeEvent

      const messageHandler = vi.fn();
      const activityHandler = vi.fn();
      const statusHandler = vi.fn();

      store.onType('message', messageHandler);
      store.onType('activity', activityHandler);
      store.onType('status', statusHandler);

      // Fire a message event
      fireWsEvent('message', { text: 'hello' });

      expect(messageHandler).toHaveBeenCalledTimes(1);
      expect(messageHandler).toHaveBeenCalledWith({
        type: 'message',
        content: { text: 'hello' },
      });
      expect(activityHandler).not.toHaveBeenCalled();
      expect(statusHandler).not.toHaveBeenCalled();
    });

    it('routes activity events to the correct handler only', () => {
      const store = setupStore();
      store.connect();

      const messageHandler = vi.fn();
      const activityHandler = vi.fn();

      store.onType('message', messageHandler);
      store.onType('activity', activityHandler);

      fireWsEvent('activity', { action: 'thinking', agent: 'planner' });

      expect(activityHandler).toHaveBeenCalledTimes(1);
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('routes status events to the correct handler only', () => {
      const store = setupStore();
      store.connect();

      const statusHandler = vi.fn();
      const errorHandler = vi.fn();

      store.onType('status', statusHandler);
      store.onType('error', errorHandler);

      fireWsEvent('status', { event: 'runtime-state' });

      expect(statusHandler).toHaveBeenCalledTimes(1);
      expect(errorHandler).not.toHaveBeenCalled();
    });

    it('routes error events to the correct handler only', () => {
      const store = setupStore();
      store.connect();

      const errorHandler = vi.fn();
      const messageHandler = vi.fn();

      store.onType('error', errorHandler);
      store.onType('message', messageHandler);

      fireWsEvent('error', { code: 'CONNECTION_REFUSED' });

      expect(errorHandler).toHaveBeenCalledTimes(1);
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('routes thinking events to the correct handler only', () => {
      const store = setupStore();
      store.connect();

      const thinkingHandler = vi.fn();
      const messageHandler = vi.fn();

      store.onType('thinking', thinkingHandler);
      store.onType('message', messageHandler);

      fireWsEvent('thinking', { thought: 'analyzing request...' });

      expect(thinkingHandler).toHaveBeenCalledTimes(1);
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('supports multiple handlers for the same event type', () => {
      const store = setupStore();
      store.connect();

      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const handler3 = vi.fn();

      store.onType('message', handler1);
      store.onType('message', handler2);
      store.onType('message', handler3);

      fireWsEvent('message', { text: 'broadcast' });

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
      expect(handler3).toHaveBeenCalledTimes(1);
    });

    it('does not route events to unsubscribed handlers', () => {
      const store = setupStore();
      store.connect();

      const handler = vi.fn();
      const unsubscribe = store.onType('message', handler);

      // Unsubscribe
      unsubscribe();

      fireWsEvent('message', { text: 'should not be received' });

      expect(handler).not.toHaveBeenCalled();
    });

    it('unsubscribe removes only the target handler, not others', () => {
      const store = setupStore();
      store.connect();

      const handler1 = vi.fn();
      const handler2 = vi.fn();

      store.onType('message', handler1);
      const unsub2 = store.onType('message', handler2);

      unsub2(); // remove handler2

      fireWsEvent('message', { text: 'only handler1' });

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).not.toHaveBeenCalled();
    });

    it('unsubscribe cleans up empty type entries', () => {
      const store = setupStore();
      store.connect();

      const handler = vi.fn();
      const unsubscribe = store.onType('message', handler);
      unsubscribe();

      // Fire event — handler should not be called, and the type map entry
      // should have been removed (size 0 → delete)
      fireWsEvent('message', { text: 'none' });
      expect(handler).not.toHaveBeenCalled();

      // Re-registering should work (verifying cleanup didn't break anything)
      const handler2 = vi.fn();
      store.onType('message', handler2);

      fireWsEvent('message', { text: 'new registration' });
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('double-unsubscribe does not throw', () => {
      const store = setupStore();
      store.connect();

      const handler = vi.fn();
      const unsubscribe = store.onType('message', handler);

      unsubscribe();
      // Second unsubscribe should not throw
      expect(() => unsubscribe()).not.toThrow();
    });

    it('unsubscribe is safe when called after disconnect', () => {
      const store = setupStore();
      store.connect();

      const handler = vi.fn();
      const unsubscribe = store.onType('message', handler);

      store.disconnect();

      // Unsubscribe after disconnect should not throw
      expect(() => unsubscribe()).not.toThrow();
    });

    it('handlers survive disconnect and continue working after reconnect', () => {
      const store = setupStore();
      store.connect();

      const handler = vi.fn();
      store.onType('message', handler);

      store.disconnect();
      store.connect(); // reconnect — old onEvent handler still registered

      fireWsEvent('message', { text: 'after reconnect' });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('event routing works before connect (store-only routing)', () => {
      // Even without connect(), onType should register handlers.
      // They just won't receive events until a real WebSocket dispatches them.
      const store = setupStore();

      const handler = vi.fn();
      const unsubscribe = store.onType('message', handler);
      expect(unsubscribe).toBeTypeOf('function');

      // Without connect, no global onEvent handler exists, so firing
      // mockConnHandlers does nothing. But the onType registration itself
      // should not throw.
    });

    it('handler errors do not prevent other handlers from running', () => {
      const store = setupStore();
      store.connect();

      const badHandler = vi.fn(() => {
        throw new Error('Handler error!');
      });
      const goodHandler = vi.fn();

      store.onType('message', badHandler);
      store.onType('message', goodHandler);

      // Should not throw — routeEvent catches handler errors
      expect(() => {
        fireWsEvent('message', { text: 'test' });
      }).not.toThrow();

      // Bad handler was called and threw
      expect(badHandler).toHaveBeenCalledTimes(1);
      // Good handler still ran
      expect(goodHandler).toHaveBeenCalledTimes(1);
    });

    it('events of unregistered types do not cause errors', () => {
      const store = setupStore();
      store.connect();

      const messageHandler = vi.fn();
      store.onType('message', messageHandler);

      // Fire an event type that has no handlers registered
      expect(() => {
        fireWsEvent('thinking' as any, { thought: 'hi' });
      }).not.toThrow();

      expect(messageHandler).not.toHaveBeenCalled();
    });
  });

  // ── sendMessage Delegation ──────────────────────────────────

  describe('sendMessage()', () => {
    it('delegates to conn.sendMessage when connected', () => {
      const store = setupStore();
      store.connect();
      mockConnState.value = 'connected';

      store.sendMessage('Hello, World!');

      expect(mockConnManager.sendMessage).toHaveBeenCalledWith('Hello, World!');
      expect(mockSendMessageCalls).toEqual(['Hello, World!']);
    });

    it('delegates multiple messages in sequence', () => {
      const store = setupStore();
      store.connect();
      mockConnState.value = 'connected';

      store.sendMessage('First');
      store.sendMessage('Second');
      store.sendMessage('Third');

      expect(mockSendMessageCalls).toEqual(['First', 'Second', 'Third']);
    });

    it('does NOT create a connection manager lazily — drops message before connect', () => {
      const store = setupStore();

      // sendMessage before connect — FIXED: no longer lazily creates conn
      store.sendMessage('early message');

      // getWsConnection should NOT have been called (conn remains null, sendMessage guards)
      expect(getWsConnection).not.toHaveBeenCalled();
      // sendMessage should NOT have been delegated to the manager
      expect(mockConnManager.sendMessage).not.toHaveBeenCalled();
    });

    it('still delegates to conn.sendMessage after disconnect (conn exists)', () => {
      const store = setupStore();
      store.connect();
      store.disconnect();

      // conn still exists (it's not nulled on disconnect), but the underlying
      // WebSocket is closed. The store delegates to conn.sendMessage which
      // checks ws.readyState and drops if not OPEN.
      store.sendMessage('after disconnect');

      expect(mockConnManager.sendMessage).toHaveBeenCalledWith('after disconnect');
    });

    it('handles empty string message', () => {
      const store = setupStore();
      store.connect();
      mockConnState.value = 'connected';

      store.sendMessage('');

      expect(mockConnManager.sendMessage).toHaveBeenCalledWith('');
    });
  });

  // ── Connection Manager onType (manager-level) ───────────────

  describe('connection manager onType', () => {
    it('connection manager onType filters by event type', () => {
      const store = setupStore();
      store.connect();

      const handler = vi.fn();
      mockConnManager.onType('message', handler);

      fireWsTypedEvent('message', { text: 'hi' });
      expect(handler).toHaveBeenCalledTimes(1);

      fireWsTypedEvent('status', { event: 'connected' });
      // Should NOT trigger message handler
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
