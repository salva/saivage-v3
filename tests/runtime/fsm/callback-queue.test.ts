import { describe, expect, it } from '@jest/globals';
import { AsyncCallbackQueue, runCallbackBatch } from '../../../src/runtime/fsm/index.js';

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
});
