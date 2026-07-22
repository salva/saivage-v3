import { describe, expect, it } from '@jest/globals';
import { ContainedOperations } from '../../../src/runtime/actors/contained-operations.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('ContainedOperations', () => {
  it('closes admission without aborting admitted work and joins raw and consumer settlement', async () => {
    const operations = new ContainedOperations(new Error('default'));
    const controller = new AbortController();
    const raw = deferred<string>();
    const consumer = deferred<void>();
    operations.assertAdmissionOpen();
    const wrapper = operations.run(controller.signal, async () => raw.promise);
    const delivery = wrapper.then(() => operations.consume(() => consumer.promise));
    const reason = new Error('closed');
    operations.closeAdmission(reason);

    expect(() => operations.assertAdmissionOpen()).toThrow(reason);
    expect(controller.signal.aborted).toBe(false);
    let joined = false;
    const joining = operations.join().then((outcome) => { joined = true; return outcome; });
    raw.resolve('done');
    await wrapper;
    await Promise.resolve();
    expect(joined).toBe(false);
    consumer.resolve();
    await delivery;
    await expect(joining).resolves.toEqual({ status: 'joined' });
  });

  it('retains the first close reason when later close and revoke supply other reasons', () => {
    const operations = new ContainedOperations(new Error('default'));
    const controller = new AbortController();
    const first = new Error('first');
    let abortCount = 0;
    controller.signal.addEventListener('abort', () => { abortCount += 1; });

    operations.closeAdmission(first);
    operations.closeAdmission(new Error('later close'));
    operations.revoke(new Error('later revoke'), controller);
    operations.revoke(new Error('repeated revoke'), controller);

    expect(controller.signal.reason).toBe(first);
    expect(abortCount).toBe(1);
    expect(operations.interruptionReason()).toBe(first);
    expect(() => operations.assertAdmissionOpen()).toThrow(first);
  });

  it('reports non-cooperative raw work as abandoned and observes its late rejection', async () => {
    const operations = new ContainedOperations(new Error('default'));
    const controller = new AbortController();
    const raw = deferred<string>();
    operations.assertAdmissionOpen();
    const wrapper = operations.run(controller.signal, async () => raw.promise);
    const consumed = wrapper.catch(() => operations.consume(() => undefined));
    const reason = new Error('revoked');
    await Promise.resolve();

    operations.revoke(reason, controller);
    await consumed;
    await expect(operations.join()).resolves.toEqual({ status: 'external_dependency_abandoned', abandonedCount: 1 });
    raw.reject(new Error('late rejection'));
    await Promise.resolve();
  });

  it.each([
    ['synchronous throw', (failure: Error) => (): void => { throw failure; }],
    ['asynchronous rejection', (failure: Error) => async (): Promise<void> => { throw failure; }],
  ])('reports an exact void consumer failure from %s', async (_name, makeConsumer) => {
    const operations = new ContainedOperations(new Error('default'));
    const wrapper = operations.run(new AbortController().signal, async () => 1);
    await wrapper;
    const failure = new Error('consumer failed');
    const consumer = operations.consume(makeConsumer(failure));
    operations.closeAdmission(new Error('closed'));

    await expect(consumer).rejects.toBe(failure);
    await expect(operations.join()).rejects.toBe(failure);
  });

  it('fails fast on invalid consume and open join while preserving settlement', async () => {
    const operations = new ContainedOperations(new Error('default'));
    expect(() => operations.consume(() => undefined)).toThrow('No contained operation is awaiting consumer delivery.');
    await expect(operations.join()).rejects.toThrow('Contained operation admission must be closed before join.');

    const raw = deferred<number>();
    const wrapper = operations.run(new AbortController().signal, async () => raw.promise);
    const consumer = operations.consume(() => undefined);
    operations.closeAdmission(new Error('closed'));
    raw.resolve(1);
    await Promise.all([wrapper, consumer]);
    await expect(operations.join()).resolves.toEqual({ status: 'joined' });
  });
});
