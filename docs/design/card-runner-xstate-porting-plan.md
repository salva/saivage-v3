# Card Runner XState Porting Plan

Status: implementation planning draft. This document explains how to port the
current Saivage v3 runtime to the XState architecture described in
[Card Runner XState Rearchitecture Draft](./card-runner-xstate-rearchitecture-draft.md).
It is not a compatibility or migration plan for old `.saivage` runtime state.

## 1. Goal

Replace the current planner/reviewer/executor dispatcher stack with persistent
XState actors while preserving Saivage domain behavior:

- Cards remain canonical domain records.
- Public card status remains the operator/API lifecycle.
- CardRunner owns card activation phase: `planning`, `reviewing`, `executing`,
  `done`, or `cancelling`.
- LLMRunner is role-generic and owns provider/tool protocol state.
- ProcessRunner owns durable external process state.
- RuntimeSupervisor owns admission, pause/quiescence, recovery, and actor tree
  lifecycle.

The port should remove old runtime code as it is replaced. Do not keep a long
term dual runtime, feature flag, or backward-compatible legacy state reader.

## 2. Current Code To Replace

The main old-runtime seams are:

- `src/runtime/runtime-planner-dispatcher.ts`: owns the current planner loop,
  retry budget, reviewer handoff, pause checks, and direct planner runs.
- `src/runtime/pending-activation-dispatcher.ts`: recursively dispatches child
  goal and terminal activations after `activate_card`.
- `src/runtime/executor-activation-dispatcher.ts`: starts terminal card
  execution, records active run ownership, runs executor, registers evidence,
  commits terminal lifecycle, and unwinds parent tool results.
- `src/runtime/runtime-reviewer-dispatcher.ts`: starts reviewer sessions,
  validates reviewer results, commits goal lifecycle, and returns corrections to
  planner control.
- `src/runtime/activation-unwind.ts`: finds unresolved `activate_card` calls,
  appends parent tool results, and repairs orphaned activation results.
- `src/runtime/session-persistence.ts`: stores role-specific AgentSession JSON
  and message JSONL, enforces the current global single-active-non-analyst
  invariant, and marks sessions waiting/done.
- `src/runtime/state-machine.ts` and `src/runtime/runtime-core.ts`: maintain the
  current runtime patch reducer, scheduled ticks, redispatch, and public card
  lifecycle transitions.
- `src/agents/agent-adapter.ts`: currently exposes role-specific planner,
  executor, reviewer, and analyst invocation methods. The port keeps the
  provider adapter surface but moves role orchestration out of dispatcher loops
  and into CardRunner/LLMRunner actors.

The porting strategy is to introduce the new actor runtime beside the old code
for one slice at a time, then delete each replaced old seam in the same slice or
the immediately following cleanup slice.

## 3. Target Runtime Modules

Create a new `src/runtime/actors/` area with these initial modules:

- `runtime-supervisor.ts`: root XState actor, actor registry, admission permits,
  pause/quiescence, startup recovery, shutdown, and child actor lifecycle.
- `card-runner.ts`: CardRunner machine and actions for public card status
  transitions, phase transitions, NoteBox delivery, parent/child activation
  outcomes, and self-event classification.
- `llm-runner.ts`: generic LLMRunner machine for persisted input envelopes,
  provider invocation, tool-call ledger transitions, tool results/errors, and
  generic output events.
- `process-runner.ts`: durable process actor with `running` and `done` states,
  process reattach/reconcile, and exactly-one terminal delivery.
- `persistence.ts`: Saivage-owned XState snapshot read/write helpers, JSONL
  append helpers, and index-manifest helpers.
- `ids.ts`: deterministic actor ids such as `card:<id>`, `planner:<card>`,
  `reviewer:<card>`, `executor:<card>`, and `process:<id>`.
- `read-model.ts`: projection from actors/domain state into API/UI fields such
  as `runnerPhase`, `agentPhase`, and `pauseMode` without exposing raw XState
  snapshots.

Keep existing domain modules for cards, lifecycle commits, evidence validation,
observability, skills, and provider adapters unless a slice proves they must be
reshaped.

## 4. Persistence Cutover

The first implementation work is a persistence foundation, not actor behavior.
Add new stores under `.saivage/runtime/actors/` and `.saivage/agents/` using the
draft's JSON/JSONL model:

```text
.saivage/runtime/actors/supervisor.json
.saivage/runtime/actors/card/<card-id>.json
.saivage/runtime/actors/llm/<agent-id>.json
.saivage/runtime/actors/process/<process-id>.json
.saivage/runtime/events.jsonl
.saivage/agents/messages/<agent-id>.index.json
.saivage/agents/messages/<agent-id>.<segment>.jsonl
.saivage/agents/tool-deliveries/<agent-id>.jsonl
```

Rules:

- New actor snapshots are Saivage-owned schemas, not opaque framework internals.
- Do not read old active session state as recoverable actor state.
- Startup rejects or explicitly fails incompatible old runtime state instead of
  migrating it.
- Agent message history may keep the existing JSONL shape initially if the new
  LLMRunner owns all appends and durable boundaries.
- The global single-active-non-analyst-session invariant goes away when the
  terminal-card slice lands; concurrency is then represented by actor ownership
  and admission permits.

## 5. Slice 0: Dependency And Skeleton

Purpose: add XState without changing runtime behavior.

Work:

1. Add `xstate` as a runtime dependency.
2. Add actor id helpers and minimal persisted snapshot schemas.
3. Add empty RuntimeSupervisor/CardRunner/LLMRunner machines with tests proving
   deterministic ids and snapshot round-trip.
4. Add `read-model.ts` projection types but do not expose them through API yet.

Validation:

- `npm run typecheck`
- Focused actor persistence tests
- `npm run validate:docs`

Exit criteria:

- Old runtime behavior is unchanged.
- New actor modules compile and persist/reload simple snapshots.

## 6. Slice 1: Terminal Card Execution

Purpose: prove `START -> executing -> done` for one terminal card.

Replace:

- The terminal path inside `ExecutorActivationDispatcher.dispatch` for operator
  or parent-activation execution.

Keep temporarily:

- Existing evidence registration and terminal commit helpers.
- Existing AgentAdapter provider invocation implementation.

Work:

1. Implement TerminalCardRunner `START` action.
2. CardRunner transitions the public card to `running`, creates or reuses
   `executor:<card>`, persists `LlmInvocationInput`, and sends `RUN_TURN`.
3. LLMRunner invokes the current executor adapter through a narrow provider port.
4. LLMRunner emits generic `LLM_RESULT` or `LLM_ERROR`.
5. CardRunner classifies the result into `TERMINAL_OUTCOME`, reuses current
   evidence validation and terminal commit helpers, then enters `done`.
6. Persist actor snapshots before each durable boundary.
7. Add recovery tests for restart while executor LLMRunner is `running` and while
   it is `waiting_for_tool(process)`.

Delete or shrink:

- Remove terminal execution responsibility from `ExecutorActivationDispatcher`.
  Leave only a short adapter that sends `START` to `card:<id>` until the parent
  activation slice deletes it entirely.

Validation:

- Focused executor/CardRunner tests
- Existing executor completion/evidence tests
- `npm run validate:routine`

Exit criteria:

- A terminal card can run to terminal status through XState actors.
- API/UI still see public card status and existing evidence fields.
- No raw XState snapshots are exposed.

## 7. Slice 2: Process Tool Calls

Purpose: move external process execution out of ad hoc LLM/tool handling.

Replace:

- Any executor/planner tool path that starts a managed process and waits for the
  result.

Work:

1. Implement ProcessRunner with durable process records and `deliveryStatus`.
2. LLMRunner persists assistant tool call and wait state before ProcessRunner
   starts.
3. ProcessRunner records terminal result/error before sending
   `APPEND_TOOL_RESULT` or `APPEND_TOOL_ERROR`.
4. Recovery reattaches or reconciles process state and delivers exactly one
   terminal tool result/error.

Validation:

- ProcessRunner unit tests for success, failure, cancellation, dirty shutdown,
  duplicate delivery, and missing process record.
- Focused LLMRunner tool-protocol tests.

Exit criteria:

- Terminal cards can use process tools without old dispatcher involvement.

## 8. Slice 3: Parent Planner `activate_card` Waits

Purpose: replace pending activation recursion with actor parent/child messaging.

Replace:

- `PendingActivationDispatcher`.
- Most `ActivationUnwindRunner` responsibility for live activations.

Work:

1. LLMRunner emits `LLM_TOOL_CALL` for `activate_card` only after persisting the
   assistant tool call and `waiting_for_tool(child_card)` state.
2. Parent CardRunner validates the child can start and asks RuntimeSupervisor to
   start or retrieve `card:<child>`.
3. Parent CardRunner sends `START` to child CardRunner and remains `planning`.
4. Child CardRunner sends exactly one activation outcome to the parent when it
   enters `done`.
5. Parent LLMRunner appends exactly one matching tool result/error and resumes
   from a persisted input envelope.
