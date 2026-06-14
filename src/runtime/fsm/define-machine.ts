import type {
  Command,
  CompiledMachine,
  MachineDefinition,
  MachineSelf,
  StateDefinition,
} from './types.js';

export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransitionError';
  }
}

export class InvalidMachineDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMachineDefinitionError';
  }
}

export function defineMachine<State extends string, Self extends MachineSelf<State>, Cmd extends Command>(
  definition: MachineDefinition<State, Self, Cmd>,
): CompiledMachine<State, Self, Cmd> {
  const { initial, sequence: sequenceList, states } = definition;

  if (!(initial in states)) {
    throw new InvalidMachineDefinitionError(
      `Initial state "${initial}" does not exist in states`,
    );
  }

  const sequenceMap = new Map<State, number>();
  if (sequenceList) {
    const seen = new Set<State>();
    for (let i = 0; i < sequenceList.length; i++) {
      const s = sequenceList[i];
      if (seen.has(s)) {
        throw new InvalidMachineDefinitionError(
          `State "${s}" appears more than once in sequence`,
        );
      }
      seen.add(s);
      if (!(s in states)) {
        throw new InvalidMachineDefinitionError(
          `Sequence state "${s}" does not exist in states`,
        );
      }
      sequenceMap.set(s, i);
    }
  }

  const stateDefinitions = new Map<State, StateDefinition<State, Self, Cmd>>();
  const stateEntries = Object.entries<StateDefinition<State, Self, Cmd>>(
    states as Record<string, StateDefinition<State, Self, Cmd>>,
  );
  for (const [stateName, stateDef] of stateEntries) {
    if (stateDef.on) {
      for (const [eventName, entry] of Object.entries(stateDef.on)) {
        if (eventName === '') {
          throw new InvalidMachineDefinitionError(
            `Event name must be non-empty in state "${stateName}"`,
          );
        }
        if (typeof entry === 'string') {
          if (!(entry in states)) {
            throw new InvalidMachineDefinitionError(
              `Transition target "${entry}" in state "${stateName}" for event "${eventName}" does not exist in states`,
            );
          }
        }
      }
    }
    stateDefinitions.set(stateName as State, stateDef);
  }

  return {
    initial,
    sequence: sequenceMap,
    stateDefinitions,
  };
}