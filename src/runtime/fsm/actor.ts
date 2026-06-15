import { dispatch } from './dispatch.js';
import { AsyncEventQueue, runEventPump } from './event-queue.js';
import type { Command, CompiledMachine, Event, MachineSelf } from './types.js';

export type Actor<State extends string, Fields extends object, Cmd extends Command> =
  MachineSelf<State> & Fields & {
    readonly _queue: AsyncEventQueue;
  };

export type ActorCommandHandler<State extends string, Fields extends object, Cmd extends Command> = (
  commands: Cmd[],
  actor: Actor<State, Fields, Cmd>,
  event: Event,
) => void;

export type ActorErrorHandler<State extends string, Fields extends object, Cmd extends Command> = (
  error: unknown,
  actor: Actor<State, Fields, Cmd>,
  event: Event,
) => void;

export type CreateActorInput<State extends string, Fields extends object, Cmd extends Command> = {
  machine: CompiledMachine<State, MachineSelf<State> & Fields, Cmd>;
  fields: Fields;
  onCommands: ActorCommandHandler<State, Fields, Cmd>;
  onError: ActorErrorHandler<State, Fields, Cmd>;
};

export function createActor<State extends string, Fields extends object, Cmd extends Command>(
  input: CreateActorInput<State, Fields, Cmd>,
): Actor<State, Fields, Cmd> {
  const queue = new AsyncEventQueue();
  const actor = input.fields as Actor<State, Fields, Cmd>;

  Object.defineProperty(actor, '_queue', {
    value: queue,
    enumerable: false,
  });

  actor._sm = { state: input.machine.initial };
  actor.state = function state() { return this._sm.state; };
  actor.send = (name, args) => {
    queue.push(args === undefined ? { name } : { name, args });
  };

  void runEventPump(
    queue,
    (event) => {
      const result = dispatch(input.machine, actor, event);
      input.onCommands(result.commands, actor, event);
    },
    (error, event) => { input.onError(error, actor, event); },
  );

  return actor;
}
