# Declarative FSM Module Design

Date: 2026-06-14.

Status: working design.

## 1. Goal

Define a small TypeScript module for declarative finite-state machines with synchronous transitions and explicit async command effects. It should provide the state-machine abstraction Saivage needs without adopting XState's actor/statechart framework.

The design is inspired by `Class::StateMachine::Declarative`, but intentionally supports only a minimal subset:

- declarative state and event definitions;
- synchronous event handling;
- state transitions;
- `on_leave` hooks before transitions;
- `on_enter` hooks after transitions;
- event handlers that may either return commands or request transitions;
- no internal async execution;
- no hidden actors;
- no nested statecharts;
- no implicit command bus.

The FSM module is the deterministic core. A separate runtime executes async commands and dispatches completion events back into the FSM.

The runtime also owns event queueing and delivery. FSM objects do not call each other directly. Events are enqueued as delivery requests, and the async application main loop drains that queue by calling `dispatch` on target FSM objects before it goes back to waiting for external I/O.

## 2. Core Model

The module has four concepts:

- **Machine definition**: static declaration of states, events, handlers, and hooks.
- **Machine instance**: a regular JS/TS object with methods and typed fields. State-machine bookkeeping lives under a reserved `_sm` slot on that object.
- **Event**: untyped named input delivered to the machine, with an optional dictionary of arguments.
- **Command**: explicit side-effect request emitted by the machine for the outer runtime to execute.

The core flow is:

```text
send(name, args) -> global event queue -> app main loop -> dispatch -> sync transition -> on_enter hooks -> commands
commands -> async job queue -> job callback -> event envelope -> event queue
```

The FSM never awaits. If work requires I/O, timers, LLM calls, process waits, file operations, or network requests, the FSM emits a command and stops. The runtime converts the command into an async job. The job later invokes a callback that enqueues a completion event for the target FSM object.

## 3. Event Queue And Delivery

Events are delivered through a runtime-owned global queue. A queued event is an envelope containing the target object reference, an event name, and an argument dictionary. Event argument types are intentionally not enforced by the framework.

```ts
type MachineRef = {
  machine: string;
  id: string;
};

type EventEnvelope = {
  id: string;
  target: MachineRef;
  name: string;
  args?: Record<string, unknown>;
  causationId?: string;
  correlationId?: string;
  createdAt: string;
};
```

Delivery rules:

- The only way to advance an FSM object is to enqueue an `EventEnvelope` and let the runtime deliver it with `dispatch`.
- `self.send(name, args)` wraps the runtime's `enqueueEvent` function: it constructs an envelope addressed to the object's own `MachineRef` and pushes it to the global event queue. It does not call `dispatch` directly.
- Cross-object event delivery uses the runtime's `enqueueEvent` function directly with an explicit `target: MachineRef`. `self.send` is sugar for self-targeted events only.
- The event pump is one long-lived async task waiting on the queue. Queue wait is implemented with a stored promise resolver: when the queue is empty the pump awaits a promise; when `send` pushes an event it calls the resolver to wake the pump.
- Because wakeup resumes the pump through promise continuation scheduling, dispatch happens outside the current JavaScript call stack. `send` is always asynchronous with respect to dispatch.
- The async event pump drains queued FSM events before awaiting the queue again. This keeps dispatch synchronous while still integrating with asynchronous I/O.
- The runtime loads the target snapshot, dispatches the event synchronously, persists the new snapshot and emitted commands, then enqueues any async jobs derived from commands.
- Delivery for a single target object is serial. The runtime must not dispatch two events concurrently to the same FSM object.
- Delivery across different target objects may be concurrent if their persistence and command queues remain consistent.
- If dispatch throws `InvalidTransitionError`, it is for an unknown snapshot state or an invalid target state. Unhandled events are ignored, not thrown. The runtime records a diagnostic and does not retry the same event blindly.
- Event envelopes should have stable ids so delivery can be deduplicated after recovery. The FSM module does not inspect or use `id`; deduplication is the runtime's responsibility.
- Events should be persisted before delivery when losing them would strand durable work.

This queue is not a generic workflow bus. It is the runtime's durable delivery mechanism for FSM events.

The `AsyncEventQueue` and `runEventPump` are runtime code, not part of the FSM module. The FSM module exports only `defineMachine`, `dispatch`, and error classes.

