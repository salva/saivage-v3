import { setActivePinia, createPinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRuntimeStore } from '../stores/runtime';
import { getRuntimeState, getRuntimeStatus, stopProject as stopProjectRequest } from '../api/client';

const serverAvailability = {
  generatedAt: '2026-08-14T00:00:00.000Z',
  components: {
    api: { state: 'available' as const, source: 'health-check' as const, checkedAt: '2026-08-14T00:00:00.000Z' },
    runtime: { state: 'degraded' as const, source: 'runtime-application' as const, checkedAt: '2026-08-14T00:00:00.000Z', diagnostic: { code: 'runtime-status-read-failed', summary: 'Runtime status read failed.' } },
    mcp: { state: 'idle' as const, source: 'mcp-manager' as const, checkedAt: '2026-08-14T00:00:00.000Z' },
  },
};
const stoppedStatus = { runtime: 'stopped' as const, currentCardId: null, started_at: '2026-08-14T00:00:00.000Z', restart_server_available: false, pid: 123, actorRuntime: { pauseMode: 'idle' as const, cards: [] }, serverAvailability };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

vi.mock('../api/auth', () => ({ getAuthToken: vi.fn(() => 'token') }));
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  getRuntimeState: vi.fn(async () => ({
    projectRoot: '/fixture',
    projectId: 'fixture-project',
    runtime: null,
    serverAvailability,
  })),
  getRuntimeStatus: vi.fn(async () => stoppedStatus),
  stopProject: vi.fn(async () => ({ status: 'stopped', contained: false })),
  restartServer: vi.fn(async () => ({ status: 'restart_scheduled' })),
}));
describe('runtime store S06 read-only projection', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(getRuntimeState).mockResolvedValue({ projectRoot: '/fixture', projectId: 'fixture-project', runtime: null, serverAvailability });
    vi.mocked(getRuntimeStatus).mockResolvedValue(stoppedStatus);
    vi.mocked(stopProjectRequest).mockResolvedValue({ status: 'stopped', contained: false });
  });

  it('does not expose removed runtime mutation actions', () => {
    const store = useRuntimeStore();

    expect(store).not.toHaveProperty('startProject');
    expect(store).not.toHaveProperty('pauseRuntime');
    expect(store).not.toHaveProperty('resumeRuntime');
    expect(store).not.toHaveProperty('freezeRuntime');
    expect(store).not.toHaveProperty('resumeRuntimeFromFreeze');
    expect(store).not.toHaveProperty('pause');
    expect(store).not.toHaveProperty('resume');
    expect(store).not.toHaveProperty('pauseActionDisabledReason');
    expect(store).not.toHaveProperty('lastActionableError');
    expect(store).toHaveProperty('stopProject');
    expect(store).toHaveProperty('restartServer');
  });

  it('keeps read-only runtime projections and fetch actions', async () => {
    const store = useRuntimeStore();

    expect(store.statusLabel).toBe('unknown');
    expect(store.loaded).toBe(false);
    expect(typeof store.fetchState).toBe('function');
    expect(typeof store.refetch).toBe('function');

    await expect(store.fetchState()).resolves.toBeUndefined();
    expect(store.loaded).toBe(true);
    expect(store.status).toBe('stopped');
    expect(store.statusLabel).toBe('stopped');
    expect(store.runtimeDetail).toBe('No live runtime.');
    expect(store.lastFetchedAt).not.toBeNull();
    expect(store).not.toHaveProperty('cardIndex');
  });

  it('classifies a request after accepted null as a retained-state refresh', async () => {
    const store = useRuntimeStore();
    await store.fetchState();
    const completedAt = store.lastFetchedAt;
    const refresh = deferred<Awaited<ReturnType<typeof getRuntimeState>>>();
    vi.mocked(getRuntimeState).mockReturnValueOnce(refresh.promise);

    const request = store.fetchState();
    expect(store.loading).toBe(false);
    expect(store.refreshing).toBe(true);
    refresh.reject(new Error('refresh failed'));
    await expect(request).rejects.toThrow('refresh failed');
    expect(store.refreshing).toBe(false);
    expect(store.loaded).toBe(true);
    expect(store.runtime).toBeNull();
    expect(store.error).toBeNull();
    expect(store.refreshError).toBe('Failed to fetch runtime state');
    expect(store.lastFetchedAt).toBe(completedAt);
  });

  it('rejects a Stop command failure without refreshing', async () => {
    const store = useRuntimeStore();
    vi.mocked(stopProjectRequest).mockRejectedValueOnce(new Error('stop failed'));
    vi.mocked(getRuntimeState).mockClear();

    await expect(store.stopProject()).rejects.toThrow('stop failed');
    expect(getRuntimeState).not.toHaveBeenCalled();
  });

  it('resolves successful Stop after classifying a failed follow-up read', async () => {
    const store = useRuntimeStore();
    await store.fetchState();
    vi.mocked(getRuntimeState).mockRejectedValueOnce(new Error('refresh failed'));

    await expect(store.stopProject()).resolves.toBeUndefined();
    expect(store.refreshError).toBe('Failed to fetch runtime state');
  });

  it('does not allow a superseded response to replace the current epoch', async () => {
    const store = useRuntimeStore();
    const obsolete = deferred<Awaited<ReturnType<typeof getRuntimeState>>>();
    vi.mocked(getRuntimeState)
      .mockReturnValueOnce(obsolete.promise)
      .mockResolvedValueOnce({ projectRoot: '/current', projectId: 'current', runtime: null, serverAvailability });

    const first = store.fetchState();
    const second = store.fetchState();
    await second;
    obsolete.resolve({ projectRoot: '/obsolete', projectId: 'obsolete', runtime: null, serverAvailability });
    await first;

    expect(store.projectId).toBe('current');
    expect(store.loaded).toBe(true);
  });
});
