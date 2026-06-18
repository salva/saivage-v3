import { describe, it, expect } from '@jest/globals';
import {
  BaseActor,
  compileActorDefinition,
  InvalidActorDefinitionError,
  InternalActorError,
  TimeoutError,
} from '../../../src/runtime/micro-actor/index.js';
import { dispatchEvent, getCompiledActorDefinition } from '../../../src/runtime/micro-actor/index.js';
import type { ActorDefinition, CompiledActorDefinition } from '../../../src/runtime/micro-actor/index.js';

function setupActor<T extends BaseActor>(ctor: new (...args: any[]) => T): T {
  const definition = getCompiledActorDefinition(ctor as any);
  const actor = new ctor();
  actor['_definition'] = definition;
  actor['_state'] = definition.initial;
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

  });

describe('state tasks', () => {
  it('runs task completion handlers through the actor pump', async () => {
    class TaskActor extends BaseActor {
      static _actor = { states: { idle: { on: { done: 'done' } }, done: { terminal: true } } };
      result = '';
      task!: Deferred<string>;

      _on_enter__idle() {
        this.task = createDeferred<string>();
        this._run_task(
          () => this.task.promise,
          { on_done: (result) => {
            this.result = result;
            this._send_event('done');
          } },
        );
      }
    }

    const actor = new TaskActor(); actor.start();

    actor.task.resolve('ok');

    await eventually(() => expect(actor.state()).toBe('done'));
    expect(actor.result).toBe('ok');
  });

  it('aborts unfinished state tasks when the actor leaves the state', async () => {
    class TaskActor extends BaseActor {
      static _actor = { states: { idle: { on: { leave: 'done' } }, done: { terminal: true } } };
      signal: AbortSignal | undefined;

      _on_enter__idle() {
        this._run_task(() => Promise.resolve(undefined), { on_done_event: 'leave' });
        this._run_task((signal) => {
          this.signal = signal;
          return new Promise<void>(() => {});
        });
      }
    }

    const actor = new TaskActor(); actor.start();

    await eventually(() => expect(actor.state()).toBe('done'));
    expect(actor.signal?.aborted).toBe(true);
  });

  it('throws when a non-terminal state has no tasks or events', async () => {
    class StuckActor extends BaseActor {
      static _actor = { states: { idle: { on: { go: 'done' } }, done: { terminal: true } } };
    }

    const actor = new StuckActor();
    actor.start();

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
        this._run_task(
          () => this.task.promise,
          { on_done: () => {
            this.finished = true;
            this._send_event('finish');
          } },
        );
      }
    }

    const actor = new FiniteActor(); actor.start();

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

    expect(() => (actor as any)._run_task(() => Promise.resolve()))
      .toThrow(InternalActorError);
  });

  it('sends default done event when no on_done callback', async () => {
    class TaskActor extends BaseActor {
      static _actor = { states: { idle: { on: { done: 'done' } }, done: { terminal: true } } };

      _on_enter__idle() {
        this._run_task(() => Promise.resolve('ok'));
      }
    }

    const actor = new TaskActor(); actor.start();
    await eventually(() => expect(actor.state()).toBe('done'));
  });

  it('sends default failed event when no on_failed callback', async () => {
    class FailActor extends BaseActor {
      static _actor = { states: { idle: { on: { failed: 'done' } }, done: { terminal: true } } };

      _on_enter__idle() {
        this._run_task(() => Promise.reject(new Error('boom')));
      }
    }

    const actor = new FailActor(); actor.start();
    await eventually(() => expect(actor.state()).toBe('done'));
  });

  it('times out a task and sends default failed event', async () => {
    class TimeoutActor extends BaseActor {
      static _actor = { states: { idle: { on: { failed: 'done' } }, done: { terminal: true } } };

      _on_enter__idle() {
        this._run_task(
          (signal) => waitForAbort(signal),
          { timeout: 10 },
        );
      }
    }

    const actor = new TimeoutActor(); actor.start();
    await eventually(() => expect(actor.state()).toBe('done'));
  });

  it('times out a task and calls on_timeout callback', async () => {
    class TimeoutActor extends BaseActor {
      static _actor = { states: { idle: { on: { timeout: 'done' } }, done: { terminal: true } } };
      timeoutError: TimeoutError | undefined;

      _on_enter__idle() {
        this._run_task(
          (signal) => waitForAbort(signal),
          {
            timeout: 10,
            on_timeout: (error) => {
              this.timeoutError = error;
              this._send_event('timeout');
            },
          },
        );
      }
    }

    const actor = new TimeoutActor(); actor.start();
    await eventually(() => expect(actor.state()).toBe('done'));
    expect(actor.timeoutError).toBeInstanceOf(TimeoutError);
  });

  it('times out a task and sends on_timeout_event', async () => {
    class TimeoutActor extends BaseActor {
      static _actor = { states: { idle: { on: { timed_out: 'done' } }, done: { terminal: true } } };

      _on_enter__idle() {
        this._run_task(
          (signal) => waitForAbort(signal),
          { timeout: 10, on_timeout_event: 'timed_out' },
        );
      }
    }

    const actor = new TimeoutActor(); actor.start();
    await eventually(() => expect(actor.state()).toBe('done'));
  });

  it('falls through timeout to on_failed when no on_timeout handler', async () => {
    class FailActor extends BaseActor {
      static _actor = { states: { idle: { on: { failed: 'done' } }, done: { terminal: true } } };
      failedError: Error | undefined;

      _on_enter__idle() {
        this._run_task(
          (signal) => waitForAbort(signal),
          {
            timeout: 10,
            on_failed: (error) => {
              this.failedError = error;
              this._send_event('failed');
            },
          },
        );
      }
    }

    const actor = new FailActor(); actor.start();
    await eventually(() => expect(actor.state()).toBe('done'));
    expect(actor.failedError).toBeInstanceOf(TimeoutError);
  });

  it('waits for timed out task to finish after abort', async () => {
    class TimeoutActor extends BaseActor {
      static _actor = { states: { idle: { on: { timeout: 'done' } }, done: { terminal: true } } };
      cleanup = createDeferred<void>();
      aborted = false;
      timeoutError: TimeoutError | undefined;

      _on_enter__idle() {
        this._run_task(
          (signal) => new Promise<void>((resolve, reject) => {
            signal.addEventListener('abort', () => {
              this.aborted = true;
              this.cleanup.promise.then(resolve, reject);
            }, { once: true });
          }),
          {
            timeout: 10,
            on_timeout: (error) => {
              this.timeoutError = error;
              this._send_event('timeout');
            },
          },
        );
      }
    }

    const actor = new TimeoutActor(); actor.start();
    await eventually(() => expect(actor.aborted).toBe(true));
    expect(actor.timeoutError).toBeUndefined();

    actor.cleanup.resolve(undefined);

    await eventually(() => expect(actor.state()).toBe('done'));
    expect(actor.timeoutError).toBeInstanceOf(TimeoutError);
  });

  it('completes a task before timeout', async () => {
    class FastActor extends BaseActor {
      static _actor = { states: { idle: { on: { done: 'done' } }, done: { terminal: true } } };

      _on_enter__idle() {
        this._run_task(
          () => Promise.resolve('fast'),
          { timeout: 1000 },
        );
      }
    }

    const actor = new FastActor(); actor.start();
    await eventually(() => expect(actor.state()).toBe('done'));
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

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
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
