import { dispatchCall, dispatchEvent, dispatchRecover } from './dispatch.js';
import { getCompiledActorDefinition } from './define-machine.js';
import { AsyncActorQueue, runActorPump } from './event-queue.js';
import type { ActorDefinition, ActorInternals, CompiledActorDefinition } from './types.js';

// Runtime constructor shape for concrete actor classes. The static _actor table is
// the declarative state/transition contract compiled once per class.
export type ActorConstructor<T extends BaseActor = BaseActor> = (new (...args: any[]) => T) & {
  _actor: ActorDefinition;
  _compiled_actor?: CompiledActorDefinition;
};

// BaseActor owns only the generic micro-actor machinery: compiled definition,
// current state, mailbox queue, and state waiters. Concrete actors own all domain
// fields and behavior. External callers should not instantiate BaseActor directly.
export abstract class BaseActor {
  #definition: CompiledActorDefinition | undefined;
  #state: string | undefined;
  #queue: AsyncActorQueue | undefined;
  #stateWaiters: Array<{ predicate: (state: string) => boolean; resolve: (state: string) => void }> = [];

  state(): string {
    return this.#requireInternals().state;
  }

  // Internal event emission. Actor methods use this to report facts such as
  // done/failed after synchronously updating their own fields. External objects
  // cannot call send directly; they must use a SlaveActor mailbox command.
  protected send(name: string): void {
    this.#requireInternals().queue.push({ kind: 'event', name });
  }

  waitForState(predicate: (state: string) => boolean): Promise<string> {
    const current = this.#requireInternals().state;
    if (predicate(current)) return Promise.resolve(current);
    return new Promise<string>((resolve) => {
      this.#stateWaiters.push({ predicate, resolve });
    });
  }

  // Runtime-only installation hook. Actor constructors run before private runtime
  // slots exist, so startActor/recoverActor installs these slots immediately after
  // construction.
  _installActorInternals(internals: ActorInternals): void {
    if (this.#queue !== undefined) {
      throw new Error('Actor internals already installed');
    }
    this.#definition = internals.definition;
    this.#state = internals.state;
    this.#queue = internals.queue;
  }

  // The following _*ForRuntime methods are intentionally narrow escape hatches for
  // the dispatcher. They avoid exposing private slots as public actor API.
  _actorDefinitionForRuntime(): CompiledActorDefinition {
    return this.#requireInternals().definition;
  }

  _stateForRuntime(): string {
    return this.#requireInternals().state;
  }

  _setStateForRuntime(state: string): void {
    this.#requireInternals();
    this.#state = state;
    this.#notifyStateWaiters(state);
  }

  _queueForRuntime(): AsyncActorQueue {
    return this.#requireInternals().queue;
  }

  // waitForState is used by adapters/controllers that need to observe when the
  // pump has processed a command. Waiters resolve on actual state changes.
  #notifyStateWaiters(state: string): void {
    const remaining: Array<{ predicate: (state: string) => boolean; resolve: (state: string) => void }> = [];
    for (const waiter of this.#stateWaiters) {
      if (waiter.predicate(state)) {
        waiter.resolve(state);
      } else {
        remaining.push(waiter);
      }
    }
    this.#stateWaiters = remaining;
  }

  // Fail loudly if actor code is used before startActor/recoverActor installed the
  // runtime machinery. Actor classes should not be manually new'ed for execution.
  #requireInternals(): ActorInternals {
    if (this.#definition === undefined || this.#state === undefined || this.#queue === undefined) {
      throw new Error('Actor internals are not installed');
    }

    return {
      definition: this.#definition,
      state: this.#state,
      queue: this.#queue,
    };
  }
}

export type ActorCommandMailbox = {
  deliver(name: string, args?: unknown): void;
};

