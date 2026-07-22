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

export type CompiledTransitionDefinition = {
  readonly target: string;
  readonly reenter: boolean;
};

export type CompiledStateDefinition = {
  readonly on: ReadonlyMap<string, CompiledTransitionDefinition>;
  readonly terminal?: boolean;
  readonly parked?: boolean;
};

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
