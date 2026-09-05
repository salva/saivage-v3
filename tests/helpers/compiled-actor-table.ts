type ActorTransition = Readonly<{
  targetStateId: string;
  reenter: boolean;
}>;

type ActorState = Readonly<{
  on: ReadonlyMap<string, ActorTransition>;
  isTerminal: boolean;
  isParked: boolean;
}>;

export type CompiledActorTable = Readonly<{ initial: string; states: ReadonlyMap<string, ActorState> }>;

export function compiledActorTransition(targetStateId: string, reenter = false): ActorTransition {
  return Object.freeze({ targetStateId, reenter });
}

export function compiledActorState(spec: { on?: Readonly<Record<string, ActorTransition>>; terminal?: boolean; parked?: boolean } = {}): ActorState {
  return Object.freeze({ on: Object.freeze(new Map(Object.entries(spec.on ?? {}))), isTerminal: spec.terminal === true, isParked: spec.parked === true });
}

export function compiledActorTable(initial: string, states: Readonly<Record<string, ActorState>>): CompiledActorTable {
  return Object.freeze({ initial, states: new Map(Object.entries(states)) });
}
