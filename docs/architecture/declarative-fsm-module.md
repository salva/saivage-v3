# Declarative FSM Module Architecture

Date: 2026-06-15.

Status: current runtime-core implementation direction.

## 1. Goal

Define a small TypeScript module for actor-local finite-state machines. The module gives Saivage explicit states, deterministic transitions, per-actor delivery, and conventional lifecycle methods.

The module supports:

- class-level actor definitions;
- declarative state and transition definitions;
- actor-local queues;
- two delivered message kinds: `event` and `call`;
- synchronous transition dispatch;
- convention-based `enter`, `leave`, and `call` methods;
- runtime-owned async work started by actor methods;
- explicit completion events returned through actor queues.

The FSM module is the deterministic core. Actor methods may start runtime-owned async work directly by calling runtime services. Async completions must return to the actor through queued events.

## 2. Core Model

The module has five concepts:

- **Actor definition**: static `_actor` declaration of states and event transitions on each concrete actor class.
- **Actor**: a regular JS/TS class instance with domain fields and methods. Runtime/FSM bookkeeping lives in JavaScript private fields on `BaseActor`.
- **Event**: queued state-transition input, delivered by `send(name)`.
- **Call**: queued method invocation, delivered by `call(name, args?)` and handled by state-scoped convention methods.
- **Actor queue**: one actor-local mailbox that serializes events and calls for one actor instance.

The core flow is:

```text
actor.send(name) -> actor queue -> actor pump -> event dispatch -> leave -> state change -> enter
actor.call(name, args) -> actor queue -> actor pump -> state-scoped call method
async completion callback -> actor fields -> actor.send(name)
```

The FSM never awaits inside transition dispatch. If work requires I/O, timers, LLM calls, process waits, file operations, or network requests, an actor method calls the appropriate runtime service and returns. The runtime service later reports completion by calling `actor.send(...)`.

Creating an actor makes it live: the runtime initializes the `BaseActor` private fields, creates the actor-local queue, and starts the actor pump. From that point, supported advancement happens only through queued `send` and `call` delivery. Low-level dispatch functions are actor-pump internals, not application APIs.

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
  };

  _on_call__idle__start_work(args: StartArgs) {
    this.prepare(args);
    this.send("start");
  }

  _on_enter__running() {
    this.runtime.startWork({
      onSucceeded: result => {
        this.result = result;
        this.send("done");
      },
      onFailed: error => {
        this.error = error;
        this.send("error");
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

`createActor(Foo, args...)` compiles or reuses `Foo._compiled_actor`, constructs the class, initializes `BaseActor` private runtime slots, and starts the queue pump.

## 4. Definition Shape

Example API sketch:

```ts
type ActorMessage =
  | { kind: "event"; name: string }
  | { kind: "call"; name: string; args?: unknown };

abstract class BaseActor {
  #definition: ActorDefinition | undefined;
  #state: string | undefined;
  #queue: AsyncActorQueue | undefined;

  state(): string;
  send(name: string): void;
  call(name: string, args?: unknown): void;
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
_on_call__{state}__{callName}   // state-scoped call handler
```

Examples:

```ts
class CardActor extends BaseActor {
  _on_enter__executing() {
    this.runtime.startExecutor(this.cardId, {
      onSucceeded: report => {
        this.executorReport = report;
        this.send("executor_succeeded");
      },
      onFailed: error => {
        this.error = error;
        this.send("executor_failed");
      },
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
    this.send("run_requested");
  }
}
```

## 6. Actor Queue And Delivery

Each actor owns a queue whose items are plain messages:

```ts
type EventMessage = {
  kind: "event";
  name: string;
};

type CallMessage = {
  kind: "call";
  name: string;
  args?: unknown;
};

type ActorMessage = EventMessage | CallMessage;
```

Delivery rules:

- `actor.send(name)` pushes `{ kind: "event", name }` to that actor's queue.
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
- Leave and enter hooks may call `send()` to enqueue later events.
- Leave and enter hooks may start async runtime work directly.
- Leave and enter hooks must not return promises.

State-machine bookkeeping rules:

- All FSM module instance data lives in JavaScript private fields on `BaseActor`.
- Domain data, runtime references, and actor behavior live on the concrete subclass.
- Actor objects expose `state()` to read the current private state slot.
- Actor objects expose `send(name)` and `call(name, args?)` methods.
- Application code cannot and should not read private FSM slots directly.

## 8. Call Dispatch Semantics

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

## 9. Minimal Conventions

These conventions keep common actors terse without adding a general workflow framework.

- `initial` defaults to the first state key when omitted.
- `done` advances to the next state only inside an explicitly declared `sequence`.
- `error` transitions to `failed` only when the current state declares `error: "failed"`.
- `enter` starts or admits state-scoped work.
- `leave` stops, cancels, or detaches state-scoped work.
- Unhandled events are ignored by default.
- Unhandled calls throw by default.
- Events carry no payload by framework design; event-specific data lives on actor fields before `send(name)` is called.
- Call arguments are `unknown` by framework design.
- Specific event names are preferred for externally meaningful completions, such as `provider_call_succeeded`, `tool_call_failed`, and `process_wait_timed_out`.

## 10. Async Work And Completion

The FSM module does not define commands. Actor methods call runtime services directly.

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
        this.send("provider_call_succeeded");
      },
      onFailed: error => {
        this.providerRequestId = requestId;
        this.error = error;
        this.send("provider_call_failed");
      },
      onTimedOut: () => {
        this.providerRequestId = requestId;
        this.send("provider_call_timed_out");
      },
    });
  }
}
```

Async work rules:

- Every external operation must have a timeout or inactivity timeout.
- Completion callbacks must call `actor.send(...)`; they must not call low-level dispatch directly.
- Completion callbacks must store enough correlation data on actor fields for the actor to reject stale or duplicate completions.
- Live callbacks are not persisted. Recovery code reconstructs safe work from durable actor/domain state or emits diagnostics/failure events.
- Cancellation is modeled as events and runtime service calls. Already-running jobs normally finish or time out and then deliver their callback event.

## 11. Persistence Boundary

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

The FSM module does not define a snapshot type. The runtime must be able to serialize and reconstruct actor objects from persisted domain data plus the actor's current state string.

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
  };

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
        this.send("project_completed");
      },
      onFailed: error => {
        this.error = error;
        this.send("error");
      },
    });
  }

  _on_enter__shutting_down() {
    this.runtime.terminateRuntimeProcesses({
      timeoutMs: 30_000,
      onCompleted: () => this.send("processes_terminated"),
      onFailed: error => {
        this.error = error;
        this.send("error");
      },
    });
  }
}
```

## 13. Example: LLM Loop Actor

```ts
type LlmState = "ready" | "calling_provider" | "running_tool" | "completed" | "failed";

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
  };

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
      onFailed: error => {
        this.error = error;
        this.send("provider_call_failed");
      },
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
      onFailed: error => {
        this.error = error;
        this.send("tool_call_failed");
      },
    });
  }
}
```

The `calling_provider` and `running_tool` states separate provider-call, tool-call, cancellation, timeout, and recovery behavior by phase.

## 14. API Surface

Minimal exported API:

```ts
export function createActor<T extends BaseActor>(ctor: ActorConstructor<T>, ...args: unknown[]): T;

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

Test the FSM module independently:

- `static _actor` declares a definition for a class;
- `_compiled_actor` is initialized lazily on first actor creation;
- `createActor(...)` initializes `BaseActor` private slots, `state()`, `send()`, `call()`, queue, and pump;
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
