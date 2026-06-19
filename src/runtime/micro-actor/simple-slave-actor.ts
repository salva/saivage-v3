import { SlaveActor } from './slave-actor.js';
import type { ActorDefinition } from './types.js';

export type SimpleSlaveCommandCallbacks<Result = unknown> = {
  on_done?: (result: Result) => void;
  on_failed?: (error: Error) => void;
};

export type SimpleSlaveCommandHandle = {
  id: string;
  cancel(): void;
};

export type SimpleSlaveMailbox = {
  deliver<Result = unknown>(
    name: string,
    args?: unknown,
    callbacks?: SimpleSlaveCommandCallbacks<Result>,
  ): SimpleSlaveCommandHandle;
  cancel(id: string): void;
};

type SimpleSlaveQueuedCommand = {
  id: string;
  name: string;
  args?: unknown;
  callbacks?: SimpleSlaveCommandCallbacks;
};

type SimpleSlaveRunningCommand = SimpleSlaveQueuedCommand & {
  cancel: () => void;
};

export class SimpleSlaveCommandCancelledError extends Error {
  constructor(readonly commandId: string) {
    super(`Command ${commandId} was cancelled`);
    this.name = 'SimpleSlaveCommandCancelledError';
  }
}

// SimpleSlaveActor is a serial worker specialization. Its public mailbox accepts
// commands with optional completion callbacks. It runs at most one command at a
// time, keeps later commands queued, and supports cancelling queued or running
// commands.
export abstract class SimpleSlaveActor extends SlaveActor {
  static _allow_inherited_actor = true;
  static _actor: ActorDefinition = {
    initial: 'idle',
    states: {
      idle: {
        on: { work_available: 'working' },
      },
      working: {
        on: { done: 'idle', failed: 'idle' },
      },
    },
  };

  private static nextCommandId = 1;
  private readonly queuedCommands: SimpleSlaveQueuedCommand[] = [];
  private runningCommand: SimpleSlaveRunningCommand | null = null;
  private workAvailable: (() => void) | null = null;

  override readonly mailbox: SimpleSlaveMailbox = {
    deliver: (name, args, callbacks) => {
      const id = `command-${SimpleSlaveActor.nextCommandId++}`;
      const command: SimpleSlaveQueuedCommand = { id, name, args, callbacks: callbacks as SimpleSlaveCommandCallbacks | undefined };
      this.enqueueCommand(command);
      return {
        id,
        cancel: () => this.cancelCommand(id),
      };
    },
    cancel: (id) => {
      this.cancelCommand(id);
    },
  };

  protected abstract _runCommand(
    command: { id: string; name: string; args?: unknown },
    context: { signal: AbortSignal },
  ): Promise<unknown>;

  enqueueCommand(command: SimpleSlaveQueuedCommand): void {
    this.queuedCommands.push(command);
    this.workAvailable?.();
    this.workAvailable = null;
  }

  cancelCommand(id: string): void {
    const queuedIndex = this.queuedCommands.findIndex((command) => command.id === id);
    if (queuedIndex >= 0) {
      const [command] = this.queuedCommands.splice(queuedIndex, 1);
      command?.callbacks?.on_failed?.(new SimpleSlaveCommandCancelledError(id));
      return;
    }

    if (this.runningCommand?.id === id) {
      const command = this.runningCommand;
      command.cancel();
    }
  }

  _on_enter__idle(): void {
    this.runTask(
      (signal) => this._waitForWork(signal),
      { on_done_event: 'work_available' },
    );
  }

  _on_enter__working(): void {
    if (this.runningCommand || this.queuedCommands.length === 0) return;
    const next = this.queuedCommands.shift()!;
    const controller = new AbortController();
    let cancel!: () => void;

    this.runTask(
      (signal) => {
        signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
        const cancelled = new Promise<never>((_resolve, reject) => {
          cancel = () => {
            const error = new SimpleSlaveCommandCancelledError(next.id);
            controller.abort(error);
            reject(error);
          };
        });
        return Promise.race([this._runCommand(next, { signal: controller.signal }), cancelled]);
      },
      {
        on_done: (result) => {
          const command = this.runningCommand;
          if (command?.id === next.id) {
            this.runningCommand = null;
            command.callbacks?.on_done?.(result);
            this.sendEvent('done');
          }
        },
        on_failed: (error) => {
          const command = this.runningCommand;
          if (command?.id === next.id) {
            this.runningCommand = null;
            command.callbacks?.on_failed?.(error);
            this.sendEvent('failed');
          }
        },
      },
    );

    this.runningCommand = { ...next, cancel };
  }

  private _waitForWork(signal: AbortSignal): Promise<void> {
    if (this.queuedCommands.length > 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.workAvailable = resolve;
      signal.addEventListener('abort', () => {
        if (this.workAvailable === resolve) this.workAvailable = null;
        reject(signal.reason);
      }, { once: true });
    });
  }
}
