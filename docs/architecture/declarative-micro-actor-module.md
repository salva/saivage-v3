# Declarative Micro-Actor Module Architecture

Date: 2026-06-15.

Status: current runtime-core implementation direction.

## 1. Goal

Define a small TypeScript module for actor-local stateful workers. The module gives Saivage explicit states, deterministic transitions, per-actor command delivery, and conventional lifecycle methods.

The module supports:

- class-level actor definitions;
- declarative state and transition definitions;
- actor-local pump queues for serialized actor work;
- one pending internal event slot per actor turn;
- synchronous transition dispatch;
- convention-based `enter`, `leave`, and `call` methods;
- runtime-owned async work started by actor methods;
- explicit completion events emitted by actor code through `_send_event(name)`.

The micro-actor module is the deterministic core. Actor methods may start runtime-owned async work directly by calling runtime services or `_start_task(...)`. Async completions return through the actor pump; actor code may then emit one internal event for the pump to apply through the state table.

## 2. Core Model

The module has five concepts:

- **Actor definition**: static `_actor` declaration of states and event transitions on each concrete actor class.
- **Actor**: a regular JS/TS class instance with domain fields and methods. Runtime bookkeeping lives in JavaScript private fields on `BaseActor`.
- **Internal event**: a string fact set by actor code with `_send_event(name)` and consumed by the pump through the state's `on` table.
- **Mailbox command**: queued method invocation delivered through `SlaveActor.mailbox.deliver(name, args?)` and handled by state-scoped convention methods.
- **State task**: async work started by `_on_enter__...` or `_on_recover__...` through `_start_task(...)`; unfinished tasks are canceled when the actor leaves that state.
- **Pump queue**: one actor-local async queue that serializes mailbox command delivery and state-task completions.

The core flow is:

```text
actor.mailbox.deliver(name, args) -> pump queue -> state-scoped call method
call/enter/recover hook mutates actor fields -> _send_event(name)
pump consumes pending event -> state-table dispatch -> leave -> state change -> enter
_start_task(...) completion -> pump queue -> task completion handler -> actor fields -> _send_event(name)
```

The micro-actor module never awaits inside transition dispatch. If work requires I/O, timers, LLM calls, process waits, file operations, or network requests, an actor method calls the appropriate runtime service and returns. External runtime services later report completion through the actor mailbox, while actor code may emit internal events.

Creating an actor makes it live: the runtime initializes the `BaseActor` private fields, creates the actor-local pump queue, and starts the actor pump. From that point, external advancement happens only through `SlaveActor.mailbox.deliver(...)`. Internal advancement happens through `_send_event(...)` and `_start_task(...)` inside actor code. Low-level dispatch functions are actor-pump internals, not application APIs.

## 3. Actor Definition

Actor definitions are pure transition data. They do not contain handler functions by default.

```ts
class Foo extends BaseActor {
  static _actor = {
    initial: "idle",
    states: {
      idle: {
        on: {
          start: "running",
          failed: "failed",
        },
      },

      running: {
        on: {
          done: "done",
          failed: "failed",
        },
      },

      done: {},
      failed: {},
    },
  };

  _on_call__idle__start_work(args: StartArgs) {
    this.prepare(args);
    this._send_event("start");
  }

  _on_enter__running() {
    this.runtime.startWork({
      onSucceeded: result => {
        this.result = result;
        this._send_event("done");
      },
      onFailed: error => {
        this.error = error;
        this._send_event("failed");
      },
    });
  }

  _on_leave__running() {
    this.runtime.detachRunningWork();
  }
}
```

Every concrete actor must explicitly extend `BaseActor` and declare its own static `_actor` slot. The runtime rejects classes that inherit `_actor` without declaring their own slot, using `Object.hasOwn(ctor, "_actor")`; this avoids accidentally running a subclass with a parent actor declaration.

The runtime compiles `_actor` lazily when the first instance of that class is created. The compiled jump tables are cached in a non-enumerable static `_compiled_actor` slot on the class.

