export type Event = { name: string; args?: Record<string, unknown> };

export type Command = { type: string; [key: string]: unknown };

export type HandlerResult<State extends string, Cmd extends Command> = {
  state?: State;
  commands?: Cmd[];
};

export type MachineRef = {
  machine: string;
  id: string;
};

export type MachineSelf<State extends string> = {
  _sm: {
    state: State;
    ref?: MachineRef;
  };
  state(): State;
  send(name: string, args?: Record<string, unknown>): void;
};

export type Handler<State extends string, Self extends MachineSelf<State>, Cmd extends Command> =
  (input: {
    self: Self;
    event: Event;
  }) => HandlerResult<State, Cmd>;

export type LeaveHook<State extends string, Self extends MachineSelf<State>, Cmd extends Command> =
  (self: Self) => { commands?: Cmd[] } | void;

export type StateDefinition<State extends string, Self extends MachineSelf<State>, Cmd extends Command> = {
  on_leave?: LeaveHook<State, Self, Cmd>;
  on_enter?: Handler<State, Self, Cmd>;
  on?: Record<string, State | Handler<State, Self, Cmd>>;
};

export type MachineDefinition<State extends string, Self extends MachineSelf<State>, Cmd extends Command> = {
  initial: State;
  sequence?: State[];
  states: Record<State, StateDefinition<State, Self, Cmd>>;
};

export type DispatchResult<State extends string, Cmd extends Command> = {
  state: State;
  commands: Cmd[];
};

export type CompiledMachine<State extends string, Self extends MachineSelf<State>, Cmd extends Command> = {
  readonly initial: State;
  readonly sequence: ReadonlyMap<State, number>;
  readonly stateDefinitions: ReadonlyMap<State, StateDefinition<State, Self, Cmd>>;
};