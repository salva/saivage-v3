# Declarative FSM Module Architecture

Date: 2026-06-15.

Status: current runtime-core implementation direction.

## 1. Goal

Define a small TypeScript module for actor-local finite-state machines. The module gives Saivage explicit states, deterministic transitions, per-actor delivery, and conventional lifecycle methods without adopting XState's actor/statechart framework.

The design is inspired by `Class::StateMachine::Declarative`, but intentionally supports only a minimal subset:

- class-level actor definitions;
- declarative state and transition definitions;
- actor-local queues;
- two delivered message kinds: `event` and `call`;
- synchronous transition dispatch;
- convention-based `enter`, `leave`, and `call` methods;
- no framework-owned async work;
- no command return channel;
- no hidden actors;
- no nested statecharts;
- no implicit workflow bus.

The FSM module is the deterministic core. Actor methods may start runtime-owned async work directly by calling runtime services. Async completions must return to the actor through queued events.

## 2. Core Model

The module has five concepts:

- **Actor definition**: static declaration of states and event transitions, normally attached by an `@Actor(...)` class decorator.
- **Actor**: a regular JS/TS class instance with domain fields and methods. FSM bookkeeping lives under a reserved `_sm` slot.
- **Event**: queued state-transition input, delivered by `send(name, args?)`.
- **Call**: queued method invocation, delivered by `call(name, args?)` and handled by state-scoped convention methods.
- **Actor queue**: one actor-local mailbox that serializes events and calls for one actor instance.

The core flow is:

```text
actor.send(name, args) -> actor queue -> actor pump -> event dispatch -> leave -> state change -> enter
actor.call(name, args) -> actor queue -> actor pump -> state-scoped call method
async completion callback -> actor.send(name, args)
```

The FSM never awaits inside transition dispatch. If work requires I/O, timers, LLM calls, process waits, file operations, or network requests, an actor method calls the appropriate runtime service and returns. The runtime service later reports completion by calling `actor.send(...)`.

Creating an actor makes it live: the runtime installs `_sm`, `state()`, `send()`, `call()`, creates the actor-local queue, and starts the actor pump. From that point, supported advancement happens only through queued `send` and `call` delivery. Low-level dispatch functions are actor-pump internals, not application APIs.

## 3. Actor Definition

Actor definitions are pure transition data. They do not contain handler functions by default.

```ts
@Actor({
  initial: "idle",
  states: {
    idle: {
      on: {
        start: "running",
        error: "failed",
      },
    },

    running: {
      on: {
        done: "done",
        error: "failed",
      },
    },

    done: {},
    failed: {},
  },
})
class Foo extends BaseActor<FooState> {
  _on_call__idle__start_work(args: StartArgs) {
    this.prepare(args);
    this.send("start");
  }

  _on_enter__running() {
    this.runtime.startWork({
      onSucceeded: result => this.send("done", { result }),
      onFailed: error => this.send("error", { error }),
    });
  }

  _on_leave__running() {
    this.runtime.detachRunningWork();
  }
}
```

The decorator should be minimal. It registers the definition for the constructor and should not heavily mutate the prototype.

```ts
const actorDefinitions = new WeakMap<Function, ActorDefinition>();

function Actor(definition: ActorDefinition) {
  return function (ctor: Function) {
    actorDefinitions.set(ctor, definition);
  };
}
```

`createActor(Foo, args...)` constructs the class, reads the registered definition, installs actor runtime methods, initializes `_sm.state`, and starts the queue pump.

## 4. Definition Shape

Example API sketch:

```ts
type ActorMessage =
  | { kind: "event"; name: string; args?: Record<string, unknown> }
  | { kind: "call"; name: string; args?: unknown };

type ActorSelf<State extends string> = {
  _sm: {
    state: State;
  };
  state(): State;
  send(name: string, args?: Record<string, unknown>): void;
  call(name: string, args?: unknown): void;
};

type StateDefinition<State extends string> = {
  on?: Record<string, State>;

  // Optional escape hatches. Omit these for convention lookup.
  enter?: string | false;
  leave?: string | false;
  calls?: Record<string, string | false>;
};

type ActorDefinition<State extends string = string> = {
  initial?: State;
  sequence?: State[];
  states: Record<State, StateDefinition<State>>;
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
_on_call__{state}__{callName}   // state-scoped call handler
```

Examples:

```ts
class CardActor extends BaseActor<CardState> {
  _on_enter__executing() {
    this.runtime.startExecutor(this.cardId, {
      onSucceeded: report => this.send("executor_succeeded", { report }),
      onFailed: error => this.send("executor_failed", { error }),
    });
  }

  _on_leave__executing() {
    this.runtime.detachExecutor(this.cardId);
  }

  _on_call__ready__run(args: { reason: string }) {
    this.runReason = args.reason;
    this.send("run_requested");
  }
}
```

