import { describe, it, expect } from '@jest/globals';
import {
  Actor,
  BaseActor,
  dispatchCall,
  dispatchEvent,
  getActorDefinition,
  InvalidActorDefinitionError,
  InvalidTransitionError,
  MissingCallHandlerError,
  createActor,
} from '../../../src/runtime/fsm/index.js';

@Actor({
  initial: 'off',
  states: {
    off: { on: { toggle: 'on' } },
    on: { on: { toggle: 'off', flicker: 'broken' } },
    broken: { on: { replace: 'off' } },
  },
})
class LightActor extends BaseActor {
  flickerCount = 0;
  log: string[] = [];

  _on_enter__on() {
    this.log.push(`entered on, state now ${this.state()}`);
  }

  _on_enter__broken() {
    this.flickerCount += 1;
  }

  _on_leave__broken() {
    this.log.push(`leaving broken after ${this.flickerCount} flickers`);
  }
}

describe('@Actor', () => {
  it('registers actor definitions per class', () => {
    expect(getActorDefinition(LightActor).initial).toBe('off');
  });

  it('rejects empty definitions', () => {
    expect(() => Actor({ states: {} })).toThrow(InvalidActorDefinitionError);
  });

  it('rejects initial state not in states', () => {
    expect(() => Actor({ initial: 'missing', states: { off: {} } }))
      .toThrow(InvalidActorDefinitionError);
  });

  it('rejects duplicate states in sequence', () => {
    expect(() => Actor({ sequence: ['a', 'a'], states: { a: {}, b: {} } }))
      .toThrow(InvalidActorDefinitionError);
  });

  it('rejects transition target not in states', () => {
    expect(() => Actor({ states: { off: { on: { go: 'missing' } } } }))
      .toThrow(InvalidActorDefinitionError);
  });
});

describe('dispatchEvent', () => {
  it('handles direct string transition', () => {
    const actor = createActor(LightActor);

    dispatchEvent(actor, { kind: 'event', name: 'toggle' });

    expect(actor.state()).toBe('on');
  });

  it('ignores unknown events', () => {
    const actor = createActor(LightActor);

    dispatchEvent(actor, { kind: 'event', name: 'unknown_event' });

    expect(actor.state()).toBe('off');
  });

  it('fires enter on transition', () => {
    const actor = createActor(LightActor);

    dispatchEvent(actor, { kind: 'event', name: 'toggle' });

    expect(actor.log).toEqual(['entered on, state now on']);
  });

  it('fires leave on transition', () => {
    const actor = createActor(LightActor);

    dispatchEvent(actor, { kind: 'event', name: 'toggle' });
    dispatchEvent(actor, { kind: 'event', name: 'flicker' });
    dispatchEvent(actor, { kind: 'event', name: 'replace' });

    expect(actor.log).toContain('leaving broken after 1 flickers');
  });

  it('does not fire leave or enter when staying in same state', () => {
    @Actor({ states: { closed: { on: { stay: 'closed' } } } })
    class DoorActor extends BaseActor {
      entered = 0;
      left = 0;
      _on_enter__closed() { this.entered += 1; }
      _on_leave__closed() { this.left += 1; }
    }

    const actor = createActor(DoorActor);
    dispatchEvent(actor, { kind: 'event', name: 'stay' });

    expect(actor.entered).toBe(0);
    expect(actor.left).toBe(0);
  });

  it('advances done inside sequence', () => {
    @Actor({ sequence: ['a', 'b', 'c'], states: { a: {}, b: {}, c: {} } })
    class StepActor extends BaseActor {}

    const actor = createActor(StepActor);

    dispatchEvent(actor, { kind: 'event', name: 'done' });
    expect(actor.state()).toBe('b');
    dispatchEvent(actor, { kind: 'event', name: 'done' });
    expect(actor.state()).toBe('c');
    dispatchEvent(actor, { kind: 'event', name: 'done' });
    expect(actor.state()).toBe('c');
  });

  it('throws InvalidTransitionError for unknown current state', () => {
    const actor = createActor(LightActor);
    actor._setStateForRuntime('nonexistent');

    expect(() => dispatchEvent(actor, { kind: 'event', name: 'toggle' }))
      .toThrow(InvalidTransitionError);
  });

  it('rejects promise-returning hooks', () => {
    @Actor({ states: { idle: { on: { start: 'running' } }, running: {} } })
    class BadActor extends BaseActor {
      _on_enter__running() { return Promise.resolve(); }
    }

    const actor = createActor(BadActor);
    expect(() => dispatchEvent(actor, { kind: 'event', name: 'start' }))
      .toThrow(InvalidTransitionError);
  });
});

describe('dispatchCall', () => {
  it('invokes convention call handlers with args', () => {
    @Actor({ states: { idle: { on: { started: 'running' } }, running: {} } })
    class WorkerActor extends BaseActor {
      reason = '';
      _on_call__idle__run(args: { reason: string }) {
        this.reason = args.reason;
        this.send('started');
      }
    }

    const actor = createActor(WorkerActor);
    dispatchCall(actor, { kind: 'call', name: 'run', args: { reason: 'test' } });

    expect(actor.reason).toBe('test');
  });

  it('supports explicit call method override', () => {
    @Actor({
      states: {
        idle: { calls: { run: 'handleRun' } },
      },
    })
    class WorkerActor extends BaseActor {
      called = false;
      handleRun() { this.called = true; }
    }

    const actor = createActor(WorkerActor);
    dispatchCall(actor, { kind: 'call', name: 'run' });

    expect(actor.called).toBe(true);
  });

  it('throws for missing call handlers', () => {
    const actor = createActor(LightActor);

    expect(() => dispatchCall(actor, { kind: 'call', name: 'missing' }))
      .toThrow(MissingCallHandlerError);
  });

  it('treats false call override as disabled no-op', () => {
    @Actor({ states: { idle: { calls: { noop: false } } } })
    class WorkerActor extends BaseActor {}

    const actor = createActor(WorkerActor);

    expect(() => dispatchCall(actor, { kind: 'call', name: 'noop' })).not.toThrow();
  });
});
