import { describe, expect, it } from '@jest/globals';
import { AsyncCallbackQueue, runCallbackBatch, type QueuedCallback } from '../../../src/runtime/fsm/index.js';

describe('AsyncCallbackQueue', () => {
  it('invokes queued callbacks in batch order', async () => {
    const queue = new AsyncCallbackQueue();
    const calls: string[] = [];

    queue.push(() => { calls.push('first'); });
    queue.push(() => { calls.push('second'); });

    await expect(runCallbackBatch(queue)).resolves.toBe(2);
    expect(calls).toEqual(['first', 'second']);
  });

  it('awaits promise-returning callbacks before invoking the next callback', async () => {
    const queue = new AsyncCallbackQueue();
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    queue.push(async () => {
      calls.push('async-start');
      await gate;
      calls.push('async-end');
    });
    queue.push(() => { calls.push('sync-after'); });

    const batch = runCallbackBatch(queue);
    await Promise.resolve();
    expect(calls).toEqual(['async-start']);

    release();
    await expect(batch).resolves.toBe(2);
    expect(calls).toEqual(['async-start', 'async-end', 'sync-after']);
  });

  it('waits while empty and wakes when a callback is pushed', async () => {
    const queue = new AsyncCallbackQueue();
    const calls: string[] = [];

    const batch = runCallbackBatch(queue);
    await Promise.resolve();
    expect(calls).toEqual([]);

    queue.push(() => { calls.push('woke'); });

    await expect(batch).resolves.toBe(1);
    expect(calls).toEqual(['woke']);
  });

  it('does not inspect callback contents', async () => {
    const queue = new AsyncCallbackQueue();
    const delivered: unknown[] = [];
    const opaquePayload = {
      target: { machine: 'example', id: '1' },
      name: 'completed',
      args: { value: 42 },
    };

    queue.push(() => {
      delivered.push(opaquePayload);
    });

    await expect(runCallbackBatch(queue)).resolves.toBe(1);
    expect(delivered).toEqual([opaquePayload]);
  });

  it('wakes all pending shift waiters when items arrive', async () => {
    const queue = new AsyncCallbackQueue();

    const first = queue.shift();
    const second = queue.shift();

    queue.push(() => {});
    queue.push(() => {});

    const item1 = await first;
    const item2 = await second;
    expect(typeof item1).toBe('function');
    expect(typeof item2).toBe('function');
  });

  it('close makes pending shift resolve with undefined', async () => {
    const queue = new AsyncCallbackQueue();

    const result = await Promise.race([
      queue.shift(),
      new Promise<QueuedCallback | undefined>((resolve) => {
        setTimeout(() => resolve(undefined), 50);
      }),
    ]);

    expect(result).toBeUndefined();

    queue.close();
    const closed = await queue.shift();
    expect(closed).toBeUndefined();
  });

  it('close wakes a pending shift immediately', async () => {
    const queue = new AsyncCallbackQueue();
    const shiftPromise = queue.shift();

    queue.close();

    const result = await shiftPromise;
    expect(result).toBeUndefined();
  });

  it('runCallbackBatch returns 0 after close', async () => {
    const queue = new AsyncCallbackQueue();
    queue.close();

    const count = await runCallbackBatch(queue);
    expect(count).toBe(0);
  });
});