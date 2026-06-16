import { describe, expect, it } from '@jest/globals';
import { MailboxQueue, runMailboxBatch } from '../../../src/runtime/micro-actor/index.js';
import type { MailboxCommand } from '../../../src/runtime/micro-actor/index.js';

describe('MailboxQueue', () => {
  it('delivers queued commands in batch order', async () => {
    const queue = new MailboxQueue();
    const delivered: MailboxCommand[] = [];
    const errors: unknown[] = [];

    queue.push({ kind: 'call', name: 'first' });
    queue.push({ kind: 'call', name: 'second', args: { value: 2 } });

    await expect(runMailboxBatch(
      queue,
      (message) => { delivered.push(message); },
      (error) => { errors.push(error); },
    )).resolves.toBe(2);

    expect(delivered).toEqual([
      { kind: 'call', name: 'first' },
      { kind: 'call', name: 'second', args: { value: 2 } },
    ]);
    expect(errors).toEqual([]);
  });

  it('waits while empty and wakes when a message is pushed', async () => {
    const queue = new MailboxQueue();
    const delivered: string[] = [];

    const batch = runMailboxBatch(
      queue,
      (message) => { delivered.push(message.name); },
      () => {},
    );
    await Promise.resolve();
    expect(delivered).toEqual([]);

    queue.push({ kind: 'call', name: 'woke' });

    await expect(batch).resolves.toBe(1);
    expect(delivered).toEqual(['woke']);
  });

  it('reports sync handler errors and continues through the batch', async () => {
    const queue = new MailboxQueue();
    const delivered: string[] = [];
    const errors: Array<{ error: unknown; command: MailboxCommand }> = [];

    queue.push({ kind: 'call', name: 'bad' });
    queue.push({ kind: 'call', name: 'good' });

    const count = await runMailboxBatch(
      queue,
      (message) => {
        if (message.name === 'bad') throw new Error('boom');
        delivered.push(message.name);
      },
      (error, command) => { errors.push({ error, command }); },
    );

    expect(count).toBe(2);
    expect(delivered).toEqual(['good']);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.command).toEqual({ kind: 'call', name: 'bad' });
    expect(errors[0]?.error).toBeInstanceOf(Error);
  });

  it('reports promise-returning handlers as invalid sync handlers', async () => {
    const queue = new MailboxQueue();
    const errors: Array<{ error: unknown; command: MailboxCommand }> = [];

    queue.push({ kind: 'call', name: 'async_handler' });

    await expect(runMailboxBatch(
      queue,
      (() => Promise.resolve()) as unknown as (command: MailboxCommand) => void,
      (error, command) => { errors.push({ error, command }); },
    )).resolves.toBe(1);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.command).toEqual({ kind: 'call', name: 'async_handler' });
    expect(errors[0]?.error).toBeInstanceOf(Error);
    expect(String((errors[0]?.error as Error).message)).toContain('synchronous');
  });
});
