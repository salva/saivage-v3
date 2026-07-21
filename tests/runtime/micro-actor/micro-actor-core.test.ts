import { describe, expect, it, jest } from '@jest/globals';
import {
  BaseActor,
  compileActorDefinition,
  InvalidActorDefinitionError,
  InternalActorError,
  TimeoutError,
} from '../../../src/runtime/micro-actor/index.js';
import type {
  ActorDefinition,
  ActorCallbackBindings,
  CompiledActorDefinition,
  RunTaskOptions,
} from '../../../src/runtime/micro-actor/index.js';

class TestActor extends BaseActor {
  constructor(definition: CompiledActorDefinition, callbacks?: ActorCallbackBindings) {
    super(definition, callbacks);
  }

  event(name: string): void { this.sendEvent(name); }
  parkedEvent(name: string): void { this.parkedSendEvent(name); }
  task<Result>(run: (signal: AbortSignal) => Promise<Result>, options?: RunTaskOptions<Result>): void {
    this.runTask(run, options);
  }
  settlement(): Promise<void> { return this.awaitLifecycleSettlement(); }
  halt(): void { this.haltCurrentTaskState(); }
}

describe('actor definition compilation', () => {
  it('normalizes and deeply freezes a reusable callback-free topology', () => {
    const definition = compileActorDefinition({
      states: {
        a: { parked: true, on: { go: 'b', stay: { target: 'a' }, again: { target: 'a', reenter: true } } },
        b: { terminal: true },
      },
    });
    const state = definition.states.get('a')!;

    expect(state.on.get('go')).toEqual({ target: 'b', reenter: false });
    expect(state.on.get('stay')).toEqual({ target: 'a', reenter: false });
    expect(state.on.get('again')).toEqual({ target: 'a', reenter: true });
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.states)).toBe(true);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.on)).toBe(true);
    expect(Object.isFrozen(state.on.get('go'))).toBe(true);
    expect('set' in definition.states).toBe(false);
    expect('delete' in definition.states).toBe(false);
    expect('clear' in definition.states).toBe(false);
    expect('set' in state.on).toBe(false);
    expect(() => Object.assign(state.on.get('go')!, { target: 'a' })).toThrow(TypeError);

    const first = new TestActor(definition);
    const second = new TestActor(definition);
    expect(() => { first.start(); second.start(); }).not.toThrow();
  });

  it('supports different definitions on instances of the same subclass', () => {
    const first = new TestActor(compileActorDefinition({ states: { first: { terminal: true } } }));
    const second = new TestActor(compileActorDefinition({ states: { second: { terminal: true } } }));

    first.start();
    second.start();

    expect(first.state()).toBe('first');
    expect(second.state()).toBe('second');
  });

  it('rejects cross-state reentry and identifies source, event, and target', () => {
    expect(() => compileActorDefinition({
      states: {
        a: { on: { go: { target: 'b', reenter: true } } },
        b: {},
      },
    })).toThrow(InvalidActorDefinitionError);
    expect(() => compileActorDefinition({
      states: {
        a: { on: { go: { target: 'b', reenter: true } } },
        b: {},
      },
    })).toThrow(/state "a".*event "go".*"b"/);
  });

  const invalidDefinitions: Array<[ActorDefinition, string]> = [
    [{ states: {} }, 'at least one state'],
    [{ states: { '': {} } }, 'non-empty'],
    [{ initial: 'missing', states: { a: {} } }, 'Initial state'],
    [{ sequence: ['a', 'a'], states: { a: {} } }, 'more than once'],
    [{ sequence: ['missing'], states: { a: {} } }, 'does not exist'],
    [{ sequence: ['a'], states: { a: { terminal: true } } }, 'cannot be in a sequence'],
    [{ states: { a: { on: { go: 'missing' } } } }, 'Transition target'],
    [{ states: { a: { on: { '': 'a' } } } }, 'Event name'],
    [{ states: { a: { terminal: true, on: { go: 'a' } } } }, 'cannot have transitions'],
    [{ states: { a: { terminal: true, parked: true } } }, 'both terminal and parked'],
  ];

  it.each(invalidDefinitions)('rejects invalid definition %#', (definition, message) => {
    expect(() => compileActorDefinition(definition)).toThrow(message);
  });

  it('adds sequence done transitions without overriding explicit transitions', () => {
    const definition = compileActorDefinition({
      sequence: ['a', 'b'],
      states: { a: {}, b: { on: { done: 'c' } }, c: { terminal: true } },
    });

    expect(definition.states.get('a')?.on.get('done')).toEqual({ target: 'b', reenter: false });
    expect(definition.states.get('b')?.on.get('done')).toEqual({ target: 'c', reenter: false });
  });
});

