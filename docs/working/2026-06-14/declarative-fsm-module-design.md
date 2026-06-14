# Declarative FSM Module Design

Date: 2026-06-14.

Status: working design.

## 1. Goal

Define a small TypeScript module for declarative finite-state machines with synchronous transitions and explicit async command effects. It should provide the state-machine abstraction Saivage needs without adopting XState's actor/statechart framework.

The design is inspired by `Class::StateMachine::Declarative`, but intentionally supports only a minimal subset:

- declarative state and event definitions;
- synchronous event handling;
- state transitions;
- `on_enter` hooks after transitions;
- event handlers that may either return commands or request transitions;
- no internal async execution;
- no hidden actors;
- no nested statecharts;
- no implicit command bus.

The FSM module is the deterministic core. A separate runtime executes async commands and dispatches completion events back into the FSM.

The runtime also owns event queueing and delivery. FSM objects do not call each other directly. Events are enqueued as delivery requests, and the runtime delivers them by calling `dispatch` on the target FSM object.

## 2. Core Model

The module has four concepts:

- **Machine definition**: static declaration of states, events, handlers, and hooks.
- **Machine instance**: current state plus typed context.
- **Event**: synchronous input delivered to the machine.
- **Command**: explicit side-effect request emitted by the machine for the outer runtime to execute.

The core flow is:

```text
event envelope -> event queue -> dispatch -> sync transition -> on_enter hooks -> commands
commands -> async job queue -> job callback -> event envelope -> event queue
```

The FSM never awaits. If work requires I/O, timers, LLM calls, process waits, file operations, or network requests, the FSM emits a command and stops. The runtime converts the command into an async job. The job later invokes a callback that enqueues a completion event for the target FSM object.

## 3. Event Queue And Delivery

Events are delivered through a runtime-owned queue. A queued event is an envelope containing the target object reference and the event payload.

```ts
type MachineRef = {
  machine: string;
  id: string;
};

type EventEnvelope<Ev extends Event> = {
  id: string;
  target: MachineRef;
  event: Ev;
  causationId?: string;
  correlationId?: string;
  createdAt: string;
};
```

Delivery rules:

- The only way to advance an FSM object is to enqueue an `EventEnvelope` and let the runtime deliver it with `dispatch`.
- The runtime loads the target snapshot, dispatches the event synchronously, persists the new snapshot and emitted commands, then enqueues any async jobs derived from commands.
- Delivery for a single target object is serial. The runtime must not dispatch two events concurrently to the same FSM object.
- Delivery across different target objects may be concurrent if their persistence and command queues remain consistent.
- If dispatch throws `InvalidTransitionError`, the runtime records a diagnostic and does not retry the same event blindly.
- Event envelopes should have stable ids so delivery can be deduplicated after recovery.
- Events should be persisted before delivery when losing them would strand durable work.

This queue is not a generic workflow bus. It is the runtime's durable delivery mechanism for FSM events.

## 4. Async Job Queue And Callbacks

Commands emitted by FSM handlers are converted by the runtime into async jobs. Jobs do not mutate FSM state directly. They finish by invoking a callback that enqueues an event envelope.

Callbacks should normally be JavaScript/TypeScript closures. The closure can capture the target FSM object reference, event-construction data, and the runtime's `enqueueEvent` function.

```ts
type AsyncJob<Cmd extends Command, Ev extends Event> = {
  id: string;
  command: Cmd;
  callback: JobCallback<Ev>;
  timeoutMs: number;
  createdAt: string;
};

type JobCallback<Ev extends Event> = {
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
  enqueueEvent: (envelope: EventEnvelope<LlmEvent>) => void;
}): JobCallback<LlmEvent> {
  const { target, requestId, enqueueEvent } = input;

  return {
    onSucceeded(result) {
      enqueueEvent({
        id: newEventId(),
        target,
        event: {
          type: "provider_call_succeeded",
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
        event: {
          type: "provider_call_failed",
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
        event: {
          type: "provider_call_timed_out",
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
type Event = { type: string; [key: string]: unknown };
type Command = { type: string; [key: string]: unknown };

type HandlerResult<State extends string, Context, Cmd extends Command> = {
  state?: State;
  context?: Context;
  commands?: Cmd[];
};

type Handler<State extends string, Context, Ev extends Event, Cmd extends Command> =
  (input: {
    state: State;
    context: Context;
    event: Ev;
  }) => HandlerResult<State, Context, Cmd>;

type StateDefinition<State extends string, Context, Ev extends Event, Cmd extends Command> = {
  on_enter?: Handler<State, Context, Ev, Cmd>;
  on?: Partial<Record<Ev["type"], State | Handler<State, Context, Ev, Cmd>>>;
};

type MachineDefinition<State extends string, Context, Ev extends Event, Cmd extends Command> = {
  initial: State;
  states: Record<State, StateDefinition<State, Context, Ev, Cmd>>;
};
```

`on` entries can be either:

- a target state string for direct transition;
- a handler function for validation, context updates, command emission, and conditional transition.

