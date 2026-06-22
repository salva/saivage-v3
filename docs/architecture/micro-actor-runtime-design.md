# Micro-Actor Runtime Design

Status: forward-looking target design.

Date: 2026-06-19.

## Purpose

This document is the target runtime design for introducing the local micro-actor framework into the Saivage v3 application. It describes the design to build, not the current production implementation.

The old XState plans are provenance only. They were reviewed for reusable product and ownership ideas, not for implementation structure. This draft does not preserve XState concepts, event names, snapshots, controller seams, compatibility bridges, or machine hierarchy as baggage.

## Reviewed Provenance

Reusable ideas found in the XState-era material:

- Keep public card lifecycle separate from private runtime actor state.
- Keep operator API and UI projections Saivage-owned; never expose raw actor internals.
- Use deterministic actor/session identities for cards, agent sessions, and processes.
- Preserve the one-active-leaf invariant.
- Treat `activate_card` as a parent planner tool call that blocks until the immediate child returns one result or tool error.
- Keep LLM/provider mechanics generic and role interpretation in the owning card actor.
- Persist model/tool/process boundaries before relying on later work.
- Enforce exactly-one tool result or tool error for every assistant tool call.
- Keep process execution durable and separately observable.
- Make pause a scheduling/admission gate, not a card state.
- Make cancellation explicit: inactive cancellation is status-driven, while running cancellation is best-effort notification-driven.
- Route notifications to cards, then deliver them to that card's main agent session at a safe LLM admission boundary.
- Prefer deletion of old controller/decorator layers over preserving old tests or APIs.

Ideas intentionally discarded:

- XState dependency, snapshots, event queues, actor refs, parallel states, and machine setup APIs.
- Decorative state machines wrapped around imperative loops.
- Generic command buses, event-sourcing layers, workflow engines, or global orchestration frameworks.
- Promise-returning child-activation facades that hide runtime ownership.
- Process-global note sinks.
- Public or persisted framework snapshots as authoritative runtime state.
- Compatibility shims for old runtime state.

## Design Rules

- Runtime behavior is owned by `BaseActor` subclasses and their explicit public methods.
- Micro-actor does not know or enforce ownership. Ownership is defined only by concrete `BaseActor` subclasses, their fields, and their public methods.
- Public methods accept external work and may return command/job IDs or immediate command acceptance results.
- Concrete actors are instantiated with parent references where they need to report completion. They do not need per-call completion callbacks in `start(...)` or `recover(...)`.
- Completion is reported by calling hard-coded parent methods, such as `onChildCardDone(...)`, `onProcessorDone(...)`, or `onLlmDone(...)`, when the child actor reaches an activation or work outcome state.
- When a parent needs to wait for a child, the parent creates and stores the promise, calls the child's domain method such as `activate(...)` or `turn(...)`, then uses `runTask(...)` to wait for that promise. The hard-coded child completion method resolves or rejects the stored promise.
- Internal state changes are string events sent with `sendEvent(...)`.
- Parked states represent externally controlled idle lifecycle states. Public actor methods advance them through protected `parkedSendEvent(...)`, not direct state assignment.
- Public methods that are valid from both parked and active states validate the current state and use `parkedSendEvent(...)` only from parked states; from active states they use `sendEvent(...)` or update actor fields directly when no state transition is needed.
- Long work is run through `runTask(...)`; task completion callbacks store results and then send `done` unless a specific branch fact is needed.
- `BaseActor._on_state_changed(oldState, newState)` is the standard cross-cutting hook for transition snapshot persistence. `BaseActor` calls it after assigning the new state and before the matching `_on_enter__{state}` hook. It runs for `start()` and normal state transitions, but not for `recover(...)` because recovery reconstructs already-persisted state.
- Concrete actors should use `_on_state_changed(...)` to save actor reconstruction records for state transitions instead of adding empty `_on_enter__{state}` hooks that only call `persist()`. Keep explicit persistence in public methods or task callbacks when actor context changes without a state transition, such as queued notifications, process output, provider admission fields, or terminal outcome fields.
- Actor state names are small and product-meaningful. Do not create a state for every helper function.
- Use `SlaveActor.submitJob(...)` only for externally queued work where a caller needs a returned job ID and cancellation handle.
- Do not expose actor state, task IDs, private fields, compiled definitions, or internal events through API/UI contracts.
- Persist Saivage domain facts and actor reconstruction data, not in-memory queues.
- If recovery cannot prove a safe continuation, fail or block explicitly with operator-visible diagnostics.

