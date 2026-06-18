export type MailboxCommand = {
  kind: 'call';
  name: string;
  args?: unknown;
};

export type StateDefinition = {
  on?: Record<string, string>;
  terminal?: boolean;
};

export type ActorDefinition = {
  initial?: string;
  sequence?: string[];
  states: Record<string, StateDefinition>;
};

export type CompiledActorDefinition = {
  initial: string;
  states: ReadonlyMap<string, StateDefinition>;
};

export type ActorInternals = {
  definition: CompiledActorDefinition;
  state: string;
};