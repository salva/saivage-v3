# Card Runner XState Replacement Plan

Status: active replacement plan, readjusted after the first XState core
implementation slices on 2026-06-12, the default runtime switchover on
2026-06-12, and the first old-harness cleanup retrospective on 2026-06-12. This
document explains how to build a new minimal Saivage v3 runtime core around the
XState architecture described in
[Card Runner XState Rearchitecture Draft](./card-runner-xstate-rearchitecture-draft.md).
It is not a one-for-one porting plan for the old runtime, not a bridge plan, and
not a migration plan for old `.saivage` runtime state.

## 0. Current Implementation Checkpoint

The first implementation pass validated the main architecture but also exposed
where the next work must be narrower than the original broad phase list. The
following pieces now exist in `src/runtime/actors/` or adjacent composition code:

- deterministic actor ids and Saivage-owned actor snapshots;
- `RuntimeSupervisorController` with pause/resume/stop and one provider-call
  admission permit;
- role-generic `LlmRunnerController` with `LLM_RESULT`, `LLM_TOOL_CALL`, and
  `LLM_ERROR` outputs;
- `ProcessRunnerController` with timeout-without-kill, inspect, wait, and explicit
  kill behavior;
- terminal and goal CardRunner controllers;
- recursive XState child activation through `activate_card`;
- reviewer turns and CardRunner-owned NoteBox delivery by note id;
- terminal and goal status ports that write public card lifecycle state through
  the `CardStore` lifecycle methods;
- an `InvocationService` to `ProviderTurnPort` adapter;
- a default `createXStateRuntimeApi()` runtime composition factory;
- XState actor input builders that reuse existing planner, executor, and reviewer
  prompt/context builders; and
- a startup recovery-plan reader that validates persisted actor snapshots before
  the supervisor starts; and
- append-only tool-call status records for `pending`, `delivered`, `errored`, and
  startup `abandoned` transitions at LLM/CardRunner tool boundaries.

The following confirmed gaps are now the priority before deeper recovery or API
rewrites:

1. The recovery-plan reader validates persisted actor snapshots, but startup does
   not yet rebuild actors or reconcile running process snapshots.
2. LLM turns persist message JSONL, tool-delivery records, and
   `pending/delivered/errored/abandoned` tool status transitions. The remaining
   protocol gap is enforcing exactly-one terminal transition when providers emit
   multiple tool calls in one turn or cancellation races active tool handling.
3. `changed` card propagation reaches active XState goal NoteBoxes, but the old
   synthetic planner-note fallback still exists for inactive/no-owner cases.
4. The production server now defaults to the XState runtime, but old dispatcher
   and old core modules remain in `src/runtime/` as deletion targets while tests
   are rewritten around actor boundaries.

Old-harness cleanup checkpoint, 2026-06-12:

- The simple deletion/rewrite tranche is done. Obsolete old-harness tests for
  executor fallback evidence, F23 dispatch acceptance, planner non-actionable
  output, startup session sweep, stale running intent reconciliation, and planner
  context-length blockers were removed or replaced by narrow startup/actor/domain
  tests.
- Remaining `createRuntimeCoreTestContainer` users need file-local triage rather
  than a blanket rewrite:
  - `tests/runtime/runtime-command-ledger.test.ts` mostly asserts old runtime
    command/run/activation ledger mechanics. Treat it as an obsolete
    orchestration suite unless a specific current product behavior is proven
    uncovered elsewhere.
  - `tests/utils/runtime-integration.test.ts` mixed mostly old harness behavior
    with direct runtime lock tests and was removed; lock coverage now lives in
    `tests/runtime/runtime-lock.test.ts`. Do not recreate the old integration
    harness for its own sake.
  - `tests/e2e/hardening-e2e.test.ts` contained valid security/API/quarantine
    tests plus an old harness lifecycle/artifact section; the old harness section
    was removed and the direct security coverage remains. Replace
    artifact/lifecycle coverage only if a current XState-era ownership boundary
    lacks it.
  - `tests/utils/error-logger.test.ts` contained valid `ErrorLogger` unit/JSONL
    tests plus old runtime error-propagation harness sections; the old harness
    sections were removed and the direct logger tests remain. Add XState logging
    coverage only for live behavior that is not already tested.
  - `tests/utils/stuck-agent-supervisor.test.ts` contains valid
    `StuckAgentSupervisor` unit tests plus old runtime-wiring sections. Preserve
    the direct supervisor tests; avoid rebuilding runtime integration around the
    old core.
  Boundary assertions in `tests/utils/runtime-module-boundary.test.ts` remain
  until the old source files are gone.
