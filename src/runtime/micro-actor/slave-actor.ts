import { MailboxQueue } from './mailbox-queue.js';
import { BaseActor } from './micro-actor.js';
import type { MailboxCommand } from './types.js';

export type ActorCommandMailbox = {
  deliver(name: string, args?: unknown): void;
};

// SlaveActor is the externally addressable actor base. Other objects can deliver
// commands to the mailbox. Derived classes dequeue commands in their own state
// handlers.
export abstract class SlaveActor extends BaseActor {
  readonly #mailboxQueue = new MailboxQueue();

  readonly mailbox: ActorCommandMailbox = {
    deliver: (name, args) => {
      const command = args === undefined
        ? { kind: 'call' as const, name }
        : { kind: 'call' as const, name, args };
      this.#mailboxQueue.push(command);
    },
  };

  protected _dequeueCommand(): Promise<MailboxCommand> {
    return this.#mailboxQueue.shift();
  }

  protected _drainCommands(): MailboxCommand[] {
    return this.#mailboxQueue.drain();
  }

  protected _closeMailbox(): void {
    this.#mailboxQueue.close();
  }
}