// SlaveActor is the externally addressable actor base. Other objects can deliver
// commands to the mailbox, but cannot emit events or mutate state directly.
export abstract class SlaveActor extends BaseActor {
  readonly mailbox: ActorCommandMailbox = {
    deliver: (name, args) => {
      const message = args === undefined
        ? { kind: 'call' as const, name }
        : { kind: 'call' as const, name, args };
      this._queueForRuntime().push(message);
    },
  };
}

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
      this._queueForRuntime().push({ kind: 'call', name: 'enqueue_command', args: { id, name, args, callbacks } });
      return {
        id,
        cancel: () => this.mailbox.cancel(id),
      };
    },
    cancel: (id) => {
      this._queueForRuntime().push({ kind: 'call', name: 'cancel_command', args: { id } });
    },
  };

  protected abstract _runCommand(
    command: { id: string; name: string; args?: unknown },
    context: { signal: AbortSignal },
  ): Promise<unknown>;

  enqueueCommand(args: SimpleSlaveQueuedCommand): void {
    this.queuedCommands.push(args);
    if (this.state() === 'idle') {
      this.send('work_available');
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
      this.send('failed');
    }
  }

  commandDone(args: SimpleSlaveTaskSucceeded): void {
    if (this.runningCommand?.id !== args.id) return;
    const command = this.runningCommand;
    this.runningCommand = null;
    command.callbacks?.on_done?.(args.result);
    this.send('done');
  }

  commandFailed(args: SimpleSlaveTaskFailed): void {
    if (this.runningCommand?.id !== args.id) return;
    const command = this.runningCommand;
    this.runningCommand = null;
    command.callbacks?.on_failed?.(args.error);
    this.send('failed');
  }

  _on_enter__idle(): void {
    if (this.queuedCommands.length > 0) {
      this.send('work_available');
    }
  }

  _on_enter__working(): void {
    if (this.runningCommand || this.queuedCommands.length === 0) return;
    const next = this.queuedCommands.shift()!;
    const controller = new AbortController();
    this.runningCommand = { ...next, controller };

    this._runCommand(next, { signal: controller.signal })
      .then((result) => {
        this._queueForRuntime().push({ kind: 'call', name: 'command_done', args: { id: next.id, result } });
      })
      .catch((error) => {
        this._queueForRuntime().push({ kind: 'call', name: 'command_failed', args: { id: next.id, error } });
      });
  }
}

// Construct a fresh actor at its declaration's initial state and start its pump.
export function startActor<T extends BaseActor>(
  ctor: ActorConstructor<T>,
  ...args: ConstructorParameters<ActorConstructor<T>>
): T {
  const definition = getCompiledActorDefinition(ctor);
  return installActor(ctor, definition.initial, undefined, ...args);
}

// Construct an actor from persisted state. Recovery is not a queued command: the
// recovered state is installed first, then the state recovery/enter hook runs.
export function recoverActor<T extends BaseActor>(
  ctor: ActorConstructor<T>,
  state: string,
  ...args: ConstructorParameters<ActorConstructor<T>>
): T {
  const definition = getCompiledActorDefinition(ctor);
  if (!definition.states.has(state)) {
    throw new Error(`Cannot recover ${ctor.name || '<anonymous>'} to unknown state "${state}"`);
  }

  return installActor(ctor, state, dispatchRecover, ...args);
}

// Shared construction path for start and recovery. The pump is the only place that
// delivers mailbox commands and internal events to actor code.
function installActor<T extends BaseActor>(
  ctor: ActorConstructor<T>,
  state: string,
  afterInstall: ((actor: T) => void) | undefined,
  ...args: ConstructorParameters<ActorConstructor<T>>
): T {
  const definition = getCompiledActorDefinition(ctor);
  const actor = new ctor(...args);
  const queue = new AsyncActorQueue();

  actor._installActorInternals({
    definition,
    state,
    queue,
  });

  // Recovery needs hooks to run before the pump starts accepting later mailbox
  // commands; fresh starts do not need an after-install hook.
  afterInstall?.(actor);

  // The pump serializes all command/event delivery for this actor. Dispatch stays
  // internal to the pump; external objects interact through SlaveActor.mailbox.
  void runActorPump(
    queue,
    (message) => {
      if (message.kind === 'event') {
        dispatchEvent(actor, message);
        return;
      }
      dispatchCall(actor, message);
    },
    (error, _message) => {
      throw error;
    },
  );

  return actor;
}