## Functional Invariants

The target implementation must preserve these invariants:

- The runtime is the only autonomous dispatcher.
- The Analyst is the user-facing mutation surface; UI mutation controls remain projection-only except authentication/bootstrap.
- At most one leaf card does real work at a time.
- A running chain may contain several `running` cards, but only the leaf receives scheduling, LLM turns, or process work.
- Parent planners activate only immediate children through `activate_card`.
- `activate_card` is a synchronous logical barrier from the parent planner perspective.
- Activatable child statuses are `backlog`, `changed`, `blocked`, and `failed`.
- Activating a child transitions it to `running`.
- Child activation outcomes update the child card to `done`, `failed`, or `blocked` before the parent receives the tool result.
- The Analyst cannot directly set a card to `blocked`; `blocked` is a main-agent activation outcome.
- Only `done` and `cancelled` descendants are completion-compatible for parent `done`.
- `changed`, `blocked`, `backlog`, `running`, and `failed` descendants block parent `done` until handled.
- `working_status` is free text for agents attached to the card.
- `result` is attached only from accepted main-agent results.
- Reviewer-negative results are stored with the card and injected into planner context; positive reviewer text is only attached to the card.
- Notifications are card-addressed, immutable, ephemeral delivery items, not user-managed note objects.
- Best-effort cancellation for running cards is represented as a card-addressed notification; it does not change status or runtime scheduling by itself.
- Run starts idle work or resumes paused work; duplicate Run returns an already-running warning.
- Pause is a scheduling gate and does not mutate card/session/process state.
- Shutdown pauses first, then terminates runtime-owned running processes.
- Process handling uses launch, inspect, bounded wait, and explicit termination; wait timeout does not kill the process.
- Every external operation admitted by the runtime has a timeout or inactivity timeout.
- Operator APIs and UI expose Saivage read models, never raw actor internals.

Most task states use the same local completion protocol: the state starts or admits work, stores any result/error data on actor fields, sends `done` when that work completes successfully, and sends `failed` when that work fails. Do not invent one event per state or helper step. Use specific event names only for external commands (`run`, `pause`, `activate`, `cancel`) or true branch facts that cannot be represented by fields plus `done`/`failed`.

## System Shape

The runtime has one root supervisor and a deterministic card actor tree:

```text
RuntimeSupervisorActor
  CardActor(project)
    ProjectCardProcessorActor
      LLMActor(planner:project)
      LLMActor(reviewer:project)
      ProcessActor(... as needed)
    CardActor(goal)
      GoalCardProcessorActor
        LLMActor(planner:goal)
        LLMActor(reviewer:goal)
        ProcessActor(... as needed)
      CardActor(terminal)
        TerminalCardProcessorActor
          LLMActor(executor:terminal)
          ProcessActor(... as needed)
```

`CardActor` has the public card states: `backlog`, `running`, `done`, `blocked`, `failed`, `cancelled`, and `changed`. This is the public card lifecycle layer. New card actors start in `backlog`; recovered actors use the persisted card state. Public idle card states such as `backlog`, `done`, `blocked`, `failed`, and `changed` are parked because external commands may later activate, change, or cancel them. `cancelled` is terminal: the actor exits, and any later reactivation creates a fresh actor instance for the new durable card state. Each card type has its own concrete processor actor class. `LLMActor` interacts with remote LLM providers.

The active chain may contain several public `running` cards, but only the leaf actor receives provider/process scheduling at a time.

Ownership conventions are deliberately narrow:

- `CardActor` owns its direct child `CardActor` instances and its associated processor actor.
- `ProjectCardProcessorActor`, `GoalCardProcessorActor`, and `TerminalCardProcessorActor` own and cache their role-specific `LLMActor` instances.
- `ProcessActor` instances are created and controlled by the processor actor that launched or attached to the process record.
- Other references are dependencies, services, or data references unless a concrete actor class explicitly stores and controls them.

Parent-child waiting follows one pattern:

1. Parent creates an activation/wait record containing a promise and its resolver.
2. Parent calls the child's domain method, such as `activate(...)`, after creating or recovering the child actor if needed.
3. Parent enters a waiting state and runs a task that awaits the promise.
4. Child reaches an activation outcome state and calls a hard-coded parent method.
5. Parent method validates the child/wait identity and resolves or rejects the promise.
6. Parent task callback stores the result and sends `done`.

