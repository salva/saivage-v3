# Declarative Micro-Actor Module Architecture

Date: 2026-06-19.

Status: current frozen implementation contract.

## Freeze Policy

`src/runtime/micro-actor/micro-actor.ts` is frozen. Do not modify the `BaseActor` design or implementation directly. If a limitation or bug is found, report it to the user; the user decides whether and how the frozen core changes.

## Purpose

The micro-actor module provides a small deterministic state-machine core for local TypeScript actor objects. It owns only actor-local runtime mechanics: compiled transition tables, current state, one pending internal event, parked-state wakeups, state-scoped tasks, lifecycle entry points, and convention-based hooks.

The core module does not persist state and does not own domain storage. Callers persist domain data and reconstruct actor instances as needed.

## Module Layout

- `micro-actor.ts`: frozen core implementation, definition compiler, `BaseActor`, `TimeoutError`, `InternalActorError`, and actor definition validation.
- `slave-actor.ts`: job-queue helper base for externally addressable actors.
- `simple-slave-actor.ts`: optional serial worker specialization built on `SlaveActor`.

## Actor Definitions

Actor classes declare static `_actor` transition data:

```ts
class ExampleActor extends BaseActor {
  static _actor = {
    initial: 'idle',
    states: {
      idle: { on: { start: 'running' } },
      running: { on: { done: 'done', failed: 'failed' } },
      done: { terminal: true },
      failed: { terminal: true },
    },
  };
}
```

Definitions are compiled lazily the first time a class is started or recovered. Compilation is cached on the concrete constructor as `_compiled_actor`. Lookup uses the nearest constructor in the JavaScript static inheritance chain that owns `_actor`; a subclass-owned `_actor` overrides an ancestor definition.

Compilation validates:

- at least one state exists;
- state names are non-empty;
- `initial`, when declared, exists;
- sequence states exist, are unique, and are not terminal;
- terminal states declare no transitions;
- states are not both terminal and parked;
- event names are non-empty;
- all transition targets exist.

The source `StateDefinition.on` field may be omitted. The compiled state always has an `on` object, possibly empty, so runtime dispatch is a direct lookup: `stateDef.on[eventName]`.

`StateDefinition.parked` declares a state that is idle but externally advanceable. Parked states may declare normal `on` transitions. The actor pump stops when it reaches a parked state, and actor public methods can later wake it through protected `parkedSendEvent(...)`.

`sequence: ['a', 'b', 'c']` is compiled into default `done` transitions. A state-owned `on.done` declaration overrides the sequence default.

## BaseActor Lifecycle

Actors are regular class instances. They become live through one of two methods:

- `start()`: allowed on a never-started actor, or on an actor whose current state is terminal. It compiles the class definition, moves the actor to the declared initial state, calls `_on_enter__{initial}` when present, and starts the main loop.
- `recover(state)`: allowed only on an actor that has never been run (`state()` has not been initialized). It compiles the class definition, validates `state`, moves the actor to that state, calls `_on_recover__{state}` when present, otherwise `_on_enter__{state}`, and starts the main loop.

`recover()` cannot be called after `start()` or after another `recover()`.

Runtime state is held in JavaScript `#private` fields on `BaseActor`. The public read API is `state()`.

## Subclass API

Actor subclasses may use three protected methods:

```ts
protected sendEvent(name: string): void;
protected parkedSendEvent(name: string): void;
protected runTask<Result>(
  run: (signal: AbortSignal) => Promise<Result>,
  options?: RunTaskOptions<Result>,
): void;
```

`sendEvent(name)` sets the single pending internal event. It throws if another event is already pending. Events are strings and carry no payload; event-specific data belongs on actor fields.

`parkedSendEvent(name)` is for actor public methods that need to advance from a parked state. It verifies the current state is parked, queues the event with the same single-slot event rules as `sendEvent(name)`, and ensures the actor pump is running so the transition is handled. It is still protected; external callers use domain-specific actor methods rather than raw event names.

`runTask(...)` starts state-scoped async work. It returns `void`. Task completion is routed back through the actor main loop. It rejects tasks started from terminal or parked states.

## Task Options

`RunTaskOptions<Result>`:

```ts
type RunTaskOptions<Result = unknown> = {
  on_done?: (result: Result) => void;
  on_failed?: (error: Error) => void;
  on_timeout?: (error: TimeoutError) => void;
  on_done_event?: string;
  on_failed_event?: string;
  on_timeout_event?: string;
  timeout?: number;
};
```

Callbacks and event shortcuts are alternatives:

- success calls `on_done(result)` when present; otherwise it sends `on_done_event ?? 'done'`;
- failure calls `on_failed(error)` when present; otherwise it sends `on_failed_event ?? 'failed'`;
- timeout calls `on_timeout(error)` when present; otherwise sends `on_timeout_event` when present; otherwise falls through to failure handling.

`timeout: 0` is normalized to no timeout. A non-zero timeout aborts the task signal with `TimeoutError` and waits for the task promise to settle cooperatively before reporting timeout.

`TaskResult` stores successful values and errors in separate fields internally (`result` vs `error`). The `runTask<Result>` generic links the task promise result to `on_done(result)`.

## Actor Main Loop

The main loop repeatedly:

1. consumes one pending event, if present;
2. dispatches by direct compiled transition-table lookup;
3. exits if the current state is terminal;
4. parks if the current state is parked;
5. throws and logs an `InternalActorError` if a non-terminal, non-parked state has no pending event and no state tasks;
6. awaits the first state task completion;
7. invokes the task completion callback or event shortcut.

Main-loop errors are logged with `console.error('BaseActor main loop failed', error)` and the loop exits.

State changes call `_on_leave__{oldState}` before changing state, abort and clear all state tasks, then call `_on_enter__{newState}`.

## Recovery Hooks

Recovery hooks are synchronous actor hooks. They may rebuild live in-memory resources and may start tasks or emit one event through the protected subclass API. If `_on_recover__{state}` is absent, `BaseActor` falls back to `_on_enter__{state}`.

## SlaveActor Boundary

`BaseActor` has no external command queue. `SlaveActor` adds the public job-queue boundary for subclasses that need external work delivery:

```ts
actor.submitJob(load, callbacks?) // returns jobId
actor.cancelJob(jobId)
```

The returned job ID is the stable handle external code uses for later cancellation. The protected actor-task side is deliberately small:

```ts
this.waitForJob(signal)
this.dequeueJob()
```

`waitForJob(signal)` is the method intended to be run through `runTask(...)` while the actor is in a waiting state. Completion means a job may be available; actor code should synchronously call `dequeueJob()` from the task callback. If the job was cancelled before the callback runs, `dequeueJob()` returns `undefined` and the actor can wait again.

`SlaveActor` is not an actor definition by itself; subclasses own their states and decide how queued jobs map onto state transitions. `SimpleSlaveActor` provides the default serial worker shape.

Jobs are external work items, not state-transition events. Actor code remains responsible for translating job availability and work outcomes into internal events.

## Tests

Focused coverage lives under `tests/runtime/micro-actor/` and covers definition compilation, lifecycle start/recover, task completion, timeout behavior, and `SimpleSlaveActor` serial job behavior.
