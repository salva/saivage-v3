import { describe, expect, it } from '@jest/globals';
import { Actor, BaseActor, createActorWithOptions } from '../../../src/runtime/fsm/index.js';

@Actor({
  initial: 'idle',
  states: {
    idle: { on: { start: 'active' } },
    active: { on: { incremented: 'active' } },
  },
})
class CounterActor extends BaseActor {
  count = 0;

  _on_call__idle__start() {
    this.count += 1;
    this.send('start');
  }

  _on_call__active__increment() {
    this.count += 1;
    this.send('incremented');
  }
}

describe('createActor', () => {
  it('creates a live actor with initial state and send(event)', async () => {
    const errors: unknown[] = [];
    const actor = createActorWithOptions(CounterActor, {
      onError: (error) => { errors.push(error); },
    });

    expect(actor.state()).toBe('idle');
    expect(actor.count).toBe(0);

    actor.call('start');
    await eventually(() => expect(actor.state()).toBe('active'));

    expect(actor.count).toBe(1);
    expect(errors).toEqual([]);
  });

  it('serializes messages through the actor queue', async () => {
    const actor = createActorWithOptions(CounterActor, {
      onError: (error) => { throw error; },
    });

    actor.call('start');
    await eventually(() => expect(actor.state()).toBe('active'));
    actor.call('increment');
    actor.call('increment');

    await eventually(() => expect(actor.count).toBe(3));
    expect(actor.state()).toBe('active');
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