This keeps the micro-actor framework out of ownership and out of cross-actor waiting. The parent owns the wait. The child only reports activation outcomes to its known parent. If the parent leaves the waiting state before the child reports, the parent invalidates the wait record; a later child report is ignored as a diagnostic no-op, not treated as a second outcome.

## Actor Inventory

### RuntimeSupervisorActor

Purpose: root runtime control, pause gate, shutdown, recovery, and parentless project ownership.

Suggested states:

- `idle`: parked; no root work is active.
- `running`: active; root project exists and admission is open.
- `paused`: parked; root project may exist, but no new model/provider calls are admitted.
- `shutting_down`: active; pause gate is closed and runtime-owned processes are being terminated, then the supervisor returns to `idle`.

Public methods:

- `run()`: start idle project work or resume from paused.
- `pause()`: close model/provider admission.
- `shutdown()`: close admission, terminate runtime-owned running processes, and settle.
- `cancelProject()`: cancel inactive project work immediately, or enqueue a best-effort cancellation notification for running project work.

Event guidance:

- Public lifecycle methods may queue command events such as `run`, `pause`, `shutdown`, and `cancel`.
- Supervisor async work completes with `done` or `failed` after storing result/diagnostic fields.

Responsibilities:

- Hold the parentless project `CardActor` reference as supervisor runtime data.
- Enforce duplicate-run behavior: return already-running warning, no duplicate root run.
- Manage admission policy for provider calls.
- Coordinate shutdown process termination.
- Project runtime status for API/UI.
- Rebuild or explicitly fail unsafe runtime state during startup recovery before normal runtime commands are accepted.

Non-responsibilities:

- Planner/executor/reviewer semantics.
- Tool-call interpretation.
- Direct card mutation outside canonical services.

### CardActor

Purpose: durable public card lifecycle boundary.

States mirror public card status:

- `backlog`: parked.
- `changed`: parked.
- `running`: active processor work is in progress.
- `blocked`: parked.
- `cancelled`: terminal.
- `failed`: parked.
- `done`: parked.

Public methods:

- `activate(caller)`: validate authority and start the card.
- `notify(notification)`: enqueue card-addressed context.
- `cancel(reason)`: cancel inactive cards immediately, or send a best-effort downstream cancellation notification for running cards.
- `markChanged(change)`: apply card/subtree change semantics.

Parked public methods use `parkedSendEvent(...)` after validating authority and recording any event-specific data on actor fields. Allowed movements are the normal `on` transitions declared on each parked state.

Event guidance:

- Public methods may queue command events such as `activate`, `changed`, and inactive `cancel` from parked states.
- Running activation work normally completes with `done` or `failed` after storing the outcome on actor fields.
- `blocked` is a domain outcome. It may be a distinct event only if the static transition table needs to route it separately from `done`.
- Running cards receive notification/context without leaving `running`. Cancellation for running cards follows this path only: enqueue a card-addressed cancellation notification for downstream delivery to the running main agent.

Responsibilities:

- Write public status through CardStore.
- Own direct child `CardActor` instances.
- Own the associated processor actor for this card type.
- Enforce direct-child activation authority.
- Commit exactly one activation outcome before returning it to the parent.
- Call the parent card's hard-coded child-completion method when this card reaches an activation outcome.
- Deliver card-addressed notifications to the card's main agent at safe boundaries.
- Represent running cancellation only as a card-addressed cancellation notification. Do not synchronously move a running card to `cancelled`, close admission, kill work, or add a separate cancellation-request state merely because an operator requested cancellation.
- Keep `changed` as public card state, not a generic actor phase.

Changed-state rules:

- Inactive modified cards become `changed`.
- Running modified cards remain `running` and receive notifications/context.
- Inactive cancelled cards and inactive non-completion-compatible descendants become `cancelled` immediately, preserving descendants already `done`.
- Running cards targeted by cancellation remain `running`; the only runtime action is to notify the running main agent downstream that cancellation was requested. The agent decides how to respond through the normal report/tool protocol.
- A goal cannot report `done` while executable descendants remain `backlog`, `changed`, `blocked`, `failed`, or `running`.
- `cancelled` descendants are completion-compatible.

### Card Processor Actors

Purpose: card-type-dependent behavior for project, goal, and terminal cards.

