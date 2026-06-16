import { dispatchCall } from './micro-actor.js';
import { MailboxQueue } from './mailbox-queue.js';
import { BaseActor } from './micro-actor.js';

export type ActorCommandMailbox = {
  deliver(name: string, args?: unknown): void;
};

// SlaveActor is the externally addressable actor base. Other objects can deliver
// commands to the mailbox, but cannot emit events or mutate state directly.
export abstract class SlaveActor extends BaseActor {
  #mailboxQueue = new MailboxQueue();

  readonly mailbox: ActorCommandMailbox = {
    deliver: (name, args) => {
      this._enqueueMailboxCommand(name, args);
    },
  };

  protected _enqueueMailboxCommand(name: string, args?: unknown): void {
    const command = args === undefined
      ? { kind: 'call' as const, name }
      : { kind: 'call' as const, name, args };
    this.#mailboxQueue.push(command);
  }

  _startMailboxPumpForRuntime(): void {
    this._startMailboxTask();
  }

  private _startMailboxTask(): void {
    this._start_actor_task({
      run: () => this.#mailboxQueue.shift(),
      on_done: (command) => {
        dispatchCall(this, command);
        this._startMailboxTask();
      },
    });
  }
}