Lookup rules:

- Enter hooks are optional. Missing enter methods are no-ops.
- Leave hooks are optional. Missing leave methods are no-ops.
- Call handlers are strict. A missing call handler throws a runtime error unless the state definition disables that call explicitly.
- Convention methods are called with `this` bound to the actor instance.
- Methods must be synchronous with respect to FSM mutation. They may start async runtime work, but they must not `await` before returning to the pump.
- If a convention method returns a promise, the actor pump treats it as a programming error.

Override example:

```ts
@Actor({
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
})
class CardActor extends BaseActor<CardState> {
  handleRunFromReady(args: { reason: string }) {
    this.runReason = args.reason;
    this.send("run_requested");
  }
}
```

## 6. Why Not Method Decorators

Method decorators are useful for metadata, but they do not solve this design's main ergonomics problem.

JavaScript class elements need property names. TypeScript rejects duplicate method names, and JavaScript keeps only the last same-named method. A decorator can replace the function stored at a property, register metadata about it, or create aliases during initialization, but it cannot turn duplicate class elements into distinct methods before the duplicate-name problem exists.

This is invalid or unusable for state-specific handlers:

```ts
class Foo {
  @OnEnter("idle")
  enter() {}

  @OnEnter("running")
  enter() {}
}
```

Convention names avoid the collision while keeping the declaration local to the class:

```ts
class Foo {
  _on_enter__idle() {}
  _on_enter__running() {}
}
```

The class decorator remains useful because it attaches one actor definition to the class without per-method registration boilerplate.

## 7. Actor Queue And Delivery

Each actor owns a queue whose items are plain messages:

```ts
type EventMessage = {
  kind: "event";
  name: string;
  args?: Record<string, unknown>;
};

type CallMessage = {
  kind: "call";
  name: string;
  args?: unknown;
};

type ActorMessage = EventMessage | CallMessage;
```

Delivery rules:

- `actor.send(name, args)` pushes `{ kind: "event", name, args }` to that actor's queue.
- `actor.call(name, args)` pushes `{ kind: "call", name, args }` to that actor's queue.
- Neither method dispatches inline. Delivery always occurs after the current JavaScript call stack unwinds.
- Cross-object delivery obtains the target actor and calls `target.send(...)` or `target.call(...)`.
- The queue item is target-free because the queue is actor-local.
- One actor pump processes one actor serially.
- Different actor pumps may run concurrently.
- Events that are not declared for the current state are ignored by default.
- Calls that have no current-state handler throw by default.
- Durable delivery records, when needed, are a runtime responsibility outside the FSM module.

Minimal queue/pump shape:

```ts
class AsyncActorQueue {
  private items: ActorMessage[] = [];
  private wake: (() => void) | undefined;

  push(message: ActorMessage) {
    this.items.push(message);
    this.wake?.();
    this.wake = undefined;
  }

  async shift(): Promise<ActorMessage> {
    while (this.items.length === 0) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }

    return this.items.shift()!;
  }

  drain(): ActorMessage[] {
    const batch = this.items;
    this.items = [];
    return batch;
  }
}

async function runActorPump(actor: RuntimeActor) {
  for (;;) {
    const first = await actor.queue.shift();
    const batch = [first, ...actor.queue.drain()];

    for (const message of batch) {
      try {
        if (message.kind === "event") {
          dispatchEvent(actor, message);
        } else {
          dispatchCall(actor, message);
        }
        actor.persist();
      } catch (error) {
        actor.reportError(error, message);
      }
    }
  }
}
```

The `drain()` implementation assumes single-threaded JavaScript: between `shift()` returning the first item and `drain()` being called, no other `push()` can interleave within the same microtask. This is safe in Node.js but would need synchronization in a multi-threaded environment.

## 8. Event Dispatch Semantics

Event dispatch is synchronous and deterministic.

Rules:

- Event dispatch mutates the actor instance in place.
- Unknown current state throws.
- Invalid target state throws.
- Unknown event for the current state is ignored, except for implicit `done` advance in `sequence`.
- Direct transitions are the only event transition form in the definition.
- If an event maps to the current state, no leave or enter hook runs.
- On actual state change, leave runs before `_sm.state` changes.
- On actual state change, enter runs after `_sm.state` changes.
- Leave and enter hooks must not directly call low-level dispatch.
- Leave and enter hooks may call `send()` to enqueue later events.
- Leave and enter hooks may start async runtime work directly.
- Leave and enter hooks must not return promises.

State-machine bookkeeping rules:

- All FSM module data lives under `self._sm`.
- `self._sm.state` is the current state and is the only required `_sm` field initially.
- Domain data, runtime references, and object methods live outside `_sm`.
- Actor objects expose `state()` to read `self._sm.state`.
- Actor objects expose runtime-installed `send(name, args?)` and `call(name, args?)` methods.
- Application code should use `state()` rather than reading `_sm.state` directly.