There is one concrete processor actor class per card type: `ProjectCardProcessorActor`, `GoalCardProcessorActor`, and `TerminalCardProcessorActor`. Shared helper functions are fine when they keep code smaller, but no generic processor framework or compatibility layer is required.

Project and goal processor states:

- `planning`: active; planner main agent is active or can receive another turn.
- `waiting_child`: active; planner is blocked on an `activate_card` tool call.
- `waiting_process`: active; planner is blocked on a process-backed tool call.
- `reviewing`: active; reviewer is assessing a candidate done outcome.
- `settled`: parked; one public outcome is ready for the owning `CardActor` and the processor may be reused for a later activation.

Public methods:

- `activate(input)`: start or resume one card activation.
- `cancel(reason)`: send a best-effort cancellation notification to the running planner or reviewer when active; parked processors may settle through the owning card's inactive cancellation path.

Important actor fields:

- Active planner session id.
- Active reviewer session id, when reviewing.
- Cached planner `LLMActor`.
- Cached reviewer `LLMActor`, when reviewer work has been needed.
- Active child activation metadata, when waiting on a child.
- Active process wait metadata, when waiting on a process.
- Pending notifications for planner delivery.
- Classified planner/reviewer result awaiting transition, if any.

Responsibilities:

- Build planner invocation context.
- Own and cache planner/reviewer `LLMActor` instances.
- Build the planner capability registry.
- Validate planner tool authority.
- Start immediate child cards through `CardActor` references held by the processor.
- Treat child activation as a synchronous logical barrier from the planner perspective.
- Route process tools to `ProcessActor` or process services.
- Enforce readiness and evidence gates before review.
- Invoke reviewer only after gates pass.
- Store negative reviewer findings for planner context.
- Call the associated `CardActor`'s hard-coded processor-completion method when it reaches `settled`.
- Return exactly one `done`, `failed`, or `blocked` activation outcome.

Event guidance:

- `activate` wakes `settled` and starts a new activation.
- Planner, reviewer, child, and process waits normally complete with `done` or `failed` after storing result/diagnostic fields.
- Use specific branch events only when a single state needs different static transition targets that cannot be derived by entering an intermediate state.

Reviewer rules:

- Reviewer output must be structured enough for control-plane decisions.
- Ambiguous prose is a failure or tool error, not a guessed pass/fail.
- If notifications or changes arrive while reviewing, reviewer success must be invalidated or diverted back to planning when those changes affect the assessed subtree.

Terminal processor states:

- `executing`: active; executor main agent is active or can receive another turn.
- `waiting_process`: active; executor is blocked on a process-backed tool call.
- `settled`: parked; one public outcome is ready for the owning `CardActor` and the processor may be reused for a later activation.

Public methods:

- `activate(input)`: start one terminal card activation.
- `cancel(reason)`: send a best-effort cancellation notification to the running executor when active; parked processors may settle through the owning card's inactive cancellation path.

Terminal responsibilities:

- Build executor invocation context.
- Own and cache the executor `LLMActor`.
- Build terminal tool capability registry.
- Route process tools to `ProcessActor` or process services.
- Validate executor terminal/reporting results.
- Commit terminal result data only from accepted executor results.
- Call the associated `CardActor`'s hard-coded processor-completion method when it reaches `settled`.
- Return exactly one `done` or `failed` outcome to the associated `CardActor`.

Event guidance:

- `activate` wakes `settled` and starts a new terminal activation.
- Executor and process waits normally complete with `done` or `failed` after storing result/diagnostic fields.
- Use specific branch events only when one state needs different static transition targets.

Terminal actors do not own children.

### LLMActor

Purpose: generic LLM/provider turn and tool-loop mechanics for planner, reviewer, and executor sessions.

Suggested states:

- `idle`: parked; no provider call is active and another turn may be requested by owner.
- `requesting_admission`: active; waiting for supervisor admission to call provider.
- `calling_provider`: active; provider request is in flight.
- `waiting_tool`: parked; a runtime tool result is required before another provider turn.

Completed turns return to `idle`; completion data is stored on actor fields before notifying the owning processor actor.

LLMActor event names are intentionally left to implementation. Provider/tool-loop requirements should drive the final transition table. The default rule still applies: provider admission, provider calls, and tool waits report local completion through `done` or `failed` unless a real branch fact needs a distinct event.

Public methods:

- `turn(inputRef)`: run a model turn from persisted input context.
- `appendToolResult(toolCallId, result)`: continue after tool success.
- `appendToolError(toolCallId, error)`: continue after tool failure.

