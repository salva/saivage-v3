import { describe, expect, it } from '@jest/globals';
import { BaseActor, recoverActor, startActor } from '../../../src/runtime/micro-actor/index.js';
import type { ActorDefinition } from '../../../src/runtime/micro-actor/index.js';

class CounterActor extends BaseActor {
  static _actor = {
    initial: 'idle',
    states: {
      idle: { on: { start: 'active' } },
      active: { on: { stop: 'done' } },
      done: {} as Record<string, string>,
    },
  };

  count = 0;

  _on_enter__active() {
    this.count += 1;
  }
}

describe('startActor', () => {
  it('creates a live actor with initial state and processes events', async () => {
    const actor = startActor(CounterActor);

    expect(actor.state()).toBe('idle');
    expect(actor.count).toBe(0);

    (actor as any)._send_event('start');
    await eventually(() => expect(actor.state()).toBe('active'));

    expect(actor.count).toBe(1);
  });

  it('processes multiple events sequentially', async () => {
    class StepActor extends BaseActor {
      static _actor = {
        initial: 'a',
        states: {
          a: { on: { go: 'b' } },
          b: { on: { go: 'c' } },
          c: { on: { go: 'a' } },
        },
      };
      log: string[] = [];
      _on_enter__a() { this.log.push('a'); }
      _on_enter__b() { this.log.push('b'); }
      _on_enter__c() { this.log.push('c'); }
    }

    const actor = startActor(StepActor);
    expect(actor.state()).toBe('a');
    expect(actor.log).toEqual(['a']);

    (actor as any)._send_event('go');
    (actor as any)._send_event('go');
    (actor as any)._send_event('go');

    await eventually(() => expect(actor.state()).toBe('a'));
    expect(actor.log).toEqual(['a', 'b', 'c', 'a']);
  });

  it('calls the initial state enter hook', () => {
    class EnterActor extends BaseActor {
      static _actor = {
        initial: 'ready',
        states: {
          ready: {},
        },
      };
      entered = false;
      _on_enter__ready() { this.entered = true; }
    }

    const actor = startActor(EnterActor);
    expect(actor.entered).toBe(true);
  });
});

describe('recoverActor', () => {
  it('restores the requested state and calls the state recover hook', async () => {
    class RecoverableActor extends BaseActor {
      static _actor = {
        initial: 'idle',
        states: {
          idle: {},
          running: {},
        },
      };

      log: string[] = [];

      _on_recover__running() {
        this.log.push(`recover:${this.state()}`);
      }

      _on_enter__running() {
        this.log.push('enter fallback should not run');
      }
    }

    const actor = recoverActor(RecoverableActor, 'running');

    expect(actor.state()).toBe('running');
    expect(actor.log).toEqual(['recover:running']);
  });

  it('falls back to enter hook when recover hook is missing', async () => {
    class RecoverableActor extends BaseActor {
      static _actor = {
        initial: 'idle',
        states: {
          idle: {},
          running: {},
        },
      };

      log: string[] = [];

      _on_enter__running() {
        this.log.push(`enter:${this.state()}`);
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
          idle: {},
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