The `drain()` implementation assumes single-threaded JavaScript: between `shift()` returning the first item and `drain()` being called, no other `push()` can interleave within the same microtask. This is safe in Node.js but would need synchronization in a multi-threaded environment.

Minimal queue/pump shape:

```ts
class AsyncEventQueue<T> {
  private items: T[] = [];
  private wake: (() => void) | undefined;

  push(item: T) {
    this.items.push(item);
    this.wake?.();
    this.wake = undefined;
  }

  async shift(): Promise<T> {
    while (this.items.length === 0) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }

    return this.items.shift()!;
  }

  drain(): T[] {
    const batch = this.items;
    this.items = [];
    return batch;
  }
}

async function runEventPump(queue: AsyncEventQueue<EventEnvelope>) {
  for (;;) {
    const first = await queue.shift();
    const batch = [first, ...queue.drain()];

    for (const event of batch) {
      const commands = dispatchEvent(event);
      for (const command of commands) startCommand(command);
    }
  }
}
```

The pump starts once during runtime startup with `void runEventPump(queue)`. Command execution is fire-and-forget from the pump perspective: `startCommand` starts async work, attaches completion/error callbacks, and those callbacks enqueue later FSM events through the same queue.

The `dispatchEvent` function in the pump sketch extracts the event from the envelope and calls the FSM module's `dispatch(machine, self, event)` with the envelope's `name` and `args` fields as the `Event`. `dispatchEvent` is runtime code; `dispatch` is the FSM module's pure synchronous function.

## 4. Async Job Queue And Callbacks

Commands emitted by FSM handlers are converted by the runtime into async jobs. Jobs do not mutate FSM state directly. They finish by invoking a callback that enqueues an event envelope.

Callbacks should normally be JavaScript/TypeScript closures. The closure can capture the target FSM object reference, event-construction data, and the runtime's `enqueueEvent` function.

```ts
type AsyncJob<Cmd extends Command> = {
  id: string;
  command: Cmd;
  callback: JobCallback;
  timeoutMs: number;
  createdAt: string;
};

type JobCallback = {
  onSucceeded: (result: unknown) => void;
  onFailed: (error: unknown) => void;
  onTimedOut: () => void;
};
```

The callback closure carries the target machine reference and knows how to translate job completion into an event for that object. For example, a provider-call job callback targets the LLM-loop FSM object and enqueues `provider_call_succeeded`, `provider_call_failed`, or `provider_call_timed_out` events.

Async jobs and callback closures are live runtime objects. They are not serialized. When the system restarts and reconstructs an FSM object from saved state, that object's recovery logic is responsible for recreating any needed async jobs and closures from the saved FSM state and durable domain state.

Job rules:

- Every async job must have a timeout or inactivity timeout.
- A job callback must enqueue an event; it must not call `dispatch` directly.
- A job callback must target exactly one FSM object.
- Job completion events must include enough correlation data for the target FSM object to reject stale or duplicate completions.
- Async jobs and callbacks are not persisted. If an object is recovered from saved state, its recovery code recreates any jobs that are safe to recreate and emits diagnostics or failure events for work that cannot be safely reconstructed.
- Cancellation is modeled as events and commands. The job queue may stop admitting new jobs for a cancelled scope, but already-running jobs normally finish or time out and then deliver their callback event.

Example callback closure:

```ts
function makeProviderCallback(input: {
  target: MachineRef;
  requestId: string;
  enqueueEvent: (envelope: EventEnvelope) => void;
}): JobCallback {
  const { target, requestId, enqueueEvent } = input;

  return {
    onSucceeded(result) {
      enqueueEvent({
        id: newEventId(),
        target,
        name: "provider_call_succeeded",
        args: {
          requestId,
          output: result as ModelOutput,
        },
        correlationId: requestId,
        createdAt: new Date().toISOString(),
      });
    },
    onFailed(error) {
      enqueueEvent({
        id: newEventId(),
        target,
        name: "provider_call_failed",
        args: {
          requestId,
          error: sanitizeError(error),
        },
        correlationId: requestId,
        createdAt: new Date().toISOString(),
      });
    },
    onTimedOut() {
      enqueueEvent({
        id: newEventId(),
        target,
        name: "provider_call_timed_out",
        args: {
          requestId,
        },
        correlationId: requestId,
        createdAt: new Date().toISOString(),
      });
    },
  };
}
```

