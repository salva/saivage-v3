// BaseActor design and implementation are frozen except for the explicitly
// authorized in-memory lifecycle-settlement hook. Any further core change
// requires user approval.

import type { ActorDefinition, CompiledActorDefinition, CompiledStateDefinition } from './types.js';

export class InternalActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InternalActorError';
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class InvalidActorDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidActorDefinitionError';
  }
}

export type ActorClassWithDefinition = Function & {
  _actor?: ActorDefinition;
  _compiled_actor?: CompiledActorDefinition;
};

export type RunTaskOptions<Result = unknown> = {
  on_done?: (result: Result) => void;
  on_failed?: (error: Error) => void;
  on_timeout?: (error: TimeoutError) => void;
  on_done_event?: string;
  on_failed_event?: string;
  on_timeout_event?: string;
  timeout?: number;
};

type TaskResult<Result = unknown> = {
  id: number;
  ok: true;
  result: Result;
  timedOut?: false;
} | {
  id: number;
  ok: false;
  error: Error;
  timedOut?: boolean;
};

type Task<Result = unknown> = {
  id: number;
  controller: AbortController;
  promise: Promise<TaskResult<Result>>;
  on_done: (result: Result) => void;
  on_failed: (error: Error) => void;
  on_timeout?: (error: TimeoutError) => void;
};

export abstract class BaseActor {
  #definition: CompiledActorDefinition | undefined;
  #currentState: string | undefined;
  #nextEvent: { name: string; sequence: number } | undefined;
  #queuedEventSequence = 0;
  #settledEventSequence = 0;
  #eventSettlementFailure: { sequence: number; error: unknown } | undefined;
  #eventSettlementWaiters = new Set<{ sequence: number; resolve: () => void; reject: (error: unknown) => void }>();
  #nextTaskId = 1;
  #stateTasks = new Map<number, Task<any>>();
  #actorMainPromise: Promise<void> | undefined;
  #actorMainRunning = false;

  state(): string {
    return this.#currentState!;
  }

  start(): void {
    if (this.#currentState !== undefined && !this.#definition!.states.get(this.#currentState)?.terminal) {
      throw new InternalActorError(`Cannot start actor from non-terminal state "${this.#currentState}"`);
    }
    const definition = getCompiledActorDefinition(this.constructor as ActorClassWithDefinition);
    this.#definition = definition;
    const oldState = this.#currentState;
    this.#currentState = definition.initial;
    this._on_state_changed(oldState, this.#currentState);
    this.#callHandler('enter');
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
    if (!this.#definition!.states.get(currentState)?.parked) {
      throw new InternalActorError(`Cannot send parked event from non-parked state "${currentState}"`);
    }
    this.sendEvent(name);
    this.#ensureActorMain();
  }

  protected runTask<Result>(run: (signal: AbortSignal) => Promise<Result>, options?: RunTaskOptions<Result>): void {
    const currentState = this.#currentState!;
    if (this.#definition!.states.get(currentState)?.terminal) {
      throw new InternalActorError(`Cannot start task in terminal state "${currentState}"`);
    }
    if (this.#definition!.states.get(currentState)?.parked) {
      throw new InternalActorError(`Cannot start task in parked state "${currentState}"`);
    }
    const controller = new AbortController();
    const id = this.#nextTaskId++;
    const timeout = options?.timeout === 0 ? undefined : options?.timeout;
    const promise = this.#safeTask(id, run, controller, timeout);
    const on_done: (result: Result) => void = options?.on_done ?? (() => this.sendEvent(options?.on_done_event ?? 'done'));
    const on_failed = options?.on_failed ?? (() => this.sendEvent(options?.on_failed_event ?? 'failed'));
    const on_timeout = options?.on_timeout ?? (options?.on_timeout_event ? (() => this.sendEvent(options.on_timeout_event!)) : undefined);
    this.#stateTasks.set(id, { id, controller, promise, on_done, on_failed, on_timeout });
  }

  protected awaitLifecycleSettlement(): Promise<void> {
    const sequence = this.#queuedEventSequence;
    const failure = this.#eventSettlementFailure;
    if (failure && failure.sequence <= sequence) return Promise.reject(failure.error);
    if (this.#settledEventSequence >= sequence) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.#eventSettlementWaiters.add({ sequence, resolve, reject });
    });
  }

  protected _on_state_changed(_oldState: string | undefined, _newState: string): void {
  }

  #dispatchEvent(eventName: string): string {
    const currentState = this.#currentState!;
    const stateDef = this.#definition!.states.get(currentState)!;

    const targetState = stateDef.on[eventName];
    if (targetState === undefined) return currentState;

    if (targetState === currentState) return currentState;

    this.#callHandler('leave');
    for (const task of this.#stateTasks.values()) {
      task.controller.abort();
    }
    this.#stateTasks.clear();
    this.#currentState = targetState;
    this._on_state_changed(currentState, targetState);
    this.#callHandler('enter');