```ts
class Foo extends BaseActor {
  static _actor = { /* raw declaration */ };
  static _compiled_actor?: CompiledActorDefinition;
}

function getCompiledActorDefinition(ctor: ActorConstructor) {
  if (!Object.hasOwn(ctor, "_actor")) {
    throw new InvalidActorDefinitionError(`${ctor.name} must declare static _actor`);
  }

  if (!ctor._compiled_actor) {
    ctor._compiled_actor = compileActorDefinition(ctor._actor);
  }

  return ctor._compiled_actor;
}
```

`startActor(Foo, args...)` compiles or reuses `Foo._compiled_actor`, constructs the class, initializes `BaseActor` private runtime slots to the initial state, and starts the actor pump.

`recoverActor(Foo, state, args...)` compiles or reuses `Foo._compiled_actor`, constructs the class, initializes `BaseActor` private runtime slots to the recovered state, runs the state recovery hook, and starts the actor pump.

## 4. Definition Shape

Example API sketch:

```ts
type MailboxCommand = { kind: "call"; name: string; args?: unknown };

abstract class BaseActor {
  #definition: ActorDefinition | undefined;
  #state: string | undefined;
  #nextEvent: string | undefined;
  #pumpQueue: ActorPumpQueue;
  #stateTasks: Map<number, ActiveStateTask>;

  state(): string;
  protected _send_event(name: string): void;
  protected _start_task<Result>(task: ActorStateTask<Result>): void;
}

abstract class SlaveActor extends BaseActor {
  readonly mailbox: {
    deliver(name: string, args?: unknown): void;
  };
}

type StateDefinition = {
  on?: Record<string, string>;

  // Optional escape hatches. Omit these for convention lookup.
  enter?: string | false;
  leave?: string | false;
  calls?: Record<string, string | false>;
};

type ActorDefinition = {
  initial?: string;
  sequence?: string[];
  states: Record<string, StateDefinition>;
};

type CompiledActorDefinition = {
  initial: string;
  sequence: ReadonlyMap<string, number>;
  states: ReadonlyMap<string, StateDefinition>;
};
```

Rules:

- `initial` defaults to the first key in `states` when omitted.
- `states` declares the complete state set.
- `on` maps event names to target states.
- `sequence` is optional and exists only for the local `done`-means-advance convention.
- `enter`, `leave`, and `calls` are optional overrides for convention method lookup.
- `false` disables a convention hook or call for that state.

Actor definitions do not store anonymous handlers. Behavior lives on the actor class through convention methods, or through explicit method-name overrides when a convention name is undesirable.

## 5. Convention Methods

The default method names are:

```text
_on_enter__{state}              // after entering a state
_on_leave__{state}              // before leaving a state
_on_recover__{state}            // after restoring an actor in a state
_on_call__{state}__{callName}   // state-scoped call handler
```

Examples:

```ts
class CardActor extends BaseActor {
  _on_enter__executing() {
    this.runtime.startExecutor(this.cardId, {
      onSucceeded: report => {
        this.executorReport = report;
        this._send_event("done");
      },
      onFailed: error => {
        this.error = error;
        this._send_event("failed");
      },
    });
  }

  _on_leave__executing() {
    this.runtime.detachExecutor(this.cardId);
  }

  _on_call__ready__run(args: { reason: string }) {
    this.runReason = args.reason;
    this._send_event("run_requested");
  }
}
```

Lookup rules:

- Enter hooks are optional. Missing enter methods are no-ops.
- Leave hooks are optional. Missing leave methods are no-ops.
- Recover hooks are optional. Missing recover methods fall back to the state enter hook when it exists.
- Call handlers are strict. A missing call handler throws a runtime error unless the state definition disables that call explicitly.
- Convention methods are called with `this` bound to the actor instance.
- Methods must be synchronous with respect to actor mutation. They may start async runtime work, but they must not `await` before returning to the pump.
- If a convention method returns a promise, the actor pump treats it as a programming error.

Recovery rules:

- Recovery is a construction mode, not a queued event.
- `recoverActor(ctor, state, ...)` validates that `state` exists in the compiled actor definition.
- The recovered state is installed before recovery hooks run, so `this.state()` returns the restored state.
- `_on_recover__{state}` runs when present.
- If `_on_recover__{state}` is missing, `_on_enter__{state}` runs when present.
- If the state definition sets `recover: false`, no recover or enter fallback hook runs.
- Recovery hooks must be synchronous. They may start runtime work and set a pending event through `_send_event()`.

Override example:

```ts
class CardActor extends BaseActor {
  static _actor = {
    states: {
      ready: {
        calls: {
          run: "handleRunFromReady",
          debug_noop: false,
        },
        on: { run_requested: "running" },
      },
      running: {},
    },
  };

  handleRunFromReady(args: { reason: string }) {
    this.runReason = args.reason;
    this._send_event("run_requested");
  }
}
```

## 6. Mailbox Queue And Pump Delivery

The actor pump owns the internal queue. `SlaveActor` owns the mailbox boundary and translates mailbox deliveries into pump work. The pump queue carries work items, not state-transition events:

```ts
type ActorPumpWork = {
  run(): void;
  subject: unknown;
};
```

Delivery rules:

- `actor.mailbox.deliver(name, args)` enqueues pump work that dispatches a state-scoped call.
- External objects cannot send events. Events are actor-internal facts emitted by `_send_event(name)`.
- Mailbox delivery never dispatches inline. Delivery occurs through the actor pump.
- State-task completion never dispatches inline. Completion handlers run through the actor pump.
- The work item is target-free because the queue is actor-local.
- One actor pump processes one actor serially.
- Different actor pumps may run concurrently.
- Events that are not declared for the current state are ignored by default.
- Calls that have no current-state handler throw by default.
- Durable delivery records, when needed, are a runtime responsibility outside the micro-actor module.

Minimal pump shape:

```ts
class ActorPumpQueue {
  private items: ActorPumpWork[] = [];
  private wake: (() => void) | undefined;

  push(work: ActorPumpWork) {
    this.items.push(work);
    this.wake?.();
    this.wake = undefined;
  }

  async shift(): Promise<ActorPumpWork> {
    while (this.items.length === 0) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }

    return this.items.shift()!;
  }

  drain(): ActorPumpWork[] {
    const batch = this.items;
    this.items = [];
    return batch;
  }
}

async function runActorPump(actor: RuntimeActor) {
  for (;;) {
    const first = await actor.queue.shift();
    const batch = [first, ...actor.queue.drain()];

    for (const work of batch) {
      try {
        work.run();
        drainPendingEvents(actor);
        actor.persist();
      } catch (error) {
        actor.reportError(error, work.subject);
      }
    }
  }
}
```

The `drain()` implementation assumes single-threaded JavaScript: between `shift()` returning the first item and `drain()` being called, no other `push()` can interleave within the same microtask. This is safe in Node.js but would need synchronization in a multi-threaded environment.

The pending event slot is not a queue. `_send_event(name)` fails if an event is already pending in the same actor turn. After each command handler, task completion handler, enter hook, leave hook, or recover hook, the pump consumes the pending event and applies it through the state table. If that transition's hooks emit another event, the pump consumes that event next.

## 7. Event Dispatch Semantics

Event dispatch is synchronous and deterministic.

Rules:

- Event dispatch mutates the actor instance in place.
- Unknown current state throws.
- Invalid target state throws.
- Unknown event for the current state is ignored, except for implicit `done` advance in `sequence`.
- Direct transitions are the only event transition form in the definition.
- If an event maps to the current state, no leave or enter hook runs.
- On actual state change, leave runs before the `BaseActor` private state slot changes.
- On actual state change, enter runs after the `BaseActor` private state slot changes.
- Leave and enter hooks must not directly call low-level dispatch.
- Leave and enter hooks may call `_send_event()` to request the next state-table event.
- Leave and enter hooks may start async runtime work directly.
- Leave and enter hooks must not return promises.

State-machine bookkeeping rules:

