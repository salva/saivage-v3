import { describe, expect, it, jest } from '@jest/globals';
import { ActivationOperationTracker, InvocationLifecycle, type CompletionPersistenceAdmission } from '../../../src/runtime/actors/invocation-lifecycle.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('InvocationLifecycle', () => {
  it('admits completion persistence exactly once and joins its internal release', async () => {
    const lifecycle = new InvocationLifecycle();
    const invocation = lifecycle.begin(new AbortController().signal);
    const held = deferred<string>();
    const persist = jest.fn(() => held.promise);
    const admission: CompletionPersistenceAdmission = lifecycle;

    const accepted = admission.admit(invocation, persist);
    expect(() => admission.admit(invocation, async () => 'duplicate')).toThrow(/already admitted/);
    lifecycle.revoke(new Error('disposed'));
    let joined = false;
    const joining = lifecycle.join().then((outcome) => { joined = true; return outcome; });
    await Promise.resolve();
    expect(joined).toBe(false);

    held.resolve('persisted');
    await expect(accepted).resolves.toBe('persisted');
    await expect(joining).resolves.toEqual({ status: 'joined' });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('throws synchronously and never invokes persistence when revocation wins', () => {
    const lifecycle = new InvocationLifecycle();
    const invocation = lifecycle.begin(new AbortController().signal);
    const persist = jest.fn(async () => 'forbidden');
    lifecycle.revoke(new Error('cancelled'));

    expect(() => lifecycle.admit(invocation, persist)).toThrow('cancelled');
    expect(persist).not.toHaveBeenCalled();
  });

  it('releases a synchronously throwing persistence callback and reports join failure', async () => {
    const lifecycle = new InvocationLifecycle();
    const invocation = lifecycle.begin(new AbortController().signal);
    const admitted = lifecycle.admit(invocation, () => { throw new Error('persistence failed'); });
    await expect(admitted).rejects.toThrow('persistence failed');
    lifecycle.revoke(new Error('disposed'));
    await expect(lifecycle.join()).rejects.toThrow('persistence failed');
  });

  it('registers persistence before invoking the callback', async () => {
    const lifecycle = new InvocationLifecycle();
    const invocation = lifecycle.begin(new AbortController().signal);
    const held = deferred<string>();
    let joining!: Promise<unknown>;
    const admitted = lifecycle.admit(invocation, () => {
      lifecycle.revoke(new Error('disposed inside callback'));
      joining = lifecycle.join();
      return held.promise;
    });
    let joined = false;
    void joining.then(() => { joined = true; });
    await Promise.resolve();
    expect(joined).toBe(false);
    held.resolve('done');
    await expect(admitted).resolves.toBe('done');
    await expect(joining).resolves.toEqual({ status: 'joined' });
  });

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
