import { dispatchCall } from './dispatch.js';
import { BaseActor } from './micro-actor.js';

export type ActorCommandMailbox = {
  deliver(name: string, args?: unknown): void;
};

// SlaveActor is the externally addressable actor base. Other objects can deliver
// commands to the mailbox, but cannot emit events or mutate state directly.
export abstract class SlaveActor extends BaseActor {
  readonly mailbox: ActorCommandMailbox = {
    deliver: (name, args) => {
      this._enqueueMailboxCommand(name, args);
    },
  };

  protected _enqueueMailboxCommand(name: string, args?: unknown): void {
    const command = args === undefined
      ? { kind: 'call' as const, name }
      : { kind: 'call' as const, name, args };
    this._enqueuePumpWorkForRuntime(
      () => dispatchCall(this, command),
      command,
    );
  }
}
