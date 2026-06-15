import { dispatchCall, dispatchEvent, dispatchRecover } from './dispatch.js';
import { getCompiledActorDefinition } from './define-machine.js';
import { AsyncActorQueue, runActorPump } from './event-queue.js';
import type { ActorDefinition, ActorInternals, ActorMessage, CompiledActorDefinition } from './types.js';

export type ActorConstructor<T extends BaseActor = BaseActor> = (new (...args: any[]) => T) & {
  _actor: ActorDefinition;
  _compiled_actor?: CompiledActorDefinition;
};

export type ActorErrorHandler<T extends BaseActor = BaseActor> = (
  error: unknown,
  actor: T,
  message: ActorMessage,
) => void;

export type CreateActorOptions<T extends BaseActor = BaseActor> = {
  onError?: ActorErrorHandler<T>;
};

export type RecoverActorOptions<T extends BaseActor = BaseActor> = CreateActorOptions<T> & {
  state: string;
};

export abstract class BaseActor {
  #definition: CompiledActorDefinition | undefined;
  #state: string | undefined;
  #queue: AsyncActorQueue | undefined;

  state(): string {
    return this.#requireInternals().state;
  }

  send(name: string): void {
    this.#requireInternals().queue.push({ kind: 'event', name });
  }

  call(name: string, args?: unknown): void {
    const message = args === undefined
      ? { kind: 'call' as const, name }
      : { kind: 'call' as const, name, args };
    this.#requireInternals().queue.push(message);
  }

  _installActorInternals(internals: ActorInternals): void {
    if (this.#queue !== undefined) {
      throw new Error('Actor internals already installed');
    }
    this.#definition = internals.definition;
    this.#state = internals.state;
    this.#queue = internals.queue;
  }

  _actorDefinitionForRuntime(): CompiledActorDefinition {
    return this.#requireInternals().definition;
  }

  _stateForRuntime(): string {
    return this.#requireInternals().state;
  }

  _setStateForRuntime(state: string): void {
    this.#requireInternals();
    this.#state = state;
  }

  _queueForRuntime(): AsyncActorQueue {
    return this.#requireInternals().queue;
  }

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

export function createActor<T extends BaseActor>(
  ctor: ActorConstructor<T>,
  ...args: ConstructorParameters<ActorConstructor<T>>
): T {
  return startActor(ctor, ...args);
}

export function createActorWithOptions<T extends BaseActor>(
  ctor: ActorConstructor<T>,
  options: CreateActorOptions<T>,
  ...args: ConstructorParameters<ActorConstructor<T>>
): T {
  return startActorWithOptions(ctor, options, ...args);
}

export function startActor<T extends BaseActor>(
  ctor: ActorConstructor<T>,
  ...args: ConstructorParameters<ActorConstructor<T>>
): T {
  return startActorWithOptions(ctor, {}, ...args);
}

export function startActorWithOptions<T extends BaseActor>(
  ctor: ActorConstructor<T>,
  options: CreateActorOptions<T>,
  ...args: ConstructorParameters<ActorConstructor<T>>
): T {
  const definition = getCompiledActorDefinition(ctor);
  return installActor(ctor, definition.initial, options, undefined, ...args);
}

export function recoverActor<T extends BaseActor>(
  ctor: ActorConstructor<T>,
  state: string,
  ...args: ConstructorParameters<ActorConstructor<T>>
): T {
  return recoverActorWithOptions(ctor, { state }, ...args);
}

export function recoverActorWithOptions<T extends BaseActor>(
  ctor: ActorConstructor<T>,
  options: RecoverActorOptions<T>,
  ...args: ConstructorParameters<ActorConstructor<T>>
): T {
  const definition = getCompiledActorDefinition(ctor);
  if (!definition.states.has(options.state)) {
    throw new Error(`Cannot recover ${ctor.name || '<anonymous>'} to unknown state "${options.state}"`);
  }

  return installActor(ctor, options.state, options, dispatchRecover, ...args);
}

function installActor<T extends BaseActor>(
  ctor: ActorConstructor<T>,
  state: string,
  options: CreateActorOptions<T>,
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

  afterInstall?.(actor);

  void runActorPump(
    queue,
    (message) => {
      if (message.kind === 'event') {
        dispatchEvent(actor, message);
        return;
      }
      dispatchCall(actor, message);
    },
    (error, message) => {
      if (options.onError) {
        options.onError(error, actor, message);
        return;
      }
      throw error;
    },
  );

  return actor;
}
