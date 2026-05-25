import { setActivePinia, createPinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed } from 'vue';
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
}));
vi.mock('../stores/ws', () => ({
  useWsStore: () => ({
    connectionState: computed(() => 'connected'),
    stale: false,
    onReconnect: vi.fn(() => vi.fn()),
    onType: vi.fn(() => vi.fn()),
  }),
}));

describe('runtime store S06 read-only projection', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('does not expose removed runtime mutation actions', () => {
    const store = useRuntimeStore();

    expect(store).not.toHaveProperty('startProject');
    expect(store).not.toHaveProperty('stopProject');
    expect(store).not.toHaveProperty('pauseRuntime');
    expect(store).not.toHaveProperty('resumeRuntime');
    expect(store).not.toHaveProperty('freezeRuntime');
    expect(store).not.toHaveProperty('resumeRuntimeFromFreeze');
  });

  it('keeps read-only runtime projections and fetch/setup actions', async () => {
    const store = useRuntimeStore();

    expect(store.statusLabel).toBe('unknown');
    expect(store.runningProcessCount).toBe(0);
    expect(store.liveUpdateLabel).toBe('Live updates connected');
    expect(typeof store.fetchState).toBe('function');
    expect(typeof store.setupWsListener).toBe('function');

    await expect(store.fetchState()).resolves.toBeUndefined();
    expect(store.projectRoot).toBe('/fixture');
    expect(store.cardIndex.total).toBe(0);
  });
});
