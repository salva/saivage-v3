import { describe, it, expect } from '@jest/globals';
import { defineMachine, dispatch, InvalidTransitionError, InvalidMachineDefinitionError } from '../../../src/runtime/fsm/index.js';
import type { Event, Command, MachineSelf, HandlerResult } from '../../../src/runtime/fsm/index.js';

type LightState = 'off' | 'on' | 'broken';
type LightCommand = { type: 'replace_bulb' } | { type: 'log'; message: string };
type LightSelf = MachineSelf<LightState> & { flickerCount: number };

const lightMachine = defineMachine<LightState, LightSelf, LightCommand>({
  initial: 'off',
  states: {
    off: {
      on: {
        toggle: 'on',
      },
    },
    on: {
      on: {
        toggle: 'off',
        flicker: ({ self }) => {
          self.flickerCount += 1;
          return { state: 'broken' };
        },
      },
      on_enter: ({ self }) => ({
        commands: [{ type: 'log', message: `entered on, state now ${self.state()}` }],
      }),
    },
    broken: {
      on_leave: (self) => ({
        commands: [{ type: 'log', message: `leaving broken after ${self.flickerCount} flickers` }],
      }),
      on: {
        replace: ({ self, event }) => {
          return { state: 'off', commands: [{ type: 'replace_bulb' }] };
        },
      },
    },
  },
});

function makeLightSelf(state: LightState = 'off'): LightSelf {
  return {
    _sm: { state },
    state() { return this._sm.state; },
    send() {},
    flickerCount: 0,
  };
}

describe('defineMachine', () => {
  it('rejects initial state not in states', () => {
    expect(() =>
      defineMachine({
        initial: 'missing' as any,
        states: { off: {} },
      })
    ).toThrow(InvalidMachineDefinitionError);
  });

  it('rejects duplicate states in sequence', () => {
    expect(() =>
      defineMachine({
        initial: 'a' as any,
        sequence: ['a', 'a'] as any,
        states: { a: {}, b: {} },
      })
    ).toThrow(InvalidMachineDefinitionError);
  });

  it('rejects sequence state not in states', () => {
    expect(() =>
      defineMachine({
        initial: 'a' as any,
        sequence: ['a', 'missing'] as any,
        states: { a: {} },
      })
    ).toThrow(InvalidMachineDefinitionError);
  });

  it('rejects transition target not in states', () => {
    expect(() =>
      defineMachine({
        initial: 'off' as any,
        states: {
          off: { on: { go: 'missing' as any } },
        },
      })
    ).toThrow(InvalidMachineDefinitionError);
  });

  it('accepts a valid definition', () => {
    const machine = defineMachine({
      initial: 'off',
      states: { off: { on: { go: 'off' } } },
    });
    expect(machine.initial).toBe('off');
  });
});