`LLMActor` has no public card-cancellation API. Running-card cancellation reaches the main agent as card-owned notification context in the next `turn(...)` input.

Responsibilities:

- Append durable invocation context before provider calls.
- Request/release provider admission through the parent processor actor, which delegates to the supervisor-owned admission policy. A paused processor does not request new LLM turns.
- Treat admission as task-owned async work: `requesting_admission` runs a task that awaits the processor/supervisor admission promise, then sends the event that starts the provider call.
- Receive already-built `LlmInvocationInput` from the owning processor. `LLMActor` does not own card notification queues and does not decide which notifications are deliverable.
- Persist provider responses before owner interpretation.
- Persist every assistant tool call before routing it.
- Enforce one result/error per tool call.
- Call the parent processor actor's hard-coded LLM completion/tool-call methods when the LLM turn completes or needs a runtime tool.
- Stay generic: do not decide public card outcomes.

Provider output rules:

- Multiple tool calls must follow an explicit documented protocol. The first implementation may fail fast rather than silently picking the first.
- Provider/account diagnostics remain outside model context unless deliberately sanitized into actionable recovery context.
- `waiting_tool` is parked; tool execution must own its timeout or bounded wait and eventually call `appendToolResult(...)` or `appendToolError(...)`.

### ProcessActor

Purpose: durable external process lifecycle.

Suggested states:

- `running`: active; process exists or is being reconciled.
- `killing`: active; explicit termination is in progress.
- `settled`: terminal; process terminal result, failure, or abandonment is recorded.

Event guidance:

- `launch(...)` starts the process and enters `running` when the process record exists.
- Process monitoring, waits, and termination normally complete with `done` or `failed` after storing process result/diagnostic fields.
- `kill` is a command event because it is an external operation, not task completion.

Public methods:

- `launch(spec)`: launch a process and create its process record.
- `wait(timeout)`: bounded wait for completion.
- `inspect(range)`: safe status/log projection.
- `kill(reason)`: terminate or mark abandoned.

Responsibilities:

- Persist process identity and ownership.
- Persist terminal result/failure.
- Return process tool results to the owning processor actor exactly once; the processor forwards the tool result to the waiting `LLMActor`.
- `inspect(...)` and `wait(...)` on an already settled process read the persisted process record directly and do not require a live actor loop.
- Reattach to running processes after restart when safe.
- Treat process results according to the normal process/tool protocol. Best-effort running cancellation does not reinterpret process results; shutdown or explicit `kill_process` handles forced process termination.

## External Command Mapping

Runtime public surfaces must map Analyst/operator commands to supervisor or card public methods. They must not call internal actor hooks or run workflow logic.

Initial command mapping:

| User/API command | Runtime target | Behavior |
| --- | --- | --- |
| start/run project | `RuntimeSupervisorActor.run()` | Starts root work or returns already-running warning. |
| pause runtime | `RuntimeSupervisorActor.pause()` | Closes admission gate; does not mutate card statuses. |
| resume runtime | `RuntimeSupervisorActor.run()` | Reopens admission from paused. |
| shutdown | `RuntimeSupervisorActor.shutdown()` | Pauses admission and terminates runtime-owned processes. |
| cancel project | `RuntimeSupervisorActor.cancelProject()` | Cancels inactive project work immediately or sends best-effort cancellation notification to running project work. |
| cancel card/subtree | `CardActor.cancel()` through the runtime command boundary | Marks inactive cards/subtrees `cancelled`; enqueues best-effort cancellation notifications for running cards. |
| mark needs correction/change | `CardActor.notify()` / `markChanged()` | Queues notification and updates public changed state where applicable. |
| activate child | Owning goal/project processor capability | Validates direct-child authority and starts child card. |

The runtime command boundary may wait for projected state when an API contract requires a completion response. Waiting must observe actor/card projections, not execute workflow itself.

Runtime command delivery must serialize concurrent external commands per actor. `parkedSendEvent(...)` intentionally has a single pending event slot and rejects a second command before the first is pumped.

## Tool Protocol

Every assistant tool call persisted in an agent session has one durable terminal delivery:

- `delivered`: tool result appended.
- `errored`: tool error appended.
- `abandoned`: recovery or shutdown recorded no normal result.

Tool routing groups:

- Local immediate tools: read-only inspection or cheap card/file operations that complete in the same LLM turn.
- Cross-card tools: `activate_card`, cancellation/change operations, and direct-child mutations.
- Process tools: start, wait, inspect, kill.
- Reporting tools: planner, reviewer, and executor terminal reports.

Rules:

- LLM actor persists the tool call before routing.
- Owning processor actor validates role-specific semantics.
- Process waits and child activations put the LLM actor into `waiting_tool`.
- Reporting tools are interpreted by the owning card processor, not by `LLMActor`.
- Rejected tool calls append a tool error and may allow another turn.
- Recovery repairs tool delivery from durable tool-call records and message logs.

## Notifications

Notifications are card-addressed ephemeral delivery items. There is no user-managed note object, note inbox, list/get operation, or acknowledgement workflow.

Rules:

- Analyst and runtime services enqueue notifications to cards.
- The card runtime decides when to append pending notifications to the main agent session.
- `CardActor` owns the pending card-addressed queue. Processor actors inspect and drain deliverable notifications from their owning `CardActor` when preparing activation input or the next main-agent turn.
- `LLMActor` is deliberately queue-free. It receives notification content only as part of the `LlmInvocationInput` built by the owning processor, preserving generic provider/tool-loop mechanics and keeping card semantics in card/processor actors.
- `CardActor` exposes enough domain methods for its processor to check whether undelivered notifications exist, drain the notifications deliverable to the main agent, and record delivery markers after the processor appends them to the next model-visible turn.
- Project/goal main agent is the planner.
- Terminal main agent is the executor.
- Reviewer is not the main agent for notification delivery.
- Delivery happens before the next provider call, not by interrupting an in-flight call.
- Delivery evidence is the agent session transcript and a small durable delivery marker.

Notifications can affect flow:

- While planning/executing, append before the next turn.
- While waiting on child/process, keep pending until the tool result is appended and the next turn is prepared.
- While reviewing, hold pending main-agent notifications. Change notifications that affect the reviewed subtree divert back to planning after reviewer completion or invalidate reviewer success. Best-effort cancellation notifications are held for the planner and do not by themselves invalidate reviewer success.
- While settled/inactive, keep pending until reactivation or discard/archive by domain policy.

## Pause, Cancellation, And Shutdown

Pause:

- Supervisor closes provider admission.
- Active provider calls reach the next durable boundary.
- No new model/provider call starts while paused.
- Process actors may continue; their results are persisted and delivered on resume/recovery.
- Pause does not change card lifecycle state.

Cancellation:

- Cancellation is immediate only for inactive cards. The requested inactive card/subtree is marked `cancelled` through canonical card rules, while descendants already `done` remain `done`.
- Cancellation for running cards and running agents is best-effort only. The runtime enqueues a downstream cancellation notification asking the running main agent to cancel if it can do so safely. The public card status remains `running`, and no separate cancellation-request state is introduced.
- Best-effort running cancellation does not close provider admission, block child activation, kill processes, abort tool waits, or reinterpret late results. The running agent continues through the normal protocol and may report `done`, `failed`, `blocked`, or `cancelled` according to what it actually did after seeing the notification.
- Hard shutdown remains the operation for forcibly terminating runtime-owned work regardless of agent cooperation.

Shutdown:

- Supervisor first closes admission.
- Supervisor terminates or abandons runtime-owned running processes.
- Supervisor persists shutdown diagnostics.
- Supervisor does not rely on in-memory queues being drained as durable evidence.

## Persistence And Recovery

Persist Saivage-owned data at explicit boundaries:

- Card records and histories.
- Agent messages and tool-call delivery records.
- Runtime supervisor state: mode, root intent, pause/shutdown diagnostics.
- Card actor reconstruction records: actor id, card id, actor kind, current state, active child/process/tool wait metadata.
- LLM actor reconstruction records: session id, role, state, admission/request metadata, current tool call wait.
- Process records: process id, command metadata, status, terminal result/failure, delivery status.
- Notification delivery records.
- Runtime event and error timelines.

State-transition persistence rule:

- Actor reconstruction records are persisted from `_on_state_changed(oldState, newState)` when a fresh actor starts or a normal transition changes state.
- `_on_state_changed(...)` captures the new actor state before `_on_enter__{state}` starts entry work. Entry hooks should therefore focus on state-specific behavior such as starting tasks or writing domain facts, not on generic snapshot persistence.
- If `_on_enter__{state}` mutates fields that must be reflected in the same actor snapshot, either move that mutation before the transition is requested or perform an explicit `persist()` after the mutation. Do not preserve per-state `persist()` calls merely to record the new state.
- Public methods and task callbacks still persist non-transition context changes explicitly. Examples include notification queues, `activeProviderCallId`, process stdout/stderr, tool-delivery metadata, and completed outcome fields.

