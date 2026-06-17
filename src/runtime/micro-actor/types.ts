export type MailboxCommand = {
  kind: 'call';
  name: string;
  args?: unknown;
};

export type StateDefinition = {
  on?: Record<string, string>;
  enter?: string | false;
  leave?: string | false;
  terminal?: boolean;
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
};
