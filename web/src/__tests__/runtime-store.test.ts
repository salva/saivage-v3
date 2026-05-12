/**
 * Bounded client-layer regression tests for the runtime Pinia store.
 *
 * Tests cover:
 *  1. fetchState() populates runtime + cardIndex on success, loading/error behavior
 *  2. Computed getters: status, isRunning, isPaused, isFrozen, currentCardId,
 *     currentAgentSessionId, queueLength, runningProcessCount, statusLabel,
 *     doneGoals, failedBlocked
 *  3. Optimistic pause/resume actions and error handling
 *  4. WebSocket-driven runtime-state/status updates via setupWsListener +
 *     ws store onType('status') path
 *
 * These tests mock the API client layer (../api/client) and the ws store
 * (../stores/ws) so we verify store-side logic without a running server.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useRuntimeStore } from '../stores/runtime';

// ── Mock the API client ───────────────────────────────────────
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

import { getRuntimeState, pauseRuntime, resumeRuntime } from '../api/client';

// ── Mock the ws store ─────────────────────────────────────────
const wsTypeHandlers = new Map<string, Set<(envelope: any) => void>>();

function fireWsEvent(type: string, content: Record<string, unknown>) {
  const handlers = wsTypeHandlers.get(type);
  if (handlers) {
    for (const h of handlers) {
      h({ type, content });
    }
  }
}

vi.mock('../stores/ws', () => ({
  useWsStore: vi.fn(() => ({
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
  })),
}));

// ── Helpers ───────────────────────────────────────────────────

function setupStore() {
  setActivePinia(createPinia());
  wsTypeHandlers.clear();
  return useRuntimeStore();
}

// ── Fixtures ──────────────────────────────────────────────────

const mockRuntimeState = {
  status: 'running' as const,
  project_id: 'saivage-v3',
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
  project_id: 'saivage-v3',
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
  project_id: 'saivage-v3',
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
  project_id: 'saivage-v3',
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

const mockRuntimeStateResponse = {
  runtime: mockRuntimeState,
  cardIndex: mockCardIndex,
};

const mockNullRuntimeResponse = {
  runtime: null,
  cardIndex: { total: 0, byStatus: {}, byType: {} },
};

// ── Tests ─────────────────────────────────────────────────────

describe('useRuntimeStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsTypeHandlers.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Initial State ───────────────────────────────────────────

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

  // ── fetchState() — success path ─────────────────────────────

  describe('fetchState() success', () => {
    it('populates runtime and cardIndex on success', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue(mockRuntimeStateResponse);

      await store.fetchState();

      expect(store.runtime).toEqual(mockRuntimeState);
      expect(store.cardIndex).toEqual(mockCardIndex);
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
      expect(store.doneGoals).toBe(30);
      expect(store.failedBlocked).toBe(5); // 3 failed + 2 blocked
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

    it('doneGoals returns 0 when "done" key is absent', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue({
        runtime: mockRuntimeState,
        cardIndex: { total: 10, byStatus: { active: 10 }, byType: {} },
      });

      await store.fetchState();

      expect(store.doneGoals).toBe(0);
    });

    it('failedBlocked sums failed and blocked, handling missing keys', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue({
        runtime: mockRuntimeState,
        cardIndex: {
          total: 10,
          byStatus: { failed: 1 },
          byType: {},
        },
      });

      await store.fetchState();

      expect(store.failedBlocked).toBe(1);
    });
  });

  // ── fetchState() — loading/error behavior ───────────────────

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

    it('clears previous error on subsequent fetch', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockRejectedValueOnce(new Error('First failure'));
      await expect(store.fetchState()).rejects.toThrow('First failure');
      expect(store.error).toBe('Failed to fetch runtime state');

      vi.mocked(getRuntimeState).mockResolvedValue(mockRuntimeStateResponse);
      await store.fetchState();
      expect(store.error).toBeNull();
      expect(store.runtime).toEqual(mockRuntimeState);
    });

    it('sets error on generic Error failure', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockRejectedValue(new Error('Network failure'));

      await expect(store.fetchState()).rejects.toThrow('Network failure');

      expect(store.error).toBe('Failed to fetch runtime state');
      expect(store.loading).toBe(false);
      expect(store.runtime).toBeNull();
    });

    it('sets error on ApiError failure (uses err.message)', async () => {
      const store = setupStore();
      const { ApiError } = await import('../api/client');
      vi.mocked(getRuntimeState).mockRejectedValue(
        new ApiError(503, 'Service unavailable', {})
      );

      await expect(store.fetchState()).rejects.toThrow('Service unavailable');

      expect(store.error).toBe('Service unavailable');
      expect(store.loading).toBe(false);
    });

    it('re-throws the error after setting state', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockRejectedValue(new Error('Network failure'));

      await expect(store.fetchState()).rejects.toThrow('Network failure');
      expect(store.error).toBe('Failed to fetch runtime state');
    });
  });

  // ── pause() — optimistic update ─────────────────────────────

  describe('pause()', () => {
    it('calls pauseRuntime API and optimistically updates runtime', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue(mockRuntimeStateResponse);
      await store.fetchState();

      vi.mocked(pauseRuntime).mockResolvedValue({ status: 'paused' });

      await store.pause();

      expect(pauseRuntime).toHaveBeenCalledOnce();
      expect(store.isPaused).toBe(true);
      expect(store.status).toBe('paused');
      expect(store.statusLabel).toBe('paused');
    });

    it('does not crash when runtime is null (no-op optimistic update)', async () => {
      const store = setupStore();
      vi.mocked(pauseRuntime).mockResolvedValue({ status: 'paused' });

      await store.pause();

      expect(pauseRuntime).toHaveBeenCalledOnce();
      expect(store.runtime).toBeNull();
      expect(store.error).toBeNull();
    });

    it('clears previous error on success', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockRejectedValue(new Error('fail'));
      await expect(store.fetchState()).rejects.toThrow('fail');
      expect(store.error).toBe('Failed to fetch runtime state');

      vi.mocked(pauseRuntime).mockResolvedValue({ status: 'paused' });
      await store.pause();
      expect(store.error).toBeNull();
    });

    it('handles generic Error failure', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue(mockRuntimeStateResponse);
      await store.fetchState();

      vi.mocked(pauseRuntime).mockRejectedValue(new Error('Server error'));

      await expect(store.pause()).rejects.toThrow('Server error');
      expect(store.error).toBe('Failed to pause runtime');
    });

    it('handles ApiError failure', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue(mockRuntimeStateResponse);
      await store.fetchState();

      const { ApiError } = await import('../api/client');
      vi.mocked(pauseRuntime).mockRejectedValue(
        new ApiError(409, 'Runtime is already paused', {})
      );

      await expect(store.pause()).rejects.toThrow('Runtime is already paused');
      expect(store.error).toBe('Runtime is already paused');
    });
  });

  // ── resume() — optimistic update ────────────────────────────

  describe('resume()', () => {
    it('calls resumeRuntime API and optimistically updates runtime', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue({
        runtime: mockRuntimeStatePaused,
        cardIndex: mockCardIndex,
      });
      await store.fetchState();

      expect(store.isPaused).toBe(true);

      vi.mocked(resumeRuntime).mockResolvedValue({ status: 'resumed' });

      await store.resume();

      expect(resumeRuntime).toHaveBeenCalledOnce();
      expect(store.isPaused).toBe(false);
    });

    it('after pause-then-resume, status and statusLabel are consistent', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockResolvedValue(mockRuntimeStateResponse);
      await store.fetchState();
      expect(store.status).toBe('running');

      // Pause
      vi.mocked(pauseRuntime).mockResolvedValue({ status: 'paused' });
      await store.pause();
      expect(store.status).toBe('paused');
      expect(store.isPaused).toBe(true);

      // Resume — should restore status to 'running'
      vi.mocked(resumeRuntime).mockResolvedValue({ status: 'resumed' });
      await store.resume();
      expect(store.isPaused).toBe(false);
      expect(store.status).toBe('running');
      expect(store.statusLabel).toBe('running');
    });

    it('does not crash when runtime is null', async () => {
      const store = setupStore();
      vi.mocked(resumeRuntime).mockResolvedValue({ status: 'resumed' });

      await store.resume();

      expect(resumeRuntime).toHaveBeenCalledOnce();
      expect(store.runtime).toBeNull();
    });

    it('clears previous error on success', async () => {
      const store = setupStore();
      vi.mocked(getRuntimeState).mockRejectedValue(new Error('fail'));
      await expect(store.fetchState()).rejects.toThrow('fail');
      expect(store.error).toBe('Failed to fetch runtime state');

      vi.mocked(resumeRuntime).mockResolvedValue({ status: 'resumed' });
      await store.resume();
      expect(store.error).toBeNull();
    });

    it('handles generic Error failure', async () => {
      const store = setupStore();
      vi.mocked(resumeRuntime).mockRejectedValue(new Error('Server error'));

      await expect(store.resume()).rejects.toThrow('Server error');
      expect(store.error).toBe('Failed to resume runtime');
    });

    it('handles ApiError failure', async () => {
      const store = setupStore();
      const { ApiError } = await import('../api/client');
      vi.mocked(resumeRuntime).mockRejectedValue(
        new ApiError(409, 'Runtime is not paused', {})
      );

      await expect(store.resume()).rejects.toThrow('Runtime is not paused');
      expect(store.error).toBe('Runtime is not paused');
    });
  });

  // ── WebSocket-driven updates ────────────────────────────────

  describe('setupWsListener — WebSocket events', () => {
    it('registers a status type handler when called', () => {
      const store = setupStore();
      store.setupWsListener();
      expect(wsTypeHandlers.has('status')).toBe(true);
      expect(wsTypeHandlers.get('status')?.size).toBe(1);
    });

    it('is idempotent — calling setupWsListener twice registers only one handler', () => {
      const store = setupStore();
      store.setupWsListener();
      store.setupWsListener();
      expect(wsTypeHandlers.get('status')?.size).toBe(1);
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
      expect(store.status).toBe('running');
      expect(store.queueLength).toBe(2);
    });

    it('handles runtime-state with only runtime (no cardIndex)', () => {
      const store = setupStore();
      store.setupWsListener();

      fireWsEvent('status', {
        event: 'runtime-state',
        runtime: mockRuntimeState,
      });

      expect(store.runtime).toEqual(mockRuntimeState);
      expect(store.cardIndex.total).toBe(0);
    });

    it('handles runtime-paused event and updates runtime optimistically', () => {
      const store = setupStore();
      store.setupWsListener();

      fireWsEvent('status', {
        event: 'runtime-state',
        runtime: mockRuntimeState,
      });

      fireWsEvent('status', {
        event: 'runtime-paused',
      });

      expect(store.isPaused).toBe(true);
      expect(store.status).toBe('paused');
      expect(store.runtime?.paused_at).toBeTruthy();
    });

    it('handles runtime-resumed event and updates runtime optimistically', () => {
      const store = setupStore();
      store.setupWsListener();

      fireWsEvent('status', {
        event: 'runtime-state',
        runtime: mockRuntimeStatePaused,
      });

      expect(store.isPaused).toBe(true);

      fireWsEvent('status', {
        event: 'runtime-resumed',
      });

      expect(store.isPaused).toBe(false);
      expect(store.runtime?.paused_at).toBeNull();
    });

    it('runtime-resumed event restores status correctly after runtime-paused', () => {
      const store = setupStore();
      store.setupWsListener();

      // Start with a running state
      fireWsEvent('status', {
        event: 'runtime-state',
        runtime: mockRuntimeState,
      });
      expect(store.status).toBe('running');

      // Pause via WS event — status becomes 'paused', pre-pause status saved
      fireWsEvent('status', { event: 'runtime-paused' });
      expect(store.isPaused).toBe(true);
      expect(store.status).toBe('paused');

      // Resume via WS event — status should be restored to 'running'
      fireWsEvent('status', { event: 'runtime-resumed' });
      expect(store.isPaused).toBe(false);
      expect(store.status).toBe('running');
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
        expect(getRuntimeState).toHaveBeenCalled();
      }, { timeout: 100 });

      expect(getRuntimeState).toHaveBeenCalledOnce();
    });

    it('handles unknown status event gracefully', () => {
      const store = setupStore();
      store.setupWsListener();

      fireWsEvent('status', {
        event: 'runtime-state',
        runtime: mockRuntimeState,
      });

      expect(() => {
        fireWsEvent('status', { event: 'unknown-event', data: {} });
      }).not.toThrow();

      expect(store.runtime).toEqual(mockRuntimeState);
    });

    it('handles empty content object', () => {
      const store = setupStore();
      store.setupWsListener();

      expect(() => {
        fireWsEvent('status', {});
      }).not.toThrow();
    });

    it('handles null/undefined content gracefully', () => {
      const store = setupStore();
      store.setupWsListener();

      expect(() => {
        fireWsEvent('status', null as any);
      }).not.toThrow();
    });

    it('runtime-paused event is a no-op when runtime is null', () => {
      const store = setupStore();
      store.setupWsListener();

      expect(() => {
        fireWsEvent('status', { event: 'runtime-paused' });
      }).not.toThrow();

      expect(store.runtime).toBeNull();
    });

    it('runtime-resumed event is a no-op when runtime is null', () => {
      const store = setupStore();
      store.setupWsListener();

      expect(() => {
        fireWsEvent('status', { event: 'runtime-resumed' });
      }).not.toThrow();

      expect(store.runtime).toBeNull();
    });
  });
});