When the job completes, it calls the closure. The closure constructs the event envelope and enqueues it for normal delivery.

## 5. Event Naming

Use event names that describe the source and semantic result, not generic `done` and `error` everywhere.

Recommended common event suffixes:

- `requested`: user/runtime asked for something, for example `run_requested`.
- `started`: an external operation started successfully.
- `succeeded`: an external operation completed successfully.
- `failed`: an external operation failed or returned an unusable result.
- `timed_out`: an external operation exceeded its configured timeout.
- `cancel_requested`: cancellation intent was delivered.
- `completed`: a child/workflow completed with a typed outcome.

Examples:

- `provider_call_succeeded`
- `provider_call_failed`
- `tool_call_succeeded`
- `tool_call_failed`
- `child_activation_completed`
- `process_wait_timed_out`
- `shutdown_requested`

Generic `done` and `error` are allowed only inside very small local machines where the source is unambiguous.

## 6. Machine Definition Shape

Example API sketch:

```ts
type Event = { name: string; args?: Record<string, unknown> };
type Command = { type: string; [key: string]: unknown };

type HandlerResult<State extends string, Cmd extends Command> = {
  state?: State;
  commands?: Cmd[];
};

type MachineSelf<State extends string> = {
  _sm: {
    state: State;
    ref?: MachineRef;
  };
  state(): State;
  send(name: string, args?: Record<string, unknown>): void;
};

type Handler<State extends string, Self extends MachineSelf<State>, Cmd extends Command> =
  (input: {
    self: Self;
    event: Event;
  }) => HandlerResult<State, Cmd>;

type LeaveHook<State extends string, Self extends MachineSelf<State>, Cmd extends Command> =
  (self: Self) => { commands?: Cmd[] } | void;

type StateDefinition<State extends string, Self extends MachineSelf<State>, Cmd extends Command> = {
  on_leave?: LeaveHook<State, Self, Cmd>;
  on_enter?: Handler<State, Self, Cmd>;
  on?: Record<string, State | Handler<State, Self, Cmd>>;
};

type MachineDefinition<State extends string, Self extends MachineSelf<State>, Cmd extends Command> = {
  initial: State;
  sequence?: State[];
  states: Record<State, StateDefinition<State, Self, Cmd>>;
};
```

`on` entries can be either:

- a target state string for direct transition;
- a handler function for validation, object field updates, command emission, and conditional transition.

Events are keyed by name. Event arguments are plain dictionaries and are validated, if needed, by the receiving handler.

`sequence` is an optional linear list of states. It exists only to support the `done`-means-advance convention. If a state appears in `sequence` and does not define its own `done` handler, `done` transitions to the next state in that list. The last state in the sequence has no implicit `done` transition.

`on_leave` runs before a state transition is committed. It is intentionally minimal: it receives only the current machine object, which knows the current state through `self.state()` and owns its own fields. It does not receive the triggering event or target state. Use it for generic state-scoped cleanup, such as cancelling or detaching live jobs owned by the current state.

`on_enter` runs after a state transition is committed in memory and before commands are returned to the caller.

`on_leave` rules:

- `on_leave` does not fire when the machine stays in the same state. It fires only on actual state transition.
- `on_leave` receives only the machine object (`self`), which knows its current state through `self.state()` and owns its own fields. It does not receive the triggering event or target state.

`on_enter` rules:

- `on_enter` does not fire for the initial state. The initial state is set by definition, not by transition. Use an explicit init event if the machine must emit commands at startup.
- `on_enter` receives the same inputs as a regular handler: `self` is the machine object after its state has been updated to the target state, and `event` is the original event that triggered the transition.

## 7. Dispatch Semantics

Dispatch is synchronous and deterministic.

```ts
type DispatchResult<State extends string, Cmd extends Command> = {
  state: State;
  commands: Cmd[];
};

function dispatch(machine, self, event): DispatchResult<...>;
```

Rules:

