import { describe, expect, it } from '@jest/globals';
import { ActivationOperationTracker, InvocationLifecycle } from '../../../src/runtime/actors/invocation-lifecycle.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('InvocationLifecycle', () => {
  it('closes admission without aborting admitted work and joins its consumer delivery', async () => {
    const lifecycle = new InvocationLifecycle();
    const activation = new AbortController();
    const invocation = lifecycle.begin(activation.signal);
    const raw = deferred<string>();
    const consumer = deferred<void>();
    let admittedSignal!: AbortSignal;
    const wrapper = lifecycle.runExternal(invocation, async (signal) => { admittedSignal = signal; return raw.promise; });
    const delivery = wrapper.then(() => lifecycle.trackConsumer(() => consumer.promise));
    const reason = new Error('result won');
    await Promise.resolve();

    lifecycle.closeAdmission(reason);
    expect(() => lifecycle.begin(activation.signal)).toThrow(reason);
    expect(admittedSignal.aborted).toBe(false);
    let joined = false;
    const joining = lifecycle.join().then((outcome) => { joined = true; return outcome; });
    await Promise.resolve();
    expect(joined).toBe(false);
    raw.resolve('done');
    await wrapper;
    lifecycle.settle(invocation);
    await Promise.resolve();
    expect(joined).toBe(false);
    consumer.resolve();
    await delivery;
    await expect(joining).resolves.toEqual({ status: 'joined' });
  });

  it('uses the first close reason when later revocation aborts admitted work', async () => {
    const lifecycle = new InvocationLifecycle();
    const activation = new AbortController();
    const invocation = lifecycle.begin(activation.signal);
    const raw = deferred<string>();
    const consumer = deferred<void>();
    let admittedSignal!: AbortSignal;
    let abortCount = 0;
    const wrapper = lifecycle.runExternal(invocation, async (signal) => {
      admittedSignal = signal;
      signal.addEventListener('abort', () => { abortCount += 1; });
      return raw.promise;
    });
    const delivery = wrapper.catch(() => lifecycle.trackConsumer(() => consumer.promise));
    const reason = new Error('first reason');
    await Promise.resolve();

    lifecycle.closeAdmission(reason);
    lifecycle.closeAdmission(new Error('ignored close'));
    lifecycle.revoke(new Error('ignored revoke'));
    lifecycle.revoke(new Error('ignored repeated revoke'));
    lifecycle.closeAdmission(new Error('ignored after revoke'));
    expect(admittedSignal.aborted).toBe(true);
    expect(admittedSignal.reason).toBe(reason);
    expect(abortCount).toBe(1);
    expect(() => lifecycle.begin(activation.signal)).toThrow(reason);
    const joining = lifecycle.join();
    await Promise.resolve();
    consumer.resolve();
    await delivery;
    await expect(joining).resolves.toEqual({ status: 'external_dependency_abandoned', abandonedCount: 1 });
    raw.resolve('late');
  });

  it('fences a noncooperative raw dependency while retaining consumer acknowledgement', async () => {
    const lifecycle = new InvocationLifecycle();
    const activation = new AbortController();
    const invocation = lifecycle.begin(activation.signal);
    const admittedSignal = lifecycle.signal(invocation);
    let abortCount = 0;
    admittedSignal.addEventListener('abort', () => { abortCount += 1; });
    const raw = deferred<string>();
    const wrapper = lifecycle.runExternal(invocation, async () => raw.promise);
    const consumed = wrapper.catch(() => lifecycle.trackConsumer(() => undefined));
    const reason = new Error('cancelled');

    lifecycle.revoke(reason);
    lifecycle.closeAdmission(new Error('ignored'));
    lifecycle.revoke(new Error('also ignored'));
    expect(admittedSignal.reason).toBe(reason);
    expect(abortCount).toBe(1);
    expect(() => lifecycle.begin(activation.signal)).toThrow(reason);

    await consumed;
    await expect(lifecycle.join()).resolves.toEqual({ status: 'external_dependency_abandoned', abandonedCount: 1 });
    raw.reject(new Error('late raw rejection'));
    await Promise.resolve();
  });
});

