import { describe, it, expect } from '@jest/globals';
import {
  BaseActor,
  compileActorDefinition,
  InvalidActorDefinitionError,
  InternalActorError,
  TimeoutError,
} from '../../../src/runtime/micro-actor/index.js';
import { getCompiledActorDefinition } from '../../../src/runtime/micro-actor/index.js';
import type { ActorDefinition, CompiledActorDefinition } from '../../../src/runtime/micro-actor/index.js';

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
    const definition = getCompiledActorDefinition(ctor);
    expect(definition.initial).toBe('off');
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

describe('state tasks', () => {
  it('runs task completion handlers through the actor pump', async () => {
    class TaskActor extends BaseActor {
      static _actor = { states: { idle: { on: { done: 'done' } }, done: { terminal: true } } };
      result = '';
      task!: Deferred<string>;

      _on_enter__idle() {
        this.task = createDeferred<string>();
        this.runTask(
          () => this.task.promise,
          { on_done: (result) => {
            this.result = result;
            this.sendEvent('done');
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
        this.runTask(() => Promise.resolve(undefined), { on_done_event: 'leave' });
        this.runTask((signal) => {
          this.signal = signal;
          return new Promise<void>(() => {});
        });
      }
    }

    const actor = new TaskActor(); actor.start();

    await eventually(() => expect(actor.state()).toBe('done'));
    expect(actor.signal?.aborted).toBe(true);
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
        this.runTask(
          () => this.task.promise,
          { on_done: () => {
            this.finished = true;
            this.sendEvent('finish');
          } },
        );
      }
    }

    const actor = new FiniteActor(); actor.start();

    actor.task.resolve(undefined);

    await eventually(() => expect(actor.state()).toBe('done'));

    expect(actor.finished).toBe(true);
  });

  it('rejects starting a task in a terminal state', () => {
    class TerminalActor extends BaseActor {
      static _actor = {
        initial: 'done',
        states: {
          idle: { on: { finish: 'done' } },
          done: { terminal: true },
        },
      };

      startTaskFromTerminal() {
        this.runTask(() => Promise.resolve());
      }
    }

    const actor = new TerminalActor();
    actor.start();

    expect(() => actor.startTaskFromTerminal())
      .toThrow(InternalActorError);
  });

  it('sends default done event when no on_done callback', async () => {
    class TaskActor extends BaseActor {
      static _actor = { states: { idle: { on: { done: 'done' } }, done: { terminal: true } } };

      _on_enter__idle() {
        this.runTask(() => Promise.resolve('ok'));
      }
    }

    const actor = new TaskActor(); actor.start();
    await eventually(() => expect(actor.state()).toBe('done'));
  });

  it('sends default failed event when no on_failed callback', async () => {
    class FailActor extends BaseActor {
      static _actor = { states: { idle: { on: { failed: 'done' } }, done: { terminal: true } } };

      _on_enter__idle() {
        this.runTask(() => Promise.reject(new Error('boom')));
      }
    }

    const actor = new FailActor(); actor.start();
    await eventually(() => expect(actor.state()).toBe('done'));
  });

  it('times out a task and sends default failed event', async () => {
    class TimeoutActor extends BaseActor {
      static _actor = { states: { idle: { on: { failed: 'done' } }, done: { terminal: true } } };

      _on_enter__idle() {
        this.runTask(
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
        this.runTask(
          (signal) => waitForAbort(signal),
          {
            timeout: 10,
            on_timeout: (error) => {
              this.timeoutError = error;
              this.sendEvent('timeout');
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
        this.runTask(
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
        this.runTask(
          (signal) => waitForAbort(signal),
          {
            timeout: 10,
            on_failed: (error) => {
              this.failedError = error;
              this.sendEvent('failed');
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
        this.runTask(
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
              this.sendEvent('timeout');
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
        this.runTask(
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
