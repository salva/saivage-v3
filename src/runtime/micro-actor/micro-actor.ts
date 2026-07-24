import type {
  ActorDefinition,
  ActorLifecycleContext,
  ActorStartContext,
  ActorTransitionContext,
  CompiledActorDefinition,
  CompiledStateDefinition,
  CompiledTransitionDefinition,
  TransitionDefinition,
} from './types.js';

export class InternalActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InternalActorError';
  }
}

export class InvalidActorDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidActorDefinitionError';
  }
}

type TaskResult<Result = unknown> = {
  ok: true;
  result: Result;
} | {
  ok: false;
  error: Error;
};

type Task = {
  promise: Promise<TaskResult>;
  onDone: (result: unknown) => void;
  onFailed: (error: Error) => void;
};

export abstract class BaseActor {
  readonly #definition: CompiledActorDefinition;
  #currentState: string | undefined;
  #nextEvent: { name: string; sequence: number } | undefined;
  #queuedEventSequence = 0;
  #settledEventSequence = 0;
  #eventSettlementWaiters = new Set<{ sequence: number; resolve: () => void; reject: (error: unknown) => void }>();
  #task: Task | null = null;
  #actorMainRunning = false;
  #deliveringTaskResult = false;
  #currentTaskStateHalted = false;
  #mainLoopFailed = false;
  #mainLoopFailure: unknown;

  protected constructor(definition: CompiledActorDefinition) {
    this.#definition = definition;
  }

  protected abstract onStateEntered(context: ActorLifecycleContext): void;
  protected abstract onTransition(context: ActorTransitionContext): void;
  protected abstract onActorMainFailure(error: unknown): void;

  state(): string {
    return this.#currentState!;
  }