    return targetState;
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
          } catch (error) {
            this.#settledEventSequence = event.sequence;
            this.#eventSettlementFailure = { sequence: event.sequence, error };
            throw error;
          } finally {
            this.#settleLifecycleWaiters();
          }
          continue;
        }

        if (this.#definition!.states.get(this.#currentState!)?.terminal) {
          return;
        }

        if (this.#definition!.states.get(this.#currentState!)?.parked) {
          return;
        }

        if (this.#stateTasks.size === 0) {
          throw new InternalActorError(`Actor stuck in non-terminal state "${this.#currentState!}" with no pending tasks or events`);
        }

        const result = await Promise.race([...this.#stateTasks.values()].map((t) => t.promise));
        const task = this.#stateTasks.get(result.id)!;
        this.#stateTasks.delete(result.id);

        if (result.timedOut && task.on_timeout) {
          task.on_timeout(result.error as TimeoutError);
        } else if (result.ok) {
          task.on_done(result.result);
        } else {
          task.on_failed(result.error);
        }
      }
    } catch (error) {
      console.error('BaseActor main loop failed', error);
    } finally {
      this.#actorMainRunning = false;
    }
  }

  #settleLifecycleWaiters(): void {
    const failure = this.#eventSettlementFailure;
    for (const waiter of this.#eventSettlementWaiters) {
      if (waiter.sequence > this.#settledEventSequence) continue;
      this.#eventSettlementWaiters.delete(waiter);
      if (failure && failure.sequence <= waiter.sequence) waiter.reject(failure.error);
      else waiter.resolve();
    }
  }

  #ensureActorMain(): void {
    if (this.#actorMainRunning) return;
    this.#actorMainRunning = true;
    this.#actorMainPromise = this.#actorMain();
  }

  async #safeTask<Result>(taskId: number, run: (signal: AbortSignal) => Promise<Result>, controller: AbortController, timeout?: number): Promise<TaskResult<Result>> {
    try {
      const task = run(controller.signal);
      const result = timeout === undefined
        ? await task
        : await this.#withTimeout(task, controller, timeout);
      return { id: taskId, ok: true, result };
    } catch (error) {
      return { id: taskId, ok: false, error: error as Error, timedOut: error instanceof TimeoutError };
    }
  }

  async #withTimeout<T>(task: Promise<T>, controller: AbortController, timeout: number): Promise<T> {
    let timeoutError: TimeoutError | undefined;
    const timer = setTimeout(() => {
      timeoutError = new TimeoutError(`Task timed out after ${timeout}ms`);
      controller.abort(timeoutError);
    }, timeout);
    try {
      const value = await task;
      if (timeoutError) throw timeoutError;
      return value;
    } catch (error) {
      throw timeoutError ?? error;
    } finally {
      clearTimeout(timer);
    }
  }

  #callHandler(hook: 'enter' | 'leave'): boolean {
    const method = this.#getMethod(`_on_${hook}__${this.#currentState!}`);
    if (method) {
      method.call(this);
      return true;
    }
    return false;
  }

  #getMethod(methodName: string): Function | undefined {
    const value = (this as unknown as Record<string, unknown>)[methodName];
    return typeof value === 'function' ? value : undefined;
  }
}

export function getCompiledActorDefinition(ctor: ActorClassWithDefinition): CompiledActorDefinition {
  if (Object.hasOwn(ctor, '_compiled_actor') && ctor._compiled_actor) {
    return ctor._compiled_actor;
  }

  const definition = getActorDefinition(ctor);
  if (!definition) {
    throw new InvalidActorDefinitionError(
      `${ctor.name || '<anonymous>'} must provide static _actor`,
    );
  }

  const compiled = compileActorDefinition(definition);
  Object.defineProperty(ctor, '_compiled_actor', {
    value: compiled,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return compiled;
}

function getActorDefinition(ctor: ActorClassWithDefinition): ActorDefinition | undefined {
  let current: Function | null = ctor;
  while (current && current !== Function.prototype) {
    if (Object.hasOwn(current, '_actor')) {
      return (current as ActorClassWithDefinition)._actor;
    }
    current = Object.getPrototypeOf(current);
  }
  return undefined;
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

  if (definition.initial !== undefined && !(definition.initial in definition.states)) {
    throw new InvalidActorDefinitionError(
      `Initial state "${definition.initial}" does not exist in states`,
    );
  }

  if (definition.sequence) {
    const seen = new Set<string>();
    for (let i = 0; i < definition.sequence.length; i++) {
      const stateName = definition.sequence[i]!;
      if (seen.has(stateName)) {
        throw new InvalidActorDefinitionError(
          `State "${stateName}" appears more than once in sequence`,
        );
      }
      seen.add(stateName);
      if (!(stateName in definition.states)) {
        throw new InvalidActorDefinitionError(
          `Sequence state "${stateName}" does not exist in states`,
        );
      }
      if (definition.states[stateName]?.terminal) {
        throw new InvalidActorDefinitionError(
          `Terminal state "${stateName}" cannot be in a sequence`,
        );
      }
    }
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

    for (const [eventName, targetState] of Object.entries(stateDef.on ?? {})) {
      if (eventName === '') {
        throw new InvalidActorDefinitionError(
          `Event name must be non-empty in state "${stateName}"`,
        );
      }
      if (!(targetState in definition.states)) {
        throw new InvalidActorDefinitionError(
          `Transition target "${targetState}" in state "${stateName}" for event "${eventName}" does not exist in states`,
        );
      }
    }
  }

  const compiledStates = new Map<string, CompiledStateDefinition>();
  for (const [stateName, stateDef] of Object.entries(definition.states)) {
    const on: Record<string, string> = { ...(stateDef.on ?? {}) };

    if (definition.sequence) {
      const index = definition.sequence.indexOf(stateName);
      if (index >= 0 && index < definition.sequence.length - 1) {
        if (!('done' in on)) {
          on.done = definition.sequence[index + 1]!;
        }
      }
    }

    compiledStates.set(stateName, {
      on,
      terminal: stateDef.terminal,
      parked: stateDef.parked,
    });
  }

  return {
    initial: definition.initial ?? stateNames[0]!,
    states: compiledStates,
  };
}