- Do not preserve any remaining harness section merely because it provides broad
  old-runtime integration coverage. For each file, first separate current product
  behavior from old implementation behavior. Delete old-orchestration assertions.
  Add only the smallest XState-era actor/domain/API test needed for current
  behavior that is otherwise unprotected.
- Reviewing or accepting this plan is not authorization to perform the cleanup.
  Execute the file edits only after an explicit implementation request.

Readjusted near-term order:

1. Complete startup recovery from the validated actor recovery plan: rebuild safe
   actor trees, explicitly abandon unsafe provider/tool/process boundaries, and
   publish diagnostics.
2. Complete the durable tool protocol by recording status transitions for every
   tool call and exactly-one delivery/error to the waiting LLMRunner.
3. Remove the remaining old synthetic-note fallback once CardRunner NoteBox
   persistence covers inactive/no-owner recovery cases.
4. Delete old dispatcher/core owners once their remaining tests are deleted or
   replaced by focused XState-era tests for current product behavior.

Do not add a general event-sourcing system, queues, distributed locks, or generic
workflow framework while closing these gaps. Add the smallest persisted records
that make the actor boundaries safe and inspectable.

## 1. Goal

Build a clean, functional runtime core around XState actors. Do not port old-core
responsibilities just because they exist. The old runtime was over-engineered;
only behavior required for a working Saivage app should move into the new core.

The target architecture is XState only:

- Cards remain canonical Saivage domain records.
- Public card status remains the operator/API lifecycle.
- CardRunner owns card activation phase: `planning`, `reviewing`, `executing`,
  `done`, or `cancelling`.
- LLMRunner is role-generic and owns provider/tool protocol state.
- ProcessRunner owns durable external process state.
- RuntimeSupervisor owns admission, pause/quiescence, recovery, actor registry,
  and actor lifecycle.
- API/UI consume Saivage read-model projections, never XState snapshots.

The final codebase must not contain adapter or bridge code whose only purpose is
to translate between the old runtime and the new runtime. Temporary scaffolding
is allowed inside a short-lived implementation branch, but it must be deleted
before the replacement is considered complete.

## 2. Functional Minimum

The new core is considered functional when it can do this without old dispatcher,
session-active-status, or activation-unwind machinery:

1. Start and stop the server with RuntimeSupervisor as the runtime owner.
2. Load project/card state and expose a usable operator read model.
3. Start a terminal card, run its executor LLMRunner, handle required tool calls,
   and commit `done`, `failed`, `blocked`, or `needs_verification`.
4. Start a goal card, run planner turns, create/start child cards through
   `activate_card`, receive exactly one child outcome, and continue planning.
5. Run reviewer turns for goal completion, return corrections to planning, and
   commit accepted goal outcomes.
6. Persist enough actor, card, message, tool-call, note, and process state to
   survive dirty shutdown by continuing safe paths or explicitly failing unsafe
   paths with diagnostics.
7. Pause, resume, cancel, and shut down without corrupting card/message/tool
   state.
8. Keep the analyst usable as a separate operator assistant. It does not need to
   be card-owned, but it may use XState if actor ownership improves the design.

Everything else is optional until a current product surface needs it.

Do not port these old-core concepts as independent requirements:

- Runtime run ledgers as a product-visible orchestration substrate.
- Runtime activation arrays as separate state from parent/child actor waits.
- Process-local active session status.
- Scheduled redispatch loops.
- Startup repair that reconstructs old active runs.
- Synthetic planner-note routing when NoteBox can cover the behavior.
- Global single-active-non-analyst-session enforcement.
- Dispatcher composition objects that exist only to wire old phase runners.

Before reintroducing any old layer, ask whether the old approach was actually
right. The default answer should be "no" unless the layer still represents a
clear product concept. If a cleaner XState actor, domain service, or read-model
projection can replace an old layer, use the cleaner design instead of preserving
the old shape.

## 3. Replacement Strategy

Prefer a clean minimal core over a progressive port.

The easiest path is likely:

1. Build the new RuntimeSupervisor/CardRunner/LLMRunner/ProcessRunner core in a
   new active runtime boundary.
