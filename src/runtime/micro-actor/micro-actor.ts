import { getCompiledActorDefinition, InvalidTransitionError } from './define-machine.js';
import type { ActorDefinition, ActorInternals, CompiledActorDefinition } from './types.js';

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

export type ActorConstructor<T extends BaseActor = BaseActor> = (new (...args: any[]) => T) & {
  _actor: ActorDefinition;
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

type TaskResult = {
  id: number;
  ok: boolean;
  value: unknown;
  timedOut?: boolean;
};

type Task = {
  id: number;
  controller: AbortController;
  promise: Promise<TaskResult>;
  on_done: (result: unknown) => void;
  on_failed: (error: Error) => void;
  on_timeout?: (error: TimeoutError) => void;
};

export abstract class BaseActor {
  _definition: CompiledActorDefinition | undefined;
  _state: string | undefined;
  _nextEvent: string | undefined;
  _nextTaskId = 1;
  _stateTasks = new Map<number, Task>();
  _actorMainPromise: Promise<void> | undefined;
  _wakeResolve: (() => void) | undefined;

  state(): string {
    return this._state!;
  }

  _wake(): void {
    this._wakeResolve?.();
    this._wakeResolve = undefined;
  }

  _send_event(name: string): void {
    if (this._nextEvent !== undefined) {
      throw new InternalActorError(`Actor already has pending event "${this._nextEvent}", cannot send "${name}"`);
    }
    this._nextEvent = name;
    this._wake();
  }

  protected _run_task<Result>(run: (signal: AbortSignal) => Promise<Result>, options?: RunTaskOptions<Result>): AbortController {
    const currentState = this._state!;
    if (this._definition!.states.get(currentState)?.terminal) {
      throw new InternalActorError(`Cannot start task in terminal state "${currentState}"`);
    }
    const controller = new AbortController();
    const id = this._nextTaskId++;
    const promise = safeTask(id, run, controller, options?.timeout);
    const on_done = options?.on_done ?? (() => this._send_event(options?.on_done_event ?? 'done'));
    const on_failed = options?.on_failed ?? (() => this._send_event(options?.on_failed_event ?? 'failed'));
    const on_timeout = options?.on_timeout ?? (options?.on_timeout_event ? (() => this._send_event(options.on_timeout_event!)) : undefined);
    this._stateTasks.set(id, { id, controller, promise, on_done: on_done as Task['on_done'], on_failed: on_failed as Task['on_failed'], on_timeout });
    this._wake();
    return controller;
  }

  _installActorInternals(internals: ActorInternals): void {
    this._definition = internals.definition;
    this._state = internals.state;
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

  actor._installActorInternals({ definition, state });

  if (afterInstall) {
    afterInstall(actor);
  } else {
    callHandler(actor, 'enter');
  }

  actor._actorMainPromise = actorMain(actor);

  return actor;
}

export function dispatchEvent(actor: BaseActor, eventName: string): string {
  const definition = actor._definition!;
  const currentState = actor._state!;
  const stateDef = definition.states.get(currentState);

  if (!stateDef) {
    throw new InvalidTransitionError(`Unknown current state "${currentState}"`);
  }

  let targetState: string | undefined = stateDef.on?.[eventName];

  if (targetState === undefined && eventName === 'done' && definition.sequence.has(currentState)) {
    const sequenceList = Array.from(definition.sequence.keys());
    const index = definition.sequence.get(currentState)!;
    if (index < sequenceList.length - 1) {
      targetState = sequenceList[index + 1];
    }
  }

  if (targetState === undefined) return currentState;

  if (!definition.states.has(targetState)) {
    throw new InvalidTransitionError(
      `Invalid target state "${targetState}" for event "${eventName}" in state "${currentState}"`,
    );
  }

  if (targetState === currentState) return currentState;

  callHandler(actor, 'leave');
  for (const task of actor._stateTasks.values()) {
    task.controller.abort();
  }
  actor._stateTasks.clear();
  actor._state = targetState;
  callHandler(actor, 'enter');
  actor._wake();

  return targetState;
}

export function dispatchRecover(actor: BaseActor): void {
  const currentState = actor._state!;
  const stateDef = actor._definition!.states.get(currentState);

  if (!stateDef) {
    throw new InvalidTransitionError(`Unknown current state "${currentState}"`);
  }

  callHandler(actor, 'recover') || callHandler(actor, 'enter');
}

async function actorMain(actor: BaseActor): Promise<void> {
  for (;;) {
    const event = actor._nextEvent;
    if (event !== undefined) {
      actor._nextEvent = undefined;
      dispatchEvent(actor, event);
      continue;
    }

    if (actor._definition!.states.get(actor._state!)?.terminal) {
      return;
    }

    if (actor._stateTasks.size === 0) {
      await new Promise<void>((resolve) => { actor._wakeResolve = resolve; });
      continue;
    }

    const wakePromise = new Promise<void>((resolve) => { actor._wakeResolve = resolve; });
    const taskPromises = [...actor._stateTasks.values()].map((t) => t.promise);
    const result = await Promise.race([wakePromise.then(() => null), ...taskPromises]);
    if (result === null) continue;
    const task = actor._stateTasks.get(result.id);
    actor._stateTasks.delete(result.id);
    if (!task) continue;

    if (result.timedOut && task.on_timeout) {
      task.on_timeout(result.value as TimeoutError);
    } else if (result.ok) {
      task.on_done(result.value);
    } else {
      task.on_failed(result.value as Error);
    }
  }
}

async function safeTask(taskId: number, run: (signal: AbortSignal) => Promise<unknown>, controller: AbortController, timeout?: number): Promise<TaskResult> {
  if (timeout !== undefined && timeout > 0) {
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new TimeoutError(`Task timed out after ${timeout}ms`));
        reject(new TimeoutError(`Task timed out after ${timeout}ms`));
      }, timeout);
    });
    try {
      const value = await Promise.race([run(controller.signal), timeoutPromise]);
      clearTimeout(timer!);
      return { id: taskId, ok: true, value };
    } catch (error) {
      clearTimeout(timer!);
      return { id: taskId, ok: false, value: error, timedOut: error instanceof TimeoutError };
    }
  }
  try {
    const value = await run(controller.signal);
    return { id: taskId, ok: true, value };
  } catch (error) {
    return { id: taskId, ok: false, value: error };
  }
}

function callHandler(actor: BaseActor, hook: 'enter' | 'leave' | 'recover'): boolean {
  const method = getMethod(actor, `_on_${hook}__${actor._state!}`);
  if (method) {
    method.call(actor);
    return true;
  }
  return false;
}

function getMethod(actor: BaseActor, methodName: string): Function | undefined {
  const value = (actor as unknown as Record<string, unknown>)[methodName];
  return typeof value === 'function' ? value : undefined;
}