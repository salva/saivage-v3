import { describe, expect, it } from '@jest/globals';
import { AsyncActorQueue, runActorBatch } from '../../../src/runtime/micro-actor/index.js';
import type { ActorMessage } from '../../../src/runtime/micro-actor/index.js';

describe('AsyncActorQueue', () => {
  it('delivers queued messages in batch order', async () => {
    const queue = new AsyncActorQueue();
    const delivered: ActorMessage[] = [];
    const errors: unknown[] = [];

    queue.push({ kind: 'event', name: 'first' });
    queue.push({ kind: 'call', name: 'second', args: { value: 2 } });

    await expect(runActorBatch(
      queue,
      (message) => { delivered.push(message); },
      (error) => { errors.push(error); },
    )).resolves.toBe(2);

    expect(delivered).toEqual([
      { kind: 'event', name: 'first' },
      { kind: 'call', name: 'second', args: { value: 2 } },
    ]);
    expect(errors).toEqual([]);
  });

  it('waits while empty and wakes when a message is pushed', async () => {
    const queue = new AsyncActorQueue();
    const delivered: string[] = [];

    const batch = runActorBatch(
      queue,
      (message) => { delivered.push(message.name); },
      () => {},
    );
    await Promise.resolve();
    expect(delivered).toEqual([]);

    queue.push({ kind: 'event', name: 'woke' });

    await expect(batch).resolves.toBe(1);
    expect(delivered).toEqual(['woke']);
  });

  it('reports sync handler errors and continues through the batch', async () => {
    const queue = new AsyncActorQueue();
    const delivered: string[] = [];
    const errors: Array<{ error: unknown; message: ActorMessage }> = [];

    queue.push({ kind: 'event', name: 'bad' });
    queue.push({ kind: 'event', name: 'good' });

    const count = await runActorBatch(
      queue,
      (message) => {
        if (message.name === 'bad') throw new Error('boom');
        delivered.push(message.name);
      },
      (error, message) => { errors.push({ error, message }); },
    );

    expect(count).toBe(2);
    expect(delivered).toEqual(['good']);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toEqual({ kind: 'event', name: 'bad' });
    expect(errors[0]?.error).toBeInstanceOf(Error);
  });

  it('reports promise-returning handlers as invalid sync handlers', async () => {
    const queue = new AsyncActorQueue();
    const errors: Array<{ error: unknown; message: ActorMessage }> = [];

    queue.push({ kind: 'event', name: 'async_handler' });

    await expect(runActorBatch(
      queue,
      (() => Promise.resolve()) as unknown as (message: ActorMessage) => void,
      (error, message) => { errors.push({ error, message }); },
    )).resolves.toBe(1);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toEqual({ kind: 'event', name: 'async_handler' });
    expect(errors[0]?.error).toBeInstanceOf(Error);
    expect(String((errors[0]?.error as Error).message)).toContain('synchronous');
  });
});
