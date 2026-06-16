import type { MailboxCommand } from './types.js';

export type MailboxCommandHandler = (command: MailboxCommand) => void;
export type MailboxCommandErrorHandler = (error: unknown, command: MailboxCommand) => void;

export class MailboxQueue {
  private items: MailboxCommand[] = [];
  private wake: (() => void) | undefined;
  private closed = false;
  private closeResolve: (() => void) | undefined;

  push(command: MailboxCommand): void {
    if (this.closed) return;
    this.items.push(command);
    this.wake?.();
    this.wake = undefined;
  }

  async shift(): Promise<MailboxCommand> {
    while (this.items.length === 0) {
      if (this.closed) {
        throw new Error('Actor mailbox queue closed');
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      if (this.closed) {
        throw new Error('Actor mailbox queue closed');
      }
    }

    return this.items.shift()!;
  }

  drain(): MailboxCommand[] {
    const batch = this.items;
    this.items = [];
    return batch;
  }

  close(): void {
    this.closed = true;
    this.wake?.();
    this.wake = undefined;
    if (this.closeResolve) {
      this.closeResolve();
    }
  }

  isClosed(): boolean {
    return this.closed;
  }
}

export async function runMailboxBatch(
  queue: MailboxQueue,
  handleCommand: MailboxCommandHandler,
  onError: MailboxCommandErrorHandler,
): Promise<number> {
  const first = await queue.shift();
  const batch = [first, ...queue.drain()];

  for (const command of batch) {
    try {
      const result = handleCommand(command) as unknown;
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined);
        onError(new Error('Actor mailbox command handlers must be synchronous'), command);
      }
    } catch (error) {
      onError(error, command);
    }
  }

  return batch.length;
}

export async function runActorPump(
  queue: MailboxQueue,
  handleCommand: MailboxCommandHandler,
  onError: MailboxCommandErrorHandler,
): Promise<void> {
  try {
    for (;;) {
      await runMailboxBatch(queue, handleCommand, onError);
    }
  } catch (error) {
    if (queue.isClosed()) return;
    throw error;
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object'
    && value !== null
    && 'then' in value
    && typeof (value as { then?: unknown }).then === 'function';
}
