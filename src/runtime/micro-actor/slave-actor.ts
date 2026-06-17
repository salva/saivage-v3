import { MailboxQueue } from './mailbox-queue.js';
import { BaseActor } from './micro-actor.js';
import type { MailboxCommand } from './types.js';

export type ActorCommandMailbox = {
  deliver(name: string, args?: unknown): void;
};

// SlaveActor is the externally addressable actor base. Other objects can deliver
// commands to the mailbox. Commands are queued and dispatched through the
// actor's mailbox task, invoking _on_call__{state}__{name}(args) handlers.
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

  protected _enqueueMailboxCommand(name: string, args?: unknown): void {
    const command = args === undefined
      ? { kind: 'call' as const, name }
      : { kind: 'call' as const, name, args };
    this.#mailboxQueue.push(command);
  }

  protected _closeMailbox(): void {
    this.#mailboxQueue.close();
  }

  _startMailboxPumpForRuntime(): void {
    this._startMailboxTask();
  }

  private _startMailboxTask(): void {
    this._start_actor_task({
      run: () => this.#mailboxQueue.shift(),
      on_done: (command: MailboxCommand) => {
        this._dispatchMailboxCommand(command);
        this._startMailboxTask();
      },
      on_failed: () => {
        this._startMailboxTask();
      },
    });
  }

  private _dispatchMailboxCommand(command: MailboxCommand): void {
    const currentState = this._state!;
    const handlerName = `_on_call__${currentState}__${command.name}`;
    const handler = (this as unknown as Record<string, unknown>)[handlerName];
    if (typeof handler === 'function') {
      handler.call(this, command.args);
    }
  }
}