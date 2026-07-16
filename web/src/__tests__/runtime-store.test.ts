import { setActivePinia, createPinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { useRuntimeStore } from '../stores/runtime';

vi.mock('../api/auth', () => ({ getAuthToken: vi.fn(() => 'token') }));
vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.status = status; }
    get isUnauthorized() { return this.status === 401; }
  },
  getRuntimeState: vi.fn(async () => ({
    projectRoot: '/fixture',
    projectId: 'fixture-project',
    runtime: null,
    cardIndex: { total: 0, byStatus: {}, byType: {} },
  })),
  getRuntimeStatus: vi.fn(async () => ({ restart_server_available: false })),
}));
vi.mock('../stores/sync', () => ({
  useSyncStore: () => ({
    connectionState: ref('connected'),
    lastEventAt: ref(null),
  }),
}));

describe('runtime store S06 read-only projection', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('does not expose removed runtime mutation actions', () => {
    const store = useRuntimeStore();

    expect(store).not.toHaveProperty('startProject');
    expect(store).not.toHaveProperty('pauseRuntime');
    expect(store).not.toHaveProperty('resumeRuntime');
    expect(store).not.toHaveProperty('freezeRuntime');
    expect(store).not.toHaveProperty('resumeRuntimeFromFreeze');
  });

  it('keeps read-only runtime projections and fetch actions', async () => {
    const store = useRuntimeStore();

    expect(store.statusLabel).toBe('unknown');
    expect(store.liveUpdateLabel).toBe('Live updates connected');
    expect(typeof store.fetchState).toBe('function');
    expect(typeof store.refetch).toBe('function');

    await expect(store.fetchState()).resolves.toBeUndefined();
    expect(store.projectRoot).toBe('/fixture');
    expect(store.cardIndex.total).toBe(0);
  });
});
