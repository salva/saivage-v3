# Declarative FSM Module Architecture

Date: 2026-06-14.

Status: current runtime-core implementation architecture.

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

The runtime also owns actor event queues and event delivery. FSM objects do not call each other directly. Each actor has its own queue and pump. Sending to an actor pushes an event pair into that actor's queue; the actor pump serially calls `dispatch` for its own object. Different actors may run their pumps in parallel.

## 2. Core Model

The module has four concepts:

- **Actor definition**: static declaration of states, events, handlers, and hooks.
- **Actor**: a regular JS/TS object with methods and typed fields. State-machine bookkeeping lives under a reserved `_sm` slot on that object. Every actor owns one event queue and one dispatch pump.
- **Event**: untyped named input delivered to the actor, with an optional dictionary of arguments.
- **Command**: explicit side-effect request emitted by the machine for the outer runtime to execute.

The core flow is:

```text
send(name, args) -> actor event queue -> actor pump -> dispatch -> on_leave -> sync transition -> on_enter -> commands
commands -> async job queue -> job completion callback -> actor.send(name, args)
```

The FSM never awaits. If work requires I/O, timers, LLM calls, process waits, file operations, or network requests, the FSM emits a command and stops. The runtime converts the command into an async job. The job later sends a completion event to the target actor.

Creating an actor makes it live: the runtime installs `send()`, creates the actor-local event queue, and starts the actor pump. From that point, the supported way to advance the actor is `actor.send(name, args)`. The low-level `dispatch` function is what the actor pump calls internally; application/runtime code should not use direct dispatch as a delivery path.

## 3. Actor Event Queue And Delivery

Each actor owns an event queue whose items are plain event pairs: an event name plus an optional argument dictionary. The queue is actor-local, so it does not need to store a target. Routing happens before enqueue: code obtains the target actor and calls `target.send(name, args)`.

```ts
type MachineRef = {
  machine: string;
  id: string;
};

type ActorRef = MachineRef & {
  send(name: string, args?: Record<string, unknown>): void;
};

type Actor<State extends string> = ActorRef & {
  _sm: { state: State };
  state(): State;
  queue: AsyncEventQueue;
};

type Event = {
  name: string;
  args?: Record<string, unknown>;
};
```

Delivery rules:

- The only supported way to advance an actor is to push an `Event` into that actor's event queue and let that actor's pump call `dispatch`.
- `self.send(name, args)` pushes `{ name, args }` to the same actor's queue. It does not call `dispatch` directly.
- Cross-object event delivery obtains the target actor and calls `target.send(name, args)`. The event queue item itself remains target-free.
- Each actor pump is one long-lived async task waiting on one actor's queue. Queue wait is implemented with a stored promise resolver: when the queue is empty the pump awaits a promise; when runtime code pushes an event it calls the resolver to wake the pump.
- Because wakeup resumes the pump through promise continuation scheduling, dispatch happens outside the current JavaScript call stack. `send` is always asynchronous with respect to dispatch.
- The actor pump drains queued events before awaiting the queue again. This keeps one actor serial while allowing different actor pumps to run in parallel.
- The actor pump dispatches the event synchronously, persists the updated object state and emitted commands, then starts any async jobs derived from commands.
- Delivery for a single actor is serial. The runtime must not dispatch two events concurrently to the same FSM object.
- Delivery across different actors may be concurrent if their persistence and command queues remain consistent.
- If dispatch throws `InvalidTransitionError`, it is for an unknown current state or an invalid target state. Unhandled events are ignored, not thrown. The runtime records a diagnostic and does not retry the same event blindly.
- Durable delivery records, when needed, should have stable ids so delivery can be deduplicated after recovery. The FSM module does not inspect or use those ids; deduplication is the runtime's responsibility.
- Events should be persisted before delivery when losing them would strand durable work.

This queue is not a generic workflow bus. It is a per-actor mailbox for FSM events. Queue items are only event pairs; target selection, command execution, persistence, and recovery are actor/runtime responsibilities around the queue.

The `AsyncEventQueue` and `runEventPump` are runtime code. They are intentionally small and actor-local. The FSM module's deterministic core remains `defineMachine`, `dispatch`, and error classes.

The `drain()` implementation assumes single-threaded JavaScript: between `shift()` returning the first item and `drain()` being called, no other `push()` can interleave within the same microtask. This is safe in Node.js but would need synchronization in a multi-threaded environment.

Minimal queue/pump shape:

```ts
class AsyncEventQueue {
  private items: Event[] = [];
  private wake: (() => void) | undefined;

  push(event: Event) {
    this.items.push(event);
    this.wake?.();
    this.wake = undefined;
  }

  async shift(): Promise<Event> {
    while (this.items.length === 0) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }

    return this.items.shift()!;
  }

  drain(): Event[] {
    const batch = this.items;
    this.items = [];
    return batch;
  }
}

async function runEventPump(actor: Actor) {
  for (;;) {
    const first = await actor.queue.shift();
    const batch = [first, ...actor.queue.drain()];

    for (const event of batch) {
      try {
        const commands = dispatch(actor.machine, actor.self, event);
        actor.startCommands(commands);
      } catch (error) {
        actor.reportError(error, event);
      }
    }
  }
}
```

Each actor pump starts when its actor is created, for example `void runEventPump(actor)`. Command execution is fire-and-forget from the pump perspective: `startCommands` starts async work, attaches completion/error callbacks, and those callbacks later call `actor.send(...)`.

