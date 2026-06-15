import { describe, expect, it } from '@jest/globals';
import { AsyncEventQueue, runEventBatch } from '../../../src/runtime/fsm/index.js';
import type { Event } from '../../../src/runtime/fsm/index.js';

describe('AsyncEventQueue', () => {
  it('delivers queued events in batch order', async () => {
    const queue = new AsyncEventQueue();
    const delivered: Event[] = [];
    const errors: unknown[] = [];

    queue.push({ name: 'first' });
    queue.push({ name: 'second', args: { value: 2 } });

    await expect(runEventBatch(
      queue,
      (event) => { delivered.push(event); },
      (error) => { errors.push(error); },
    )).resolves.toBe(2);

    expect(delivered).toEqual([
      { name: 'first' },
      { name: 'second', args: { value: 2 } },
    ]);
    expect(errors).toEqual([]);
  });

  it('waits while empty and wakes when an event is pushed', async () => {
    const queue = new AsyncEventQueue();
    const delivered: string[] = [];

    const batch = runEventBatch(
      queue,
      (event) => { delivered.push(event.name); },
      () => {},
    );
    await Promise.resolve();
    expect(delivered).toEqual([]);

    queue.push({ name: 'woke' });

    await expect(batch).resolves.toBe(1);
    expect(delivered).toEqual(['woke']);
  });

  it('reports sync handler errors and continues through the batch', async () => {
    const queue = new AsyncEventQueue();
    const delivered: string[] = [];
    const errors: Array<{ error: unknown; event: Event }> = [];

    queue.push({ name: 'bad' });
    queue.push({ name: 'good' });

    const count = await runEventBatch(
      queue,
      (event) => {
        if (event.name === 'bad') throw new Error('boom');
        delivered.push(event.name);
      },
      (error, event) => { errors.push({ error, event }); },
    );

    expect(count).toBe(2);
    expect(delivered).toEqual(['good']);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.event).toEqual({ name: 'bad' });
    expect(errors[0]?.error).toBeInstanceOf(Error);
  });

  it('reports promise-returning handlers as invalid sync handlers', async () => {
    const queue = new AsyncEventQueue();
    const errors: Array<{ error: unknown; event: Event }> = [];

    queue.push({ name: 'async_handler' });

    await expect(runEventBatch(
      queue,
      (() => Promise.resolve()) as unknown as (event: Event) => void,
      (error, event) => { errors.push({ error, event }); },
    )).resolves.toBe(1);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.event).toEqual({ name: 'async_handler' });
    expect(errors[0]?.error).toBeInstanceOf(Error);
    expect(String((errors[0]?.error as Error).message)).toContain('synchronous');
  });
});
