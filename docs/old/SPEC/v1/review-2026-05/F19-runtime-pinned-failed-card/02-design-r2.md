# F19 — Design (r2)

Supersedes [02-design-r1.md](02-design-r1.md). Changes vs r1 are summarised at the end. Proposal B is still recommended, with a tighter boundary and explicit `start` vs `restart` semantics.

## Proposal A — Focused fix (surgical)

### Shape

Three localised changes inside the runtime layer, no new abstractions.

1. **Eliminate the `_status` in-memory drift.** Delete the `_status` field on [`Runtime`](../../../src/runtime/runtime.ts). Replace the `status` getter with `return readRuntimeState(this.projectRoot)?.status ?? 'idle'`. All five existing call sites that assign `_status` are deleted; the matching disk writes already exist or are added (notably `freeze()` already writes `status: 'frozen'` to disk; `startup()` no longer needs an in-memory rehydration). `shutdown()`'s `this._status === 'frozen'` short-circuit reads the persisted state instead.
2. **Clear `current_card_id` and `active_card_run` on the executor-failure branch.** In `dispatchPendingActivations`, before the `if (execResult.status === 'failed') { ... return }` path returns, call `updateRuntimeState(this.projectRoot, { current_card_id: parentRun?.card_id ?? null, current_agent_session_id: parentRun?.planner_session_id ?? null, active_card_run: parentRun })`, using `parentPlannerRunFor`. Mirrors what [`repairStartupActiveCardRun`](../../../src/runtime/runtime.ts) already does for terminal-executor cards at line 282.
3. **Route auto-recovery through `backlog`.** Reject any planner-supplied `status` update that violates `VALID_TRANSITIONS` inside `applyPlannerResult`'s `untrackedChanges.status` branch; route `failed → backlog` only via an explicit restart directive. Delete any planner-loop code that tries to redispatch a terminal card without a backlog hop.
4. **Add `lastTickAt`.** Persist a `last_tick_at` field in `RuntimeState`; stamp it on each `safeTick` entry, each `dispatchGoal` iteration, and each terminal-status write. Expose as `lastTickAt` in `/api/runtime/status`.

### Failure modes

- **Field-by-field clearing is fragile.** Every new exit path must remember to write `current_card_id: null, active_card_run: null`. The bug pattern that produced F19 (a code path that updates one field and forgets the others) is preserved.
- **No invariant enforcement.** The `RuntimeStateInvariantError` in [src/runtime/state.ts](../../../src/runtime/state.ts) line 13 only catches the idle-with-active-run case. The new invariant ("`running` + `currentCardId` references a terminal card is forbidden") has to be hand-wired into every writer.
- **`applyPlannerResult` rewrite is brittle.** The planner JSON can supply `status` on any card; the current `cardStore.update` carve-out for terminal cards lets it through silently. Filtering only `failed → active` leaves the door open for other illegal pairs; the deny list grows over time.
- **Does not subsume F20 or F23.** Both remain separate fixes.

### API impact

`/api/runtime/status` gains `lastTickAt: string | null`. No fields removed.

### Test strategy

Unit tests for the four points; an integration test asserting that an executor-failure followed by no planner activity sees `runtime: 'idle'` (or a different `currentCardId`) within 30s. The existing pause/resume integration suite must still pass because the `_status` deletion removes the `mirrorRuntimeState` drift in passing.

## Proposal B — Runtime state machine (recommended)

Introduce a single module that owns every runtime-layer transition and enforces the contract on every tick.

### New module: `src/runtime/state-machine.ts`

`RuntimeStateMachine` with these responsibilities and explicit boundaries:

#### Boundary — what the machine owns

