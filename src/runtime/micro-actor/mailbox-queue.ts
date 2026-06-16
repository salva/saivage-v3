import type { MailboxCommand } from './types.js';

export class MailboxQueue {
  private items: MailboxCommand[] = [];
  private wake: (() => void) | undefined;
  private closed = false;

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
  }

  isClosed(): boolean {
    return this.closed;
  }
}