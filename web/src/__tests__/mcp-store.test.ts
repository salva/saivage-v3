/**
 * Bounded client-layer regression tests for the MCP Pinia store.
 *
 * Tests cover:
 *  1. fetchMcpData() populates state on success
 *  2. loading/error state transitions
 *  3. Computed getters: toolCount, serverCount, totalInvocations, totalErrors
 *  4. startPolling / stopPolling lifecycle
 *  5. ApiError handling
 *
 * These tests mock the API client layer (../api/client) so we verify
 * store-side logic without requiring a running Saivage server.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useMcpStore } from '../stores/mcp';

// ── Mock the API client ───────────────────────────────────────
vi.mock('../api/client', () => ({
  getMcpTools: vi.fn(),
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

import { getMcpTools } from '../api/client';
import type { McpToolsResponse } from '../api/types';

// ── Helpers ───────────────────────────────────────────────────

function setupStore() {
  setActivePinia(createPinia());
  return useMcpStore();
}

// ── MCP fixtures ──────────────────────────────────────────────

const mockMcpToolsResponse = {
  tools: [
    { name: 'read', description: 'Read a file', inputSchema: { type: 'object' as const } },
    { name: 'write_file', description: 'Write a file', inputSchema: { type: 'object' as const } },
  ],
  servers: ['filesystem', 'web'],
  invocationStats: {
    'filesystem:read': { total: 10, success: 9, error: 1, lastInvokedAt: '2025-06-01T10:00:00Z' },
    'filesystem:write_file': { total: 3, success: 3, error: 0, lastInvokedAt: '2025-06-01T09:30:00Z' },
  },
  serverDetails: [
    {
      name: 'filesystem',
      transport: 'stdio',
      status: 'running',
      toolCount: 2,
      tools: [
        {
          name: 'read',
          description: 'Read a file',
          inputSchema: { type: 'object' as const },
          stats: { total: 10, success: 9, error: 1, lastInvokedAt: '2025-06-01T10:00:00Z' },
        },
        {
          name: 'write_file',
          description: 'Write a file',
          inputSchema: { type: 'object' as const },
          stats: { total: 3, success: 3, error: 0, lastInvokedAt: '2025-06-01T09:30:00Z' },
        },
      ],
    },
    {
      name: 'web',
      transport: 'sse',
      status: 'running',
      toolCount: 0,
      tools: [],
    },
  ],
} satisfies McpToolsResponse;

const mockEmptyResponse = {
  tools: [],
  servers: [],
  invocationStats: {},
  serverDetails: [],
} satisfies McpToolsResponse;

// ── Tests ─────────────────────────────────────────────────────

describe('useMcpStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear any pending intervals from previous tests
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ── Initial State ───────────────────────────────────────────

  describe('initial state', () => {
    it('has empty defaults', () => {
      const store = setupStore();
      expect(store.servers).toEqual([]);
      expect(store.allTools).toEqual([]);
      expect(store.serverNames).toEqual([]);
      expect(store.invocationStats).toEqual({});
      expect(store.loading).toBe(false);
      expect(store.error).toBeNull();
      expect(store.lastRefreshed).toBeNull();
    });

    it('computed getters return zero', () => {
      const store = setupStore();
      expect(store.toolCount).toBe(0);
      expect(store.serverCount).toBe(0);
      expect(store.totalInvocations).toBe(0);
      expect(store.totalErrors).toBe(0);
    });
  });

  // ── fetchMcpData() ──────────────────────────────────────────

  describe('fetchMcpData()', () => {
    it('populates all state fields on success', async () => {
      const store = setupStore();
      vi.mocked(getMcpTools).mockResolvedValue(mockMcpToolsResponse);

      await store.fetchMcpData();

      expect(store.servers).toHaveLength(2);
      expect(store.servers[0].name).toBe('filesystem');
      expect(store.servers[1].name).toBe('web');
      expect(store.allTools).toHaveLength(2);
      expect(store.serverNames).toEqual(['filesystem', 'web']);
      expect(Object.keys(store.invocationStats)).toHaveLength(2);
      expect(store.loading).toBe(false);
      expect(store.error).toBeNull();
      expect(store.lastRefreshed).toBeTruthy();
    });

    it('computed getters reflect populated data', async () => {
      const store = setupStore();
      vi.mocked(getMcpTools).mockResolvedValue(mockMcpToolsResponse);

      await store.fetchMcpData();

      expect(store.toolCount).toBe(2);
      expect(store.serverCount).toBe(2);
      expect(store.totalInvocations).toBe(13); // 10 + 3
      expect(store.totalErrors).toBe(1);       // 1 error on read
    });

    it('sets loading=true while fetching', async () => {
      const store = setupStore();
      let resolve: (v: typeof mockMcpToolsResponse) => void;
      const promise = new Promise<typeof mockMcpToolsResponse>((r) => { resolve = r; });
      vi.mocked(getMcpTools).mockReturnValue(promise);

      const fetchPromise = store.fetchMcpData();
      expect(store.loading).toBe(true);

      resolve!(mockMcpToolsResponse);
      await fetchPromise;
      expect(store.loading).toBe(false);
    });

    it('sets error on fetch failure (generic Error)', async () => {
      const store = setupStore();
      vi.mocked(getMcpTools).mockRejectedValue(new Error('Network failure'));

      await store.fetchMcpData();

      expect(store.error).toBe('Failed to fetch MCP tools');
      expect(store.loading).toBe(false);
      expect(store.servers).toEqual([]);
    });

    it('sets error on fetch failure (ApiError)', async () => {
      const store = setupStore();
      // We need to import ApiError from the mock, but since it's mocked we
      // use the class from the mock module. The store catches `err instanceof ApiError`
      // and uses err.message. We'll use a generic Error with the right shape.
      // Actually, the mock above exports ApiError, so we can use it.
      const { ApiError } = await import('../api/client');
      vi.mocked(getMcpTools).mockRejectedValue(new ApiError(500, 'Server error', {}));

      await store.fetchMcpData();

      // Store uses err.message when err instanceof ApiError
      expect(store.error).toBe('Server error');
      expect(store.loading).toBe(false);
    });

    it('handles missing optional fields gracefully', async () => {
      const store = setupStore();
      vi.mocked(getMcpTools).mockResolvedValue(mockEmptyResponse);

      await store.fetchMcpData();

      expect(store.servers).toEqual([]);
      expect(store.allTools).toEqual([]);
      expect(store.serverNames).toEqual([]);
      expect(store.invocationStats).toEqual({});
      expect(store.loading).toBe(false);
      expect(store.error).toBeNull();
    });

    it('handles a contract-valid response with no server details', async () => {
      const store = setupStore();
      vi.mocked(getMcpTools).mockResolvedValue({
        tools: [{ name: 't', inputSchema: { type: 'object' } }],
        servers: ['s'],
        invocationStats: {},
        serverDetails: [],
      });

      await store.fetchMcpData();

      expect(store.servers).toEqual([]);
      expect(store.toolCount).toBe(1);
      expect(store.serverCount).toBe(0);
    });

    it('handles a contract-valid response with empty invocation stats', async () => {
      const store = setupStore();
      vi.mocked(getMcpTools).mockResolvedValue({
        tools: [],
        servers: [],
        invocationStats: {},
        serverDetails: [],
      });

      await store.fetchMcpData();

      expect(store.invocationStats).toEqual({});
      expect(store.totalInvocations).toBe(0);
      expect(store.totalErrors).toBe(0);
    });
  });

  // ── Polling ─────────────────────────────────────────────────

  describe('startPolling / stopPolling', () => {
    it('startPolling calls fetchMcpData periodically', async () => {
      const store = setupStore();
      vi.mocked(getMcpTools).mockResolvedValue(mockMcpToolsResponse);

      // Start polling at 10s interval
      store.startPolling(10000);

      // Fast-forward time by 10s
      await vi.advanceTimersByTimeAsync(10000);

      // fetchMcpData should have been called by the interval
      expect(getMcpTools).toHaveBeenCalledTimes(1);

      // Fast-forward another 10s
      await vi.advanceTimersByTimeAsync(10000);

      expect(getMcpTools).toHaveBeenCalledTimes(2);

      store.stopPolling();
    });

    it('stopPolling clears the interval', async () => {
      const store = setupStore();
      vi.mocked(getMcpTools).mockResolvedValue(mockMcpToolsResponse);

      store.startPolling(10000);
      store.stopPolling();

      // Fast-forward — no more calls should happen
      await vi.advanceTimersByTimeAsync(30000);

      // Only the manual fetch if any — none from interval
      expect(getMcpTools).not.toHaveBeenCalled();
    });

    it('startPolling replaces existing interval', async () => {
      const store = setupStore();
      vi.mocked(getMcpTools).mockResolvedValue(mockMcpToolsResponse);

      store.startPolling(10000);
      store.startPolling(5000); // replace

      await vi.advanceTimersByTimeAsync(5000);
      expect(getMcpTools).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5000);
      expect(getMcpTools).toHaveBeenCalledTimes(2);

      store.stopPolling();
    });

    it('polling does not throw on fetch errors', async () => {
      const store = setupStore();
      vi.mocked(getMcpTools).mockRejectedValue(new Error('fail'));

      store.startPolling(5000);

      // Should not throw
      await vi.advanceTimersByTimeAsync(5000);

      expect(getMcpTools).toHaveBeenCalledTimes(1);
      // Error is swallowed by .catch(() => {}) in startPolling
      expect(store.error).toBe('Failed to fetch MCP tools');

      store.stopPolling();
    });
  });

  // ── Computed: totalInvocations / totalErrors ────────────────

  describe('totalInvocations', () => {
    it('sums totals across all invocation stats', async () => {
      const store = setupStore();
      vi.mocked(getMcpTools).mockResolvedValue({
        ...mockEmptyResponse,
        invocationStats: {
          'a:x': { total: 5, success: 3, error: 2 },
          'b:y': { total: 7, success: 7, error: 0 },
        },
      });

      await store.fetchMcpData();

      expect(store.totalInvocations).toBe(12);
      expect(store.totalErrors).toBe(2);
    });

    it('returns 0 when invocationStats is empty', async () => {
      const store = setupStore();
      vi.mocked(getMcpTools).mockResolvedValue(mockEmptyResponse);

      await store.fetchMcpData();

      expect(store.totalInvocations).toBe(0);
      expect(store.totalErrors).toBe(0);
    });
  });

  // ── Readonly state ──────────────────────────────────────────

  describe('readonly state', () => {
    it('servers, allTools, serverNames are readonly refs', async () => {
      // This is a type-level contract. At runtime, readonly refs
      // still allow .value mutation in tests (it's a TS guard).
      // We verify the state is populated correctly after fetch.
      const store = setupStore();
      vi.mocked(getMcpTools).mockResolvedValue(mockMcpToolsResponse);

      await store.fetchMcpData();

      // State was set internally by the store action — this is expected
      expect(store.servers).toHaveLength(2);
      expect(store.allTools).toHaveLength(2);
      expect(store.serverNames).toEqual(['filesystem', 'web']);
    });
  });

  // ── lastRefreshed ───────────────────────────────────────────

  describe('lastRefreshed', () => {
    it('is set to an ISO timestamp after successful fetch', async () => {
      const store = setupStore();
      vi.mocked(getMcpTools).mockResolvedValue(mockMcpToolsResponse);

      const before = new Date().toISOString();
      await store.fetchMcpData();

      expect(store.lastRefreshed).toBeTruthy();
      expect(store.lastRefreshed! >= before).toBe(true);
    });

    it('remains null after failed fetch', async () => {
      const store = setupStore();
      vi.mocked(getMcpTools).mockRejectedValue(new Error('fail'));

      await store.fetchMcpData();

      expect(store.lastRefreshed).toBeNull();
    });
  });
});
