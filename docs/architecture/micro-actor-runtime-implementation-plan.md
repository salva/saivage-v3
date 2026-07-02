# Micro-Actor Runtime Implementation Plan

Status: complete for the current micro-actor runtime replacement.

Date: 2026-06-24.

## Current Status

The core micro-actor runtime replacement has landed:

- `RuntimeApi` now uses the actor execution path and no longer has a projection-only startup branch.
- Legacy actor runner/XState runtime paths and the `xstate` package dependency have been removed.
- `CardActor`, `LLMActor`, `ProcessActor`, processor base classes, `TerminalCardProcessorActor`, and `PlanningCardProcessorActor` are the active runtime path.
- Planner, executor, and reviewer reports are accepted only through role contract terminal tools.
- Card-owned notifications are delivered per LLM turn with durable delivery markers; `LLMActor` remains queue-free.
- Reviewer execution is a phase of `PlanningCardProcessorActor`; the standalone reviewer card processor was removed.
- Recovery startup records explicit active reconstruction facts in actor snapshots, projects safe persisted terminal tool-call outcomes, converts known interrupted running card work into blocked card outcomes, cleans handled snapshots, then rewrites sanitized diagnostics so `actorRuntime.recovery` shows only outstanding recovery work.

## Future Choices

The actor runtime plan is complete. The following are future product/architecture choices, not unfinished compatibility work:

1. If mid-flight resume becomes a concrete requirement, design it as new actor-owned reconstruction entrypoints. Do not add adapters around in-memory promises, provider calls, or process handles.
2. If auto-reactivation after restart becomes desirable, replace the conservative block-on-restart policy deliberately rather than layering a bridge over current recovery.
3. Broader release validation should run when release criteria or affected surfaces change; the current focused, routine, UI, and release profiles have passed after the recovery and cleanup slices.

