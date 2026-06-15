import { describe, it, expect } from '@jest/globals';
import {
  BaseActor,
  compileActorDefinition,
  dispatchCall,
  dispatchEvent,
  InvalidActorDefinitionError,
  InvalidTransitionError,
  MissingCallHandlerError,
  createActor,
} from '../../../src/runtime/fsm/index.js';
import type { ActorDefinition, CompiledActorDefinition } from '../../../src/runtime/fsm/index.js';

class LightActor extends BaseActor {
  static _actor: ActorDefinition = {
    initial: 'off',
    states: {
      off: { on: { toggle: 'on' } },
      on: { on: { toggle: 'off', flicker: 'broken' } },
      broken: { on: { replace: 'off' } },
    },
  };
  static _compiled_actor?: CompiledActorDefinition;

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

describe('actor definition compilation', () => {
  it('compiles actor definitions lazily per class', () => {
    const ctor = LightActor as typeof LightActor & { _compiled_actor?: CompiledActorDefinition };
    delete ctor._compiled_actor;
    expect(ctor._compiled_actor).toBeUndefined();
    const actor = createActor(ctor);
    expect(actor.state()).toBe('off');
    const compiled = (ctor as { _compiled_actor?: CompiledActorDefinition })._compiled_actor;
    expect(compiled?.initial).toBe('off');
  });

  it('rejects empty definitions', () => {
    expect(() => compileActorDefinition({ states: {} })).toThrow(InvalidActorDefinitionError);
  });

  it('rejects initial state not in states', () => {
    expect(() => compileActorDefinition({ initial: 'missing', states: { off: {} } }))
      .toThrow(InvalidActorDefinitionError);
  });

  it('rejects duplicate states in sequence', () => {
    expect(() => compileActorDefinition({ sequence: ['a', 'a'], states: { a: {}, b: {} } }))
      .toThrow(InvalidActorDefinitionError);
  });

  it('rejects transition target not in states', () => {
    expect(() => compileActorDefinition({ states: { off: { on: { go: 'missing' } } } }))
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
    class DoorActor extends BaseActor {
      static _actor = { states: { closed: { on: { stay: 'closed' } } } };
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
    class StepActor extends BaseActor {
      static _actor = { sequence: ['a', 'b', 'c'], states: { a: {}, b: {}, c: {} } };
    }

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
    class BadActor extends BaseActor {
      static _actor = { states: { idle: { on: { start: 'running' } }, running: {} } };
      _on_enter__running() { return Promise.resolve(); }
    }

    const actor = createActor(BadActor);
    expect(() => dispatchEvent(actor, { kind: 'event', name: 'start' }))
      .toThrow(InvalidTransitionError);
  });
});

describe('dispatchCall', () => {
  it('invokes convention call handlers with args', () => {
    class WorkerActor extends BaseActor {
      static _actor = { states: { idle: { on: { started: 'running' } }, running: {} } };
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
    class WorkerActor extends BaseActor {
      static _actor = {
        states: {
          idle: { calls: { run: 'handleRun' } },
        },
      };

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
    class WorkerActor extends BaseActor {
      static _actor: ActorDefinition = { states: { idle: { calls: { noop: false } } } };
    }

    const actor = createActor(WorkerActor);

    expect(() => dispatchCall(actor, { kind: 'call', name: 'noop' })).not.toThrow();
  });
});
