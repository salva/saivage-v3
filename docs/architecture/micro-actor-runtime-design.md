# Micro-Actor Runtime Design

Status: current runtime architecture. The micro-actor runtime has landed and is the active execution path (see [Implementation Plan — Current Status](./micro-actor-runtime-implementation-plan.md#current-status)). The R1-R4 and P1-P5 remediation is complete: truthful process state/scoped termination, process-first startup recovery, authoritative CardActor cancellation, the single RuntimeGate pause barrier, and reviewer/main-agent notification isolation are all implemented. Sections explicitly marked as deferred or future work are aspirational.

Date: 2026-06-19.

## Purpose

This document is the runtime architecture for the Saivage v3 micro-actor framework. It describes the design as built, alongside explicitly marked future-work sections that remain aspirational.

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
- Make pause a global scheduling/delivery gate, not a card state and not a generic micro-actor framework state.
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
- Pause support is centralized as a small runtime composition primitive (the `RuntimeGate` service) for provider-call admission. The gate is NOT part of the micro-actor framework (`BaseActor`/`micro-actor.ts`); it is a composition-root service injected into `LLMActor`. Do not implement pause by globally suppressing `_on_enter__{state}`: that creates half-entered states and makes recovery ambiguous. The gate never blocks tool results, child outcomes, process spawns, card dispatch, or completion settlement from already-admitted provider responses; those responses drain until the next provider call parks at the gate.
- `BaseActor._on_state_changed(oldState, newState)` is the standard cross-cutting hook for transition snapshot persistence. `BaseActor` calls it after assigning the new state and before the matching `_on_enter__{state}` hook. It runs for `start()` and normal state transitions, but not for `recover(...)` because recovery reconstructs already-persisted state.
- Concrete actors should use `_on_state_changed(...)` to save actor reconstruction records for state transitions instead of adding empty `_on_enter__{state}` hooks that only call `persist()`. Keep explicit persistence in public methods or task callbacks when actor context changes without a state transition, such as queued notifications, process output, provider admission fields, or terminal outcome fields.
- Actor state names are small and product-meaningful. Do not create a state for every helper function.
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
- Activatable child statuses are `backlog`, `changed`, and `blocked`. A `failed` card is not reactivatable; the parent must cancel it or handle the failure context (this matches `isActivatable()` in code and keeps failure a terminal-ish outcome that requires explicit operator/planner action rather than silent retry).
- Activating a child transitions it to `running`.
- Main-agent activation outcomes update the child card to `done`, `failed`, or `blocked` before the parent receives the tool result. Runtime cancellation may instead resolve the parent-visible activation as `cancelled`; processors never synthesize `cancelled`.
- The Analyst cannot directly set a card to `blocked`; `blocked` is a main-agent activation outcome.
- Only `done` and `cancelled` descendants are completion-compatible for parent `done`.
- `changed`, `blocked`, `backlog`, `running`, and `failed` descendants block parent `done` until handled.
- `working_status` is free text for agents attached to the card.
- `result` is attached only from accepted main-agent results.
- Reviewer-negative results are stored with the card and injected into planner context; positive reviewer text is only attached to the card.
- Notifications are card-addressed, immutable, ephemeral delivery items, not user-managed note objects.
- Cancellation is authoritative for both inactive and running cards. Inactive cards are marked `cancelled` immediately; running cards cancel the current `CardActor` activation, write `cancelled` to the store immediately, resolve the pending activation as cancelled, stop activation-owned runtime process scope, and drop stale/late outcomes through the CardActor cancellation flag (see [Implementation Plan P3](./micro-actor-runtime-implementation-plan.md#p3-cardactor-owns-authoritative-cancellation-and-activation-id-settlement)).
- Run starts idle work or resumes paused work; duplicate Run returns an already-running warning. Resume opens the pause barrier so existing waiters proceed, without requiring a second manual Run.
- Pause is a global provider-admission barrier. Pause itself does not mutate card/session/process state, though already-admitted provider responses may still execute tools, spawn runtime-owned processes, dispatch cards, persist facts, and settle to durable boundaries while paused. (See [Implementation Plan P4](./micro-actor-runtime-implementation-plan.md#p4-runtimegate-replaces-llm-admission-and-owns-the-pause-barrier).)
- Shutdown pauses first, then terminates runtime-owned running processes.
- Process handling uses launch, inspect, bounded wait, and explicit termination; wait timeout does not kill the process.
- Every external operation admitted by the runtime has a timeout or inactivity timeout.
- Operator APIs and UI expose Saivage read models, never raw actor internals.

Most task states use the same local completion protocol: the state starts or admits work, stores any result/error data on actor fields, sends `done` when that work completes successfully, and sends `failed` when that work fails. Do not invent one event per state or helper step. Use specific event names only for external commands (`run`, `pause`, `activate`, `cancel`) or true branch facts that cannot be represented by fields plus `done`/`failed`.

## System Shape

The runtime has a deterministic card actor tree rooted at the project card:

```text
CardActor(project)
  PlanningCardProcessorActor
    LLMActor(planner:project)
    LLMActor(reviewer:project)
  CardActor(goal)
    PlanningCardProcessorActor
      LLMActor(planner:goal)
      LLMActor(reviewer:goal)
    CardActor(terminal)
      TerminalCardProcessorActor extends BaseMainLLMCardProcessorActor
        LLMActor(executor:terminal)
```

Process execution is a service, not an actor. A single injected `ProcessRunner` is called directly by process tools and by shutdown; it does not appear in the actor tree.

Pause admission is also a service, not an actor state. A single composition-root `RuntimeGate` owns live pause truth and waiters; persisted runtime mode is projected from `RuntimeState.status` directly and is the restart truth. Runtime state and the runtime gate are the two sources of pause truth: `RuntimeState.status` is durable projection/restart state, and `RuntimeGate` is the live provider-admission barrier. The gate is NOT part of the micro-actor framework. The gate has one chokepoint: `LLMActor` before provider invocation. Process tools and card/root dispatch do not ask the gate; already-received provider responses may continue through tool execution, process spawn, card dispatch, and durable settlement while paused until the next provider call parks. `ProcessRunner` itself never asks the gate — it is a pure OS-process service. (See [Implementation Plan P4](./micro-actor-runtime-implementation-plan.md#p4-runtimegate-replaces-llm-admission-and-owns-the-pause-barrier).)

`CardActor` has the public card states: `backlog`, `running`, `done`, `blocked`, `failed`, `cancelled`, and `changed`. This is the public card lifecycle layer. New card actors start in `backlog`; recovered actors use the persisted card state. Public idle card states such as `backlog`, `done`, `blocked`, `failed`, and `changed` are parked because external commands may later activate, change, or cancel them. `cancelled` is terminal: the actor exits, the card cannot be edited or reactivated, and replacement work requires creating a new card. Processor actors share mechanical base classes but keep role/card policy in concrete subclasses. `LLMActor` interacts with remote LLM providers.

Note on `needs_verification`: the operator projection vocabulary (`actorRuntime.cards[].actorState`) includes `needs_verification` (see [System Specification §17](../spec/system-specification.md#17-recovery)), but it is **not** a `CardActor` state. It is a projected actor-state label derived from an executor terminal result kind. The recovery path rejects executor terminal results of the `needs_verification` kind rather than recovering a `needs_verification` actor. Do not add it to the CardActor state table without a concrete recovery path.

The active chain may contain several public `running` cards, but only the leaf actor receives provider/process scheduling at a time.

Ownership conventions are deliberately narrow:

- `CardActor` owns its direct child `CardActor` instances and its associated processor actor.
- `BaseCardProcessorActor` owns common processor mechanics: activation, pending activation resolution, settlement, snapshots, and parent outcome reporting.
- `BaseMainLLMCardProcessorActor` owns the shared main-agent LLM loop for processors driven by one main LLM session. It exposes `notificationContext(input, inputId)`, a delivery-only hook that drains main-agent notifications and records markers only while planner/executor provider input is being constructed. Reviewer continuations do not receive that hook, so draining main-agent notifications is unrepresentable (see [Implementation Plan P5](./micro-actor-runtime-implementation-plan.md#p5-reviewer-cannot-reach-main-agent-notification-delivery)). Reviewer currentness is based on actual assessed card/subtree/record changes, not on pending main-agent notification state.
- `PlanningCardProcessorActor` owns project/goal planner/reviewer semantics.
- `TerminalCardProcessorActor` owns executor semantics.
- Process execution is owned by a single injected `ProcessRunner` service, not by an actor. Process tools and shutdown call it directly.
- Other references are dependencies, services, or data references unless a concrete actor class explicitly stores and controls them.

Parent-child waiting follows one pattern. `CardActor` owns child actor references, direct-child authority, child activation dispatch, and child completion callbacks. Processor actors own planner/executor/reviewer semantics and may await child activation as tool state, but they obtain child activation through their owning `CardActor`; they do not own arbitrary child actor lifecycles.

1. The owning `CardActor` creates an activation/wait record containing a promise and its resolver.
2. The owning `CardActor` validates direct-child authority, creates or recovers the child actor if needed, and calls the child's domain method such as `activate(...)`.
3. Parent enters a waiting state and runs a task that awaits the promise.
4. Child reaches an activation outcome state and calls a hard-coded parent method.
5. Parent method validates the child/wait identity and resolves or rejects the promise.
6. Parent task callback stores the result and sends `done`.

This keeps the micro-actor framework out of ownership and out of cross-actor waiting. `CardActor` owns the lifecycle wait; processors only await a normalized result for tool semantics. The child only reports activation outcomes to its known parent card. If the parent card leaves the waiting state before the child reports, the parent invalidates the wait record; a later child report is ignored as a diagnostic no-op, not treated as a second outcome.

## Actor Inventory

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
- `activateChild(childId, caller)`: the single child-activation seam — validates direct-child authority, creates or recovers the child `CardActor`, calls the child's `activate(...)`, and returns a normalized activation outcome. Processors obtain child activation through this capability, not by holding child `CardActor` references.
- `notify(notification)`: enqueue card-addressed context.
- `cancel(reason)`: cancel inactive cards immediately. For running cards, cancel the current activation — write `cancelled` to the card store immediately, resolve the pending activation as cancelled, stop the activation-owned runtime process scope, and cause stale/late outcomes to be dropped through the CardActor cancellation flag (see [Implementation Plan P3](./micro-actor-runtime-implementation-plan.md#p3-cardactor-owns-authoritative-cancellation-and-activation-id-settlement)).
- `markChanged(change)`: apply card/subtree change semantics.

Parked public methods use `parkedSendEvent(...)` after validating authority and recording any event-specific data on actor fields. Allowed movements are the normal `on` transitions declared on each parked state. Forbidden transitions (e.g. `failed`/`done`/`cancelled` → `activate`) must be encoded as **absent transitions in the table**, not merely guarded at runtime by `isActivatable()`. Impossible states should fail fast in the table, not rely on defensive code.

Event guidance:

- Public methods may queue command events such as `activate`, `changed`, and inactive `cancel` from parked states.
- Fresh running activation enters through `_on_enter__running` and routes to `processor.activate`; recovered running activation enters through `_on_recover__running` and routes to `processor.recoverActive`. Both paths share `beginProcessorActivation`, which lazily starts a deferred processor before dispatch.
- Running activation work normally completes with `done` or `failed` after storing the outcome on actor fields.
- `blocked` is a domain outcome. It may be a distinct event only if the static transition table needs to route it separately from `done`.
- Running cards receive notification/context without leaving `running`. Cancellation for running cards is authoritative through the current activation: the card store is marked `cancelled` immediately, the pending activation resolves as cancelled, activation-owned process scope is stopped, and late outcomes are dropped by the CardActor cancellation flag (see [Implementation Plan P3](./micro-actor-runtime-implementation-plan.md#p3-cardactor-owns-authoritative-cancellation-and-activation-id-settlement)).

Responsibilities:

- Write public status through CardStore.
- Own direct child `CardActor` instances.
- Own the associated processor actor for this card type. During startup recovery, a running card may construct its processor but defer `processor.start()` until the top-down cascade reaches that card.
- Enforce direct-child activation authority.
- Commit exactly one activation outcome before returning it to the parent.
- Call the parent card's hard-coded child-completion method when this card reaches an activation outcome.
- Deliver card-addressed notifications to the card's main agent at safe boundaries.
- Be the single settlement authority for the current activation via its own fields (`#activationId`, `#cancellation`, `#pendingActivation`, `activeReconstruction`, `lastOutcome`). There is no separate attempt object and no activation-generation counter; a cancelled `CardActor` is terminal, so one cancellation flag is the complete settlement guard. `#activationId` is the stable process-owner identity passed through `CardActivationInput`, not a settlement-matching key. `CardActor` itself enforces exactly-once settlement, cancellation, parent delivery, and activation-owned process scope. Propagate cancellation to running children through their `CardActor.cancel()`.
- Keep `changed` as public card state, not a generic actor phase.

Changed-state rules:

- Inactive modified cards become `changed`, except `cancelled` which is terminal and cannot be revived through editing. To replace cancelled work, create a new card.
- Running modified cards remain `running` and receive notifications/context.

### Card Processor Actors

Purpose: card-type-dependent behavior for project, goal, and terminal cards.

Processor actors use a small inheritance hierarchy for shared mechanics, not a generic policy framework:

- `BaseCardProcessorActor`: common to all processor actors. It defines the shared processor state machine, `activate(input)`, pending activation promise, `settle(outcome)`, generic snapshot persistence, and outcome reporting to the owning `CardActor`. It must not know planner, reviewer, executor, process-tool, or card-type policy. It has no cancellation API and no `cancelled` state; running cancellation is owned by the `CardActor` activation (see [Implementation Plan P3](./micro-actor-runtime-implementation-plan.md#p3-cardactor-owns-authoritative-cancellation-and-activation-id-settlement)).
- `BaseMainLLMCardProcessorActor`: common to processors driven by a card's main agent LLM. It creates one `LLMActor` per logical invocation flow, lazily adopts recovered LLM snapshots inside `recoverActive`, resolves recovered initial LLM outcomes through inline tool replay, and exposes `notificationContext(input, inputId)` to drain main-agent notifications only while constructing planner/executor provider input (records delivery markers atomically). Reviewer turns have no main-agent queue access. It must not decide role-specific tool semantics.
- `PlanningCardProcessorActor`: project/goal semantics around planner, child activation, completion gate, reviewer phase, and planner/reviewer terminal contracts.
- `TerminalCardProcessorActor`: terminal-card executor semantics around executor terminal contract and process tools. Executor terminal outcomes are `done`, `failed`, or `blocked`, matching the uniform main-agent outcome vocabulary.

Use one `PlanningCardProcessorActor` for both project and goal behavior. Add distinct processor classes only when project and goal behavior truly differs.

Shared processor states from `BaseCardProcessorActor`:

- `idle`: parked; no activation is in progress.
- `running`: active; subclass-specific work is in progress.
- `settled`: parked; one public outcome is ready for or has been returned to the owning `CardActor`, and the processor may be reused for a later activation.

There is no processor `cancelled` state. Cancellation is owned by `CardActor` (via its cancellation flag); when a card is cancelled the owning processor is simply not activated again, and any in-flight processor task settles normally only to have `CardActor.commitOutcome()` drop the late outcome (see [Implementation Plan P3](./micro-actor-runtime-implementation-plan.md#p3-cardactor-owns-authoritative-cancellation-and-activation-id-settlement)).

Subclass-specific phase fields, not extra top-level actor states, should represent details such as planning, waiting on a child, waiting on a process, or reviewing unless a distinct state is needed for task ownership.

Project and goal processor phases:

- `planning`: planner main agent is active or can receive another turn.
- `waiting_child`: planner is blocked on an `activate_card` tool call.
- `waiting_process`: planner is blocked on a process-backed tool call.
- `reviewing`: reviewer is assessing a candidate done outcome.

Public methods:

- `activate(input)`: start or resume one card activation.
- `recoverActive(state, input, signal)`: recover an already-active processor state for a running card reached by the startup cascade.

Processors have no cancellation API. Running cancellation is owned by the `CardActor` activation (see [Implementation Plan P3](./micro-actor-runtime-implementation-plan.md#p3-cardactor-owns-authoritative-cancellation-and-activation-id-settlement)). Late processor outcomes are dropped by the CardActor cancellation flag.

Important actor fields:

- Active planner session id.
- Active reviewer session id, when reviewing.
- Planner `LLMActor` for the current invocation flow.
- Reviewer `LLMActor` for the current review invocation, when reviewer work has been needed.
- Active child activation metadata, when waiting on a child.
- Active process wait metadata, when waiting on a process.
- Queued notifications waiting for the next safe planner delivery point.
- Classified planner/reviewer result awaiting transition, if any.

Responsibilities:

- Build planner invocation context.
- Own planner/reviewer `LLMActor` instances for the current activation; processors do not reuse actors across activations until `LLMActor` has an explicit terminal-settlement API.
- Build the planner capability registry.
- Validate planner tool authority.
- Start immediate child cards through the owning `CardActor.activateChild(childId, caller)` capability; the processor does not hold child `CardActor` references.
- Treat child activation as a synchronous logical barrier from the planner perspective.
- Route process tools to the `ProcessRunner` service.
- Enforce readiness and evidence gates before review.
- Invoke reviewer only after gates pass.
- Store negative reviewer findings for planner context.
- Settle through `BaseCardProcessorActor.settle(...)` so the owning `CardActor` receives exactly one processor outcome.
- Return exactly one `done`, `failed`, or `blocked` processor outcome. Runtime cancellation is converted to the parent-visible `cancelled` activation outcome by `CardActor`, not by processors.

Event guidance:

- `activate` wakes `idle` or `settled` and starts a new activation.
- Planner, reviewer, child, and process waits normally complete with `done` or `failed` after storing result/diagnostic fields.
- Use specific branch events only when a single state needs different static transition targets that cannot be derived by entering an intermediate state.

Reviewer rules:

- Reviewer output must be structured enough for control-plane decisions.
- Ambiguous prose is a failure or tool error, not a guessed pass/fail.
- If card, subtree, or record changes arrive while reviewing and affect the assessed snapshot, reviewer success must be invalidated or diverted back to planning. Pending main-agent notifications alone do not invalidate reviewer success and reviewer turns must not drain them.

Terminal processor phases:

- `executing`: executor main agent is active or can receive another turn.
- `waiting_process`: executor is blocked on a process-backed tool call.

Public methods:

- `activate(input)`: start one terminal card activation.

Terminal processors have no cancellation API; running cancellation is owned by `CardActor` (see [Implementation Plan P3](./micro-actor-runtime-implementation-plan.md#p3-cardactor-owns-authoritative-cancellation-and-activation-id-settlement)).

Terminal responsibilities:

- Build executor invocation context.
- Own the executor `LLMActor` for the current activation; processors do not reuse actors across activations until `LLMActor` has an explicit terminal-settlement API.
- Build terminal tool capability registry.
- Route process tools to the `ProcessRunner` service.
- Validate executor terminal/reporting results.
- Commit terminal result data only from accepted executor results.
- Settle through `BaseCardProcessorActor.settle(...)` so the owning `CardActor` receives exactly one processor outcome.
- Return exactly one `done`, `failed`, or `blocked` outcome to the associated `CardActor`.

Event guidance:

- `activate` wakes `idle` or `settled` and starts a new terminal activation.
- Executor and process waits normally complete with `done`, `failed`, or `blocked` after storing result/diagnostic fields.
- Use specific branch events only when one state needs different static transition targets.

Terminal actors do not own children.

### LLMActor

Purpose: generic LLM/provider turn and tool-loop mechanics for planner, reviewer, and executor sessions.

Suggested states:

- `idle`: parked; no provider call is active and another turn may be requested by owner.
- `requesting_admission`: active; waiting for the `RuntimeGate` to open before calling the provider.
- `calling_provider`: active; provider request is in flight.
- `waiting_for_tool`: parked; a runtime tool result is required before another provider turn.

Completed turns return to `idle`; completion data is stored on actor fields before notifying the owning processor actor.

LLMActor event names are intentionally left to implementation. Provider/tool-loop requirements should drive the final transition table. The default rule still applies: provider admission, provider calls, and tool waits report local completion through `done` or `failed` unless a real branch fact needs a distinct event.

Public methods:

- `turn(inputRef)`: run a model turn from persisted input context.
- `appendToolResult(toolCallId, result, continuationContext)`: continue after tool success or tool error, including failed terminal `emit_result` repair tool results (tool errors are delivered through the same method; there is no separate `appendToolError`).
- `continueAfterPlainText(repairDirective, continuationContext)`: continue after a plain-text contract repair directive, with optional caller-provided context appended before the next provider call.
- `fromActiveReconstruction(...)`: rebuild a persisted active LLM without calling `start()`. This is invoked lazily by the owning processor's `recoverActive` path; a recovered `calling_provider` turn reissues the provider call and parks at the provider gate.

`LLMActor` has no public card-cancellation API. Authoritative cancellation is handled by `CardActor`'s cancellation flag (P3); any in-flight provider call's late outcome is dropped by `CardActor.commitOutcome()`. `LLMActor` never decides cancellation.

Responsibilities:

- Append durable invocation context before provider calls.
- Await the injected `RuntimeGate` directly before provider invocation; pause **waits** rather than failing the turn. The processor is not in the admission path.
- Receive already-built `LlmInvocationInput` from the owning processor. `LLMActor` does not own card notification queues and does not decide which notifications are deliverable.
- Persist provider responses before owner interpretation.
- Persist every assistant tool call before routing it.
- Enforce one result/error per tool call.
- Call the parent processor actor's hard-coded LLM completion/tool-call methods when the LLM turn completes or needs a runtime tool.
- Stay generic: do not decide public card outcomes.

Provider output rules:

- Multiple tool calls must follow an explicit documented protocol. The first implementation may fail fast rather than silently picking the first.
- Provider/account diagnostics remain outside model context unless deliberately sanitized into actionable recovery context.
- `waiting_for_tool` is parked; tool execution must own its timeout or bounded wait and eventually call `appendToolResult(...)`.

### ProcessRunner (service, not an actor)

Purpose: durable external process lifecycle. Process management is a service, not a micro-actor. It does real OS work and holds real state (live child handles, output streams, a durable registry), so it earns its existence as exactly one injected class. Do not wrap it in an actor, a facade, or module-level forwarding functions.

There is one `ProcessRunner` instance per runtime, injected from the composition root into the terminal processor (tool binding) and the shutdown path. The governing boundary test is "forward vs real work": any class or function that only delegates to the runner must not exist. No `ProcessApi` read/redaction wrapper class, no per-root module singleton, no free-function forwarders. Operator-facing redaction is a small set of functions (`toProcessView`, command redaction) applied at the HTTP/UI serialization boundary, not a wrapper around the runner.

Public methods:

- `spawn(spec)`: launch a child process, stream output to durable logs, register it, return the process record.
- `wait(id, timeout)`: bounded wait; timeout returns a result but does not kill the process.
- `kill(id, reason)`: terminate one process — SIGTERM, bounded wait, SIGKILL, reap. This is the single implementation of "actually stop a process," used by the `kill_process` tool and the scoped-set termination helpers. Unattached running records are signalled by process group (not silently flipped to `killed`).
- `stopByOwner(ownerId, reason, { graceMs })`: terminate all running processes owned by a specific owner (e.g., a terminal activation or analyst session).
- `stopRuntimeOwned(reason, { graceMs })`: terminate all running processes whose `owner_kind !== 'operator'`. Used by shutdown and stopProject. There is deliberately no blanket `stopAll`.
- Registry reads (`list`, `get`) over durable process records, plus start-time reconcile of records left behind by a crashed run. Reconcile is owner-scoped: runtime/agent-owned records are killed by PID or marked lost; operator-owned records are observed best-effort or marked lost. There is no `reattach_state` fiction (see [Implementation Plan P1](./micro-actor-runtime-implementation-plan.md#p1-processrunner-owns-truthful-process-state-and-scoped-termination)).

Responsibilities:

- Persist process identity, ownership, command metadata, status, and terminal result/failure.
- Return process tool results to the calling tool handler exactly once; the tool handler forwards the result to the waiting `LLMActor` via `appendToolResult(...)`.
- Reads and bounded waits on an already settled process read the persisted record directly.

Non-responsibilities:

- Notification routing. The runner records terminal results; delivering them as card notifications is a higher-layer concern and must not live in the runner.
- Operator-facing redaction (see above).

Routing:

- Process tools (`run_command`, `wait_process`, `kill_process`) call `ProcessRunner` methods directly.
- Shutdown calls `runner.stopRuntimeOwned(...)` directly. It does not walk the actor tree and does not route through any process actor.
- Runtime start invokes `reconcile()` before actor recovery to reconcile records left by a crashed run (see [Implementation Plan P2](./micro-actor-runtime-implementation-plan.md#p2-startup-reconciles-processes-before-actor-recovery)). Runtime/agent-owned running records are killed by PID or marked lost; operator-owned records are observed best-effort or marked lost (see [Implementation Plan P1](./micro-actor-runtime-implementation-plan.md#p1-processrunner-owns-truthful-process-state-and-scoped-termination)).
- Running cancellation is authoritative via `CardActor`'s activation-id settlement (see [Implementation Plan P3](./micro-actor-runtime-implementation-plan.md#p3-cardactor-owns-authoritative-cancellation-and-activation-id-settlement)); shutdown or explicit `kill_process` handles broader forced process termination beyond the activation-owned scope.

## External Command Mapping

Runtime public surfaces must map Analyst/operator commands to `SupervisorRuntimeApi`, `RuntimeGate`, `RuntimeState`, or card public methods. They must not call internal actor hooks or run workflow logic.

Initial command mapping:

| User/API command | Runtime target | Behavior |
| --- | --- | --- |
| start/run project | `SupervisorRuntimeApi` plus root `CardActor.activate()` and `RuntimeState` | Sets runtime state to running, activates root card, awaits outcome, and projects run record; or returns already-running warning. |
| pause runtime | `SupervisorRuntimeApi` plus `RuntimeGate.close()` and `RuntimeState` | Closes the global provider-admission gate and records paused runtime state; does not mutate card statuses. |
| resume runtime | `SupervisorRuntimeApi` plus `RuntimeGate.open()` and `RuntimeState` | Reopens the gate from paused and records running runtime state so provider waiters proceed in normal actor order. |
| shutdown | Runtime/composition root (`SupervisorRuntimeApi.shutdown()`) | Closes the runtime gate, records stopped runtime state, terminates runtime-owned processes via `ProcessRunner.stopRuntimeOwned(...)`, then halts. |
| cancel project | `SupervisorRuntimeApi` plus root `CardActor.cancel()` and `RuntimeState` | Cancels inactive project work immediately; for running project work, cancels the project card's current activation. |
| cancel card/subtree | `CardActor.cancel()` through the runtime command boundary | Marks inactive cards/subtrees `cancelled`; for running cards, cancels the current activation (writes `cancelled`, stops activation-owned process scope, rejects late outcomes, propagates to running children). |
| mark needs correction/change | `CardActor.markChanged(change)` | Sets durable card states to `changed` through edit/subtree propagation and queues notifications so active/future agents learn about the change. Notifications alone never set `changed`. |
| queue notification | `CardActor.notify(notification)` | Queues card-addressed context for delivery to the main agent session. Does not mutate card lifecycle state. |
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
- Reporting tools: planner, reviewer, and executor terminal reports, all submitted through the unified `emit_result` terminal tool; each role's contract validates the statuses that role may emit.

Rules:

- LLM actor persists the tool call before routing.
- Owning processor actor validates role-specific semantics.
- Process waits and child activations put the LLM actor into `waiting_for_tool`.
- Reporting tools are role-contract terminal tools interpreted by the owning card processor, not by `LLMActor`. Planner, executor, and reviewer terminal outcomes must be accepted only after their contract payload validates; free-form prose or ad-hoc JSON messages do not commit card outcomes.
- Terminal `emit_result` validation does not sample pending notification state, does not drain notifications, and does not defer or reject terminal results because notifications arrived after the provider call. Failed terminal repair guidance is written to the failed `emit_result` tool result; notification rows for a repair turn, if any, are separate continuation context in the next provider input.
- Rejected tool calls append a tool error and may allow another turn.
- Recovery repairs tool delivery from durable tool-call records and message logs.

## Notifications

Notifications are the primary context-delivery and steering mechanism. They let the runtime, the operator (through the Analyst), and edit propagation inform agents about situations the runtime does not encode as lifecycle state: changed subtrees, operator corrections, cross-card coordination, dependency updates, and any other context an agent needs to decide its next action. Because notifications can target a card in any lifecycle state, agents can handle situations — a done card that needs re-evaluation, a blocked child that was unblocked upstream, a failed card whose dependency was fixed — without the runtime needing a dedicated state for every scenario. Edit propagation queues notifications to the ancestor chain so planners learn about deep-tree changes; the `changed` state is a durable edit signal for completion gates, not a delivery mechanism.

Notifications are card-addressed ephemeral delivery items. There is no user-managed note object, note inbox, list/get operation, or acknowledgement workflow.

Rules:

- Analyst and runtime services enqueue notifications to cards.
- The card runtime appends pending notifications to the main agent session only while constructing provider input.
- `CardActor` owns the pending card-addressed queue. The processor's `notificationContext(input, inputId)` drains deliverable main-agent notifications at safe planner/executor pre-provider-call points only; reviewer flows have no queue access (see [Implementation Plan P5](./micro-actor-runtime-implementation-plan.md#p5-reviewer-cannot-reach-main-agent-notification-delivery)).
- `LLMActor` is deliberately queue-free. It receives notification content only as part of the `LlmInvocationInput` built by the owning processor, preserving generic provider/tool-loop mechanics and keeping card semantics in card/processor actors.
- `CardActor` exposes a delivery method for its processor to drain notifications deliverable to a specific main-agent input and record delivery markers. Processor activation inputs do not expose pendingness queries.
- Project/goal main agent is the planner.
- Terminal main agent is the executor.
- Reviewer is not the main agent for notification delivery.
- Delivery happens before the next provider call, not by interrupting an in-flight call and not during terminal validation.
- Delivery evidence is the agent session transcript and a small durable delivery marker.
- Project/goal processors must have access to their owning `CardActor` so they can drain newly queued main-agent notifications before every planner provider turn, not only at activation.
- Safe pre-provider delivery points are initial planner/executor turns, continuations after non-terminal tool results, continuations after failed terminal `emit_result` repair tool results, and continuations after plain-text repair directives. If terminal validation succeeds and no further provider call is made, notifications that arrived after the last safe point remain queued for a future safe provider-input delivery. `CardActor` only commits clean outcomes; it never flips `done` to `changed` because of pending notifications. Notifications arriving on an already-inactive `done` card after settlement are queued for future delivery and do not mutate lifecycle state. `changed` is produced only by card edits/subtree mutations, never by notification delivery.

Notifications can affect flow:

- While planning/executing, append before the next turn.
- While waiting on child/process, keep pending until the tool result is appended and the next turn is prepared.
- While reviewing, hold pending main-agent notifications for later planner/executor delivery. Actual card/subtree/record changes that affect the reviewed snapshot divert back to planning after reviewer completion or invalidate reviewer success; pending notification state alone does not. Cancellation during review cancels the current activation; late reviewer outcomes are dropped by the CardActor cancellation flag (see [Implementation Plan P3](./micro-actor-runtime-implementation-plan.md#p3-cardactor-owns-authoritative-cancellation-and-activation-id-settlement)).
- While settled/inactive, keep pending until reactivation or discard/archive by domain policy. Notifications queued on terminal `cancelled` cards can never be reactivated; they remain queued as provenance and do not steer any agent. To replace cancelled work, create a new card or notify the parent planner.

## Pause, Cancellation, And Shutdown

Pause (see [Implementation Plan P4](./micro-actor-runtime-implementation-plan.md#p4-runtimegate-replaces-llm-admission-and-owns-the-pause-barrier)):

- `RuntimeGate` closes; `RuntimeState.status` records paused mode.
- Active provider calls and already-running OS processes may continue until the next durable boundary.
- No new provider call starts while paused.
- Already-received provider responses may execute tool calls, spawn runtime-owned processes, dispatch child/root cards, persist facts, and settle to durable boundaries while paused. Follow-up provider calls park at the provider gate.
- Resume reopens the gate. Existing waiters proceed exactly once in normal actor order; there is no separate held-deliverables queue or replay scheduler. Resume must preserve one-active-leaf and exactly-one-tool-result invariants.
- Pause itself does not change card lifecycle state.

Cancellation:

- Cancellation is immediate only for inactive cards. The requested inactive card/subtree is marked `cancelled` through canonical card rules, while descendants already `done` remain `done`.
- Cancellation for running cards is authoritative. `CardActor.cancel()` cancels the current activation, writes `cancelled` to the card store immediately, resolves the pending activation as cancelled, stops activation-owned runtime process scope via `ProcessRunner.stopByOwner(#activationId)`, and drops late provider/tool/process outcomes through the CardActor cancellation flag. Running children are cancelled through their own `CardActor.cancel()` so they are cancelled too (see [Implementation Plan P3](./micro-actor-runtime-implementation-plan.md#p3-cardactor-owns-authoritative-cancellation-and-activation-id-settlement)).
- Hard shutdown remains the operation for forcibly terminating runtime-owned work regardless of agent cooperation.

Shutdown (operational teardown at the runtime root):

Shutdown is not a domain state cascade. The goal is to halt all actor activity, not to drive every agent to a terminal state. It is performed by the runtime/composition root.

1. Close the runtime gate and record stopped mode in `RuntimeState`.
2. Terminate runtime-owned OS processes via `ProcessRunner.stopRuntimeOwned(...)` — SIGTERM, bounded wait, SIGKILL stragglers, reap, dispose scope.
3. In-flight provider calls are abandoned; recovery classifies them as `abandon_with_diagnostic` on next startup.
4. Mark the runtime stopped. Activity halts because no new work is admitted and all OS-level waits have settled.

No actor owns process termination or tree-cascade logic for shutdown. Driving agents through domain states on shutdown is explicitly avoided; in-flight work is left to be classified by recovery on the next startup.

## Persistence And Recovery

Persist Saivage-owned data at explicit boundaries:

- Card records and histories.
- Agent messages and tool-call delivery records.
- Runtime state: status, root intent, pause/shutdown diagnostics.
- Card actor reconstruction records: actor id, card id, actor kind, current state, active child/process/tool wait metadata.
- LLM actor reconstruction records: session id, role, state, admission/request metadata, current tool call wait.
- Process records: process id, command metadata, status, terminal result/failure, delivery status.
- Notification delivery records.
- Runtime event and error timelines.

State-transition persistence rule:

- Actor reconstruction records are persisted from `_on_state_changed(oldState, newState)` when a fresh actor starts or a normal transition changes state.
- `_on_state_changed(...)` captures the new actor state before `_on_enter__{state}` starts entry work. Entry hooks should therefore focus on state-specific behavior such as starting tasks or writing domain facts, not on generic snapshot persistence.
- If `_on_enter__{state}` mutates fields that must be reflected in the same actor snapshot, either move that mutation before the transition is requested or perform an explicit `persist()` after the mutation. Do not preserve per-state `persist()` calls merely to record the new state.
- Public methods and task callbacks still persist non-transition context changes explicitly. Examples include notification queues, process stdout/stderr, tool-delivery metadata, and completed outcome fields.

Do not persist:

- `BaseActor` private fields.
- Internal pending events.
- In-memory task lists.
- Job queues.
- Function closures, actor object references, or provider client objects.

Recovery procedure (implemented startup sequence):

**Phase 0 — process reconciliation before actor recovery.** Reconcile persisted running process records through the `ProcessRunner` registry BEFORE actor recovery (see [Implementation Plan P1](./micro-actor-runtime-implementation-plan.md#p1-processrunner-owns-truthful-process-state-and-scoped-termination), [P2](./micro-actor-runtime-implementation-plan.md#p2-startup-reconciles-processes-before-actor-recovery)). There are three cases: runtime/agent-owned records are killed by PID/process-group or marked lost and retained as terminal records; operator-owned records that are still alive are matched and remain `running`, not terminal; operator-owned records that are missing or clock-skewed are marked lost and retained as terminal records. No process record is removed. Startup does not reattach OS processes and does not use a `reattach_state`.

**Phase 1 — validate root record, build the recovery plan, and run the pre-reconstruction pass.** Close the runtime gate, then validate the project root card record. If the root card record is missing, unreadable, or fails the card schema, startup throws before recovery planning. Next, read CardStore, runtime records, session logs, tool records, notification records, actor snapshots, and `activeReconstruction` records to build the recovery plan; the plan is not derived from public-status or state-name heuristics. `runActorStartupRecovery` then runs the complete pre-reconstruction pass in this order, all before live actor reconstruction or inline tool replay:

1. Clean cancelled-card snapshots.
2. Project safe persisted terminal tool-call outcomes (executor terminal, planner `blocked`/`failed`, planner `done` paired with a matching persisted reviewer terminal result) only when active card, processor, LLM, and reviewer reconstruction records all agree; mark them `terminal_projected`.
3. Clean cancelled and terminal-projected handled snapshots. These are snapshots whose card outcomes were just committed by terminal projection, not reconstructed snapshots.
4. Abandon stale pending tool calls once.
5. Rebuild the recovery plan.
6. Write sanitized recovery diagnostics for ambiguous or stranded active work. Diagnostics do not patch card status to `blocked` or any other status.

**Phase 2 — construct running cards and recover by top-down cascade.** When running recovery work exists, construct running `CardActor` instances with deferred recovery and deferred processor start. This construction is data/tree work only: no processor starts, no LLM adoption, and no recovery side effects. Then call `recoverCurrentCardState()` on the root card only. The root's `_on_recover__running` starts its processor lazily and calls `processor.recoverActive`, which adopts recovered LLM snapshots and resolves the initial LLM outcome. A recovered `calling_provider` LLM reissues the provider call and parks at the closed gate until the operator resumes. A recovered `waiting_tool` LLM is resolved inline through `resolveInitialOutcome`; non-terminal tool calls use `replayToolForRecovery`, and a replayed running `activate_card` call recovers the child card and awaits settlement. Process-tool replays resolve as interrupted because process records were already reconciled in Phase 0.

**Phase 3 — leave the runtime in the correct mode.** If running recovery work existed, leave the runtime paused with the gate closed for operator verification. Otherwise, follow the persisted runtime mode.

Recovery classifications used by the current policy:

- `terminal_projected`: a persisted terminal tool call safely projects a card outcome from durable records.
- `complete_no_live_actor`: no live actor is needed for a settled/parked state.
- `abandon_with_diagnostic`: interrupted work with no safe reconstruction; recorded as sanitized operator-visible diagnostics in Phase 1 before reconstruction, not as a `blocked` card outcome.

Non-goal: OS process reattachment is deliberately excluded. Runtime/agent-owned process records and missing/skewed operator-owned process records are reconciled to retained terminal records; live operator-owned process records remain `running`; none are reattached to actors. Do not add adapters or bridges over in-memory promises, provider calls, or process handles to approximate reattachment.

## API And Projection

`RuntimeApi` is the external command and projection boundary. It is not a workflow runner and not a compatibility wrapper.

Allowed responsibilities:

- Construct or attach the runtime root and call `SupervisorRuntimeApi`/card public methods. The root `CardActor.activate()` owns root activation; `RuntimeApi` calls it, awaits the promise, and projects the run record — it does not branch over planner/executor/reviewer sequencing. There is no production projection-only runtime mode.
- Validate command authority and shape.
- Subscribe or wait on projected state.
- Project cards, agents, processes, runtime mode, diagnostics, and timelines.

Forbidden responsibilities:

- Directly instantiate child actors below card ownership.
- Branch over planner/executor/reviewer workflow.
- Synthesize child activation outcomes.
- Call protected actor methods.
- Expose raw actor internals, task IDs, or transition-table state.
- Run workflow loops or branch over runtime phases.
- Expose raw actor private state or compiled transition tables over public APIs.

Projection requirements:

- Show stopped/running/paused (and error on failed startup) truthfully, mapped from `RuntimeState.status`.
- Show active chain and active leaf.
- Show current provider/process waits when safe to expose.
- Show recovery/cancellation diagnostics.
- Keep raw provider secrets and internal error details out of model context and default UI projections.

## Source Layout Draft

Candidate production layout:

```text
src/runtime/micro-actor/
  micro-actor.ts

src/runtime/actors/
  supervisor-runtime-api.ts   # RuntimeApi boundary (composition root)
  card-actor.ts
  base-card-processor-actor.ts
  base-main-llm-card-processor-actor.ts
  planning-card-processor-actor.ts
  terminal-card-processor-actor.ts
  llm-actor.ts

src/runtime/process-runner.ts   # the one injected process service; not an actor
src/runtime/runtime-gate.ts     # the one injected pause/admission service; not an actor

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
- Whether reviewer structured output is tool-based immediately or strict JSON in the first implementation.
- Exact public schema fields for active-chain and runtime activity projection.

These are implementation decisions, not reasons to keep old XState or controller design.
