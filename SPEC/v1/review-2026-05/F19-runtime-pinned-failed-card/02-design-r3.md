# F19 — Design (r3)

Supersedes [02-design-r2.md](02-design-r2.md). Changes vs r2 are summarised at the end. Proposal B is still recommended.

## Proposal A — Focused fix (surgical)

### Shape

Three localised changes inside the runtime layer, no new abstractions.

1. **Eliminate the `_status` in-memory drift.** Delete the `_status` field on [`Runtime`](../../../../src/runtime/runtime.ts). Replace the `status` getter with `return readRuntimeState(this.projectRoot)?.status ?? 'idle'`. All five existing call sites that assign `_status` are deleted; the matching disk writes already exist or are added (notably `freeze()` already writes `status: 'frozen'` to disk; `startup()` no longer needs an in-memory rehydration). `shutdown()`'s `this._status === 'frozen'` short-circuit reads the persisted state instead.
2. **Clear `current_card_id` and `active_card_run` on the executor-failure branch.** In `dispatchPendingActivations`, before the `if (execResult.status === 'failed') { ... return }` path returns, call `updateRuntimeState(this.projectRoot, { current_card_id: parentRun?.card_id ?? null, current_agent_session_id: parentRun?.planner_session_id ?? null, active_card_run: parentRun })`, using `parentPlannerRunFor`. Mirrors what [`repairStartupActiveCardRun`](../../../../src/runtime/runtime.ts) already does for terminal-executor cards.
3. **Route auto-recovery through `backlog`.** Reject any planner-supplied `status` update that violates `VALID_TRANSITIONS` inside `applyPlannerResult`'s `untrackedChanges.status` branch; route `failed → backlog` only via an explicit restart directive. Delete any planner-loop code that tries to redispatch a terminal card without a backlog hop.
4. **Add `lastTickAt`.** Persist a `last_tick_at` field in `RuntimeState`; stamp it on each `safeTick` entry, each `dispatchGoal` iteration, and each terminal-status write. Expose as `lastTickAt` in `/api/runtime/status`.

### Failure modes

- **Field-by-field clearing is fragile.** Every new exit path must remember to write `current_card_id: null, active_card_run: null`. The bug pattern that produced F19 (a code path that updates one field and forgets the others) is preserved.
- **No invariant enforcement.** The `RuntimeStateInvariantError` in [src/runtime/state.ts](../../../../src/runtime/state.ts) only catches the idle-with-active-run case. The new invariant ("`running` + `currentCardId` references a terminal card is forbidden") has to be hand-wired into every writer.
- **`applyPlannerResult` rewrite is brittle.** The planner JSON can supply `status` on any card; the current `cardStore.update` carve-out for terminal cards lets it through silently. Filtering only `failed → active` leaves the door open for other illegal pairs; the deny list grows over time.
- **Does not subsume F23.** Remains a separate fix.

### API impact

`/api/runtime/status` gains `lastTickAt: string | null`. No fields removed.

### Test strategy

Unit tests for the four points; an integration test asserting that an executor-failure followed by no planner activity sees `runtime: 'idle'` (or a different `currentCardId`) within 30s. The existing pause/resume integration suite must still pass because the `_status` deletion removes the `mirrorRuntimeState` drift in passing.

## Proposal B — Runtime state machine (recommended)

Introduce a single module that owns every runtime-layer transition and enforces the contract on every tick.

### New module: `src/runtime/state-machine.ts`

`RuntimeStateMachine` with these responsibilities and explicit boundaries.

#### Boundary — what the machine owns

