import { describe, expect, it } from '@jest/globals';
import { BaseActor, InternalActorError } from '../../../src/runtime/micro-actor/index.js';

describe('start', () => {
  it('creates a live actor and processes events from task completions', async () => {
    class StepActor extends BaseActor {
      static _actor = {
        initial: 'a',
        states: {
          a: { on: { go: 'b' } },
          b: { on: { go: 'c' } },
          c: { on: { go: 'done' } },
          done: { terminal: true },
        },
      };
      log: string[] = [];

      _on_enter__a() {
        this.log.push('enter:a');
        this.runTask(
          () => Promise.resolve(undefined),
          { on_done: () => { this.sendEvent('go'); } },
        );
      }

      _on_enter__b() {
        this.log.push('enter:b');
        this.runTask(
          () => Promise.resolve(undefined),
          { on_done: () => { this.sendEvent('go'); } },
        );
      }

      _on_enter__c() {
        this.log.push('enter:c');
        this.runTask(
          () => Promise.resolve(undefined),
          { on_done: () => { this.sendEvent('go'); } },
        );
      }

      _on_enter__done() {
        this.log.push('enter:done');
      }
    }

    const actor = new StepActor();
    actor.start();
    expect(actor.state()).toBe('a');
    expect(actor.log).toEqual(['enter:a']);

    await eventually(() => expect(actor.state()).toBe('done'));
    expect(actor.log).toEqual(['enter:a', 'enter:b', 'enter:c', 'enter:done']);
  });

  it('calls the initial state enter hook', () => {
    class EnterActor extends BaseActor {
      static _actor = {
        initial: 'ready',
        states: {
          ready: { on: { go: 'done' } },
          done: { terminal: true },
        },
      };
      entered = false;
      _on_enter__ready() {
        this.entered = true;
        this.runTask(
          () => Promise.resolve(undefined),
          { on_done: () => { this.sendEvent('go'); } },
        );
      }
    }

    const actor = new EnterActor();
    actor.start();
    expect(actor.entered).toBe(true);
  });

  it('can restart from a terminal state', async () => {
    class RestartableActor extends BaseActor {
      static _actor = {
        initial: 'ready',
        states: {
          ready: { on: { finish: 'done' } },
          done: { terminal: true },
        },
      };
      entered = 0;

      _on_enter__ready() {
        this.entered += 1;
        this.runTask(
          () => Promise.resolve(undefined),
          { on_done_event: 'finish' },
        );
      }
    }

    const actor = new RestartableActor();
    actor.start();
    await eventually(() => expect(actor.state()).toBe('done'));

    actor.start();

    expect(actor.state()).toBe('ready');
    expect(actor.entered).toBe(2);
  });

  it('rejects starting from a non-terminal state', () => {
    class RunningActor extends BaseActor {
      static _actor = {
        initial: 'running',
        states: {
          running: { on: { finish: 'done' } },
          done: { terminal: true },
        },
      };

      _on_enter__running() {
        this.runTask(() => new Promise(() => {}));
      }
    }

    const actor = new RunningActor();
    actor.start();

    expect(() => actor.start()).toThrow(InternalActorError);
  });
});

describe('_on_state_changed', () => {
  it('fires on start with oldState undefined before _on_enter', () => {
    class TestActor extends BaseActor {
      static _actor = {
        initial: 'idle',
        states: {
          idle: { terminal: true },
        },
      };
      log: string[] = [];

      protected _on_state_changed(oldState: string | undefined, newState: string): void {
        this.log.push(`changed:${oldState ?? 'undefined'}:${newState}`);
      }

      _on_enter__idle() {
        this.log.push('enter:idle');
      }
    }

    const actor = new TestActor();
    actor.start();

    expect(actor.log).toEqual(['changed:undefined:idle', 'enter:idle']);
  });

  it('fires on state transition with old and new state before _on_enter', async () => {
    class TestActor extends BaseActor {
      static _actor = {
        initial: 'idle',
        states: {
          idle: { parked: true, on: { go: 'active' } },
          active: { terminal: true },
        },
      };
      log: string[] = [];

      protected _on_state_changed(oldState: string | undefined, newState: string): void {
        this.log.push(`changed:${oldState}:${newState}`);
      }

      _on_enter__idle() {
        this.log.push('enter:idle');
      }

      _on_enter__active() {
        this.log.push('enter:active');
      }

      go() {
        this.parkedSendEvent('go');
      }
    }

    const actor = new TestActor();
    actor.start();
    actor.log = [];
    actor.go();

    await eventually(() => expect(actor.log).toEqual(['changed:idle:active', 'enter:active']));
  });

  it('does not fire when dispatch returns the same state', async () => {
    class TestActor extends BaseActor {
      static _actor = {
        initial: 'idle',
        states: {
          idle: { parked: true, on: { noop: 'idle' } },
        },
      };
      changes = 0;

      protected _on_state_changed(): void {
        this.changes++;
      }

      noop() {
        this.parkedSendEvent('noop');
      }
    }

    const actor = new TestActor();
    actor.start();
    const initial = actor.changes;
    actor.noop();

    await eventually(() => expect(actor.state()).toBe('idle'));
    expect(actor.changes).toBe(initial);
  });
});

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 20; i++) {
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
