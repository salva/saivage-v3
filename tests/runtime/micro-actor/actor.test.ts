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

describe('recover', () => {
  it('restores the requested state and calls the recover hook', () => {
    class RecoverableActor extends BaseActor {
      static _actor = {
        initial: 'idle',
        states: {
          idle: { terminal: true },
          running: { on: { done: 'idle' } },
        },
      };

      log: string[] = [];

      _on_recover__running() {
        this.log.push(`recover:${this.state()}`);
        this.runTask(
          () => Promise.resolve(undefined),
          { on_done: () => { this.sendEvent('done'); } },
        );
      }
    }

    const actor = new RecoverableActor();
    actor.recover('running');

    expect(actor.state()).toBe('running');
    expect(actor.log).toEqual(['recover:running']);
  });

  it('falls back to enter hook when recover hook is missing', () => {
    class RecoverableActor extends BaseActor {
      static _actor = {
        initial: 'idle',
        states: {
          idle: { terminal: true },
          running: { on: { done: 'idle' } },
        },
      };

      log: string[] = [];

      _on_enter__running() {
        this.log.push(`enter:${this.state()}`);
        this.runTask(
          () => Promise.resolve(undefined),
          { on_done: () => { this.sendEvent('done'); } },
        );
      }
    }

    const actor = new RecoverableActor();
    actor.recover('running');

    expect(actor.state()).toBe('running');
    expect(actor.log).toEqual(['enter:running']);
  });

  it('rejects unknown recovered states', () => {
    class RecoverableActor extends BaseActor {
      static _actor = {
        states: {
          idle: {},
        },
      };
    }

    const actor = new RecoverableActor();
    expect(() => actor.recover('missing')).toThrow('unknown state');
  });

  it('rejects recovery after start', () => {
    class RecoverableActor extends BaseActor {
      static _actor = {
        states: {
          idle: { terminal: true },
        },
      };
    }

    const actor = new RecoverableActor();
    actor.start();

    expect(() => actor.recover('idle')).toThrow(InternalActorError);
  });

  it('rejects recovery after recovery', () => {
    class RecoverableActor extends BaseActor {
      static _actor = {
        states: {
          idle: { terminal: true },
        },
      };
    }

    const actor = new RecoverableActor();
    actor.recover('idle');

    expect(() => actor.recover('idle')).toThrow(InternalActorError);
  });

  it('reports recover hook errors through actor recovery', () => {
    class RecoverableActor extends BaseActor {
      static _actor = {
        states: {
          idle: { on: { done: 'idle' } },
        },
      };

      _on_recover__idle() {
        throw new Error('recover failed');
      }
    }

    const actor = new RecoverableActor();
    expect(() => actor.recover('idle')).toThrow('recover failed');
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

  it('does not fire on recover', () => {
    class TestActor extends BaseActor {
      static _actor = {
        states: {
          idle: { terminal: true },
          running: { parked: true, on: { done: 'idle' } },
        },
      };
      changes = 0;

      protected _on_state_changed(): void {
        this.changes++;
      }

      _on_recover__running() {}
    }

    const actor = new TestActor();
    actor.recover('running');

    expect(actor.changes).toBe(0);
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
