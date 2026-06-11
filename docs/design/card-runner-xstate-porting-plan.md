# Card Runner XState Replacement Plan

Status: implementation planning draft. This document explains how to build a new
minimal Saivage v3 runtime core around the XState architecture described in
[Card Runner XState Rearchitecture Draft](./card-runner-xstate-rearchitecture-draft.md).
It is not a one-for-one porting plan for the old runtime, not a bridge plan, and
not a migration plan for old `.saivage` runtime state.

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
- `process-runner.ts`: durable process actor with `running` and `done` states,
  process reattach/reconcile, cancellation, and exactly-one terminal delivery.
- `notebox.ts`: idempotent note storage, delivery, consumption, and recovery
  reconciliation.
- `persistence.ts`: Saivage-owned actor snapshot schemas, JSONL append helpers,
  atomic JSON writes, and index-manifest helpers.
- `ids.ts`: deterministic actor ids such as `card:<id>`, `planner:<card>`,
  `reviewer:<card>`, `executor:<card>`, and `process:<id>`.
- `read-model.ts`: projection from actors/domain state into API/UI fields without
  exposing raw XState state.

Additional actors are allowed when they simplify real lifecycle ownership. Do not
add generic actor layers "because XState is available," but do consider XState
for long-lived non-card workflows such as analyst conversations, MCP/server
connections, operator command execution, or durable background reconciliation if
they need explicit states, cancellation, pause/quiescence, or recovery.

The rest of the runtime should depend on this package-level boundary instead of
reaching into individual actor internals.

## 6. Persistence Model

Implement new persistence before full behavior:

```text
.saivage/runtime/actors/supervisor.json
.saivage/runtime/actors/card/<card-id>.json
.saivage/runtime/actors/llm/<agent-id>.json
.saivage/runtime/actors/process/<process-id>.json
.saivage/runtime/events.jsonl
.saivage/agents/messages/<agent-id>.index.json
.saivage/agents/messages/<agent-id>.<segment>.jsonl
.saivage/agents/tool-deliveries/<agent-id>.jsonl
.saivage/cards/<card-id>/notes.jsonl
```

Rules:

- Actor snapshots are Saivage-owned schemas, not opaque framework internals.
- Startup does not migrate old active runtime state.
- Incompatible old `.saivage` runtime state should fail closed with an operator
  reset instruction or be explicitly marked failed/abandoned if safe.
- Message logs and tool-call histories are append-only JSONL.
- Compact JSON snapshots are fast-start state, not the only audit trail.
- Companion index manifests identify current log segments and current versioned
  domain files.
- The global single-active-non-analyst-session invariant is removed; concurrency
  is controlled by actor ownership and admission permits.

## 7. Build Order

These are construction phases for a minimal new core. They are not a checklist of
old-runtime features to port. Each phase should leave the new runtime internally
coherent for the behavior it owns. The old runtime does not need to keep working
during the replacement branch if that makes implementation simpler.

### Phase A: Minimal Runtime Shell

Work:

1. Add `xstate` as a runtime dependency.
2. Add actor ids, snapshot schemas, JSON/JSONL persistence primitives, and event
   append helpers.
3. Implement RuntimeSupervisor skeleton with `mode` and `work` parallel regions.
4. Implement read-model projection types.
5. Wire server startup/shutdown to RuntimeSupervisor for the new core. If old
   dispatcher startup wiring is disconnected here, document that card execution
   remains unavailable until the terminal/goal phases land.

Exit criteria:

- Runtime starts a supervisor actor.
- Supervisor snapshot round-trip is tested.
- Runtime ownership is explicit: either the branch still uses old dispatchers for
  behavior not yet rebuilt, or card execution is intentionally unavailable until
  later phases. Do not hide this behind a bridge.

### Phase B: Provider Turn And Generic LLMRunner

Work:

1. Replace role-specific agent invocation orchestration with a provider/model turn
   primitive usable by LLMRunner.
2. Define and persist `LlmInvocationInput` envelopes.
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

- LLMRunner can run a model turn from a persisted input envelope.
- No role-specific planner/executor/reviewer policy lives inside LLMRunner.
- Provider calls go through supervisor admission, even if the initial permit
  implementation is simple.

### Phase C: Terminal CardRunner And Required Executor Tools

