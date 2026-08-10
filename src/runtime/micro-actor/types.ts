export type TransitionDefinition =
  | string
  | { readonly target: string; readonly reenter?: boolean };

export type StateDefinition = {
  readonly on?: Readonly<Record<string, TransitionDefinition>>;
  readonly terminal?: boolean;
  readonly parked?: boolean;
};

export type ActorDefinition = {
  readonly initial: string;
  readonly states: Readonly<Record<string, StateDefinition>>;
};

export type CompiledActorTransition = {
  readonly targetStateId: string;
  readonly reenter: boolean;
};

export type CompiledTransitionDefinition = CompiledActorTransition;

export type CompiledActorState<Transition extends CompiledActorTransition = CompiledActorTransition> = {
  readonly on: ReadonlyMap<string, Transition>;
  readonly isTerminal: boolean;
  readonly isParked: boolean;
};

export type CompiledStateDefinition = CompiledActorState<CompiledTransitionDefinition>;

export type CompiledActorDefinition = {
  readonly initial: string;
  readonly states: ReadonlyMap<string, CompiledStateDefinition>;
};

export type ActorStartContext = Readonly<{
  source: null;
  event: null;
  target: string;
}>;

export type ActorTransitionContext = Readonly<{
  source: string;
  event: string;
  target: string;
  reentered: boolean;
}>;

export type ActorLifecycleContext = ActorStartContext | ActorTransitionContext;