The actor pump owns dispatch for exactly one machine object. The queue only stores event pairs; the pump supplies actor-local machine, self, persistence, command-starting, and error-reporting behavior.

## 4. Async Job Completion

Commands emitted by FSM handlers are converted by the runtime into async jobs. Jobs do not mutate FSM state directly. They finish by sending an event to the owning actor.

Callbacks should normally be JavaScript/TypeScript closures. The closure can capture the target actor reference and event-construction data, then call `actor.send(name, args)` on completion.

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

The job callback closure carries the target actor reference and knows how to translate job completion into an event for that actor. For example, a provider-call job callback targets the LLM-loop actor and sends `provider_call_succeeded`, `provider_call_failed`, or `provider_call_timed_out`.

Async jobs and callback closures are live runtime objects. They are not serialized. When the system restarts and reconstructs an FSM object from saved state, that object's recovery logic is responsible for recreating any needed async jobs and closures from the saved FSM state and durable domain state.

Job rules:

- Every async job must have a timeout or inactivity timeout.
- A job callback must call `actor.send(name, args)`; it must not call `dispatch` directly.
- A job callback must target exactly one actor.
- Job completion events must include enough correlation data for the target FSM object to reject stale or duplicate completions.
- Async jobs and callbacks are not persisted. If an object is recovered from saved state, its recovery code recreates any jobs that are safe to recreate and emits diagnostics or failure events for work that cannot be safely reconstructed.
- Cancellation is modeled as events and commands. The job queue may stop admitting new jobs for a cancelled scope, but already-running jobs normally finish or time out and then deliver their callback event.

Example callback closure:

```ts
function makeProviderCallback(input: {
  target: ActorRef;
  requestId: string;
}): JobCallback {
  const { target, requestId } = input;

  return {
    onSucceeded(result) {
      target.send("provider_call_succeeded", {
        requestId,
        output: result as ModelOutput,
      });
    },
    onFailed(error) {
      target.send("provider_call_failed", {
        requestId,
        error: sanitizeError(error),
      });
    },
    onTimedOut() {
      target.send("provider_call_timed_out", {
        requestId,
      });
    },
  };
}
```

When the job completes, it calls the closure. The closure constructs the event pair and sends it to the target actor's queue.

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
  };
  state(): State;
  send(name: string, args?: Record<string, unknown>): void;
};

type Handler<State extends string, Self extends MachineSelf<State>, Cmd extends Command> =
  (input: {
    self: Self;
    event: Event;
  }) => HandlerResult<State, Cmd> | void;

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

function dispatch<State extends string, Self extends MachineSelf<State>, Cmd extends Command>(
  machine: CompiledMachine<State, Self, Cmd>,
  self: Self,
  event: Event,
): DispatchResult<State, Cmd>;
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
- Domain data, runtime references, and object methods live outside `_sm`.
- Machine objects expose a `state()` method that returns `self._sm.state`.
- Machine objects expose a `send(name, args?)` method that pushes `{ name, args }` to the same actor's event queue. This method is added by the runtime, not by the FSM module. It closes over the actor-local queue. The FSM module does not define `send`; it documents the expected interface.
- The runtime owns `MachineRef` assignment. The ref may live in a runtime registry or closure; it does not need to be stored under `_sm` unless a later implementation proves that storing it there is useful.
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
1. actor receives send(name, args) and pushes `{ name, args }` to its event queue
2. actor event queue wakes that actor's long-lived async pump via stored promise resolver
3. actor pump drains queued events before awaiting it again
4. actor pump loads or reconstructs the actor's machine object when needed
5. actor pump dispatches event through FSM
6. actor pump persists updated object state and emitted commands atomically when possible
7. actor pump converts commands into async jobs
8. async job completion calls actor.send(name, args) and wakes the pump
```

The FSM module does not define a snapshot type. Persistence is the runtime's responsibility. The runtime must be able to serialize and reconstruct `self` objects from persisted data. The module only requires that `self` objects have a reserved `_sm` slot with a `state` field matching the machine's state type, a `state()` method that returns it, and a runtime-provided `send()` method that pushes self-addressed events to the actor-local queue.

## 10. Command Effects

Commands are plain data emitted by handlers. They describe the side effect to perform, not what event to produce on completion. The job callback closure (Section 4) is responsible for constructing the completion event pair and sending it to the target actor. Commands do not carry event-type-name mappings or callback references.

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

The runtime converts a command into an async job by pairing it with a callback closure. The closure is constructed by the subsystem that knows the target actor and the event names to produce on each outcome. The command itself stays serializable plain data.

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
- `InvalidTransitionError` is thrown only for unknown current states and invalid target states, not for unhandled events.
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

- actor queues store only `{ name, args? }` event pairs;
- `self.send(name, args)` pushes an event pair and does not dispatch inline;
- `send` wakes the actor event pump through a stored promise resolver;
- dispatch runs from the actor pump after the current JavaScript call stack has unwound;
- the actor event pump drains queued events before awaiting the queue again;
- delivery for one actor is serial;
- different actor pumps may process events in parallel;
- commands become async jobs;
- job completion callbacks call `actor.send(name, args)` rather than calling dispatch directly;
- duplicate durable delivery records are ignored or rejected deterministically;
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
