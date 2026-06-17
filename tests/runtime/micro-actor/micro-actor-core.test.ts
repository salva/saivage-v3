import { describe, it, expect } from '@jest/globals';
import {
  BaseActor,
  compileActorDefinition,
  InvalidActorDefinitionError,
  InvalidTransitionError,
  InternalActorError,
  startActor,
} from '../../../src/runtime/micro-actor/index.js';
import { dispatchEvent, getCompiledActorDefinition } from '../../../src/runtime/micro-actor/index.js';
import type { ActorDefinition, ActorConstructor, CompiledActorDefinition } from '../../../src/runtime/micro-actor/index.js';

function setupActor<T extends BaseActor>(ctor: ActorConstructor<T>): T {
  const definition = getCompiledActorDefinition(ctor);
  const actor = new ctor();
  actor._installActorInternals({ definition, state: definition.initial });
  return actor;
}

class LightActor extends BaseActor {
  static _actor: ActorDefinition = {
    initial: 'off',
    states: {
      off: { on: { toggle: 'on' } },
      on: { on: { toggle: 'off', flicker: 'broken' } },
      broken: { on: { replace: 'off' } },
    },
  };
  static _compiled_actor?: CompiledActorDefinition;

  flickerCount = 0;
  log: string[] = [];

  _on_enter__on() {
    this.log.push(`entered on, state now ${this.state()}`);
  }

  _on_enter__broken() {
    this.flickerCount += 1;
  }

  _on_leave__broken() {
    this.log.push(`leaving broken after ${this.flickerCount} flickers`);
  }
}

describe('actor definition compilation', () => {
  it('compiles actor definitions lazily per class', () => {
    const ctor = LightActor as typeof LightActor & { _compiled_actor?: CompiledActorDefinition };
    delete ctor._compiled_actor;
    expect(ctor._compiled_actor).toBeUndefined();
    const actor = setupActor(ctor);
    expect(actor.state()).toBe('off');
    const compiled = (ctor as { _compiled_actor?: CompiledActorDefinition })._compiled_actor;
    expect(compiled?.initial).toBe('off');
  });

  it('rejects empty definitions', () => {
    expect(() => compileActorDefinition({ states: {} })).toThrow(InvalidActorDefinitionError);
  });

  it('rejects initial state not in states', () => {
    expect(() => compileActorDefinition({ initial: 'missing', states: { off: {} } }))
      .toThrow(InvalidActorDefinitionError);
  });

  it('rejects duplicate states in sequence', () => {
    expect(() => compileActorDefinition({ sequence: ['a', 'a'], states: { a: {}, b: {} } }))
      .toThrow(InvalidActorDefinitionError);
  });

  it('rejects transition target not in states', () => {
    expect(() => compileActorDefinition({ states: { off: { on: { go: 'missing' } } } }))
      .toThrow(InvalidActorDefinitionError);
  });

  it('rejects transitions on terminal states', () => {
    expect(() => compileActorDefinition({ states: { done: { on: { restart: 'idle' }, terminal: true } } }))
      .toThrow(InvalidActorDefinitionError);
  });

  it('rejects terminal states in sequences', () => {
    expect(() => compileActorDefinition({ sequence: ['a', 'b'], states: { a: {}, b: { terminal: true } } }))
      .toThrow(InvalidActorDefinitionError);
  });
});