Do not persist:

- `BaseActor` private fields.
- Internal pending events.
- In-memory task lists.
- Job queues.
- Function closures, actor object references, or provider client objects.

Recovery procedure:

1. Read CardStore, runtime records, session logs, tool records, process records, and notification records.
2. Recreate `RuntimeSupervisorActor`.
3. Recreate card actors for public `running` cards and unresolved waits.
4. Recreate LLM actors only when a recoverable active/waiting session exists.
5. Recreate process actors for running or undelivered process records.
6. Reconnect deterministic IDs.
7. Call `BaseActor.recover(state)` on fresh actor instances where safe. Actor-specific `_on_recover__{state}` hooks rebuild in-memory references from persisted reconstruction records. `recover(...)` does not call `_on_state_changed(...)` and must not re-run transition persistence or transition side effects.
8. Repair forward or fail explicitly when state is ambiguous.

Recovery classifications for each actor state must be designed before implementation:

- `resume_safe`: continue from durable boundary.
- `reconcile_then_resume`: inspect child/process/tool record first.
- `abandon_with_diagnostic`: no safe continuation; record failed/blocked outcome.
- `complete_no_live_actor`: no live actor needed.

Examples:

- A `ProcessActor` in `running` may be `reconcile_then_resume` if the OS process can be found through the process registry.
- A provider call in progress at crash time is `abandon_with_diagnostic` because the external request cannot be safely reattached.
- A planner `LLMActor` waiting on `activate_card` is `reconcile_then_resume` if the active child actor and durable card state can be rebuilt from the active card chain and activation edge.
- A committed `cancelled` card or settled process is `complete_no_live_actor`; parked card outcomes such as `done`, `failed`, and `blocked` may still need a live parked actor when future changes or activation are allowed.

## API And Projection

`RuntimeApi` remains the external command and projection boundary if useful.

Allowed responsibilities:

- Construct/attach the supervisor actor.
- Validate command authority and shape.
- Call supervisor/card public methods.
- Subscribe or wait on projected state.
- Project cards, agents, processes, runtime mode, diagnostics, and timelines.

Forbidden responsibilities:

- Directly instantiate child actors below supervisor/card ownership.
- Branch over planner/executor/reviewer workflow.
- Synthesize child activation outcomes.
- Call protected actor methods.
- Expose raw actor internals, task IDs, or transition-table state.
- Run workflow loops or branch over runtime phases.
- Expose raw actor private state or compiled transition tables over public APIs.

Projection requirements:

- Show idle/running/paused/shutting-down truthfully.
- Show active chain and active leaf.
- Show current provider/process waits when safe to expose.
- Show recovery/cancellation diagnostics.
- Keep raw provider secrets and internal error details out of model context and default UI projections.

## Source Layout Draft

Candidate production layout:

```text
src/runtime/micro-actor/
  micro-actor.ts
  slave-actor.ts
  simple-slave-actor.ts

src/runtime/actors/
  runtime-supervisor.ts
  card-actor.ts
  card-processor-actor.ts
  llm-actor.ts
  process-actor.ts

src/runtime/projection/
  runtime-read-model.ts
  card-read-model.ts
  process-read-model.ts

src/runtime/persistence/
  actor-records.ts
  tool-delivery-records.ts
  notification-delivery-records.ts

src/application/
  runtime-api-factory.ts
```

Names may change during implementation. The important boundary is that orchestration lives in actor classes, projections live in projection modules, and persistence services are injected helpers rather than controllers.

## Implementation Plan

The detailed rollout plan lives in [Micro-Actor Runtime Implementation Plan](./micro-actor-runtime-implementation-plan.md). Keep this document focused on the target architecture; update the plan when implementation ordering, acceptance criteria, or cleanup steps change.

## Open Questions

- Exact completed actor-record retention policy: delete, archive, or keep bounded history.
- Whether process tools share one `ProcessActor` per process record or use direct process-service tasks for short operations.
- Whether reviewer structured output is tool-based immediately or strict JSON in the first implementation.
- Exact public schema fields for active-chain and runtime activity projection.

These are implementation decisions, not reasons to keep old XState or controller design.