- `dispatch` mutates `self` in place. The caller holds a reference to the same object and can persist it after dispatch returns. `DispatchResult` returns the new state and emitted commands for convenience; it does not carry a separate object snapshot.
- If the current state has no handler for the event, dispatch ignores the event and returns no commands, except for implicit `done` advance in `sequence`.
- If a direct transition is configured, the state changes to the target and the target state's `on_enter` runs.
- If a handler is configured, the handler runs synchronously and may update the machine object, emit commands, and/or transition.
- If a handler returns no `state`, or explicitly returns the current state, or returns `undefined`, the machine stays in the same state. No transition occurs.
- `on_leave` fires only when the machine actually transitions to a different state. It does not fire when the handler stays in the same state.
- `on_enter` fires only when the machine actually transitions to a different state. It does not fire for the initial state (set by definition, not by transition).
- If a transition occurs, `on_leave` for the source state runs before the state change is committed.
- If a transition occurs, `on_enter` for the target state runs after the handler result is applied and the state change is committed.
- Commands returned by `on_leave`, the event handler, and `on_enter` are concatenated in deterministic order: `on_leave` commands first, handler commands second, `on_enter` commands third.
- `on_leave` must not trigger another transition directly. It may emit cleanup commands whose completion events later report diagnostics.
- `on_enter` must not trigger another state transition directly. It may emit commands whose completion events later trigger transitions.
- Handlers, `on_leave`, and `on_enter` must be pure with respect to external systems. They may compute commands but must not perform I/O.
- Handlers and `on_enter` may mutate the machine object fields synchronously. They must not mutate external systems or other machine objects.
- `on_leave` should be used for cleanup commands and should not mutate durable fields except for trivial local bookkeeping needed to detach live handles.

State-machine bookkeeping rules:

- All data owned by the FSM module lives under `self._sm`.
- `self._sm.state` is the current state and is the only required `_sm` field initially.
- `self._sm.ref` is an optional `MachineRef` set by the runtime when creating or recovering an FSM object. The FSM module does not create or manage refs.
- Domain data, runtime references, and object methods live outside `_sm`.
- Machine objects expose a `state()` method that returns `self._sm.state`.
- Machine objects expose a `send(name, args?)` method that queues an event for the same object in the global event queue. This method is added by the runtime, not by the FSM module. It closes over the runtime's `enqueueEvent` function and the object's `MachineRef`, so that `send` is equivalent to `enqueueEvent({ target: self._sm.ref, name, args })`. The FSM module does not define `send`; it documents the expected interface.
- The runtime sets `self._sm.ref` to the object's `MachineRef` when creating or recovering an FSM object. The FSM module does not create or manage refs; it only reserves the field name.
- Application handlers should use `self.state()` to read the current state. They should not read or mutate `_sm` directly except through `dispatch` or FSM-provided helpers.
- If the FSM module later needs local metadata, such as a sequence index cache or debug counters, it goes under `_sm` rather than becoming top-level object fields.

## 8. Minimal Conventions

These conventions keep common machines terse without adding a general workflow framework.

- `done` is the default advance event inside an explicitly declared `sequence`. If a state belongs to `sequence` and does not override `done`, `done` advances to the next state in that sequence.
- `error` is the conventional failure event name. It has no implicit behavior unless the machine or current state declares an `error` transition.
- `on_enter` starts or admits state-scoped work. `on_leave` stops, cancels, or detaches state-scoped work.
- Unhandled events are ignored by default. This matches the lightweight object style and avoids boilerplate no-op handlers.
- Event payloads are untyped dictionaries by framework design. Handlers own any argument validation they require.
- Specific event names are still preferred for externally meaningful completions, such as `provider_call_succeeded`, `tool_call_failed`, and `process_wait_timed_out`. `done` is for local step advancement where the source is obvious.

## 9. Persistence Boundary

The FSM module does not persist anything itself. The caller owns persistence.

Recommended runtime sequence:

```text
1. object calls send(name, args) or external code enqueues event envelope
2. event queue wakes the long-lived async event pump via stored promise resolver
3. event pump drains the global event queue before awaiting it again
4. delivery loop loads target snapshot
5. dispatch event through FSM
6. persist new snapshot and emitted commands atomically when possible
7. convert commands into async jobs
8. async job callback enqueues completion event envelope and wakes the pump
```

The FSM module does not define a snapshot type. Persistence is the runtime's responsibility. The runtime must be able to serialize and reconstruct `self` objects from persisted data. The module only requires that `self` objects have a reserved `_sm` slot with a `state` field matching the machine's state type and a `state()` method that returns it.