2. Move old runtime orchestration code out of the active import tree when the new
   core owns the corresponding product behavior.
3. Keep only domain primitives that are still valid: card store, lifecycle
   transition policy, provider configuration, observability sinks, file/process
   primitives, skills/tool definitions, and prompt/context builders if they fit
   the new ownership model.
4. Reimplement runtime orchestration from scratch with RuntimeSupervisor,
   CardRunner, LLMRunner, ProcessRunner, NoteBox, and actor persistence.
5. Move and modify adjacent layers progressively as they become needed by the new
   core. If an old adjacent layer is unnecessary for current functionality, leave
   it out instead of preserving it.
6. Reassess each adjacent layer before moving it. The implementation choice is
   not "port or delete"; it is "keep the product behavior, then choose the best
   new ownership model."
7. Extend XState beyond card execution when it improves lifecycle ownership,
   recovery, or operator control. The analyst path is eligible for this treatment
   even though it is not card-attached.
8. Delete any temporary compatibility, bridge, or adapter modules before merge.

This does not require running old and new dispatchers side by side. If an old
layer's shape fights the new architecture, rewrite it or omit it instead of
adapting around it.

## 4. Old Code To Audit, Not Port

Treat these files as behavior references and deletion targets, not as porting
units. They can be deleted immediately, left temporarily unreferenced, or parked
in a branch-local archive while the new core is built. They should not remain
imported by the final runtime:

- `src/runtime/runtime-planner-dispatcher.ts`
- `src/runtime/pending-activation-dispatcher.ts`
- `src/runtime/executor-activation-dispatcher.ts`
- `src/runtime/runtime-reviewer-dispatcher.ts`
- `src/runtime/activation-unwind.ts`
- `src/runtime/phases/planner-activation-runner.ts`
- `src/runtime/phases/planner-iteration-runner.ts`
- `src/runtime/phases/executor-phase-runner.ts`
- `src/runtime/phases/reviewer-phase-runner.ts`
- `src/runtime/session-persistence.ts` active-session ownership logic
- `src/runtime/state-machine.ts` dispatch/tick/redispatch responsibilities
- `src/runtime/runtime-core.ts` active-run/runtime-run/runtime-activation reducer
  responsibilities
- `src/runtime/runtime-dispatch-composition.ts`
- `src/runtime/runtime-lifecycle-controller.ts`
- `src/runtime/runtime-lifecycle-state.ts`
- `src/runtime/runtime-startup.ts` old active-session reconciliation
- `src/runtime/startup-repair.ts` old active-run repair paths
- `src/runtime/activation-repair.ts`
- `src/runtime/runtime-run-ledger.ts`
- `src/runtime/runtime-project-commands.ts` old command runner shape
- Runtime state fields that encode old orchestration, especially active run,
  runtime activation arrays, dispatch-in-flight maps, and single-active-session
  assumptions.

The `src/runtime/phases/` directory should also be audited as old-core code. Keep
or extract only product domain logic that still makes sense, such as terminal
commit validation or prompt/context assembly. Do not port phase runners or phase
state helpers as an architectural layer.

The audit question for every old layer is:

1. What current product behavior does this layer support?
2. Is that behavior required for the functional minimum or a current operator
   surface?
3. Is the old ownership model still right under XState?
4. Could the behavior be simpler as a CardRunner action, LLMRunner wait state,
   RuntimeSupervisor policy, standalone domain service, read-model projection, or
   separate XState actor?
5. If it is not required now, can it be omitted until the product need reappears?

Rewrite adjacent layers if they encode old runtime assumptions:

- Server runtime-control routes should command RuntimeSupervisor, not old
  dispatcher methods.
- Operator API state responses should be built from read-model projections, not
  old active-run fields.
- Web stores should consume projected `runnerPhase`, `agentPhase`, `pauseMode`,
  diagnostics, and public card status.
- Agent invocation code should become a provider/model turn primitive used by
  LLMRunner, not role-specific planner/executor/reviewer orchestration glue.
- Session/message persistence should become LLMRunner-owned conversation and
  tool-call logs, not global role sessions with process-local active status.

## 5. New Runtime Layers

Create `src/runtime/actors/` as the new orchestration boundary:

- `runtime-supervisor.ts`: root XState actor, deterministic actor registry,
  admission permits, pause/quiescence, startup recovery, shutdown, and child
  lifecycle.