describe('dispatchEvent', () => {
  it('handles direct string transition', () => {
    const actor = setupActor(LightActor);

    dispatchEvent(actor, 'toggle');

    expect(actor.state()).toBe('on');
  });

  it('ignores unknown events', () => {
    const actor = setupActor(LightActor);

    dispatchEvent(actor, 'unknown_event');

    expect(actor.state()).toBe('off');
  });

  it('fires enter on transition', () => {
    const actor = setupActor(LightActor);

    dispatchEvent(actor, 'toggle');

    expect(actor.log).toEqual(['entered on, state now on']);
  });

  it('fires leave on transition', () => {
    const actor = setupActor(LightActor);

    dispatchEvent(actor, 'toggle');
    dispatchEvent(actor, 'flicker');
    dispatchEvent(actor, 'replace');

    expect(actor.log).toContain('leaving broken after 1 flickers');
  });

  it('does not fire leave or enter when staying in same state', () => {
    class DoorActor extends BaseActor {
      static _actor = { states: { closed: { on: { stay: 'closed' } } } };
      entered = 0;
      left = 0;
      _on_enter__closed() { this.entered += 1; }
      _on_leave__closed() { this.left += 1; }
    }

    const actor = setupActor(DoorActor);
    dispatchEvent(actor, 'stay');

    expect(actor.entered).toBe(0);
    expect(actor.left).toBe(0);
  });

  it('advances done inside sequence', () => {
    class StepActor extends BaseActor {
      static _actor = { sequence: ['a', 'b', 'c'], states: { a: {}, b: {}, c: {} } };
    }

    const actor = setupActor(StepActor);

    dispatchEvent(actor, 'done');
    expect(actor.state()).toBe('b');
    dispatchEvent(actor, 'done');
    expect(actor.state()).toBe('c');
    dispatchEvent(actor, 'done');
    expect(actor.state()).toBe('c');
  });

  it('throws InvalidTransitionError for unknown current state', () => {
    const actor = setupActor(LightActor);
    actor._state = 'nonexistent';

    expect(() => dispatchEvent(actor, 'toggle'))
      .toThrow(InvalidTransitionError);
  });

  it('rejects multiple internal events in one actor turn', async () => {
    class BadActor extends BaseActor {
      static _actor = { states: { idle: {} } };
      _on_enter__idle() {
        this._send_event('one');
        this._send_event('two');
      }
    }

    expect(() => startActor(BadActor)).toThrow(InternalActorError);
  });
});

describe('state tasks', () => {
  it('runs task completion handlers through the actor pump', async () => {
    class TaskActor extends BaseActor {
      static _actor = { states: { idle: { on: { done: 'done' } }, done: { terminal: true } } };
      result = '';
      task!: Deferred<string>;

      _on_enter__idle() {
        this.task = createDeferred<string>();
        this._start_task({
          run: () => this.task.promise,
          on_done: (result) => {
            this.result = result;
            this._send_event('done');
          },
        });
      }
    }

    const actor = startActor(TaskActor);

    actor.task.resolve('ok');

    await eventually(() => expect(actor.state()).toBe('done'));
    expect(actor.result).toBe('ok');
  });

  it('aborts unfinished state tasks when the actor leaves the state', async () => {
    class TaskActor extends BaseActor {
      static _actor = { states: { idle: { on: { leave: 'done' } }, done: { terminal: true } } };
      signal: AbortSignal | undefined;
      task = createDeferred<void>();

      _on_enter__idle() {
        this._start_task({
          run: ({ signal }) => {
            this.signal = signal;
            return this.task.promise;
          },
        });
      }
    }

    const actor = startActor(TaskActor);

    await eventually(() => expect(actor.signal?.aborted).toBe(false));
    dispatchEvent(actor, 'leave');

    expect(actor.signal?.aborted).toBe(true);
  });

  it('rejects when a non-terminal state has no tasks or events', async () => {
    class StuckActor extends BaseActor {
      static _actor = { states: { idle: {} } };
    }

    const actor = startActor(StuckActor);
    await expect(actor._actorMainPromise).rejects.toThrow(InternalActorError);
  });

  it('exits the main loop when entering a terminal state', async () => {
    class FiniteActor extends BaseActor {
      static _actor = {
        states: {
          idle: { on: { finish: 'done' } },
          done: { terminal: true },
        },
      };
      finished = false;
      task = createDeferred<void>();

      _on_enter__idle() {
        this._start_task({
          run: () => this.task.promise,
          on_done: () => {
            this.finished = true;
            this._send_event('finish');
          },
        });
      }
    }

    const actor = startActor(FiniteActor);

    actor.task.resolve(undefined);

    await eventually(() => expect(actor.state()).toBe('done'));

    const mainResult = await actor._actorMainPromise;
    expect(mainResult).toBeUndefined();
    expect(actor.finished).toBe(true);
  });

  it('rejects starting a task in a terminal state', () => {
    class TerminalActor extends BaseActor {
      static _actor = {
        states: {
          idle: { on: { finish: 'done' } },
          done: { terminal: true },
        },
      };
    }

    const actor = setupActor(TerminalActor);
    actor._state = 'done';

    expect(() => (actor as any)._start_task({ run: () => Promise.resolve() }))
      .toThrow(InternalActorError);
  });
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 30; i++) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}