`on_enter` runs after a state transition is committed in memory and before commands are returned to the caller.

`on_enter` rules:

- `on_enter` does not fire for the initial state. The initial state is set by definition, not by transition. Use an explicit init event if the machine must emit commands at startup.
- `on_enter` does not fire when a handler stays in the same state (returns no `state` field). `on_enter` fires only on entry to a new state.
- `on_enter` receives the same inputs as a regular handler: `state` is the target state the machine just entered, `context` is the context after the triggering handler's updates, and `event` is the original event that triggered the transition.

## 7. Dispatch Semantics

Dispatch is synchronous and deterministic.

```ts
type DispatchResult<State extends string, Context, Cmd extends Command> = {
  state: State;
  context: Context;
  commands: Cmd[];
};

function dispatch(machine, snapshot, event): DispatchResult<...>;
```

Rules:

- If the current state has no handler for the event, dispatch throws `InvalidTransitionError`.
- If a direct transition is configured, the state changes to the target and the target state's `on_enter` runs.
- If a handler is configured, the handler runs synchronously and may update context, emit commands, and/or transition.
- If a handler returns no `state`, the machine remains in the current state.
- If a transition occurs, `on_enter` for the target state runs after the handler result is applied.
- Commands returned by the event handler and `on_enter` are concatenated in deterministic order: handler commands first, `on_enter` commands second.
- `on_enter` must not trigger another state transition directly. It may emit commands whose completion events later trigger transitions.
- Handlers and `on_enter` must be pure with respect to external systems. They may compute commands but must not perform I/O.
- Handlers and `on_enter` must not mutate the input context. Return a new or updated context in the handler result. The runtime should treat context as immutable and replace it atomically with the handler result.

## 8. Persistence Boundary

The FSM module does not persist anything itself. The caller owns persistence.

Recommended runtime sequence:

```text
1. receive event
2. enqueue event envelope
3. delivery loop loads target snapshot
4. dispatch event through FSM
5. persist new snapshot and emitted commands atomically when possible
6. convert commands into async jobs
7. async job callback enqueues completion event envelope
```

Snapshot shape:

```ts
type MachineSnapshot<State extends string, Context> = {
  machine: string;
  id: string;
  state: State;
  context: Context;
  version: number;
};
```

The module should include a small snapshot validator, but it should not know where snapshots are stored.

## 9. Command Effects

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

The runtime converts a command into an async job by pairing it with a callback closure. The closure is constructed by the subsystem that knows the target FSM object, the event types to produce on each outcome, and the `enqueueEvent` function. The command itself stays serializable plain data.

Command rules:

- Every command that touches an external system must have a timeout or inactivity timeout.
- Every command must include enough correlation data for completion events to be routed back to the correct machine instance.
- Commands are not executed by the FSM module.
- Commands should carry enough identity for the owning FSM object's recovery code to decide whether a pending external operation should be recreated, ignored, or converted into a diagnostic/failure event.

## 10. Example: Supervisor Machine

```ts
type SupervisorState = "idle" | "running" | "paused" | "shutting_down";

type SupervisorContext = {
  projectId: string;
  lastOutcome?: "done" | "failed" | "blocked" | "cancelled";
};

type SupervisorEvent =
  | { type: "run_requested" }
  | { type: "pause_requested" }
  | { type: "shutdown_requested" }
  | { type: "project_completed"; outcome: SupervisorContext["lastOutcome"] }
  | { type: "processes_terminated" };

type SupervisorCommand =
  | { type: "start_project"; projectId: string }
  | { type: "warn_already_running" }
  | { type: "terminate_runtime_processes"; timeoutMs: number };

const supervisorMachine = defineMachine<
  SupervisorState,
  SupervisorContext,
  SupervisorEvent,
  SupervisorCommand
>({
  initial: "idle",
  states: {
    idle: {
      on: {
        run_requested: ({ context }) => ({
          state: "running",
          commands: [{ type: "start_project", projectId: context.projectId }],
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
        project_completed: ({ context, event }) => ({
          state: "idle",
          context: { ...context, lastOutcome: event.outcome },
        }),
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

## 11. Example: LLM Loop Machine

This sketch shows the intended style. Provider calls and tool calls are commands; their completions return as events.

```ts
type LlmState = "ready" | "calling_provider" | "running_tool" | "completed" | "failed";

type LlmEvent =
  | { type: "start_requested" }
  | { type: "provider_call_succeeded"; output: ModelOutput }
  | { type: "provider_call_failed"; error: string }
  | { type: "provider_call_timed_out" }
  | { type: "tool_call_succeeded"; result: ToolResult }
  | { type: "tool_call_failed"; error: string }
  | { type: "cancel_requested" };