describe('state tasks and events', () => {
  it('halts only during task-result delivery without transition or main-loop failure', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const callbacks: string[] = [];
    let actor!: TestActor;
    actor = new TestActor(
      compileActorDefinition({ states: { running: { on: { done: 'terminal' } }, terminal: { terminal: true } } }),
      {
        enter: ({ target }) => {
          callbacks.push(`enter:${target}`);
          if (target === 'running') actor.task(() => Promise.resolve(), { on_done: () => actor.halt() });
        },
        leave: () => callbacks.push('leave'),
        transition: () => callbacks.push('transition'),
      },
    );
    expect(() => actor.halt()).toThrow(InternalActorError);
    actor.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(actor.state()).toBe('running');
    expect(callbacks).toEqual(['enter:running']);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(() => actor.start()).toThrow(InternalActorError);
    errorSpy.mockRestore();
  });

  it('runs task completion callbacks and default completion/failure events', async () => {
    const definition = compileActorDefinition({
      states: { idle: { on: { done: 'done', failed: 'done' } }, done: { terminal: true } },
    });
    let result = '';
    let completionActor!: TestActor;
    completionActor = new TestActor(definition, {
      enter: ({ target }) => {
        if (target === 'idle') completionActor.task(() => Promise.resolve('ok'), {
          on_done: (value) => { result = value; completionActor.event('done'); },
        });
      },
    });
    completionActor.start();
    await eventually(() => expect(completionActor.state()).toBe('done'));
    expect(result).toBe('ok');

    let defaultDone!: TestActor;
    defaultDone = new TestActor(definition, {
      enter: ({ target }) => {
        if (target === 'idle') defaultDone.task(() => Promise.resolve(), { timeout: 1_000 });
      },
    });
    defaultDone.start();
    await eventually(() => expect(defaultDone.state()).toBe('done'));

    let defaultFailed!: TestActor;
    defaultFailed = new TestActor(definition, {
      enter: ({ target }) => { if (target === 'idle') defaultFailed.task(() => Promise.reject(new Error('boom'))); },
    });
    defaultFailed.start();
    await eventually(() => expect(defaultFailed.state()).toBe('done'));
  });

  it('aborts unfinished source-state tasks before state assignment', async () => {
    const definition = compileActorDefinition({
      states: { idle: { on: { leave: 'done' } }, done: { terminal: true } },
    });
    let signal: AbortSignal | undefined;
    let actor!: TestActor;
    actor = new TestActor(definition, {
      enter: ({ target }) => {
        if (target !== 'idle') return;
        actor.task(() => Promise.resolve(), { on_done_event: 'leave' });
        actor.task((taskSignal) => { signal = taskSignal; return new Promise(() => {}); });
      },
    });
    actor.start();

    await eventually(() => expect(actor.state()).toBe('done'));
    expect(signal?.aborted).toBe(true);
  });

  it('routes timeout callbacks and waits for abort cleanup', async () => {
    const definition = compileActorDefinition({
      states: { idle: { on: { timeout: 'done' } }, done: { terminal: true } },
    });
    const cleanup = deferred<void>();
    let aborted = false;
    let timeoutError: TimeoutError | undefined;
    let actor!: TestActor;
    actor = new TestActor(definition, {
      enter: ({ target }) => {
        if (target !== 'idle') return;
        actor.task(
          (signal) => new Promise<void>((resolve, reject) => {
            signal.addEventListener('abort', () => {
              aborted = true;
              cleanup.promise.then(resolve, reject);
            }, { once: true });
          }),
          {
            timeout: 10,
            on_timeout: (error) => { timeoutError = error; actor.event('timeout'); },
          },
        );
      },
    });
    actor.start();
    await eventually(() => expect(aborted).toBe(true));
    expect(timeoutError).toBeUndefined();

    cleanup.resolve();
    await eventually(() => expect(actor.state()).toBe('done'));
    expect(timeoutError).toBeInstanceOf(TimeoutError);
  });

  it('supports timeout events and timeout fallback to failure', async () => {
    const timeoutDefinition = compileActorDefinition({
      states: { idle: { on: { timed_out: 'done' } }, done: { terminal: true } },
    });
    let timeoutActor!: TestActor;
    timeoutActor = new TestActor(timeoutDefinition, {
      enter: ({ target }) => {
        if (target === 'idle') timeoutActor.task(waitForAbort, { timeout: 5, on_timeout_event: 'timed_out' });
      },
    });
    timeoutActor.start();
    await eventually(() => expect(timeoutActor.state()).toBe('done'));

    let failedError: Error | undefined;
    const failureDefinition = compileActorDefinition({
      states: { idle: { on: { failed: 'done' } }, done: { terminal: true } },
    });
    let failureActor!: TestActor;
    failureActor = new TestActor(failureDefinition, {
      enter: ({ target }) => {
        if (target === 'idle') failureActor.task(waitForAbort, {
          timeout: 5,
          on_failed: (error) => { failedError = error; failureActor.event('failed'); },
        });
      },
    });
    failureActor.start();
    await eventually(() => expect(failureActor.state()).toBe('done'));
    expect(failedError).toBeInstanceOf(TimeoutError);

    let defaultFailureActor!: TestActor;
    defaultFailureActor = new TestActor(failureDefinition, {
      enter: ({ target }) => {
        if (target === 'idle') defaultFailureActor.task(waitForAbort, { timeout: 5 });
      },
    });
    defaultFailureActor.start();
    await eventually(() => expect(defaultFailureActor.state()).toBe('done'));
  });

  it('enforces terminal, parked, and pending-event rules', () => {
    const terminal = new TestActor(compileActorDefinition({ states: { done: { terminal: true } } }));
    terminal.start();
    expect(() => terminal.task(() => Promise.resolve())).toThrow(InternalActorError);

    const parked = new TestActor(compileActorDefinition({ states: { idle: { parked: true } } }));
    expect(() => parked.parkedEvent('go')).toThrow(InternalActorError);
    parked.start();
    expect(() => parked.task(() => Promise.resolve())).toThrow(InternalActorError);
    parked.event('one');
    expect(() => parked.event('two')).toThrow(InternalActorError);

    const running = new TestActor(compileActorDefinition({ states: { idle: { parked: true } } }));
    running.start();
    expect(() => running.parkedEvent('missing')).not.toThrow();

    let nonParked!: TestActor;
    nonParked = new TestActor(
      compileActorDefinition({ states: { running: {} } }),
      { enter: () => nonParked.task(() => new Promise(() => {})) },
    );
    nonParked.start();
    expect(() => nonParked.parkedEvent('missing')).toThrow(InternalActorError);
  });
});

