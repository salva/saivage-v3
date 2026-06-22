# Micro-Actor Runtime Implementation Plan

Status: target implementation plan.

Date: 2026-06-22.

## Purpose

This plan introduces the micro-actor runtime core described in [Micro-Actor Runtime Design](./micro-actor-runtime-design.md). It is intentionally direct: replace controller/workflow orchestration with concrete `BaseActor` subclasses, keep public API responses as projections, and delete superseded paths as each slice lands.

No compatibility layer is planned. If old controller behavior conflicts with the actor design, replace it. In most slices, rewriting implementation files from scratch is expected to be simpler and safer than adapting old XState/controller code.

## Ground Rules

- Keep `BaseActor` as the only actor framework.
- Use actor public methods for domain commands; do not expose raw events outside actor classes.
- Use `done` and `failed` for normal task completion. Add named events only for external commands or real branch facts.
- Keep parked states idle. They advance only through public methods using `parkedSendEvent(...)`.
- Use `BaseActor._on_state_changed(oldState, newState)` for generic actor snapshot persistence after `start()` and normal state transitions. It is called after assigning the new state and before `_on_enter__{state}`, and it is intentionally not called by `recover(...)`.
- Do not add `_on_enter__{state}` hooks whose only purpose is saving the actor snapshot. Keep explicit `persist()` calls only where actor context changes without a state transition or where entry logic mutates fields that must be persisted after the transition snapshot.
- Keep orchestration inside actor classes. `RuntimeApi` may validate commands, call public methods, wait on projections, and project state.
- Persist domain facts and reconstruction records, not in-memory queues, function closures, or actor internals.
- Delete replaced controller/XState-era code during the slice that makes it obsolete.
- Do not add adapters, bridges, shims, or compatibility tests for old runtime behavior. Tests should protect the new actor design, not legacy contracts.

## Slice 1: RuntimeApi Boundary And Supervisor Shell

Goal: make the runtime entry point actor-centered before changing card execution.

Implementation:

- Replace the existing supervisor/controller shell with a new `RuntimeSupervisorActor`; do not adapt `RuntimeSupervisorController` as a bridge.
- Add states `idle`, `running`, `paused`, and `shutting_down`.
- Implement public methods `run()`, `pause()`, `shutdown()`, and `cancelProject()`.
- Persist supervisor state transitions from `_on_state_changed(...)`; keep explicit persistence for non-transition context changes such as provider admission/release fields or initialization data.
- Keep duplicate `run()` simple: if already running, return an already-running warning and do not create new work.
- Keep the existing public `RuntimeApi` surface where operators/tools already call it, but replace the implementation so it constructs or attaches to the supervisor and calls only supervisor/card public methods.
- Move runtime mode projection into projection/read-model code.
- Delete any `RuntimeApi` path that advances planner/executor/reviewer workflow directly once replacement is in place.

Tests:

- Supervisor starts idle work from `idle`.
- `run()` from `running` returns already-running and creates no duplicate root work.
- `pause()` closes admission and does not mutate card status.
- `run()` from `paused` resumes admission.
- `shutdown()` transitions through shutdown and returns to `idle` with diagnostics.
- RuntimeApi boundary test proves it does not import or instantiate child workflow actors.
- No `RuntimeSupervisorController` compatibility wrapper remains.

Acceptance:

- Public runtime mode projections show idle/running/paused/shutting-down truthfully.
- No lower-level planner/executor/reviewer workflow is run by `RuntimeApi`.
- Focused supervisor/API tests pass.

## Slice 2: CardActor Lifecycle Boundary

Goal: centralize public card lifecycle state in `CardActor`.

Implementation:

- Add `CardActor` with public states `backlog`, `changed`, `running`, `blocked`, `failed`, `done`, and `cancelled`.
- Mark inactive reactivatable states as parked and `cancelled` as terminal.
- Implement public methods `activate(caller)`, `notify(notification)`, `cancel(reason)`, and `markChanged(change)`.
- Persist card actor state transitions from `_on_state_changed(...)` and remove empty `_on_enter__{state}` hooks that only save snapshots.
- Keep explicit persistence for card context changes that do not transition state, including queued notifications, change metadata, cancellation metadata, and accepted activation outcomes.
- Persist public card status changes through the canonical card store before reporting outcomes upward.
- Instantiate or reconnect direct child `CardActor` instances from card data.
- Instantiate or reconnect the associated processor actor for the card type.
- Use `BaseActor.recover(state)` when reconnecting a fresh actor instance to an existing durable card state.
- In `running`, call the processor's `activate(input)` method and wait on a parent-owned promise.
- Call hard-coded parent completion methods when activation outcomes are committed.
- Keep running-card change handling simple: running cards stay `running` and receive notification/context.

Tests:

- Activatable statuses are `backlog`, `changed`, `blocked`, and `failed`.
- `activate(...)` rejects non-child or not-ready activation.
- Activation transitions to `running` and starts the processor.
- Processor `done`, `failed`, and `blocked` outcomes update card state before parent notification.
- `markChanged(...)` moves inactive cards to `changed` and leaves running cards `running`.
- `cancel(...)` marks cards/subtrees `cancelled`, preserves descendants already `done`, and records late active-work results as diagnostics.
- `_on_state_changed(...)` records card actor state transitions, while `recover(...)` does not emit a new transition snapshot.

Acceptance:

- Card status writes are centralized through `CardActor`/canonical card service.
- One active chain can be represented by `running` CardActors.
- No controller code mutates running card status outside the actor/canonical service path.

## Slice 3: Generic LLMActor

Goal: isolate provider calls and tool-call loop mechanics from planner/executor/reviewer semantics.

Implementation:

- Add `LLMActor` with states needed by implementation, starting from `idle`, `requesting_admission`, `calling_provider`, and `waiting_tool` unless implementation proves a simpler table.
- Implement public methods `turn(inputRef)`, `appendToolResult(toolCallId, result)`, `appendToolError(toolCallId, error)`, and `cancel(reason)`.
- Persist LLM actor state transitions from `_on_state_changed(...)`; keep explicit persistence for input, outcome, waiting-tool, delivered-tool, and cancellation fields that change outside a state transition.
- Persist model-visible input context before provider calls.
- Request provider admission through the parent processor actor and supervisor policy; paused processors do not request new LLM turns.
- Persist provider responses before interpretation by the owner.
- Persist assistant tool calls before routing them.
- Enforce exactly one tool result or tool error per tool call.
- Return raw provider outcome/tool-call facts to the parent processor through hard-coded methods.
- Fail fast on unsupported provider output such as multiple parallel tool calls until a deliberate protocol is implemented.

Tests:

- `turn(...)` persists invocation context before provider call.
- A paused processor does not request a new LLM turn, so no provider call starts while paused.
- Provider failure returns a failed LLM outcome to the parent processor.
- Tool calls are persisted before routing.
- `appendToolResult(...)` and `appendToolError(...)` continue from `waiting_tool`.
- Duplicate tool result/error for the same tool call is rejected.
- Cancellation before admission prevents future provider calls.
- Cancellation during provider work is observed at the next safe boundary.

Acceptance:

- LLMActor contains no planner/executor/reviewer-specific semantics.
- Provider and tool diagnostics are stored, not injected raw into model-visible context.
- Focused LLMActor tests pass with fake provider/admission services.

## Slice 4: ProcessActor And Process Capabilities

Goal: make process execution durable and separately observable before terminal cards need process tools.

Implementation:

- Add `ProcessActor` with `running`, `killing`, and terminal `settled` states.
- Implement `launch(spec)`, `wait(timeout)`, `inspect(range)`, and `kill(reason)`.
- Persist process actor state transitions from `_on_state_changed(...)`; keep explicit persistence for launch metadata, stdout/stderr chunks, kill metadata, and terminal exit details.
- Start a monitoring task while `running` so process exit is recorded even when no one is waiting.
- Keep wait timeout non-destructive: timeout returns a tool result but does not kill the process.
- Persist command metadata, working directory, timestamps, rendered command, status, exit/termination details, and safe logs.
- Reconcile persisted running process records during recovery.
- Delete or replace old process runner/controller code when this actor owns process lifecycle.

Tests:

- Launch records process metadata and exposes safe projection.
- Process exit records terminal result and transitions to `settled`.
- `wait(timeout)` times out without killing the process.
- `inspect(range)` returns bounded safe output.
- `kill(reason)` terminates or marks abandoned with diagnostics.
- Recovery of a running process reconciles live process status or marks abandoned.

Acceptance:

- Process tools route through ProcessActor or a deliberately small process service used by ProcessActor.
- Process read models are available to API/UI without exposing unsafe raw output.
- Focused process actor tests pass.
- No process-runner controller bridge remains in production code.

## Slice 5: TerminalCardProcessorActor Vertical Slice

Goal: prove the full actor path with the simplest useful card execution.

Implementation:

- Implement terminal processor behavior in `TerminalCardProcessorActor`.
- Add terminal states `executing`, `waiting_process`, and parked `settled` or simpler equivalents if implementation allows.
- Implement public methods `activate(input)` and `cancel(reason)`.
- Persist terminal processor state transitions from `_on_state_changed(...)`; keep explicit persistence for activation inputs, process ids, cancellation metadata, and terminal outcomes when those fields change outside transition entry.
- Build executor invocation context from card data, notifications, and relevant project context.
- Own/cache one executor `LLMActor` for the terminal activation path.
- Provide terminal capabilities: reporting result/failure, process launch/wait/inspect/kill through `ProcessActor`, and safe file inspection if already supported.
- Validate executor terminal report before committing card result data.
- Return exactly one `done` or `failed` outcome to the associated `CardActor`.

Tests:

- Terminal card executes via executor `LLMActor` and commits accepted `done` result.
- Executor `failed` report commits failed outcome without result data.
- Invalid executor report appends tool error or fails visibly according to protocol.
- Process wait timeout returns a timeout tool result and does not kill the process.
- Explicit process kill records termination details.
- Terminal cancellation marks the card/subtree `cancelled`, stops future LLM admission, and records late results as diagnostics.

Acceptance:

- One terminal card can run end-to-end without controller workflow.
- Terminal result data is attached only from accepted executor output.
- Old terminal execution controller paths are deleted, not bypassed through adapters.

## Slice 6: Goal/Project Planner Flow

Goal: implement planner child activation and goal completion around the actor boundaries.

Implementation:

- Implement project and goal processor behavior in `ProjectCardProcessorActor` and `GoalCardProcessorActor`.
- Build planner invocation context from card tree, planning diary, pending notifications, prior reviewer findings, and direct child status.
- Own/cache planner `LLMActor` and reviewer `LLMActor` as needed.
- Build planner capabilities for direct-child activation, direct-child mutation, process tools, working status, and planner terminal reports.
- Implement `activate_card` as a synchronous logical barrier from the planner perspective.
- For child activation, call the child `CardActor.activate(...)`, wait on a parent-owned promise, then append exactly one tool result/error to the planner LLMActor.
- Enforce the completion gate: a goal cannot report `done` while executable descendants are incomplete.
- Store blocked/failed/done outcome facts before reporting to the associated CardActor.

Tests:

- Planner can activate only immediate children.
- Invalid child activation appends tool error and does not dispatch work.
- Child `done`, `failed`, and `blocked` outcomes return exactly one planner tool result.
- Changed, blocked, backlog, running, or failed descendants block parent `done`.
- `cancelled` descendants are completion-compatible.
- Planner process tools route through ProcessActor and return bounded results.
- Pending notifications are delivered before the next planner turn.

Acceptance:

- Project/goal planning can execute a child terminal card through the actor chain.
- No planner controller owns child dispatch outside processor actors/CardActor, and no planner bridge remains.

## Slice 7: Reviewer Flow

Goal: add reviewer assessment after planner reports candidate done.

Implementation:

- Run readiness and evidence gates before reviewer invocation.
- Invoke reviewer only after gates pass.
- Require structured reviewer output sufficient for control-plane decisions.
- Treat ambiguous reviewer prose as failed/invalid output, not as guessed approval.
- Store negative reviewer findings with the card and inject them into the next planner context.
- Attach positive reviewer text to the card only after the reviewed snapshot is still current.
- If relevant changes/notifications arrive while reviewing, invalidate reviewer success or divert back to planning.

Tests:

- Reviewer is not invoked until readiness/evidence gates pass.
- Reviewer approval commits reviewed done only for the assessed snapshot.
- Reviewer correction returns to planning with stored findings.
- Relevant change during review invalidates success.
- Ambiguous reviewer output fails visibly.

Acceptance:

- Goal/project `done` requires planner report, gates, and valid reviewer approval unless the card type explicitly skips review.
- Reviewer logic stays inside processor actor/LLMActor boundaries.

## Slice 8: Recovery

Goal: rebuild safe actor state from durable records after restart.

Implementation:

- Define actor reconstruction records for supervisor, cards, processors, LLM turns, process records, activation waits, and tool waits.
- Create fresh actor instances and call `BaseActor.recover(state)` where safe.
- Use `_on_recover__{state}` hooks to rebuild in-memory references from persisted reconstruction records. Recovery must not call `_on_state_changed(...)` and must not re-persist already-recorded transition snapshots unless repair logic deliberately writes a diagnostic or reconciled state.
- Reconstruct active card chains and unresolved waits.
- Reconcile running process records.
- Abandon provider calls in progress with diagnostics because they cannot be safely reattached.
- Repair tool delivery from persisted tool-call/message records.
- Fail or block explicitly when state is ambiguous.

Tests:

- Startup handles active planner waiting on child activation.
- Startup handles LLM waiting for a process tool result.
- Startup handles terminal process result awaiting delivery.
- Startup abandons in-flight provider request with planner-visible diagnostic.
- Startup handles interrupted reviewer with correction context or visible diagnostic.

Acceptance:

- Recovery never relies on in-memory queues or raw actor internals.
- Unsafe states become explicit diagnostics, not silent restarts.

## Slice 9: Cleanup

Goal: remove replaced runtime machinery.

Implementation:

- Delete XState-era factories, machine definitions, wrappers, and tests once actor coverage replaces them.
- Delete controller classes that still own runtime workflow.
- Remove imports from superseded runtime paths.
- Remove duplicated per-state `_on_enter__{state}` persistence hooks after concrete actors adopt `_on_state_changed(...)` for transition snapshots.
- Simplify actor snapshot helpers so saving one actor snapshot does not reread every actor snapshot when the caller does not need a full snapshot list.
- Keep only projection/API code that calls actor public methods or reads projections.
- Update docs to point to current actor design and remove stale implementation references from current docs.
- Remove obsolete runtime dependencies such as XState when no production import remains.

Tests:

- Static/boundary tests prove production runtime does not import removed controller/XState paths.
- Routine validation passes.

Acceptance:

- No production `*Controller` owns autonomous runtime workflow.
- No production XState runtime path remains.
- No compatibility, adapter, bridge, or legacy-contract test remains for old runtime behavior.
- Transition snapshot persistence is centralized through `_on_state_changed(...)`; per-state `_on_enter__{state}` hooks exist only for state-specific behavior.
- Obsolete runtime dependencies are removed from package manifests.
- Focused actor, API boundary, projection, and routine validation pass.

## Cross-Slice Test Matrix

- Micro-actor definition, parked state, task, timeout, cancellation, and recovery tests.
- Supervisor run/pause/resume/shutdown/cancel tests.
- CardActor activation, status commit ordering, changed state, cancellation, and notification tests.
- LLMActor provider admission, provider failure, cancellation, tool protocol, duplicate tool delivery, and diagnostics tests.
- ProcessActor launch, wait timeout, inspect, kill, exit, and recovery tests.
- Terminal processor executor/report/process tests.
- Goal/project processor child activation, planner report, completion gate, process, notification, and reviewer tests.
- RuntimeApi boundary tests proving it calls public methods and projects read models only.
- Projection tests for runtime mode, active chain, active leaf, provider/process waits, and diagnostics.
- UI smoke tests when projection contracts change.

## Open Decisions

- Completed actor-record retention: delete, archive, or bounded history.
- Whether process tools share one `ProcessActor` per process record or use direct process-service tasks for short operations.
- Whether reviewer structured output is tool-based immediately or strict JSON in the first implementation.
- Exact public projection fields for active chain and runtime activity.

These decisions should be made when their implementation slice starts, not before.
