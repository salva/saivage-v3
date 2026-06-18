import { describe, expect, it } from '@jest/globals';
import { BaseActor, InternalActorError, recoverActor, startActor } from '../../../src/runtime/micro-actor/index.js';

describe('startActor', () => {
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
        this._run_task(
          () => Promise.resolve(undefined),
          { on_done: () => { this._send_event('go'); } },
        );
      }

      _on_enter__b() {
        this.log.push('enter:b');
        this._run_task(
          () => Promise.resolve(undefined),
          { on_done: () => { this._send_event('go'); } },
        );
      }

      _on_enter__c() {
        this.log.push('enter:c');
        this._run_task(
          () => Promise.resolve(undefined),
          { on_done: () => { this._send_event('go'); } },
        );
      }

      _on_enter__done() {
        this.log.push('enter:done');
      }
    }

    const actor = startActor(StepActor);
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
        this._run_task(
          () => Promise.resolve(undefined),
          { on_done: () => { this._send_event('go'); } },
        );
      }
    }

    const actor = startActor(EnterActor);
    expect(actor.entered).toBe(true);
  });
});

describe('recoverActor', () => {
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
        this._run_task(
          () => Promise.resolve(undefined),
          { on_done: () => { this._send_event('done'); } },
        );
      }
    }

    const actor = recoverActor(RecoverableActor, 'running');

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
        this._run_task(
          () => Promise.resolve(undefined),
          { on_done: () => { this._send_event('done'); } },
        );
      }
    }

    const actor = recoverActor(RecoverableActor, 'running');

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

    expect(() => recoverActor(RecoverableActor, 'missing')).toThrow('unknown state');
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

    expect(() => recoverActor(RecoverableActor, 'idle')).toThrow('recover failed');
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