- `card-runner.ts`: CardRunner machine and actions for public card status
  transitions, phase transitions, NoteBox delivery, parent/child activation
  outcomes, and self-event classification.
- `llm-runner.ts`: generic LLMRunner machine for input envelopes, provider
  requests, tool-call ledger transitions, tool results/errors, and generic
  output events.
- `process-runner.ts`: background process actor that starts a subprocess, waits
  for it with a timeout, and gives the owning LLMRunner control over what happens
  next. ProcessRunner does not kill the process on timeout. Instead, it reports
  the timeout to the LLMRunner, which decides whether to keep waiting, inspect
  partial output, kill the process, or abandon it. ProcessRunner provides
  exactly-one terminal delivery and can be reattached after dirty shutdown if
  the process is still running.
- `notebox.ts`: starts as a data structure owned by CardRunner — a set of
  delivered note ids and a list of pending notes. Only extract into a separate
  persisted module if note delivery grows real persistence or recovery complexity.
  The initial implementation needs only: idempotent delivery by note id, delivery
  before the next LLMRunner turn, and pending-note guards on `REVIEW_PASSED`.
- `persistence.ts`: Saivage-owned actor snapshot read/write, JSONL append, atomic
  JSON write, and companion index-manifest helpers. Start with what Phase C needs
  (card snapshots, LLM runner snapshots, message logs) and add segmentation and
  index manifests when the phases that need them land.
- `ids.ts`: deterministic actor ids such as `card:<id>`, `planner:<card>`,
  `reviewer:<card>`, `executor:<card>`, and `process:<id>`.
- `read-model.ts`: projection from actors/domain state into API/UI fields without
  exposing raw XState state. This module lives near API routes, not inside the
  actors package boundary. Actors expose their state through well-defined
  interfaces; projections are a separate concern.

Additional actors are allowed when they simplify real lifecycle ownership. Do not
add generic actor layers "because XState is available," but do consider XState
for long-lived non-card workflows such as analyst conversations, MCP/server
connections, operator command execution, or durable background reconciliation if
they need explicit states, cancellation, pause/quiescence, or recovery.

The rest of the runtime should depend on this package-level boundary instead of
reaching into individual actor internals.

## 6. Persistence Model

Implement persistence incrementally. The first implementation used a simple
single-file actor snapshot store to prove the actor boundary. Before recovery or
production switchover, replace that test-friendly layout with small per-actor
files and append-only delivery logs. Add storage complexity only when a phase
needs it:

Phase C needs:
```text
.saivage/runtime/actors/supervisor.json
.saivage/runtime/actors/card/<card-id>.json
.saivage/runtime/actors/llm/<agent-id>.json
.saivage/agents/messages/<agent-id>.jsonl
.saivage/agents/tool-deliveries/<agent-id>.jsonl
```

Later phases add:
```text
.saivage/runtime/events.jsonl
.saivage/agents/messages/<agent-id>.index.json
.saivage/agents/messages/<agent-id>.<segment>.jsonl
.saivage/cards/<card-id>/notes.jsonl (if NoteBox grows beyond in-memory)
```

Rules:

- Actor snapshots are Saivage-owned schemas, not opaque framework internals.
  Include a `schema_version` field from day one so future schema changes don't
  require another clean break.
- Startup does not migrate old active runtime state.
- Incompatible old `.saivage` runtime state should fail closed with an operator
  reset instruction or be explicitly marked failed/abandoned if safe.
- Message logs and tool-call histories are append-only JSONL.
- Compact JSON snapshots are fast-start state, not the only audit trail.
- Companion index manifests identify current log segments and current versioned
  domain files.
- The global single-active-non-analyst-session invariant is removed; concurrency
  is controlled by actor ownership and admission permits.
- Do not persist private XState internals, event queues, or framework snapshots.
  Persist Saivage facts: actor id/kind, public phase, card id, current input id,
  pending tool call ids, process ids, and terminal outcomes.

## 7. Build Order

These are construction phases for a minimal new core. They are not a checklist of
old-runtime features to port. Each phase should leave the new runtime internally
coherent for the behavior it owns. The old runtime does not need to keep working
during the replacement branch if that makes implementation simpler.

### Phase A: Minimal Runtime Shell

Work:

1. Add `xstate` as a runtime dependency. Pin to XState v5-style actors and
   machine setup; v4 has a different actor API and snapshot model.