## 10. Command Effects

Commands are plain data emitted by handlers. They describe the side effect to perform, not what event to produce on completion. The callback closure (Section 4) is responsible for constructing the completion event envelope. Commands do not carry event-type-name mappings or callback references.

Example:

```ts
type RuntimeCommand =
  | {
      type: "call_provider";
      requestId: string;
      sessionId: string;
      timeoutMs: number;
    }
  | {
      type: "activate_child";
      requestId: string;
      childId: string;
      timeoutMs: number;
    };
```

The runtime converts a command into an async job by pairing it with a callback closure. The closure is constructed by the subsystem that knows the target FSM object, the event names to produce on each outcome, and the `enqueueEvent` function. The command itself stays serializable plain data.

Command rules:

- Every command that touches an external system must have a timeout or inactivity timeout.
- Every command must include enough correlation data for completion events to be routed back to the correct machine instance.
- Commands are not executed by the FSM module.
- Commands should carry enough identity for the owning FSM object's recovery code to decide whether a pending external operation should be recreated, ignored, or converted into a diagnostic/failure event.

## 11. Example: Supervisor Machine

```ts
type SupervisorState = "idle" | "running" | "paused" | "shutting_down";

type SupervisorFields = {
  projectId: string;
  lastOutcome?: "done" | "failed" | "blocked" | "cancelled";
};

type SupervisorSelf = MachineSelf<SupervisorState> & SupervisorFields;

type SupervisorCommand =
  | { type: "start_project"; projectId: string }
  | { type: "warn_already_running" }
  | { type: "terminate_runtime_processes"; timeoutMs: number };

const supervisorMachine = defineMachine<
  SupervisorState,
  SupervisorSelf,
  SupervisorCommand
>({
  initial: "idle",
  states: {
    idle: {
      on: {
        run_requested: ({ self }) => ({
          state: "running",
          commands: [{ type: "start_project", projectId: self.projectId }],
        }),
      },
    },

    running: {
      on: {
        run_requested: () => ({
          commands: [{ type: "warn_already_running" }],
        }),
        pause_requested: "paused",
        shutdown_requested: "shutting_down",
        project_completed: ({ self, event }) => {
          self.lastOutcome = event.args?.outcome as SupervisorFields["lastOutcome"];
          return { state: "idle" };
        },
      },
    },

    paused: {
      on: {
        run_requested: "running",
        shutdown_requested: "shutting_down",
      },
    },

    shutting_down: {
      on_enter: () => ({
        commands: [{ type: "terminate_runtime_processes", timeoutMs: 30_000 }],
      }),
      on: {
        processes_terminated: "idle",
      },
    },
  },
});
```

## 12. Example: LLM Loop Machine

This sketch shows the intended style. Provider calls and tool calls are commands; their completions return as events.

```ts
type LlmState = "ready" | "calling_provider" | "running_tool" | "completed" | "failed";

type LlmSelf = MachineSelf<LlmState> & LlmContext;

const llmLoopMachine = defineMachine<LlmState, LlmSelf, LlmCommand>({
  initial: "ready",
  states: {
    ready: {
      on: {
        start_requested: ({ self }) => ({
          state: "calling_provider",
          commands: [callProviderCommand(self)],
        }),
        cancel_requested: "failed",
      },
    },

    calling_provider: {
      on: {
        provider_call_succeeded: ({ self, event }) => {
          const parsed = parseModelOutput(event.args?.output as ModelOutput);
          if (parsed.kind === "outcome") {
            self.outcome = parsed.outcome;
            return {
              state: "completed",
            };
          }

          self.pendingTools = parsed.toolCalls;
          return {
            state: "running_tool",
            commands: [runNextToolCommand(parsed.toolCalls, self)],
          };
        },
        provider_call_failed: ({ self, event }) => {
          self.error = String(event.args?.error ?? "provider call failed");
          return { state: "failed" };
        },
        provider_call_timed_out: ({ self }) => {
          self.error = "provider call timed out";
          return { state: "failed" };
        },
        cancel_requested: ({ self }) => {
          self.cancellationRequested = true;
          return {};
        },
      },
    },

    running_tool: {
      on: {
        tool_call_succeeded: ({ self, event }) => {
          appendToolResult(self, event.args?.result as ToolResult);
          const nextTool = nextPendingTool(self);
          if (nextTool) {
            return {
              commands: [runToolCommand(nextTool, self)],
            };
          }

          return {
            state: "calling_provider",
            commands: [callProviderCommand(self)],
          };
        },
        tool_call_failed: ({ self, event }) => {
          self.error = String(event.args?.error ?? "tool call failed");
          return { state: "failed" };
        },
        cancel_requested: ({ self }) => {
          self.cancellationRequested = true;
          return {};
        },
      },
    },

    completed: {},
    failed: {},
  },
});
```

