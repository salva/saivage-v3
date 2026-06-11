# Card Runner XState Replacement Plan

Status: implementation planning draft. This document explains how to replace the
current Saivage v3 runtime with the XState architecture described in
[Card Runner XState Rearchitecture Draft](./card-runner-xstate-rearchitecture-draft.md).
It is not a progressive compatibility plan, not a bridge plan, and not a
migration plan for old `.saivage` runtime state.

## 1. Goal

Build the new runtime layers cleanly around XState actors and remove the old
dispatcher/session/unwind architecture from the active tree.

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

## 2. Replacement Strategy

Prefer a clean replacement over a progressive port.

The easiest path is likely:

1. Move old runtime orchestration code out of the active import tree.
2. Keep only domain primitives that are still valid: card store, lifecycle
   transition policy, provider configuration, observability sinks, file/process
   primitives, skills/tool definitions, and prompt/context builders if they fit
   the new ownership model.
3. Reimplement runtime orchestration from scratch with RuntimeSupervisor,
   CardRunner, LLMRunner, ProcessRunner, NoteBox, and actor persistence.
4. Rewrite adjacent layers that assume old active-run/session/activation state.
5. Delete any temporary compatibility, bridge, or adapter modules before merge.

This does not require running old and new dispatchers side by side. If an old
layer's shape fights the new architecture, rewrite it instead of adapting around
it.

## 3. Old Code To Remove Or Rewrite

Move these files out of the active runtime path early. They can be deleted
immediately or parked in a temporary branch-local archive while behavior is being
reimplemented, but they should not remain imported by the new runtime:

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
- Runtime state fields that encode old orchestration, especially active run,
  runtime activation arrays, dispatch-in-flight maps, and single-active-session
  assumptions.

Rewrite adjacent layers if they encode old runtime assumptions:

- Server runtime-control routes should command RuntimeSupervisor, not old
  dispatcher methods.
- Operator API state responses should be built from read-model projections, not
  old active-run fields.
- Web stores should consume projected `runnerPhase`, `agentPhase`, `pauseMode`,
  diagnostics, and public card status.
- Agent invocation code should become a provider/model turn primitive used by
  LLMRunner, not a role-specific planner/executor/reviewer orchestration adapter.
- Session/message persistence should become LLMRunner-owned conversation and
  tool-call logs, not global role sessions with process-local active status.

## 4. New Runtime Layers

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

The rest of the runtime should depend on this package-level boundary instead of
reaching into individual actor internals.

## 5. Persistence Model

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

## 6. Build Order

These are construction phases, not a progressive production rollout. Each phase
should leave the new runtime internally coherent. The old runtime does not need
to keep working during the replacement branch if that makes implementation
simpler.

### Phase A: Runtime Shell

Work:

1. Add `xstate` as a runtime dependency.
2. Add actor ids, snapshot schemas, JSON/JSONL persistence primitives, and event
   append helpers.
3. Implement RuntimeSupervisor skeleton with `mode` and `work` parallel regions.
4. Implement read-model projection types.
5. Remove old dispatcher startup wiring from the active server composition and
   replace it with supervisor startup/shutdown placeholders.

Exit criteria:

- Runtime starts a supervisor actor.
- Supervisor snapshot round-trip is tested.
- Old dispatchers are no longer the startup owner.

### Phase B: Generic LLMRunner

Work:

1. Replace role-specific agent invocation orchestration with a provider/model turn
   primitive usable by LLMRunner.
2. Define and persist `LlmInvocationInput` envelopes.
3. Implement generic LLMRunner states: `done`, `running`, `waiting_for_tool`.
4. Emit only generic outputs: `LLM_TOOL_CALL`, `LLM_RESULT`, `LLM_ERROR`.
5. Persist before provider calls, after provider responses/errors, after tool
   calls, after tool results/errors, and at wait-state transitions.
6. Remove or rewrite AgentSession active-status logic that conflicts with actor
   ownership.

Exit criteria:

- LLMRunner can run a model turn from a persisted input envelope.
- No role-specific planner/executor/reviewer policy lives inside LLMRunner.

### Phase C: Terminal CardRunner

Work:

1. Implement terminal CardRunner `START -> executing -> done`.
2. CardRunner transitions public card status, owns `executor:<card>`, persists
   executor input, and classifies executor `LLM_RESULT` into `TERMINAL_OUTCOME`.
3. Rewrite evidence registration and terminal commit paths as CardRunner actions
   or domain services with no dependency on old active-run state.
4. Implement executor recovery from interrupted `running` and
   `waiting_for_tool(process)` states.

Exit criteria:

- A terminal card executes through actors only.
- No `ExecutorActivationDispatcher` path remains.

### Phase D: ProcessRunner And Tool Protocol

