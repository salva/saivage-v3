# F19 — Plan (r2)

Implements Proposal B from [02-design-r2.md](02-design-r2.md). Bundled with [F23](../F23-invalid-failed-active/00-issue.md): F23's design defers to this plan for the state-machine module and adds the `transitionCard(id, 'restart', ...)` audit-trail behaviour as a small extension. [F20](../F20-executor-false-failed/00-issue.md) is **not** bundled (see [02-design-r2.md](02-design-r2.md) "Coordination with F20 and F23"); F20 introduces its own status (or repurposes an existing one) in a separate PR series with its own schema and UI fanout.

## Test-runner and validation conventions

Package test runner is **Jest** ([package.json](../../../package.json) lines 14–15: `"test": "NODE_OPTIONS=--experimental-vm-modules jest"`, `"test:direct": "NODE_OPTIONS=--experimental-vm-modules node ./node_modules/jest/bin/jest.js"`; `jest.roots = ["<rootDir>/tests"]` lines 110–112). New tests live under `tests/runtime/`. Per-PR validation in this plan therefore uses:

- `npm run typecheck`
- focused: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime/state-machine.test.ts --runInBand --forceExit`
- broader: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime tests/server --runInBand --forceExit`
- final cleanup step: `npm test`
- UI smoke (only Step 1 and final): `npm run web:test:operator-smoke`
- live probe: per the [saivage-development-validation](../../../../.github/skills/saivage-development-validation/SKILL.md) skill, against the documented `saivage-v3-getrich.service` on `10.0.3.170` (codebase bind-mounted; build on host, restart service, probe `/health`).

The earlier r1 references to `npx vitest run src/runtime src/server` and `src/runtime/state-machine.test.ts` were wrong: this package has no Vitest configuration for backend code and `jest.roots` excludes `src/`. Vitest is used only inside the `web/` subproject. Those commands are replaced throughout.

## Coordination summary

- Step 1 lands `last_tick_at` schema + API surface (additive only, no logic change).
- Step 2 lands the `RuntimeStateMachine` module with unit tests but no callers.
- Step 3 wires the machine into `Runtime` as a tick-only observer (writes `last_tick_at`); other writes still go through legacy code. **No invariant auto-correction yet** — the machine cannot safely correct `status` while `_status` is still authoritative on the in-memory side.
- Step 4 deletes `_status`; `Runtime.status` becomes a disk read. After this step the machine's invariants I1–I3 can begin auto-correcting, and they are enabled in this same step.
- Step 5 routes runtime-side card transitions through `transitionCard`; introduces `start` vs `restart` actions; closes F23.
- Step 6 routes runtime-state writes through `transition()`; consolidates the eight clear-state blobs; removes `safeTick` and `_safeTickInFlight`; closes F19's main symptom.
- Step 7 is the dead-code sweep + full-suite green.

Each step preserves a working build and passes the existing test suite plus its own new tests.

## Direct-writer inventory (the implementation checklist)

Generated with `rg -n "updateRuntimeState\(|saveRuntimeState\(|setStatus\(|cardStore\.update\(" src/runtime src/server src/agents` and verified by reading the matched lines. Each entry is annotated with the step that converts it (or marks it explicitly out of scope).

`src/runtime/runtime.ts`:

