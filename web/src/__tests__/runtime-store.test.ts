/**
 * Bounded client-layer regression tests for the runtime Pinia store.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { ref } from 'vue';
import { useRuntimeStore } from '../stores/runtime';

vi.mock('../api/client', () => ({
  getRuntimeState: vi.fn(),
  pauseRuntime: vi.fn(),
  resumeRuntime: vi.fn(),
  ApiError: class extends Error {
    status: number;
    body: Record<string, unknown>;
    constructor(status: number, message: string, body: Record<string, unknown> = {}) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.body = body;
    }
    get isUnauthorized(): boolean { return this.status === 401; }
    get isNotFound(): boolean { return this.status === 404; }
  },
}));

vi.mock('../api/auth', () => ({
  getAuthToken: vi.fn(() => 'test-token'),
}));

import { getRuntimeState, pauseRuntime, resumeRuntime } from '../api/client';

const wsTypeHandlers = new Map<string, Set<(envelope: any) => void>>();
const reconnectHandlers = new Set<() => void>();
const wsState = {
  connectionState: ref('connected'),
  stale: ref(false),
};

function fireWsEvent(type: string, content: Record<string, unknown>) {
  const handlers = wsTypeHandlers.get(type);
  if (handlers) {
    for (const h of handlers) {
      h({ type, content });
    }
  }
}

function fireReconnect() {
  for (const handler of reconnectHandlers) {
    handler();
  }
}

vi.mock('../stores/ws', () => ({
  useWsStore: vi.fn(() => ({
    get connectionState() { return wsState.connectionState.value; },
    get stale() { return wsState.stale.value; },
    onType: (type: string, handler: (envelope: any) => void) => {
      let set = wsTypeHandlers.get(type);
      if (!set) {
        set = new Set();
        wsTypeHandlers.set(type, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
      };
    },
    onReconnect: (handler: () => void) => {
      reconnectHandlers.add(handler);
      return () => reconnectHandlers.delete(handler);
    },
  })),
}));

function setupStore() {
  setActivePinia(createPinia());
  wsTypeHandlers.clear();
  reconnectHandlers.clear();
  wsState.connectionState.value = 'connected';
  wsState.stale.value = false;
  return useRuntimeStore();
}

const mockRuntimeState = {
  status: 'running' as const,
  project_id: 'project' as const,
  pid: 1234,
  started_at: '2025-06-01T08:00:00Z',
  current_card_id: 'card-001',
  current_agent_session_id: 'session-abc',
  paused: false,
  paused_at: null,
  queue: ['card-002', 'card-003'],
  running_processes: ['proc-1', 'proc-2', 'proc-3'],
  updated_at: '2025-06-01T10:00:00Z',
};

const mockRuntimeStateIdle = {
  status: 'idle' as const,
  project_id: 'project' as const,
  pid: 1234,
  started_at: '2025-06-01T08:00:00Z',
  current_card_id: null,
  current_agent_session_id: null,
  paused: false,
  paused_at: null,
  queue: [],
  running_processes: [],
  updated_at: '2025-06-01T10:00:00Z',
};

const mockRuntimeStatePaused = {
  status: 'running' as const,
  project_id: 'project' as const,
  pid: 1234,
  started_at: '2025-06-01T08:00:00Z',
  current_card_id: 'card-001',
  current_agent_session_id: 'session-abc',
  paused: true,
  paused_at: '2025-06-01T10:30:00Z',
  queue: ['card-002'],
  running_processes: ['proc-1'],
  updated_at: '2025-06-01T10:30:00Z',
};

const mockRuntimeStateFrozen = {
  status: 'frozen' as const,
  project_id: 'project' as const,
  pid: 1234,
  started_at: '2025-06-01T08:00:00Z',
  current_card_id: null,
  current_agent_session_id: null,
  paused: false,
  paused_at: null,
  queue: [],
  running_processes: [],
  updated_at: '2025-06-01T11:00:00Z',
  frozen_reason: 'API rate limit exceeded',
};

const mockCardIndex = {
  total: 42,
  byStatus: { done: 30, failed: 3, blocked: 2, active: 5, backlog: 2 },
  byType: { code: 20, test: 10, plan: 5, goal: 3, doc: 4 },
};

const mockCardStoreHealth = {
  canonical: 'ok' as const,
  compatibilitySnapshots: 'degraded' as const,
  lastCompatibilitySnapshotWarning: {
    code: 'compatibility-snapshot-degraded' as const,
    operation: 'mutation-rebuild' as const,
    relativePath: '.saivage/cards/tree/project.children.json',
    message: 'Synthetic warning with token=[REDACTED]',
    occurredAt: '2026-01-01T00:00:00.000Z',
    canonicalCommitted: true,
  },
  warnings: [],
};

const mockRuntimeStateResponse = {
  runtime: mockRuntimeState,
  cardIndex: mockCardIndex,
};

const mockNullRuntimeResponse = {
  runtime: null,
  cardIndex: { total: 0, byStatus: {}, byType: {} },
};

describe('useRuntimeStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsTypeHandlers.clear();
    reconnectHandlers.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initial state', () => {
    it('has empty defaults', () => {
      const store = setupStore();
      expect(store.runtime).toBeNull();
      expect(store.cardIndex).toEqual({ total: 0, byStatus: {}, byType: {} });
      expect(store.loading).toBe(false);
      expect(store.error).toBeNull();
    });

    it('computed getters return sensible defaults when runtime is null', () => {
      const store = setupStore();
      expect(store.status).toBe('idle');
      expect(store.isRunning).toBe(false);
      expect(store.isPaused).toBe(false);
      expect(store.isFrozen).toBe(false);
      expect(store.currentCardId).toBeNull();
      expect(store.currentAgentSessionId).toBeNull();
      expect(store.queueLength).toBe(0);
      expect(store.runningProcessCount).toBe(0);
      expect(store.statusLabel).toBe('unknown');
      expect(store.doneGoals).toBe(0);
      expect(store.failedBlocked).toBe(0);
    });
  });

  describe('fetchState() success', () => {
    it('populates runtime and cardIndex on success', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue(mockRuntimeStateResponse);

      await store.fetchState();

      expect(store.runtime).toEqual(mockRuntimeState);
      expect(store.cardIndex).toEqual(mockCardIndex);
      expect(store.cardStoreHealth).toBeNull();
      expect(store.loading).toBe(false);
      expect(store.error).toBeNull();
    });

    it('correctly sets computed getters after fetch', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue(mockRuntimeStateResponse);

      await store.fetchState();

      expect(store.status).toBe('running');
      expect(store.isRunning).toBe(true);
      expect(store.isPaused).toBe(false);
      expect(store.isFrozen).toBe(false);
      expect(store.currentCardId).toBe('card-001');
      expect(store.currentAgentSessionId).toBe('session-abc');
      expect(store.queueLength).toBe(2);
      expect(store.runningProcessCount).toBe(3);
      expect(store.statusLabel).toBe('running');
      expect(store.runtime).toEqual(mockRuntimeState);
      expect(store.doneGoals).toBe(30);
      expect(store.failedBlocked).toBe(5);
    });

    it('handles null runtime in response', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue(mockNullRuntimeResponse);

      await store.fetchState();

      expect(store.runtime).toBeNull();
      expect(store.cardIndex).toEqual({ total: 0, byStatus: {}, byType: {} });
      expect(store.status).toBe('idle');
      expect(store.statusLabel).toBe('unknown');
    });

    it('statusLabel returns "paused" when paused is true regardless of status', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue({
        runtime: mockRuntimeStatePaused,
        cardIndex: mockCardIndex,
      });

      await store.fetchState();

      expect(store.status).toBe('running');
      expect(store.isPaused).toBe(true);
      expect(store.statusLabel).toBe('paused');
    });

    it('statusLabel returns "frozen" when status is frozen', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue({
        runtime: mockRuntimeStateFrozen,
        cardIndex: mockCardIndex,
      });

      await store.fetchState();

      expect(store.isFrozen).toBe(true);
      expect(store.statusLabel).toBe('frozen');
    });
  });



    it('populates CardStore health from REST and treats absence as unknown', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue({ ...mockRuntimeStateResponse, cardStoreHealth: mockCardStoreHealth });
      await store.fetchState();
      expect(store.cardStoreHealth).toEqual(mockCardStoreHealth);

      vi.mocked(getRuntimeState).mockResolvedValue(mockRuntimeStateResponse);
      await store.fetchState();
      expect(store.cardStoreHealth).toBeNull();
    });

  describe('fetchState() loading/error', () => {
    it('sets loading=true while fetching', async () => {
      const store = setupStore();
      let resolve: (v: typeof mockRuntimeStateResponse) => void;
      const promise = new Promise<typeof mockRuntimeStateResponse>((r) => { resolve = r; });
      vi.mocked(getRuntimeState).mockReturnValue(promise);

      const fetchPromise = store.fetchState();
      expect(store.loading).toBe(true);

      resolve!(mockRuntimeStateResponse);
      await fetchPromise;
      expect(store.loading).toBe(false);
    });

    it('sets unauthorized on 401 failures', async () => {
      const store = setupStore();
      const { ApiError } = await import('../api/client');
      vi.mocked(getRuntimeState).mockRejectedValue(new ApiError(401, 'Unauthorized', {}));

      await expect(store.fetchState()).rejects.toThrow('Unauthorized');
      expect(store.unauthorized).toBe(true);
      expect(store.runtimeDetail).toContain('valid API token');
    });
  });

  describe('pause()', () => {
    it('uses the RuntimeState returned by pauseRuntime instead of an optimistic patch', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue(mockRuntimeStateResponse);
      await store.fetchState();
      vi.mocked(pauseRuntime).mockResolvedValue({ ...mockRuntimeStatePaused, status: 'running', paused: true });

      await store.pause();

      expect(store.runtime).toEqual({ ...mockRuntimeStatePaused, status: 'running', paused: true });
      expect(store.isPaused).toBe(true);
      expect(store.status).toBe('running');
    });
  });

  describe('resume()', () => {
    it('after pause-then-resume, status and statusLabel are consistent', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue(mockRuntimeStateResponse);
      await store.fetchState();
      vi.mocked(pauseRuntime).mockResolvedValue({ ...mockRuntimeStatePaused, status: 'running', paused: true });
      await store.pause();
      vi.mocked(resumeRuntime).mockResolvedValue(mockRuntimeState);

      await store.resume();

      expect(store.isPaused).toBe(false);
      expect(store.status).toBe('running');
      expect(store.statusLabel).toBe('running');
      expect(store.runtime).toEqual(mockRuntimeState);
    });
  });

  describe('setupWsListener — WebSocket events', () => {
    it('registers status and reconnect handlers when called', () => {
      const store = setupStore();
      store.setupWsListener();
      expect(wsTypeHandlers.has('status')).toBe(true);
      expect(wsTypeHandlers.get('status')?.size).toBe(1);
      expect(reconnectHandlers.size).toBe(1);
    });

    it('is idempotent for status and reconnect registration', () => {
      const store = setupStore();
      store.setupWsListener();
      store.setupWsListener();
      expect(wsTypeHandlers.get('status')?.size).toBe(1);
      expect(reconnectHandlers.size).toBe(1);
    });

    it('refetches runtime state on reconnect', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue(mockRuntimeStateResponse);
      store.setupWsListener();

      fireReconnect();

      await vi.waitFor(() => {
        expect(getRuntimeState).toHaveBeenCalledOnce();
      });
    });

    it('handles runtime-state event and updates runtime + cardIndex', () => {
      const store = setupStore();
      store.setupWsListener();

      fireWsEvent('status', {
        event: 'runtime-state',
        runtime: mockRuntimeState,
        cardIndex: mockCardIndex,
      });

      expect(store.runtime).toEqual(mockRuntimeState);
      expect(store.cardIndex).toEqual(mockCardIndex);
    });



    it('updates CardStore health from runtime-state only when the optional field is present', () => {
      const store = setupStore();
      store.setupWsListener();
      fireWsEvent('status', { event: 'runtime-state', cardStoreHealth: mockCardStoreHealth });
      expect(store.cardStoreHealth).toEqual(mockCardStoreHealth);
      fireWsEvent('status', { event: 'runtime-state', runtime: mockRuntimeState, cardIndex: mockCardIndex });
      expect(store.cardStoreHealth).toEqual(mockCardStoreHealth);
    });

    it('handles runtime-paused and runtime-resumed events', () => {
      const store = setupStore();
      store.setupWsListener();

      fireWsEvent('status', {
        event: 'runtime-state',
        runtime: mockRuntimeState,
      });
      fireWsEvent('status', { event: 'runtime-paused' });
      expect(store.isPaused).toBe(true);
      fireWsEvent('status', { event: 'runtime-resumed' });
      expect(store.isPaused).toBe(false);
      expect(store.status).toBe('running');
    });



    it('rejects malformed covered runtime-state WebSocket payloads before mutation', () => {
      const store = setupStore();
      store.setupWsListener();

      expect(() => fireWsEvent('status', {
        event: 'runtime-state',
        runtime: { status: 'paused' },
      })).toThrow();
      expect(store.runtime).toBeNull();
    });

    it('card-status-changed event triggers a fetchState call', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue(mockRuntimeStateResponse);
      store.setupWsListener();

      fireWsEvent('status', {
        event: 'card-status-changed',
        card: { id: 'card-001', status: 'done' },
      });

      await vi.waitFor(() => {
        expect(getRuntimeState).toHaveBeenCalledOnce();
      });
    });
  });
});
