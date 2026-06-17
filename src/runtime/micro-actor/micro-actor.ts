import { getCompiledActorDefinition, InvalidTransitionError } from './define-machine.js';
import type { ActorDefinition, ActorInternals, CompiledActorDefinition } from './types.js';

export class InternalActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InternalActorError';
  }
}

export type ActorConstructor<T extends BaseActor = BaseActor> = (new (...args: any[]) => T) & {
  _actor: ActorDefinition;
  _compiled_actor?: CompiledActorDefinition;
};

export type ActorStateTask<Result = unknown> = {
  run(context: { signal: AbortSignal }): Promise<Result>;
  on_done?: (result: Result) => void;
  on_failed?: (error: unknown) => void;
};

type FinishedTask = {
  id: number;
  ok: boolean;
  value: unknown;
};

type ActiveStateTask<Result = unknown> = ActorStateTask<Result> & {
  id: number;
  controller: AbortController;
  finished: Promise<FinishedTask>;
};

export abstract class BaseActor {
  _definition: CompiledActorDefinition | undefined;
  _state: string | undefined;
  _nextEvent: string | undefined;
  _nextTaskId = 1;
  _stateTasks = new Map<number, ActiveStateTask>();
  _actorMainPromise: Promise<void> | undefined;

  state(): string {
    return this._state!;
  }

  protected _send_event(name: string): void {
    if (this._nextEvent !== undefined) {
      throw new InternalActorError(`Actor already has pending event "${this._nextEvent}", cannot send "${name}"`);
    }
    this._nextEvent = name;
  }

  protected _start_task<Result>(task: ActorStateTask<Result>): void {
    const currentState = this._state!;
    if (this._definition!.states.get(currentState)?.terminal) {
      throw new InternalActorError(`Cannot start task in terminal state "${currentState}"`);
    }
    const controller = new AbortController();
    const id = this._nextTaskId++;
    const finished = runTask(id, task, controller);
    this._stateTasks.set(id, { ...task, id, controller, finished } as ActiveStateTask);
  }

  protected _start_actor_task<Result>(task: ActorStateTask<Result>): void {
    this._start_task(task);
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
    tryMethod(actor, `_on_enter__${state}`);
  }

  (actor as BaseActor & { _startMailboxPumpForRuntime?: () => void })._startMailboxPumpForRuntime?.();
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

  tryMethod(actor, `_on_leave__${currentState}`);
  for (const task of actor._stateTasks.values()) {
    task.controller.abort();
  }
  actor._stateTasks.clear();
  actor._state = targetState;
  tryMethod(actor, `_on_enter__${targetState}`);
  (actor as BaseActor & { _restartOnStateChange?: () => void })._restartOnStateChange?.();

  return targetState;
}

export function dispatchRecover(actor: BaseActor): void {
  const currentState = actor._state!;
  const stateDef = actor._definition!.states.get(currentState);

  if (!stateDef) {
    throw new InvalidTransitionError(`Unknown current state "${currentState}"`);
  }

  const recoverMethod = getMethod(actor, `_on_recover__${currentState}`);
  if (recoverMethod) {
    recoverMethod.call(actor);
    return;
  }

  tryMethod(actor, `_on_enter__${currentState}`);
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
      const state = actor._state!;
      actor._state = 'failed';
      throw new InternalActorError(
        `Actor stuck in non-terminal state "${state}" with no pending tasks or events`,
      );
    }

    const finished = await Promise.race([...actor._stateTasks.values()].map((t) => t.finished));
    const task = actor._stateTasks.get(finished.id);
    if (!task) continue;
    actor._stateTasks.delete(finished.id);
    if (task.controller.signal.aborted) {
      task.on_failed?.(null);
    } else {
      finished.ok ? task.on_done?.(finished.value) : task.on_failed?.(finished.value);
    }
  }
}

async function runTask<Result>(taskId: number, task: ActorStateTask<Result>, controller: AbortController): Promise<FinishedTask> {
  try {
    const value = await task.run({ signal: controller.signal });
    return { id: taskId, ok: true, value };
  } catch (value) {
    return { id: taskId, ok: false, value };
  }
}

function tryMethod(actor: BaseActor, methodName: string): void {
  const method = getMethod(actor, methodName);
  if (method) method.call(actor);
}

function getMethod(actor: BaseActor, methodName: string): Function | undefined {
  const value = (actor as unknown as Record<string, unknown>)[methodName];
  return typeof value === 'function' ? value : undefined;
}