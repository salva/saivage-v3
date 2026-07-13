import { describe, expect, it } from '@jest/globals';
import { ActivationOperationTracker, InvocationLifecycle } from '../../../src/runtime/actors/invocation-lifecycle.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('InvocationLifecycle', () => {
  it('fences a noncooperative raw dependency while retaining consumer acknowledgement', async () => {
    const lifecycle = new InvocationLifecycle();
    const invocation = lifecycle.begin(new AbortController().signal);
    const raw = deferred<string>();
    const wrapper = lifecycle.runExternal(invocation, async () => raw.promise);
    const consumed = wrapper.catch(() => lifecycle.trackConsumer(() => undefined));

    lifecycle.revoke(new Error('cancelled'));

    await consumed;
    await expect(lifecycle.join()).resolves.toEqual({ status: 'external_dependency_abandoned', abandonedCount: 1 });
    raw.reject(new Error('late raw rejection'));
    await Promise.resolve();
  });
});

describe('ActivationOperationTracker', () => {
  it('joins the admitted consumer callback after wrapper completion', async () => {
    const tracker = new ActivationOperationTracker();
    const raw = deferred<string>();
    const consumer = deferred<void>();
    const wrapper = tracker.run(new AbortController().signal, async () => raw.promise);
    const delivery = wrapper.then(() => tracker.trackConsumer(() => consumer.promise));
    raw.resolve('done');
    await wrapper;
    tracker.revoke(new Error('settled'));
    let joined = false;
    const joining = tracker.join().then((outcome) => { joined = true; return outcome; });
    await Promise.resolve();
    expect(joined).toBe(false);
    consumer.resolve();
    await delivery;
    await expect(joining).resolves.toEqual({ status: 'joined' });
  });
});