6. Recovery reconciles parent wait state with child card/runner state before
   normal event processing.

Delete or shrink:

- Delete `PendingActivationDispatcher` after planner dispatch no longer calls
  it.
- Keep only small historical repair helpers from `activation-unwind.ts` if tests
  still need them; otherwise delete live unwind paths.

Validation:

- Parent/child actor tests for terminal child done/failed/blocked.
- Duplicate `activate_card` delivery tests.
- Dirty shutdown tests at each boundary: before child start, after child start,
  after child terminal, after parent delivery.

Exit criteria:

- Parent planners see one tool result/error per `activate_card` without scanning
  old runtime activation arrays.

## 9. Slice 4: Goal Planning Loop

Purpose: move planner iteration from `RuntimePlannerDispatcher` into CardRunner
and LLMRunner.

Replace:

- `PlannerActivationRunner` and `PlannerIterationRunner` orchestration from
  `runtime-planner-dispatcher.ts`.

Keep temporarily:

- Existing planner prompt/context builders.
- Existing planner failure handling helpers, reshaped into CardRunner actions.

Work:

1. Goal CardRunner starts in `planning`, creates `planner:<goal>`, and sends
   `RUN_TURN` with a persisted input envelope.
2. LLMRunner returns generic outputs only.
3. CardRunner classifies planner reports into continue, replan, blocked, failed,
   or `REVIEW_READY` self-event.
4. Planner no-progress recovery remains inside LLMRunner and does not expose
   provider/account diagnostics to model context.
5. Retry budgets and iteration counters become CardRunner context persisted at
   every durable boundary.

Delete or shrink:

- Replace `RuntimePlannerDispatcher.dispatchGoal` with a supervisor call that
  sends `START` or `RESUME` to `card:<goal>`.
- Delete planner loop code after equivalent actor tests pass.

Validation:

- Planner classification tests.
- Existing planner tool contract tests.
- Goal CardRunner recovery tests for lost self-events and interrupted planner
  turns.

Exit criteria:

- Goal planning no longer runs as a process-local `for` loop.
- Planner turn boundaries are recoverable from persisted LLMRunner/CardRunner
  state.

## 10. Slice 5: Reviewer Phase And NoteBox

Purpose: move reviewer handoff and correction loops into CardRunner, then add
NoteBox delivery semantics.

Replace:

- `RuntimeReviewerDispatcher`.
- Synthetic planner notes as a live delivery mechanism.

Work:

1. CardRunner transitions `planning -> reviewing` through `REVIEW_READY`.
2. CardRunner creates or reuses `reviewer:<goal>` and sends `RUN_TURN`.
3. CardRunner classifies reviewer `LLM_RESULT` into `REVIEW_PASSED`,
   `REVIEW_NEEDS_CORRECTIONS`, or `REVIEW_FAILED` self-events.
4. `REVIEW_PASSED` is guarded by NoteBox: pending planner-visible notes divert
   back to `planning`; otherwise the goal commits terminal done.
5. `REVIEW_NEEDS_CORRECTIONS` appends correction context and returns to
   `planning` until retry exhaustion.
6. Active edits become NoteBox entries; running cards stay publicly `running`.
7. Note delivery is idempotent by note id and persisted before `RUN_TURN`.

Delete or shrink:

- Delete `RuntimeReviewerDispatcher` after all reviewer result decisions are
  CardRunner self-events.
- Remove synthetic planner-note live routing if NoteBox covers its use cases.

Validation:

- Reviewer pass/fail/needs-corrections tests.
- NoteBox delivery and dirty shutdown tests.
- Active edit tests for inactive versus running cards.

Exit criteria:

- Reviewer retry and note-driven replan behavior are actor-owned.

## 11. Slice 6: RuntimeSupervisor Cutover

Purpose: make RuntimeSupervisor the only dispatcher and lifecycle owner.

Replace:

- Scheduled redispatch/tick ownership in `RuntimeStateMachine`.
- `lifecycle.dispatchPromises`, `dispatchInFlight`, and global pause booleans as
  dispatch-control primitives.

Work:

1. Runtime startup creates RuntimeSupervisor and sends `RECOVER`.
2. Supervisor reconstructs CardRunner, LLMRunner, and ProcessRunner actors from
   persisted snapshots and domain state.
3. Supervisor owns parallel `mode` and `work` regions: running, quiescing,
   paused, stopping, ready, model invocation active, and recovering.
4. Admission permits gate each provider call, not each card.
5. Pause sends `QUIESCE` to active actors and enters `paused` only after durable
   acknowledgements.