2. Add actor ids, snapshot schemas, JSON/JSONL persistence primitives, and event
   append helpers.
3. Implement RuntimeSupervisor skeleton with `mode` and `work` parallel regions.
4. Implement read-model projection types.
5. Add an explicit XState runtime composition boundary. It may remain opt-in until
   Phases B, D, and G have enough persistence and NoteBox wiring to avoid a
   misleading production switchover.

Exit criteria:

- Runtime can start a supervisor actor through an explicit XState runtime
  boundary.
- Supervisor snapshot round-trip is tested.
- Runtime ownership is explicit: either the branch still uses old dispatchers for
  behavior not yet rebuilt, or card execution is intentionally unavailable until
  later phases. Do not hide this behind a bridge.

Current status: structurally complete. The XState runtime has an opt-in
composition factory, but production server startup still defaults to the old core
until message/tool persistence and `changed` handling are closed.

### Phase B: Provider Turn And Generic LLMRunner

Work:

1. Add `xstate` as a runtime dependency. Pin to XState v5-style actors and
   machine setup; v4 has a different actor API and snapshot model.
2. Replace role-specific agent invocation orchestration with a provider/model turn
   primitive usable by LLMRunner. The concrete interface is `LlmInvocationInput`:
   CardRunner prepares and persists an input envelope containing system prompt
   reference, episode context (card id, workspace, parent, children, review
   context, delivered note ids), and the model call parameters. LLMRunner loads
   it by id and calls the provider.
2. Define `LlmInvocationInput` envelopes. Persist only the minimal envelope or
   message reference needed for restart diagnostics and exactly-one tool delivery;
   do not build a generic queue or event-sourcing layer.
3. Implement generic LLMRunner states: `done`, `running`, `waiting_for_tool`.
4. Emit only generic outputs: `LLM_TOOL_CALL`, `LLM_RESULT`, `LLM_ERROR`.
5. Persist before provider calls, after provider responses/errors, after tool
   calls, after tool results/errors, and at wait-state transitions.
6. Add minimal admission here: one provider-call permit owned by supervisor. Full
   queueing/pause polish can come later, but provider calls must not bypass the
   admission boundary.
7. Remove or rewrite AgentSession active-status logic that conflicts with actor
   ownership.

Exit criteria:

- LLMRunner can run a model turn from an input envelope and persist enough
  turn-boundary metadata to explain or safely fail after a restart.
- No role-specific planner/executor/reviewer policy lives inside LLMRunner.
- Provider calls go through supervisor admission, even if the initial permit
  implementation is simple.

Current status: generic LLMRunner, provider adapter, and admission are complete.
Turn-boundary message/tool persistence is not complete and is the next Phase B/D
gap to close.

### Phase C: Terminal CardRunner And Required Executor Tools

Work:

1. Implement terminal CardRunner `START -> executing -> done`.
2. CardRunner transitions public card status, owns `executor:<card>`, persists
   executor input, and classifies executor `LLM_RESULT` into `TERMINAL_OUTCOME`.
3. Rewrite evidence registration and terminal commit paths as CardRunner actions
   or domain services with no dependency on old active-run state.
4. Implement only the executor tools required for the app to perform real
   terminal work. If a tool is old-core baggage and no current executor needs it,
   leave it out. Process execution counts: if a terminal executor needs to run a
   subprocess, implement ProcessRunner here because the LLMRunner must be able to
   start a process, wait for it with a timeout, and then decide whether to keep
   waiting, inspect partial output, kill the process, or move on.
5. ProcessRunner is not a simple completion wrapper. A process timeout returns
   control to the LLMRunner without killing the process. The LLMRunner decides
   what to do next: wait again, read partial output, kill the process, or treat
   it as failed. This requires ProcessRunner to track a running subprocess as a
   real background actor, not just a flag on a tool-call ledger entry.
6. Implement executor recovery from interrupted `running` and
   `waiting_for_tool(process)` states.

Exit criteria:

- A terminal card executes through actors only.
- No `ExecutorActivationDispatcher` path remains.
- Required executor tool calls are handled by the actor core. Unsupported old
  tools fail clearly rather than going through old runtime glue.

### Phase D: Tool Protocol Completion

Work:

