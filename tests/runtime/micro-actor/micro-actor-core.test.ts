import { describe, expect, it, jest } from '@jest/globals';
import {
  BaseActor,
  compileActorDefinition,
  InternalActorError,
  InvalidActorDefinitionError,
} from '../../../src/runtime/micro-actor/index.js';
import type {
  ActorDefinition,
  ActorLifecycleContext,
  ActorTransitionContext,
  CompiledActorDefinition,
} from '../../../src/runtime/micro-actor/index.js';

type TaskCallbacks<Result> = Readonly<{
  onDone(result: Result): void;
  onFailed(error: Error): void;
}>;

class TestActor extends BaseActor {
  readonly #entered: (context: ActorLifecycleContext) => void;
  readonly #transitioned: (context: ActorTransitionContext) => void;
  readonly #mainFailed: (error: unknown) => void;

  constructor(
    definition: CompiledActorDefinition,
    hooks: Readonly<{
      entered?(context: ActorLifecycleContext): void;
      transitioned?(context: ActorTransitionContext): void;
      mainFailed?(error: unknown): void;
    }> = {},
  ) {
    super(definition);
    this.#entered = hooks.entered ?? (() => undefined);
    this.#transitioned = hooks.transitioned ?? (() => undefined);
    this.#mainFailed = hooks.mainFailed ?? (() => undefined);
  }

  event(name: string): void { this.sendEvent(name); }
  parkedEvent(name: string): void { this.parkedSendEvent(name); }
  task<Result>(run: () => Promise<Result>, callbacks: TaskCallbacks<Result>): void { this.runTask(run, callbacks); }
  settlement(): Promise<void> { return this.awaitLifecycleSettlement(); }
  halt(): void { this.haltCurrentTaskState(); }