  start(): void {
    if (this.#currentState !== undefined) throw new InternalActorError(`Cannot start actor more than once from state "${this.#currentState}"`);
    this.#currentState = this.#definition.initial;
    const context: ActorStartContext = Object.freeze({
      source: null,
      event: null,
      target: this.#definition.initial,
    });
    this.onStateEntered(context);
    this.#ensureActorMain();
  }

  protected sendEvent(name: string): void {
    if (this.#nextEvent !== undefined) {
      throw new InternalActorError(`Actor already has pending event "${this.#nextEvent.name}", cannot send "${name}"`);
    }
    this.#queuedEventSequence++;
    this.#nextEvent = { name, sequence: this.#queuedEventSequence };
  }

  protected parkedSendEvent(name: string): void {
    const currentState = this.#currentState;
    if (currentState === undefined) {
      throw new InternalActorError('Cannot send parked event before actor start');
    }
    if (!this.#definition.states.get(currentState)?.parked) {
      throw new InternalActorError(`Cannot send parked event from non-parked state "${currentState}"`);
    }
    this.sendEvent(name);
    this.#ensureActorMain();
  }

  protected runTask<Result>(run: () => Promise<Result>, callbacks: Readonly<{ onDone(result: Result): void; onFailed(error: Error): void }>): void {
    const currentState = this.#currentState!;
    if (this.#definition.states.get(currentState)?.terminal) {
      throw new InternalActorError(`Cannot start task in terminal state "${currentState}"`);
    }
    if (this.#definition.states.get(currentState)?.parked) {
      throw new InternalActorError(`Cannot start task in parked state "${currentState}"`);
    }
    if (this.#task !== null) throw new InternalActorError(`Actor already has a task in state "${currentState}"`);
    this.#task = {
      promise: this.#safeTask(run),
      onDone: (result) => callbacks.onDone(result as Result),
      onFailed: callbacks.onFailed,
    };
  }

  protected awaitLifecycleSettlement(): Promise<void> {
    if (this.#mainLoopFailed) return Promise.reject(this.#mainLoopFailure);
    const sequence = this.#queuedEventSequence;
    if (this.#settledEventSequence >= sequence) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.#eventSettlementWaiters.add({ sequence, resolve, reject });
    });
  }

  protected haltCurrentTaskState(): void {
    if (!this.#deliveringTaskResult || this.#nextEvent !== undefined) throw new InternalActorError('Current task state can be halted only during task-result callback delivery with no pending event');
    this.#currentTaskStateHalted = true;
  }

  #dispatchEvent(eventName: string): string {
    const currentState = this.#currentState!;
    const stateDef = this.#definition.states.get(currentState)!;

    const transition = stateDef.on.get(eventName);
    if (transition === undefined) return currentState;

    if (transition.target === currentState && !transition.reenter) return currentState;

    const context: ActorTransitionContext = Object.freeze({
      source: currentState,
      event: eventName,
      target: transition.target,
      reentered: transition.reenter,
    });
    this.#currentState = transition.target;
    this.onTransition(context);
    this.onStateEntered(context);

    return transition.target;
  }

  async #actorMain(): Promise<void> {
    try {
      for (;;) {
        const event = this.#nextEvent;
        if (event !== undefined) {
          this.#nextEvent = undefined;
          try {
            this.#dispatchEvent(event.name);
            this.#settledEventSequence = event.sequence;
          } finally {
            this.#settleLifecycleWaiters();
          }
          continue;
        }

        if (this.#definition.states.get(this.#currentState!)?.terminal) {
          return;
        }

        if (this.#definition.states.get(this.#currentState!)?.parked) {
          return;
        }

        if (this.#task === null) {
          throw new InternalActorError(`Actor stuck in non-terminal state "${this.#currentState!}" with no pending tasks or events`);
        }

        const task = this.#task;
        const result = await task.promise;
        if (this.#task !== task) throw new InternalActorError('Actor task slot changed before callback delivery');
        this.#task = null;

        this.#deliveringTaskResult = true;
        try {
          if (result.ok) task.onDone(result.result);
          else task.onFailed(result.error);
        } finally { this.#deliveringTaskResult = false; }
        if (this.#currentTaskStateHalted) return;
      }
    } catch (error) {
      this.#mainLoopFailed = true;
      this.#mainLoopFailure = error;
      for (const waiter of this.#eventSettlementWaiters) {
        this.#eventSettlementWaiters.delete(waiter);
        waiter.reject(error);
      }
      console.error('BaseActor main loop failed', error);
      try {
        this.onActorMainFailure(error);
      } catch (hookError) {
        console.error('BaseActor main-loop failure hook failed', hookError);
      }
    } finally {
      this.#actorMainRunning = false;
    }
  }

  #settleLifecycleWaiters(): void {
    for (const waiter of this.#eventSettlementWaiters) {
      if (waiter.sequence > this.#settledEventSequence) continue;
      this.#eventSettlementWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  #ensureActorMain(): void {
    if (this.#actorMainRunning || this.#mainLoopFailed) return;
    this.#actorMainRunning = true;
    void this.#actorMain();
  }

  async #safeTask<Result>(run: () => Promise<Result>): Promise<TaskResult<Result>> {
    try {
      return { ok: true, result: await run() };
    } catch (error) {
      return { ok: false, error: error as Error };
    }
  }

}

export function compileActorDefinition(definition: ActorDefinition): CompiledActorDefinition {
  const stateNames = Object.keys(definition.states);
  if (stateNames.length === 0) {
    throw new InvalidActorDefinitionError('Actor definition must declare at least one state');
  }

  for (const stateName of stateNames) {
    if (stateName === '') {
      throw new InvalidActorDefinitionError('State names must be non-empty');
    }
  }

  if (!(definition.initial in definition.states)) {
    throw new InvalidActorDefinitionError(
      `Initial state "${definition.initial}" does not exist in states`,
    );
  }

  for (const [stateName, stateDef] of Object.entries(definition.states)) {
    if (stateDef.terminal && stateDef.on && Object.keys(stateDef.on).length > 0) {
      throw new InvalidActorDefinitionError(
        `Terminal state "${stateName}" cannot have transitions`,
      );
    }

    if (stateDef.terminal && stateDef.parked) {
      throw new InvalidActorDefinitionError(
        `State "${stateName}" cannot be both terminal and parked`,
      );
    }

    for (const [eventName, transition] of Object.entries(stateDef.on ?? {})) {
      if (eventName === '') {
        throw new InvalidActorDefinitionError(
          `Event name must be non-empty in state "${stateName}"`,
        );
      }
      const targetState = transitionTarget(transition);
      if (!(targetState in definition.states)) {
        throw new InvalidActorDefinitionError(
          `Transition target "${targetState}" in state "${stateName}" for event "${eventName}" does not exist in states`,
        );
      }
      if (typeof transition !== 'string' && transition.reenter === true && targetState !== stateName) {
        throw new InvalidActorDefinitionError(
          `Transition in state "${stateName}" for event "${eventName}" targets "${targetState}" with reenter:true; reentry requires the source and target state to match`,
        );
      }
    }
  }

  const compiledStates: Array<readonly [string, CompiledStateDefinition]> = [];
  for (const [stateName, stateDef] of Object.entries(definition.states)) {
    const on = new Map<string, CompiledTransitionDefinition>();
    for (const [eventName, transition] of Object.entries(stateDef.on ?? {})) {
      on.set(eventName, compileTransition(transition));
    }

    compiledStates.push([stateName, Object.freeze({
      on: immutableMap(on),
      terminal: stateDef.terminal,
      parked: stateDef.parked,
    })]);
  }

  return Object.freeze({
    initial: definition.initial,
    states: immutableMap(compiledStates),
  });
}

function transitionTarget(transition: TransitionDefinition): string {
  return typeof transition === 'string' ? transition : transition.target;
}

function compileTransition(transition: TransitionDefinition): CompiledTransitionDefinition {
  return Object.freeze({
    target: transitionTarget(transition),
    reenter: typeof transition !== 'string' && transition.reenter === true,
  });
}

class ImmutableMap<Key, Value> implements ReadonlyMap<Key, Value> {
  readonly #map: Map<Key, Value>;

  constructor(entries: Iterable<readonly [Key, Value]>) {
    this.#map = new Map(entries);
    Object.freeze(this);
  }

  get size(): number { return this.#map.size; }
  get(key: Key): Value | undefined { return this.#map.get(key); }
  has(key: Key): boolean { return this.#map.has(key); }
  entries(): MapIterator<[Key, Value]> { return this.#map.entries(); }
  keys(): MapIterator<Key> { return this.#map.keys(); }
  values(): MapIterator<Value> { return this.#map.values(); }
  forEach(callbackfn: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#map) callbackfn.call(thisArg, value, key, this);
  }
  [Symbol.iterator](): MapIterator<[Key, Value]> { return this.#map[Symbol.iterator](); }
}

function immutableMap<Key, Value>(entries: Iterable<readonly [Key, Value]>): ReadonlyMap<Key, Value> {
  return new ImmutableMap(entries);
}
