import { describe, expect, it } from '@jest/globals';
import { SimpleSlaveActor, SlaveJobCancelledError } from '../../../src/runtime/micro-actor/index.js';

class TestSimpleSlaveActor extends SimpleSlaveActor<string> {
  started: string[] = [];
  completions: Array<Deferred<unknown>> = [];
  signals: AbortSignal[] = [];

  protected runJob(job: { id: string; load: string }, context: { signal: AbortSignal }): Promise<unknown> {
    this.started.push(job.load);
    this.signals.push(context.signal);
    const deferred = createDeferred<unknown>();
    this.completions.push(deferred);
    return deferred.promise;
  }
}

describe('SimpleSlaveActor', () => {
  it('runs submitted jobs serially and calls on_done callbacks', async () => {
    const actor = new TestSimpleSlaveActor();
    actor.start();
    const done: unknown[] = [];

    const first = actor.submitJob('first', { on_done: (result) => { done.push(result); } });
    const second = actor.submitJob('second', { on_done: (result) => { done.push(result); } });

    expect(first).toMatch(/^job-/);
    expect(second).toMatch(/^job-/);
    expect(second).not.toBe(first);

    await eventually(() => expect(actor.started).toEqual(['first']));
    actor.completions[0]!.resolve('one');
    await eventually(() => expect(done).toEqual(['one']));
    await eventually(() => expect(actor.started).toEqual(['first', 'second']));

    actor.completions[1]!.resolve('two');
    await eventually(() => expect(done).toEqual(['one', 'two']));
    await eventually(() => expect(actor.state()).toBe('waiting'));
  });

  it('cancels queued jobs before they run', async () => {
    const actor = new TestSimpleSlaveActor();
    actor.start();
    const failed: unknown[] = [];

    actor.submitJob('first');
    const queued = actor.submitJob('second', { on_failed: (error) => { failed.push(error); } });

    await eventually(() => expect(actor.started).toEqual(['first']));
    expect(actor.cancelJob(queued)).toBe(true);

    await eventually(() => expect(failed[0]).toBeInstanceOf(SlaveJobCancelledError));
    actor.completions[0]!.resolve('one');

    await eventually(() => expect(actor.state()).toBe('waiting'));
    expect(actor.started).toEqual(['first']);
  });

  it('does not run a job cancelled after it wakes the waiting actor', async () => {
    const actor = new TestSimpleSlaveActor();
    actor.start();
    const failed: unknown[] = [];

    const jobId = actor.submitJob('first', { on_failed: (error) => { failed.push(error); } });
    expect(actor.cancelJob(jobId)).toBe(true);

    await eventually(() => expect(failed[0]).toBeInstanceOf(SlaveJobCancelledError));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(actor.started).toEqual([]);
    expect(actor.state()).toBe('waiting');
  });

  it('aborts and fails a running job when cancelled', async () => {
    const actor = new TestSimpleSlaveActor();
    actor.start();
    const failed: unknown[] = [];

    const running = actor.submitJob('first', { on_failed: (error) => { failed.push(error); } });

    await eventually(() => expect(actor.started).toEqual(['first']));
    expect(actor.signals[0]!.aborted).toBe(false);
    expect(actor.cancelJob(running)).toBe(true);

    await eventually(() => expect(actor.signals[0]!.aborted).toBe(true));
    await eventually(() => expect(failed[0]).toBeInstanceOf(SlaveJobCancelledError));
    await eventually(() => expect(actor.state()).toBe('waiting'));
  });

  it('fails a running job and returns to waiting through done', async () => {
    const actor = new TestSimpleSlaveActor();
    actor.start();
    const failed: unknown[] = [];

    actor.submitJob('first', { on_failed: (error) => { failed.push(error); } });

    await eventually(() => expect(actor.started).toEqual(['first']));
    actor.completions[0]!.reject(new Error('boom'));

    await eventually(() => expect(failed[0]).toBeInstanceOf(Error));
    await eventually(() => expect(actor.state()).toBe('waiting'));
  });
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 30; i++) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}
