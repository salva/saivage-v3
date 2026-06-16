import { describe, expect, it } from '@jest/globals';
import { MailboxQueue } from '../../../src/runtime/micro-actor/index.js';
import type { MailboxCommand } from '../../../src/runtime/micro-actor/index.js';

describe('MailboxQueue', () => {
  it('pushes and shifts commands in order', async () => {
    const queue = new MailboxQueue();

    queue.push({ kind: 'call', name: 'first' });
    queue.push({ kind: 'call', name: 'second', args: { value: 2 } });

    const first = await queue.shift();
    expect(first).toEqual({ kind: 'call', name: 'first' });

    const second = await queue.shift();
    expect(second).toEqual({ kind: 'call', name: 'second', args: { value: 2 } });
  });

  it('waits while empty and wakes when a message is pushed', async () => {
    const queue = new MailboxQueue();

    const shifted = queue.shift();
    await Promise.resolve();

    queue.push({ kind: 'call', name: 'woke' });
    const command = await shifted;
    expect(command).toEqual({ kind: 'call', name: 'woke' });
  });

  it('drains all pending commands', () => {
    const queue = new MailboxQueue();

    queue.push({ kind: 'call', name: 'a' });
    queue.push({ kind: 'call', name: 'b' });

    const batch = queue.drain();
    expect(batch).toEqual([
      { kind: 'call', name: 'a' },
      { kind: 'call', name: 'b' },
    ]);
    expect(queue.drain()).toEqual([]);
  });

  it('rejects shift after close', async () => {
    const queue = new MailboxQueue();
    queue.close();

    await expect(queue.shift()).rejects.toThrow('closed');
  });

  it('ignores push after close', () => {
    const queue = new MailboxQueue();
    queue.close();
    queue.push({ kind: 'call', name: 'ignored' });

    expect(queue.drain()).toEqual([]);
    expect(queue.isClosed()).toBe(true);
  });
});