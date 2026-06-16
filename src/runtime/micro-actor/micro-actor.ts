import { getCompiledActorDefinition } from './define-machine.js';
import { InvalidTransitionError, MissingCallHandlerError } from './define-machine.js';
import type { ActorDefinition, ActorInternals, CompiledActorDefinition, MailboxCommand, StateDefinition } from './types.js';

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
  _definition: CompiledActorDefinition | undefined;
  _state: string | undefined;
  _nextEvent: string | undefined;
  _nextTaskId = 1;
  _stateTasks = new Map<number, ActiveStateTask>();

  state(): string {
    return this._state!;
  }

  // Internal event emission. This records the one event the current actor turn
  // should process next; it is not an event queue.
  protected _send_event(name: string): void {
    if (this._nextEvent !== undefined) {
      throw new InternalActorError(`Actor already has pending event "${this._nextEvent}", cannot send "${name}"`);
    }
    this._nextEvent = name;
  }

  protected _start_task<Result>(task: ActorStateTask<Result>): void {
    const state = this._state!;
    const controller = new AbortController();
    const id = this._nextTaskId++;
    this._stateTasks.set(id, { ...task, id, state, controller } as ActiveStateTask);

    Promise.resolve()
      .then(() => task.run({ signal: controller.signal }))
      .then((result) => {
        runActorTurn(this, () => completeTask(this, id, 'done', result));
      })
      .catch((error) => {
        runActorTurn(this, () => completeTask(this, id, 'failed', error));
      });
  }

  // Runtime-only installation hook. Actor constructors run before private runtime
  // slots exist, so startActor/recoverActor installs these slots immediately after
  // construction.
  _installActorInternals(internals: ActorInternals): void {
    if (this._definition !== undefined || this._state !== undefined) {
      throw new Error('Actor internals already installed');
    }
    this._definition = internals.definition;
    this._state = internals.state;
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
    runActorTurn(actor, () => afterInstall(actor));
  }
  startOptionalMailboxPump(actor);

  return actor;
}

function startOptionalMailboxPump(actor: BaseActor): void {
  const maybeMailboxActor = actor as BaseActor & { _startMailboxPumpForRuntime?: () => void };
  maybeMailboxActor._startMailboxPumpForRuntime?.();
}

export function runActorTurn(actor: BaseActor, run: () => void): void {
  const result = run() as unknown;
  if (isPromiseLike(result)) {
    void Promise.resolve(result).catch(() => undefined);
    throw new InternalActorError('Actor turn work must be synchronous');
  }
  drainActorEvents(actor);
}

export function dispatchEvent(actor: BaseActor, eventName: string): string {
  const definition = actor._definition!;
  const currentState = actor._state!;
  const stateDef = definition.states.get(currentState);

  if (!stateDef) {
    throw new InvalidTransitionError(`Unknown current state "${currentState}"`);
  }

  const targetState = stateDef.on?.[eventName]
    ?? implicitDoneTarget(definition.sequence, currentState, eventName);

  if (targetState === undefined) {
    return currentState;
  }

  if (!definition.states.has(targetState)) {
    throw new InvalidTransitionError(
      `Invalid target state "${targetState}" for event "${eventName}" in state "${currentState}"`,
    );
  }

  if (targetState === currentState) {
    return currentState;
  }

  callOptionalHook(actor, stateDef, 'leave', `_on_leave__${currentState}`);
  cancelTasksForState(actor, currentState);
  actor._state = targetState;
  callOptionalHook(actor, definition.states.get(targetState)!, 'enter', `_on_enter__${targetState}`);

  return targetState;
}

export function dispatchCall(actor: BaseActor, call: MailboxCommand): void {
  const currentState = actor._state!;
  const stateDef = actor._definition!.states.get(currentState);

  if (!stateDef) {
    throw new InvalidTransitionError(`Unknown current state "${currentState}"`);
  }

  const override = stateDef.calls?.[call.name];
  if (override === false) {
    return;
  }

  const methodName = override ?? `_on_call__${currentState}__${call.name}`;
  const method = methodFromActor(actor, methodName);
  if (!method) {
    throw new MissingCallHandlerError(
      `Missing call handler "${methodName}" for call "${call.name}" in state "${currentState}"`,
    );
  }

  assertSyncResult(method.call(actor, call.args), methodName);
}

export function dispatchRecover(actor: BaseActor): void {
  const currentState = actor._state!;
  const stateDef = actor._definition!.states.get(currentState);

  if (!stateDef) {
    throw new InvalidTransitionError(`Unknown current state "${currentState}"`);
  }

  const recoverName = `_on_recover__${currentState}`;
  const recoverMethod = methodFromActor(actor, recoverName);
  if (recoverMethod) {
    assertSyncResult(recoverMethod.call(actor), recoverName);
    return;
  }

  callOptionalHook(actor, stateDef, 'enter', `_on_enter__${currentState}`);
}

function drainActorEvents(actor: BaseActor): void {
  for (let i = 0; i < 100; i++) {
    const event = actor._nextEvent;
    actor._nextEvent = undefined;
    if (event === undefined) return;
    dispatchEvent(actor, event);
  }
  throw new InternalActorError('Actor produced too many internal events in one turn');
}

function completeTask(actor: BaseActor, id: number, status: 'done' | 'failed', value: unknown): void {
  const task = actor._stateTasks.get(id);
  if (!task) return;
  actor._stateTasks.delete(id);
  if (task.controller.signal.aborted || task.state !== actor._state) return;

  const result = status === 'done'
    ? task.on_done?.(value)
    : task.on_failed?.(value);
  if (isPromiseLike(result)) {
    throw new InternalActorError(`State task ${status} handler must be synchronous`);
  }
}

function cancelTasksForState(actor: BaseActor, state: string): void {
  for (const [id, task] of actor._stateTasks) {
    if (task.state !== state) continue;
    actor._stateTasks.delete(id);
    task.controller.abort();
  }
}

function callOptionalHook(
  actor: BaseActor,
  stateDef: StateDefinition,
  hook: 'enter' | 'leave',
  conventionName: string,
): void {
  const override = stateDef[hook];
  if (override === false) {
    return;
  }

  const methodName = override ?? conventionName;
  const method = methodFromActor(actor, methodName);
  if (!method) {
    return;
  }

  assertSyncResult(method.call(actor), methodName);
}

function implicitDoneTarget(
  sequence: ReadonlyMap<string, number>,
  currentState: string,
  eventName: string,
): string | undefined {
  if (eventName !== 'done' || !sequence.has(currentState)) {
    return undefined;
  }

  const index = sequence.get(currentState)!;
  const sequenceList = Array.from(sequence.keys());
  if (index >= sequenceList.length - 1) {
    return undefined;
  }

  return sequenceList[index + 1];
}

function methodFromActor(actor: BaseActor, methodName: string): Function | undefined {
  const value = (actor as unknown as Record<string, unknown>)[methodName];
  return typeof value === 'function' ? value : undefined;
}

function assertSyncResult(value: unknown, label: string): void {
  if (isPromiseLike(value)) {
    throw new InvalidTransitionError(`${label} must be synchronous`);
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object'
    && value !== null
    && 'then' in value
    && typeof (value as { then?: unknown }).then === 'function';
}
