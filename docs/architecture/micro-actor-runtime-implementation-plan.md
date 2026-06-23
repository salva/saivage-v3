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
- Runtime construction has one production path: create the supervisor/root card actor stack with the real card store and provider invocation port. Do not keep projection-only or legacy-compatible execution modes.
- Persist domain facts and reconstruction records, not in-memory queues, function closures, or actor internals.
- Delete replaced controller/XState-era code during the slice that makes it obsolete.
- Do not add adapters, bridges, shims, or compatibility tests for old runtime behavior. Tests should protect the new actor design, not legacy contracts.
- Planner, executor, and reviewer terminal reports are contract terminal tools, not free-form prose or ad-hoc JSON messages. Processor actors validate terminal tool payloads through the role contract before committing card outcomes.
- Use inheritance only for stable mechanics. `BaseCardProcessorActor` owns processor activation/settlement/persistence mechanics; `BaseMainLLMCardProcessorActor` owns main-agent LLM loop mechanics. Planner, reviewer, executor, and card-type policy belong in concrete subclasses.

## Slice 1: RuntimeApi Boundary And Supervisor Shell

Goal: make the runtime entry point actor-centered before changing card execution.

Implementation:

- Replace the existing supervisor/controller shell with a new `RuntimeSupervisorActor`; do not adapt `RuntimeSupervisorController` as a bridge.
- Add states `idle`, `running`, `paused`, and `shutting_down`.
- Implement public methods `run()`, `pause()`, `shutdown()`, and `cancelProject()`.
- Persist supervisor state transitions from `_on_state_changed(...)`; keep explicit persistence for non-transition context changes such as provider admission/release fields or initialization data.
- Implement `cancelProject()` with the same two-path cancellation semantics as `CardActor`: inactive project work is cancelled immediately, while running project work receives a best-effort cancellation notification and remains under normal runtime flow.
- Keep duplicate `run()` simple: if already running, return an already-running warning and do not create new work.
- Keep the existing public `RuntimeApi` surface where operators/tools already call it, but replace the implementation so it constructs or attaches to the supervisor and calls only supervisor/card public methods.
- `RuntimeApi` must always run through the actor stack. It may start the root `CardActor` and wait on projections or the root activation promise, but it must not have an alternate path that only fabricates runtime records without actor execution.
- Move runtime mode projection into projection/read-model code.
- Delete any `RuntimeApi` path that branches over planner/executor/reviewer workflow directly once replacement is in place.

Tests:

- Supervisor starts idle work from `idle`.
- `run()` from `running` returns already-running and creates no duplicate root work.
- `pause()` closes admission and does not mutate card status.
- `run()` from `paused` resumes admission.
- `shutdown()` transitions through shutdown and returns to `idle` with diagnostics.
- RuntimeApi boundary test proves it starts only the supervisor/root card actor path and does not branch over child workflow phases.
- No `RuntimeSupervisorController` compatibility wrapper remains.

Acceptance:

- Public runtime mode projections show idle/running/paused/shutting-down truthfully.
- No optional projection-only runtime execution path remains.
- No lower-level planner/executor/reviewer workflow branch is run by `RuntimeApi`.
- Focused supervisor/API tests pass.

## Slice 2: CardActor Lifecycle Boundary

Goal: centralize public card lifecycle state in `CardActor`.

Implementation:

- Add `CardActor` with public states `backlog`, `changed`, `running`, `blocked`, `failed`, `done`, and `cancelled`.
- Mark inactive reactivatable states as parked and `cancelled` as terminal.
- Implement public methods `activate(caller)`, `notify(notification)`, `cancel(reason)`, and `markChanged(change)`.
- Persist card actor state transitions from `_on_state_changed(...)` and remove empty `_on_enter__{state}` hooks that only save snapshots.
- Keep explicit persistence for card context changes that do not transition state, including queued notifications, change metadata, inactive-cancellation writes, and accepted activation outcomes.
- Persist public card status changes through the canonical card store before reporting outcomes upward.
- Implement cancellation as two paths: inactive cards/subtrees are marked `cancelled` immediately, while running cards only receive a best-effort cancellation notification downstream and remain `running`.
- Do not use running cancellation to close provider admission, abort active tools, kill processes, or reinterpret later agent reports. Those are shutdown or process-control responsibilities, not best-effort cancellation behavior.
- Keep notification queue ownership in `CardActor`. Provide card/processor-facing methods to check pending notifications, drain notifications deliverable to the main agent, and record delivery markers after those notifications are appended to the next model-visible turn.
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
- `cancel(...)` marks inactive cards/subtrees `cancelled`, preserves descendants already `done`, and enqueues best-effort cancellation notifications for running cards without changing their status.
- Running-card cancellation tests prove the card stays `running`, downstream notification is queued, and no provider/process/tool hard-cancel side effect is triggered.
- `_on_state_changed(...)` records card actor state transitions, while `recover(...)` does not emit a new transition snapshot.

Acceptance:

- Card status writes are centralized through `CardActor`/canonical card service.
- One active chain can be represented by `running` CardActors.
- No controller code mutates running card status outside the actor/canonical service path.

## Slice 3: Generic LLMActor

Goal: isolate provider calls and tool-call loop mechanics from planner/executor/reviewer semantics.

Implementation:

- Add `LLMActor` with states needed by implementation, starting from `idle`, `requesting_admission`, `calling_provider`, and `waiting_tool` unless implementation proves a simpler table.
- Implement public methods `turn(inputRef)`, `appendToolResult(toolCallId, result)`, and `appendToolError(toolCallId, error)`.
- Persist LLM actor state transitions from `_on_state_changed(...)`; keep explicit persistence for input, outcome, waiting-tool, and delivered-tool fields that change outside a state transition.
- Keep `LLMActor` generic and queue-free. It receives notification content only through `LlmInvocationInput` prepared by the owning processor.
- Persist model-visible input context before provider calls.
- Request provider admission through the parent processor actor and supervisor policy; paused processors do not request new LLM turns.
- Persist provider responses before interpretation by the owner.
- Persist assistant tool calls before routing them.
- Enforce exactly one tool result or tool error per tool call.
- Return raw provider outcome/tool-call facts to the parent processor through hard-coded methods.
- Fail fast on unsupported provider output such as multiple parallel tool calls until a deliberate protocol is implemented.
- Keep terminal-report tool calls generic at the `LLMActor` boundary. `LLMActor` persists and returns them like any other tool call; the owning processor decides whether a tool call is a terminal report, validates the contract payload, and settles the card.

Tests:

- `turn(...)` persists invocation context before provider call.
- A paused processor does not request a new LLM turn, so no provider call starts while paused.
- Provider failure returns a failed LLM outcome to the parent processor.
- Tool calls are persisted before routing.
- `appendToolResult(...)` and `appendToolError(...)` continue from `waiting_tool`.
- Duplicate tool result/error for the same tool call is rejected.
- Notification-bearing turns include processor-supplied notification context without `LLMActor` owning or mutating card notification queues.
- Terminal-report tool calls are returned to the owning processor without role-specific interpretation inside `LLMActor`.

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

- Add `BaseCardProcessorActor` before adding or refactoring concrete processors. It owns the shared processor states `idle`, `running`, `settled`, and `cancelled`; public `activate(input)` and `cancel(reason)`; pending activation promise handling; `settle(outcome)`; `_on_state_changed(...)` persistence; and common snapshot fields. It must not know planner, reviewer, executor, process-tool, or card-type policy.
- Add `BaseMainLLMCardProcessorActor` for processors whose main card agent is one LLM session. It owns/caches the main `LLMActor`, runs the main turn loop, injects owning-card notifications before each main-agent provider turn, records delivery markers, and provides hook methods for concrete tool routing and terminal-report handling. It must not decide role-specific semantics.
- Implement terminal processor behavior in `TerminalCardProcessorActor`.
- Make `TerminalCardProcessorActor` extend `BaseMainLLMCardProcessorActor`.
- Represent terminal-specific phases such as `executing` and `waiting_process` on processor fields unless a distinct state is needed for task ownership; keep the shared top-level processor states in `BaseCardProcessorActor`.
- Implement public methods `activate(input)` and `cancel(reason)`.
- Persist terminal processor state transitions from `_on_state_changed(...)`; keep explicit persistence for activation inputs, process ids, queued cancellation notifications, and terminal outcomes when those fields change outside transition entry.
- Build executor invocation context from card data, notifications, and relevant project context.
- Own/cache one executor `LLMActor` for the terminal activation path.
- Provide terminal capabilities: reporting result/failure, process launch/wait/inspect/kill through `ProcessActor`, and safe file inspection if already supported.
- Offer the executor contract terminal tool and validate accepted executor terminal reports through that contract before committing card result data. Do not accept free-form executor prose or ad-hoc JSON as a terminal card result.
- Return exactly one `done` or `failed` outcome to the associated `CardActor`.

