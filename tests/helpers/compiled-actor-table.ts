import type { CompiledActorState, CompiledActorTransition } from '../../src/runtime/micro-actor/index.js';

export type CompiledActorTable = Readonly<{ initial: string; states: ReadonlyMap<string, CompiledActorState> }>;

export function compiledActorTransition(targetStateId: string, reenter = false): CompiledActorTransition {
  return Object.freeze({ targetStateId, reenter });
}

export function compiledActorState(spec: { on?: Readonly<Record<string, CompiledActorTransition>>; terminal?: boolean; parked?: boolean } = {}): CompiledActorState {
  return Object.freeze({ on: Object.freeze(new Map(Object.entries(spec.on ?? {}))), isTerminal: spec.terminal === true, isParked: spec.parked === true });
}

export function compiledActorTable(initial: string, states: Readonly<Record<string, CompiledActorState>>): CompiledActorTable {
  return Object.freeze({ initial, states: new Map(Object.entries(states)) });
}
