# Micro-Actor Runtime Redesign Draft

Status: first draft.

Date: 2026-06-19.

## Purpose

This document is the fresh runtime design draft for introducing the local micro-actor framework into the Saivage v3 application.

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
- Make cancellation cooperative, bounded, and explicit.
- Route notifications to cards, then deliver them to that card's main agent session at a safe LLM admission boundary.
- Prefer deletion of old controller/decorator layers over preserving old tests or APIs.

Ideas intentionally discarded:

- XState dependency, snapshots, event queues, actor refs, parallel states, and machine setup APIs.
- Decorative state machines wrapped around imperative loops.
- Generic command buses, event-sourcing layers, workflow engines, or global orchestration frameworks.
- Promise-returning child-activation facades that hide runtime ownership.
- Process-global note sinks.
- Public or persisted framework snapshots as authoritative runtime state.
- Compatibility shims for old runtime state unless a live deployment requires one and the user explicitly asks for it.

## Design Rules

- Runtime behavior is owned by `BaseActor` subclasses and their explicit public methods.
- Public methods accept external work and may return command/job IDs or immediate command acceptance results.
- Internal state changes are string events sent with `sendEvent(...)`.
- Long work is run through `runTask(...)`; task completion callbacks store results and then send `done` unless a specific branch fact is needed.
- Actor state names are small and product-meaningful. Do not create a state for every helper function.
- Use `SlaveActor.submitJob(...)` only for externally queued work where a caller needs a returned job ID and cancellation handle.
- Do not expose actor state, task IDs, private fields, compiled definitions, or internal events through API/UI contracts.
- Persist Saivage domain facts and actor reconstruction data, not in-memory queues.
- If recovery cannot prove a safe continuation, fail or block explicitly with operator-visible diagnostics.

## System Shape

The runtime actor tree has one root supervisor and a deterministic card actor tree:

```text
RuntimeSupervisorActor
  CardNodeActor(project)
    ProjectCardActor
      LlmActor(planner:project)
      LlmActor(reviewer:project)
      ProcessActor(... as needed)
    CardNodeActor(goal)
      GoalCardActor
        LlmActor(planner:goal)
        LlmActor(reviewer:goal)
        ProcessActor(... as needed)
      CardNodeActor(terminal)
        TerminalCardActor
          LlmActor(executor:terminal)
          ProcessActor(... as needed)
```

`CardNodeActor` owns public card lifecycle and projection. Type-specific actors own planner, reviewer, executor, tool, and process semantics.

The active chain may contain several public `running` cards, but only the leaf actor receives provider/process scheduling at a time.

## Actor Inventory

### RuntimeSupervisorActor

Purpose: root runtime control, pause gate, shutdown, recovery, and parentless project ownership.

Suggested states:

- `idle`: no root work is active.
- `running`: root project exists and admission is open.
- `paused`: root project may exist, but no new model/provider calls are admitted.
- `shutting_down`: pause gate is closed and runtime-owned processes are being terminated.

Public methods:

- `run()`: start idle project work or resume from paused.
- `pause()`: close model/provider admission.
- `shutdown()`: close admission, terminate runtime-owned running processes, and settle.
- `cancelProject()`: cooperatively cancel the active root chain.
- `recover()`: rebuild actor tree from persisted state.

Responsibilities:

- Own the parentless project `CardNodeActor`.
- Enforce duplicate-run behavior: return already-running warning, no duplicate root run.
- Own admission policy for provider calls.
- Coordinate shutdown process termination.
- Project runtime status for API/UI.
- Rebuild or explicitly fail unsafe runtime state during startup recovery.

Non-responsibilities:

- Planner/executor/reviewer semantics.
- Tool-call interpretation.
- Direct card mutation outside canonical services.

### CardNodeActor

Purpose: durable public card lifecycle boundary.

States mirror public card status:

- `backlog`
- `changed`
- `running`
- `blocked`
- `canceled`
- `failed`
- `done`

Public methods:

- `activate(caller)`: validate authority and start the card.
- `notify(notification)`: enqueue card-addressed context.
- `cancel(reason)`: cancel inactive card or coordinate active cancellation.
- `markChanged(change)`: apply card/subtree change semantics.

Responsibilities:

- Write public status through CardStore.
- Own the type-specific internal actor for project, goal, or terminal cards.
- Enforce direct-child activation authority.
- Commit exactly one activation outcome before returning it to the parent.
- Deliver card-addressed notifications to the card's main agent at safe boundaries.
- Keep `changed` as public card state, not a generic actor phase.