- **Owned fields on `RuntimeState`**: `status`, `current_card_id`, `current_agent_session_id`, `active_card_run`, `paused`, `paused_at`, `last_tick_at`. Every write to these fields by `Runtime`, `ActiveRuntime`, and `RuntimeControl` (when an active runtime is available) goes through `RuntimeStateMachine.transition(event, payload)`. The free-function `updateRuntimeState` in [src/runtime/state.ts](../../../src/runtime/state.ts) stays available and is the implementation the machine calls; it is also used (unchanged) by ledger-only writers for `runtime_commands`, `runtime_runs`, `runtime_activations`, `running_processes`, `queue`, `frozen_reason`, `runtime_intent`.
- **Owned card-status writes by runtime callers**: every `cardStore.setStatus(...)` or `cardStore.update(id, { status: ... })` invocation that originates from `Runtime` (including `applyPlannerResult`'s untracked-status path and `dispatchPendingActivations` line 706) is replaced with `RuntimeStateMachine.transitionCard(cardId, action, payload)`. The machine consults [`decide()`](../../../src/permissions/card-permissions.ts) and `cardStore.validateTransition`; it does **not** duplicate either matrix.
- **Out of scope (explicitly not owned)**: operator API routes, planner tools, analyst tools, and `CardStore`'s own direct mutation surface continue to call `cardStore` directly. The freeze/resume fallback writers in [src/server/routes/runtime-config-notes.ts](../../../src/server/routes/runtime-config-notes.ts) (which execute only when no active runtime is attached) are also out of scope for F19 and continue to use `updateRuntimeState` directly. The design therefore is **"single runtime-layer writer"**, not "single writer for `CardStatus` workspace-wide" — the latter would require wider permission-system work that does not belong in this PR series.

#### Actions vs. states (start vs. restart)

`transitionCard` takes an **action**, not a target state:

```ts
type RuntimeCardAction =
  | 'start'        // begin execution from a startable status
  | 'restart'      // recover from a terminal status (or blocked/changed) back to running
  | 'cancel'
  | 'planner_set_status'; // planner-supplied status from applyPlannerResult
```

- `start`: only valid when the card is in `STARTABLE_STATES = {drafting, backlog, changed}` (per [src/permissions/card-permissions.ts](../../../src/permissions/card-permissions.ts#L29) `STARTABLE_STATES`). Drives `backlog → active → running` (or `drafting → backlog → active → running` for the drafting case). The state machine refuses `start` on a `failed | done | cancelled | blocked | active | running` card.
- `restart`: valid when the card is in `RESTARTABLE_STATES = {blocked, changed, done, failed, cancelled}` (per [src/permissions/card-permissions.ts](../../../src/permissions/card-permissions.ts#L28)). Drives `failed → backlog → active → running` (or the analogous sequence for `done`, `cancelled`, `blocked`, `changed`). This is the only action the machine offers for recovering a terminal card; `transitionCard(id, 'restart')` is the call site for both operator-initiated restart and the runtime's own auto-recovery when `runtime_intent.status === 'running'` after a terminal child.
- `planner_set_status`: handles `applyPlannerResult`'s `updated_cards.status` path. The machine refuses any planner-requested transition that violates `cardStore.validateTransition(currentStatus, requestedStatus)`. Refusals are logged to `errors.jsonl` and the planner result is preserved with the offending field dropped. Refusal is the **safe contract**: planner-supplied status updates do not silently restart terminal work. To restart, the planner must explicitly emit the `restart` directive (a separate tool surface that the F23 design owns).

`dispatchPendingActivations` line 706 becomes `this._stateMachine.transitionCard(card.id, currentStatus === 'failed' ? 'restart' : 'start', { goalId })`. Because the runtime is the only caller that knows whether this is a fresh start or a recovery, the action is selected at the call site, not inferred inside the machine.

This composes correctly with the permission matrix: `decide({ role: 'planner', action: 'card.start', targetState: 'failed' })` denies (matrix entry "`NOT_STARTABLE_STATES` → not allowed") and `decide({ role: 'planner', action: 'card.restart', targetState: 'failed' })` allows. The state machine fails closed if the matrix denies; the F19 recovery path goes through `card.restart` and is matrix-authorised.

#### Tick loop ownership

A single `setInterval` lives inside `RuntimeStateMachine`, registered via [`RuntimeLifecycleScope.registerTimer`](../../../src/runtime/lifecycle.ts#L85). The machine owns:

- the timer itself (cleared on `stop()`);
- a per-tick re-entrancy lock (one `Promise` in flight at a time);
- the on-demand tick fired at the end of every `transition()` call (also gated by the same lock — re-entrant transitions skip the on-demand tick and rely on the next interval tick).

`safeTick` and `_safeTickInFlight` on `Runtime` are deleted in the same step that the machine's tick takes over dispatch responsibility (Step 6 in the plan). Until that step, `safeTick` stays exactly as it is and the machine's tick only bumps `last_tick_at` (Step 3 invariant: machine tick is observe-only until Step 4 takes over `status`/`paused` from `_status`). The transitions module never re-enters `dispatchGoal` directly; it schedules a re-dispatch by calling `Runtime.dispatchGoal` through an injected scheduler dep, which uses `Runtime`'s existing `_dispatchInFlight` set as the dedup gate. This avoids two timers racing into `dispatchGoal` simultaneously.

Cadence: 5s interval. Justification: contract C3 is 5s (no terminal pin for more than one tick); contract C1 inner clause is 5s. Faster intervals add no value because the persisted-state read is the limiting factor.

#### Invariants

`tick()` asserts and auto-corrects:

- **I1** `status === 'running'` ⇒ `active_card_run !== null`. Violation → emit `state_machine_invariant` to `errors.jsonl` (once per `(invariant, key)` tuple), transition `status` to `'idle'`.
- **I2** `current_card_id` references a card with status ∉ `TERMINAL_STATUSES`. Violation → if a parent planner run exists via `parentPlannerRunFor`, pop to it (matches the design of `repairStartupActiveCardRun`); else transition to `'idle'`. After the corrective write, if `runtime_intent.status === 'running'` and a root run is open, schedule one re-dispatch via the scheduler dep.
- **I3** `active_card_run.card_id === current_card_id` (or both `null`). Violation → reconcile by clearing both and treating as I2.
- **I4** `last_tick_at` is monotonic across ticks for a single live runtime.

Auto-correction is the machine's job; **Step 3 of the plan is NOT no-op**. See "Step boundaries" below — this revision drops the "no behaviour change" framing because I1–I3 cannot be observed-only.

#### Construction and unit testability

```ts
new RuntimeStateMachine({
  cardStore: CardStore,
  readState: () => RuntimeState | null,
  writeState: (changes: Partial<RuntimeState>) => RuntimeState,
  errorLogger: ErrorLogger,
  clock: () => Date,                              // injectable
  scheduler: { setInterval, clearInterval },      // injectable
  redispatchGoal: (goalId: string) => Promise<void>, // injected from Runtime
});
```

No `projectRoot`. No direct `fs` access. Unit tests use a `Map`-backed `readState`/`writeState`, a fake `CardStore`, and a manual clock. `Runtime` constructs the machine inside its own constructor, passing `(changes) => updateRuntimeState(this.projectRoot, changes)` for `writeState` and `() => readRuntimeState(this.projectRoot)` for `readState`, and `(goalId) => this.dispatchGoal(goalId)` for `redispatchGoal`. This keeps the project-root persistence boundary inside `Runtime`, where it already lives.

#### Files deleted or reduced

- The bespoke `_status` field and getter on `Runtime` — deleted (Step 4 of the plan).
- The eight inline `updateRuntimeState({ status: 'idle', current_card_id: null, current_agent_session_id: null, queue: [], active_card_run: null } as Partial<RuntimeState> as never)` blobs at [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) lines 555, 581, 609, 635, 644, 645, 660, 800 — replaced with one `transition('goal_exit' | 'card_terminated' | 'paused', ...)` call each. The `as Partial<RuntimeState> as never` cast (which exists only because these writes bypass the schema's type guard) disappears with them.
- The stale-`active_card_run` self-heal branch in `safeTick` (lines 793–810) — folded into invariants I1/I3.
- `_safeTickInFlight`, `safeTick`, `_autoDispatchFirstBacklogGoal` — folded into the machine's own tick.
- `mirrorRuntimeState` in [src/runtime/control.ts](../../../src/runtime/control.ts) — replaced with `runtime.stateMachine.transition('paused' | 'resumed')`. `RuntimeControl` becomes a thin route-level policy wrapper that emits operator events; the state mutation is owned by the machine. The no-active-runtime fallback in `control.ts` (the `else` branch of `pauseRuntimeControl`/`resumeRuntimeControl`) is unchanged in F19 and stays as a direct `updateRuntimeState` call.

#### Files added

- `src/runtime/state-machine.ts` — class, ~250 lines.
- `tests/runtime/state-machine.test.ts` — exhaustive unit tests for invariants and transitions (lives under `tests/runtime/` per the package's Jest layout, not under `src/`).

### Coordination with F20 and F23

- **F23 collapses to "remove the broken callers"**: the state machine never exposes a `failed → active` (or `failed → running`) one-step transition; `transitionCard(id, 'restart')` is the only recovery action and routes through `backlog`. The `Invalid transition: failed → active` and `failed → running` errors become architecturally unreachable from the runtime layer once Step 5 of the plan replaces line 706 with `transitionCard(id, ..., 'start' | 'restart')` and the `applyPlannerResult` untracked-status write with `transitionCard(id, ..., 'planner_set_status')`.
- **F20 is deferred and NOT bundled into this PR series.** r1 proposed bundling F20 by reclassifying false executor failures as `needs_corrections`. But `needs_corrections` is a `ReviewerResult.result`, not a `CardStatus`: [src/schemas/validators.ts](../../../src/schemas/validators.ts#L13) `cardStatusSchema = z.enum(['drafting','backlog','active','running','blocked','changed','done','failed','cancelled'])` and [src/schemas/types.ts](../../../src/schemas/types.ts#L12-L22) match. Adding `needs_corrections` to `CardStatus` is a cross-contract change with downstream impact on: the Zod schema, the `CardStatus` TS type and every type-narrowing site, `VALID_TRANSITIONS`, `validateMutablePatch` and `TERMINAL_STATES` carve-outs, the permission matrix entries (`STARTABLE_STATES`, `RESTARTABLE_STATES`, `DELETABLE_STATES`), the UI status badge mapping in `web/`, the operator API responses, and the runtime tick invariants. F20 needs its own design with that full surface specified. The F19/F23 series introduces the machine and uses only the existing `CardStatus` enum; F20 lands later, can add `needs_corrections` (or repurpose an existing status — that choice is F20's), and adds a one-method `verifyExecutorOutcome` hook inside the state machine when its schema impact is fully scoped. The plan reflects this by removing the original Step 7.

### Integration with existing `permissions/` matrix

The state machine does **not** copy `VALID_TRANSITIONS` ([src/cards/card-store.ts](../../../src/cards/card-store.ts#L217)) or the `decide()` matrix from [src/permissions/card-permissions.ts](../../../src/permissions/card-permissions.ts). It composes:

- For runtime-side card writes: `decide({ role: 'planner' | 'operator', action: 'card.start' | 'card.restart' | 'card.cancel', targetState: card.status })` first (is the action permitted?), then for each one-step transition in the planned sequence `cardStore.validateTransition(current, next)` (is the literal transition legal?). Fail-closed if either rejects.
- `transitionCard(id, 'restart', payload)` for a failed card decomposes to the ordered sequence `failed → backlog → active → running`. Each step calls `cardStore.setStatus`, which uses the same `VALID_TRANSITIONS`. The state machine never bypasses the store's validator; it just makes legal multi-step recoveries discoverable.

### Failure modes

- **Bigger surface change.** ~10 call sites in `runtime.ts` rewritten plus `control.ts` and `safeTick` consolidated. Higher review cost than Proposal A; mitigated by the PR-per-step plan ([03-plan-r2.md](03-plan-r2.md)).
- **Tick interval is a wall-clock dependency.** 5s polling adds negligible load; test determinism requires the injectable clock and scheduler deps already in the constructor.
- **Wider blast radius if invariant logic is wrong.** A buggy invariant could auto-correct healthy runtime state into garbage. Mitigation: each invariant has its own unit test that violates it and asserts the auto-correction; each auto-correction also writes one `errors.jsonl` line, so a regression is observable in the same harness that produced F19.
- **Cross-process write race.** Operator API routes still call `cardStore.setStatus` directly. If an operator restart races a runtime auto-restart, both paths reach `cardStore.setStatus` and the existing per-card lock decides the winner. No new race is introduced; the existing behaviour is preserved.

### API impact

Identical to Proposal A: `/api/runtime/status` gains `lastTickAt: string | null`. No removals.

### Documentation and comment discipline

The state machine module is new code and is the only place where new explanatory comments are appropriate (event-name docs and invariant-rationale lines). The plan must not add docstrings or commentary to untouched runtime code. Per the project guideline, the rewrite of an existing inline write into `transition(...)` does not earn a new comment unless the transition reason is non-obvious. Test names carry the contract; the implementation reads as straightforward calls. Reviewer §7 is addressed by stating this discipline here and enforcing it in PR review.

### Test strategy

- **Unit (machine)**: each invariant (I1–I4) under every card-status × runtime-status combination; each transition event (`start_project`, `goal_exit`, `card_terminated`, `paused`, `resumed`, `freeze`, `unfreeze`); each `transitionCard` action (`start`, `restart`, `cancel`, `planner_set_status`) under each card status; matrix-deny propagation; planner-supplied illegal status rejection.
- **Unit (runtime adapter)**: `Runtime.status` getter reads disk; `Runtime` constructor wires the machine; `Runtime` injects `redispatchGoal` correctly.
- **Integration**: drive `dispatchGoal` against a fake `AgentRuntime` whose executor returns `status: 'failed'`. Assert that `readRuntimeState().current_card_id` is `null` or the parent goal id within 5s; assert `runtime.status` is `'running'` (with parent in flight) or `'idle'` within 30s; assert no `Invalid transition` line appears in `errors.jsonl`.
- **Integration (pause/resume)**: assert that after `POST /api/runtime/pause`, both `/api/runtime/status.runtime === 'paused'` and on-disk `runtime.json.status === 'paused'`. The pre-fix behaviour (disk `status` mirrored from stale `_status`) must regress to red without the fix.
- **Integration (startup repair while frozen)**: `Runtime` constructed and `shutdown()` called while the persisted `status === 'frozen'` short-circuits cleanly without re-reading the now-deleted `_status`.
- **E2E**: covered by the live LXC probe in the plan, against the documented `saivage-v3-getrich.service` deployment.

## Recommendation

**Proposal B.** Reasons grounded in the project guidelines:

1. **Architecture-first, no backward compatibility.** The `_status` field, the eight inline state-clearing blobs, the `as Partial<RuntimeState> as never` casts, `mirrorRuntimeState`, `safeTick`'s self-heal, and `_safeTickInFlight` are exactly the accumulated patchwork the guideline says to remove. Proposal A patches them; Proposal B deletes them.
2. **Clean code, proper architecture.** Two stores with no enforced relationship is the structural defect; a single writer is the canonical fix.
3. **No migration shims.** The new module replaces the old code paths directly; no parallel `_status` / disk-state cohabitation.
4. **Aggressive dead-code removal.** Proposal B removes more lines than it adds (`_status` field + getter + 8 inline blobs + `safeTick` self-heal + `_safeTickInFlight` + `mirrorRuntimeState`) and centralises the remaining logic in one tested place.
5. **No over-engineering.** One module, one class, one interval timer, one event dispatcher. The "abstraction" is exactly the abstraction that already implicitly exists in `runtime.ts`, made explicit so it can be tested and trusted.
6. **Subsumes F23 directly.** F20 is intentionally deferred (see "Coordination" above) so its schema work does not enter this PR.

The cost is a larger diff and a more careful PR sequence, accounted for in [03-plan-r2.md](03-plan-r2.md).

## Changes vs r1

- Reviewer §1: state-machine boundary tightened to "single runtime-layer writer". The freeze/resume fallback in `runtime-config-notes.ts` and operator/analyst/CardStore direct surfaces are documented as explicitly out of scope.
- Reviewer §2: `start` vs `restart` action model added. The machine takes actions (not target states); recovery from `failed` is `transitionCard(id, 'restart')`, which the permission matrix already allows; `start` keeps its `STARTABLE_STATES` constraint. Line 706 rewritten as a status-dependent action selection.
- Reviewer §3: F20 explicitly deferred and removed from the bundle. The schema/permission/UI impact of any new card status is documented as F20's own design surface. F19/F23 only use the existing `CardStatus` enum.
- Reviewer §4: tick-loop ownership specified. The machine owns the timer, the re-entrancy lock, and the on-demand tick after each transition; the boundary at which `safeTick` stops dispatching is named explicitly (Step 6 of the plan, when the machine takes over runtime-status writes).
- Reviewer §5: "Step 3 is no-op" framing dropped. Step 3 is observe-and-bump-`last_tick_at` only; invariants I1–I3 light up in Step 4 when the machine takes over `status` (because before that, `_status` still lies and the machine cannot mutate without conflict). The plan now reflects this.
- Reviewer §6: machine constructor takes injected `readState`, `writeState`, `cardStore`, `errorLogger`, `clock`, `scheduler`, `redispatchGoal`. No `projectRoot`; no I/O.
- Reviewer §7: comment/docstring discipline stated explicitly.