Tests:

- Terminal card executes via executor `LLMActor` and commits accepted `done` result.
- Executor `failed` report commits failed outcome without result data.
- Invalid executor report appends tool error or fails visibly according to protocol.
- Free-form executor messages do not commit terminal card outcomes.
- Process wait timeout returns a timeout tool result and does not kill the process.
- Explicit process kill records termination details.
- Terminal cancellation while inactive marks the card/subtree `cancelled`; terminal cancellation while running is a best-effort notification to the executor and does not stop future LLM admission, kill processes, or rewrite later executor reports.
- Base processor tests prove activation, cancellation, settlement, parent promise resolution, and transition snapshot persistence are shared and not duplicated in concrete processors.

Acceptance:

- One terminal card can run end-to-end without controller workflow.
- Terminal result data is attached only from accepted executor output.
- Common processor mechanics live in the base classes; terminal-specific code contains executor/process semantics only.
- Old terminal execution controller paths are deleted, not bypassed through adapters.

## Slice 6: Goal/Project Planner Flow

Goal: implement planner child activation and goal completion around the actor boundaries.

Implementation:

- Implement project and goal processor behavior in `PlanningCardProcessorActor`, extending `BaseMainLLMCardProcessorActor`.
- Add `ProjectCardProcessorActor` and `GoalCardProcessorActor` only as thin subclasses when project and goal behavior truly diverges; otherwise use `PlanningCardProcessorActor` directly.
- Build planner invocation context from card tree, planning diary, pending notifications, prior reviewer findings, and direct child status.
- Own/cache the planner `LLMActor`; own the reviewer invocation as a phase of the same project/goal processor rather than as a separate card processor.
- Give the project/goal processor access to its owning `CardActor` so it can inspect/drain deliverable main-agent notifications before activation and before every subsequent planner provider turn; record delivery markers after successful append.
- Best-effort cancellation of a running project/goal is delivered through the same notification path and does not alter planner admission, child activation, process tools, or later planner reports by itself.
- Build planner capabilities for direct-child activation, direct-child mutation, process tools, working status, and the planner contract terminal report tool. Do not accept free-form planner prose or ad-hoc JSON as a terminal planner report.
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
- Best-effort cancellation notification is delivered before the next planner turn and does not otherwise change planner control flow.
- Planner terminal reports are accepted only through the planner contract terminal tool.
- Project/goal subclass tests, if any, cover only real overridden behavior and do not duplicate base or shared planning behavior.

Acceptance:

- Project/goal planning can execute a child terminal card through the actor chain, continue the same planner session after the child result, and receive newly queued notifications before the next provider call.
- Shared planner behavior is implemented once in `PlanningCardProcessorActor`.
- No planner controller owns child dispatch outside processor actors/CardActor, and no planner bridge remains.

## Slice 7: Reviewer Flow

Goal: add reviewer assessment after planner reports candidate done.

Implementation:

- Run readiness and evidence gates inside the same project/goal processor after the planner contract terminal report proposes `done`.
- Invoke reviewer only after gates pass; the reviewer is a phase owned by the project/goal processor, not a standalone card processor that can independently settle the card.
- Require reviewer output through the reviewer contract terminal tool. Do not accept ambiguous reviewer prose or ad-hoc JSON as a reviewer assessment.
- Treat ambiguous reviewer prose as failed/invalid output, not as guessed approval.
- Store negative reviewer findings with the card and inject them into the next planner context.
- Attach positive reviewer text to the card only after the reviewed snapshot is still current.
- If relevant changes/notifications arrive while reviewing, invalidate reviewer success or divert back to planning.
- Cancellation notifications are main-agent notifications. If one arrives while reviewer work is active, hold it with other pending main-agent notifications until planner ownership resumes; do not deliver cancellation to the reviewer unless a separate reviewer-cancellation feature is explicitly designed.

Tests:

- Reviewer is not invoked until readiness/evidence gates pass.
- Reviewer approval commits reviewed done only for the assessed snapshot.
- Reviewer correction returns to planning with stored findings.
- Reviewer terminal reports are accepted only through the reviewer contract terminal tool.
- Relevant change during review invalidates success.
- Cancellation notification during review is held for planner delivery and does not by itself invalidate reviewer success unless paired with a real card/tree change.
- Ambiguous reviewer output fails visibly.

Acceptance:

- Goal/project `done` requires planner report, gates, and valid reviewer approval unless the card type explicitly skips review.
- Reviewer logic stays inside processor actor/LLMActor boundaries.
- No standalone reviewer card processor is required for the normal project/goal flow.

## Slice 8: Recovery

Goal: rebuild safe actor state from durable records after restart.

Implementation:

- Define actor reconstruction records for supervisor, cards, processors, LLM turns, process records, activation waits, and tool waits.
- Create fresh actor instances and call `BaseActor.recover(state)` where safe.
- Use `_on_recover__{state}` hooks to rebuild in-memory references from persisted reconstruction records. Recovery must not call `_on_state_changed(...)` and must not re-persist already-recorded transition snapshots unless repair logic deliberately writes a diagnostic or reconciled state.
- Reconstruct active card chains and unresolved waits.
- Consume the recovery plan during runtime startup. A recovery plan that is only computed and exposed is incomplete.
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
- Startup either reconstructs recoverable active actor chains or records explicit blocked/failed diagnostics for abandoned work.

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
- Static/boundary tests prove production runtime does not import removed controller/XState paths and that public actor barrels do not export legacy runner/controller modules.
- Routine validation passes.

Acceptance:

- No production `*Controller` owns autonomous runtime workflow.
- No production XState runtime path remains.
- No compatibility, adapter, bridge, or legacy-contract test remains for old runtime behavior.
- No `XSTATE_*` implementation names remain in current runtime code.
- Concrete processor classes do not duplicate activation, settlement, cancellation, main LLM loop, or notification-delivery mechanics already owned by the base classes.
- Transition snapshot persistence is centralized through `_on_state_changed(...)`; per-state `_on_enter__{state}` hooks exist only for state-specific behavior.
- Obsolete runtime dependencies are removed from package manifests.
- Focused actor, API boundary, projection, and routine validation pass.

## Cross-Slice Test Matrix

- Micro-actor definition, parked state, task, timeout, cancellation, and recovery tests.
- Supervisor run/pause/resume/shutdown/cancel tests.
- CardActor activation, status commit ordering, changed state, cancellation, and notification tests.
- BaseCardProcessorActor and BaseMainLLMCardProcessorActor mechanical tests.
- LLMActor provider admission, provider failure, tool protocol, duplicate tool delivery, and diagnostics tests.
- ProcessActor launch, wait timeout, inspect, kill, exit, and recovery tests.
- Terminal processor executor/report/process tests.
- Goal/project processor child activation, planner report, completion gate, process, notification, and reviewer tests.
- Contract-terminal tests for planner, executor, and reviewer reports.
- RuntimeApi boundary tests proving it calls public methods and projects read models only.
- Projection tests for runtime mode, active chain, active leaf, provider/process waits, and diagnostics.
- UI smoke tests when projection contracts change.

## Open Decisions

- Completed actor-record retention: delete, archive, or bounded history.
- Whether process tools share one `ProcessActor` per process record or use direct process-service tasks for short operations.
- Exact public projection fields for active chain and runtime activity.

These decisions should be made when their implementation slice starts, not before.
