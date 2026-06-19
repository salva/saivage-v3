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

export type CompiledStateDefinition = {
  on: Readonly<Record<string, string>>;
  terminal?: boolean;
};

export type CompiledActorDefinition = {
  initial: string;
  states: ReadonlyMap<string, CompiledStateDefinition>;
};
