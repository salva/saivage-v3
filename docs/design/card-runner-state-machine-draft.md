# Card Runner State Machine Draft

Status: draft design. This document describes a target architecture, not current
runtime behavior. Current behavior remains documented in
[Agents and runtime architecture](../agents.md).

## 1. Goal

Replace recursive card dispatch with card runners that coordinate through an
explicit in-memory delayed-call queue.

The runtime must be able to stop after any persisted transition, restart, read
state from disk, and continue without relying on the JavaScript call stack. The
delayed-call queue itself is not persisted. It is regenerated from persisted
card runner state, agent runner state, process records, and recovery hooks.

## 2. Core Separation

The runtime has three state layers.

The layers are semantic boundaries, not merely different enum names. The same
word may appear in more than one layer, but it must mean something different at
each layer:

- Public card status is the card's externally visible lifecycle from the
  runtime/operator/planner point of view.
- Card runner state is the private state of the process that runs while that
  card is publicly running.
- Agent runner state is an implementation detail of one attached LLM agent
  interaction.

Do not decide correctness by comparing state names across layers. Decide it by
which semantic question the state answers.

### 2.1 Public Card Status

The public card status is the lifecycle visible to planners, operators, and
other cards:

```text
backlog | changed | running | done | cancelled | failed | blocked | deleted
```

This status answers: what is the card's externally visible lifecycle state?

It does not answer which agent is currently running, which tool is waiting, or
how to resume the card after restart.

### 2.2 Card Runner State

The card runner state is runtime-internal orchestration state for one card.

It answers:

- Which attached agent should run next for this card?
- Is this card waiting for a child, review, or other card-level continuation?
- What durable card-level information is needed to resume after restart?

The runner must not duplicate lifecycle outcomes. It must not have states like
`done`, `failed`, `blocked`, or `cancelled`. Those belong to the public card
status.

When a card reaches a terminal public status, its card runner should have no
active card-level work.

### 2.3 Agent Runner State

The agent runner state is runtime-internal execution state for one attached
agent.

It answers:

- Is this attached agent currently being invoked?
- Is this attached agent waiting for a tool result?
- Which tool call must receive the next tool result?

The agent runner is generic. It should not have role-specific states like
`planning`, `executing`, or `reviewing`. Those meanings come from the attached
agent role and the card runner state.

## 3. Attached Agents

Operational agents are attached to cards and live for the lifetime of the card.

Agent ids are deterministic:

```text
planner:<goal_or_project_card_id>
reviewer:<goal_or_project_card_id>
executor:<terminal_card_id>
```

The analyst is not part of this model.

Agents do not have `done`, `failed`, or `blocked` status. A session exists
because its card exists. Whether it is currently being invoked is agent runner
state, not session state.

## 4. Minimal Runner Phases

Use the smallest phase set that supports durable recovery.

### 4.1 Card Runner

Card runner phases are card-type workflow phases. They should be concrete names
such as `planning`, `reviewing`, or `executing`.

Do not add generic card runner phases like `should_run_agent` or
`waiting_for_child`. Agent execution and tool waits belong to the AgentRunner.

Example phases:

```ts
type GoalCardRunnerPhase =
  | { kind: 'idle' }
  | { kind: 'planning'; planner_agent_id: string }
  | { kind: 'reviewing'; reviewer_agent_id: string };

type TerminalCardRunnerPhase =
  | { kind: 'idle' }
  | { kind: 'executing'; executor_agent_id: string };
```

`idle` means the runner has no active work. The card may be in `backlog`, a
`changed`, a terminal status, or waiting to be started by a delayed call.

`planning` means the goal card is actively controlled by its planner agent.

