import { describe, expect, it, vi } from 'vitest';
import { createOwnedFetch } from '../stores/owned-fetch';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('plain request lifetime', () => {
  it.each(['success', 'failure'] as const)('stale %s and finally cannot publish or clear a newer pending request', async (outcome) => {
    const owner = createOwnedFetch();
    const first = deferred<string>();
    const second = deferred<string>();
    const accept = vi.fn();
    const reject = vi.fn();
    let firstSignal!: AbortSignal;
    const a = owner.run((signal) => { firstSignal = signal; return first.promise; }, accept, reject);
    const b = owner.run(() => second.promise, accept, reject);
    expect(firstSignal.aborted).toBe(true);
    if (outcome === 'success') first.resolve('stale');
    else first.reject(new Error('stale'));
    await a;
    expect(accept).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
    expect(owner.pending.value).toBe(true);
    second.resolve('current');
    await b;
    expect(accept).toHaveBeenCalledWith('current');
    expect(owner.pending.value).toBe(false);
  });

  it('cancels late acceptance and keeps separate instances independent', async () => {
    const a = createOwnedFetch();
    const b = createOwnedFetch();
    const response = deferred<string>();
    const accept = vi.fn();
    const pending = a.run(() => response.promise, accept, vi.fn());
    await b.run(async () => 'other', accept, vi.fn());
    expect(a.pending.value).toBe(true);
    a.cancel();
    response.resolve('departed');
    await pending;
    expect(accept.mock.calls).toEqual([['other']]);
    expect(a.pending.value).toBe(false);
  });

  it('propagates acceptance faults rather than disguising them as load failures', async () => {
    const owner = createOwnedFetch();
    const reject = vi.fn();
    await expect(owner.run(async () => 1, () => { throw new Error('accept'); }, reject)).rejects.toThrow('accept');
    expect(reject).not.toHaveBeenCalled();
    expect(owner.pending.value).toBe(false);
  });
});
