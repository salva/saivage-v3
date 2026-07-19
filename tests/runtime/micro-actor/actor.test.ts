import { describe, expect, it } from '@jest/globals';
import {
  BaseActor,
  compileActorDefinition,
  InternalActorError,
} from '../../../src/runtime/micro-actor/index.js';
import type {
  ActorCallbackBindings,
  CompiledActorDefinition,
} from '../../../src/runtime/micro-actor/index.js';

class TestActor extends BaseActor {
  constructor(definition: CompiledActorDefinition, callbacks?: ActorCallbackBindings) {
    super(definition, callbacks);
  }

  event(name: string): void { this.sendEvent(name); }
  parkedEvent(name: string): void { this.parkedSendEvent(name); }
  task<Result>(run: (signal: AbortSignal) => Promise<Result>, onDoneEvent?: string): void {
    this.runTask(run, onDoneEvent === undefined ? undefined : { on_done_event: onDoneEvent });
  }
}

describe('start', () => {
  it('creates a live actor and processes events from task completions', async () => {
    const definition = compileActorDefinition({
      initial: 'a',
      states: {
        a: { on: { go: 'b' } },
        b: { on: { go: 'c' } },
        c: { on: { go: 'done' } },
        done: { terminal: true },
      },
    });
    const log: string[] = [];
    let actor!: TestActor;
    actor = new TestActor(definition, {
      enter: ({ target }) => {
        log.push(`enter:${target}`);
        if (target !== 'done') actor.task(() => Promise.resolve(), 'go');
      },
    });

    actor.start();
    expect(actor.state()).toBe('a');
    expect(log).toEqual(['enter:a']);

    await eventually(() => expect(actor.state()).toBe('done'));
    expect(log).toEqual(['enter:a', 'enter:b', 'enter:c', 'enter:done']);
  });

  it('uses the exact frozen start context and invokes no transition callback', () => {
    const definition = compileActorDefinition({ states: { ready: { terminal: true } } });
    const contexts: unknown[] = [];
    const actor = new TestActor(definition, {
      enter: (context) => contexts.push(context),
      transition: (context) => contexts.push(context),
    });

    actor.start();

    expect(contexts).toEqual([{
      source: null,
      event: null,
      target: 'ready',
      reentered: false,
      sequence: null,
    }]);
    expect(Object.isFrozen(contexts[0])).toBe(true);
  });

  it('does not invoke callbacks during construction and freezes bindings', () => {
    const definition = compileActorDefinition({ states: { idle: { terminal: true } } });
    const enter = () => { throw new Error('construction callback ran'); };
    const callbacks: ActorCallbackBindings = { enter };

    expect(() => new TestActor(definition, callbacks)).not.toThrow();
    expect(Object.isFrozen(callbacks)).toBe(true);
  });

  it('propagates start-entry failure synchronously after assigning state', () => {
    const actor = new TestActor(
      compileActorDefinition({ states: { idle: { terminal: true } } }),
      { enter: () => { throw new Error('start failed'); } },
    );

    expect(() => actor.start()).toThrow('start failed');
    expect(actor.state()).toBe('idle');
  });

  it('can restart from a terminal state with the same definition and bindings', () => {
    let entered = 0;
    const actor = new TestActor(
      compileActorDefinition({ states: { done: { terminal: true } } }),
      { enter: () => { entered++; } },
    );

    actor.start();
    actor.start();

    expect(entered).toBe(2);
  });

  it('rejects starting from a non-terminal state', () => {
    const actor = new TestActor(
      compileActorDefinition({ states: { idle: { parked: true } } }),
    );
    actor.start();

    expect(() => actor.start()).toThrow(InternalActorError);
  });
});

describe('transition callbacks', () => {
  it('passes the exact transition context after state assignment and before enter', async () => {
    const definition = compileActorDefinition({
      states: {
        idle: { parked: true, on: { go: 'active' } },
        active: { terminal: true },
      },
    });
    const log: string[] = [];
    const contexts: unknown[] = [];
    let actor!: TestActor;
    actor = new TestActor(definition, {
      leave: (context) => { log.push(`leave:${actor.state()}`); contexts.push(context); },
      transition: (context) => { log.push(`transition:${actor.state()}`); contexts.push(context); },
      enter: (context) => {
        if (context.source !== null) log.push(`enter:${actor.state()}`);
        contexts.push(context);
      },
    });
    actor.start();
    log.length = 0;
    contexts.length = 0;

    actor.parkedEvent('go');
    await eventually(() => expect(actor.state()).toBe('active'));

    expect(log).toEqual(['leave:idle', 'transition:active', 'enter:active']);
    expect(contexts).toHaveLength(3);
    expect(contexts[0]).toBe(contexts[1]);
    expect(contexts[1]).toBe(contexts[2]);
    expect(contexts[0]).toEqual({
      source: 'idle',
      event: 'go',
      target: 'active',
      reentered: false,
      sequence: 1,
    });
    expect(Object.isFrozen(contexts[0])).toBe(true);
  });

  it('does not invoke callbacks for an ordinary same-state transition', async () => {
    const calls: string[] = [];
    const actor = new TestActor(
      compileActorDefinition({ states: { idle: { parked: true, on: { noop: 'idle' } } } }),
      {
        leave: () => calls.push('leave'),
        transition: () => calls.push('transition'),
        enter: ({ source }) => { if (source !== null) calls.push('enter'); },
      },
    );
    actor.start();

    actor.parkedEvent('noop');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toEqual([]);
    expect(actor.state()).toBe('idle');
  });
});

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