- All micro-actor module instance data lives in JavaScript private fields on `BaseActor`.
- Domain data, runtime references, and actor behavior live on the concrete subclass.
- Actor objects expose `state()` to read the current private state slot.
- Actor objects expose `state()` publicly. `BaseActor._send_event(name)` is protected and only actor code may call it. `SlaveActor.mailbox.deliver(...)` is the external command surface.
- Application code cannot and should not read private actor slots directly.

## 8. Call Dispatch Semantics

Calls are state-scoped method invocations. They are for external or parent/runtime requests that should run actor code without first modeling the request as a transition event.

Rules:

- Calls are queued and serial.
- A call does not transition state by itself.
- A call handler may update actor fields synchronously.
- A call handler may start async runtime work.
- A call handler may set one pending internal event by calling `_send_event()`.
- A call handler should not enqueue other mailbox commands to itself. If it needs follow-up state work, it should emit an internal event.
- Missing call handlers throw by default.
- Call handlers must not return promises.

This separates invocation from transition. For example, mailbox command `run` can validate input and emit `run_requested`; the transition remains explicit in `states.ready.on.run_requested`.

## 9. Minimal Conventions

These conventions keep common actors terse without adding a general workflow framework.

- `initial` defaults to the first state key when omitted.
- `done` is the normal event for successful completion of the task owned by the current state.
- `failed` is the normal event for failed completion of the task owned by the current state.
- `done` advances to the next state only inside an explicitly declared `sequence`.
- `enter` starts or admits state-scoped work.
- `leave` stops, cancels, or detaches state-scoped work.
- Unhandled events are ignored by default.
- Unhandled calls throw by default.
- Events carry no payload by framework design; event-specific data lives on actor fields before `_send_event(name)` is called.
- Call arguments are `unknown` by framework design.
- Specific event names are reserved for externally meaningful intermediate facts. State-local work should normally write result/error fields on the actor and then send `done` or `failed`.

## 10. Async Work And Completion

The micro-actor module defines a mailbox command delivery boundary for `SlaveActor`s and a state-scoped task helper on `BaseActor`. Actor methods either call runtime services directly or start state-scoped async work with `_start_task(...)`.

Example:

```ts
class LlmActor extends BaseActor {
  _on_enter__calling_provider() {
    const requestId = this.requestId;

    this.runtime.callProvider({
      requestId,
      prompt: this.prompt,
      timeoutMs: 60_000,
      onSucceeded: output => {
        this.providerRequestId = requestId;
        this.providerOutput = output;
        this._send_event("done");
      },
      onFailed: error => {
        this.providerRequestId = requestId;
        this.error = error;
        this._send_event("failed");
      },
      onTimedOut: () => {
        this.providerRequestId = requestId;
        this._send_event("failed");
      },
    });
  }
}
```

Async work rules:

- Every external operation must have a timeout or inactivity timeout.
- `_on_enter__...` and `_on_recover__...` start state-owned async work by calling `_start_task(...)`; hooks do not receive task arguments.
- `_start_task(...)` records the current state and gives the task an `AbortSignal`.
- When the actor leaves a state, unfinished tasks started in that state are aborted and stale completions are ignored.
- State-task `on_done` and `on_failed` handlers run synchronously through the actor pump. They may mutate actor fields and may call `_send_event(...)`.
- State-task completion handlers may also do nothing; no transition occurs unless they emit an event.
- Completion callbacks for work outside `_start_task(...)` must deliver a mailbox command; actor code then calls `_send_event(...)`. They must not call low-level dispatch directly.
- Completion callbacks must store enough correlation data on actor fields for the actor to reject stale or duplicate completions.
- Live callbacks are not persisted. Recovery code reconstructs safe work from durable actor/domain state or emits diagnostics/failure events.
- Cancellation is modeled as events and runtime service calls. Already-running jobs normally finish or time out and then deliver their callback event.

## 11. Persistence Boundary

The micro-actor module does not persist anything itself. The caller owns persistence.

Recommended runtime sequence:

```text
1. external code delivers a command through `actor.mailbox.deliver(...)`
2. actor pump queue wakes that actor's pump through a stored promise resolver
3. actor pump drains queued commands before awaiting the queue again
4. actor pump loads or reconstructs the actor instance when needed
5. actor pump dispatches one command synchronously
6. actor pump persists updated actor state when needed
7. actor code emits internal events through `_send_event(...)`, which the pump consumes immediately after the current hook
8. async runtime callbacks later deliver mailbox commands or complete state tasks
```

The micro-actor module does not define a snapshot type. The runtime must be able to serialize and reconstruct actor objects from persisted domain data plus the actor's current state string.

## 12. Example: Supervisor Actor

```ts
type SupervisorState = "idle" | "running" | "paused" | "shutting_down" | "failed";

class SupervisorActor extends BaseActor {
  static _actor = {
    initial: "idle",
    states: {
      idle: {
        on: {
          run_requested: "running",
          shutdown_requested: "shutting_down",
        },
      },

      running: {
        on: {
          done: "idle",
          pause_requested: "paused",
          shutdown_requested: "shutting_down",
          failed: "failed",
        },
      },

      paused: {
        on: {
          run_requested: "running",
          shutdown_requested: "shutting_down",
        },
      },

      shutting_down: {
        on: {
          processes_terminated: "idle",
          failed: "failed",
        },
      },

      failed: {},
    },
  };

  projectId: string;
  lastOutcome?: "done" | "failed" | "blocked" | "canceled";

  _on_call__idle__run() {
    this._send_event("run_requested");
  }

  _on_call__running__run() {
    this.runtime.warnAlreadyRunning(this.projectId);
  }

  _on_enter__running() {
    this.runtime.startProject(this.projectId, {
      onCompleted: outcome => {
        this.lastOutcome = outcome;
        this._send_event("done");
      },
      onFailed: error => {
        this.error = error;
        this._send_event("failed");
      },
    });
  }

  _on_enter__shutting_down() {
    this.runtime.terminateRuntimeProcesses({
      timeoutMs: 30_000,
      onCompleted: () => this._send_event("processes_terminated"),
      onFailed: error => {
        this.error = error;
        this._send_event("failed");
      },
    });
  }
}
```

## 13. Example: LLM Loop Actor

```ts
type LlmState = "ready" | "calling_provider" | "interpreting_provider_output" | "running_tool" | "done" | "failed";

class LlmLoopActor extends BaseActor {
  static _actor = {
    initial: "ready",
    states: {
      ready: {
        on: {
          start_requested: "calling_provider",
          cancel_requested: "failed",
        },
      },

      calling_provider: {
        on: {
          done: "interpreting_provider_output",
          failed: "failed",
          cancel_requested: "failed",
        },
      },

      interpreting_provider_output: {
        on: {
          outcome_accepted: "done",
          tool_calls_ready: "running_tool",
          failed: "failed",
          cancel_requested: "failed",
        },
      },

      running_tool: {
        on: {
          done: "calling_provider",
          failed: "failed",
          cancel_requested: "failed",
        },
      },

      done: {},
      failed: {},
    },
  };

  _on_call__ready__start(args: StartArgs) {
    this.prompt = args.prompt;
    this._send_event("start_requested");
  }

  _on_enter__calling_provider() {
    this.runtime.callProvider({
      prompt: this.prompt,
      onSucceeded: output => {
        this.providerOutput = output;
        this._send_event("done");
      },
      onFailed: error => {
        this.error = error;
        this._send_event("failed");
      },
      onTimedOut: () => this._send_event("failed"),
    });
  }

  _on_enter__interpreting_provider_output() {
    const parsed = parseModelOutput(this.providerOutput);
    if (parsed.kind === "outcome") {
      this.outcome = parsed.outcome;
      this._send_event("outcome_accepted");
      return;
    }

    this.pendingTools = parsed.toolCalls;
    this._send_event("tool_calls_ready");
  }

  _on_enter__running_tool() {
    const nextTool = this.pendingTools.shift();
    if (!nextTool) {
      this._send_event("done");
      return;
    }

    this.runtime.runTool(nextTool, {
      onSucceeded: result => {
        this.toolResults.push(result);
        this._send_event("done");
      },
      onFailed: error => {
        this.error = error;
        this._send_event("failed");
      },
    });
  }
}
```

