import { describe, expect, it } from '@jest/globals';
import { SimpleSlaveActor, SimpleSlaveCommandCancelledError, startActor } from '../../../src/runtime/micro-actor/index.js';

class TestSimpleSlaveActor extends SimpleSlaveActor {
  started: string[] = [];
  completions: Array<Deferred<unknown>> = [];
  signals: AbortSignal[] = [];

  protected _runCommand(command: { id: string; name: string; args?: unknown }, context: { signal: AbortSignal }): Promise<unknown> {
    this.started.push(command.name);
    this.signals.push(context.signal);
    const deferred = createDeferred<unknown>();
    this.completions.push(deferred);
    return deferred.promise;
  }
}

describe('SimpleSlaveActor', () => {
  it('runs mailbox commands serially and calls on_done callbacks', async () => {
    const actor = startActor(TestSimpleSlaveActor);
    const done: unknown[] = [];

    actor.mailbox.deliver('first', undefined, { on_done: (result) => { done.push(result); } });
    actor.mailbox.deliver('second', undefined, { on_done: (result) => { done.push(result); } });

    await eventually(() => expect(actor.started).toEqual(['first']));
    actor.completions[0]!.resolve('one');
    await eventually(() => expect(done).toEqual(['one']));
    await eventually(() => expect(actor.started).toEqual(['first', 'second']));

    actor.completions[1]!.resolve('two');
    await eventually(() => expect(done).toEqual(['one', 'two']));
    await eventually(() => expect(actor.state()).toBe('idle'));
  });

  it('cancels queued commands before they run', async () => {
    const actor = startActor(TestSimpleSlaveActor);
    const failed: unknown[] = [];

    actor.mailbox.deliver('first');
    const queued = actor.mailbox.deliver('second', undefined, { on_failed: (error) => { failed.push(error); } });

    await eventually(() => expect(actor.started).toEqual(['first']));
    queued.cancel();

    await eventually(() => expect(failed[0]).toBeInstanceOf(SimpleSlaveCommandCancelledError));
    actor.completions[0]!.resolve('one');

    await eventually(() => expect(actor.state()).toBe('idle'));
    expect(actor.started).toEqual(['first']);
  });

  it('aborts and fails a running command when cancelled', async () => {
    const actor = startActor(TestSimpleSlaveActor);
    const failed: unknown[] = [];

    const running = actor.mailbox.deliver('first', undefined, { on_failed: (error) => { failed.push(error); } });

    await eventually(() => expect(actor.started).toEqual(['first']));
    expect(actor.signals[0]!.aborted).toBe(false);
    running.cancel();

    await eventually(() => expect(actor.signals[0]!.aborted).toBe(true));
    await eventually(() => expect(failed[0]).toBeInstanceOf(SimpleSlaveCommandCancelledError));
    await eventually(() => expect(actor.state()).toBe('idle'));
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