Work:

1. Implement ProcessRunner with durable records, cancellation, reattach, and
   terminal delivery status.
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

### Phase F: Goal Planning

Work:

1. Implement goal CardRunner `planning` phase with owned `planner:<goal>`.
2. Rewrite planner context/prompt assembly as input-envelope construction.
3. CardRunner classifies planner `LLM_RESULT` into continue, replan, blocked,
   failed, or `REVIEW_READY` self-events.
4. Persist classified self-event decisions before sending the self-event.
5. Move retry budgets and iteration counters into CardRunner context.
6. Delete planner process-local loop logic.

Exit criteria:

- Goal planning no longer runs through `RuntimePlannerDispatcher` or phase
  runners.
- Planner boundaries are recoverable from CardRunner/LLMRunner state.

### Phase G: Reviewer And NoteBox

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

### Phase H: Supervisor Lifecycle And Admission

Work:

1. Implement full startup `RECOVER` sequence.
2. Rebuild actor tree from snapshots and domain records.
3. Verify tree consistency before normal event processing.
4. Implement admission permits per provider call.
5. Implement collaborative quiescence: supervisor enters `paused` only after
   actors persist safe pausable state and acknowledge `QUIESCE`.
6. Implement cancellation and shutdown ordering: CardRunner stops owned
   LLMRunners; ProcessRunner reconciles or records bounded abandonment.
7. Remove old lifecycle pause booleans, dispatch promises, scheduled redispatch,
   and runtime tick ownership.

Exit criteria:

- RuntimeSupervisor is the only dispatcher and lifecycle owner.

### Phase I: API/UI Rewrite

Work:

1. Rewrite runtime-control server routes to command RuntimeSupervisor.
2. Rewrite state/debug API responses to use read-model projections.
3. Rewrite web stores and panels that relied on old active-run/session fields.
4. Expose stable Saivage terms only: public card status, `runnerPhase`,
   `agentPhase`, `pauseMode`, actor diagnostics, message logs, and process
   records.
5. Ensure no API/UI contract exposes raw XState state values, snapshots, event
   queues, or framework terminology.

Exit criteria:

- Operator surfaces work against the new actor runtime directly.
- No bridge model converts old runtime state to new UI state.

### Phase J: Deletion And Tree Cleanup

Work:

1. Delete obsolete dispatcher, phase-runner, session-active-status, activation
   unwind, and runtime tick code.
2. Delete tests that only assert old orchestration.
3. Rewrite tests that assert product behavior through new actor boundaries.
4. Remove obsolete schemas and runtime state fields.
5. Update docs that describe old dispatcher/session behavior.
6. Run import-boundary checks to ensure old runtime modules are not reachable.

Exit criteria:

- The codebase has one runtime architecture.
- No final adapter, bridge, compatibility shim, or old-state migration remains.

## 7. Replacement Matrix

| Old responsibility | New owner |
| --- | --- |
| Terminal executor dispatch | Terminal CardRunner + executor LLMRunner |
| Managed process wait/delivery | ProcessRunner + LLMRunner wait state |
| `activate_card` recursive dispatch | Parent/child CardRunner messaging |
| Parent tool-result unwind | LLMRunner delivery ledger |
| Planner iteration loop | Goal CardRunner + planner LLMRunner |
| Reviewer handoff and correction loop | Goal CardRunner + reviewer LLMRunner |
| Synthetic live planner notes | NoteBox |
| Runtime pause booleans | RuntimeSupervisor parallel `mode` region |
| Dispatch in-flight maps | Actor registry and deterministic ids |
| Scheduled redispatch | Supervisor recovery/admission/event routing |
| Active run API fields | Read-model projections |
| Role-specific AgentSession ownership | LLMRunner-owned conversation state |
| Runtime activation arrays | Parent/child actor waits and delivery records |

## 8. Testing Strategy

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

Use focused tests while building each phase, then run broad validation before the
replacement branch is considered complete:

```bash
npm run validate:routine
npm test
npm run validate:ui-smoke
```

Run `npm run validate:ui` when API/UI read models change substantially, and
`npm run validate:release` before merging the full replacement.

## 9. Commit Cadence

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
adapters or bridges.

## 10. Stop Conditions

Pause and update the XState design if any of these happen:

- XState snapshots cannot be represented as simple Saivage-owned JSON schemas.
- Actor messaging makes exactly-one `activate_card` delivery unclear.
- Recovery requires persisting private XState internals or in-memory queues.
- API/UI needs raw XState concepts to explain runtime state.
- LLMRunner cannot stay role-generic without hiding role policy in provider
  plumbing.
- Temporary scaffolding starts becoming a permanent bridge.

If a stop condition is hit, update both this plan and the XState draft before
continuing implementation.