describe('lifecycle ordering and settlement', () => {
  it('orders leave, abort, state assignment, transition, and enter with the queued sequence', async () => {
    const trigger = deferred<void>();
    const log: string[] = [];
    const contexts: unknown[] = [];
    let actor!: TestActor;
    actor = new TestActor(
      compileActorDefinition({ states: { running: { on: { finish: 'done' } }, done: { terminal: true } } }),
      {
        enter: (context) => {
          if (context.target === 'running') {
            actor.task(() => trigger.promise, { on_done_event: 'finish' });
            actor.task((signal) => new Promise(() => {
              signal.addEventListener('abort', () => log.push('abort'), { once: true });
            }));
          } else {
            log.push(`enter:${actor.state()}`);
            contexts.push(context);
          }
        },
        leave: (context) => { log.push(`leave:${actor.state()}`); contexts.push(context); },
        transition: (context) => { log.push(`transition:${actor.state()}`); contexts.push(context); },
      },
    );
    actor.start();
    trigger.resolve();

    await eventually(() => expect(actor.state()).toBe('done'));
    expect(log).toEqual(['leave:running', 'abort', 'transition:done', 'enter:done']);
    expect(contexts).toHaveLength(3);
    expect(contexts[0]).toBe(contexts[1]);
    expect(contexts[1]).toBe(contexts[2]);
    expect(contexts[0]).toEqual({
      source: 'running', event: 'finish', target: 'done', reentered: false, sequence: 1,
    });
  });

  it('settles unknown and internal self-transition events without callbacks or abort', async () => {
    const calls: string[] = [];
    const actor = new TestActor(
      compileActorDefinition({ states: { idle: { parked: true, on: { same: 'idle' } } } }),
      {
        leave: () => calls.push('leave'),
        transition: () => calls.push('transition'),
        enter: ({ source }) => { if (source !== null) calls.push('enter'); },
      },
    );
    actor.start();
    await actor.settlement();

    actor.parkedEvent('missing');
    await actor.settlement();
    actor.parkedEvent('same');
    await actor.settlement();

    expect(calls).toEqual([]);
  });

  it('keeps source tasks alive for an internal self-transition', async () => {
    const trigger = deferred<void>();
    const calls: string[] = [];
    let pendingSignal: AbortSignal | undefined;
    let settlement: Promise<void> | undefined;
    let actor!: TestActor;
    actor = new TestActor(
      compileActorDefinition({ states: { running: { on: { same: { target: 'running' } } } } }),
      {
        enter: ({ source }) => {
          if (source !== null) calls.push('enter');
          actor.task(() => trigger.promise, {
            on_done: () => {
              actor.event('same');
              settlement = actor.settlement();
            },
          });
          actor.task((signal) => { pendingSignal = signal; return new Promise(() => {}); });
        },
        leave: () => calls.push('leave'),
        transition: () => calls.push('transition'),
      },
    );
    actor.start();
    trigger.resolve();

    await eventually(() => expect(settlement).toBeDefined());
    await settlement;
    expect(pendingSignal?.aborted).toBe(false);
    expect(calls).toEqual([]);
    expect(actor.state()).toBe('running');
  });

  it('explicitly reenters the same state, aborts tasks, and marks context reentered', async () => {
    const trigger = deferred<void>();
    const log: string[] = [];
    const contexts: unknown[] = [];
    let entries = 0;
    let actor!: TestActor;
    actor = new TestActor(
      compileActorDefinition({ states: { running: { on: { again: { target: 'running', reenter: true } } } } }),
      {
        enter: (context) => {
          entries++;
          if (entries === 1) {
            actor.task(() => trigger.promise, { on_done_event: 'again' });
            actor.task((signal) => new Promise(() => {
              signal.addEventListener('abort', () => log.push('abort'), { once: true });
            }));
          } else {
            actor.task(() => new Promise(() => {}));
            contexts.push(context);
            log.push('enter');
          }
        },
        leave: (context) => { contexts.push(context); log.push('leave'); },
        transition: (context) => { contexts.push(context); log.push('transition'); },
      },
    );
    actor.start();
    trigger.resolve();

    await eventually(() => expect(entries).toBe(2));
    expect(log).toEqual(['leave', 'abort', 'transition', 'enter']);
    expect(contexts).toHaveLength(3);
    expect(contexts[0]).toEqual({
      source: 'running', event: 'again', target: 'running', reentered: true, sequence: 1,
    });
  });

  it.each(['leave', 'transition', 'enter'] as const)('rejects lifecycle settlement when %s throws', async (phase) => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const calls: string[] = [];
      const callbacks: ActorCallbackBindings = {
        leave: () => { calls.push('leave'); if (phase === 'leave') throw new Error('leave failed'); },
        transition: () => { calls.push('transition'); if (phase === 'transition') throw new Error('transition failed'); },
        enter: ({ source }) => {
          if (source === null) return;
          calls.push('enter');
          if (phase === 'enter') throw new Error('enter failed');
        },
      };
      const actor = new TestActor(
        compileActorDefinition({ states: { idle: { parked: true, on: { go: 'done' } }, done: { terminal: true } } }),
        callbacks,
      );
      actor.start();
      actor.parkedEvent('go');

      await expect(actor.settlement()).rejects.toThrow(`${phase} failed`);
      expect(actor.state()).toBe(phase === 'leave' ? 'idle' : 'done');
      expect(calls).toEqual(
        phase === 'leave' ? ['leave']
          : phase === 'transition' ? ['leave', 'transition']
            : ['leave', 'transition', 'enter'],
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('does not abort source tasks or update state when leave throws', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const trigger = deferred<void>();
      let pendingSignal: AbortSignal | undefined;
      let settlement: Promise<void> | undefined;
      let actor!: TestActor;
      actor = new TestActor(
        compileActorDefinition({ states: { running: { on: { finish: 'done' } }, done: { terminal: true } } }),
        {
          enter: ({ target }) => {
            if (target !== 'running') return;
            actor.task(() => trigger.promise, {
              on_done: () => {
                actor.event('finish');
                settlement = actor.settlement();
                void settlement.catch(() => undefined);
              },
            });
            actor.task((signal) => { pendingSignal = signal; return new Promise(() => {}); });
          },
          leave: () => { throw new Error('leave failed'); },
        },
      );
      actor.start();
      trigger.resolve();
      await eventually(() => expect(settlement).toBeDefined());

      await expect(settlement).rejects.toThrow('leave failed');
      expect(pendingSignal?.aborted).toBe(false);
      expect(actor.state()).toBe('running');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value?: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 40; i++) {
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
