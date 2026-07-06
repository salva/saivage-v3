# Micro-Actor Runtime Implementation Plan

Status: R1-R4 and P1-P5 remediation complete. The micro-actor runtime, truthful process state/scoped termination, process-first startup recovery, authoritative CardActor cancellation, the single RuntimeGate pause barrier, and reviewer/main-agent notification isolation have all landed. Remaining work is consolidated in [Remaining Work Consolidated Plan](./remaining-work-consolidated-plan.md).

Date: 2026-06-24.

## Current Status

The core micro-actor runtime replacement has landed:

- `RuntimeApi` now uses the actor execution path and no longer has a projection-only startup branch.
- Legacy actor runner/XState runtime paths and the `xstate` package dependency have been removed.
- `CardActor`, `LLMActor`, processor base classes, `TerminalCardProcessorActor`, and `PlanningCardProcessorActor` are the active runtime path. Process execution is a non-actor injected `ProcessRunner` service.
- Planner, executor, and reviewer reports are accepted only through role contract terminal tools.
- Card-owned notifications are delivered per LLM turn with durable delivery markers; `LLMActor` remains queue-free.
- Reviewer execution is a phase of `PlanningCardProcessorActor`; the standalone reviewer card processor was removed.
- Recovery startup records explicit active reconstruction facts in actor snapshots. The pre-reconstruction `runActorStartupRecovery` pass projects safe persisted terminal tool-call outcomes, cleans cancelled/terminal-projected handled snapshots, abandons stale tool calls, rebuilds the recovery plan, and writes sanitized diagnostics. Live recovery then constructs running card actors without starting processors, recovers the root card only, and lets the top-down `activate_card` cascade lazily start reached processors and recover their LLM snapshots.

## Future Choices

The actor runtime plan is complete. The following are future product/architecture choices, not unfinished compatibility work:

1. Mid-flight resume is implemented for running card actors, in-flight provider calls, and waiting tool calls through actor-owned reconstruction entrypoints. OS-process reattachment remains a deliberate non-goal; do not add adapters around in-memory promises, provider calls, or process handles.
2. Auto-reactivation after restart (discard-snapshots-on-reactivate, from card-store state) remains a deferred policy choice. Current recovery already reconstructs running card actors and resumes active work through the top-down cascade, so the choice is auto-reactivation-from-card-store versus the current reconstruction path rather than a bridge over current recovery.
3. Broader release validation should run when release criteria or affected surfaces change; the focused, routine, UI, and release profiles have been re-run after P1-P5.