`reviewing` means the goal card is actively controlled by its reviewer agent.
Any review-attempt identifier is reviewer-result metadata, not card-runner
control state. See [Reviewer Attempt Identity](#142-reviewer-attempt-identity).

`executing` means the terminal card is actively controlled by its executor
agent. The terminal card may be a coding, research, documentation, validation,
or other terminal work item.

When a card runner enters an active state, the matching `_on_enter__*` handler
explicitly enqueues a delayed call for the attached agent. For example,
`_on_enter__executing` calls the queue service to enqueue
`agentRunner.invoke_agent()` for `executor:<card>`.

### 4.2 Agent Runner

Agent runner phases are generic agent execution phases.

```ts
type AgentRunnerPhase =
  | { kind: 'idle' }
  | { kind: 'running' }
  | {
      kind: 'waiting_for_tool';
      tool_call_id: string;
      tool_name: string;
      wait: ToolWait;
    };
```

`idle` means the agent is not currently being invoked and is not waiting for a
tool result.

`running` means an `invoke_agent` call is in progress or has been persisted as
in progress.

Agent runner state must be kept current on disk at every model/tool boundary.
Recovery resumes from the last persisted agent state and message history, not
from in-memory delayed calls.

`waiting_for_tool` means the attached agent emitted a tool call and cannot
continue until runtime appends the matching tool result or tool error.

## 5. Tool Waits

Start with only the waits needed by current card execution.

```ts
type ToolWait =
  | {
      kind: 'child_card';
      child_card_id: string;
    }
  | {
      kind: 'process';
      process_id: string;
    };
```

Add more wait kinds only when a real runtime tool needs durable async waiting.

`activate_card` uses `child_card`.

Long-running process tools use `process` only when runtime must resume after the
process completes or after restart.

### 5.1 Changed Cards

`changed` is a public card status, not a CardRunner phase.

When an analyst or external correction marks a card `changed`, the card's
CardRunner does not start work by itself and does not leave `idle` unless it was
already active for another reason. The change is surfaced to the responsible
planner through the normal notification/context path. A planner may later call
`activate_card` for that changed card, and `start_card` consumes `changed` the
same way it consumes `backlog`: the public card status becomes `running` and the
CardRunner enters its active phase.

`changed` does not wake planners by itself. It is visible context for the next
planner turn or activation.

## 6. Delayed Calls

Delayed calls are an in-memory FIFO queue of async functions.

Do not queue private state changes. Do not queue free-form action records. Do not
persist the queue to disk. Do not create a scheduler abstraction in the first
design. The recursion-breaking point is the delayed function call: work that
would otherwise be invoked recursively is pushed onto the runtime's in-memory
queue and executed later by the sequential processor.

Delayed calls are processed one at a time in FIFO order. A delayed call invokes
an async public method on its target object. That method may change its own
private state and may enqueue more delayed calls by explicitly calling the queue
service. If the process stops, pending in-memory delayed calls are lost by
design. Runtime resumes from persisted object state by running recovery hooks,
which may enqueue the calls needed to continue.

Conceptual delayed call shape:

```ts
type DelayedCall = () => Promise<void>;

interface DelayedCallQueue {
  enqueue(call: DelayedCall): void;
  drain(): Promise<void>;
}
```

Every runtime operation in this model is async, including delayed calls,
`_set_state`, public methods, entry hooks, recovery hooks, and resume hooks. The
queue processor awaits each delayed call before taking the next one. It never
runs two delayed calls concurrently.

An implementation may wrap function calls with debug metadata, but that metadata
is not authoritative runtime state:

```ts
type DelayedCallDebugMetadata = {
  id?: string;
  target: { kind: 'card_runner' | 'agent_runner' | 'runtime'; id: string };
  method: string;
  created_at: string;
};
```

Examples:

```ts
queue.enqueue(() => cardRunner('T-7').start_card());
queue.enqueue(() => agentRunner('executor:T-7').invoke_agent());
queue.enqueue(() => agentRunner('planner:G-12').append_tool_result(toolCallId, content));
queue.enqueue(() => cardRunner('G-12').notify_child_finished(childId, outcome));
```

Do not add delayed calls for hypothetical future features.

## 7. Processing A Delayed Call

Processing a delayed call has this shape:

```text
take one delayed call from the in-memory queue
invoke the target object's public method
persist any card/cardRunner/agentRunner/message changes made by that method
repeat until the queue is empty or runtime is quiescing for pause/stop
```

Public methods do not return delayed calls. If a method needs another object to
act later, it explicitly calls the delayed-call queue service:

```ts
queue.enqueue(() => target.public_method(...args));
```

Examples:

- `agentRunner.invoke_agent()` calls the model. If it receives a tool call,
  terminal result, or protocol error, it explicitly enqueues a delayed call to
  its own public handler.
- `agentRunner.append_tool_result(...)` appends the tool result. If the agent
  should continue, it explicitly enqueues `agentRunner.invoke_agent()`.
- `cardRunner.start_card()` may enter `executing`; `_on_enter__executing`
  explicitly enqueues `executorAgentRunner.invoke_agent()`.

Methods that only patch local state do not enqueue follow-up work.

All local state changes made by the method must be persisted before external
side effects run. There is no rollback across external effects. Recovery moves
forward from durable state. Because delayed calls are not persisted, any
necessary post-restart continuation must be derivable from persisted state and
implemented in `_on_recovery__*`.

## 8. State Entry Convention

State changes are private to the object that owns the state.

A delayed call or notification is handled by a public method. That method may
change the receiver's private state by calling:

```ts
await _set_state(newState)
```

`_set_state` persists the new state, then calls the state-entry hook:

```ts
await _on_enter(newState)
```

So the internal flow is:

```text
delayed call / notification
  -> public receiver method
    -> _set_state(newState)
      -> persist state
      -> _on_enter(newState)
        -> _on_enter__{new_state_name}
```

`_on_enter` dispatches by convention to private state-specific methods:

```text
_on_enter__{new_state_name}
```

Examples:

```text
_on_enter__planning
_on_enter__reviewing
_on_enter__executing
_on_enter__running
_on_enter__waiting_for_tool
```

An `_on_enter__*` handler may perform immediate side effects for that entered
state and return:

```ts
RunnerState | null
```

If it returns `null`, the object stays in the state that was just entered. If it
returns another state, `_set_state(returnedState)` is called for the same object.
That means the returned state's `_on_enter__{state}` actions must also run.

Rules:

- External objects must not call `_set_state` on another object.
- `_set_state` is the only way an object changes its own runner state.
- `_set_state` must persist the new state before `_on_enter` runs.
- `_set_state(...)` must be the last active operation in its branch. Returning a
  value after `_set_state(...)` is acceptable; mutating state, invoking another
  object, or enqueueing more work after `_set_state(...)` is not.
- This rule exists because `_set_state(...)` may trigger `_on_enter__*` work that
  changes the runtime situation in ways the caller should not continue to reason
  about as if it were still in the old state.
- The method does not magically abort the caller. Callers are responsible for
  returning immediately after `_set_state(...)` so no old-state logic runs after
  the state change.
- `_on_enter__*` methods must be small and explicit.
- `_on_enter__*` methods may return a new state for the same object. Returning a
  new state is a private diversion, not an external call.
- State diversion is for exceptional local outcomes, usually failure handling or
  repair. It is not the normal mechanism for progressing workflow. Normal
  workflow progression should use delayed calls and public methods.
- When `_on_enter__*` returns a new state, the object must enter that new state
  through `_set_state`, persist it, and run the new state's `_on_enter__*`
  handler too.
- If entering a state requires no immediate side effect, its `_on_enter__*`
  returns `null`.
- Do not add a generic workflow engine around this convention.

## 9. Recovery Entry Convention

Recovery uses the same explicit-dispatch style.

During runtime startup or explicit recovery, each persisted runner state can be
asked how it should continue:

```ts
_on_recovery(currentState)
```

`_on_recovery` dispatches by convention to private state-specific methods:

```text
_on_recovery__{current_state_name}
```

Examples:

```text
_on_recovery__planning
_on_recovery__reviewing
_on_recovery__executing
_on_recovery__running
_on_recovery__waiting_for_tool
```

`_on_recovery__*` returns:

```ts
RunnerState | null
```

Use `_on_recovery__*` to either keep the recovered state or divert the object to
a safer state. If a non-null state is returned, `_set_state(returnedState)` is
called and that state's `_on_enter__*` handler runs normally.

Examples:

- A card runner recovered in `planning` may enqueue a delayed call to
  `plannerAgentRunner.invoke_agent()` and return `null`.
- A card runner recovered in `executing` may enqueue a delayed call to
  `executorAgentRunner.invoke_agent()` and return `null`.
- A planner agent runner recovered in `waiting_for_tool(activate_card)` may
  enqueue a delayed call to its own `append_tool_result(...)` if the child card
  is already terminal, then return `null`.
- An agent runner recovered in an impossible `running` state may return `idle` or
  another explicit local recovery state. Entering that returned state must run
  that state's `_on_enter__*` actions.

Rules:

- `_on_recovery__*` must not mutate runner state directly.
- `_on_recovery__*` may enqueue delayed calls explicitly through the queue
  service.
- `_on_recovery__*` must return a new state for the same object or `null`.
- Ambiguous recovery states should fail fast or return an explicit failure/repair
  state. Do not silently normalize unknown states.

## 10. Resume Entry Convention

Resume uses the same explicit-dispatch style, but it is not recovery.

During resume after an intentional pause, each active persisted runner state can
be asked what it should do before normal queue draining continues:

```ts
_on_resume(currentState)
```

`_on_resume` dispatches by convention to private state-specific methods:

```text
_on_resume__{current_state_name}
```

`_on_resume__*` does not return state diversions. The object was paused in a
valid state, so resume should not repair or normalize it. It may enqueue delayed
calls through the queue service when work must continue after pause.

Rules:

- `_on_resume__*` must not mutate runner state directly.
- `_on_resume__*` may enqueue delayed calls explicitly through the queue service.
- If resume discovers impossible state, it should fail fast instead of repairing
  silently. Crash recovery belongs to `_on_recovery__*`.

## 11. Pub/Sub And Encapsulation

Objects must not freely trigger another object's private state changes.

Card runner states are private to that card runner. Agent runner states are
private to that agent runner. External objects communicate through public
methods, commands, or notifications. When the communication crosses object
boundaries, the preferred mechanism is a delayed call enqueued through the
runtime queue service. The receiving object decides whether to store data and
whether to call `_set_state` on itself.

Bad pattern:

```text
child directly queues parent CardRunner state = planning
```

Good pattern:

```text
child publishes card_finished
parent CardRunner receives the notification
parent listener enqueues parentCardRunner.notify_child_finished(...)
parent CardRunner later handles its own public method, stores any needed data,
and may call _set_state
```

Subscriptions are not persisted. They are regenerated during state
reconstruction from the object graph and current runner states. Conceptually,
subscriptions are static wiring for the reconstructed runtime, not durable
runtime state.

When an object creates or attaches a child object that can produce relevant
results, the parent object must subscribe to that child at creation time. For
example:

- A CardRunner subscribes to its attached planner, reviewer, or executor
  AgentRunner when that AgentRunner is attached.
- A parent CardRunner subscribes to a child CardRunner when the child is created
  or activated.
- An AgentRunner waiting on a process subscribes to the process record or process
  registry entry that will publish completion.

Notifications should flow from the object that owns the result upward to the
objects that subscribed to it. For example, an agent handler that accepts a
terminal result publishes that a result is available; the owning CardRunner
receives the notification, may change its own state, and may publish a new card
result notification to its parent.

Subscriptions must be registered before the first delayed call that can produce
the corresponding notification. In practice, `_on_enter__*` handlers attach the
needed subscriptions before enqueueing `invoke_agent()` or `start_card()`.

Do not hard-code callbacks inside child code. Register listeners explicitly from
the composition/wiring layer:

```ts
const foo = new Foo(...);
foo.register_listener(event, cb);
```

The object that owns the listener registry should also provide a small delivery
helper. Prefer a precise name over `deliver_notification`:

```ts
dispatch_notification(event, ...extraArgs)
```

`dispatch_notification` finds the callbacks registered for `event.kind` and
enqueues each callback through the delayed-call subsystem. The callback receives
the event, the publishing object, and any extra arguments:

```ts
cb(event, sourceObject, ...extraArgs)
```

Example:

```ts
agentRunner.dispatch_notification(
  { kind: 'agent_result_available', agent_id: agentRunner.id, result },
  runtimeContext,
);
```

The registered callback receives:

```ts
cb(event, agentRunner, runtimeContext)
```

`dispatch_notification` must not mutate unrelated objects directly. It only
schedules callbacks as delayed calls. Listener callbacks should not call
cross-object public methods inline when those methods may mutate state. They
should enqueue delayed calls through the runtime queue service so all
state-changing work remains serialized by the queue processor.

Minimal event examples:

```ts
type RuntimePubSubEvent =
  | { kind: 'agent_result_available'; agent_id: string; result: unknown }
  | { kind: 'agent_tool_call'; agent_id: string; tool_call_id: string; tool_name: string; args: unknown }
  | { kind: 'card_finished'; card_id: string; outcome: unknown }
  | { kind: 'process_finished'; process_id: string; outcome: unknown };
```

Listener callbacks should be small async functions. A callback usually enqueues a
public method on the receiving object. That public method may then call
`_set_state` on that same object when the delayed call is processed.

Example:

```ts
parent.register_listener('card_finished', (event) => {
  if (event.card_id === childId) {
    queue.enqueue(() => parent.notify_child_finished(event));
  }
});
```

`notify_child_finished` is a public method on the parent card runner. It is the
parent's responsibility to decide whether that notification matters and whether
to call `_set_state`.

## 12. Starting Root And Child Cards

Root project work starts from an external runtime event generated by the analyst
or operator, such as `start_project`. That event enqueues a delayed call to the
project CardRunner's public start method. The project CardRunner then enters
`planning(planner:<project>)` exactly like any other goal card.

There is no ready-queue scan or automatic project start.

A planner starts a child through `activate_card`.

`start_card` expects the card to be in public status `backlog` or `changed` and
expects the CardRunner to be `idle`. Calling it for a public `running` card is a
tool error for the caller; the runtime must not start a second activation for the
same card.

Before the tool call:

```text
parent card status: running
parent card runner: planning(planner:<parent>)
planner agent runner: running
```

The planner emits an `activate_card` tool call. Runtime persists the assistant
tool call and delivers it to the planner AgentRunner through a delayed call.

The planner agent runner transitions to:

```ts
{
  kind: 'waiting_for_tool',
  tool_call_id: '<activate_card tool call id>',
  tool_name: 'activate_card',
  wait: { kind: 'child_card', child_card_id: '<child>' }
}
```

The parent card remains publicly `running`.

The parent card runner remains in `planning`. The wait is represented by the
planner AgentRunner's `waiting_for_tool` state, not by a card runner state.

The activate-card tool handler, not the generic AgentRunner, enqueues:

```ts
queue.enqueue(() => cardRunner('<child>').start_card())
```

The child card then becomes publicly `running`, and its card runner enters its
own active state:

- Goal/project child: `planning(planner:<child>)`
- Terminal child: `executing(executor:<child>)`

## 13. Completing A Child Card

When a child reaches `done`, `failed`, `blocked`, or `cancelled`, the child's
CardRunner publishes a card-result notification as part of the notification
chain. The subscribed parent CardRunner enqueues `notify_child_finished`, which
eventually delivers the result to the parent planner AgentRunner waiting for that
child activation.

The parent card runner remains in `planning`.

The planner agent runner transitions from `waiting_for_tool` to `idle` after the
tool result is appended.

The parent CardRunner's `notify_child_finished` handler enqueues delivery of the
tool result to the waiting planner AgentRunner:

```ts
queue.enqueue(() =>
  agentRunner('planner:<parent>').append_tool_result(
    '<activate_card tool call id>',
    '<CardActivationOutcome>',
  ),
)
```

After the tool result is appended, the delayed-call chain may invoke
`planner:<parent>` again through the parent card runner's `planning` state.

No recursive call stack is required.

## 14. Reviewer Flow

A goal card is publicly `running` while its planner and reviewer work.

When the planner reports done and runtime acceptance gates pass, the goal runner
switches from:

```text
planning(planner:<goal>)
```

to:

```text
reviewing(reviewer:<goal>)
```

Review-attempt identifiers, if retained, are metadata attached to persisted
reviewer results. They are not part of runner state.

The reviewer result updates the goal card lifecycle:

- `pass` sets public card status to `done`.
- `needs_corrections` keeps public card status `running` and switches the runner
  back to `planning(planner:<goal>)` with review context appended to the
  planner conversation.

The reviewer session remains `reviewer:<goal>` across repeated correction
cycles.

### 14.1 Reviewer-To-Planner Transition

When `reviewer:<goal>` emits a reviewer result, the reviewer AgentRunner does
not directly mutate the CardRunner. It publishes an `agent_result_available`
notification.

The goal CardRunner is subscribed to its reviewer AgentRunner. Its listener
enqueues a delayed call to the CardRunner's public review-result handler:

```ts
queue.enqueue(() => goalCardRunner.handle_reviewer_result(result));
```

`handle_reviewer_result` is responsible for interpreting the reviewer result:

- `pass` persists the review result, sets the public card status to `done`, sets
  the reviewer AgentRunner to `idle`, sets the CardRunner to `idle`, and
  notifies the parent if this goal was activated by a parent.
- `needs_corrections` persists the review result, keeps the public card status
  `running`, sets the reviewer AgentRunner to `idle`, appends review context to
  the planner conversation, and sets the CardRunner back to
  `planning(planner:<goal>)`.
- Retry exhaustion persists the review result, sets the public card status to
  `failed`, sets the reviewer AgentRunner to `idle`, sets the CardRunner to
  `idle`, and notifies the parent with a failed activation outcome.

The `_set_state(...)` call in this handler must be the last active operation in
the branch that takes it. If review context needs to be appended or parent
notifications need to be enqueued, those operations happen before the state
change or from the entered state's `_on_enter__*` handler.

### 14.2 Reviewer Attempt Identity

`assessment_id` is the current codebase's name for a persisted reviewer-attempt
identifier. Historically reviewer sessions were identified as:

```text
reviewer:<goal_id>:<assessment_id>
```

The attached-agent design removes `assessment_id` from the reviewer agent id.
The reviewer agent id is always:

```text
reviewer:<goal_id>
```

If review attempts still need a durable identifier for audit, result lookup, or
UI display, keep that identifier on the persisted review result record only. It
must not be part of:

- CardRunner state.
- AgentRunner state.
- Reviewer AgentSession identity.
- Any runtime control-flow decision.

If no current API, UI, test, or audit path actually needs distinct reviewer
attempt ids after the redesign, `assessment_id` can be removed entirely and the
review history can be ordered by persisted review-result timestamps instead.

## 15. Planner Terminal Report Flow

A goal CardRunner in `planning(planner:<goal>)` receives terminal planner reports
through notifications from `planner:<goal>`.

When the planner AgentRunner accepts `report_goal_done`, `report_goal_failed`, or
`report_goal_blocked`, it publishes `agent_result_available`. The goal
CardRunner is subscribed to its planner AgentRunner and enqueues:

```ts
queue.enqueue(() => goalCardRunner.handle_planner_result(result));
```

`handle_planner_result` is responsible for card-level interpretation:

- `report_goal_done` first runs acceptance gates such as subtree readiness and
  evidence validation. Gate failures append a tool error/result to the planner
  conversation and keep the CardRunner in `planning`.
- Accepted `report_goal_done` keeps the public card status `running` and changes
  the CardRunner to `reviewing(reviewer:<goal>)`. The planner AgentRunner is set
  to `idle` before the reviewer AgentRunner is invoked.
- `report_goal_failed` sets the public card status to `failed`, sets the
  CardRunner to `idle`, clears the planner AgentRunner to `idle`, and notifies
  the parent when this goal was activated by a parent.
- `report_goal_blocked` sets the public card status to `blocked`, sets the
  CardRunner to `idle`, clears the planner AgentRunner to `idle`, and notifies
  the parent when this goal was activated by a parent.

The generic AgentRunner does not decide these card-level outcomes. It only
handles model interaction, tool protocol, and publication of accepted agent
results.

## 16. Terminal Executor Flow

A terminal card starts from `backlog`.

On `start_card`:

```text
card status: running
card runner: executing(executor:<card>)
executor agent runner: running while invoked
```

When `executor:<card>` emits a terminal result, the owning CardRunner handles the
accepted result:

- It persists the executor result on the card.
- It sets public card status to `done`, `failed`, or `blocked`.
- It sets its own CardRunner phase to `idle`.
- It sets the executor AgentRunner to `idle` through the owned attached-agent
  control path.
- It publishes a parent notification if the card was activated by a parent
  planner. The parent's listener enqueues any follow-up delayed call.

The executor session remains `executor:<card>` for future restarts of the same
card.

## 17. Process Wait Flow

Long-running process waits use the same AgentRunner wait model as
`activate_card`.

When an agent starts a process that must complete before the agent can continue,
the relevant tool handler:

1. Persists the process record.
2. Persists the assistant tool call.
3. Sets the AgentRunner to `waiting_for_tool` with
   `wait: { kind: 'process', process_id }`.

When the process registry observes terminal process completion, it publishes a
`process_finished` notification. The waiting AgentRunner is subscribed to the
process record and enqueues:

```ts
queue.enqueue(() => agentRunner.append_tool_result(toolCallId, processOutcome));
```

After the tool result is appended, the AgentRunner may enqueue
`invoke_agent()` so the same attached agent can continue.

Pause does not kill external processes. If a process finishes while runtime is
paused, the process result is persisted or buffered in the process registry and
delivered after resume. Recovery inspects persisted process records and the
AgentRunner's `waiting_for_tool(process)` state to deliver exactly one tool
result or tool error.

## 18. Cancellation Flow

Cancellation is not a CardRunner phase. It is a public card lifecycle outcome.

When runtime or the operator cancels active work for a card, the owning
CardRunner must ensure work is stopped and then transition the objects to a
settled shape:

- Stop or mark abandoned any active external work owned by the card when the
  runtime knows how to stop it.
- Set the public card status to `cancelled`.
- Set the CardRunner phase to `idle`.
- Set each attached AgentRunner that was active for that card to `idle`.
- Publish the normal card-result notification so any parent waiting on
  `activate_card` receives one terminal outcome.

If force-cancel is retained as a distinct operator/runtime action, it uses the
same state transitions. The only distinction is the parent-visible outcome: the
parent receives a synthetic failed activation outcome that records cancellation
as the reason.

## 19. Delayed-Call Chain Rule

The code should not hard-code a global "only one card can run" rule in every
card transition.

The first design does not need a scheduler abstraction. Runtime processes an
explicit chain of delayed calls sequentially.

This preserves today's single-agent execution model because only one
`invoke_agent` call is processed at a time. Future parallelism would
require a separate design and must not be hidden inside card or agent state
transitions.

Sequential delayed-call processing is the only concurrency mechanism in this
design. Runtime must not start a second model invocation while another
`invoke_agent` call is in progress. Multiple cards may have public status
`running` because ancestors remain running while a descendant works, but at most
one attached agent invocation is actively executing at a time in the initial
implementation.

## 20. Pause And Resume

Pause is ordered quiescence, not a runner state.

No CardRunner or AgentRunner has a `paused` phase. Pause is a runtime-level flag
and queue-processing mode. A pause request follows this order:

1. Runtime records that it is quiescing.
2. Runtime asks active objects to stop generating new delayed calls unless those
   calls are required to finish the current atomic step safely.
3. The delayed-call queue drains to empty.
4. Runtime records `paused: true`.

The runtime is considered paused only when the in-memory delayed-call queue is
empty. Calls already being processed finish their current public method. New LLM
invocations are not started while quiescing or paused.

External processes continue running while paused. Terminal process results that
arrive while paused are persisted or buffered by the process registry and
delivered after resume.

Resume clears the runtime pause flag and reconstructs subscriptions and any
needed delayed calls from persisted state. Resume uses `_on_resume__*` hooks when
an object needs behavior that is neither normal state entry nor crash recovery.

`_on_resume__*` differs from `_on_recovery__*`:

- `_on_resume__*` runs after an intentional pause where in-memory state was kept
  valid and external processes may have continued.
- `_on_recovery__*` runs after startup or explicit crash repair where in-memory
  delayed calls were lost.

Both hooks may share helper functions when they need to enqueue the same
continuation. The duplication between normal entry and recovery is handled at the
implementation level by extracting common helper functions, not by reintroducing a
persisted call queue.

## 21. Recovery

On startup, runtime reads persisted cards, card runners, and agent runners, then
reconstructs pub/sub listener wiring.

Before processing normal delayed calls, runtime runs a repair stage. The
repair stage calls `_on_recovery` for persisted card runner and agent runner
states and enqueues missing delayed calls needed to reach a stable continuation
point.

Recovery rules:

- If a card is public `running`, its card runner must explain which card-level
  work is active or waiting.
- If a card runner is in an active phase such as `planning`, `reviewing`, or
  `executing`, recovery calls the matching `_on_recovery__*` handler to enqueue the
  next delayed agent call when appropriate.
- If an agent runner is `running`, runtime recovers the agent from the last
  persisted runner state and message boundary, then continues according to the
  phase-specific recovery policy.
- If an agent runner is `waiting_for_tool`, runtime inspects the wait target.
- If waiting for a child card and the child is terminal, append the missing tool
  result and resume the parent agent.
- If waiting for a child card and the child is still running, continue the child.
- If waiting for a process, inspect the process record and append the matching
  tool result or failure.
- If a card is terminal but its runner is not `idle`, fail fast or run an
  explicit repair transition.
- If an agent runner is `running` after restart, there is no live in-memory model
  call. Recovery must use the persisted agent state and message history to resume
  from the last durable boundary, either by enqueueing `invoke_agent` again with
  recovery context or by enqueueing a failure-handling delayed call, according to
  the phase-specific policy.
- Delayed calls are not persisted. If the process shuts down while delayed calls
  are pending, recovery must recreate the required continuation from persisted
  runner state, card state, messages, and process records.

Recovery must not inspect agent session status to decide whether work is active.
Card runner and agent runner state are authoritative for internal execution.

## 22. Persistence

Persist card runner state and agent runner state under project-local `.saivage/`
state, alongside the card and runtime state. Do not persist the in-memory
delayed-call queue. The exact file layout can be chosen during implementation,
but persisted state must be JSON or JSONL and must be durable before immediate
side effects execute.

Persisted agent state includes the AgentRunner phase and the attached agent's
message/tool-call history. Any method that advances model interaction, tool
dispatch, or tool-result delivery must update disk before relying on the next
delayed call.

Minimum persisted data per card:

```ts
interface PersistedCardRunner {
  card_id: string;
  phase: CardRunnerPhase;
  updated_at: string;
}

interface PersistedAgentRunner {
  agent_id: string;
  card_id: string;
  phase: AgentRunnerPhase;
  updated_at: string;
}

```

Do not persist an in-memory call stack. Parent/child waiting is represented by
the planner agent runner's `waiting_for_tool(activate_card)` state. The parent
card runner remains in its active phase, such as `planning`.

## 23. Behavioral Coverage

The redesign must preserve these existing runtime behaviors unless a later
document explicitly removes them:

- One `activate_card` assistant tool call receives exactly one matching tool
  result or tool error.
- Parent planners see only `done`, `failed`, or `blocked` activation outcomes.
- Reviewer `needs_corrections` is internal to the child goal activation until
  retry exhaustion.
- Reviewer retry exhaustion reports a failed activation outcome.
- Subtree readiness and evidence validation remain planner tool errors before
  reviewer invocation.
- Public card status remains the externally visible lifecycle state.
- CardRunner and AgentRunner state are authoritative for internal execution, not
  old AgentSession lifecycle status.
- Runtime pause is global and does not mutate public card status or runner
  phases.
- Force-cancel still produces exactly one synthetic failure outcome for the
  active activation path.
- Durable process reattach/reconciliation still produces exactly one terminal
  process result or failure for any waiting agent.
- Planner no-progress recovery still produces an agent-visible recovery path
  without exposing provider/account diagnostics.
- Old `.saivage` runtime state is not migrated.

## 24. Implementation Notes

- Implement runner transition helpers as simple functions where useful:
  `(card, cardRunner, agentRunners, stateChange) -> { cardRunner?, agentRunnerPatches?, cardStatusPatch? }`.
- Persist transition results before executing immediate side effects.
- Put immediate side effects in `_on_enter__{state}` handlers. Each handler may
  enqueue delayed calls explicitly through the queue service.
- Put startup repair decisions in `_on_recovery__{state}` handlers. Each handler
  may enqueue delayed calls explicitly through the queue service and may return
  a local state diversion or `null`.
- Remove session-status-based concurrency checks such as scanning for active
  sessions. Use card runner and agent runner state instead.
- Rebuild subscriptions during runtime reconstruction. Do not persist
  subscriptions.
- Register listener callbacks from composition/wiring code. Do not hard-code
  parent callbacks inside child code.
- Keep public card status transitions simple and validated.
- Do not add generic workflow engines, plugin systems, dynamic state graphs, or
  database layers.
- Do not implement definitive compaction changes as part of this draft. Preserve
  system prompts and tool-call validity when compaction code is touched.

## 25. First Implementation Slice

The first code slice should prove the architecture with the smallest behavior
change that exercises durable waiting:

1. Add persisted card runner and agent runner state.
2. Add the in-memory delayed-call queue and initialization repair.
3. Add pure transition helpers for terminal executor cards, generic agent
   runner phases, and goal `activate_card` waiting.
4. Replace recursive terminal child activation with planner agent
   `waiting_for_tool(activate_card)` and delayed child `start_card` call.
5. Reuse deterministic `executor:<card>` sessions.
6. Add focused recovery tests for parent waiting on a child and child completion
   delivery after reload.

Only after that slice works should reviewer and planner-session normalization be
folded into the same runner model.
