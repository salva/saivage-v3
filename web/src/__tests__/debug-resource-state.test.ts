import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DebugErrorsResponse } from '../api/types';

const api = vi.hoisted(() => ({
  getDebugErrors: vi.fn(),
  listProcesses: vi.fn(),
  getDoctor: vi.fn(),
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

  it('suppresses stale Errors failure while independent process/Doctor observations retain last-good values', async () => {
    const first = deferred<DebugErrorsResponse>();
    const second = deferred<DebugErrorsResponse>();
    api.getDebugErrors.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    api.listProcesses.mockResolvedValueOnce({ processes: [{ id: 'retained' }] }).mockRejectedValueOnce(new Error('offline'));
    api.getDoctor.mockResolvedValueOnce({ status: 'ok', checks: [{ name: 'retained' }], issues: [] }).mockRejectedValueOnce(new Error('offline'));
    const store = useDebugStore();
    const a = store.fetchErrors();
    const b = store.fetchErrors();
    await Promise.all([store.fetchProcesses(), store.fetchDoctor()]);
    first.reject(new Error('superseded'));
    await a;
    expect(store.errorsError).toBeNull();
    expect(store.errorsLoading).toBe(true);
    await Promise.all([store.fetchProcesses(), store.fetchDoctor()]);
    expect(store.processes).toEqual([{ id: 'retained' }]);
    expect(store.processesError).toBe('Failed to fetch processes');
    expect(store.doctorStatus).toBe('ok');
    expect(store.doctorChecks).toEqual([{ name: 'retained' }]);
    expect(store.doctorError).toBe('Failed to fetch doctor diagnostics');
    store.$dispose();
    expect((api.getDebugErrors.mock.calls[1]![0] as AbortSignal).aborted).toBe(true);
    second.resolve({ errors: [], total: 0 });
    await b;
    expect(store.errorsLoading).toBe(false);
  });
});
