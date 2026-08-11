import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DebugErrorsResponse, EventsResponse } from '../api/types';

const api = vi.hoisted(() => ({
  getDebugErrors: vi.fn(),
  getNewestEvents: vi.fn(),
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

describe('Debug Errors and Timeline resource state', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('tracks simultaneous loading and settlement independently', async () => {
    const errorsRequest = deferred<DebugErrorsResponse>();
    const timelineRequest = deferred<EventsResponse>();
    api.getDebugErrors.mockReturnValueOnce(errorsRequest.promise);
    api.getNewestEvents.mockReturnValueOnce(timelineRequest.promise);
    const store = useDebugStore();

    const errorsAction = store.fetchErrors();
    const timelineAction = store.fetchTimeline();

    expect(store.errorsLoading).toBe(true);
    expect(store.timelineLoading).toBe(true);

    errorsRequest.resolve({ errors: [], total: 0 });
    await errorsAction;

    expect(store.errorsLoading).toBe(false);
    expect(store.timelineLoading).toBe(true);
    expect(store.errorsError).toBeNull();
    expect(store.timelineError).toBeNull();

    timelineRequest.resolve({ events: [], total: 0 });
    await timelineAction;

    expect(store.errorsLoading).toBe(false);
    expect(store.timelineLoading).toBe(false);
  });

  it('isolates a rejected Errors request from a pending Timeline request', async () => {
    const errorsRequest = deferred<DebugErrorsResponse>();
    const timelineRequest = deferred<EventsResponse>();
    api.getDebugErrors.mockReturnValueOnce(errorsRequest.promise);
    api.getNewestEvents.mockReturnValueOnce(timelineRequest.promise);
    const store = useDebugStore();
    const expectedFailure = new Error('errors unavailable');

    const errorsAction = store.fetchErrors().catch((error: unknown) => error);
    const timelineAction = store.fetchTimeline();
    errorsRequest.reject(expectedFailure);

    expect(await errorsAction).toBe(expectedFailure);
    expect(store.errorsLoading).toBe(false);
    expect(store.errorsError).toBe('Failed to fetch debug errors');
    expect(store.timelineLoading).toBe(true);
    expect(store.timelineError).toBeNull();

    timelineRequest.resolve({ events: [], total: 0 });
    await timelineAction;

    expect(store.errorsError).toBe('Failed to fetch debug errors');
    expect(store.timelineLoading).toBe(false);
    expect(store.timelineError).toBeNull();
  });
});