const llmLoopMachine = defineMachine<LlmState, LlmContext, LlmEvent, LlmCommand>({
  initial: "ready",
  states: {
    ready: {
      on: {
        start_requested: ({ context }) => ({
          state: "calling_provider",
          commands: [callProviderCommand(context)],
        }),
        cancel_requested: "failed",
      },
    },

    calling_provider: {
      on: {
        provider_call_succeeded: ({ context, event }) => {
          const parsed = parseModelOutput(event.output);
          if (parsed.kind === "outcome") {
            return {
              state: "completed",
              context: { ...context, outcome: parsed.outcome },
            };
          }

          return {
            state: "running_tool",
            context: { ...context, pendingTools: parsed.toolCalls },
            commands: [runNextToolCommand(parsed.toolCalls, context)],
          };
        },
        provider_call_failed: ({ context, event }) => ({
          state: "failed",
          context: { ...context, error: event.error },
        }),
        provider_call_timed_out: ({ context }) => ({
          state: "failed",
          context: { ...context, error: "provider call timed out" },
        }),
        cancel_requested: ({ context }) => ({
          context: { ...context, cancellationRequested: true },
        }),
      },
    },

    running_tool: {
      on: {
        tool_call_succeeded: ({ context, event }) => {
          const nextContext = appendToolResult(context, event.result);
          const nextTool = nextPendingTool(nextContext);
          if (nextTool) {
            return {
              context: nextContext,
              commands: [runToolCommand(nextTool, nextContext)],
            };
          }

          return {
            state: "calling_provider",
            context: nextContext,
            commands: [callProviderCommand(nextContext)],
          };
        },
        tool_call_failed: ({ context, event }) => ({
          state: "failed",
          context: { ...context, error: event.error },
        }),
        cancel_requested: ({ context }) => ({
          context: { ...context, cancellationRequested: true },
        }),
      },
    },

    completed: {},
    failed: {},
  },
});
```

This version deliberately separates `calling_provider` from `ready`. That is not required globally, but it is useful in the LLM loop because provider calls, tool calls, cancellation, timeout, and recovery differ by phase.

## 12. API Surface

Minimal exported API:

```ts
export function defineMachine<State, Context, Event, Command>(
  definition: MachineDefinition<State, Context, Event, Command>,
): CompiledMachine<State, Context, Event, Command>;

export function dispatch<State, Context, Event, Command>(
  machine: CompiledMachine<State, Context, Event, Command>,
  snapshot: MachineSnapshot<State, Context>,
  event: Event,
): DispatchResult<State, Context, Command>;

export class InvalidTransitionError extends Error {}
export class InvalidMachineDefinitionError extends Error {}
```

Optional helpers:

```ts
export function command<Command>(command: Command): { commands: Command[] };
```

Do not add `assign` helpers, `transition` helpers, interpreters, schedulers, timers, actor spawning, or persistence adapters to this module initially. Those belong to the Saivage runtime. Inline spread syntax like `{ context: { ...context, ...patch } }` is readable without an `assign` helper.

## 13. Validation Rules

At definition time:

- `initial` must exist in `states`.
- Every direct transition target must exist.
- State names and event names must be non-empty strings.
- `on_enter` must be a function when present.
- `on` handlers must be functions or valid target states.

At dispatch time:

- Unknown current state throws.
- Unknown event for current state throws.
- Handler returning an unknown target state throws.
- Handler throwing an exception converts to caller-visible failure; the module does not swallow it.

## 14. Testing Strategy

Test the FSM module independently:

- direct transition works;
- handler transition works;
- handler can update context;
- handler can emit commands;
- `on_enter` runs after transition;
- handler commands precede `on_enter` commands;
- invalid event throws;
- invalid target throws;
- no async behavior exists in the module.

Test the runtime delivery subsystem separately:

- event envelopes deliver to the referenced target object;
- delivery for one target object is serial;
- commands become async jobs;
- closure callbacks enqueue completion event envelopes rather than calling dispatch directly;
- duplicate event ids are ignored or rejected deterministically;
- stale completion events are rejected by target FSM context;
- timeout callbacks produce timeout events.

Test Saivage machines separately by asserting domain invariants:

- duplicate Run emits warning and stays `running`;
- Shutdown emits process termination command;
- LLM loop executes tools serially;
- `activate_card` is a barrier command;
- cancellation waits for bounded operation completion events;
- project completion returns supervisor to `idle` while preserving project card outcome.

## 15. Non-Goals

The module should not implement:

- hierarchical states;
- parallel states;
- actor supervision;
- delayed transitions;
- async actions;
- built-in persistence;
- built-in command execution;
- cross-object synchronous calls;
- implicit retries;
- visual statechart tooling;
- a generic workflow engine.

If Saivage later needs any of these, add them outside this module first. Promote into the FSM module only after repeated local patterns prove they belong there.

## 16. Why This Fits Saivage

This design keeps the useful part of state machines: explicit states, explicit events, invalid transition detection, and easy transition tests.

It avoids the part that made XState feel too large: actor hierarchy, invoked actor semantics, statechart features, and framework-owned async execution.

Saivage already needs its own durable runtime for cards, activation records, LLM sessions, process registry, and recovery. A synchronous declarative FSM plus explicit command effects maps directly to that runtime without hiding persistence or recovery behind framework behavior.