- line 128 `_syncRunningProcesses`: writes `running_processes` only — **out of scope** (ledger field, not machine-owned).
- line 184 `markActivationComplete`: writes `runtime_activations`, `runtime_runs` only — **out of scope**.
- line 271 / 282 / 290 / 296 `repairStartupActiveCardRun`: writes owned fields. **Step 6** — replace each `saveRuntimeState` with `this._stateMachine.transition('startup_repair', { repaired })` after computing the repaired snapshot.
- line 487 `emitAgentEvent` (`session_started` only): writes `current_agent_session_id`. **Step 6** — replace with `this._stateMachine.transition('agent_session_started', { sessionId })`.
- line 535 `_rejectRuntimeCommand`: writes `runtime_commands` only — **out of scope**.
- line 555 startProject `.catch` blob: **Step 6** → `transition('goal_exit', { reason: 'start_project_failed' })`.
- line 565 stopProject command completion: writes `runtime_commands` only — **out of scope**.
- line 581 stopProject clear blob: **Step 6** → `transition('goal_exit', { reason: 'stop_project' })`.
- line 609 shutdown clear blob: **Step 6** → `transition('shutdown', {})`.
- line 610 `pause`: **Step 5** → `transition('paused', {})`.
- line 611 `resume`: **Step 5** → `transition('resumed', { activeRun: state?.active_card_run })`.
- line 612 `freeze`: **Step 5** → `transition('frozen', { reason, currentCardId, currentSessionId, queue })`.
- line 613 `resumeFromFreeze`: **Step 5** → `transition('unfrozen', { manifest })`.
- line 621 `dispatchGoal` activation: **Step 6** → `transition('goal_dispatched', { goalId, plannerSessionId, planCardType })`.
- line 624 `dispatchGoal` paused-exit: **Step 5** → `transition('paused', {})`.
- line 635 planner-exception clear blob: **Step 6** → `transition('goal_exit', { reason: 'planner_error' })`.
- line 637 between-iteration session-id update: writes `current_agent_session_id`, `queue: []`. **Step 6** → `transition('planner_iteration', { plannerSessionId })`.
- line 644 blocked-exit clear blob: **Step 6** → `transition('goal_exit', { reason: 'planner_blocked' })`.
- line 645 done-with-unfinished-children clear blob: **Step 6** → `transition('goal_exit', { reason: 'pending_child_work' })`.
- line 660 goal-completed clear blob: **Step 6** → `transition('goal_exit', { reason: 'goal_completed' })`.
- line 706 executor-target card status writes (`cardStore.setStatus(card.id, 'active' | 'running')`) and the owned-fields write of `current_card_id` and `active_card_run`: **Step 5** for the card statuses → `this._stateMachine.transitionCard(card.id, card.status === 'failed' || card.status === 'done' || card.status === 'cancelled' || card.status === 'blocked' || card.status === 'changed' ? 'restart' : 'start', { goalId, callerEdge })`; **Step 6** for the runtime-state fields → `this._stateMachine.transition('executor_started', { cardId, cardType, callerEdge, executorSessionId })`.
- line 758 `invokeReviewer` runtime-state write: **Step 6** → `this._stateMachine.transition('reviewer_started', { goalId, goalCardType, reviewerSessionId })`.
- line 766–782 `applyPlannerResult.untrackedChanges.status`: **Step 5** — replace `cardStore.update(update.id, { status })` with `this._stateMachine.transitionCard(update.id, 'planner_set_status', { requestedStatus: update.status })`. Other fields in `untrackedChanges` continue to use `cardStore.update` (not status-mutation).
- line 800 `safeTick` self-heal blob: **Step 6** — folded into invariants I1/I3; `safeTick` deleted entirely.

`src/runtime/control.ts`:

- `mirrorRuntimeState` (called by both `pauseRuntimeControl` and `resumeRuntimeControl`): **Step 5** — when `ctx.activeRuntime` exists, call `ctx.activeRuntime.runtime.stateMachine.transition('paused' | 'resumed', ...)` instead and delete `mirrorRuntimeState`. **Add a public accessor `ActiveRuntime.stateMachine` (forwarding to `this._runtime.stateMachine`) and expose `Runtime.stateMachine` as a `get`**; do not let `control.ts` reach through any private field.
- The no-active-runtime fallback branch (`updateRuntimeState({ status: 'paused' | 'idle', paused, paused_at })`): **out of scope** — kept as direct write per the design's narrowed boundary.

`src/server/routes/runtime-config-notes.ts`:

- line 175 freeze fallback `updateRuntimeState`: **out of scope** (fallback for no active runtime).
- line 176 resume-from-freeze fallback `updateRuntimeState`: **out of scope**.

`src/server/server.ts`:

- line 64 `/api/runtime/status` route: **Step 1** adds `lastTickAt`. **Step 1 also** updates the inactive-runtime fallback at the same line (`const state = readRuntimeState(projectRoot); return reply.send({ ..., lastTickAt: state?.last_tick_at ?? null });`) so the field is consistent across both branches.

`src/agents/`: no owned-field writers found by the inventory grep.

After Step 6, the only remaining direct writers of owned fields in the runtime layer are the three explicitly-out-of-scope items above; `rg -n "updateRuntimeState\(.*status:" src/runtime` reduces to zero matches. The Step 7 dead-code sweep verifies this.

## Step 1 — Add `last_tick_at` field

**Goal:** persist a tick liveness timestamp without changing any logic.

