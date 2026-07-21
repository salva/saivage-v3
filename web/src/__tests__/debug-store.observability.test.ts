import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getDebugErrors: vi.fn(),
  getNewestEvents: vi.fn(),
}));

vi.mock('../api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api/client')>()), ...api }));

import { useDebugStore } from '../stores/debug';

const timestamp = '2026-07-21T00:00:00.000Z';

describe('Debug combined observability refresh', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks(); });

  it('refreshes newest timeline and derived errors together', async () => {
    api.getNewestEvents.mockResolvedValue({ events: [{ id: 'event', kind: 'runtime_diagnostic', timestamp, error_message: 'timeline' }], total: 1001 });
    api.getDebugErrors.mockResolvedValue({ errors: [{ id: 'error', kind: 'runtime_diagnostic', timestamp, error_message: 'durable error' }], total: 1 });
    const store = useDebugStore();
    await store.refreshObservability();
    expect(store.timelineTotal).toBe(1001);
    expect(store.timelineEvents).toHaveLength(1);
    expect(store.errors).toHaveLength(1);
  });

  it('preserves the successful projection, shows partial failure, and rejects', async () => {
    api.getNewestEvents.mockResolvedValue({ events: [{ id: 'event', kind: 'mcp_tool_invocation', timestamp, server: 'mcp', tool: 'read', success: true, duration_ms: 1 }], total: 1 });
    api.getDebugErrors.mockRejectedValue(new Error('errors unavailable'));
    const store = useDebugStore();
    await expect(store.refreshObservability()).rejects.toThrow('errors unavailable');
    expect(store.timelineEvents).toHaveLength(1);
    expect(store.error).toBe('Failed to fetch debug data');
  });
});