Changed-state rules:

- Inactive modified cards become `changed`.
- Running modified cards remain `running` and receive notifications/context.
- A goal cannot report `done` while executable descendants remain `backlog`, `changed`, `blocked`, `failed`, or `running`.
- `canceled` descendants are completion-compatible.

### ProjectCardActor And GoalCardActor

Purpose: planner/reviewer semantics for project and goal cards.

Suggested states:

- `planning`: planner main agent is active or can receive another turn.
- `waiting_child`: planner is blocked on an `activate_card` tool call.
- `waiting_process`: planner is blocked on a process-backed tool call.
- `reviewing`: reviewer is assessing a candidate done outcome.
- `settled`: one public outcome is ready for the owning `CardNodeActor`.

Important actor fields:

- Active planner session id.
- Active reviewer session id, when reviewing.
- Active child activation metadata, when waiting on a child.
- Active process wait metadata, when waiting on a process.
- Pending notifications for planner delivery.
- Classified planner/reviewer result awaiting transition, if any.

Responsibilities:

- Build planner invocation context.
- Own the planner capability registry.
- Validate planner tool authority.
- Start immediate child cards through owned `CardNodeActor` references.
- Treat child activation as a synchronous logical barrier from the planner perspective.
- Route process tools to `ProcessActor` or process services.
- Enforce readiness and evidence gates before review.
- Invoke reviewer only after gates pass.
- Store negative reviewer findings for planner context.
- Return exactly one `done`, `failed`, or `blocked` activation outcome.

Reviewer rules:

- Reviewer output must be structured enough for control-plane decisions.
- Ambiguous prose is a failure or tool error, not a guessed pass/fail.
- If notifications or changes arrive while reviewing, reviewer success must be invalidated or diverted back to planning when those changes affect the assessed subtree.

### TerminalCardActor

Purpose: executor semantics for one terminal activation.

Suggested states:

- `executing`: executor main agent is active or can receive another turn.
- `waiting_process`: executor is blocked on a process-backed tool call.
- `settled`: one public outcome is ready for the owning `CardNodeActor`.

Responsibilities:

- Build executor invocation context.
- Own terminal tool capability registry.
- Route process tools to `ProcessActor` or process services.
- Validate executor terminal/reporting results.
- Commit terminal result data only from accepted executor results.
- Return exactly one `done` or `failed` outcome to the owning `CardNodeActor`.

Terminal actors do not own children.

### LlmActor

Purpose: generic LLM/provider turn and tool-loop mechanics for planner, reviewer, and executor sessions.

Suggested states:

- `idle`: no provider call is active; another turn may be requested by owner.
- `requesting_admission`: waiting for supervisor admission to call provider.
- `calling_provider`: provider request is in flight.
- `waiting_tool`: a runtime tool result is required before another provider turn.
- `settled`: this episode is done and control returns to owner.

Public methods:

- `submitTurn(inputRef)`: run a model turn from persisted input context.
- `appendToolResult(toolCallId, result)`: continue after tool success.
- `appendToolError(toolCallId, error)`: continue after tool failure.
- `cancel(reason)`: cancel or refuse future admission.

Responsibilities:

- Append durable invocation context before provider calls.
- Request/release provider admission through supervisor-owned policy.
- Persist provider responses before owner interpretation.
- Persist every assistant tool call before routing it.
- Enforce one result/error per tool call.
- Forward raw terminal/reporting objects to the owning card actor.
- Stay generic: do not decide public card outcomes.

Provider output rules:

- Multiple tool calls must follow an explicit documented protocol. The first implementation may fail fast rather than silently picking the first.
- Provider/account diagnostics remain outside model context unless deliberately sanitized into actionable recovery context.

### ProcessActor

Purpose: durable external process lifecycle.

Suggested states:

- `running`: process exists or is being reconciled.
- `killing`: explicit termination is in progress.
- `settled`: process terminal result, failure, or abandonment is recorded.

Public methods:

- `startOrAttach(spec)`: create or reattach to a process record.
- `wait(timeout)`: bounded wait for completion.
- `inspect(range)`: safe status/log projection.
- `kill(reason)`: terminate or mark abandoned.

Responsibilities:

- Persist process identity and ownership.
- Persist terminal result/failure.
- Return process tool results to the waiting `LlmActor` exactly once.
- Reattach to running processes after restart when safe.
- Treat late results after cancellation as diagnostics, not second tool results.

## External Command Mapping

Runtime public surfaces must map Analyst/operator commands to supervisor or card public methods. They must not call internal actor hooks or run workflow logic.

Initial command mapping:

| User/API command | Runtime target | Behavior |
| --- | --- | --- |
| start/run project | `RuntimeSupervisorActor.run()` | Starts root work or returns already-running warning. |
| pause runtime | `RuntimeSupervisorActor.pause()` | Closes admission gate; does not mutate card statuses. |
| resume runtime | `RuntimeSupervisorActor.run()` | Reopens admission from paused. |
| shutdown | `RuntimeSupervisorActor.shutdown()` | Pauses admission and terminates runtime-owned processes. |
| cancel project | `RuntimeSupervisorActor.cancelProject()` | Cooperatively cancels active root chain. |
| cancel card/subtree | `CardNodeActor.cancel()` through canonical service/runtime adapter | Cancels inactive subtree or coordinates active cancellation if supported. |
| mark needs correction/change | `CardNodeActor.notify()` / `markChanged()` | Queues notification and updates public changed state where applicable. |
| activate child | Owning `GoalCardActor` capability | Validates direct-child authority and starts child card. |

The adapter may wait for projected state when an existing API contract requires a completion response. Waiting must observe actor/card projections, not execute workflow itself.

## Tool Protocol

Every assistant tool call persisted in an agent session has one durable terminal delivery:

- `delivered`: tool result appended.
- `errored`: tool error appended.
- `abandoned`: cancellation/recovery recorded no normal result.

Tool routing groups:

- Local immediate tools: read-only inspection or cheap card/file operations that complete in the same LLM turn.
- Cross-card tools: `activate_card`, cancellation/change operations, and direct-child mutations.
- Process tools: start, wait, inspect, kill.
- Reporting tools: planner, reviewer, and executor terminal reports.

Rules:

- LLM actor persists the tool call before routing.
- Owning card actor validates role-specific semantics.
- Process waits and child activations put the LLM actor into `waiting_tool`.
- Reporting tools are interpreted by the owning card actor, not by `LlmActor`.
- Rejected tool calls append a tool error and may allow another turn.
- Recovery repairs tool delivery from durable tool-call records and message logs.

## Notifications

Notifications are card-addressed ephemeral delivery items. There is no user-managed note object, note inbox, list/get operation, or acknowledgement workflow.

Rules:

- Analyst and runtime services enqueue notifications to cards.
- The card runtime decides when to append pending notifications to the main agent session.
- Project/goal main agent is the planner.
- Terminal main agent is the executor.
- Reviewer is not the main agent for notification delivery.
- Delivery happens before the next provider call, not by interrupting an in-flight call.
- Delivery evidence is the agent session transcript and a small durable delivery marker.

Notifications can affect flow:

- While planning/executing, append before the next turn.
- While waiting on child/process, keep pending until the tool result is appended and the next turn is prepared.
- While reviewing, hold pending notifications; if they affect the reviewed subtree, divert back to planning after reviewer completion or invalidate reviewer success.
- While settled/inactive, keep pending until reactivation or discard/archive by domain policy.

## Pause, Cancellation, And Shutdown

Pause:

- Supervisor closes provider admission.
- Active provider calls reach the next durable boundary.
- No new model/provider call starts while paused.
- Process actors may continue; their results are persisted and delivered on resume/recovery.
- Pause does not change card lifecycle state.

Cancellation:

- Inactive cards/subtrees can be marked `canceled` synchronously through CardStore rules.
- Active cancellation is cooperative and bounded.
- Active LLM actors refuse future admission and receive cancellation context at safe boundaries.
- Runtime-owned processes are killed or marked abandoned according to process policy.
- Parent planners receive a normal failed/blocked/done activation result or tool error according to the owning card's policy; do not invent a second activation result.

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
7. Run actor-specific recovery public methods or `recover(state)` where safe.
8. Repair forward or fail explicitly when state is ambiguous.

Recovery classifications for each actor state must be designed before implementation:

- `resume_safe`: continue from durable boundary.
- `reconcile_then_resume`: inspect child/process/tool record first.
- `abandon_with_diagnostic`: no safe continuation; record failed/blocked outcome.
- `terminal`: no live actor needed.

