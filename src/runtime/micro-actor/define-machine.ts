import type { ActorDefinition, CompiledActorDefinition, StateDefinition } from './types.js';

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

export type ActorClassWithDefinition = Function & {
  _actor?: ActorDefinition;
  _allow_inherited_actor?: boolean;
  _compiled_actor?: CompiledActorDefinition;
};

export function getCompiledActorDefinition(ctor: ActorClassWithDefinition): CompiledActorDefinition {
  if (!Object.hasOwn(ctor, '_actor') && !ctor._allow_inherited_actor) {
    throw new InvalidActorDefinitionError(
      `${ctor.name || '<anonymous>'} must declare static _actor`,
    );
  }

  if (ctor._compiled_actor) {
    return ctor._compiled_actor;
  }

  const definition = ctor._actor;
  if (!definition) {
    throw new InvalidActorDefinitionError(
      `${ctor.name || '<anonymous>'} static _actor is missing`,
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

export function compileActorDefinition(definition: ActorDefinition): CompiledActorDefinition {
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

  return {
    initial: definition.initial ?? states[0]!,
    sequence: compileSequence(definition.sequence),
    states: new Map<string, StateDefinition>(Object.entries(definition.states)),
  };
}

function compileSequence(sequence: string[] | undefined): ReadonlyMap<string, number> {
  const compiled = new Map<string, number>();
  if (!sequence) return compiled;
  for (let i = 0; i < sequence.length; i++) {
    compiled.set(sequence[i]!, i);
  }
  return compiled;
}