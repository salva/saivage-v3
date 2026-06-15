import type { ActorDefinition } from './types.js';

const actorDefinitions = new WeakMap<Function, ActorDefinition>();

export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransitionError';
  }
}

export class InvalidActorDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidActorDefinitionError';
  }
}

export class MissingCallHandlerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingCallHandlerError';
  }
}

export function Actor(definition: ActorDefinition): ClassDecorator {
  validateActorDefinition(definition);

  return (ctor) => {
    actorDefinitions.set(ctor, definition);
  };
}

export function getActorDefinition(ctor: Function): ActorDefinition {
  const definition = actorDefinitions.get(ctor);
  if (!definition) {
    throw new InvalidActorDefinitionError(
      `Missing @Actor definition for ${ctor.name || '<anonymous>'}`,
    );
  }
  return definition;
}

export function initialState(definition: ActorDefinition): string {
  if (definition.initial !== undefined) {
    return definition.initial;
  }

  const first = Object.keys(definition.states)[0];
  if (!first) {
    throw new InvalidActorDefinitionError('Actor definition must declare at least one state');
  }
  return first;
}

function validateActorDefinition(definition: ActorDefinition): void {
  const states = Object.keys(definition.states);
  if (states.length === 0) {
    throw new InvalidActorDefinitionError('Actor definition must declare at least one state');
  }

  for (const stateName of states) {
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
    for (const stateName of definition.sequence) {
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
    }
  }

  for (const [stateName, stateDef] of Object.entries(definition.states)) {
    validateMethodOverride(stateDef.enter, `enter override in state "${stateName}"`);
    validateMethodOverride(stateDef.leave, `leave override in state "${stateName}"`);

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

    for (const [callName, methodName] of Object.entries(stateDef.calls ?? {})) {
      if (callName === '') {
        throw new InvalidActorDefinitionError(
          `Call name must be non-empty in state "${stateName}"`,
        );
      }
      validateMethodOverride(methodName, `call override "${callName}" in state "${stateName}"`);
    }
  }
}

function validateMethodOverride(value: string | false | undefined, label: string): void {
  if (value === undefined || value === false) return;
  if (value === '') {
    throw new InvalidActorDefinitionError(`${label} must be a non-empty method name or false`);
  }
}
