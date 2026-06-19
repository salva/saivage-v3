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