1. Complete ProcessRunner capabilities not already needed by Phase C: detach and
   reattach to a running process after dirty shutdown, kill on LLMRunner request,
   read partial output, and report timeout or completion with exactly-one
   terminal delivery.
2. LLMRunner persists assistant tool calls and a minimal delivery record before
   external work starts.
3. ProcessRunner records terminal process result/error before the owning runner
   delivers the result to the next model turn.
4. Enforce exactly-one matching tool result/error for every assistant tool call.
   Start with in-process plus append-only delivery records; add richer recovery
   only when a concrete dirty-shutdown path needs it.

Exit criteria:

- Process tools are actor-owned.
- Dirty shutdown around process start/result/delivery is recoverable.

Current status: process tools are actor-owned for the happy path and timeout path.
Dirty-shutdown reattachment and exactly-one persisted delivery are still open.

### Phase E: Parent/Child Card Activation

Work:

1. Implement `activate_card` as LLMRunner output plus CardRunner validation.
2. Parent LLMRunner persists `waiting_for_tool(child_card)` before the child
   starts.
3. RuntimeSupervisor starts or retrieves `card:<child>`.
4. Parent CardRunner sends `START`; child CardRunner sends exactly one terminal
   activation outcome.
5. Parent LLMRunner appends exactly one matching tool result/error and resumes
   from a persisted envelope.
6. Delete old runtime activation arrays and activation unwind logic from active
   state.

Note: Phase E is unit-testable with mock child outcomes, but the first real
end-to-end test where a planner activates a child and receives its result requires
at least a minimal Phase F planner.

Exit criteria:

- Parent planners receive child outcomes without scanning sessions or runtime
  activation records.
- `PendingActivationDispatcher` and live `ActivationUnwindRunner` behavior are
  gone.

### Phase F: Goal Planning Minimum

Work:

1. Implement goal CardRunner `planning` phase with owned `planner:<goal>`.
2. Rewrite planner context/prompt assembly as input-envelope construction.
3. CardRunner classifies planner `LLM_RESULT` into continue, replan, blocked,
   failed, or `REVIEW_READY` self-events.
4. Persist classified self-event decisions before sending the self-event.
5. Move retry budgets and iteration counters into CardRunner context.
6. Delete planner process-local loop logic.
7. Move only planner tools required for current goal execution. Tools whose only
   purpose was old runtime maintenance should be omitted.

Exit criteria:

- Goal planning no longer runs through `RuntimePlannerDispatcher` or phase
  runners.
- Planner boundaries are recoverable from CardRunner/LLMRunner state.

### Phase G: Reviewer And NoteBox Minimum

Work:

1. Implement `planning -> reviewing` through `REVIEW_READY`.
2. CardRunner owns `reviewer:<goal>` and classifies reviewer `LLM_RESULT` into
   `REVIEW_PASSED`, `REVIEW_NEEDS_CORRECTIONS`, or `REVIEW_FAILED`.
3. Guard `REVIEW_PASSED` with NoteBox pending-note checks. NoteBox starts as a
   CardRunner-owned data structure: a set of delivered note ids and a list of
   pending notes. Idempotent delivery by note id is the only initial requirement.
4. Route reviewer corrections through NoteBox and return to `planning` until
   retry exhaustion.
5. Convert `changed` edits into NoteBox entries for the owning goal while public
   card status stays `running` for active XState-owned work. Do not keep the old
   synthetic planner-note queue as the final owner of this behavior.
6. Delete reviewer dispatcher and synthetic live planner-note routing.

Exit criteria:

- Reviewer pass/fail/correction behavior is CardRunner-owned.
- ProcessRunner provides exactly-one terminal delivery and can be reattached after
  dirty shutdown if the process is still running. A process timeout returns control
  to the LLMRunner without killing the process. The LLMRunner decides whether to
  keep waiting, inspect partial output, kill the process, or abandon it.
- Note delivery is idempotent by note id. NoteBox starts as a CardRunner-owned
  data structure. Only extract it into a separate persisted module if it grows
  real persistence or recovery complexity.
- CardRunner `cancelling` is a transient cleanup phase. For the initial
  implementation, it transitions immediately to `done` with `cancelled` public
  card status. Add real cancellation owned-work cleanup if actual cancellation
  sequences require it.
- Planner iteration exhaustion (hitting the budget) transitions CardRunner to
  `done` with `blocked` or `failed` public card status, same as the current
  `terminateIfNonTerminal`. No separate mechanism is needed.
