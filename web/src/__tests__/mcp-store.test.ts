import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const api = vi.hoisted(() => ({ getMcpTools: vi.fn() }));
vi.mock('../api/client', () => ({
  getMcpTools: api.getMcpTools,
  ApiError: class ApiError extends Error {},
}));

import { useMcpStore } from '../stores/mcp';

describe('MCP displayed hierarchy store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('owns one server/tool hierarchy and derives displayed totals from it', async () => {
    api.getMcpTools.mockResolvedValue({
      servers: [{
        name: 'filesystem', transport: 'stdio', status: 'running', toolCount: 2,
        tools: [
          { name: 'read', stats: { total: 7, success: 6, error: 1 } },
          { name: 'write', stats: { total: 3, success: 3, error: 0 } },
        ],
      }],
    });
    const store = useMcpStore();
    await store.fetchMcpData();

    expect(store.servers).toHaveLength(1);
    expect(store.toolCount).toBe(2);
    expect(store.totalInvocations).toBe(10);
    expect(store.totalErrors).toBe(1);
    expect(store).not.toHaveProperty('invocationStats');
    expect(store).not.toHaveProperty('startPolling');
  });
});
