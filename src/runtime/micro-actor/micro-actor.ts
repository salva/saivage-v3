import { dispatchEvent, dispatchRecover } from './dispatch.js';
import { getCompiledActorDefinition } from './define-machine.js';
import type { ActorDefinition, ActorInternals, CompiledActorDefinition } from './types.js';

export class InternalActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InternalActorError';
  }
}

// Runtime constructor shape for concrete actor classes. The static _actor table is
// the declarative state/transition contract compiled once per class.
export type ActorConstructor<T extends BaseActor = BaseActor> = (new (...args: any[]) => T) & {
  _actor: ActorDefinition;
  _compiled_actor?: CompiledActorDefinition;
};

export type ActorStateTask<Result = unknown> = {
  run(context: { signal: AbortSignal }): Promise<Result>;
  on_done?: (result: Result) => void;
  on_failed?: (error: unknown) => void;
};

type ActiveStateTask<Result = unknown> = ActorStateTask<Result> & {
  id: number;
  state: string;
  controller: AbortController;
};

// BaseActor owns only the generic micro-actor machinery: compiled definition,
// current state, pending event, state tasks, and state waiters. Concrete actors own all domain
// fields and behavior. External callers should not instantiate BaseActor directly.
export abstract class BaseActor {
  #definition: CompiledActorDefinition | undefined;
  #state: string | undefined;
  #nextEvent: string | undefined;
  #nextTaskId = 1;
  #stateTasks = new Map<number, ActiveStateTask>();
  #stateWaiters: Array<{ predicate: (state: string) => boolean; resolve: (state: string) => void }> = [];

  state(): string {
    return this.#requireInternals().state;
  }

  // Internal event emission. This records the one event the current actor turn
  // should process next; it is not an event queue.
  protected _send_event(name: string): void {
    this.#requireInternals();
    if (this.#nextEvent !== undefined) {
      throw new InternalActorError(`Actor already has pending event "${this.#nextEvent}", cannot send "${name}"`);
    }
    this.#nextEvent = name;
  }

  protected _start_task<Result>(task: ActorStateTask<Result>): void {
    const state = this.#requireInternals().state;
    const controller = new AbortController();
    const id = this.#nextTaskId++;
    this.#stateTasks.set(id, { ...task, id, state, controller } as ActiveStateTask);

    Promise.resolve()
      .then(() => task.run({ signal: controller.signal }))
      .then((result) => {
        this._runActorTurnForRuntime(() => this.#completeTask(id, 'done', result));
      })
      .catch((error) => {
        this._runActorTurnForRuntime(() => this.#completeTask(id, 'failed', error));
      });
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
    if (this.#definition !== undefined || this.#state !== undefined) {
      throw new Error('Actor internals already installed');
    }
    this.#definition = internals.definition;
    this.#state = internals.state;
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
    const current = this.#requireInternals().state;
    if (current !== state) {
      this.#cancelTasksForState(current);
    }
    this.#state = state;
    this.#notifyStateWaiters(state);
  }

  _consumeNextEventForRuntime(): string | undefined {
    this.#requireInternals();
    const event = this.#nextEvent;
    this.#nextEvent = undefined;
    return event;
  }

  _runActorTurnForRuntime(run: () => void): void {
    this.#requireInternals();
    const result = run() as unknown;
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(() => undefined);
      throw new InternalActorError('Actor turn work must be synchronous');
    }
    drainActorEvents(this);
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
    if (this.#definition === undefined || this.#state === undefined) {
      throw new Error('Actor internals are not installed');
    }

    return {
      definition: this.#definition,
      state: this.#state,
    };
  }

  #completeTask(id: number, status: 'done' | 'failed', value: unknown): void {
    const task = this.#stateTasks.get(id);
    if (!task) return;
    this.#stateTasks.delete(id);
    if (task.controller.signal.aborted || task.state !== this.#requireInternals().state) return;

    const result = status === 'done'
      ? task.on_done?.(value)
      : task.on_failed?.(value);
    if (isPromiseLike(result)) {
      throw new InternalActorError(`State task ${status} handler must be synchronous`);
    }
  }

  #cancelTasksForState(state: string): void {
    for (const [id, task] of this.#stateTasks) {
      if (task.state !== state) continue;
      this.#stateTasks.delete(id);
      task.controller.abort();
    }
  }
}

// Construct a fresh actor at its declaration's initial state.
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

// Shared construction path for start and recovery.
function installActor<T extends BaseActor>(
  ctor: ActorConstructor<T>,
  state: string,
  afterInstall: ((actor: T) => void) | undefined,
  ...args: ConstructorParameters<ActorConstructor<T>>
): T {
  const definition = getCompiledActorDefinition(ctor);
  const actor = new ctor(...args);

  actor._installActorInternals({
    definition,
    state,
  });

  // Recovery needs hooks to run before accepting later mailbox
  // commands; fresh starts do not need an after-install hook.
  if (afterInstall) {
    actor._runActorTurnForRuntime(() => afterInstall(actor));
  }
  startOptionalMailboxPump(actor);

  return actor;
}

function startOptionalMailboxPump(actor: BaseActor): void {
  const maybeMailboxActor = actor as BaseActor & { _startMailboxPumpForRuntime?: () => void };
  maybeMailboxActor._startMailboxPumpForRuntime?.();
}

function drainActorEvents(actor: BaseActor): void {
  for (let i = 0; i < 100; i++) {
    const event = actor._consumeNextEventForRuntime();
    if (event === undefined) return;
    dispatchEvent(actor, event);
  }
  throw new InternalActorError('Actor produced too many internal events in one turn');
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object'
    && value !== null
    && 'then' in value
    && typeof (value as { then?: unknown }).then === 'function';
}
