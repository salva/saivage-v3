import type { Command, CompiledMachine, DispatchResult, Event, MachineSelf } from './types.js';
import { InvalidTransitionError } from './define-machine.js';

export function dispatch<State extends string, Self extends MachineSelf<State>, Cmd extends Command>(
  machine: CompiledMachine<State, Self, Cmd>,
  self: Self,
  event: Event,
): DispatchResult<State, Cmd> {
  const currentState = self._sm.state;

  const stateDef = machine.stateDefinitions.get(currentState);
  if (!stateDef) {
    throw new InvalidTransitionError(
      `Unknown current state "${String(currentState)}"`,
    );
  }

  const handler = stateDef.on?.[event.name];

  if (handler === undefined) {
    if (event.name === 'done' && machine.sequence.has(currentState)) {
      const idx = machine.sequence.get(currentState)!;
      const sequenceList = Array.from(machine.sequence.keys());
      if (idx < sequenceList.length - 1) {
        const nextState = sequenceList[idx + 1];
        return transition<State, Self, Cmd>(machine, self, currentState, nextState, event);
      }
    }
    return { state: currentState, commands: [] };
  }

  if (typeof handler === 'string') {
    return transition<State, Self, Cmd>(machine, self, currentState, handler, event);
  }

  const result = handler({ self, event }) ?? {};
  const targetState = 'state' in result ? (result.state as State | undefined) : undefined;
  const handlerCommands = result.commands ?? [];

  if (targetState === undefined || targetState === currentState) {
    self._sm.state = currentState;
    return { state: currentState, commands: handlerCommands };
  }

  const targetDef = machine.stateDefinitions.get(targetState);
  if (!targetDef) {
    throw new InvalidTransitionError(
      `Invalid target state "${String(targetState)}" for event "${event.name}" in state "${String(currentState)}"`,
    );
  }

  const leaveResult = stateDef.on_leave?.(self);
  const leaveCmds = leaveResult?.commands ?? [];

  self._sm.state = targetState;

  const enterResult = targetDef.on_enter?.({ self, event }) ?? {};
  const enterCmds = enterResult.commands ?? [];

  return {
    state: targetState,
    commands: [...leaveCmds, ...handlerCommands, ...enterCmds],
  };
}

function transition<State extends string, Self extends MachineSelf<State>, Cmd extends Command>(
  machine: CompiledMachine<State, Self, Cmd>,
  self: Self,
  fromState: State,
  toState: State,
  event: Event,
): DispatchResult<State, Cmd> {
  const fromDef = machine.stateDefinitions.get(fromState);
  const toDef = machine.stateDefinitions.get(toState);

  if (!toDef) {
    throw new InvalidTransitionError(
      `Invalid target state "${String(toState)}" for event "${event.name}" in state "${String(fromState)}"`,
    );
  }

  const leaveResult = fromDef?.on_leave?.(self);
  const leaveCmds = leaveResult?.commands ?? [];

  self._sm.state = toState;

  const enterResult = toDef.on_enter?.({ self, event }) ?? {};
  const enterCmds = enterResult.commands ?? [];

  return {
    state: toState,
    commands: [...leaveCmds, ...enterCmds],
  };
}