- `changed` card edits become NoteBox entries delivered to the owning planner.
  This is not optional — `changed` is a current product status and NoteBox must
  handle it.

Current status: reviewer and in-memory NoteBox delivery are implemented. The
`changed` edit integration is not yet implemented and should happen before the
production runtime switchover.

### Phase H: Supervisor Lifecycle Completion

Work:

1. Move actor snapshots from the early single-file test layout to a small
   per-actor layout that can support targeted recovery.
2. Implement full startup `RECOVER` sequence.
3. Rebuild actor tree from snapshots and domain records.
4. Verify tree consistency before normal event processing.
5. Expand the minimal admission boundary from Phase B: one provider call at a time
   continues to be sufficient. Only add queuing or permit pools if a real product
   need appears.
6. Implement collaborative quiescence: supervisor enters `paused` only after
   actors persist safe pausable state and acknowledge `QUIESCE`.
7. Implement cancellation and shutdown ordering: CardRunner stops owned
   LLMRunners; ProcessRunner reconciles or records bounded abandonment.
8. Remove old lifecycle pause booleans, dispatch promises, scheduled redispatch,
   and runtime tick ownership.

Exit criteria:

- RuntimeSupervisor is the only dispatcher and lifecycle owner.

Current status: not started beyond the supervisor skeleton and simple admission.
Do not start broad recovery until the actor snapshot layout and LLM/tool delivery
logs exist.

### Phase I: API/UI, Analyst, And Tool Surface Rewrite

Work:

1. Rewrite runtime-control server routes to command RuntimeSupervisor.
2. Rewrite state/debug API responses to use read-model projections.
3. Rewrite web stores and panels that relied on old active-run/session fields.
4. Expose stable Saivage terms only: public card status, `runnerPhase`,
   `agentPhase`, `pauseMode`, actor diagnostics, message logs, and process
   records.
5. Rewrite planner, executor, reviewer, and analyst tool read paths that depended
   on old `RuntimeState` fields. Keep only current product tools.
6. Reassess the analyst implementation. It must remain separate from CardRunner,
   but it may become an AnalystRunner XState actor if that gives cleaner
   conversation lifecycle, provider admission, cancellation, or recovery than the
   current non-actor path.
7. Ensure no API/UI contract exposes raw XState state values, snapshots, event
   queues, or framework terminology.

Exit criteria:

- Operator surfaces work against the new actor runtime directly.
- No bridge model converts old runtime state to new UI state.
- Analyst remains usable as a separate operator assistant. If rebuilt with
  XState, it is owned by an analyst/runtime supervisor path, not by CardRunner.

### Phase J: Final Tree Cleanup

Work:

1. Verify obsolete dispatcher, phase-runner, session-active-status, activation
   unwind, and runtime tick code were deleted as their replacement phases landed.
2. Delete tests that only assert old orchestration, old runtime state repair,
   old dispatch ledgers, old session-active ownership, or old compatibility
   behavior.
3. Rewrite tests only when they assert current product behavior that is not
   already protected elsewhere. Prefer narrow actor/domain/API tests over broad
   end-to-end harnesses.
4. Remove obsolete schemas and runtime state fields.
5. Update docs that describe old dispatcher/session behavior.
6. Run import-boundary checks to ensure old runtime modules are not reachable.

Exit criteria:

- The codebase has one runtime architecture.
- No final adapter, bridge, compatibility shim, or old-state migration remains.

Deletion is not supposed to wait until Phase J. Each phase should delete the old
runtime owner it replaces as soon as the new minimal behavior is covered. Phase J
is only the final sweep for missed imports, stale schemas, obsolete tests, and
documentation drift.

Current final-cleanup posture after the old-harness retrospective:

- The remaining old harness files are not automatically rewrite targets. Treat
  them as file-local triage targets: some are mostly obsolete, some contain
  valuable direct unit/security coverage, and some contain both.
- If a file mostly validates old dispatch/run-ledger/session mechanics, delete it
  and rely on focused XState/domain tests for live behavior.
- If a file contains valid direct unit/API/security tests, preserve those tests
  without dragging the old runtime harness along.
- If a product behavior is still valid and lacks coverage, add one small test at
  the ownership boundary that now owns the behavior. Do not rebuild a miniature
  version of `createRuntimeCoreTestContainer`.

## 8. Old Responsibility Triage