describe('dispatch', () => {
  it('handles direct string transition', () => {
    const self = makeLightSelf('off');
    const result = dispatch(lightMachine, self, { name: 'toggle' });
    expect(result.state).toBe('on');
    expect(self._sm.state).toBe('on');
  });

  it('handles handler transition', () => {
    const self = makeLightSelf('on');
    const result = dispatch(lightMachine, self, { name: 'flicker' });
    expect(result.state).toBe('broken');
    expect(self.flickerCount).toBe(1);
  });

  it('ignores unknown events', () => {
    const self = makeLightSelf('off');
    const result = dispatch(lightMachine, self, { name: 'unknown_event' });
    expect(result.state).toBe('off');
    expect(result.commands).toEqual([]);
  });

  it('fires on_enter on transition', () => {
    const self = makeLightSelf('off');
    const result = dispatch(lightMachine, self, { name: 'toggle' });
    expect(result.state).toBe('on');
    expect(result.commands).toEqual([{ type: 'log', message: 'entered on, state now on' }]);
  });

  it('fires on_leave on transition', () => {
    const self = makeLightSelf('broken');
    const result = dispatch(lightMachine, self, { name: 'replace' });
    expect(result.state).toBe('off');
    expect(result.commands).toEqual([
      { type: 'log', message: 'leaving broken after 0 flickers' },
      { type: 'replace_bulb' },
    ]);
  });

  it('does not fire on_leave when staying in same state', () => {
    type DoorState = 'closed' | 'open';
    type DoorSelf = MachineSelf<DoorState> & { leaveCalled: boolean };
    const doorMachine = defineMachine<DoorState, DoorSelf, never>({
      initial: 'closed',
      states: {
        closed: {
          on_leave: (self) => { self.leaveCalled = true; },
          on: { open: 'open' },
        },
        open: {
          on: { close: 'closed' },
        },
      },
    });
    const self: DoorSelf = {
      _sm: { state: 'closed' },
      state() { return this._sm.state; },
      send() {},
      leaveCalled: false,
    };
    dispatch(doorMachine, self, { name: 'open' });
    expect(self.leaveCalled).toBe(true);

    self.leaveCalled = false;
    dispatch(doorMachine, self, { name: 'open' });
    expect(self.leaveCalled).toBe(false);
  });

  it('does not fire on_enter for initial state', () => {
    type CounterState = 'idle' | 'counting';
    type CounterSelf = MachineSelf<CounterState> & { enteredIdle: boolean };
    const counterMachine = defineMachine<CounterState, CounterSelf, never>({
      initial: 'idle',
      states: {
        idle: {
          on_enter: () => ({ commands: [] as never[] }),
          on: { start: 'counting' },
        },
        counting: {
          on: { done: 'idle' },
        },
      },
    });
    const self: CounterSelf = {
      _sm: { state: 'idle' },
      state() { return this._sm.state; },
      send() {},
      enteredIdle: false,
    };
    const result = dispatch(counterMachine, self, { name: 'start' });
    expect(result.state).toBe('counting');

    const result2 = dispatch(counterMachine, self, { name: 'done' });
    expect(result2.state).toBe('idle');
  });

  it('concatenates commands in order: on_leave, handler, on_enter', () => {
    type StepState = 'a' | 'b';
    type StepCommand = { type: string };
    type StepSelf = MachineSelf<StepState>;
    const stepMachine = defineMachine<StepState, StepSelf, StepCommand>({
      initial: 'a',
      states: {
        a: {
          on_leave: () => ({ commands: [{ type: 'leave_a' }] }),
          on: {
            go: () => ({
              state: 'b' as StepState,
              commands: [{ type: 'handler_a' }],
            }),
          },
        },
        b: {
          on_enter: () => ({ commands: [{ type: 'enter_b' }] }),
          on: { back: 'a' },
        },
      },
    });
    const self: StepSelf = {
      _sm: { state: 'a' },
      state() { return this._sm.state; },
      send() {},
    };
    const result = dispatch(stepMachine, self, { name: 'go' });
    expect(result.commands).toEqual([
      { type: 'leave_a' },
      { type: 'handler_a' },
      { type: 'enter_b' },
    ]);
  });

  it('throws InvalidTransitionError for unknown current state', () => {
    const self = { _sm: { state: 'nonexistent' as any }, state() { return this._sm.state; }, send() {} } as any;
    expect(() => dispatch(lightMachine, self, { name: 'toggle' })).toThrow(InvalidTransitionError);
  });

  it('throws InvalidTransitionError for invalid target state from handler', () => {
    type BadState = 'a';
    type BadSelf = MachineSelf<BadState>;
    const badMachine = defineMachine<BadState, BadSelf, never>({
      initial: 'a',
      states: {
        a: {
          on: {
            go: () => ({ state: 'nonexistent' as any }),
          },
        },
      },
    });
    const self: BadSelf = {
      _sm: { state: 'a' },
      state() { return this._sm.state; },
      send() {},
    };
    expect(() => dispatch(badMachine, self, { name: 'go' })).toThrow(InvalidTransitionError);
  });

  it('handler returning undefined stays in same state with no commands', () => {
    const self = makeLightSelf('on');
    const result = dispatch(lightMachine, self, { name: 'flicker', args: {} });
    expect(result.state).toBe('broken');

    const result2 = dispatch(lightMachine, self, { name: 'unknown' });
    expect(result2.state).toBe('broken');
    expect(result2.commands).toEqual([]);
  });

  it('handler returning empty object stays in same state', () => {
    type SimpleState = 'idle' | 'active';
    type SimpleSelf = MachineSelf<SimpleState>;
    const simpleMachine = defineMachine<SimpleState, SimpleSelf, never>({
      initial: 'idle',
      states: {
        idle: {
          on: {
            activate: 'active',
            noop: () => ({}),
          },
        },
        active: {
          on: { deactivate: 'idle' },
        },
      },
    });
    const self: SimpleSelf = {
      _sm: { state: 'idle' },
      state() { return this._sm.state; },
      send() {},
    };
    const result = dispatch(simpleMachine, self, { name: 'noop' });
    expect(result.state).toBe('idle');
    expect(result.commands).toEqual([]);
  });

  it('handler can emit commands without transitioning', () => {
    type EmitState = 'idle';
    type EmitCommand = { type: 'log'; message: string };
    type EmitSelf = MachineSelf<EmitState>;
    const emitMachine = defineMachine<EmitState, EmitSelf, EmitCommand>({
      initial: 'idle',
      states: {
        idle: {
          on: {
            ping: () => ({
              commands: [{ type: 'log', message: 'pinged' }],
            }),
          },
        },
      },
    });
    const self: EmitSelf = {
      _sm: { state: 'idle' },
      state() { return this._sm.state; },
      send() {},
    };
    const result = dispatch(emitMachine, self, { name: 'ping' });
    expect(result.state).toBe('idle');
    expect(result.commands).toEqual([{ type: 'log', message: 'pinged' }]);
  });

  it('rejects promise-returning handlers at runtime', () => {
    type AsyncState = 'idle' | 'done';
    type AsyncSelf = MachineSelf<AsyncState>;
    const asyncMachine = defineMachine<AsyncState, AsyncSelf, never>({
      initial: 'idle',
      states: {
        idle: {
          on: {
            go: (async () => ({ state: 'done' })) as any,
          },
        },
        done: {},
      },
    });
    const self: AsyncSelf = {
      _sm: { state: 'idle' },
      state() { return this._sm.state; },
      send() {},
    };

    expect(() => dispatch(asyncMachine, self, { name: 'go' })).toThrow(InvalidTransitionError);
  });

  it('rejects promise-returning on_enter hooks at runtime', () => {
    type AsyncState = 'idle' | 'done';
    type AsyncSelf = MachineSelf<AsyncState>;
    const asyncMachine = defineMachine<AsyncState, AsyncSelf, never>({
      initial: 'idle',
      states: {
        idle: { on: { go: 'done' } },
        done: {
          on_enter: (async () => ({})) as any,
        },
      },
    });
    const self: AsyncSelf = {
      _sm: { state: 'idle' },
      state() { return this._sm.state; },
      send() {},
    };

    expect(() => dispatch(asyncMachine, self, { name: 'go' })).toThrow(InvalidTransitionError);
  });

  it('rejects promise-returning on_leave hooks at runtime', () => {
    type AsyncState = 'idle' | 'done';
    type AsyncSelf = MachineSelf<AsyncState>;
    const asyncMachine = defineMachine<AsyncState, AsyncSelf, never>({
      initial: 'idle',
      states: {
        idle: {
          on_leave: (async () => ({})) as any,
          on: { go: 'done' },
        },
        done: {},
      },
    });
    const self: AsyncSelf = {
      _sm: { state: 'idle' },
      state() { return this._sm.state; },
      send() {},
    };

    expect(() => dispatch(asyncMachine, self, { name: 'go' })).toThrow(InvalidTransitionError);
  });
});