6. Shutdown stops owned child actors in order: CardRunner stops owned LLMRunners;
   ProcessRunner reconciles or marks bounded abandonment.

Delete or shrink:

- Keep `RuntimeStateMachine.transitionCard` only if it remains the best public
  card lifecycle policy adapter. Delete runtime dispatch/tick behavior from it.
- Remove old lifecycle dispatch promise maps.

Validation:

- Supervisor recovery tests.
- Pause/resume/quiescence tests.
- Admission permit tests for multiple simultaneous cards.

Exit criteria:

- No old dispatcher starts planner/reviewer/executor work.

## 12. Slice 7: API/UI Read Model

Purpose: expose the new runtime without leaking XState concepts.

Replace:

- Any API/UI dependence on old runtime fields that described active run/session
  ownership rather than Saivage domain state.

Work:

1. Add read-model projection from CardRunner/LLMRunner/RuntimeSupervisor state.
2. Expose stable Saivage fields only: `runnerPhase`, `agentPhase`, `pauseMode`,
   current actor diagnostics, and public card status.
3. Keep agent message display backed by Saivage message logs, not XState
   snapshots.
4. Update web stores/tests to consume projections.

Validation:

- API contract tests.
- `npm run web:test:operator-smoke`
- Relevant web store tests.

Exit criteria:

- Operator surfaces show actor progress without exposing XState state values,
  actor snapshots, event queues, or framework terminology.

## 13. Slice 8: Old State Removal

Purpose: remove old runtime artifacts once the actor path is complete.

Work:

1. Delete obsolete runtime activation arrays and active-card-run fields from new
   runtime writes.
2. Delete old dispatcher files and tests that only assert old orchestration.
3. Delete orphaned session-reconciliation paths that conflict with actor
   recovery.
4. Update docs that describe old dispatcher behavior.
5. Keep no migration path for old `.saivage`; startup should fail closed or
   require reset when old incompatible state exists.

Validation:

- `npm run validate:routine`
- `npm test`
- `npm run validate:ui-smoke`

Exit criteria:

- The codebase has one runtime architecture.
- Old state files are not read as active runtime state.

## 14. Replacement Matrix

| Old responsibility | New owner | First slice |
| --- | --- | --- |
| Terminal executor dispatch | Terminal CardRunner + executor LLMRunner | Slice 1 |
| Managed process wait/delivery | ProcessRunner + LLMRunner wait state | Slice 2 |
| `activate_card` recursive dispatch | Parent/child CardRunner messaging | Slice 3 |
| Parent tool-result unwind | LLMRunner delivery ledger | Slice 3 |
| Planner iteration loop | Goal CardRunner + planner LLMRunner | Slice 4 |
| Reviewer handoff and correction loop | Goal CardRunner + reviewer LLMRunner | Slice 5 |
| Synthetic live planner notes | NoteBox | Slice 5 |
| Runtime pause booleans | RuntimeSupervisor parallel `mode` region | Slice 6 |
| Dispatch in-flight maps | Actor registry and deterministic ids | Slice 6 |
| Scheduled redispatch | Supervisor recovery/admission/event routing | Slice 6 |
| Active run API fields | Read-model projections | Slice 7 |

## 15. Testing Strategy

Each slice needs unit tests at the actor boundary and at least one integration
test through the existing runtime command/API surface.

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

## 16. Commit And Validation Cadence

Commit each slice separately. Prefer this cadence:

1. Add narrow actor/persistence code plus focused tests.
2. Port one old responsibility.
3. Delete or shrink the old code now made redundant.
4. Run focused tests.
5. Run `npm run validate:routine` for runtime slices.
6. Run `npm run validate:ui-smoke` when API/UI read models change.
7. Run `npm test` before deleting old dispatcher families or changing recovery.

Do not batch multiple slices into one commit. If a slice reveals the XState glue
is more complex than the custom-core fallback, stop and reassess before porting
the next dispatcher.

## 17. Stop Conditions

Pause the port and revisit the architecture if any of these happen:

- XState snapshots cannot be represented as simple Saivage-owned JSON schemas.
- Actor messaging makes exactly-one `activate_card` delivery less clear than the
  current explicit unwind logic.
- Recovery requires persisting private XState internals or in-memory queues.
- The API/UI needs raw XState concepts to explain runtime state.
- The first terminal-card slice needs extensive adapter glue before it can commit
  `START -> executing -> done`.

If a stop condition is hit, update both this plan and the XState draft before
continuing implementation.