The `calling_provider`, `interpreting_provider_output`, and `running_tool` states separate provider-call, output interpretation, tool-call, cancellation, timeout, and recovery behavior by phase. `done` and `failed` still report whether the current state's work completed successfully; fact events such as `outcome_accepted` and `tool_calls_ready` are branch decisions, not success/failure signals.

## 14. API Surface

Minimal exported API:

```ts
export function startActor<T extends BaseActor>(ctor: ActorConstructor<T>, ...args: unknown[]): T;
export function recoverActor<T extends BaseActor>(ctor: ActorConstructor<T>, state: string, ...args: unknown[]): T;

export function compileActorDefinition(definition: ActorDefinition): CompiledActorDefinition;
export function getCompiledActorDefinition(ctor: ActorConstructor): CompiledActorDefinition;

export class InvalidActorDefinitionError extends Error {}
export class InvalidTransitionError extends Error {}
export class MissingCallHandlerError extends Error {}
```

Internal helpers include `dispatchEvent`, `dispatchCall`, actor runtime installation, and `runActorPump`.

## 15. Validation Rules

At definition time:

- `states` must be non-empty.
- `initial`, when present, must exist in `states`.
- Every `sequence` state must exist in `states`.
- A state must not appear more than once in `sequence`.
- Every direct transition target must exist.
- State names and event names must be non-empty strings.
- `enter`, `leave`, and `calls` overrides must be method-name strings or `false`.
- Concrete actor classes must declare their own static `_actor`; inherited `_actor` is rejected.

At delivery time:

- Unknown current state throws.
- Unknown events for the current state are ignored.
- Missing call handlers throw.
- Invalid transition target throws.
- Convention methods throwing exceptions become caller/runtime-visible delivery failures; the module does not swallow them.
- Convention methods returning promises throw a programming error.

## 16. Testing Strategy

Test the micro-actor module independently:

- `static _actor` declares a definition for a class;
- `_compiled_actor` is initialized lazily on first actor creation;
- `startActor(...)` initializes `BaseActor` private slots, `state()`, pending event slot, state task set, pump queue, and pump;
- `recoverActor(...)` initializes `BaseActor` private slots with a restored state and runs `_on_recover__{state}` or `_on_enter__{state}` fallback;
- `initial` defaults to the first state;
- direct transition works;
- `leave` runs before transition;
- `enter` runs after transition;
- `call` invokes `_on_call__{state}__{name}`;
- missing call handler throws;
- missing enter/leave hooks are no-ops;
- `done` advances within an explicitly declared sequence;
- unknown event is ignored;
- invalid target throws;
- promise-returning convention methods are rejected.

Test the runtime delivery subsystem separately:

- pump queues store serialized work, not events;
- `SlaveActor.mailbox.deliver(...)` enqueues pump work and does not dispatch inline;
- `_send_event(...)` sets exactly one pending event for the current actor turn;
- `_start_task(...)` runs completion handlers through the pump;
- state changes abort unfinished tasks for the old state;
- queue wakeups happen through stored promise resolvers;
- delivery runs from the actor pump after the current JavaScript call stack has unwound;
- the actor pump drains queued work before awaiting the queue again;
- delivery for one actor is serial;
- different actor pumps may process messages in parallel;
- async completion callbacks deliver mailbox commands or complete state tasks rather than calling low-level dispatch;
- duplicate durable delivery records are ignored or rejected deterministically;
- stale completion events are rejected by actor fields;
- timeout callbacks produce timeout events.

Test Saivage actors separately by asserting domain invariants:

- duplicate Run emits warning and stays `running`;
- Shutdown starts process termination;
- LLM loop executes tools serially;
- `activate_card` behaves as a barrier;
- cancellation waits for bounded operation completion events;
- project completion returns supervisor to `idle` while preserving project card outcome.