Work:

1. Implement terminal CardRunner `START -> executing -> done`.
2. CardRunner transitions public card status, owns `executor:<card>`, persists
   executor input, and classifies executor `LLM_RESULT` into `TERMINAL_OUTCOME`.
3. Rewrite evidence registration and terminal commit paths as CardRunner actions
   or domain services with no dependency on old active-run state.
4. Implement only the executor tools required for the app to perform real
   terminal work. If a tool is old-core baggage and no current executor needs it,
   leave it out.
5. If real executor work requires process execution, implement the needed
   ProcessRunner subset in this phase instead of waiting for a separate process
   phase.
6. Implement executor recovery from interrupted `running` and
   `waiting_for_tool(process)` states.

Exit criteria:

- A terminal card executes through actors only.
- No `ExecutorActivationDispatcher` path remains.
- Required executor tool calls are handled by the actor core. Unsupported old
  tools fail clearly rather than going through old runtime glue.

### Phase D: Tool Protocol Completion

Work:

1. Complete ProcessRunner capabilities not already needed by Phase C: durable
   records, cancellation, reattach, and terminal delivery status.
2. LLMRunner persists assistant tool calls and wait state before external work
   starts.
3. ProcessRunner records terminal process result/error before delivering
   `APPEND_TOOL_RESULT` or `APPEND_TOOL_ERROR`.
4. Enforce exactly-one matching tool result/error for every assistant tool call,
   including terminal/reporting tool calls.

Exit criteria:

- Process tools are actor-owned.
- Dirty shutdown around process start/result/delivery is recoverable.

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
3. Guard `REVIEW_PASSED` with NoteBox pending-note checks.
4. Route reviewer corrections through Goal Context/NoteBox and return to
   `planning` until retry exhaustion.
5. Convert active edits into NoteBox entries while public card status stays
   `running`.
6. Delete reviewer dispatcher and synthetic live planner-note routing.

Exit criteria:

- Reviewer pass/fail/correction behavior is CardRunner-owned.
- Note delivery is idempotent and recoverable by note id.

### Phase H: Supervisor Lifecycle Completion

Work:

1. Implement full startup `RECOVER` sequence.
2. Rebuild actor tree from snapshots and domain records.
3. Verify tree consistency before normal event processing.
4. Expand the minimal admission boundary from Phase B into full provider-call
   admission policy.
5. Implement collaborative quiescence: supervisor enters `paused` only after
   actors persist safe pausable state and acknowledge `QUIESCE`.
6. Implement cancellation and shutdown ordering: CardRunner stops owned
   LLMRunners; ProcessRunner reconciles or records bounded abandonment.
7. Remove old lifecycle pause booleans, dispatch promises, scheduled redispatch,
   and runtime tick ownership.

Exit criteria:

- RuntimeSupervisor is the only dispatcher and lifecycle owner.

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
2. Delete tests that only assert old orchestration.
3. Rewrite tests that assert product behavior through new actor boundaries.
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

## 8. Old Responsibility Triage

| Old responsibility | New action |
| --- | --- |
| Terminal executor dispatch | Rebuild as Terminal CardRunner + executor LLMRunner |
| Managed process wait/delivery | Rebuild only required tools with ProcessRunner + LLMRunner wait state |
| `activate_card` recursive dispatch | Rebuild as parent/child CardRunner messaging |
| Parent tool-result unwind | Rebuild as LLMRunner delivery ledger |
| Planner iteration loop | Rebuild minimum viable goal CardRunner + planner LLMRunner |
| Reviewer handoff and correction loop | Rebuild minimum viable reviewer phase |
| Synthetic live planner notes | Replace with NoteBox if still needed |
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

Use focused tests while building each phase, then run broad validation before the
replacement branch is considered complete:

```bash
npm run validate:routine
npm test
npm run validate:ui-smoke
```

Run `npm run validate:ui` when API/UI read models change substantially, and
`npm run validate:release` before merging the full replacement.

Intermediate construction commits may intentionally break old runtime tests after
the old owner has been disconnected. In that case, keep focused new-core tests
green, mark or rewrite obsolete old-core tests promptly, and do not treat a broad
suite failure caused only by deleted old behavior as a reason to preserve old
glue.

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