## API And Projection

`RuntimeApi` remains the external adapter if useful.

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
  card-node-actor.ts
  project-card-actor.ts
  goal-card-actor.ts
  terminal-card-actor.ts
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

## Implementation Slices

### Slice 1: Supervisor Shell And Runtime API Boundary

- Introduce or adapt `RuntimeSupervisorActor` as the only root runtime actor.
- Ensure `RuntimeApi` calls supervisor public methods only.
- Project truthful idle/running/paused status from supervisor/card records.
- Delete adapter paths that still drive workflow directly when replaced.

Acceptance:

- Duplicate run returns already-running warning.
- Pause blocks new provider admission.
- API tests prove no lower-level actor/controller imports in `RuntimeApi`.

### Slice 2: CardNodeActor Lifecycle Boundary

- Implement public card lifecycle actor states.
- Route activation through `CardNodeActor.activate(...)`.
- Keep public status writes centralized.
- Add changed-state and notification enqueue behavior.

Acceptance:

- One active chain is represented by card actors and public status.
- Direct-child activation authority is enforced.
- Changed descendants block parent `done`.

### Slice 3: Generic LlmActor

- Implement provider admission, provider call, tool-call persistence, and terminal output forwarding.
- Fail fast on unsupported provider output such as multiple tool calls if not yet supported.
- Keep role interpretation out of `LlmActor`.

Acceptance:

- Provider call can be cancelled or denied by pause.
- Every tool call gets a durable pending record.
- Raw result is forwarded to owner for interpretation.

### Slice 4: TerminalCardActor

- Use `LlmActor` for executor turns.
- Implement executor reporting and process tools.
- Commit accepted terminal results through CardStore.

Acceptance:

- Terminal card runs to `done` or `failed`.
- Process wait and cancellation are covered.
- Terminal result is attached only from accepted executor output.

### Slice 5: Goal/Project Planner Flow

- Use `LlmActor` for planner turns.
- Implement direct-child activation and process waits.
- Implement planner terminal reports and readiness/evidence gates.

Acceptance:

- `activate_card` returns exactly one result/error to planner.
- Planner cannot finish with incomplete descendants.
- Process waits are explicit and recoverable.

### Slice 6: Reviewer Flow

- Implement reviewer invocation after gates pass.
- Require structured reviewer outcome.
- Route corrections back to planner context.
- Invalidate reviewer success on relevant pending changes.

Acceptance:

- Pass commits reviewed done.
- Corrections append planner context and resume planning.
- Ambiguous reviewer output fails visibly.

### Slice 7: Recovery

- Define and implement actor reconstruction records.
- Rebuild supervisor/card/LLM/process actors from durable state.
- Repair child/process/tool waits.
- Fail unsafe states explicitly.

Acceptance:

- Startup handles active planner wait on child.
- Startup handles process terminal result awaiting delivery.
- Startup handles interrupted reviewer with planner-visible diagnostic.

### Slice 8: Cleanup

- Delete XState-era factories, files, tests, and dependencies that no longer serve current design.
- Delete controller classes that duplicate actor workflow.
- Replace old tests with actor/API/projection tests.

Acceptance:

- No production import of XState runtime files remains.
- No production `*Controller` owns runtime workflow.
- Focused actor tests and routine validation pass.

## Tests To Write

Minimum focused test families:

- Micro-actor definition/task/cancellation tests.
- Supervisor run/pause/resume/shutdown tests.
- CardNode activation/status/changed-state tests.
- LlmActor provider admission/tool-call protocol tests.
- Goal actor child activation barrier tests.
- Goal actor process wait tests.
- Terminal actor executor/process tests.
- Reviewer structured verdict tests.
- Recovery classification tests.
- RuntimeApi boundary tests proving it does not import or drive child workflows.
- Projection tests for idle/running/paused/shutting-down and active chain.

Delete tests that only protect old XState/controller behavior once replacement coverage exists.

## Open Questions

- Exact completed actor-record retention policy: delete, archive, or keep bounded history.
- Exact cancellation outcome surfaced to parent planner for active subtree cancellation.
- Whether process tools share one `ProcessActor` per process record or use direct process-service tasks for short operations.
- Whether reviewer structured output is tool-based immediately or strict JSON as a temporary bridge.
- Exact public schema fields for active-chain and runtime activity projection.

These are implementation decisions, not reasons to keep old XState or controller design.
