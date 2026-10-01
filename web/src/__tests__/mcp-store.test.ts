import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const api = vi.hoisted(() => ({ getMcpTools: vi.fn() }));
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  getMcpTools: api.getMcpTools,
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

  it('retains last-good hierarchy on failure and cancels disposed late reads', async () => {
    api.getMcpTools.mockResolvedValueOnce({ servers: [{ name: 'retained', tools: [] }] })
      .mockRejectedValueOnce(new Error('offline'));
    const store = useMcpStore();
    await store.fetchMcpData();
    const timestamp = store.lastRefreshed;
    await store.fetchMcpData();
    expect(store.servers[0]!.name).toBe('retained');
    expect(store.lastRefreshed).toBe(timestamp);
    expect(store.error).toBe('Failed to fetch MCP tools');
    let resolve!: (value: unknown) => void;
    api.getMcpTools.mockImplementationOnce(() => new Promise((yes) => { resolve = yes; }));
    const pending = store.fetchMcpData();
    const signal = api.getMcpTools.mock.calls.at(-1)![0] as AbortSignal;
    store.$dispose();
    expect(signal.aborted).toBe(true);
    resolve({ servers: [] });
    await pending;
    expect(store.servers[0]!.name).toBe('retained');
    expect(store.loading).toBe(false);
  });
});