| Old responsibility | New action |
| --- | --- |
| Terminal executor dispatch | Rebuild as Terminal CardRunner + executor LLMRunner |
| Managed process wait/delivery | Rebuild as ProcessRunner: background process actor that starts a subprocess, reports timeout without killing it, and gives LLMRunner control to keep waiting, inspect output, kill, or abandon |
| `activate_card` recursive dispatch | Rebuild as parent/child CardRunner messaging |
| Parent tool-result unwind | Rebuild as LLMRunner delivery ledger |
| Planner iteration loop | Rebuild minimum viable goal CardRunner + planner LLMRunner |
| Reviewer handoff and correction loop | Rebuild minimum viable reviewer phase |
| Synthetic live planner notes | Replace with NoteBox; `changed` card edits become NoteBox entries delivered to the owning planner |
| Runtime pause booleans | Replace with RuntimeSupervisor mode; no boolean port |
| Dispatch in-flight maps | Delete; actor registry and deterministic ids cover ownership |
| Scheduled redispatch | Delete unless a current product need reappears |
| Active run API fields | Replace with read-model projections only if UI needs them |
| Role-specific AgentSession ownership | Delete; LLMRunner owns conversation advancement |
| Runtime activation arrays | Delete; parent/child waits and delivery records cover required behavior |
| Old startup active-run repair | Delete; implement actor recovery from new persisted state |
| Analyst non-card conversations | Reassess; keep non-card, but XState actor ownership is allowed if cleaner |

## 9. Testing Strategy

Required test themes:

- Deterministic actor ids and snapshot round-trip.
- Public card status transitions remain valid.
- LLMRunner emits only generic outputs.
- CardRunner classifies outputs through persisted self-events.
- Every assistant tool call receives exactly one matching tool result/error.
- Dirty shutdown loses at most in-memory events, not completed durable
  boundaries.
- Recovery repairs forward when unambiguous and fails/blocks explicitly when
  ambiguous.
- Pause reaches `paused` only after durable quiescence acknowledgements.
- API/UI read models never expose raw XState snapshots.
- Import-boundary tests prove old dispatcher modules are not used.
- Unsupported old tools or runtime commands fail clearly instead of falling back
  to old-core behavior.

Non-goals for testing:

- No compatibility tests for old `.saivage` runtime state, old run-ledger shapes,
  old activation arrays, or old active-session ownership.
- No broad harness whose value is only that it exercises many old runtime layers
  at once.
- No adapter tests that prove old dispatcher behavior still works after the XState
  runtime is the default.

Use focused tests while building each phase, then run broad validation before the
replacement branch is considered complete:

```bash
npm run validate:routine
npm test
npm run validate:ui-smoke
```

Run `npm run validate:ui` when API/UI read models change substantially, and
`npm run validate:release` before merging the full replacement.

Intermediate construction commits may intentionally break or delete old runtime
tests after the old owner has been disconnected. In that case, keep focused
new-core tests green, delete obsolete old-core tests promptly, and do not treat a
broad suite failure caused only by deleted old behavior as a reason to preserve
old glue.

## 10. Commit Cadence

Commit by construction phase or by coherent subphase. It is acceptable for
intermediate commits on the replacement branch to remove old runtime behavior
before the new runtime is complete, provided the commit message and tests make
that explicit.

Prefer this cadence:

1. Remove or disconnect old runtime owner for the area being rebuilt.
2. Add new actor/domain implementation.
3. Add product-behavior tests through the new boundary.
4. Delete temporary scaffolding before leaving the phase.
5. Run the relevant focused validation.

Do not merge a state where old and new runtime paths coexist through permanent
translation glue or bridge modules.

## 11. Stop Conditions

Pause and update the XState design if any of these happen:

- XState snapshots cannot be represented as simple Saivage-owned JSON schemas.
- Actor messaging makes exactly-one `activate_card` delivery unclear.
- Recovery requires persisting private XState internals or in-memory queues.
- API/UI needs raw XState concepts to explain runtime state.
- LLMRunner cannot stay role-generic without hiding role policy in provider
  plumbing.
- Temporary scaffolding starts becoming a permanent bridge.
- A layer is being reintroduced primarily because it existed in the old core,
  rather than because a current product behavior needs it and the ownership model
  was re-evaluated.

If a stop condition is hit, update both this plan and the XState draft before
continuing implementation.