## 9. Call Dispatch Semantics

Calls are state-scoped method invocations. They are for external or parent/runtime requests that should run actor code without first modeling the request as a transition event.

Rules:

- Calls are queued and serial like events.
- A call does not transition state by itself.
- A call handler may update actor fields synchronously.
- A call handler may start async runtime work.
- A call handler may enqueue events by calling `send()`.
- A call handler may enqueue other calls by calling `call()`, though this should be rare.
- Missing call handlers throw by default.
- Call handlers must not return promises.

This separates invocation from transition. For example, `call("run")` can validate input and enqueue `run_requested`; the transition remains explicit in `states.ready.on.run_requested`.

## 10. Minimal Conventions

These conventions keep common actors terse without adding a general workflow framework.

- `initial` defaults to the first state key when omitted.
- `done` advances to the next state only inside an explicitly declared `sequence`.
- `error` transitions to `failed` only when the current state declares `error: "failed"`, or when a later implementation explicitly adopts a definition-level default. There is no hidden global failure transition initially.
- `enter` starts or admits state-scoped work.
- `leave` stops, cancels, or detaches state-scoped work.
- Unhandled events are ignored by default.
- Unhandled calls throw by default.
- Event payloads are untyped dictionaries by framework design.
- Call arguments are `unknown` by framework design.
- Specific event names are preferred for externally meaningful completions, such as `provider_call_succeeded`, `tool_call_failed`, and `process_wait_timed_out`.

## 11. Async Work And Completion

The FSM module does not define commands. Actor methods call runtime services directly.

Example:

```ts
class LlmActor extends BaseActor<LlmState> {
  _on_enter__calling_provider() {
    const requestId = this.requestId;

    this.runtime.callProvider({
      requestId,
      prompt: this.prompt,
      timeoutMs: 60_000,
      onSucceeded: output => this.send("provider_call_succeeded", { requestId, output }),
      onFailed: error => this.send("provider_call_failed", { requestId, error }),
      onTimedOut: () => this.send("provider_call_timed_out", { requestId }),
    });
  }
}
```

Async work rules:

- Every external operation must have a timeout or inactivity timeout.
- Completion callbacks must call `actor.send(...)`; they must not call low-level dispatch directly.
- Completion events must include enough correlation data for the actor to reject stale or duplicate completions.
- Live callbacks are not persisted. Recovery code reconstructs safe work from durable actor/domain state or emits diagnostics/failure events.
- Cancellation is modeled as events and runtime service calls. Already-running jobs normally finish or time out and then deliver their callback event.

## 12. Persistence Boundary

The FSM module does not persist anything itself. The caller owns persistence.

Recommended runtime sequence:

```text
1. actor receives send(...) or call(...) and pushes a message to its queue
2. actor queue wakes that actor's pump through a stored promise resolver
3. actor pump drains queued messages before awaiting the queue again
4. actor pump loads or reconstructs the actor instance when needed
5. actor pump dispatches one message synchronously
6. actor pump persists updated actor state when needed
7. async runtime callbacks later call actor.send(...)
```

The FSM module does not define a snapshot type. The runtime must be able to serialize and reconstruct actor objects from persisted domain data plus `_sm.state`.

## 13. Example: Supervisor Actor

```ts
type SupervisorState = "idle" | "running" | "paused" | "shutting_down" | "failed";

@Actor<SupervisorState>({
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
        project_completed: "idle",
        pause_requested: "paused",
        shutdown_requested: "shutting_down",
        error: "failed",
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
        error: "failed",
      },
    },

    failed: {},
  },
})
class SupervisorActor extends BaseActor<SupervisorState> {
  projectId: string;
  lastOutcome?: "done" | "failed" | "blocked" | "cancelled";

  _on_call__idle__run() {
    this.send("run_requested");
  }

  _on_call__running__run() {
    this.runtime.warnAlreadyRunning(this.projectId);
  }

  _on_enter__running() {
    this.runtime.startProject(this.projectId, {
      onCompleted: outcome => {
        this.lastOutcome = outcome;
        this.send("project_completed", { outcome });
      },
      onFailed: error => this.send("error", { error }),
    });
  }

  _on_enter__shutting_down() {
    this.runtime.terminateRuntimeProcesses({
      timeoutMs: 30_000,
      onCompleted: () => this.send("processes_terminated"),
      onFailed: error => this.send("error", { error }),
    });
  }
}
```

## 14. Example: LLM Loop Actor

