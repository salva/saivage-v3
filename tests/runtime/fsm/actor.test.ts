import { describe, expect, it } from '@jest/globals';
import { createActor, defineMachine } from '../../../src/runtime/fsm/index.js';
import type { MachineSelf } from '../../../src/runtime/fsm/index.js';

type CounterState = 'idle' | 'active';
type CounterCommand = { type: 'started'; count: number };
type CounterFields = { count: number };
type CounterSelf = MachineSelf<CounterState> & CounterFields;

const counterMachine = defineMachine<CounterState, CounterSelf, CounterCommand>({
  initial: 'idle',
  states: {
    idle: {
      on: {
        start: ({ self }) => {
          self.count += 1;
          return {
            state: 'active',
            commands: [{ type: 'started', count: self.count }],
          };
        },
      },
    },
    active: {
      on: {
        increment: ({ self }) => {
          self.count += 1;
          return {};
        },
      },
    },
  },
});

describe('createActor', () => {
  it('creates a live actor with initial state and send()', async () => {
    const commands: CounterCommand[] = [];
    const errors: unknown[] = [];
    const actor = createActor<CounterState, CounterFields, CounterCommand>({
      machine: counterMachine,
      fields: { count: 0 },
      onCommands: (emitted) => { commands.push(...emitted); },
      onError: (error) => { errors.push(error); },
    });

    expect(actor.state()).toBe('idle');
    expect(actor.count).toBe(0);

    actor.send('start');
    await eventually(() => expect(actor.state()).toBe('active'));

    expect(actor.count).toBe(1);
    expect(commands).toEqual([{ type: 'started', count: 1 }]);
    expect(errors).toEqual([]);
  });

  it('serializes events through the actor queue', async () => {
    const actor = createActor<CounterState, CounterFields, CounterCommand>({
      machine: counterMachine,
      fields: { count: 0 },
      onCommands: () => {},
      onError: (error) => { throw error; },
    });

    actor.send('start');
    actor.send('increment');
    actor.send('increment');

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