  protected onStateEntered(context: ActorLifecycleContext): void { this.#entered(context); }
  protected onTransition(context: ActorTransitionContext): void { this.#transitioned(context); }
  protected onActorMainFailure(error: unknown): void { this.#mainFailed(error); }
}

const unexpectedFailure = (error: Error): never => { throw error; };

describe('configured actor definition', () => {
  it('compiles immutable explicit topology and rejects invalid production definitions', () => {
    const compiled = compileActorDefinition({
      initial: 'ready',
      states: {
        ready: { parked: true, on: { go: 'done', stay: { target: 'ready' }, again: { target: 'ready', reenter: true } } },
        done: { terminal: true },
      },
    });
    const ready = compiled.states.get('ready')!;
    expect(ready.on.get('go')).toEqual({ target: 'done', reenter: false });
    expect(ready.on.get('stay')).toEqual({ target: 'ready', reenter: false });
    expect(ready.on.get('again')).toEqual({ target: 'ready', reenter: true });
    expect([compiled, compiled.states, ready, ready.on, ready.on.get('go')].every(Object.isFrozen)).toBe(true);
    expect('set' in compiled.states).toBe(false);
    expect('set' in ready.on).toBe(false);

    const invalid: Array<readonly [ActorDefinition, string | RegExp]> = [
      [{ initial: 'missing', states: {} }, 'at least one state'],
      [{ initial: '', states: { '': {} } }, 'non-empty'],
      [{ initial: 'missing', states: { ready: {} } }, 'Initial state'],
      [{ initial: 'ready', states: { ready: { on: { go: 'missing' } } } }, 'Transition target'],
      [{ initial: 'ready', states: { ready: { on: { '': 'ready' } } } }, 'Event name'],
      [{ initial: 'done', states: { done: { terminal: true, on: { go: 'done' } } } }, 'cannot have transitions'],
      [{ initial: 'done', states: { done: { terminal: true, parked: true } } }, 'both terminal and parked'],
      [{ initial: 'ready', states: { ready: { on: { go: { target: 'done', reenter: true } } }, done: {} } }, /state "ready".*event "go".*"done"/],
    ];
    for (const [definition, message] of invalid) expect(() => compileActorDefinition(definition)).toThrow(message);
    expect(() => compileActorDefinition(invalid[0]![0])).toThrow(InvalidActorDefinitionError);
  });
});

describe('configured actor lifecycle', () => {
  it('1. starts at the explicit initial state with the exact frozen sequence-free context', () => {
    const contexts: ActorLifecycleContext[] = [];
    const actor = new TestActor(
      compileActorDefinition({ initial: 'ready', states: { ready: { terminal: true } } }),
      { entered: (context) => contexts.push(context) },
    );
    actor.start();
    expect(actor.state()).toBe('ready');
    expect(contexts).toEqual([{ source: null, event: null, target: 'ready' }]);
    expect(Object.isFrozen(contexts[0])).toBe(true);
  });

  it('2. invokes no hook during construction and no transition hook on start', () => {
    const entered = jest.fn<(context: ActorLifecycleContext) => void>();
    const transitioned = jest.fn<(context: ActorTransitionContext) => void>();
    const actor = new TestActor(
      compileActorDefinition({ initial: 'ready', states: { ready: { terminal: true } } }),
      { entered, transitioned },
    );
    expect(entered).not.toHaveBeenCalled();
    expect(transitioned).not.toHaveBeenCalled();
    actor.start();
    expect(entered).toHaveBeenCalledTimes(1);
    expect(transitioned).not.toHaveBeenCalled();
  });

  it('3. propagates start-entry failure synchronously after assigning state', () => {
    const actor = new TestActor(
      compileActorDefinition({ initial: 'ready', states: { ready: { terminal: true } } }),
      { entered: () => { throw new Error('start failed'); } },
    );
    expect(() => actor.start()).toThrow('start failed');
    expect(actor.state()).toBe('ready');
    expect(() => actor.start()).toThrow(InternalActorError);
  });

  it('4. rejects repeated start from terminal, parked, and halted states', async () => {
    const terminal = new TestActor(compileActorDefinition({ initial: 'done', states: { done: { terminal: true } } }));
    terminal.start();
    expect(() => terminal.start()).toThrow(InternalActorError);

    const parked = new TestActor(compileActorDefinition({ initial: 'ready', states: { ready: { parked: true } } }));
    parked.start();
    expect(() => parked.start()).toThrow(InternalActorError);

    let halted = false;
    let running!: TestActor;
    running = new TestActor(
      compileActorDefinition({ initial: 'running', states: { running: {} } }),
      { entered: () => running.task(() => Promise.resolve(), { onDone: () => { running.halt(); halted = true; }, onFailed: unexpectedFailure }) },
    );
    running.start();
    await eventually(() => expect(halted).toBe(true));
    expect(() => running.start()).toThrow(InternalActorError);
  });

  it('5. assigns a parked transition target before transition then entry with one exact frozen context', async () => {
    const log: string[] = [];
    const contexts: ActorLifecycleContext[] = [];
    let actor!: TestActor;
    actor = new TestActor(
      compileActorDefinition({ initial: 'ready', states: { ready: { parked: true, on: { go: 'done' } }, done: { terminal: true } } }),
      {
        transitioned: (context) => { log.push(`transition:${actor.state()}`); contexts.push(context); },
        entered: (context) => { if (context.source !== null) { log.push(`entry:${actor.state()}`); contexts.push(context); } },
      },
    );
    actor.start();
    actor.parkedEvent('go');
    await actor.settlement();
    expect(log).toEqual(['transition:done', 'entry:done']);
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toBe(contexts[1]);
    expect(contexts[0]).toEqual({ source: 'ready', event: 'go', target: 'done', reentered: false });
    expect(Object.isFrozen(contexts[0])).toBe(true);
  });

  it('6. invokes no hook for a non-reentering same-state edge', async () => {
    const calls: string[] = [];
    const actor = new TestActor(
      compileActorDefinition({ initial: 'ready', states: { ready: { parked: true, on: { stay: 'ready' } } } }),
      { transitioned: () => calls.push('transition'), entered: ({ source }) => { if (source !== null) calls.push('entry'); } },
    );
    actor.start();
    actor.parkedEvent('stay');
    await actor.settlement();
    expect(calls).toEqual([]);
  });

  it('7. clears a completed task before success callback and settles only after transition and entry hooks', async () => {
    const log: string[] = [];
    let settlement!: Promise<void>;
    let actor!: TestActor;
    actor = new TestActor(
      compileActorDefinition({ initial: 'running', states: { running: { on: { done: 'terminal' } }, terminal: { terminal: true } } }),
      {
        entered: ({ target }) => {
          log.push(`entry:${target}`);
          if (target === 'running') actor.task(() => Promise.resolve('ok'), {
            onDone: () => {
              log.push('callback');
              expect(() => actor.task(() => new Promise(() => {}), { onDone: () => undefined, onFailed: unexpectedFailure })).not.toThrow();
              actor.event('done');
              settlement = actor.settlement().then(() => { log.push('settled'); });
            },
            onFailed: unexpectedFailure,
          });
        },
        transitioned: () => log.push('transition'),
      },
    );
    actor.start();
    await eventually(() => expect(settlement).toBeDefined());
    await settlement;
    expect(log).toEqual(['entry:running', 'callback', 'transition', 'entry:terminal', 'settled']);
  });

  it('8. clears a rejected task before its failure callback and explicit event', async () => {
    const failure = new Error('failed');
    const log: string[] = [];
    let actor!: TestActor;
    actor = new TestActor(
      compileActorDefinition({ initial: 'running', states: { running: { on: { failed: 'terminal' } }, terminal: { terminal: true } } }),
      {
        entered: ({ target }) => {
          log.push(`entry:${target}`);
          if (target === 'running') actor.task(() => Promise.reject(failure), {
            onDone: () => { throw new Error('unexpected success'); },
            onFailed: (error) => {
              expect(error).toBe(failure);
              expect(() => actor.task(() => new Promise(() => {}), { onDone: () => undefined, onFailed: unexpectedFailure })).not.toThrow();
              log.push('failure');
              actor.event('failed');
            },
          });
        },
        transitioned: () => log.push('transition'),
      },
    );
    actor.start();
    await eventually(() => expect(actor.state()).toBe('terminal'));
    expect(log).toEqual(['entry:running', 'failure', 'transition', 'entry:terminal']);
  });

  it('9. reenters the same node after task completion with transition then entry and no abort surface', async () => {
    const log: string[] = [];
    let entries = 0;
    let actor!: TestActor;
    actor = new TestActor(
      compileActorDefinition({ initial: 'node', states: { node: { on: { again: { target: 'node', reenter: true } } } } }),
      {
        transitioned: (context) => log.push(`transition:${context.reentered}`),
        entered: ({ target }) => {
          entries += 1;
          log.push(`entry:${target}`);
          if (entries === 1) actor.task(() => Promise.resolve(), { onDone: () => actor.event('again'), onFailed: unexpectedFailure });
          else actor.task(() => new Promise(() => {}), { onDone: () => undefined, onFailed: unexpectedFailure });
        },
      },
    );
    actor.start();
    await eventually(() => expect(entries).toBe(2));
    expect(log).toEqual(['entry:node', 'transition:true', 'entry:node']);
  });

  it.each(['transition', 'entry'] as const)('10. terminally rejects current and future lifecycle settlement when the %s hook fails', async (phase) => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const calls: string[] = [];
      const failure = new Error(`${phase} failed`);
      const mainFailed = jest.fn<(error: unknown) => void>();
      let actor!: TestActor;
      actor = new TestActor(
        compileActorDefinition({ initial: 'ready', states: { ready: { parked: true, on: { go: { target: 'ready', reenter: true } } } } }),
        {
          transitioned: () => { calls.push('transition'); if (phase === 'transition') throw failure; },
          entered: ({ source }) => { if (source !== null) { calls.push('entry'); if (phase === 'entry') throw failure; } },
          mainFailed,
        },
      );
      actor.start();
      actor.parkedEvent('go');
      const current = actor.settlement();
      await expect(current).rejects.toBe(failure);
      await expect(actor.settlement()).rejects.toBe(failure);
      actor.parkedEvent('go');
      await expect(actor.settlement()).rejects.toBe(failure);
      await new Promise((resolve) => setImmediate(resolve));
      expect(mainFailed).toHaveBeenCalledTimes(1);
      expect(mainFailed).toHaveBeenCalledWith(failure);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith('BaseActor main loop failed', failure);
      expect(actor.state()).toBe('ready');
      expect(calls).toEqual(phase === 'transition' ? ['transition'] : ['transition', 'entry']);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('11. terminally reports task-result callback and framework-loop failures exactly once', async () => {
    for (const phase of ['task-result', 'framework-loop'] as const) {
      const primary = new Error(`${phase} failed`);
      const hook = jest.fn<(error: unknown) => void>();
      const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      let actor!: TestActor;
      actor = new TestActor(
        compileActorDefinition({ initial: 'running', states: { running: {} } }),
        phase === 'task-result'
          ? { entered: () => actor.task(() => Promise.resolve(), { onDone: () => { throw primary; }, onFailed: unexpectedFailure }), mainFailed: hook }
          : { mainFailed: hook },
      );
      actor.start();
      await eventually(() => expect(hook).toHaveBeenCalledTimes(1));
      expect(hook).toHaveBeenCalledWith(phase === 'task-result' ? primary : expect.any(InternalActorError));
      const caught = hook.mock.calls[0]![0];
      await expect(actor.settlement()).rejects.toBe(caught);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith('BaseActor main loop failed', caught);
      log.mockRestore();
    }
  });

  it('12. logs a secondary hook failure without replacing or retrying the primary failure', async () => {
    const primary = new Error('primary');
    const secondary = new Error('secondary');
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const hook = jest.fn<(error: unknown) => void>(() => { throw secondary; });
    const actor = new TestActor(
      compileActorDefinition({ initial: 'ready', states: { ready: { parked: true, on: { go: 'done' } }, done: { terminal: true } } }),
      { transitioned: () => { throw primary; }, mainFailed: hook },
    );
    actor.start(); actor.parkedEvent('go');
    await expect(actor.settlement()).rejects.toBe(primary);
    await expect(actor.settlement()).rejects.toBe(primary);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(log.mock.calls).toEqual([
      ['BaseActor main loop failed', primary],
      ['BaseActor main-loop failure hook failed', secondary],
    ]);
    log.mockRestore();
  });

  it('13. permits halt only during callback delivery after slot clear and before an event is queued', async () => {
    const outside = new TestActor(compileActorDefinition({ initial: 'ready', states: { ready: { parked: true } } }));
    outside.start();
    expect(() => outside.halt()).toThrow(InternalActorError);

    let legal = false;
    let halted!: TestActor;
    halted = new TestActor(
      compileActorDefinition({ initial: 'running', states: { running: {} } }),
      { entered: () => halted.task(() => Promise.resolve(), { onDone: () => { halted.halt(); legal = true; }, onFailed: unexpectedFailure }) },
    );
    halted.start();
    await eventually(() => expect(legal).toBe(true));

    let checkedQueuedEvent = false;
    let queued!: TestActor;
    queued = new TestActor(
      compileActorDefinition({ initial: 'running', states: { running: { on: { done: 'terminal' } }, terminal: { terminal: true } } }),
      { entered: ({ target }) => { if (target === 'running') queued.task(() => Promise.resolve(), { onDone: () => { queued.event('done'); expect(() => queued.halt()).toThrow(InternalActorError); checkedQueuedEvent = true; }, onFailed: unexpectedFailure }); } },
    );
    queued.start();
    await eventually(() => expect(queued.state()).toBe('terminal'));
    expect(checkedQueuedEvent).toBe(true);
  });

  it('14. chains configured execution because each next node entry sees a null task slot', async () => {
    const entries: string[] = [];
    let actor!: TestActor;
    actor = new TestActor(
      compileActorDefinition({
        initial: 'a',
        states: { a: { on: { next: 'b' } }, b: { on: { next: 'done' } }, done: { terminal: true } },
      }),
      {
        entered: ({ target }) => {
          entries.push(target);
          if (target !== 'done') actor.task(() => Promise.resolve(), { onDone: () => actor.event('next'), onFailed: unexpectedFailure });
        },
      },
    );
    actor.start();
    await eventually(() => expect(actor.state()).toBe('done'));
    expect(entries).toEqual(['a', 'b', 'done']);
  });
});

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