- **Owned fields on `RuntimeState`**: `status`, `current_card_id`, `current_agent_session_id`, `active_card_run`, `paused`, `paused_at`, `last_tick_at`. Every write to these fields by `Runtime`, `ActiveRuntime`, and `RuntimeControl` (when an active runtime is available) goes through `RuntimeStateMachine.transition(event, payload)`. The free-function `updateRuntimeState` in [src/runtime/state.ts](../../../../src/runtime/state.ts) stays available and is the implementation the machine calls; it is also used (unchanged) by ledger-only writers for `runtime_commands`, `runtime_runs`, `runtime_activations`, `running_processes`, `queue`, `frozen_reason`, `runtime_intent`.
- **Owned card-status writes by runtime callers**: every `cardStore.setStatus(...)` or `cardStore.update(id, { status: ... })` invocation that originates from `Runtime` is replaced with `RuntimeStateMachine.transitionCard(cardId, action, payload)`. The full per-site inventory lives in [01-analysis-r3.md](01-analysis-r3.md) "Full runtime-originating `CardStatus` mutation inventory"; the conversion checklist lives in [03-plan-r3.md](03-plan-r3.md) Step 5. After Step 5, `rg -n "cardStore\.setStatus|cardStore\.update\([^\n]*status|untrackedChanges\.status" src/runtime/runtime.ts` returns zero matches — there is **no per-site justification carve-out inside `runtime.ts`**; every runtime-originated card-status write goes through the machine. This is the architecture-first reading of reviewer §1.
- **Out of scope (explicitly not owned), with justification**:
  - Operator API routes (`src/server/routes/cards-*`) and analyst tools ([src/agents/analyst-tools.ts](../../../../src/agents/analyst-tools.ts#L142-L144) — `abort_goal`/`restart_card`/`restart_goal`) continue to call `cardStore` directly. They are role-bounded surfaces (operator/analyst) with their own permission matrix entries and audit envelopes (`runMutatingTool`); F19's machine is the *runtime-orchestrator* boundary. Routing analyst/operator writes through the machine would conflate two permission domains and require duplicate analyst-action plumbing inside the machine.
  - [src/cards/card-store.ts](../../../../src/cards/card-store.ts) itself — the store is the validator (`validateTransition` at [L1081-L1087](../../../../src/cards/card-store.ts#L1081-L1087)); its internal `setStatus`/`update` paths are the implementation surface that `transitionCard` calls into.
  - The freeze/resume fallback writers in [src/server/routes/runtime-config-notes.ts](../../../../src/server/routes/runtime-config-notes.ts) (which execute only when no active runtime is attached) — runtime-state writes only, not `CardStatus`, and only on a no-active-runtime code path that the machine cannot observe.
  
  The boundary is therefore **"single runtime-layer writer"** for `CardStatus` and `RuntimeState` owned fields — not "single writer for `CardStatus` workspace-wide", which would require wider permission-system work that does not belong in this PR series.

#### Actions vs. states (start vs. restart) and the permission/transition tables

`transitionCard` takes an **action**, not a target state:

```ts
type RuntimeCardAction =
  | 'start'                        // begin execution from a startable status
  | 'restart'                      // recover from a terminal/blocked/changed status back to running
  | 'cancel'
  | 'planner_set_status'           // planner-supplied status from applyPlannerResult
  | 'block'                        // goal → blocked (planner declared blocked)
  | 'complete'                     // goal → done (reviewer passed)
  | 'fail'                         // any → failed (executor error, planner error, evidence reg. failure, startup repair)
  | 'crash_recovery_drop_to_backlog'; // active/running → backlog (performCrashRecovery / simulateCrash)
```

The action ↔ permission/transition rules are tabulated below. The source-of-truth constants are [`STARTABLE_STATES`](../../../../src/permissions/card-permissions.ts#L29) and [`RESTARTABLE_STATES`](../../../../src/permissions/card-permissions.ts#L28). All transitions go through `cardStore.validateTransition` for the literal one-step legality (Unicode-arrow message defined in [src/cards/card-store.ts](../../../../src/cards/card-store.ts#L1081-L1087)).

| Action | From-state requirement | Permission matrix call | One-step transitions emitted |
|---|---|---|---|
| `start` | `card.status ∈ STARTABLE_STATES = {drafting, backlog, changed}` | `decide({ role: 'planner', action: 'card.start', targetState: card.status })` must allow | `drafting → backlog → active → running` (drafting) / `backlog → active → running` (backlog) / `changed → backlog → active → running` (changed) |
| `restart` | `card.status ∈ RESTARTABLE_STATES = {blocked, changed, done, failed, cancelled}` | `decide({ role: 'planner', action: 'card.restart', targetState: card.status })` must allow | `<terminal> → backlog → active → running` for each |
| `cancel` | matrix-allowed | `decide({ role: ..., action: 'card.cancel', targetState })` | `<from> → cancelled` |
| `planner_set_status` | any (planner-supplied) | none (matrix already gated upstream) | exactly one step; `cardStore.validateTransition(current, requested)` must accept, else **reject with one `state_machine_planner_status_rejected` log line and leave card unchanged** |
| `block` | `card.status === 'active' \|\| card.status === 'running'` | none (runtime-owned outcome) | `<from> → running → blocked` |
| `complete` | `card.status === 'active' \|\| card.status === 'running'` | none | `<from> → running → done` |
| `fail` | any non-terminal | none | one-step `<from> → failed` |
| `crash_recovery_drop_to_backlog` | `card.status ∈ {active, running}` | none (recovery, not user action) | `<from> → backlog` |

Test coverage in `tests/runtime/state-machine.test.ts` exercises every action against each member of the runtime's nine `CardStatus` values (`drafting`, `backlog`, `active`, `running`, `blocked`, `changed`, `done`, `failed`, `cancelled`) and asserts the expected accept/reject outcome. The explicit recovery test set required by reviewer §2 is:

| action / current `card.status` | `failed` | `done` | `cancelled` | `blocked` | `changed` | `active` | `running` |
|---|---|---|---|---|---|---|---|
| `start` | reject (NOT_STARTABLE) | reject | reject | reject | accept (STARTABLE) | reject | reject |
| `restart` | accept (RESTARTABLE) | accept | accept | accept | accept | reject (NOT_RESTARTABLE) | reject |

These rows are encoded as table-driven `it.each` cases in the unit test so a future edit of `STARTABLE_STATES`/`RESTARTABLE_STATES` breaks the test if it drifts from the matrix.

`dispatchPendingActivations` L706 becomes:

```ts
const STARTABLE = new Set<CardStatus>(['drafting', 'backlog', 'changed']);
const action: RuntimeCardAction = STARTABLE.has(card.status) ? 'start' : 'restart';
this._stateMachine.transitionCard(card.id, action, { goalId });
```

Because the runtime is the only caller that knows whether this is a fresh start or a recovery, the action is selected at the call site, not inferred inside the machine. The `start`/`restart` choice cascades into the matrix: `decide({ role: 'planner', action: 'card.start', targetState: 'failed' })` denies (`failed ∈ NOT_STARTABLE_STATES`), and `decide({ role: 'planner', action: 'card.restart', targetState: 'failed' })` allows (`failed ∈ RESTARTABLE_STATES`). The state machine fails closed if the matrix denies; the F19 recovery path goes through `card.restart` and is matrix-authorised.

For `planner_set_status` specifically, the safe contract is rejection (not normalisation): silently restarting a terminal card on planner JSON is the bug, not the fix.

#### Tick loop ownership

A single `setInterval` lives inside `RuntimeStateMachine`, registered via [`RuntimeLifecycleScope.registerTimer`](../../../../src/runtime/lifecycle.ts). The machine owns:

- the timer itself (cleared on `stop()`);
- a per-tick re-entrancy lock (one `Promise` in flight at a time);
- the on-demand tick fired at the end of every `transition()` call (also gated by the same lock — re-entrant transitions skip the on-demand tick and rely on the next interval tick).

`safeTick` and `_safeTickInFlight` on `Runtime` are deleted in the same step that the machine's tick takes over dispatch responsibility (Step 6 in the plan). Until that step, `safeTick` stays exactly as it is and the machine's tick only bumps `last_tick_at`. The transitions module never re-enters `dispatchGoal` directly; it schedules a re-dispatch by calling `Runtime.dispatchGoal` through an injected `redispatchGoal` scheduler dep, which uses `Runtime`'s existing `_dispatchInFlight` set as the dedup gate. This avoids two timers racing into `dispatchGoal` simultaneously.

Cadence: 5s interval. Justification: contract C3 is 5s (no terminal pin for more than one tick); contract C1 inner clause is 5s. Faster intervals add no value because the persisted-state read is the limiting factor.

#### Invariants

`tick()` asserts and auto-corrects:

- **I1** `status === 'running'` ⇒ `active_card_run !== null`. Violation → emit `state_machine_invariant` to `errors.jsonl` (once per `(invariant, key)` tuple), transition `status` to `'idle'`.
- **I2** `current_card_id` references a card with status ∉ `TERMINAL_STATUSES`. Violation → if a parent planner run exists via `parentPlannerRunFor`, pop to it (matches the design of `repairStartupActiveCardRun`); else transition to `'idle'`. After the corrective write, if `runtime_intent.status === 'running'` and a root run is open, schedule one re-dispatch via the scheduler dep.
- **I3** `active_card_run.card_id === current_card_id` (or both `null`). Violation → reconcile by clearing both and treating as I2.
- **I4** `last_tick_at` is monotonic across ticks for a single live runtime.

Auto-correction is the machine's job; Step 3 of the plan is **not no-op**, but invariant auto-correction is gated by an explicit, temporary `enforceInvariants` constructor flag (see "Construction" below).

#### Construction, the `enforceInvariants` staging flag, and F13 coordination

```ts
new RuntimeStateMachine({
  cardStore: CardStore,
  readState: () => RuntimeState | null,
  writeState: (changes: Partial<RuntimeState>) => RuntimeState,
  errorLogger: ErrorLogger,
  clock: () => Date,                                  // injectable
  scheduler: { setInterval, clearInterval },          // injectable
  redispatchGoal: (goalId: string) => Promise<void>,  // injected from Runtime
  enforceInvariants: boolean,                         // STAGING-ONLY; see below
});
```

No `projectRoot`. No direct `fs` access. Unit tests use a `Map`-backed `readState`/`writeState`, a fake `CardStore`, and a manual clock.

**`enforceInvariants` is an explicit, temporary staging flag.** Its lifecycle is part of the contract, not an implementation detail:

- During Step 3 (`Runtime` constructs the machine but `_status` is still authoritative), `Runtime` passes `enforceInvariants: false`. In this mode the machine's `tick()` does I4 only (stamps `last_tick_at`, asserts monotonicity); I1–I3 violations are detected and logged once per `(invariant, key)` tuple but **not auto-corrected**, because correcting `status` while `_status` still lies would cause an immediate re-divergence on the next `/api/runtime/status` read.
- During Step 4 (`_status` deleted, `Runtime.status` becomes a disk read), `Runtime` flips its constructor call to `enforceInvariants: true`. I1–I3 auto-correction lights up. From this point on, both the test suite and the live deployment exercise the full machine.
- During Step 7 (dead-code sweep), the flag is **removed**: the parameter is deleted from the constructor signature, the conditional inside `tick()` is collapsed to always-enforce, and `rg -n "enforceInvariants" src/` must return zero matches. Step 7 will fail the gate if any other construction path still passes `false` — that is the architectural guarantee that a half-enforced machine cannot survive the cleanup.

**Coordination with F13 r3 (async construction).** F13 r3 converts `Runtime` and `ActiveRuntime` construction to async factories (`Runtime.open(config)` / `ActiveRuntime.open(projectRoot, config, mcpManager)`). The state-machine seam is sync-constructible (the constructor body does no I/O) and therefore composes with either model:

- pre-F13: instantiate inside `Runtime`'s sync constructor (Step 3 plan as written).
- post-F13: instantiate inside `Runtime.open()` after the async setup completes and before the returned `Runtime` instance is exposed. The seam type and contract do not change; only the instantiation site moves.

**Merge ordering is explicit: F13 r3 lands first, then F19 rebases.** [03-plan-r3.md](03-plan-r3.md) Step 3 contains both pre-F13 and post-F13 instantiation snippets; only the post-F13 version is the one that actually ships. `ActiveRuntime.stateMachine` becomes a getter on the instance returned by `ActiveRuntime.open()`, identical in observable behaviour to the pre-F13 synchronous version.

#### Files deleted or reduced

- The bespoke `_status` field and getter on `Runtime` — deleted (Step 4 of the plan).
- The eight inline `updateRuntimeState({ status: 'idle', current_card_id: null, current_agent_session_id: null, queue: [], active_card_run: null } as Partial<RuntimeState> as never)` blobs in `runtime.ts` — replaced with one `transition('goal_exit' | 'card_terminated' | 'paused', ...)` call each. The `as Partial<RuntimeState> as never` cast (which exists only because these writes bypass the schema's type guard) disappears with them.
- The stale-`active_card_run` self-heal branch in `safeTick` — folded into invariants I1/I3.
- `_safeTickInFlight`, `safeTick`, `_autoDispatchFirstBacklogGoal` — folded into the machine's own tick.
- `mirrorRuntimeState` in [src/runtime/control.ts](../../../../src/runtime/control.ts) — replaced with `runtime.stateMachine.transition('paused' | 'resumed')`. `RuntimeControl` becomes a thin route-level policy wrapper that emits operator events; the state mutation is owned by the machine. The no-active-runtime fallback in `control.ts` (the `else` branch of `pauseRuntimeControl`/`resumeRuntimeControl`) is unchanged in F19 and stays as a direct `updateRuntimeState` call.
- The `enforceInvariants` flag itself — deleted in Step 7 (see "Construction" above).

#### Files added

- `src/runtime/state-machine.ts` — class, ~250 lines.
- `tests/runtime/state-machine.test.ts` — exhaustive unit tests for invariants and transitions (lives under `tests/runtime/` per the package's Jest layout, not under `src/`).

### Coordination with F20 and F23

- **F23 collapses to "remove the broken callers"**: the state machine never exposes a `failed → active` (or `failed → running`) one-step transition; `transitionCard(id, 'restart')` is the only recovery action and routes through `backlog`. The `Invalid transition: failed → active` and `failed → running` errors become architecturally unreachable from the runtime layer once Step 5 of the plan replaces L706 with `transitionCard(id, ..., 'start' | 'restart')` and the `applyPlannerResult` untracked-status write with `transitionCard(id, ..., 'planner_set_status')`.
- **F20 is deferred and NOT bundled into this PR series.** r1 proposed bundling F20 by reclassifying false executor failures as `needs_corrections`. But `needs_corrections` is a `ReviewerResult.result`, not a `CardStatus`: [src/schemas/validators.ts](../../../../src/schemas/validators.ts) `cardStatusSchema = z.enum(['drafting','backlog','active','running','blocked','changed','done','failed','cancelled'])` and [src/schemas/types.ts](../../../../src/schemas/types.ts) match. Adding `needs_corrections` to `CardStatus` is a cross-contract change with downstream impact on: the Zod schema, the `CardStatus` TS type and every type-narrowing site, `VALID_TRANSITIONS`, `validateMutablePatch` and `TERMINAL_STATES` carve-outs, the permission matrix entries (`STARTABLE_STATES`, `RESTARTABLE_STATES`, `DELETABLE_STATES`), the UI status badge mapping in `web/`, the operator API responses, and the runtime tick invariants. F20 needs its own design with that full surface specified. The F19/F23 series introduces the machine and uses only the existing `CardStatus` enum; F20 lands later, can add `needs_corrections` (or repurpose an existing status — that choice is F20's), and adds a one-method `verifyExecutorOutcome` hook inside the state machine when its schema impact is fully scoped.

### Integration with existing `permissions/` matrix

The state machine does **not** copy `VALID_TRANSITIONS` ([src/cards/card-store.ts](../../../../src/cards/card-store.ts)) or the `decide()` matrix from [src/permissions/card-permissions.ts](../../../../src/permissions/card-permissions.ts). It composes:

- For runtime-side card writes: `decide({ role: 'planner' | 'operator', action: 'card.start' | 'card.restart' | 'card.cancel', targetState: card.status })` first (is the action permitted?), then for each one-step transition in the planned sequence `cardStore.validateTransition(current, next)` (is the literal transition legal?). Fail-closed if either rejects.
- `transitionCard(id, 'restart', payload)` for a failed card decomposes to the ordered sequence `failed → backlog → active → running`. Each step calls `cardStore.setStatus`, which uses the same `VALID_TRANSITIONS`. The state machine never bypasses the store's validator; it just makes legal multi-step recoveries discoverable.

### Failure modes

- **Bigger surface change.** ~10 call sites in `runtime.ts` rewritten plus `control.ts` and `safeTick` consolidated. Higher review cost than Proposal A; mitigated by the PR-per-step plan ([03-plan-r3.md](03-plan-r3.md)).
- **Tick interval is a wall-clock dependency.** 5s polling adds negligible load; test determinism requires the injectable clock and scheduler deps already in the constructor.
- **Wider blast radius if invariant logic is wrong.** A buggy invariant could auto-correct healthy runtime state into garbage. Mitigation: each invariant has its own unit test that violates it and asserts the auto-correction; each auto-correction also writes one `errors.jsonl` line, so a regression is observable in the same harness that produced F19. The `enforceInvariants: false` staging in Step 3 explicitly bounds the window in which I1–I3 could mis-correct (it cannot — they are observe-only until Step 4).
- **Cross-process write race.** Operator API routes still call `cardStore.setStatus` directly. If an operator restart races a runtime auto-restart, both paths reach `cardStore.setStatus` and the existing per-card lock decides the winner. No new race is introduced; the existing behaviour is preserved.

### API impact

Identical to Proposal A: `/api/runtime/status` gains `lastTickAt: string | null`. No removals.

### Documentation and comment discipline

The state machine module is new code and is the only place where new explanatory comments are appropriate (event-name docs and invariant-rationale lines). The plan must not add docstrings or commentary to untouched runtime code. Per the project guideline, the rewrite of an existing inline write into `transition(...)` does not earn a new comment unless the transition reason is non-obvious. Test names carry the contract; the implementation reads as straightforward calls.

### Test strategy

- **Unit (machine)**: each invariant (I1–I4) under every card-status × runtime-status combination; each transition event (`start_project`, `goal_exit`, `card_terminated`, `paused`, `resumed`, `freeze`, `unfreeze`); each `transitionCard` action against each of the nine `CardStatus` values per the table above; matrix-deny propagation; planner-supplied illegal status rejection; the explicit `start`-vs-`restart` table for `failed`/`done`/`cancelled`/`blocked`/`changed`/`active`/`running`.
- **Unit (runtime adapter)**: `Runtime.status` getter reads disk; `Runtime` constructor (or post-F13 `Runtime.open()` factory) wires the machine; `Runtime` injects `redispatchGoal` correctly.
- **Integration**: drive `dispatchGoal` against a fake `AgentRuntime` whose executor returns `status: 'failed'`. Assert that `readRuntimeState().current_card_id` is `null` or the parent goal id within 5s; assert `runtime.status` is `'running'` (with parent in flight) or `'idle'` within 30s; assert no `Invalid transition` line appears in `errors.jsonl`.
- **Integration (pause/resume)**: assert that after `POST /api/runtime/pause`, both `/api/runtime/status.runtime === 'paused'` and on-disk `runtime.json.status === 'paused'`. The pre-fix behaviour (disk `status` mirrored from stale `_status`) must regress to red without the fix.
- **Integration (startup repair while frozen)**: `Runtime` constructed and `shutdown()` called while the persisted `status === 'frozen'` short-circuits cleanly without re-reading the now-deleted `_status`.
- **E2E**: covered by the live LXC probe in the plan, against the documented `saivage-v3-getrich.service` deployment. The deterministic Jest integration test is the F19 acceptance gate; the live probe is informational only (see plan Probe-D).

## Recommendation

**Proposal B.** Reasons grounded in the project guidelines:

1. **Architecture-first, no backward compatibility.** The `_status` field, the eight inline state-clearing blobs, the `as Partial<RuntimeState> as never` casts, `mirrorRuntimeState`, `safeTick`'s self-heal, and `_safeTickInFlight` are exactly the accumulated patchwork the guideline says to remove. Proposal A patches them; Proposal B deletes them.
2. **Clean code, proper architecture.** Two stores with no enforced relationship is the structural defect; a single writer is the canonical fix.
3. **No migration shims.** The new module replaces the old code paths directly; no parallel `_status` / disk-state cohabitation.
4. **Aggressive dead-code removal.** Proposal B removes more lines than it adds (`_status` field + getter + 8 inline blobs + `safeTick` self-heal + `_safeTickInFlight` + `mirrorRuntimeState` + the staging `enforceInvariants` flag) and centralises the remaining logic in one tested place.
5. **No over-engineering.** One module, one class, one interval timer, one event dispatcher. The "abstraction" is exactly the abstraction that already implicitly exists in `runtime.ts`, made explicit so it can be tested and trusted.
6. **Subsumes F23 directly.** F20 is intentionally deferred (see "Coordination" above) so its schema work does not enter this PR.

The cost is a larger diff and a more careful PR sequence, accounted for in [03-plan-r3.md](03-plan-r3.md).

## Changes vs r2

- Reviewer §1 (transitionCard ownership): the boundary is restated as architecture-first — **every** runtime-originated `cardStore.setStatus` / `cardStore.update({...status...})` call routes through the machine, with no per-site carve-out inside `runtime.ts`. The full per-site inventory lives in the analysis; the plan's Step 5 checklist enumerates every conversion. Out-of-scope surfaces (analyst tools, operator routes, `CardStore` self, `runtime-config-notes.ts` fallbacks) are named with explicit justification.
- Reviewer §2 (start vs restart): the action ↔ permission/transition table is reproduced verbatim. The explicit `start`-vs-`restart` accept/reject table for `failed`/`done`/`cancelled`/`blocked`/`changed`/`active`/`running` is declared as the required `it.each` test set for `tests/runtime/state-machine.test.ts`. References point at `STARTABLE_STATES`/`RESTARTABLE_STATES` in [src/permissions/card-permissions.ts](../../../../src/permissions/card-permissions.ts#L28-L50).
- Reviewer §3 (`enforceInvariants`): documented as an explicit, temporary staging flag in the constructor contract; lifecycle pinned to Step 3 (`false`) → Step 4 (`true`) → Step 7 (**remove**). The Step 7 cleanup explicitly requires `rg -n "enforceInvariants" src/` returns zero matches.
- New "Coordination with F13 r3 (async construction)" subsection ties the seam to F13's `Runtime.open()` / `ActiveRuntime.open()` factory and pins the merge order: F13 r3 lands first, then F19 rebases its Step 3 wiring into the new construction chain.
- All relative links are now repo-root-correct (`../../../../src/...` for in-package files; `../../../../../<workspace-root-path>` is used in the analysis for `tmp/` and `.github/skills/` references).
