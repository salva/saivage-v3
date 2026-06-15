import { dispatchCall, dispatchEvent, dispatchRecover } from './dispatch.js';
import { getCompiledActorDefinition } from './define-machine.js';
import { AsyncActorQueue, runActorPump } from './event-queue.js';
import type { ActorDefinition, ActorInternals, CompiledActorDefinition } from './types.js';

export type ActorConstructor<T extends BaseActor = BaseActor> = (new (...args: any[]) => T) & {
  _actor: ActorDefinition;
  _compiled_actor?: CompiledActorDefinition;
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

export function startActor<T extends BaseActor>(
  ctor: ActorConstructor<T>,
  ...args: ConstructorParameters<ActorConstructor<T>>
): T {
  const definition = getCompiledActorDefinition(ctor);
  return installActor(ctor, definition.initial, undefined, ...args);
}

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
      throw error;
    },
  );

  return actor;
}
