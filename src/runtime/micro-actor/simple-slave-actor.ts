import { SlaveActor } from './slave-actor.js';
import type { ActorDefinition } from './types.js';

export type SimpleSlaveCommandCallbacks<Result = unknown> = {
  on_done?: (result: Result) => void;
  on_failed?: (error: unknown) => void;
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
  controller: AbortController;
};

type SimpleSlaveTaskSucceeded = {
  id: string;
  result: unknown;
};

type SimpleSlaveTaskFailed = {
  id: string;
  error: unknown;
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
        calls: { enqueue_command: 'enqueueCommand', cancel_command: 'cancelCommand' },
      },
      working: {
        on: { done: 'idle', failed: 'idle' },
        calls: {
          enqueue_command: 'enqueueCommand',
          command_done: 'commandDone',
          command_failed: 'commandFailed',
          cancel_command: 'cancelCommand',
        },
      },
    },
  };

  private static nextCommandId = 1;
  private readonly queuedCommands: SimpleSlaveQueuedCommand[] = [];
  private runningCommand: SimpleSlaveRunningCommand | null = null;

  override readonly mailbox: SimpleSlaveMailbox = {
    deliver: (name, args, callbacks) => {
      const id = `command-${SimpleSlaveActor.nextCommandId++}`;
      this._enqueueMailboxCommand('enqueue_command', { id, name, args, callbacks });
      return {
        id,
        cancel: () => this.mailbox.cancel(id),
      };
    },
    cancel: (id) => {
      this._enqueueMailboxCommand('cancel_command', { id });
    },
  };

  protected abstract _runCommand(
    command: { id: string; name: string; args?: unknown },
    context: { signal: AbortSignal },
  ): Promise<unknown>;

  enqueueCommand(args: SimpleSlaveQueuedCommand): void {
    this.queuedCommands.push(args);
    if (this.state() === 'idle') {
      this._send_event('work_available');
    }
  }

  cancelCommand(args: { id: string }): void {
    const queuedIndex = this.queuedCommands.findIndex((command) => command.id === args.id);
    if (queuedIndex >= 0) {
      const [command] = this.queuedCommands.splice(queuedIndex, 1);
      command?.callbacks?.on_failed?.(new SimpleSlaveCommandCancelledError(args.id));
      return;
    }

    if (this.runningCommand?.id === args.id) {
      const command = this.runningCommand;
      this.runningCommand = null;
      command.controller.abort();
      command.callbacks?.on_failed?.(new SimpleSlaveCommandCancelledError(args.id));
      this._send_event('failed');
    }
  }

  commandDone(args: SimpleSlaveTaskSucceeded): void {
    if (this.runningCommand?.id !== args.id) return;
    const command = this.runningCommand;
    this.runningCommand = null;
    command.callbacks?.on_done?.(args.result);
    this._send_event('done');
  }

  commandFailed(args: SimpleSlaveTaskFailed): void {
    if (this.runningCommand?.id !== args.id) return;
    const command = this.runningCommand;
    this.runningCommand = null;
    command.callbacks?.on_failed?.(args.error);
    this._send_event('failed');
  }

  _on_enter__idle(): void {
    if (this.queuedCommands.length > 0) {
      this._send_event('work_available');
    }
  }

  _on_enter__working(): void {
    if (this.runningCommand || this.queuedCommands.length === 0) return;
    const next = this.queuedCommands.shift()!;
    const controller = new AbortController();
    this.runningCommand = { ...next, controller };

    this._runCommand(next, { signal: controller.signal })
      .then((result) => {
        this._enqueueMailboxCommand('command_done', { id: next.id, result });
      })
      .catch((error) => {
        this._enqueueMailboxCommand('command_failed', { id: next.id, error });
      });
  }
}