**Files:**

- [src/schemas/validators.ts](../../../src/schemas/validators.ts) — add `last_tick_at: z.string().datetime().nullable().optional()` to `runtimeStateSchema` (defaulting `null`/absent for back-compat reads). The schema lives in `validators.ts`, not `index.ts` (`index.ts` re-exports).
- [src/schemas/types.ts](../../../src/schemas/types.ts) — add `last_tick_at?: string | null;` to `interface RuntimeState`. Without this the new field cannot be passed through `Partial<RuntimeState>` writers without casts.
- [src/runtime/state.ts](../../../src/runtime/state.ts) — include `last_tick_at: null` in `defaultRuntimeState()`.
- [src/runtime/active-runtime.ts](../../../src/runtime/active-runtime.ts) — `getStatus()` adds `lastTickAt: state?.last_tick_at ?? null` to the return type and value.
- [src/server/server.ts](../../../src/server/server.ts) line 64 — `/api/runtime/status` payload adds `lastTickAt: status.lastTickAt` in the active-runtime branch and `lastTickAt: state?.last_tick_at ?? null` in the inactive-runtime fallback branch.

**Validation:**

- `npm run typecheck` clean.
- `NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime tests/server tests/schemas.test.ts --runInBand --forceExit` green.
- New unit test under `tests/runtime/runtime-state-last-tick-at.test.ts`: default state has `last_tick_at: null`; round-trip through `updateRuntimeState` preserves `last_tick_at`.
- New unit test under `tests/server/runtime-status-last-tick-at.test.ts`: `/api/runtime/status` response includes `lastTickAt` in both the active-runtime and no-runtime branches.
- `npm run web:test:operator-smoke` to confirm the dashboard tolerates the additive field.

**Rollback:** revert; field is additive.

## Step 2 — Add `src/runtime/state-machine.ts` with invariants but no callers

**Goal:** ship the module and unit tests, no wiring.

**Files added:**

- `src/runtime/state-machine.ts` — `RuntimeStateMachine` class with the constructor signature from [02-design-r2.md](02-design-r2.md): `({ cardStore, readState, writeState, errorLogger, clock, scheduler, redispatchGoal })`. Methods: `transition(event, payload)`, `transitionCard(cardId, action, payload)`, `tick()`, `start()`, `stop()`. Imports `decide` from [src/permissions/card-permissions.ts](../../../src/permissions/card-permissions.ts) and `TERMINAL_STATUSES` (move the constant from `runtime.ts` to a new `src/runtime/constants.ts` if the import cycle blocks; otherwise inline as a private `Set` in the module). The module does no I/O.
- `tests/runtime/state-machine.test.ts` — unit tests for invariants I1–I4 and for every transition event and every `transitionCard` action, using a `Map`-backed state, a fake `CardStore`, and a manual clock.

**Validation:**

- `npm run typecheck` clean.
- `NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime/state-machine.test.ts --runInBand --forceExit` green.

**Rollback:** delete the two new files.

## Step 3 — Wire the machine into `Runtime` as a tick-only observer

**Goal:** instantiate the machine inside `Runtime`, start its tick timer, but route no `status` / `current_card_id` / `active_card_run` writes through it yet. The machine's `tick()` only stamps `last_tick_at`. Invariants I1–I3 are present in code but **skip auto-correction while the legacy `_status` is still authoritative** (the machine consults a constructor flag `enforceInvariants: false` set by `Runtime` until Step 4 flips it). I4 (monotonic `last_tick_at`) is enforced.

**Files:**