The detailed recovery work and simplification direction is tracked in [Slice 8: Recovery](#slice-8-recovery).

## Confirmed Follow-Up Corrections

The post-implementation review found a few real issues that should be fixed before expanding recovery. These are not reasons to reintroduce controller workflows or compatibility layers; they are small corrections to keep the actor design clean.

Completed post-review fixes:

- Candidate-review self-citation is rejected unless backed by durable evidence outside the reviewed card candidate result.
- Processor cancellation states and processor `cancel(...)` APIs remain absent from the normal path by design; running cancellation is owned by `CardActor` through the current activation, including authoritative activation-id settlement (see [P3](#p3-cardactor-owns-authoritative-cancellation-and-activation-id-settlement)).
- Notification delivery uses the card-owned `deliverNotificationsForInput(inputId)` contract. Done cards with leftover notifications are handled by the processor's terminal-deferral path (see [P3](#p3-cardactor-owns-authoritative-cancellation-and-activation-id-settlement)), not by flipping `done` to `changed`.
- Non-terminal planner `activate_card` argument failures are returned as recoverable tool results instead of crashing activation.
- Dead actor APIs/options such as untracked notification drain/record methods, production-dead `LLMActor.appendToolError`, and unused runtime construction inputs were removed.
- Notification delivery markers and terminal processor process actor records are bounded/compacted.
- Actor runtime read-model state names are aligned with current actor states.
- Reviewer approval is invalidated when main-agent notifications remain pending after the reviewer turn (reviewer-currentness check). Reviewer turns cannot drain main-agent notifications: reviewer continuations use `reviewerContext(input)`, while only planner/executor flows use `plannerNotificationContext(input, inputId)` (see [P5](#p5-reviewer-cannot-reach-main-agent-notification-delivery)).
- Startup's pre-reconstruction `runActorStartupRecovery` pass projects safe terminal outcomes from durable records; after that pass, startup constructs running card actors with valid `active_reconstruction`, recovers the root card only, and lets `activate_card` replay cascade to children. A `blocked` card status may still arise from terminal projection when the persisted planner terminal is itself `blocked`, never from unreconstructable active work.
- Safe parked-state recovery hooks avoid normal-entry side effects where needed.
- Terminal tool-call recovery projects safe executor terminal outcomes, planner `blocked`/`failed` outcomes, and planner `done` outcomes paired with matching persisted reviewer terminal results.
- Completed child activation waits are handled by the generic interrupted-work conversion path rather than a dedicated special case; stale pending tool calls are abandoned after converted snapshots are cleaned.
- Startup recovery now uses a single initial recovery plan. Its pre-reconstruction `runActorStartupRecovery` pass projects safe terminal outcomes first, cleans cancelled/terminal-projected handled snapshots once, abandons stale pending tool calls once, rebuilds, and persists the outstanding recovery plan; after that pass, startup constructs remaining running card actors without starting processors, recovers the root card only, and lets inline replay in each processor cascade through `activate_card` while recording sanitized diagnostics for any active work that cannot be safely reconstructed.
- Recovery diagnostics are rebuilt after handled snapshot cleanup, so `.saivage/runtime/recovery-diagnostics.json` and `actorRuntime.recovery` report only currently outstanding recovery work.
- The concrete `SupervisorRuntimeApi.getRecoveryPlan()` test seam and dead old-runtime assembly/stuck-supervisor files were removed.
- Full Jest, focused actor suites, routine validation, and current operator-facing spec updates have been run after the recovery slices landed.

Remaining priority fixes:

- Terminal contract handling uses the existing bounded repair loop (`runContractBoundedRepairLoop`) shared by the planner, reviewer-inner, and executor processors — this is accepted current architecture, not pending work. Do not expand it into a general/unbounded terminal-output repair loop, and do not remove the bounded loop without replacing the three callers. Keep its budget bounded and fail fast when the budget is exhausted.
- Remove any newly discovered dead options, duplicated types/helpers, or production-dead LLM/processor APIs as they appear.

Deferred or optional improvements:

- Expanding the bounded repair budget or adding repair for new terminal kinds may be considered later if model behavior proves it is needed; until then the current bounded loop is simpler and easier to reason about.
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
- Add states `idle`, `running`, and `paused` (no `shutting_down`; see [R3](#completed-remediation-r1-r4)).
- Implement public methods `run()`, `pause()`, `shutdown()`, and `cancelProject()`.
- Persist supervisor state transitions from `_on_state_changed(...)`; keep explicit persistence for non-transition context changes such as provider admission/release fields or initialization data.
- Implement `cancelProject()` with authoritative cancellation semantics matching `CardActor` (see [P3](#p3-cardactor-owns-authoritative-cancellation-and-activation-id-settlement)): inactive project work is cancelled immediately, while running project work cancels the current activation so late outcomes cannot commit.
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
- `shutdown()` cancels the supervisor and returns to `idle` (no `shutting_down` state; see [R3](#completed-remediation-r1-r4)).
- RuntimeApi boundary test proves it starts only the supervisor/root card actor path and does not branch over child workflow phases.
- No `RuntimeSupervisorController` compatibility wrapper remains.

Acceptance:

- Public runtime mode projections show idle/running/paused truthfully.
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
- Implement cancellation as two paths: inactive cards/subtrees are marked `cancelled` immediately, while running cards cancel the current activation, write `cancelled` to the card store immediately, resolve the pending activation as cancelled, stop the activation-owned runtime process scope, and drop stale/late outcomes through the CardActor cancellation flag (see [P3](#p3-cardactor-owns-authoritative-cancellation-and-activation-id-settlement)).
- Cancellation of a running card is authoritative, not advisory. The current activation prevents late provider/tool/process outcomes from overwriting the cancelled card lifecycle.
- Keep notification queue ownership in `CardActor`. Provide one processor-facing delivery method that atomically drains notifications for a specific model input id and records delivery markers. Do not keep separate untracked drain/record methods unless a production caller needs them.
- Instantiate or reconnect direct child `CardActor` instances from card data.
- Instantiate or reconnect the associated processor actor for the card type.
- Use `BaseActor.recover(state)` when reconnecting a fresh actor instance to an existing durable card state.
- In `running`, call the processor's `activate(input)` method and wait on a parent-owned promise.
- Call hard-coded parent completion methods when activation outcomes are committed.
- Keep running-card change handling simple: running cards stay `running` and receive notification/context.
- On `done` activation settlement, the processor's bounded repair loop defers the terminal `done` report if undelivered main-agent notifications are pending (see [P3](#p3-cardactor-owns-authoritative-cancellation-and-activation-id-settlement)). The card stays `running`; notifications are delivered to the LLM; the agent re-reports after seeing them. `CardActor` never flips `done` to `changed` because of pending notifications. `changed` is exclusively an edit/subtree-mutation signal.

Tests:

- Activatable statuses are `backlog`, `changed`, and `blocked`. `failed` is not reactivatable (matches `isActivatable()`); the parent must cancel it or handle the failure context.
- `activate(...)` rejects non-child or not-ready activation.
- Activation transitions to `running` and starts the processor.
- Processor `done`, `failed`, and `blocked` outcomes update card state before parent notification.
- `markChanged(...)` moves inactive cards to `changed` and leaves running cards `running`.
- `cancel(...)` marks inactive cards/subtrees `cancelled`, preserves descendants already `done`, and for running cards cancels the current activation, writes `cancelled` to the store immediately, and drops late outcomes through the CardActor cancellation flag.
- Running-card cancellation tests prove the card store is marked `cancelled` immediately, the pending activation resolves as cancelled, and a late provider outcome does not overwrite the cancelled lifecycle.
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

## Slice 4: Process Service And Process Capabilities

Goal: make process execution durable and separately observable before terminal cards need process tools.

Current status: process execution is handled by one injected `ProcessRunner` service (collapsed from the old four-layer forwarding stack by R1). There is no `ProcessActor` and none is planned: process management does real OS work and holds real state, so it earns its existence as exactly one service class.

Implementation (current):

- `ProcessRunner` spawns processes (`spawn(spec)` with explicit `ownerId`/`ownerKind`/`cardId`), streams output to durable logs, persists a durable process registry, and exposes scoped termination: `kill(id, reason, { graceMs })`, `stopByOwner(ownerId, reason, { graceMs })`, `stopRuntimeOwned(reason, { graceMs })`. There is deliberately no blanket `stopAll`.
- Process tools (`run_command`, `wait_process`, `kill_process`) call the runner directly.
- Reconciliation at startup is owner-scoped: runtime/agent-owned running records are killed by PID or marked lost; operator-owned records are observed best-effort or marked lost. See [P1](#p1-processrunner-owns-truthful-process-state-and-scoped-termination) for the corrected truthfulness model and [P2](#p2-startup-reconciles-processes-before-actor-recovery) for startup ordering.

Known drift to be removed in [Remediation R1](#completed-remediation-r1-r4):

- The service was wrapped in a four-layer forwarding stack (`ProcessApi` → module free functions → `ProcessRunnerService` one-line methods → `*ForService` free functions) backed by a per-root module singleton. Only one of those layers did real work. R1 collapsed this to one injected class with scoped termination methods. See [R1](#completed-remediation-r1-r4) and [P1](#p1-processrunner-owns-truthful-process-state-and-scoped-termination) for the current state.

Acceptance:

- Process tools route through the one `ProcessRunner` service.
- Process read models are available to API/UI without exposing unsafe raw output; redaction is applied at the serialization boundary, not via a wrapper class.
- No process-runner controller bridge or forwarding wrapper remains in production code.

## Slice 5: TerminalCardProcessorActor Vertical Slice

Goal: prove the full actor path with the simplest useful card execution.

Implementation:

- Add `BaseCardProcessorActor` before adding or refactoring concrete processors. It owns the shared processor states, public `activate(input)`, pending activation promise handling, settlement, `_on_state_changed(...)` persistence, and common snapshot fields. It must not know planner, reviewer, executor, process-tool, or card-type policy. Processor-level `cancel(...)` and `cancelled` states are intentionally absent; running cancellation is owned by the `CardActor` current activation (see [P3](#p3-cardactor-owns-authoritative-cancellation-and-activation-id-settlement)).
- Add `BaseMainLLMCardProcessorActor` for processors whose main card agent is one LLM session. It creates the main `LLMActor` for the current invocation flow, runs the main turn loop, injects owning-card notifications before each main-agent provider turn, records delivery markers, and provides hook methods for concrete tool routing and terminal-report handling. It must not decide role-specific semantics.
- Implement terminal processor behavior in `TerminalCardProcessorActor`.
- Make `TerminalCardProcessorActor` extend `BaseMainLLMCardProcessorActor`.
- Represent terminal-specific phases such as `executing` and `waiting_process` on processor fields unless a distinct state is needed for task ownership; keep the shared top-level processor states in `BaseCardProcessorActor`.
- Implement public `activate(input)`. Do not add processor `cancel(reason)` unless a separate shutdown/force-cancel feature is deliberately designed.
- Persist terminal processor state transitions from `_on_state_changed(...)`; keep explicit persistence for activation inputs, process ids, and terminal outcomes when those fields change outside transition entry. Cancellation is owned by `CardActor`, not by processors.
- Build executor invocation context from card data, notifications, and relevant project context.
- Own one executor `LLMActor` for the terminal activation path; do not reuse it across activations until `LLMActor` has an explicit terminal-settlement API.
- Provide terminal capabilities: reporting result/failure, process launch/wait/kill through the `ProcessRunner` service, and safe file inspection if already supported.
- Offer the executor contract terminal tool and validate accepted executor terminal reports through that contract before committing card result data. Do not accept free-form executor prose or ad-hoc JSON as a terminal card result. Executor terminal outcomes are `done`, `failed`, or `blocked`.
- Return exactly one `done`, `failed`, or `blocked` outcome to the associated `CardActor`.
- Clean up or archive terminal processor process references after the activation no longer needs them. Long-lived processor instances must not accumulate completed process records indefinitely.

Tests:

- Terminal card executes via executor `LLMActor` and commits accepted `done` result.
- Executor `failed` report commits failed outcome without result data.
- Invalid executor report appends tool error or fails visibly according to protocol.
- Free-form executor messages do not commit terminal card outcomes.
- Process wait timeout returns a timeout tool result and does not kill the process.
- Explicit process kill records termination details.
- Completed/killed process actors do not leak indefinitely through the terminal processor's process map.
- Terminal cancellation while inactive marks the card/subtree `cancelled`; terminal cancellation while running cancels the current activation (see [P3](#p3-cardactor-owns-authoritative-cancellation-and-activation-id-settlement)).
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
- Cancellation of a running project/goal cancels the current activation (see [P3](#p3-cardactor-owns-authoritative-cancellation-and-activation-id-settlement)); late planner outcomes are dropped by the CardActor cancellation flag.
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
- Planner process tools route through the `ProcessRunner` service and return bounded results.
- Pending notifications are delivered before the next planner turn.
- Running-card cancellation cancels the current activation and prevents late planner outcomes from committing (see [P3](#p3-cardactor-owns-authoritative-cancellation-and-activation-id-settlement)).
- Planner terminal reports are accepted only through the planner contract terminal tool.
- Project/goal subclass tests, if any, cover only real overridden behavior and do not duplicate base or shared planning behavior.

Acceptance:

- Project/goal planning can execute a child terminal card through the actor chain, continue the same planner session after the child result, and receive newly queued notifications before the next provider call.
- Shared planner behavior is implemented once in `PlanningCardProcessorActor`.
- No planner controller owns child dispatch outside processor actors/CardActor, and no planner bridge remains.

## Slice 7: Reviewer Flow

Goal: add reviewer assessment after planner reports candidate done.

Current status: implemented for the current actor path. Reviewer execution is planner-owned and contract-terminal-only, self-citation without durable evidence is rejected, and corrections return a blocked planner outcome. Pending main-agent notifications invalidate reviewer approval through currentness checks instead of being drained into reviewer context: reviewer continuations use `reviewerContext(input)` which has no access to the main-agent queue (see [P5](#p5-reviewer-cannot-reach-main-agent-notification-delivery)).

Implementation:

- Run readiness and evidence gates inside the same project/goal processor after the planner contract terminal report proposes `done`.
- Invoke reviewer only after gates pass; the reviewer is a phase owned by the project/goal processor, not a standalone card processor that can independently settle the card.
- Require reviewer output through the reviewer contract terminal tool. Do not accept ambiguous reviewer prose or ad-hoc JSON as a reviewer assessment.
- Treat ambiguous reviewer prose as failed/invalid output, not as guessed approval.
- Review the candidate planner result directly. Do not validate reviewer evidence by fabricating a committed done card through an inline fake store. If the reviewer may cite the reviewed card itself, define that as an explicit evidence rule and require durable evidence on that card; otherwise reject self-citation and require done descendant evidence.
- Store negative reviewer findings with the card and inject them into the next planner context.
- Attach positive reviewer text to the card only after the reviewed snapshot is still current.
- If relevant changes/notifications arrive while reviewing, invalidate reviewer success or divert back to planning.
- Cancellation is authoritative (see [P3](#p3-cardactor-owns-authoritative-cancellation-and-activation-id-settlement)). If a running card is cancelled while reviewer work is active, the cancelled current activation prevents late reviewer outcomes from committing.

No remaining implementation work for this slice. Add focused tests only if new reviewer currentness cases appear during active recovery reconstruction.

Tests:

- Reviewer is not invoked until readiness/evidence gates pass.
- Reviewer approval commits reviewed done only for the assessed snapshot.
- Reviewer approval cannot be based solely on the reviewed card citing its own uncommitted candidate result.
- Reviewer correction returns to planning with stored findings.
- Reviewer terminal reports are accepted only through the reviewer contract terminal tool.
- Relevant change during review invalidates success.
- Cancellation during review cancels the current activation; late reviewer outcomes are dropped by the CardActor cancellation flag.
- Ambiguous reviewer output fails visibly.

Acceptance:

- Goal/project `done` requires planner report, gates, and valid reviewer approval unless the card type explicitly skips review.
- Reviewer logic stays inside processor actor/LLMActor boundaries.
- No standalone reviewer card processor is required for the normal project/goal flow.

## Slice 8: Recovery

Goal: rebuild safe actor state from durable records after restart.

Current status: implemented for the current recovery policy. Startup builds one initial `ActorRecoveryPlan`; the pre-reconstruction `runActorStartupRecovery` pass projects safe persisted terminal tool-call outcomes, cleans cancelled/terminal-projected handled snapshots once, retains reconciled process records per the three-case outcome (runtime/agent-owned records are killed or marked lost as terminal `killed`/`failed`, operator-owned missing/skewed records are marked lost as terminal `failed`, and operator-owned records still alive are matched and remain `running`), abandons stale pending tool calls once, then rebuilds the recovery plan and writes sanitized diagnostics/actions to `.saivage/runtime/recovery-diagnostics.json` for any still-outstanding recovery work. All of that runs before live actor recovery. Startup then constructs running card actors without starting processors and recovers the root card; `activate_card` replay cascades to children, and each reached processor lazily recovers its LLM snapshots. Mid-flight resume is implemented for running card actors, in-flight provider calls, and waiting tool calls; OS-process reattachment remains a deliberate non-goal.

Recovery-side terminal projection is accepted current architecture, not compatibility debt: normal runtime lifecycle commits are owned by `CardActor`, while startup recovery is a distinct operational mode that reconstructs safe outcomes from complete durable records after the normal path was interrupted.

Completed:

- Recovery plan construction classifies supervisor, card, LLM, processor, and process snapshots.
- In-flight provider calls are reissued from the persisted `calling_provider` state on recovery: a recovered `calling_provider` LLM re-enters `_on_enter__calling_provider` and re-runs the provider call, parked at the closed gate until the operator resumes.
- Waiting-tool, active processor, active card, and running process states are surfaced as recovery actions/diagnostics.
- Ambiguous active card states, active LLM states without concrete recovery actions, and stranded active cards are surfaced as human-readable diagnostics.
- Persisted running process records are reconciled at startup before actor recovery (`reconcile()` is wired into `SupervisorRuntimeApi.start()` ahead of `buildActorRecoveryPlan`). Reconciliation is truthful: real PID/process-group signalling for unattached records, no `reattach_state` fiction (see [P1](#p1-processrunner-owns-truthful-process-state-and-scoped-termination), [P2](#p2-startup-reconciles-processes-before-actor-recovery)).
- Startup persists sanitized outstanding recovery diagnostics without including actor snapshot context payloads.
- Persisted recovery diagnostics are versioned with `schema_version: 1`.
- Discarded non-idle supervisor snapshots are surfaced as human-readable diagnostics and actions.
- Clean startup recovery clears stale `.saivage/runtime/recovery-diagnostics.json` files.
- `actorRuntime.recovery` projects sanitized outstanding recovery diagnostics through the runtime status read model/API contract.
- Startup retains reconciled process records per the three-case outcome — runtime/agent-owned as `status:'killed'`, `terminal_reason:'kill_unattached'` or `status:'failed'`, `terminal_reason:'lost'`; operator-owned still alive matched and remaining `running`; operator-owned missing/skewed as `status:'failed'`, `terminal_reason:'lost'` — and clears terminal ones from outstanding diagnostics, so the same process reconciliation is not reported on every restart.
- Startup's pre-reconstruction `runActorStartupRecovery` pass projects safe terminal outcomes from durable records; after that pass, startup constructs running card actors with valid `active_reconstruction`, recovers the root card only, and lets inline replay cascade through `activate_card`. A `blocked` card status may still arise from terminal projection when the persisted planner terminal is itself `blocked`, never from unreconstructable active work.
- Startup cleans cancelled and terminal-projected handled card, LLM, and processor snapshots inside `runActorStartupRecovery` after committing terminal-projected card outcomes and before rewriting diagnostics, all before live actor reconstruction, so handled interrupted work is not reported on every restart.
- `CardActor` recovery to `done` does not run normal entry side effects; there is no notification-sensitive done-to-changed handling in recovery.
- Card, processor, and LLM snapshots persist explicit `active_reconstruction` records for active card activation, processor activation, provider calls, and LLM tool waits.
- Recovery planning exposes active reconstruction records and derives card/LLM/processor active status from those records rather than public-status or state-name heuristics.
- Startup projects persisted terminal tool calls for safe executor terminal outcomes, planner `blocked`/`failed` outcomes, and planner `done` outcomes paired with a matching persisted reviewer terminal result before broad interrupted-work conversion.
- Projected terminal tool calls are marked `terminal_projected`, so stale pending tool-call cleanup does not abandon already-recovered terminal decisions.
- Startup refuses planner `done` projection unless reviewer reconstruction identity, reviewer terminal output, and descendant readiness are all available from durable records.
- Startup handles completed child `activate_card` waits through generic interrupted-work conversion instead of a dedicated child-activation recovery function.
- Startup recovery's pre-reconstruction `runActorStartupRecovery` pass is a single-pass plan consumption path: project terminal outcomes, clean cancelled/terminal-projected handled snapshots once, retain reconciled process records per the three-case outcome (runtime/agent-owned and operator-owned missing/skewed become terminal `failed`/`killed` records cleared from outstanding diagnostics, while operator-owned still alive remain `running`), abandon stale pending tool calls, then rebuild and persist the outstanding recovery plan. Deferred running-card construction and top-down cascade recovery happen after this pass.
- Recovered `waiting_tool` LLM actors park for replay through `replayToolForRecovery`; they are not converted to a `blocked` card status. `LlmRecoveryDiagnosticAction` and `llmRecoveryDiagnosticAction` are diagnostic-label producers only; they do not drive recovery control flow.
- Recovery diagnostics are outstanding-only after cleanup. Handled interrupted work clears from `.saivage/runtime/recovery-diagnostics.json` and `actorRuntime.recovery` during the same startup.

### Deferred simplification direction

The recovery pipeline no longer rebuilds recovery plans between special-case passes, and the child-activation special case has been removed. It rebuilds once after cleanup to publish the outstanding-only diagnostics contract. Two broader simplifications remain deferred because they are larger boundary decisions, not prerequisites for the current clean actor path.

Deferred options:

- **Eager terminal commit.** `recoverProjectedTerminalToolOutcomes` still recomputes card outcomes from logged terminal tool-call args on restart. Eager commit would move this into the normal path, but the current clean boundary is that `CardActor` owns the single durable lifecycle commit. Do not add eager commit unless that boundary is deliberately refactored without duplicate commit paths.
- **Discard-snapshots-on-reactivate.** Restart is normal for an autonomous agent, and auto-reactivation from card-store state remains deferred. Current recovery already reconstructs running card actors and resumes waiting/provider work through the top-down cascade, so the deferred choice is auto-reactivation-from-card-store versus the current reconstruction path.

Do not add adapters or bridge commit paths to get eager commit quickly. If eager commit is pursued, refactor the normal actor path so `CardActor` still owns exactly one lifecycle commit operation.

Future policy choices:

- Extend mid-flight resume only where durable records are complete enough. Running card actors, in-flight provider calls, and waiting tool calls already recover through actor-owned reconstruction; OS-process reattachment remains out of scope, and any future expansion must not use compatibility shims.
- Keep diagnostics for truly orphaned state, including ambiguous card states, stranded active cards, and discarded non-idle supervisor snapshots, regardless of future policy choices.

Implementation:

- Keep startup recovery's pre-reconstruction `runActorStartupRecovery` pass as one pass over the initial recovery plan: project safe terminal outcomes from waiting-tool LLM records first, clean cancelled/terminal-projected handled snapshots once, then abandon stale tool calls once. Projection and reconstruction share the same plan; projected cards are excluded from reconstruction candidates. Rebuild the plan only after cleanup to publish outstanding-only diagnostics. Live reconstruction of running card actors and replay of waiting tool calls, including `waiting_tool` actors, happen after this pass.
- Keep recovery diagnostics as the outstanding-recovery report, not a startup findings report. Do not silently mix both semantics in the same projection.
- Keep recovery-side terminal projection until a deliberate `CardActor`-owned eager commit refactor exists.
- Keep the current reconstruction path until a deliberate discard-and-reactivate runtime policy exists. Keep diagnostics for truly orphaned state either way.
- Reconcile persisted running process records at startup before actor recovery: runtime/agent-owned records are killed by PID or marked lost; operator-owned records still alive are matched and remain `running`, while operator-owned missing/skewed records are marked lost (see [P1](#p1-processrunner-owns-truthful-process-state-and-scoped-termination)). Reconciled records are retained per the three-case outcome; no record is removed. In-flight provider calls are reissued on recovery and park at the closed gate until the operator resumes. OS-process reattachment remains a deliberate non-goal: runtime/agent-owned and operator-owned missing/skewed records become terminal retained records, live operator-owned records remain `running`, and none are reattached.
- Mid-flight resume is implemented for running card actors, in-flight provider calls, and waiting tool calls where durable records are complete enough; OS-process reattachment remains out of scope. Do not double-deliver tool results or duplicate provider turns.
- Fail or block explicitly when state is ambiguous, and clean up/reconcile stale actor snapshots after the ambiguity is handled.

Tests:

- Actor runtime read-model tests recognize current supervisor, card, LLM, processor, and process actor states without exposing raw state values.
- Startup reconstructs running card actors and replays their waiting tool calls, and records sanitized diagnostics for unreconstructable active work without patching card status. A `blocked` card status arises only from terminal projection of a persisted planner `blocked` terminal, and `failed` outcomes come only from terminal projection.
- Startup projects persisted terminal tool calls only when active card, processor, LLM reconstruction records, reviewer reconstruction records where required, and matching logged tool-call messages all agree.
- Safe parked-state recovery hooks hydrate actor fields without triggering `_on_state_changed(...)` transition snapshot writes.
- Recovered `waiting_tool` LLM actors, including planner `activate_card` waits and all other nonterminal `waiting_tool` states such as process-tool waits, park for replay through `replayToolForRecovery`; there is no distinct child-activation or process-tool-wait recovery path.
- LLMs waiting for a process tool result and terminal process results awaiting delivery park for replay through `replayToolForRecovery` like any other interrupted `waiting_tool` state.
- Startup reissues in-flight provider calls from the persisted `calling_provider` state; diagnostics surface any that cannot be safely reissued, projected through `actorRuntime.recovery`.
- Startup handles terminal interrupted reviewer/planner completion with correction/pass context. Nonterminal reviewer interruptions are reconstructed/replayed where durable records allow, else recorded as sanitized diagnostics rather than converted to a `blocked` card status.
- Startup persists sanitized recovery diagnostics for any active snapshot that remains outstanding after handled cleanup.
- Startup diagnostics cover unknown active LLM states, active cards without active owner records, and discarded non-idle supervisor snapshots that remain outstanding after cleanup. Handled reconciled process records clear from diagnostics in the same startup.
- Recovery diagnostics read-model tests prove the runtime status projection remains sanitized and stale diagnostics are cleared after clean recovery.
- Recovery cleanup tests prove handled reconciled process records are retained per the three-case outcome — runtime/agent-owned and operator-owned missing/skewed as terminal records cleared from outstanding diagnostics, operator-owned still alive remaining `running` — before outstanding-only diagnostics are rewritten.
- Recovery tests prove `recover(...)` hooks do not trigger transition snapshot writes through `_on_state_changed(...)`.
- Recovery tests prove handled snapshots are removed or reconciled so the same recovery work is not reported again after restart.

Acceptance:

- Recovery never relies on in-memory queues or raw actor internals.
- Unsafe states become explicit diagnostics, not silent restarts.
- Startup either reconstructs recoverable active actor chains or records sanitized diagnostics for work that cannot be safely reconstructed.
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

## Completed Remediation (R1-R4)

The R1-R4 code-to-design conformance work has landed. This section records what was done so the active plan (P1-P5) is not confused with completed work. Do not re-implement these.

- **R1 — one injected `ProcessRunner`.** The four-layer forwarding stack (`ProcessApi` → module free functions → `ProcessRunnerService` → `*ForService` functions) and the per-root `serviceFor` singleton are gone. `ProcessRunner` is exactly one injected class with `spawn/wait/kill/stopByOwner/stopRuntimeOwned/list/get/reconcile`. Ownership (`ownerId`, `ownerKind`) is required at spawn. All four process-termination callers go through scoped runner methods. Terminal activation cleanup is awaited in a `try/finally` before the activation resolves.
- **R2 — `CardActor` owns construction.** `CardActor` constructs its own processor via `createProcessor(card, this)`. `SupervisorRuntimeApi` constructs only the root and reads the shared `lookup` Map for `notifyCard` and read-model. The old `makePlanningProcessor`/`makeTerminalProcessor`/`processorFor`/`childrenPort` machinery is gone. Recovery calls pure projection functions (`projectPlannerTerminalOutcome`, `projectTerminalExecutorOutcome`) and does not instantiate processor actors.
- **R3 — no `shutting_down` state.** `RuntimeSupervisorActor` has only `idle`/`running`/`paused`. The `shutting_down` reads (`startProjectRejection`'s `runtime_stopping` branch, `actorPauseMode`'s `stopping` case) are gone.
- **R4 — pause/resume routes exist.** `/api/runtime/pause` and `/api/runtime/resume` are wired through the operator contract route system. They close/open the single `RuntimeGate` (landed by P4) so provider calls, runtime-owned process spawns, and card/root dispatch actually wait while paused.

Stale R1 notes worth correcting here: the `kill_process` tool no longer exposes a `signal` argument and already escalates SIGTERM → bounded wait → SIGKILL; do not re-do that work.

Dropped earlier-draft items (provenance): turn-loop home (`runContractBoundedRepairLoop` is already the correct shared free function for planner/reviewer-inner/executor); analyst loop dedup (opposite semantics, no terminal tools, different anti-loop mechanism — forcing unification would relocate logic without removing it).


## Completed Remediation (P1-P5)

The R1-R4 remediation landed the core micro-actor path. A holistic review then found five remaining correctness issues (P1-P5), each fixed at its owning architectural layer — not by scattering per-call guards or adding forwarding wrappers, and not by introducing new classes that duplicate state already owned by existing actors. P1-P5 have all landed. The detailed Problem/Fix/Acceptance records below are kept as the design rationale; do not re-implement them. Keep activation state on `CardActor`; keep OS process truth on `ProcessRunner`; keep recovery as the existing pipeline in `actor-recovery.ts`; the `RuntimeGate` is the single pause authority.

### P1 — ProcessRunner owns truthful process state and scoped termination

**Problem.** `ProcessRunner` still has three real defects: (a) unattached running records can be marked `killed` without signalling a real PID/process group (`stopProcess` at `src/runtime/process-runner.ts:596-623` flips status without an OS signal); (b) `reconcile()` writes `reattach_state: 'reattached'` with no recreated `ChildProcess` handle, claiming control that does not exist (`:654-683`); (c) `loadRegistryForRunner` re-reads durable JSON on every `get`/`list`/`stop` call (`:234-239`). Scoped termination itself already has the right shape (`stopByOwner` for activation/session cleanup and `stopRuntimeOwned` for shutdown/stopProject); do not add a second process-scope taxonomy unless a future multi-project runtime deliberately changes the one-active-project invariant.

**Fix.** Keep all process truth in `ProcessRunner`. Do not introduce a new owner.

- Delete `reattach_state`, `ProcessReconcileOptions.reattach`, `ProcessReconciliationProbeStatus`, and the dead `_audit` parameter on `markLost`. A process is either attached (live `ChildProcess`) or unattached (durable record only).
- For unattached running records in `stopProcess`/`reconcile`: signal by process group (`process.kill(-pid,'SIGTERM')`), poll the group liveness `process.kill(-pid,0)` for the grace window (not just the leader PID — child processes can outlive the `sh -c` leader in the same process group), escalate to `process.kill(-pid,'SIGKILL')`, and only mark `killed` after the group is verified gone; otherwise mark `lost`. Split reconcile by `owner_kind`: runtime/agent-owned are signalled/killed/lost; operator-owned are probed best-effort (alive → observed `running`; dead → `lost`).
- `wait()` on unattached running records throws (no legitimate caller needs it after restart; executor cards are blocked by recovery and analyst sessions are new).
- `loadRegistryForRunner` returns the transient registry directly; `upsertRegistryRecord` is already the durable write-through path, so transient is authoritative in-memory.
- Make `stopMatching` signal the whole scoped set first, wait the grace window once, then kill stragglers — not `N * graceMs` serial awaits.
- Keep the existing ownership fields as the only process ownership vocabulary: `ownerKind` distinguishes runtime/agent work from operator work, `ownerId` identifies the activation/session owner, and `cardId` supports read-model filtering. `stopRuntimeOwned(...)` remains the correct stopProject/shutdown scope while the runtime has one active project; `stopByOwner(...)` remains the activation/session cleanup scope.

Acceptance: unattached kills actually signal the OS; no `reattach_state` fiction; `wait()` on unattached records fails fast; registry reads do not reload durable JSON per call; no redundant process-scope field or ownership taxonomy is introduced.

### P2 — Startup reconciles processes before actor recovery

**Problem.** `SupervisorRuntimeApi.start()` runs `buildActorRecoveryPlan` + `runActorStartupRecovery` (lines 60-64) before `processRunner.reconcile()` (line 65). A card can be projected to terminal `done`/`failed` from a persisted tool call while its runtime-owned process record is still marked `running`.

**Fix.** This is a two-line reorder, not a new `RuntimeRecoveryCoordinator` class. The recovery pipeline already exists as free functions in `src/runtime/actors/actor-recovery.ts` (`buildActorRecoveryPlan`, `runActorStartupRecovery`, `recoverProjectedTerminalToolOutcomes`, `convertActorRecoveryOutcomes`, etc.) and its terminal projection is driven by LLM/tool-call logs, not process records. So:

- Move `this.options.processRunner.reconcile()` above `buildActorRecoveryPlan(...)` in `start()`.
- If and only if a future terminal-projection path actually needs process facts (it does not today), pass a `ProcessReconcileResult` argument into `buildActorRecoveryPlan`. That is one parameter, not a new class.

Acceptance: `reconcile()` runs before actor recovery; recovery diagnostics are unchanged; no new recovery coordinator class exists.

### P3 — CardActor owns authoritative cancellation and activation-id settlement

**Problem.** `CardActor.cancel()` for a running card (`src/runtime/actors/card-actor.ts:207-212`) only enqueues a cancellation notification and returns. The in-flight provider call can still return and `commitOutcome()` (`:271-279`) writes `done`/`failed`/`blocked` over the intended `cancelled` state. The frozen micro-actor core processes queued events only after the current task settles, so a queued `cancel` event cannot preempt `on_done`/`on_failed`.

**Fix.** Keep activation state on `CardActor` where it already lives (`#pendingActivation`, `activeReconstruction`, `lastOutcome`). Do **not** introduce an `ActivationAttempt`/`ActivationLease` class — there is exactly one card-activation per `CardActor` at a time, so a third parallel record would triple the state and add two resolvers to keep in sync.

- Add `#activationId` and `#cancellation` fields to `CardActor`. There is no activation-generation counter: a cancelled `CardActor` is terminal and is never reactivated, so one boolean cancellation flag is the complete settlement guard. The activation id exists only to give the activation a stable process-owner identity (see below) — it is not a settlement-matching key and is never threaded through processor outcomes, tool callbacks, or child-activation callbacks.
- `activate(caller)` generates one stable activation id (e.g. `${cardId}:act:${++counter}`), stores it in `#activationId`, and passes it through `CardActivationInput.activationId` so the processor and process provider use it as the process `ownerId` — not the LLM input id, which changes per turn and would split one activation's processes across owners.
- In `cancel()` for a running card: set `#cancellation = reason`, write `cancelled` to the store via `writeStatus('cancelled')`, clear `activeReconstruction`, resolve `#pendingActivation` as `{ status: 'cancelled', summary: reason.reason }`, set `#pendingActivation = null`, queue `sendEvent('cancel')`, fire-and-forget `ProcessRunner.stopByOwner(#activationId)`, and persist. The `sendEvent('cancel')` must be queued synchronously — the frozen actor main loop crashes if the processor task settles while `cancel()` is still awaiting something and no event is queued (the main loop finds no event, no tasks, a non-terminal state, and throws). Process cleanup is fire-and-forget: it signals SIGTERM immediately and proceeds concurrently with the cancellation transition. The processor's own `finally` block already awaits `stopByOwner(input.activationId)` on settlement as a safety net, so the two calls are complementary, not redundant.
- In `commitOutcome()`: if `#cancellation` is set, return immediately. Do not mutate lifecycle, do not `sendEvent`. The processor does not know about cancellation or activation identity; it settles normally and `CardActor.commitOutcome()` is the single settlement gate that drops late outcomes.
- Propagate cancellation to running descendants **through the live `CardActor.cancel()`** via `deps.lookup.get(childId)`; fall back to a direct store write only when no live actor exists. Replace the current `cancelDescendantIds` which direct-writes all descendants and bypasses their pending-activation resolvers.
- Terminal-report validation in the bounded repair loop (`onTerminalTool` handler shared by planner and executor processors) must defer a `done` report when undelivered main-agent notifications are pending. This is not a validation error — it is a currentness continuation: new context arrived before terminal acceptance. The card stays `running`, the pending notifications are appended to the next LLM turn, and the agent decides whether to re-report `done`, adjust its result, block, or fail. `CardActor.commitOutcome()` therefore never needs to flip `done` to `changed` — it only commits clean outcomes. Remove `reopenDoneWithPendingNotifications()` and the `_on_enter__done`/`_on_recover__done` pair that exists only to compensate for it. Notifications arriving on an already-inactive `done` card after settlement are queued for future delivery; they do not mutate lifecycle state. `changed` is produced only by card edits/subtree mutations, never by notification delivery.
- `BaseCardProcessorActor` continues to return only `done`/`failed`/`blocked` to its owning `CardActor`; it never synthesizes `cancelled`. The CardActor-to-parent activation outcome vocabulary is `done`/`failed`/`blocked`/`cancelled`, where `cancelled` is produced only by `CardActor.cancel()`.
- Terminal processor process wiring must switch from `llmInput.inputId` to `input.activationId` as the process `ownerId` (`src/runtime/actors/terminal-card-processor-actor.ts:68,98,131`). There is one activation-owned identity — the `CardActor`-generated activation id — not the per-turn LLM input id. Normal settlement's `finally` cleanup and cancellation's `stopByOwner` then reference the same id.
- Make `cancelled` truly terminal in the lifecycle state machine: remove `cancelled → backlog` and `cancelled → changed` from `VALID_TRANSITIONS` in `src/cards/lifecycle.ts`; remove `'cancelled'` from `FLIPPABLE_RESTING` in `src/runtime/changed-propagation.ts`. The spec and design already say cancelled is terminal; the code must match so propagation and direct transitions cannot revive a cancelled card.
- Recovery must treat cards whose durable card status is `cancelled` as fully handled and remove all actor snapshots (card, processor, LLM) for them at startup. P3's running cancellation writes `cancelled` to the card store and queues `sendEvent('cancel')`, but the frozen main loop processes that event only after the current processor task settles. A crash in that window leaves the card store `cancelled` while stale processor/LLM snapshots with active reconstruction records remain on disk. Without this cleanup those snapshots would generate outstanding recovery diagnostics on every restart. Existing recovery already converts `running` cards to `blocked` and cleans their snapshots; this extends the same cleanup to cards already in a terminal store status.

Acceptance: late provider/tool/process/child outcomes cannot mutate a cancelled card's lifecycle; running descendants are cancelled through their live `CardActor.cancel()`; `cancelled` is a first-class parent-visible activation outcome; pending main-agent notifications at terminal-report time are handled by the processor's bounded repair loop (not by a CardActor settlement flip); `reopenDone` and its compensating recover hook are gone; `cancelled` is terminal in the lifecycle state machine (no cancelled→backlog/changed transition, no propagation flip); recovery removes all actor snapshots for cards whose durable status is `cancelled`, so a crash during running cancellation does not leave stale active snapshots or outstanding diagnostics.

### P4 — RuntimeGate replaces LLM admission and owns the pause barrier

**Problem.** Pause/resume is a global runtime concern but is currently (a) split across supervisor mode, persisted runtime state, and a module-global `setRuntimeControlNotifyCard` registry, and (b) only enforced by `LLMAdmissionPort.requestProviderCall` returning `false`, which **fails the turn** `src/runtime/actors/llm-actor.ts:148` rather than waiting behind a gate. Runtime-owned process spawns and child dispatch can still be started from an already-returned provider response after pause, so LLM admission alone is not enough. The R4 routes are wired but functionally inert until this lands.

**Fix.** Introduce one small composition-root `RuntimeGate` that **replaces** the existing admission port — do not run two admission systems in parallel. The gate is an awaitable barrier for new autonomous side effects and dispatch, not a workflow engine and not a completion-replay queue.

- `RuntimeGate` owns live pause truth and waiters. Persisted runtime mode is the restart authority; supervisor mode is the projection/duplicate-run guard. On startup the gate is initialized from persisted mode, and any mismatch is normalized through that single reconstruction path rather than tolerated as two live truths.
- `LLMActor` asks the gate (awaitable) before provider invocation; pause **waits** rather than failing the turn.
- The runtime process tool provider asks the gate before calling `ProcessRunner.spawn(...)` for runtime-owned work, so an in-flight provider response cannot launch a new OS process while paused. `ProcessRunner` itself must not know about pause policy — it is a pure OS-process service. Operator-owned Analyst process spawns are outside autonomous runtime pause unless a separate operator policy deliberately gates them.
- `CardActor.activateChild(...)` (and the root dispatch path) asks the gate before dispatching new card/processor work, so an in-flight planner response cannot start a child while paused.
- Completion facts from already-admitted work may still persist and settle to durable boundaries while paused. Follow-up autonomous work reaches the same provider/spawn/child-dispatch gate before it can start. Resume opens the gate and existing waiters continue exactly once in normal actor order; do not add a separate held-deliverables queue or replay/drain scheduler.
- **Delete** `LLMAdmissionPort`, `RuntimeSupervisorActor.requestProviderCall`/`releaseProviderCall`, and `activeProviderCallId`. The gate is the single source of pause truth.
- `SupervisorRuntimeApi.pause()`/`resume()`: close/open the gate, update supervisor mode, and update persisted runtime state. Throw on non-applicable states; never silently no-op. Resume does not run workflow logic; it only opens the barrier so already-blocked actor work can proceed.
- **Delete** `setRuntimeControlNotifyCard` and `runtimeControlNotifyCardByRoot` (`src/runtime/control.ts:24-37`) and the wiring in `src/application/runtime-composition.ts:107`. Offline CLI pause/resume writes persisted state only and never attempts drain.
- A small explicit helper (`awaitGateOpen`/`runGatedTask`) is acceptable to remove duplicated boilerplate. Do **not** add an implicit `BaseActor.paused` flag that suppresses `_on_enter__{state}` globally — that creates half-entered states and ambiguous recovery.

Acceptance: `LLMAdmissionPort` and the supervisor's provider-call admission are gone; the gate is the single live pause authority; provider calls, runtime-owned process spawns, and child/root dispatch wait while paused; resume does not require a second manual Run and does not replay a custom deliverables queue; no role-specific planner/reviewer/executor code owns pause policy; the module-global notify registry is gone.

### P5 — Reviewer cannot reach main-agent notification delivery

**Problem.** The reviewer's `onNonTerminalTool` continuation (`src/runtime/actors/planning-card-processor-actor.ts:221`) calls the generic `notificationContextMessages(input, inputId)` (`src/runtime/actors/base-main-llm-card-processor-actor.ts:38-41`), which drains the card's main-agent notification queue and marks it delivered to the reviewer session. The design says reviewer turns must hold those notifications.

**Fix.** This is a method split, not a delivery-policy class. Make the wrong action unrepresentable by removing the generic `notificationContextMessages` helper and exposing two explicit methods on the base processor:

- `plannerNotificationContext(input, inputId)` — drains main-agent notifications (planner/executor flows only). Atomic drain + marker recording already lives inside `CardActor.deliverNotificationsForInput`; no new atomicity machinery.
- `reviewerContext(input)` — returns currentness/change invalidation state only; **no** access to the main-agent queue.

Update the planner continuation (line 106) and activation input (line 131) to use the planner method; the reviewer continuation (line 221) uses the reviewer method. The reviewer-currentness check that invalidates reviewer approval when main-agent notifications are pending stays as-is.

Acceptance: reviewer code has no method capable of draining planner/main-agent notifications; planner/executor delivery still drains exactly once and records markers; no new delivery-policy abstraction is introduced.

### Sequencing

The order in which P1-P5 were implemented:

1. **P1 — ProcessRunner truth/scoped termination.** Unblocks authoritative cancel (which stops activation-owned processes) and recovery ordering. Independent.
2. **P3 — CardActor authoritative cancel + activation-id settlement.** Depends on P1 only for the process-stop path; uses `stopByOwner(activationId)` (via `CardActivationInput.activationId`) for activation-owned process cleanup.
3. **P2 — Reorder recovery.** Two-line swap; benefits from P1's reconcile changes.
4. **P4 — RuntimeGate.** Replaces LLM admission; independent of P1-P3.
5. **P5 — Notification method split.** Independent; can land anytime.
6. **Boundary cleanup** is folded into the slice that touches each boundary (see P3 for notification settlement/`cancelDescendantIds`, P5 for the helper split); remaining items are tracked below.

### Boundary cleanup (folded into the slices above, or standalone)

These boundary items are not part of P1-P5 and remain as standalone cleanup opportunities:

- `CardActor` owns child actor references, direct-child authority, and child completion callbacks; `PlanningCardProcessorActor` obtains child activation through an `activateChild(childId, caller)` capability, not by holding child `CardActor` refs.
- Root activation projection: `SupervisorRuntimeApi.runRootProject` is architecturally acceptable — it calls `CardActor.activate()`, awaits the promise, and projects the run record, which the design allows. Fix the root-settlement projection bug (settled `blocked` root still projects `running` with stale `currentCardId`) and simplify the `finally`-block cancel/settle branch so the API layer only projects outcomes, never decides control flow.
- Delete the stale `recoverTerminalToolOutcome` instance methods on the processor classes (recovery already imports the pure projection functions).
- Remove the `failed -> activate` (and `done`/`cancelled` -> activate) state-table transitions the domain invariant forbids; the table should encode impossible transitions, not rely only on `isActivatable()` guards.
- Delete the thin `createComposedRuntimeApi` forwarding wrapper; inline it and move `candidateAvailability.dispose()` into the shutdown path.



## Remaining Validation And Documentation Follow-Up

These items are not blockers for the core actor replacement. P1-P5 have landed and validation has been re-run:

- Full Jest has been run and stale docs-parity tests were rewritten around the current docs/source authority. Continue removing or rewriting stale tests around the new actor architecture rather than adding adapter, bridge, shim, migration, or compatibility code.
- `npm run validate:ui-smoke`, `npm run validate:ui`, and `npm run validate:release` passed after the single-pass recovery simplification; routine/docs validation was re-run after P1-P5.
- Operator-facing docs now describe planner-owned reviewer phase, terminal-tool-only report behavior, card-owned notification delivery markers, and conservative recovery diagnostics. Keep them updated as nonterminal active recovery expands.
- `.saivage/runtime/recovery-diagnostics.json` is now projected through `actorRuntime.recovery`; decide later whether a dedicated recovery endpoint or UI treatment is needed.
- Review generated/runtime artifact ownership separately from this runtime redesign if repository hygiene remains an open release concern.
- Focused tests cover reviewer self-citation rejection, malformed `activate_card` args, real `CardActor` to processor notification-marker wiring, bounded marker/process-map retention, CardActor authoritative cancellation, process truth/scoped termination, recovery ordering, runtime gate wait/unblock behavior, and reviewer notification method split.

## Cross-Slice Test Matrix

- Micro-actor definition, parked state, task, timeout, cancellation, and recovery tests.
- Supervisor run/pause/resume/shutdown/cancel tests.
- Runtime gate tests: close blocks provider calls, runtime-owned process spawns, and child/root dispatch; resume opens the barrier so existing waiters proceed exactly once in normal actor order; no custom deliverables replay queue exists; any micro-actor helper for gated tasks is explicit and does not suppress `_on_enter__{state}` globally.
- CardActor activation, status commit ordering, changed state, cancellation, and notification tests.
- BaseCardProcessorActor and BaseMainLLMCardProcessorActor mechanical tests.
- LLMActor provider admission, provider failure, tool protocol, duplicate tool delivery, and diagnostics tests.
- Process launch, wait timeout, kill, exit, recovery, and scoped-set termination (`stopByOwner`/`stopRuntimeOwned`, including the `owner_kind !== 'operator'` survivor invariant) tests.
- Terminal processor executor/report/process tests.
- Goal/project processor child activation, planner report, completion gate, process, notification, and reviewer tests.
- Contract-terminal tests for planner, executor, and reviewer reports.
- RuntimeApi boundary tests proving it calls public methods and projects read models only, including root activation projection (await CardActor.activate(), project run outcome, no workflow branching).
- Projection tests for runtime mode, active chain, active leaf, provider/process waits, and diagnostics.
- UI smoke tests when projection contracts change.
- Regression tests for removing dead actor APIs so they do not reappear without a production caller.

## Open Decisions

- Remaining card/LLM/processor actor-record retention: delete, archive, or bounded history after reconstruction/outcome conversion. Abandoned process snapshot cleanup is already implemented. If discard-snapshots-on-restart is chosen, this becomes moot for restart recovery.
- Whether mid-flight LLM/process resume is ever a concrete requirement. The current completed policy is diagnostics, safe terminal projection, cleanup, and conservative blocking.
- Exact public projection fields for active chain and runtime activity.
- Whether reviewer-phase notifications should ever be reviewer-visible. The current safe default is to hold main-agent notifications for planner delivery unless a concrete reviewer-cancellation feature is designed.

Resolved decisions (kept for provenance):

- Process tools share one injected `ProcessRunner` service; there is no `ProcessActor` and none is planned. The current four-layer forwarding wrapper around the service is slated for removal in [Remediation R1](#completed-remediation-r1-r4).
- `actorRuntime.recovery` is the current outstanding-only recovery visibility surface after startup cleanup. A dedicated recovery endpoint/UI treatment is optional polish, not a separate decision.
- Eager terminal commit is deferred. The current clean boundary keeps `CardActor` as the single lifecycle commit owner and uses recovery-side terminal projection for crash windows.
- Discard-snapshots-on-reactivate is deferred. Current startup behavior runs a pre-reconstruction `runActorStartupRecovery` pass (safe terminal projection, cancelled/terminal-projected snapshot cleanup, stale-tool-call abandonment, sanitized diagnostics), then constructs running card actors and recovers active work through the top-down cascade; auto-reactivation from card-store state remains deferred.

These decisions should be made when their implementation slice starts, not before.
