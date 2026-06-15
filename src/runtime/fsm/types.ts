export type EventMessage = {
  kind: 'event';
  name: string;
};

export type CallMessage = {
  kind: 'call';
  name: string;
  args?: unknown;
};

export type ActorMessage = EventMessage | CallMessage;

export type StateDefinition = {
  on?: Record<string, string>;
  enter?: string | false;
  leave?: string | false;
  recover?: string | false;
  calls?: Record<string, string | false>;
};

export type ActorDefinition = {
  initial?: string;
  sequence?: string[];
  states: Record<string, StateDefinition>;
};

export type CompiledActorDefinition = {
  initial: string;
  sequence: ReadonlyMap<string, number>;
  states: ReadonlyMap<string, StateDefinition>;
};

export type ActorInternals = {
  definition: CompiledActorDefinition;
  state: string;
  queue: import('./event-queue.js').AsyncActorQueue;
};
