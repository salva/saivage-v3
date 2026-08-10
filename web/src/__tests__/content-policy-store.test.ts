import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requests = vi.hoisted(() => [] as Array<{ signal: AbortSignal; resolve: (value: unknown) => void; reject: (reason: unknown) => void }>);
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  getContentPolicyRuntime: vi.fn((signal: AbortSignal) => new Promise((resolve, reject) => requests.push({ signal, resolve, reject }))),
}));

describe('content-policy store', () => {
  beforeEach(() => { requests.length = 0; setActivePinia(createPinia()); });
  it('owns loading/error/value and discards a superseded response', async () => {
    const { useContentPolicyStore } = await import('../stores/contentPolicy');
    const store = useContentPolicyStore();
    const first = store.refetch();
    const second = store.refetch();
    expect(requests[0]!.signal.aborted).toBe(true);
    requests[0]!.resolve({ refusal_high_water: 9, latest: null });
    requests[1]!.resolve({ refusal_high_water: 1, latest: null });
    await Promise.all([first, second]);
    expect(store.value).toEqual({ refusal_high_water: 1, latest: null });
    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
  });
  it('reports current request failure and clears all state on reset', async () => {
    const { useContentPolicyStore } = await import('../stores/contentPolicy');
    const store = useContentPolicyStore();
    const pending = store.refetch();
    requests[0]!.reject(new Error('unavailable'));
    await expect(pending).rejects.toThrow('unavailable');
    expect(store.error).toBe('unavailable');
    store.reset();
    expect(store.value).toBeNull();
    expect(store.error).toBeNull();
  });
});