- [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) — construct `this._stateMachine = new RuntimeStateMachine({ cardStore: this.cardStore, readState: () => readRuntimeState(this.projectRoot), writeState: (changes) => updateRuntimeState(this.projectRoot, changes), errorLogger: this._errorLogger, clock: () => new Date(), scheduler: { setInterval, clearInterval }, redispatchGoal: (goalId) => this.dispatchGoal(goalId), enforceInvariants: false })` in the constructor. Add public `get stateMachine(): RuntimeStateMachine`. Call `this._stateMachine.start()` at the end of `startup()` (timer registered via `RuntimeLifecycleScope.registerTimer` per [src/runtime/lifecycle.ts](../../../src/runtime/lifecycle.ts#L85)); call `this._stateMachine.stop()` at the start of `shutdown()`'s in-flight cancel block (before disposing the lifecycle scope).
- [src/runtime/active-runtime.ts](../../../src/runtime/active-runtime.ts) — add `get stateMachine(): RuntimeStateMachine { return this._runtime.stateMachine; }`.

**Validation:**

- `npm run typecheck` clean.
- `NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime --runInBand --forceExit` green.
- New integration test under `tests/runtime/state-machine-tick.test.ts`: after `runtime.startup()` and one tick interval, `readRuntimeState().last_tick_at` is non-null and strictly newer than the previous value across consecutive ticks; no `errors.jsonl` entries containing `state_machine_invariant` appear.
- **Live LXC probe (probe-A)**, see §Live probe sequence: on the documented GetRich-v2 deployment, `last_tick_at` advances monotonically across two reads spaced 7s apart.

**Rollback:** revert constructor/`startup`/`shutdown` lines; machine becomes unreachable.

## Step 4 — Cut `Runtime.status` over to the machine; delete `_status`; enable invariants

**Goal:** kill the in-memory/disk drift. After this step, `/api/runtime/status.runtime` always matches the on-disk `RuntimeState.status`. The state machine's invariants I1–I3 begin auto-correcting.

**Files:**

- [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) — delete the `_status: RuntimeStatus = 'idle'` field (line 99). Replace the `status` getter with `get status(): RuntimeStatus { return readRuntimeState(this.projectRoot)?.status ?? 'idle'; }`. Delete all five `this._status = ...` writes (lines 583, 605, 609, 612, 613). Verify the corresponding disk writes already exist at the same sites; in `shutdown()`'s frozen-short-circuit path (line 609), the existing `if (this._status === 'frozen')` becomes `if (readRuntimeState(this.projectRoot)?.status === 'frozen')`. In `freeze()` (line 612), confirm the existing `updateRuntimeState({ status: 'frozen', ... })` is present — it is. In `resumeFromFreeze()` (line 613), confirm the `updateRuntimeState({ status: 'idle', ... })` is present — it is.
- `RuntimeStateMachine` constructor — flip the default of the `enforceInvariants` flag in the state-machine config to `true` for `Runtime`'s call site. From now on, the tick auto-corrects I1, I2, I3.

**Validation:**

- `npm run typecheck` clean.
- `NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime tests/server --runInBand --forceExit` green.
- New unit test `tests/runtime/runtime-status-getter.test.ts`: after `new Runtime(...)` but before `startup()`, `runtime.status === 'idle'`; after `startup()` on a project whose persisted state has `status: 'running'`, `runtime.status === 'running'`; after `stopProject()`, `runtime.status === 'idle'`; after `freeze()`, `runtime.status === 'frozen'`; after `resumeFromFreeze()`, `runtime.status === 'idle'`.
- New regression test `tests/runtime/runtime-shutdown-while-frozen.test.ts`: `runtime.startup()` from a persisted `status: 'frozen'` state followed by `runtime.shutdown()` takes the frozen short-circuit path (does not run `disposeProcessRuntimeScope` for unfrozen, does not call `cleanAll`), without reading `_status`.
- New regression test `tests/runtime/pause-resume-disk-consistency.test.ts`: after `RuntimeControl.pauseRuntimeControl(...)`, both `activeRuntime.getStatus().status` and `readRuntimeState(projectRoot).status` equal `'paused'`. Pre-fix this test fails (because `mirrorRuntimeState` overwrites disk `status` with the stale `_status` value); the test must turn red without the Step 4 + Step 5 fix and green with it.
- **Live LXC probe (probe-B)**, see §Live probe sequence: after restart, API `runtime` equals disk `status`.

**Rollback:** restore `_status` field and assignments; disk-side writes already exist and stay (harmless).

## Step 5 — Route every runtime-side card transition through the machine; remove `failed → active|running` (closes F23)

**Goal:** the runtime layer never calls `cardStore.setStatus(card, ...)` or `cardStore.update(card, { status: ... })` directly. All such writes go through `transitionCard(id, action, payload)`. The `start` vs `restart` distinction from [02-design-r2.md](02-design-r2.md) makes the matrix authorise the recovery path explicitly.

**Files:**

- [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) — line 706 (`if (card.status === 'backlog') this.cardStore.setStatus(card.id, 'active'); this.cardStore.setStatus(card.id, 'running');`) becomes:

  ```ts
  const startable = ['drafting', 'backlog', 'changed'];
  const action = startable.includes(card.status) ? 'start' : 'restart';
  this._stateMachine.transitionCard(card.id, action, { goalId });
  ```

  The machine looks up `decide({ role: 'planner', action: action === 'start' ? 'card.start' : 'card.restart', targetState: card.status })`; if denied, refuses the dispatch, fires `card_failed` + a `state_machine_action_denied` error log, returns `{ failed: true }` so the dispatch loop unwinds via the existing branch.
- [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) lines 766–782 `applyPlannerResult` — `untrackedChanges.status` becomes `this._stateMachine.transitionCard(update.id, 'planner_set_status', { requestedStatus: update.status as CardStatus })`. The machine refuses any planner-requested transition that violates `cardStore.validateTransition(current, requested)`; refusals append one `state_machine_planner_status_rejected` line to `errors.jsonl` (one per `(cardId, requestedStatus)`) and the planner result is preserved minus the offending field. **This is the safe contract; the r1 plan's "log a correction and land in `running`" behaviour is intentionally NOT implemented** (reviewer §6) — silently restarting a terminal card on planner JSON is the bug, not the fix.
- [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) — `pause()`, `resume()`, `freeze()`, `resumeFromFreeze()`, and the in-loop `paused` writer (line 624) all switch from direct `updateRuntimeState(...)` of owned fields to `this._stateMachine.transition('paused' | 'resumed' | 'frozen' | 'unfrozen', payload)`. The machine handles `status`/`paused`/`paused_at` writes; ledger writes (`running_processes: []` on shutdown, `queue` snapshots on freeze) stay as direct `updateRuntimeState` calls.
- [src/runtime/control.ts](../../../src/runtime/control.ts) — `pauseRuntimeControl` and `resumeRuntimeControl`, when `ctx.activeRuntime` is present, call `ctx.activeRuntime.stateMachine.transition('paused' | 'resumed', { actor: 'operator' })` instead of `mirrorRuntimeState`. `mirrorRuntimeState` is deleted. The no-active-runtime fallback branch is unchanged.

**Validation:**

- `npm run typecheck` clean.
- `NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime tests/server tests/permissions --runInBand --forceExit` green.
- New unit test `tests/runtime/state-machine-planner-set-status.test.ts`: a planner result with `updated_cards: [{ id, status: 'active' }]` for a `failed` card produces exactly one `state_machine_planner_status_rejected` line, the card remains `'failed'`, and the dispatch loop continues. A planner result with `updated_cards: [{ id, status: 'backlog' }]` for a `failed` card is accepted (legal transition) and the card lands in `'backlog'`.
- New unit test `tests/runtime/dispatch-pending-activations-failed-card.test.ts`: when `getPendingActivationCards` returns a card with `status === 'failed'`, `transitionCard(id, 'restart', ...)` is invoked; the matrix allows it; the card progresses through `backlog → active → running`; no `Invalid transition` line is logged.
- **Live LXC probe (probe-C)**, see §Live probe sequence: after one induced-failure cycle on the GetRich-v2 deployment, `errors.jsonl` contains zero `Invalid transition: failed → (active|running)` lines.

**Rollback:** revert; direct `cardStore.setStatus` calls return; F23 reopens.

## Step 6 — Route runtime-state writes through the machine; consolidate the eight clear-state blobs (closes F19)

**Goal:** every owned-field write in `runtime.ts` goes through `transition()`. The machine writes `status`, `current_card_id`, `current_agent_session_id`, `active_card_run`, `paused`, `paused_at`, `last_tick_at` together in one disk write, with invariant assertions. The missing clear after the executor-failure branch (the F19 root cause) becomes a `transition('card_terminated', { cardId: card.id, outcome: 'failed' })` call before the inner `return`. The machine then consults `runtime_intent.status`: if `'running'`, pops to the parent planner run via `parentPlannerRunFor` and schedules one `redispatchGoal(parentRun.card_id)` via the scheduler dep; if `'stopped'`, transitions to `'idle'`. Either way, `current_card_id` never points at a terminal card after the next tick.

**Files:**

- [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) — apply every Step 6 conversion from the "Direct-writer inventory" above. Delete the `safeTick` method, `_safeTickInFlight`, and `_autoDispatchFirstBacklogGoal`. Delete the `setTimeout(() => { void this.safeTick(); }, 0)` at the end of `startup()` and the `void this.safeTick();` at the end of `resume()` — both are subsumed by the machine's tick.
- [src/runtime/state.ts](../../../src/runtime/state.ts) — no change; `updateRuntimeState` stays for ledger fields.

**Validation:**

- `npm run typecheck` clean.
- `NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime tests/server tests/lifecycle --runInBand --forceExit` green; rewrite tests that asserted exact disk-write argument shapes to assert on machine `transition` calls.
- New integration test `tests/runtime/executor-failure-recovery.test.ts`: fake executor returns `status: 'failed'`; within 5s of the return, `readRuntimeState().current_card_id` is either `null` or the parent goal id; `runtime.status` is `'running'` (parent in flight) or `'idle'`; never `'running'` + terminal card id. Run with a `runtime_intent.status: 'running'` precondition and an open root run; exactly one `redispatchGoal` is scheduled.
- New integration test `tests/runtime/runtime-status-matches-disk.test.ts`: drive a full start_project → executor failure cycle; assert `/api/runtime/status.runtime === readRuntimeState().status` at every poll for 30s.
- **Live LXC probe (probe-D, F19 acceptance)**, see §Live probe sequence.

**Rollback:** revert; clear blobs return and F19 reopens.

## Step 7 — Dead-code sweep

**Goal:** remove everything orphaned by Steps 1–6.

**Items to delete (verify each with the noted grep):**

- `_status: RuntimeStatus = 'idle';` field on `Runtime` — verify `rg -n "_status\b" src/runtime/runtime.ts` is empty.
- `_safeTickInFlight: boolean` field — verify `rg -n "_safeTickInFlight" src/runtime/` is empty.
- `private async safeTick(): Promise<void>` method — verify `rg -n "safeTick" src/runtime/` only matches state-machine method calls (none on `Runtime`).
- `private async _autoDispatchFirstBacklogGoal()` method — verify `rg -n "_autoDispatchFirstBacklogGoal" src/runtime/` is empty.
- `setTimeout(() => { void this.safeTick(); }, 0);` at the end of `startup()` — verify `rg -n "this\.safeTick" src/runtime/` is empty.
- `void this.safeTick();` at the end of `resume()` — same grep.
- `mirrorRuntimeState` in [src/runtime/control.ts](../../../src/runtime/control.ts) — verify `rg -n "mirrorRuntimeState" src/` is empty.
- The eight `updateRuntimeState({ status: 'idle', current_card_id: null, current_agent_session_id: null, queue: [], active_card_run: null } as Partial<RuntimeState> as never)` invocations — verify `rg -n "as Partial<RuntimeState> as never" src/runtime/runtime.ts` is empty (these casts only exist because the inline blobs bypassed the schema's type guard).
- Any test fixtures that exercised the legacy `_status` setter behaviour exclusively — `rg -n "_status" tests/runtime/` should return no matches against runtime internals.
- Orphan imports in [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) after the rewrites — `npm run lint` flags unused imports; remove each one flagged.
- The internal flag `enforceInvariants` if it is no longer needed after Step 4 (every constructor passes `true`) — collapse to always-on.

**Validation:**

- `npm run typecheck` clean.
- `npm test` (full Jest suite) green.
- `npm run lint` clean.
- `npm run web:test:operator-smoke` green (no UI fanout regression).
- `npm run docs:verify` green.
- Final greps return zero hits as noted above.

**Rollback:** not applicable — this is the cleanup. If a regression surfaces, the orphans were unused so re-adding them is a no-op; revert the specific Step that introduced the regression instead.

## Live probe sequence (LXC)

Target deployment: `saivage-v3-getrich.service` on `10.0.3.170`. This is the documented Saivage v3 production-style deployment per the [saivage-development-validation](../../../../.github/skills/saivage-development-validation/SKILL.md) skill ("the codebase is bind mounted; build on the host, restart the service, then probe health"). The earlier r1 plan named an undocumented `saivage-v3-checkers-e2e` container at `10.0.3.180` and read a token from a host file — both are explicitly replaced here. The current authorised flow for token access is "use only user-authorized local tokens and never print token values" (skill, "Live Verification"); the operator runs the probe and pastes the API status into the PR; the AI does not read or copy the token value.

Shared header (operator runs once, exports locally; never prints `$TOKEN`):

```bash
# Operator-only: source local token from authorized location. NEVER print $TOKEN.
export API=http://10.0.3.170:8080
export H="Authorization: Bearer $SAIVAGE_API_TOKEN"  # SAIVAGE_API_TOKEN set in operator shell
```

Build-and-deploy header (run before any probe that requires the latest code):

```bash
cd /home/salva/g/ml/saivage-v3
npm run build
ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service && systemctl is-active saivage-v3-getrich.service'
curl -fsS $API/health
```

### Probe-A (Step 3) — `last_tick_at` advances; no invariant violations

```bash
# After deploy
T0=$(curl -fsS -H "$H" $API/api/runtime/status | jq -r .lastTickAt)
sleep 7
T1=$(curl -fsS -H "$H" $API/api/runtime/status | jq -r .lastTickAt)
test -n "$T0" -a -n "$T1" -a "$T0" != "null" -a "$T1" != "null" -a "$T1" \> "$T0" \
  && echo "PASS probe-A: ticks advanced ($T0 -> $T1)" \
  || { echo "FAIL probe-A: ticks did not advance ($T0 -> $T1)"; exit 1; }
ssh root@10.0.3.170 \
  'grep "state_machine_invariant" /work/getrich-v2/.saivage/errors.jsonl 2>/dev/null | wc -l' \
  | awk '$1 == 0 { print "PASS probe-A: no invariant violations"; exit 0 } { print "FAIL probe-A: invariant violations="$1; exit 1 }'
```

### Probe-B (Step 4) — in-memory/disk consistency

```bash
# After deploy
API_STATUS=$(curl -fsS -H "$H" $API/api/runtime/status | jq -r .runtime)
DISK_STATUS=$(ssh root@10.0.3.170 'jq -r .status /work/getrich-v2/.saivage/tmp/state/runtime.json')
test "$API_STATUS" = "$DISK_STATUS" \
  && echo "PASS probe-B: consistent ($API_STATUS)" \
  || { echo "FAIL probe-B: api=$API_STATUS disk=$DISK_STATUS"; exit 1; }
```

Then exercise pause/resume (the path that was previously drifting):

```bash
curl -fsS -X POST -H "$H" $API/api/runtime/pause
sleep 1
API_AFTER_PAUSE=$(curl -fsS -H "$H" $API/api/runtime/status | jq -r .runtime)
DISK_AFTER_PAUSE=$(ssh root@10.0.3.170 'jq -r .status /work/getrich-v2/.saivage/tmp/state/runtime.json')
test "$API_AFTER_PAUSE" = "paused" -a "$DISK_AFTER_PAUSE" = "paused" \
  && echo "PASS probe-B (pause): both paused" \
  || { echo "FAIL probe-B (pause): api=$API_AFTER_PAUSE disk=$DISK_AFTER_PAUSE"; exit 1; }
curl -fsS -X POST -H "$H" $API/api/runtime/resume >/dev/null
```

### Probe-C (Step 5) — no illegal `failed → (active|running)` errors

Driven by a deterministic Jest integration fixture, not by waiting on real executor behaviour. The integration test introduced in Step 5 (`tests/runtime/dispatch-pending-activations-failed-card.test.ts`) is the authoritative deterministic check. The live probe verifies the production deployment has not regressed across recent history:

```bash
ssh root@10.0.3.170 \
  'grep -E "Invalid transition: failed -> (active|running)" /work/getrich-v2/.saivage/errors.jsonl 2>/dev/null | wc -l' \
  | awk '$1 == 0 { print "PASS probe-C: no illegal failed-> active/running"; exit 0 } { print "FAIL probe-C: count="$1; exit 1 }'
```

If `errors.jsonl` already contains historical lines from before the fix, the operator truncates the file or rotates it before this probe (`ssh root@10.0.3.170 'mv /work/getrich-v2/.saivage/errors.jsonl{,.pre-f19}'`) so the probe scopes to post-fix behaviour. No `sleep 600` waits are used.

### Probe-D (Step 6, F19 acceptance) — runtime auto-recovers from failed current card

The deterministic version of this probe is the integration test `tests/runtime/executor-failure-recovery.test.ts` introduced in Step 6, which uses the existing `FakeAgentAdapter` test seam in [src/agents/](../../../src/agents/) — the same seam already exercised by the runtime tests under `tests/runtime/`. The live probe is a non-deterministic confirmation against the production deployment:

```bash
# After deploy; operator has started a project that is expected to surface a failed card.
DEADLINE_MS=30000
START_MS=$(date +%s%3N)
prev_card=""
prev_runtime=""
while :; do
  NOW_MS=$(date +%s%3N)
  STATE=$(curl -fsS -H "$H" $API/api/runtime/status)
  RT=$(echo "$STATE" | jq -r .runtime)
  CC=$(echo "$STATE" | jq -r .currentCardId)
  if [ "$CC" != "null" ] && [ "$CC" != "" ]; then
    CARD_STATUS=$(curl -fsS -H "$H" $API/api/cards/$CC | jq -r .status)
    if [ "$CARD_STATUS" = "failed" ] || [ "$CARD_STATUS" = "done" ] || [ "$CARD_STATUS" = "cancelled" ]; then
      # contract C3: terminal currentCardId must not persist past one tick window
      sleep 6
      STATE2=$(curl -fsS -H "$H" $API/api/runtime/status)
      RT2=$(echo "$STATE2" | jq -r .runtime)
      CC2=$(echo "$STATE2" | jq -r .currentCardId)
      if [ "$CC2" = "$CC" ] && [ "$RT2" = "running" ]; then
        echo "FAIL probe-D: pinned currentCardId=$CC runtime=$RT2 after 6s"
        exit 1
      fi
      echo "PASS probe-D: recovered from terminal card $CC (runtime=$RT2 currentCardId=$CC2)"
      exit 0
    fi
  fi
  if [ $((NOW_MS - START_MS)) -gt $DEADLINE_MS ]; then
    echo "INCONCLUSIVE probe-D: no terminal card observed within ${DEADLINE_MS}ms; rely on Jest integration test"
    exit 0
  fi
  sleep 2
done
```

### Probe-E

**Removed.** F20 is no longer in this PR series; the F20 design owns its own live probe.

## Rollback strategy (overall)

Each step is one PR. To revert to the broken Phase-2 baseline, revert in reverse order: 7 → 6 → 5 → 4 → 3 → 2 → 1. Steps 1–3 are safe to leave in place even if 4–7 are reverted (additive only). Steps 4 and 6 are the substantive behaviour changes; reverting either alone re-opens F19. Step 5 alone reverts F23.

## Changes vs r1

- Reviewer §1: every Vitest invocation replaced with Jest commands aligned to `package.json`; new tests placed under `tests/runtime/` per `jest.roots`.
- Reviewer §2: Step 1 expanded to include the `RuntimeState` TypeScript interface, the inactive-runtime fallback in `server.ts`, and `ActiveRuntime.getStatus()`'s return type.
- Reviewer §3: Step 4 adds an explicit shutdown-while-frozen regression test and rewrites the frozen short-circuit to read persisted state.
- Reviewer §4: the "Direct-writer inventory" section enumerates every owned-field writer in the runtime layer with the step that converts it (or marks it explicitly out of scope), keyed to the reviewer's suggested `rg` command.
- Reviewer §5: Step 5 adds a public `Runtime.stateMachine` / `ActiveRuntime.stateMachine` accessor so `control.ts` does not reach through privates.
- Reviewer §6: the F23 planner-status test asserts **rejection** (with one log line and the card unchanged), not "log a correction and land in `running`". The unsafe r1 contract is dropped.
- Reviewer §7: F20 and the original Step 7 are removed; `needs_corrections` is documented as a CardStatus addition that belongs in F20's own PR series with full schema/UI/permission impact.
- Reviewer §8: the live probe targets `saivage-v3-getrich.service` on the documented `10.0.3.170` host per the validation skill; no undocumented container, no host token file read, no `sleep 600`, deterministic Jest fixture is the primary acceptance check, live probe is the confirmation.
- Reviewer §9: integration coverage list expanded — `executor-failure-recovery.test.ts`, `runtime-status-matches-disk.test.ts`, `pause-resume-disk-consistency.test.ts`, `state-machine-planner-set-status.test.ts`, `dispatch-pending-activations-failed-card.test.ts`, `runtime-shutdown-while-frozen.test.ts`.
- Reviewer §10: dead-code list in Step 7 cross-checked against `rg` queries per item; out-of-scope direct writers (`runtime-config-notes.ts`, `control.ts` no-runtime fallback) are called out explicitly with reasons.
