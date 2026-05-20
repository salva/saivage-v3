/**
 * Bounded client-layer unit tests for the WebSocket Pinia store.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

let mockConnState: { value: string };
let mockConnSessionId: { value: string | null };
let mockConnReconnectAttempts: { value: number };
let mockConnHandlers: Set<(envelope: any) => void>;
let mockSendMessageCalls: string[];
let mockConnConnectCalls: number;
let mockConnDisconnectCalls: number;
let authToken = 'test-token';
const ingestWsEventSpy = vi.fn();

function resetMockConn() {
  mockConnState = { value: 'offline' };
  mockConnSessionId = { value: null };
  mockConnReconnectAttempts = { value: 0 };
  mockConnHandlers = new Set();
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
  };
}

let mockConnManager: ReturnType<typeof createMockConnectionManager>;

vi.mock('../api/websocket', () => ({
  getWsConnection: vi.fn(() => mockConnManager),
}));

vi.mock('../api/auth', () => ({
  getAuthToken: vi.fn(() => authToken),
}));

vi.mock('../stores/analystChat', () => ({
  useAnalystChat: () => ({ ingestWsEvent: ingestWsEventSpy }),
}));

import { useWsStore } from '../stores/ws';
import { getWsConnection } from '../api/websocket';

function setupStore() {
  resetMockConn();
  mockConnManager = createMockConnectionManager();
  authToken = 'test-token';
  ingestWsEventSpy.mockReset();
  setActivePinia(createPinia());
  return useWsStore();
}

function fireWsEvent(type: string, content: Record<string, unknown> = {}) {
  const envelope = { type, content };
  for (const handler of mockConnHandlers) {
    handler(envelope);
  }
}

describe('useWsStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('connect()', () => {
    it('creates the connection manager on first call', () => {
      const store = setupStore();
      store.connect();
      expect(getWsConnection).toHaveBeenCalledOnce();
    });

    it('calls conn.connect() to initiate the WebSocket when token exists', () => {
      const store = setupStore();
      store.connect();
      expect(mockConnConnectCalls).toBe(1);
      expect(store.connectionState).toBe('offline');
    });

    it('marks no-token when no auth token is available', () => {
      const store = setupStore();
      authToken = '';

      store.connect();

      expect(mockConnConnectCalls).toBe(1);
      expect(store.connectionState).toBe('no-token');
      expect(store.stale).toBe(false);
    });

    it('does not override an already connected transport with no-token when token exists', () => {
      const store = setupStore();
      mockConnState.value = 'connected';
      mockConnSessionId.value = 'sess-123';

      store.connect();

      expect(store.connectionState).toBe('connected');
      expect(store.sessionId).toBe('sess-123');
    });

    it('starts sync polling on connect', () => {
      vi.useFakeTimers();
      const store = setupStore();
      store.connect();
      mockConnState.value = 'connected';
      mockConnSessionId.value = 'polled-session';
      vi.advanceTimersByTime(300);
      expect(store.connectionState).toBe('connected');
      expect(store.sessionId).toBe('polled-session');
      vi.useRealTimers();
    });
  });

  describe('disconnect()', () => {
    it('calls conn.disconnect() on the connection manager', () => {
      const store = setupStore();
      store.connect();
      store.disconnect();
      expect(mockConnDisconnectCalls).toBe(1);
      expect(store.connectionState).toBe('offline');
    });
  });

  describe('onType() — event routing', () => {
    it('routes events to the correct type handler', () => {
      const store = setupStore();
      store.connect();
      const messageHandler = vi.fn();
      const activityHandler = vi.fn();
      store.onType('message', messageHandler);
      store.onType('activity', activityHandler);

      fireWsEvent('message', { text: 'hello' });

      expect(messageHandler).toHaveBeenCalledTimes(1);
      expect(activityHandler).not.toHaveBeenCalled();
    });

    it('unsubscribe removes only the target handler', () => {
      const store = setupStore();
      store.connect();
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      store.onType('message', handler1);
      const unsub2 = store.onType('message', handler2);
      unsub2();

      fireWsEvent('message', { text: 'only handler1' });

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).not.toHaveBeenCalled();
    });

    it('forwards relevant analyst activity events exactly once', () => {
      const store = setupStore();
      store.connect();

      fireWsEvent('activity', { event: 'analyst_tool_invoked', sessionId: 'chat-1', tool: 'read_file', success: true, summary: 'opened docs' });

      expect(ingestWsEventSpy).toHaveBeenCalledTimes(1);
      expect(ingestWsEventSpy).toHaveBeenCalledWith({ event: 'analyst_tool_invoked', sessionId: 'chat-1', tool: 'read_file', success: true, summary: 'opened docs' });
    });

    it('uses shared predicates for activity ingestion and ignores non-activity status events', () => {
      const store = setupStore();
      store.connect();

      fireWsEvent('activity', { event: 'tool_invocation', tool: 'read_file' });
      fireWsEvent('status', { event: 'connected' });

      expect(ingestWsEventSpy).toHaveBeenCalledTimes(1);
      expect(ingestWsEventSpy).toHaveBeenCalledWith({ event: 'tool_invocation', tool: 'read_file' });
    });
  });

  describe('reconnect + stale semantics', () => {
    it('notifies reconnect handlers when a connected event arrives', () => {
      const store = setupStore();
      store.connect();
      const onReconnect = vi.fn();
      store.onReconnect(onReconnect);

      fireWsEvent('status', { event: 'connected' });

      expect(onReconnect).toHaveBeenCalledTimes(1);
      expect(store.lastConnectedAt).toBeTruthy();
    });

    it('marks unauthorized from websocket error envelopes', () => {
      const store = setupStore();
      store.connect();

      fireWsEvent('error', { code: 'unauthorized' });

      expect(store.connectionState).toBe('unauthorized');
      expect(store.stale).toBe(false);
    });

    it('marks stale when transport goes offline after being connected', () => {
      vi.useFakeTimers();
      const store = setupStore();
      mockConnState.value = 'connected';
      store.connect();
      fireWsEvent('status', { event: 'connected' });

      mockConnState.value = 'offline';
      vi.advanceTimersByTime(300);

      expect(store.connectionState).toBe('offline');
      expect(store.stale).toBe(true);
      vi.useRealTimers();
    });
  });

  describe('sendMessage()', () => {
    it('delegates to conn.sendMessage after connect', () => {
      const store = setupStore();
      store.connect();
      store.sendMessage('Hello, World!');
      expect(mockConnManager.sendMessage).toHaveBeenCalledWith('Hello, World!');
      expect(mockSendMessageCalls).toEqual(['Hello, World!']);
    });

    it('does NOT create a connection manager lazily — drops message before connect', () => {
      const store = setupStore();
      store.sendMessage('early message');
      expect(getWsConnection).not.toHaveBeenCalled();
    });
  });
});