This version deliberately separates `calling_provider` from `ready`. That is not required globally, but it is useful in the LLM loop because provider calls, tool calls, cancellation, timeout, and recovery differ by phase.

## 13. API Surface

Minimal exported API:

```ts
export function defineMachine<State extends string, Self extends MachineSelf<State>, Cmd extends Command>(
  definition: MachineDefinition<State, Self, Cmd>,
): CompiledMachine<State, Self, Cmd>;

export function dispatch<State extends string, Self extends MachineSelf<State>, Cmd extends Command>(
  machine: CompiledMachine<State, Self, Cmd>,
  self: Self,
  event: Event,
): DispatchResult<State, Cmd>;

export class InvalidTransitionError extends Error {}
export class InvalidMachineDefinitionError extends Error {}
```

Optional helpers:

Do not add `assign` helpers, `transition` helpers, `command` helpers, interpreters, schedulers, timers, actor spawning, `delay`, or persistence adapters to this module initially. Those belong to the Saivage runtime or to a later iteration if repeated local patterns prove they belong here.

## 14. Validation Rules

At definition time:

- `initial` must exist in `states`.
- Every `sequence` state must exist in `states`.
- A state must not appear more than once in `sequence`.
- Every direct transition target must exist.
- State names and event names must be non-empty strings.
- `on_leave` must be a function when present.
- `on_enter` must be a function when present.
- `on` handlers must be functions or valid target states.

At dispatch time:

- Unknown current state throws.
- Unknown events for the current state are ignored.
- `InvalidTransitionError` is thrown only for unknown snapshot states and invalid target states, not for unhandled events.
- Handler throwing an exception converts to caller-visible failure; the module does not swallow it.

## 15. Testing Strategy

Test the FSM module independently:

- direct transition works;
- handler transition works;
- handler can update machine object fields;
- handler can emit commands;
- `on_leave` runs before transition;
- `on_enter` runs after transition;
- `on_leave` commands precede handler commands;
- handler commands precede `on_enter` commands;
- `done` advances within an explicitly declared sequence;
- unknown event is ignored;
- invalid target throws;
- no async behavior exists in the module.

Test the runtime delivery subsystem separately:

- event envelopes deliver to the referenced target object;
- `self.send(name, args)` enqueues an event and does not dispatch inline;
- `send` wakes the async event pump through a stored promise resolver;
- dispatch runs from the event pump after the current JavaScript call stack has unwound;
- the async event pump drains queued FSM events before awaiting the queue again;
- delivery for one target object is serial;
- commands become async jobs;
- closure callbacks enqueue completion event envelopes rather than calling dispatch directly;
- duplicate event ids are ignored or rejected deterministically;
- stale completion events are rejected by target FSM object fields;
- timeout callbacks produce timeout events.

Test Saivage machines separately by asserting domain invariants:

- duplicate Run emits warning and stays `running`;
- Shutdown emits process termination command;
- LLM loop executes tools serially;
- `activate_card` is a barrier command;
- cancellation waits for bounded operation completion events;
- project completion returns supervisor to `idle` while preserving project card outcome.

## 16. Non-Goals

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
- a generic workflow engine.

If Saivage later needs any of these, add them outside this module first. Promote into the FSM module only after repeated local patterns prove they belong there.

## 17. Why This Fits Saivage

This design keeps the useful part of state machines: explicit states, explicit events, invalid transition detection, and easy transition tests.

It avoids the part that made XState feel too large: actor hierarchy, invoked actor semantics, statechart features, and framework-owned async execution.

Saivage already needs its own durable runtime for cards, activation records, LLM sessions, process registry, and recovery. A synchronous declarative FSM plus explicit command effects maps directly to that runtime without hiding persistence or recovery behind framework behavior.
