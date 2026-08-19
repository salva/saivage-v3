export type CompiledActorTransition = {
  readonly targetStateId: string;
  readonly reenter: boolean;
};

export type CompiledActorState<Transition extends CompiledActorTransition = CompiledActorTransition> = {
  readonly on: ReadonlyMap<string, Transition>;
  readonly isTerminal: boolean;
  readonly isParked: boolean;
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
