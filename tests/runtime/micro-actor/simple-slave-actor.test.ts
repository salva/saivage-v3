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

    expect(actor.getJobState(first)).toBe('queued');
    expect(actor.getJobState(second)).toBe('queued');

    await eventually(() => expect(actor.started).toEqual(['first']));
    await eventually(() => expect(actor.getJobState(first)).toBe('running'));
    actor.completions[0]!.resolve('one');
    await eventually(() => expect(done).toEqual(['one']));
    await eventually(() => expect(actor.getJobState(first)).toBe('done'));
    await eventually(() => expect(actor.started).toEqual(['first', 'second']));
    await eventually(() => expect(actor.getJobState(second)).toBe('running'));

    actor.completions[1]!.resolve('two');
    await eventually(() => expect(done).toEqual(['one', 'two']));
    await eventually(() => expect(actor.getJobState(second)).toBe('done'));
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
    expect(actor.getJobState(queued)).toBe('cancelled');
    actor.completions[0]!.resolve('one');

    await eventually(() => expect(actor.state()).toBe('waiting'));
    expect(actor.started).toEqual(['first']);
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
    expect(actor.getJobState(running)).toBe('cancelled');
    await eventually(() => expect(actor.state()).toBe('waiting'));
  });

  it('fails a running job and returns to waiting through done', async () => {
    const actor = new TestSimpleSlaveActor();
    actor.start();
    const failed: unknown[] = [];

    const running = actor.submitJob('first', { on_failed: (error) => { failed.push(error); } });

    await eventually(() => expect(actor.started).toEqual(['first']));
    actor.completions[0]!.reject(new Error('boom'));

    await eventually(() => expect(failed[0]).toBeInstanceOf(Error));
    await eventually(() => expect(actor.getJobState(running)).toBe('failed'));
    await eventually(() => expect(actor.state()).toBe('waiting'));
  });

  it('keeps mailbox delivery as an id-returning convenience wrapper', () => {
    const actor = new TestSimpleSlaveActor();

    const jobId = actor.mailbox.deliver('first');

    expect(jobId).toMatch(/^job-/);
    expect(actor.getJobState(jobId)).toBe('queued');
    expect(actor.mailbox.cancel(jobId)).toBe(true);
    expect(actor.getJobState(jobId)).toBe('cancelled');
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
