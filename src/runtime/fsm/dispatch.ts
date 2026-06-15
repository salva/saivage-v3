import type { CallMessage, EventMessage, StateDefinition } from './types.js';
import { InvalidTransitionError, MissingCallHandlerError } from './define-machine.js';
import type { BaseActor } from './base-actor.js';

export function dispatchEvent(actor: BaseActor, event: EventMessage): string {
  const definition = actor._actorDefinitionForRuntime();
  const currentState = actor._stateForRuntime();
  const stateDef = definition.states.get(currentState);

  if (!stateDef) {
    throw new InvalidTransitionError(`Unknown current state "${currentState}"`);
  }

  const targetState = stateDef.on?.[event.name]
    ?? implicitDoneTarget(definition.sequence, currentState, event.name);

  if (targetState === undefined) {
    return currentState;
  }

  if (!definition.states.has(targetState)) {
    throw new InvalidTransitionError(
      `Invalid target state "${targetState}" for event "${event.name}" in state "${currentState}"`,
    );
  }

  if (targetState === currentState) {
    return currentState;
  }

  callOptionalHook(actor, stateDef, 'leave', `_on_leave__${currentState}`);
  actor._setStateForRuntime(targetState);
  callOptionalHook(actor, definition.states.get(targetState)!, 'enter', `_on_enter__${targetState}`);

  return targetState;
}

export function dispatchCall(actor: BaseActor, call: CallMessage): void {
  const definition = actor._actorDefinitionForRuntime();
  const currentState = actor._stateForRuntime();
  const stateDef = definition.states.get(currentState);

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
  const definition = actor._actorDefinitionForRuntime();
  const currentState = actor._stateForRuntime();
  const stateDef = definition.states.get(currentState);

  if (!stateDef) {
    throw new InvalidTransitionError(`Unknown current state "${currentState}"`);
  }

  const recoverOverride = stateDef.recover;
  if (recoverOverride === false) {
    return;
  }

  const recoverName = recoverOverride ?? `_on_recover__${currentState}`;
  const recoverMethod = methodFromActor(actor, recoverName);
  if (recoverMethod) {
    assertSyncResult(recoverMethod.call(actor), recoverName);
    return;
  }

  callOptionalHook(actor, stateDef, 'enter', `_on_enter__${currentState}`);
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
  if (typeof value === 'object'
    && value !== null
    && 'then' in value
    && typeof (value as { then?: unknown }).then === 'function') {
    throw new InvalidTransitionError(`${label} must be synchronous`);
  }
}
