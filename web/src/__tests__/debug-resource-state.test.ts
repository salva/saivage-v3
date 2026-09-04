import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DebugErrorsResponse } from '../api/types';

const api = vi.hoisted(() => ({
  getDebugErrors: vi.fn(),
}));

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  ...api,
}));

import { useDebugStore } from '../stores/debug';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('Debug Errors resource state', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('tracks loading through successful settlement', async () => {
    const errorsRequest = deferred<DebugErrorsResponse>();
    api.getDebugErrors.mockReturnValueOnce(errorsRequest.promise);
    const store = useDebugStore();

    const errorsAction = store.fetchErrors();

    expect(store.errorsLoading).toBe(true);

    errorsRequest.resolve({ errors: [], total: 0 });
    await errorsAction;

    expect(store.errorsLoading).toBe(false);
    expect(store.errorsError).toBeNull();
  });

  it('records and rethrows a rejected Errors request', async () => {
    const errorsRequest = deferred<DebugErrorsResponse>();
    api.getDebugErrors.mockReturnValueOnce(errorsRequest.promise);
    const store = useDebugStore();
    const expectedFailure = new Error('errors unavailable');

    const errorsAction = store.fetchErrors().catch((error: unknown) => error);
    errorsRequest.reject(expectedFailure);

    expect(await errorsAction).toBe(expectedFailure);
    expect(store.errorsLoading).toBe(false);
    expect(store.errorsError).toBe('Failed to fetch debug errors');
  });
});
