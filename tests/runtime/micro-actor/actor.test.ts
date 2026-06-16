import { describe, expect, it } from '@jest/globals';
import { BaseActor, recoverActor, SlaveActor, startActor } from '../../../src/runtime/micro-actor/index.js';

class CounterActor extends SlaveActor {
  static _actor = {
    initial: 'idle',
    states: {
      idle: { on: { start: 'active' } },
      active: { on: { incremented: 'active' } },
    },
  };

  count = 0;

  _on_call__idle__start() {
    this.count += 1;
    this._send_event('start');
  }

  _on_call__active__increment() {
    this.count += 1;
    this._send_event('incremented');
  }
}

describe('startActor', () => {
  it('creates a live actor with initial state and internal events', async () => {
    const actor = startActor(CounterActor);

    expect(actor.state()).toBe('idle');
    expect(actor.count).toBe(0);

    actor.mailbox.deliver('start');
    await eventually(() => expect(actor.state()).toBe('active'));

    expect(actor.count).toBe(1);
  });

  it('serializes messages through the actor queue', async () => {
    const actor = startActor(CounterActor);

    actor.mailbox.deliver('start');
    await eventually(() => expect(actor.state()).toBe('active'));
    actor.mailbox.deliver('increment');
    actor.mailbox.deliver('increment');

    await eventually(() => expect(actor.count).toBe(3));
    expect(actor.state()).toBe('active');
  });
});

describe('recoverActor', () => {
  it('restores the requested state and calls the state recover hook', () => {
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

  it('falls back to enter hook when recover hook is missing', () => {
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