describe('ActivationOperationTracker', () => {
  it('closes admission without aborting admitted work and joins its consumer delivery', async () => {
    const tracker = new ActivationOperationTracker();
    const activation = new AbortController();
    const raw = deferred<string>();
    const consumer = deferred<void>();
    let admittedSignal!: AbortSignal;
    const wrapper = tracker.run(activation.signal, async (signal) => { admittedSignal = signal; return raw.promise; });
    const delivery = wrapper.then(() => tracker.trackConsumer(() => consumer.promise));
    const reason = new Error('result won');
    await Promise.resolve();

    tracker.closeAdmission(reason);
    expect(() => tracker.run(activation.signal, async () => 'new')).toThrow(reason);
    expect(admittedSignal.aborted).toBe(false);
    let joined = false;
    const joining = tracker.join().then((outcome) => { joined = true; return outcome; });
    await Promise.resolve();
    expect(joined).toBe(false);
    raw.resolve('done');
    await wrapper;
    await Promise.resolve();
    expect(joined).toBe(false);
    consumer.resolve();
    await delivery;
    await expect(joining).resolves.toEqual({ status: 'joined' });
  });

  it('uses the first close reason when later revocation aborts admitted work', async () => {
    const tracker = new ActivationOperationTracker();
    const activation = new AbortController();
    const raw = deferred<string>();
    const consumer = deferred<void>();
    let admittedSignal!: AbortSignal;
    let abortCount = 0;
    const wrapper = tracker.run(activation.signal, async (signal) => {
      admittedSignal = signal;
      signal.addEventListener('abort', () => { abortCount += 1; });
      return raw.promise;
    });
    const delivery = wrapper.catch(() => tracker.trackConsumer(() => consumer.promise));
    const reason = new Error('first reason');
    await Promise.resolve();

    tracker.closeAdmission(reason);
    tracker.closeAdmission(new Error('ignored close'));
    tracker.revoke(new Error('ignored revoke'));
    tracker.revoke(new Error('ignored repeated revoke'));
    tracker.closeAdmission(new Error('ignored after revoke'));
    expect(admittedSignal.aborted).toBe(true);
    expect(admittedSignal.reason).toBe(reason);
    expect(abortCount).toBe(1);
    expect(() => tracker.run(activation.signal, async () => 'new')).toThrow(reason);
    const joining = tracker.join();
    await Promise.resolve();
    consumer.resolve();
    await delivery;
    await expect(joining).resolves.toEqual({ status: 'external_dependency_abandoned', abandonedCount: 1 });
    raw.resolve('late');
  });

  it('joins the admitted consumer callback after wrapper completion', async () => {
    const tracker = new ActivationOperationTracker();
    const raw = deferred<string>();
    const consumer = deferred<void>();
    const activation = new AbortController();
    let admittedSignal!: AbortSignal;
    let abortCount = 0;
    const wrapper = tracker.run(activation.signal, async (signal) => {
      admittedSignal = signal;
      signal.addEventListener('abort', () => { abortCount += 1; });
      return raw.promise;
    });
    const delivery = wrapper.then(() => tracker.trackConsumer(() => consumer.promise));
    await Promise.resolve();
    raw.resolve('done');
    await wrapper;
    const reason = new Error('settled');
    tracker.revoke(reason);
    tracker.closeAdmission(new Error('ignored'));
    tracker.revoke(new Error('also ignored'));
    expect(admittedSignal.reason).toBe(reason);
    expect(abortCount).toBe(1);
    expect(() => tracker.run(activation.signal, async () => 'new')).toThrow(reason);
    let joined = false;
    const joining = tracker.join().then((outcome) => { joined = true; return outcome; });
    await Promise.resolve();
    expect(joined).toBe(false);
    consumer.resolve();
    await delivery;
    await expect(joining).resolves.toEqual({ status: 'joined' });
  });
});