The detailed recovery work and simplification direction is tracked in [Slice 8: Recovery](#slice-8-recovery).

## Confirmed Follow-Up Corrections

The post-implementation review found a few real issues that should be fixed before expanding recovery. These are not reasons to reintroduce controller workflows or compatibility layers; they are small corrections to keep the actor design clean.

Completed post-review fixes:

- Candidate-review self-citation is rejected unless backed by durable evidence outside the reviewed card candidate result.
- Running cancellation is notification-only; processor cancellation states and processor `cancel(...)` APIs were removed from the normal path.
- Notification delivery uses the card-owned `deliverNotificationsForInput(inputId)` contract, and done cards with leftover notifications reopen as `changed` so pending context is not stranded.
- Non-terminal planner `activate_card` argument failures are returned as recoverable tool results instead of crashing activation.
- Dead actor APIs/options such as untracked notification drain/record methods, production-dead `LLMActor.appendToolError`, and unused runtime construction inputs were removed.
- Notification delivery markers and terminal processor process actor records are bounded/compacted.
- Actor runtime read-model state names are aligned with current actor states.
- Reviewer approval is invalidated when main-agent notifications remain pending after the reviewer turn; reviewer turns do not drain main-agent notification queues.
- Startup converts known interrupted running card work into explicit blocked card outcomes when the owner card and transition are valid.
- Safe parked-state recovery hooks avoid normal-entry side effects where needed.
- Terminal tool-call recovery projects safe executor terminal outcomes, planner `blocked`/`failed` outcomes, and planner `done` outcomes paired with matching persisted reviewer terminal results.
- Completed child activation waits are handled by the generic interrupted-work conversion path rather than a dedicated special case; stale pending tool calls are abandoned after converted snapshots are cleaned.
- Startup recovery now uses a single initial recovery plan, projects safe terminal outcomes first, blocks remaining active card work including `block_tool_wait` actors, cleans handled snapshots once, and then abandons stale pending tool calls.
- Recovery diagnostics are rebuilt after handled snapshot cleanup, so `.saivage/runtime/recovery-diagnostics.json` and `actorRuntime.recovery` report only currently outstanding recovery work.
- The concrete `SupervisorRuntimeApi.getRecoveryPlan()` test seam and dead old-runtime assembly/stuck-supervisor files were removed.
- Full Jest, focused actor suites, routine validation, and current operator-facing spec updates have been run after the recovery slices landed.

Remaining priority fixes:

- Keep terminal contract handling simple and fail-fast unless a concrete repair requirement exists. Do not add a general terminal-output repair loop just because it is possible.
- Remove any newly discovered dead options, duplicated types/helpers, or production-dead LLM/processor APIs as they appear.

Deferred or optional improvements:

- A one-turn terminal contract repair loop may be added later if model behavior proves it is needed. Until then, explicit failure on invalid terminal tools is simpler and easier to reason about.
- Parallel provider tool calls remain unsupported by design. Keep the one-tool-call invariant until a full protocol is designed.

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
- Keep notification queue ownership in `CardActor`. Provide one processor-facing delivery method that atomically drains notifications for a specific model input id and records delivery markers. Do not keep separate untracked drain/record methods unless a production caller needs them.
- Instantiate or reconnect direct child `CardActor` instances from card data.
- Instantiate or reconnect the associated processor actor for the card type.
- Use `BaseActor.recover(state)` when reconnecting a fresh actor instance to an existing durable card state.
- In `running`, call the processor's `activate(input)` method and wait on a parent-owned promise.
- Call hard-coded parent completion methods when activation outcomes are committed.
- Keep running-card change handling simple: running cards stay `running` and receive notification/context.
- On activation settlement, handle leftover queued notifications explicitly. The simplest acceptable behavior is a diagnostic or durable marker showing notifications were not delivered before the terminal outcome; do not silently discard or indefinitely hide them.

Tests:

- Activatable statuses are `backlog`, `changed`, `blocked`, and `failed`.
- `activate(...)` rejects non-child or not-ready activation.
- Activation transitions to `running` and starts the processor.
- Processor `done`, `failed`, and `blocked` outcomes update card state before parent notification.
- `markChanged(...)` moves inactive cards to `changed` and leaves running cards `running`.
- `cancel(...)` marks inactive cards/subtrees `cancelled`, preserves descendants already `done`, and enqueues best-effort cancellation notifications for running cards without changing their status.
- Running-card cancellation tests prove the card stays `running`, downstream notification is queued, and no provider/process/tool hard-cancel side effect is triggered.
- Running-card cancellation tests prove the cancellation notification reaches a later model-visible turn when one exists, or is recorded as leftover/undelivered when the activation settles before another turn.
- `_on_state_changed(...)` records card actor state transitions, while `recover(...)` does not emit a new transition snapshot.

Acceptance:

- Card status writes are centralized through `CardActor`/canonical card service.
- One active chain can be represented by `running` CardActors.
- No controller code mutates running card status outside the actor/canonical service path.

## Slice 3: Generic LLMActor

Goal: isolate provider calls and tool-call loop mechanics from planner/executor/reviewer semantics.

Implementation:

- Add `LLMActor` with states needed by implementation, starting from `idle`, `requesting_admission`, `calling_provider`, and `waiting_tool` unless implementation proves a simpler table.
- Implement public methods needed by production call sites. `turn(inputRef)` and `appendToolResult(toolCallId, result, continuationContext)` are required. Keep `appendToolError(...)` only if a production caller uses a distinct tool-error protocol; otherwise deliver structured tool errors through `appendToolResult(...)` and delete the unused method.
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
- `appendToolResult(...)` continues from `waiting_tool`; any retained `appendToolError(...)` path has production coverage.
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
- Recovery abandons persisted `running`/`killing` process records with sanitized diagnostics by default. Do not add live process/PID reconciliation unless preserving in-flight process results becomes a concrete requirement.
- Delete or replace old process runner/controller code when this actor owns process lifecycle.

Tests:

- Launch records process metadata and exposes safe projection.
- Process exit records terminal result and transitions to `settled`.
- `wait(timeout)` times out without killing the process.
- `inspect(range)` returns bounded safe output.
- `kill(reason)` terminates or marks abandoned with diagnostics.
- Recovery of a running/killing process marks it abandoned with diagnostics; live process reattachment is deferred unless explicitly required.

Acceptance:

- Process tools route through ProcessActor or a deliberately small process service used by ProcessActor.
- Process read models are available to API/UI without exposing unsafe raw output.
- Focused process actor tests pass.
- No process-runner controller bridge remains in production code.

## Slice 5: TerminalCardProcessorActor Vertical Slice

Goal: prove the full actor path with the simplest useful card execution.

Implementation:

- Add `BaseCardProcessorActor` before adding or refactoring concrete processors. It owns the shared processor states, public `activate(input)`, pending activation promise handling, settlement, `_on_state_changed(...)` persistence, and common snapshot fields. It must not know planner, reviewer, executor, process-tool, or card-type policy. Processor-level `cancel(...)` and `cancelled` states are intentionally absent from the normal running-cancel path; running cancellation is delivered as card-owned notification context.
- Add `BaseMainLLMCardProcessorActor` for processors whose main card agent is one LLM session. It creates the main `LLMActor` for the current invocation flow, runs the main turn loop, injects owning-card notifications before each main-agent provider turn, records delivery markers, and provides hook methods for concrete tool routing and terminal-report handling. It must not decide role-specific semantics.
- Implement terminal processor behavior in `TerminalCardProcessorActor`.
- Make `TerminalCardProcessorActor` extend `BaseMainLLMCardProcessorActor`.
- Represent terminal-specific phases such as `executing` and `waiting_process` on processor fields unless a distinct state is needed for task ownership; keep the shared top-level processor states in `BaseCardProcessorActor`.
- Implement public `activate(input)`. Do not add processor `cancel(reason)` unless a separate shutdown/force-cancel feature is deliberately designed.
- Persist terminal processor state transitions from `_on_state_changed(...)`; keep explicit persistence for activation inputs, process ids, and terminal outcomes when those fields change outside transition entry. Queued cancellation notifications remain owned by `CardActor`, not by processors.
- Build executor invocation context from card data, notifications, and relevant project context.
- Own one executor `LLMActor` for the terminal activation path; do not reuse it across activations until `LLMActor` has an explicit terminal-settlement API.
- Provide terminal capabilities: reporting result/failure, process launch/wait/inspect/kill through `ProcessActor`, and safe file inspection if already supported.
- Offer the executor contract terminal tool and validate accepted executor terminal reports through that contract before committing card result data. Do not accept free-form executor prose or ad-hoc JSON as a terminal card result.
- Return exactly one `done` or `failed` outcome to the associated `CardActor`.
- Clean up or archive terminal processor child `ProcessActor` references after the activation no longer needs them. Long-lived processor instances must not accumulate completed process actors indefinitely.

Tests:

- Terminal card executes via executor `LLMActor` and commits accepted `done` result.
- Executor `failed` report commits failed outcome without result data.
- Invalid executor report appends tool error or fails visibly according to protocol.
- Free-form executor messages do not commit terminal card outcomes.
- Process wait timeout returns a timeout tool result and does not kill the process.
- Explicit process kill records termination details.
- Completed/killed process actors do not leak indefinitely through the terminal processor's process map.
- Terminal cancellation while inactive marks the card/subtree `cancelled`; terminal cancellation while running is a best-effort card notification to the executor and does not stop future LLM admission, kill processes, or rewrite later executor reports.
- Base processor tests prove activation, settlement, parent promise resolution, and transition snapshot persistence are shared and not duplicated in concrete processors.

Acceptance:

- One terminal card can run end-to-end without controller workflow.
- Terminal result data is attached only from accepted executor output.
- Common processor mechanics live in the base classes; terminal-specific code contains executor/process semantics only.
- Old terminal execution controller paths are deleted, not bypassed through adapters.

## Slice 6: Goal/Project Planner Flow

Goal: implement planner child activation and goal completion around the actor boundaries.

Implementation:

- Implement project and goal processor behavior in `PlanningCardProcessorActor`, extending `BaseMainLLMCardProcessorActor`.
- Use `PlanningCardProcessorActor` directly for both project and goal cards unless their behavior truly diverges.
- Build planner invocation context from card tree, pending notifications, prior reviewer findings, and direct child status.
- Own the planner `LLMActor` for the current activation; own the reviewer invocation as a phase of the same project/goal processor rather than as a separate card processor. Do not reuse LLM actors across activations until `LLMActor` has an explicit terminal-settlement API.
- Give the project/goal processor access to its owning `CardActor` so it can inspect/drain deliverable main-agent notifications before activation and before every subsequent planner provider turn; record delivery markers after successful append.
- Best-effort cancellation of a running project/goal is delivered through the same notification path and does not alter planner admission, child activation, process tools, or later planner reports by itself.
- Build planner capabilities for direct-child activation, direct-child mutation, process tools, working status, and the planner contract terminal report tool. Do not accept free-form planner prose or ad-hoc JSON as a terminal planner report.
- Implement `activate_card` as a synchronous logical barrier from the planner perspective.
- For child activation, call the child `CardActor.activate(...)`, wait on a parent-owned promise, then append exactly one tool result/error to the planner LLMActor.
- Treat invalid non-terminal planner tool arguments as recoverable tool results. Bad `activate_card` arguments, missing children, non-immediate descendants, and missing child actors should not throw out of the activation loop.
- Enforce the completion gate: a goal cannot report `done` while executable descendants are incomplete.
- Store blocked/failed/done outcome facts before reporting to the associated CardActor.

Tests:

- Planner can activate only immediate children.
- Invalid child activation appends tool error and does not dispatch work.
- Malformed `activate_card` arguments append a tool error/result and do not fail the whole planner activation unless the planner exhausts its turn budget.
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

Current status: implemented for the current actor path. Reviewer execution is planner-owned and contract-terminal-only, self-citation without durable evidence is rejected, corrections return a blocked planner outcome, and pending main-agent notifications invalidate reviewer approval instead of being drained into reviewer context.

Implementation:

- Run readiness and evidence gates inside the same project/goal processor after the planner contract terminal report proposes `done`.
- Invoke reviewer only after gates pass; the reviewer is a phase owned by the project/goal processor, not a standalone card processor that can independently settle the card.
- Require reviewer output through the reviewer contract terminal tool. Do not accept ambiguous reviewer prose or ad-hoc JSON as a reviewer assessment.
- Treat ambiguous reviewer prose as failed/invalid output, not as guessed approval.
- Review the candidate planner result directly. Do not validate reviewer evidence by fabricating a committed done card through an inline fake store. If the reviewer may cite the reviewed card itself, define that as an explicit evidence rule and require durable evidence on that card; otherwise reject self-citation and require done descendant evidence.
- Store negative reviewer findings with the card and inject them into the next planner context.
- Attach positive reviewer text to the card only after the reviewed snapshot is still current.
- If relevant changes/notifications arrive while reviewing, invalidate reviewer success or divert back to planning.
- Cancellation notifications are main-agent notifications. If one arrives while reviewer work is active, hold it with other pending main-agent notifications until planner ownership resumes or record it as undelivered if the activation settles first; do not deliver cancellation to the reviewer unless a separate reviewer-cancellation feature is explicitly designed.

No remaining implementation work for this slice. Add focused tests only if new reviewer currentness cases appear during active recovery reconstruction.

Tests:

- Reviewer is not invoked until readiness/evidence gates pass.
- Reviewer approval commits reviewed done only for the assessed snapshot.
- Reviewer approval cannot be based solely on the reviewed card citing its own uncommitted candidate result.
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

Current status: implemented for the current conservative recovery policy. Startup builds one initial `ActorRecoveryPlan`, projects safe persisted terminal tool-call outcomes, converts all remaining active card work into blocked outcomes, cleans handled snapshots once, removes abandoned process snapshots, abandons stale pending tool calls, then rebuilds the recovery plan and writes sanitized diagnostics/actions to `.saivage/runtime/recovery-diagnostics.json` for any still-outstanding recovery work. Mid-flight active-chain resume is not part of this policy; it requires a later explicit actor-owned reconstruction design.

Completed:

- Recovery plan construction classifies supervisor, card, LLM, processor, and process snapshots.
- In-flight provider calls are classified for abandonment.
- Waiting-tool, active processor, active card, and running process states are surfaced as recovery actions/diagnostics.
- Ambiguous active card states, active LLM states without concrete recovery actions, and stranded active cards are surfaced as human-readable diagnostics.
- Persisted running/killing process snapshots use the default `abandon_running_process` recovery action instead of implying live process reconciliation.
- Startup persists sanitized outstanding recovery diagnostics without including actor snapshot context payloads.
- Persisted recovery diagnostics are versioned with `schema_version: 1`.
- Discarded non-idle supervisor snapshots are surfaced as human-readable diagnostics and actions.
- Clean startup recovery clears stale `.saivage/runtime/recovery-diagnostics.json` files.
- `actorRuntime.recovery` projects sanitized outstanding recovery diagnostics through the runtime status read model/API contract.
- Startup removes handled abandoned running/killing process snapshots before rewriting recovery diagnostics, so the same process abandonment is not reported on every restart.
- Startup converts known interrupted running card work to explicit blocked card outcomes when the owning card is still `running`.
- Startup removes converted card, LLM, and processor snapshots after committing card outcomes and before rewriting diagnostics, so handled interrupted work is not reported on every restart.
- `CardActor` recovery to `done` does not run normal `done` entry side effects that reopen cards with pending notifications.
- Card, processor, and LLM snapshots persist explicit `active_reconstruction` records for active card activation, processor activation, provider calls, and LLM tool waits.
- Recovery planning exposes active reconstruction records and derives card/LLM/processor active status from those records rather than public-status or state-name heuristics.
- Startup projects persisted terminal tool calls for safe executor terminal outcomes, planner `blocked`/`failed` outcomes, and planner `done` outcomes paired with a matching persisted reviewer terminal result before broad interrupted-work conversion.
- Projected terminal tool calls are marked `terminal_projected`, so stale pending tool-call cleanup does not abandon already-recovered terminal decisions.
- Startup refuses planner `done` projection unless reviewer reconstruction identity, reviewer terminal output, and descendant readiness are all available from durable records.
- Startup handles completed child `activate_card` waits through generic interrupted-work conversion instead of a dedicated child-activation recovery function.
- Startup recovery is a single-pass plan consumption path: project terminal outcomes, block remaining active card work, clean handled snapshots once, remove handled process snapshots, abandon stale pending tool calls, then rebuild and persist the outstanding recovery plan.
- Nonterminal `block_tool_wait` LLM actors participate in generic blocked conversion. `LlmRecoveryDiagnosticAction` and `llmRecoveryDiagnosticAction` are diagnostic-label producers only; they do not drive recovery control flow.
- Recovery diagnostics are outstanding-only after cleanup. Handled interrupted work clears from `.saivage/runtime/recovery-diagnostics.json` and `actorRuntime.recovery` during the same startup.

### Deferred simplification direction

The recovery pipeline no longer rebuilds recovery plans between special-case passes, and the child-activation special case has been removed. It rebuilds once after cleanup to publish the outstanding-only diagnostics contract. Two broader simplifications remain deferred because they are larger boundary decisions, not prerequisites for the current clean actor path.

Deferred options:

- **Eager terminal commit.** `recoverProjectedTerminalToolOutcomes` still recomputes card outcomes from logged terminal tool-call args on restart. Eager commit would move this into the normal path, but the current clean boundary is that `CardActor` owns the single durable lifecycle commit. Do not add eager commit unless that boundary is deliberately refactored without duplicate commit paths.
- **Discard-snapshots-on-reactivate.** Restart is normal for an autonomous agent, and re-activation from card-store state may eventually be better than block-on-restart. Keep the current conservative blocked conversion until an explicit auto-reactivation policy is designed.

Do not add adapters or bridge commit paths to get eager commit quickly. If eager commit is pursued, refactor the normal actor path so `CardActor` still owns exactly one lifecycle commit operation.

Future policy choices:

- Implement genuine mid-flight resume only if it becomes a concrete requirement. Re-attachable provider calls, process waits, child activation waits, and reviewer/planner correction context must be designed as actor-owned reconstruction, not compatibility shims.
- Keep diagnostics for truly orphaned state, including ambiguous card states, stranded active cards, and discarded non-idle supervisor snapshots, regardless of future policy choices.

Implementation:

- Keep startup recovery as one pass over the initial recovery plan: project safe terminal outcomes from waiting-tool LLM records first, then generically block all remaining active card work (including `block_tool_wait` actors), clean handled snapshots once, then abandon stale tool calls once. Projection and conversion share the same plan; projected cards are excluded from conversion candidates. Rebuild the plan only after cleanup to publish outstanding-only diagnostics.
- Keep recovery diagnostics as the outstanding-recovery report, not a startup findings report. Do not silently mix both semantics in the same projection.
- Keep recovery-side terminal projection until a deliberate `CardActor`-owned eager commit refactor exists.
- Keep block-on-restart until a deliberate discard-and-reactivate runtime policy exists. Keep diagnostics for truly orphaned state either way.
- Abandon persisted running/killing process records and in-flight provider calls with diagnostics by default. Reconcile live processes or re-attach provider calls only if a later slice explicitly chooses that more complex path.
- Implement genuine mid-flight resume only after it is explicitly required and only where durable records are complete enough. Do not double-deliver tool results or duplicate provider turns.
- Fail or block explicitly when state is ambiguous, and clean up/reconcile stale actor snapshots after the ambiguity is handled.

Tests:

- Actor runtime read-model tests recognize current supervisor, card, LLM, processor, and process actor states without exposing raw state values.
- Startup converts known unrecoverable active work to explicit blocked card outcomes when the owning card is still `running`. Conversion always emits `blocked`; `failed` outcomes come only from terminal projection, not from generic conversion.
- Startup projects persisted terminal tool calls only when active card, processor, LLM reconstruction records, reviewer reconstruction records where required, and matching logged tool-call messages all agree.
- Safe parked-state recovery hooks hydrate actor fields without triggering `_on_state_changed(...)` transition snapshot writes.
- Generic blocked conversion covers planner `activate_card` waits and all other nonterminal `waiting_tool` states; there is no distinct child-activation or process-tool-wait recovery path.
- Generic blocked conversion covers LLM waiting for a process tool result and terminal process result awaiting delivery; these have no distinct recovery handling and are blocked like any other interrupted wait.
- Startup abandons in-flight provider requests with operator/runtime-visible diagnostics projected through `actorRuntime.recovery`.
- Startup handles terminal interrupted reviewer/planner completion with correction/pass context. Nonterminal reviewer interruptions fall under generic blocked conversion with diagnostics.
- Startup persists sanitized recovery diagnostics for any active snapshot that remains outstanding after handled cleanup.
- Startup diagnostics cover unknown active LLM states, active cards without active owner records, and discarded non-idle supervisor snapshots that remain outstanding after cleanup. Handled running process abandonment clears from diagnostics in the same startup.
- Recovery diagnostics read-model tests prove the runtime status projection remains sanitized and stale diagnostics are cleared after clean recovery.
- Recovery cleanup tests prove handled abandoned process snapshots are removed before outstanding-only diagnostics are rewritten.
- Recovery tests prove `recover(...)` hooks do not trigger transition snapshot writes through `_on_state_changed(...)`.
- Recovery tests prove handled snapshots are removed or reconciled so the same recovery work is not reported again after restart.

Acceptance:

- Recovery never relies on in-memory queues or raw actor internals.
- Unsafe states become explicit diagnostics, not silent restarts.
- Startup either reconstructs recoverable active actor chains or records explicit blocked diagnostics for abandoned work.
- Recovery diagnostics do not include provider payloads, auth data, prompts, raw snapshot context, or other secret-bearing fields.

## Slice 9: Cleanup

Goal: remove replaced runtime machinery.

Current status: complete for current runtime source. Legacy actor runner/XState paths are deleted, `xstate` is removed, stale `XSTATE_*` runtime identifiers are gone from current TypeScript source, the single planning processor is used for project/goal cards, the standalone reviewer processor is deleted, and old runtime assembly/stuck-supervisor baggage is removed.

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

## Remaining Validation And Documentation Follow-Up

These items are not blockers for the core actor replacement. Current validation is complete for this recovery simplification; rerun the broader profiles when release criteria or affected surfaces change:

- Full Jest has been run and stale docs-parity tests were rewritten around the current docs/source authority. Continue removing or rewriting stale tests around the new actor architecture rather than adding adapter, bridge, shim, migration, or compatibility code.
- `npm run validate:ui-smoke`, `npm run validate:ui`, and `npm run validate:release` passed after the single-pass recovery simplification.
- Operator-facing docs now describe planner-owned reviewer phase, terminal-tool-only report behavior, card-owned notification delivery markers, and conservative recovery diagnostics. Keep them updated as nonterminal active recovery expands.
- `.saivage/runtime/recovery-diagnostics.json` is now projected through `actorRuntime.recovery`; decide later whether a dedicated recovery endpoint or UI treatment is needed.
- Review generated/runtime artifact ownership separately from this runtime redesign if repository hygiene remains an open release concern.
- Focused tests now cover the confirmed post-review gaps: reviewer self-citation rejection, malformed `activate_card` args, running cancellation notification delivery/leftover handling, real `CardActor` to processor notification-marker wiring, and bounded marker/process-map retention. Keep adding focused recovery tests for newly implemented reconstruction/reconciliation behavior.

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
- Regression tests for removing dead actor APIs so they do not reappear without a production caller.

## Open Decisions

- Remaining card/LLM/processor actor-record retention: delete, archive, or bounded history after reconstruction/outcome conversion. Abandoned process snapshot cleanup is already implemented. If discard-snapshots-on-restart is chosen, this becomes moot for restart recovery.
- Whether mid-flight LLM/process resume is ever a concrete requirement. The current completed policy is diagnostics, safe terminal projection, cleanup, and conservative blocking.
- Exact public projection fields for active chain and runtime activity.
- Whether reviewer-phase notifications should ever be reviewer-visible. The current safe default is to hold main-agent notifications for planner delivery unless a concrete reviewer-cancellation feature is designed.

Resolved decisions (kept for provenance):

- Process tools share one `ProcessActor` per process record; the implementation already does this.
- `actorRuntime.recovery` is the current outstanding-only recovery visibility surface after startup cleanup. A dedicated recovery endpoint/UI treatment is optional polish, not a separate decision.
- Eager terminal commit is deferred. The current clean boundary keeps `CardActor` as the single lifecycle commit owner and uses recovery-side terminal projection for crash windows.
- Discard-snapshots-on-reactivate is deferred. The current startup behavior conservatively blocks non-terminal interrupted work until an explicit auto-reactivation policy exists.

These decisions should be made when their implementation slice starts, not before.