describe('sequence convention', () => {
  type SeqState = 'pending' | 'running' | 'done';
  type SeqSelf = MachineSelf<SeqState>;

  const seqMachine = defineMachine<SeqState, SeqSelf, never>({
    initial: 'pending',
    sequence: ['pending', 'running', 'done'],
    states: {
      pending: { on: { start: 'running' } },
      running: {},
      done: {},
    },
  });

  function makeSeqSelf(state: SeqState = 'pending'): SeqSelf {
    return {
      _sm: { state },
      state() { return this._sm.state; },
      send() {},
    };
  }

  it('done advances to next state in sequence', () => {
    const self = makeSeqSelf('pending');
    dispatch(seqMachine, self, { name: 'start' });
    expect(self._sm.state).toBe('running');

    const result = dispatch(seqMachine, self, { name: 'done' });
    expect(result.state).toBe('done');
  });

  it('done does not advance from last state in sequence', () => {
    const self = makeSeqSelf('done');
    const result = dispatch(seqMachine, self, { name: 'done' });
    expect(result.state).toBe('done');
    expect(result.commands).toEqual([]);
  });

  it('done does not advance from state not in sequence', () => {
    type NSeqState = 'a' | 'b';
    type NSeqSelf = MachineSelf<NSeqState>;
    const noSeqMachine = defineMachine<NSeqState, NSeqSelf, never>({
      initial: 'a',
      states: {
        a: {},
        b: {},
      },
    });
    const self: NSeqSelf = {
      _sm: { state: 'a' },
      state() { return this._sm.state; },
      send() {},
    };
    const result = dispatch(noSeqMachine, self, { name: 'done' });
    expect(result.state).toBe('a');
  });

  it('explicit done handler overrides sequence advance', () => {
    type OvState = 'a' | 'b' | 'c';
    type OvSelf = MachineSelf<OvState>;
    const ovMachine = defineMachine<OvState, OvSelf, never>({
      initial: 'a',
      sequence: ['a', 'b', 'c'],
      states: {
        a: {},
        b: {
          on: {
            done: 'a',
          },
        },
        c: {},
      },
    });
    const self: OvSelf = {
      _sm: { state: 'b' },
      state() { return this._sm.state; },
      send() {},
    };
    const result = dispatch(ovMachine, self, { name: 'done' });
    expect(result.state).toBe('a');
  });
});

describe('handler mutating self fields', () => {
  it('handler can update domain fields on self', () => {
    type CounterState = 'idle' | 'counting';
    type CounterSelf = MachineSelf<CounterState> & { count: number };
    type CounterCmd = { type: 'log'; message: string };

    const counterMachine = defineMachine<CounterState, CounterSelf, CounterCmd>({
      initial: 'idle',
      states: {
        idle: {
          on: {
            start: ({ self }) => {
              self.count = 0;
              return { state: 'counting' };
            },
          },
        },
        counting: {
          on: {
            increment: ({ self }) => {
              self.count += 1;
              return {};
            },
            finish: 'idle',
          },
        },
      },
    });

    const self: CounterSelf = {
      _sm: { state: 'idle' },
      state() { return this._sm.state; },
      send() {},
      count: 0,
    };

    dispatch(counterMachine, self, { name: 'start' });
    expect(self._sm.state).toBe('counting');
    expect(self.count).toBe(0);

    dispatch(counterMachine, self, { name: 'increment' });
    expect(self.count).toBe(1);

    dispatch(counterMachine, self, { name: 'increment' });
    expect(self.count).toBe(2);

    dispatch(counterMachine, self, { name: 'finish' });
    expect(self._sm.state).toBe('idle');
  });
});