```ts
type LlmState = "ready" | "calling_provider" | "running_tool" | "completed" | "failed";

@Actor<LlmState>({
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
        provider_call_succeeded: "running_tool",
        provider_call_failed: "failed",
        provider_call_timed_out: "failed",
        model_completed: "completed",
        cancel_requested: "failed",
      },
    },

    running_tool: {
      on: {
        tool_call_succeeded: "calling_provider",
        tool_call_failed: "failed",
        cancel_requested: "failed",
      },
    },

    completed: {},
    failed: {},
  },
})
class LlmLoopActor extends BaseActor<LlmState> {
  _on_call__ready__start(args: StartArgs) {
    this.prompt = args.prompt;
    this.send("start_requested");
  }

  _on_enter__calling_provider() {
    this.runtime.callProvider({
      prompt: this.prompt,
      onSucceeded: output => {
        const parsed = parseModelOutput(output);
        if (parsed.kind === "outcome") {
          this.outcome = parsed.outcome;
          this.send("model_completed");
          return;
        }

        this.pendingTools = parsed.toolCalls;
        this.send("provider_call_succeeded");
      },
      onFailed: error => this.send("provider_call_failed", { error }),
      onTimedOut: () => this.send("provider_call_timed_out"),
    });
  }

  _on_enter__running_tool() {
    const nextTool = this.pendingTools.shift();
    if (!nextTool) {
      this.send("tool_call_succeeded");
      return;
    }

    this.runtime.runTool(nextTool, {
      onSucceeded: result => {
        this.toolResults.push(result);
        this.send("tool_call_succeeded");
      },
      onFailed: error => this.send("tool_call_failed", { error }),
    });
  }
}
```

This version deliberately separates `calling_provider` from `ready`. That is not required globally, but it is useful in the LLM loop because provider calls, tool calls, cancellation, timeout, and recovery differ by phase.

## 15. API Surface

Minimal exported API:

```ts
export function Actor<State extends string>(
  definition: ActorDefinition<State>,
): ClassDecorator;

export function createActor<T extends object>(ctor: ActorConstructor<T>, ...args: unknown[]): T & RuntimeActorMethods;

export function getActorDefinition(ctor: Function): ActorDefinition;

export class InvalidActorDefinitionError extends Error {}
export class InvalidTransitionError extends Error {}
export class MissingCallHandlerError extends Error {}
```

Internal-only helpers may include `dispatchEvent`, `dispatchCall`, `installActorRuntime`, and `runActorPump`. They should not be the public application API.

Do not add `assign` helpers, `transition` helpers, command helpers, interpreters, schedulers, timers, actor spawning, `delay`, or persistence adapters to this module initially. Those belong to the Saivage runtime or to a later iteration if repeated local patterns prove they belong here.

## 16. Validation Rules

At definition time:

- `states` must be non-empty.
- `initial`, when present, must exist in `states`.
- Every `sequence` state must exist in `states`.
- A state must not appear more than once in `sequence`.
- Every direct transition target must exist.
- State names and event names must be non-empty strings.
- `enter`, `leave`, and `calls` overrides must be method-name strings or `false`.

At delivery time:

- Unknown current state throws.
- Unknown events for the current state are ignored.
- Missing call handlers throw.
- Invalid transition target throws.
- Convention methods throwing exceptions become caller/runtime-visible delivery failures; the module does not swallow them.
- Convention methods returning promises throw a programming error.

## 17. Testing Strategy

Test the FSM module independently:

- `@Actor(...)` registers a definition for a class;
- `createActor(...)` initializes `_sm.state`, `state()`, `send()`, `call()`, queue, and pump;
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

- actor queues store only event/call messages;
- `send` and `call` enqueue and do not dispatch inline;
- queue wakeups happen through stored promise resolvers;
- delivery runs from the actor pump after the current JavaScript call stack has unwound;
- the actor pump drains queued messages before awaiting the queue again;
- delivery for one actor is serial;
- different actor pumps may process messages in parallel;
- async completion callbacks call `actor.send(...)` rather than low-level dispatch;
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

## 18. Non-Goals

The module should not implement:

- hierarchical states;
- parallel states;
- actor supervision;
- delayed transitions;
- async actions;
- built-in persistence;
- built-in command execution;
- built-in `delay` handling;
- cross-object synchronous calls;
- implicit retries;
- visual statechart tooling;
- a generic workflow engine;
- JavaScript syntax macros or AST transforms.

If Saivage later needs any of these, add them outside this module first. Promote into the FSM module only after repeated local patterns prove they belong there.

## 19. Why This Fits Saivage

This design keeps the useful part of state machines: explicit states, explicit events, invalid transition detection, serial actor delivery, and easy transition tests.

It avoids the part that made XState feel too large: actor hierarchy, invoked actor semantics, statechart features, and framework-owned async execution.

Saivage already needs its own durable runtime for cards, activation records, LLM sessions, process registry, and recovery. A synchronous actor-local FSM with convention methods maps directly to that runtime without hiding persistence or recovery behind framework behavior.
