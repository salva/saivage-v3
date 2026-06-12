# F19 — Implementation Plan (r3)

Implements Proposal B from [02-design-r3.md](02-design-r3.md). Each step is a self-contained PR that compiles, passes `npm run typecheck`, passes its own tests, and leaves the system in a runnable state. Test commands match the package's Jest layout (`tests/` at repo root, ESM-flagged Jest). Changes vs r2 are summarised at the end.

## Coordination with F13 r3

F13 r3 converts `Runtime` / `ActiveRuntime` construction to async factories (`Runtime.open(config)` / `ActiveRuntime.open(projectRoot, config, mcpManager)`). **F13 r3 lands first; F19 rebases.** Every step below assumes the post-F13 construction shape; the pre-F13 alternative is noted inline only at Step 3 (the only step whose wiring location changes). If the merge order flips at PR time, only Step 3's instantiation snippet is rewritten; the seam itself and every subsequent step are unchanged.

## Validation commands (run after every step)

The active LXC harness is `saivage-v3-getrich.service` on `10.0.3.170` (per [../../../../../.github/skills/saivage-development-validation/SKILL.md](../../../../../.github/skills/saivage-development-validation/SKILL.md)). Standard commands (also recorded in repo memory `saivage-validation-commands`):

```
cd /home/salva/g/ml/saivage-v3
npm run typecheck
NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime --runInBand --forceExit
npm test
npm run web:test:operator-smoke
npm run docs:verify
```

`web/` is the only Vitest surface (operator smoke); backend is Jest-only. Step-local extra commands are listed per step.

## Step 1 — Contract: add `lastTickAt` to `RuntimeState` and `/api/runtime/status`

**Files**: [src/runtime/state.ts](../../../../src/runtime/state.ts), [src/server/server.ts](../../../../src/server/server.ts), the test alongside.

- Add `last_tick_at: string | null` to `RuntimeState`; default `null`. Update the type guard / Zod schema for `RuntimeState`.
- Update `/api/runtime/status` to include `lastTickAt: state?.last_tick_at ?? null` on both active and fallback branches.
- Update [docs/runtime-state.md](../../../../docs/runtime-state.md) (if present; else skip — `docs:verify` will assert) and the operator API doc.

**Tests**: a unit test asserting that a freshly persisted `RuntimeState` round-trips `last_tick_at` and that the route includes the field as `null` by default. Lives at `tests/runtime/runtime-state-last-tick-at.test.ts`.

**Acceptance**: `npm run typecheck`, `npm run docs:verify`, `NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime --runInBand --forceExit` green; full `npm test` green.

## Step 2 — Skeleton: `RuntimeStateMachine` class with invariant types and the staging flag

**Files added**: `src/runtime/state-machine.ts`, `tests/runtime/state-machine.test.ts`.

- Define `RuntimeStateMachineEvent` union (`'start_project' | 'goal_exit' | 'card_terminated' | 'paused' | 'resumed' | 'freeze' | 'unfreeze' | 'startup_repair' | 'reviewer_started' | 'reviewer_finished' | 'tick'`).
- Define `RuntimeCardAction` union (`'start' | 'restart' | 'cancel' | 'planner_set_status' | 'block' | 'complete' | 'fail' | 'crash_recovery_drop_to_backlog'`).
- Constructor with `{ cardStore, readState, writeState, errorLogger, clock, scheduler, redispatchGoal, enforceInvariants }` deps. **No `projectRoot`. No `fs`.**
- `start()` registers the interval timer through the injected scheduler; `stop()` clears it. `transition(event, payload)` and `transitionCard(cardId, action, payload)` are no-op delegating stubs for now (they call `cardStore`/`writeState` directly using the exact same code as the current call sites would).
- `tick()` stamps `last_tick_at = clock().toISOString()` and asserts I4 (monotonicity) only.
- `enforceInvariants` is wired through to `tick()`: when `false`, invariants I1–I3 are observed (detected and logged once per `(invariant, key)` tuple via `errorLogger`) but **not** auto-corrected. When `true`, the full auto-correction in Step 6 lights up. In Step 2 the auto-correction code does not yet exist; only the gate is present.

**Tests**: 
- machine constructs with stub deps; 
- `start()`/`stop()` schedule/clear the interval through the injected scheduler; 
- `tick()` writes `last_tick_at`; 
- on-demand `transition('tick')` is gated by the re-entrancy lock; 
- I4 monotonicity test: clock that goes backwards triggers one `state_machine_invariant` error;
- `enforceInvariants: false` does not auto-correct (a forced I1 violation in the test fixture stays uncorrected and produces exactly one log line).

**Not wired into `Runtime` yet.**

**Acceptance**: jest + typecheck + full `npm test` green.

## Step 3 — Wire the machine into `Runtime`, observe-only

**Files**: [src/runtime/runtime.ts](../../../../src/runtime/runtime.ts), [src/runtime/active-runtime.ts](../../../../src/runtime/active-runtime.ts) (post-F13: `Runtime.open()` / `ActiveRuntime.open()` factories).

- Post-F13 wiring (canonical): `Runtime.open(config)` instantiates `new RuntimeStateMachine({ cardStore, readState, writeState, errorLogger, clock: () => new Date(), scheduler: globalScheduler, redispatchGoal: (id) => this.dispatchGoal(id), enforceInvariants: false })` after the async setup completes and before the `Runtime` instance is returned. Call `_stateMachine.start()` inside `startup()`; call `_stateMachine.stop()` inside `shutdown()`. `ActiveRuntime.open(projectRoot, config, mcpManager)` exposes `stateMachine` as a getter on the returned instance.
- Pre-F13 fallback (in case merge order flips): same construction in `Runtime`'s sync constructor and same lifecycle hooks. This branch is deleted from the final PR if F13 r3 has already landed.
- No call sites change yet. The machine ticks every 5s and updates `last_tick_at`. `enforceInvariants: false` keeps I1–I3 observe-only — invariant violations are logged to `errors.jsonl` once per `(invariant, key)` tuple but the machine does not yet auto-correct, because `_status` is still authoritative and a corrective `status` write would re-diverge.

**Tests**: an integration test that constructs `Runtime` (via `Runtime.open()` post-F13) against a temp project, asserts `readRuntimeState(...).last_tick_at` advances after a `setTimeout(0)` flush, then shuts down cleanly. Lives at `tests/runtime/state-machine-wired.test.ts`.

**Acceptance**: all of §Validation, plus a live ping of `GET /api/runtime/status` on the LXC harness showing `lastTickAt` is non-null after one tick.

## Step 4 — Replace `_status` with disk-backed reads; flip `enforceInvariants` to `true`

**Files**: [src/runtime/runtime.ts](../../../../src/runtime/runtime.ts), [src/runtime/control.ts](../../../../src/runtime/control.ts).

- Delete the `_status` field. Replace the `status` getter with `return this.readRuntimeStateBound()?.status ?? 'idle'` (where `readRuntimeStateBound` is the same bound `readRuntimeState(projectRoot)` already used by the machine; reuse it).
- Delete every `this._status = ...` assignment (five sites).
- Update `shutdown()`'s `'frozen'` short-circuit to read disk instead of `_status`.
- Replace `mirrorRuntimeState` callers in [src/runtime/control.ts](../../../../src/runtime/control.ts) with `runtime.stateMachine.transition('paused')` / `transition('resumed')`. The transition writes `status: 'paused' | <prior>`, `paused: true|false`, `paused_at: timestamp|null` atomically through the machine. Delete `mirrorRuntimeState`.
- Flip `Runtime`'s machine instantiation to `enforceInvariants: true`. Invariant auto-correction (I1–I3) is now active. (The auto-correction code itself lands in Step 6; in Step 4 the only branch reached is I4 + the observe-only logging path; flipping the flag only matters once Step 6 fills in the corrective writes.)

**Tests**: 
- regression test for pause/resume: after `POST /api/runtime/pause`, both `/api/runtime/status.runtime === 'paused'` and `readRuntimeState(root).status === 'paused'`. This test was red before the fix (mirror overwrote disk with stale `_status`) and is green after.
- regression test for shutdown-while-frozen: persist `status: 'frozen'`, construct `Runtime` via `Runtime.open()`, call `shutdown()`, assert clean exit without touching the now-deleted `_status`.

**Acceptance**: §Validation green.

## Step 5 — Route runtime-originating `cardStore` status writes through `transitionCard`

**Files**: [src/runtime/runtime.ts](../../../../src/runtime/runtime.ts), plus the unit tests for each new transition.

Per-site checklist (one bullet per row in the inventory table at the bottom of [01-analysis-r3.md](01-analysis-r3.md)). Every site is either converted or annotated against the out-of-scope allowlist; the Step 7 grep gate enforces zero direct `cardStore` status writes inside `src/runtime/runtime.ts`.

- [ ] [src/runtime/runtime.ts L266](../../../../src/runtime/runtime.ts#L266) — `repairStartupActiveCardRun` reviewer-phase repair: convert `cardStore.update(run.card_id, { status: 'running' })` → `this._stateMachine.transitionCard(run.card_id, 'restart', { reason: 'reviewer_interrupted' })`. Action `restart` is matrix-allowed for `RESTARTABLE_STATES` and decomposes to `failed|cancelled|done|blocked|changed → backlog → active → running`; for the active case the machine first asserts `card.status` is one of those (the repair only runs for cards persisted across a service restart, all of which are non-`active`/`running` by construction).
- [ ] [src/runtime/runtime.ts L278](../../../../src/runtime/runtime.ts#L278) — `repairStartupActiveCardRun` executor-phase repair: convert `cardStore.update(run.card_id, { status: 'failed', error, result })` → `this._stateMachine.transitionCard(run.card_id, 'fail', { reason: 'service_restart', error })` then a follow-up direct `cardStore.update(run.card_id, { error, result })` for the non-status fields (the machine owns `status` only).
- [ ] [src/runtime/runtime.ts L614](../../../../src/runtime/runtime.ts#L614) — `performCrashRecovery` drop-to-backlog: convert `if (card.status === 'active' || card.status === 'running') this.cardStore.setStatus(card.id, 'backlog')` → `this._stateMachine.transitionCard(card.id, 'crash_recovery_drop_to_backlog')`. The machine's pre-condition matches the existing `if` guard.
- [ ] [src/runtime/runtime.ts L635](../../../../src/runtime/runtime.ts#L635) — planner-exception catch in `dispatchGoal`: convert `cardStore.update(goalId, { status: 'failed', error, status_text })` → `this._stateMachine.transitionCard(goalId, 'fail', { reason: 'planner_error', error })`, then the non-status `cardStore.update(goalId, { error, status_text })` for the remaining fields.
- [ ] [src/runtime/runtime.ts L644](../../../../src/runtime/runtime.ts#L644) — planner-blocked exit: convert the `setStatus(goalId, 'running'); setStatus(goalId, 'blocked')` micro-sequence → `this._stateMachine.transitionCard(goalId, 'block', { blocked_reason })`. The machine emits `→ running → blocked` atomically; the runtime-side double call is deleted.
- [ ] [src/runtime/runtime.ts L660](../../../../src/runtime/runtime.ts#L660) — goal-completed happy path: convert `setStatus(goalId, 'running'); setStatus(goalId, 'done')` → `this._stateMachine.transitionCard(goalId, 'complete', { assessment })`.
- [ ] [src/runtime/runtime.ts L706](../../../../src/runtime/runtime.ts#L706) — executor-target start (F19/F23 primary site): convert `if (card.status === 'backlog') setStatus(card.id, 'active'); setStatus(card.id, 'running')` → `const action: RuntimeCardAction = STARTABLE.has(card.status) ? 'start' : 'restart'; this._stateMachine.transitionCard(card.id, action, { goalId });`. `STARTABLE` is `new Set([...STARTABLE_STATES])` imported from [src/permissions/card-permissions.ts](../../../../src/permissions/card-permissions.ts).
- [ ] [src/runtime/runtime.ts L715](../../../../src/runtime/runtime.ts#L715) — executor exception catch: convert `cardStore.setStatus(card.id, 'failed')` → `this._stateMachine.transitionCard(card.id, 'fail', { reason: 'executor_exception', error })`. Pair with the existing `updateRuntimeState` clear-state write replacement covered in Step 6.
- [ ] [src/runtime/runtime.ts L740](../../../../src/runtime/runtime.ts#L740) — evidence-registration-failure branch: convert `cardStore.update(card.id, { status: 'failed', error: registrationError, result })` → `this._stateMachine.transitionCard(card.id, 'fail', { reason: 'evidence_registration_failed', error: registrationError })` then `cardStore.update(card.id, { error: registrationError, result })` for non-status fields.
- [ ] L758 — **runtime-state field write only**, not a `CardStatus` writer; the corresponding `transition('reviewer_started', { goalId, reviewerSessionId, ...activeCardRun })` conversion lands in Step 6 alongside the rest of the owned-fields rewrite. No conversion in Step 5.
- [ ] [src/runtime/runtime.ts L766–L782](../../../../src/runtime/runtime.ts#L766) — `applyPlannerResult.untrackedChanges.status` planner-supplied status: convert `cardStore.update(update.id, { status: update.status as CardRecord['status'] })` → `const ok = this._stateMachine.transitionCard(update.id, 'planner_set_status', { requestedStatus: update.status }); if (!ok) untrackedChanges.rejected.push({ id: update.id, requestedStatus: update.status, reason: 'state_machine_planner_status_rejected' });`. Closes the Route-2 silent-write defect.
- [ ] [src/runtime/runtime.ts L784](../../../../src/runtime/runtime.ts#L784) — `simulateCrash`: convert the same `if (card.status === 'active' || card.status === 'running') this.cardStore.setStatus(card.id, 'backlog')` shape as L614 → `this._stateMachine.transitionCard(card.id, 'crash_recovery_drop_to_backlog')`. Keeps the diagnostic helper honest.
- [ ] Out-of-scope (do **not** convert): every call site listed under "Out-of-scope card-status writers" in [01-analysis-r3.md](01-analysis-r3.md). Each is annotated with a top-of-file comment justifying the exemption only if a comment does not already exist there (the project guideline forbids adding commentary to untouched code; the only files touched in Step 5 are `src/runtime/runtime.ts` and the new machine module, so no out-of-scope file gets a new comment unless its body is already being edited for an unrelated reason).
- [ ] Final gate (run in this PR, repeated in Step 7): `rg -n "cardStore\.setStatus|cardStore\.update\([^\n]*status|untrackedChanges\.status" src/runtime/runtime.ts` returns zero matches.

**Tests added in this step** (in `tests/runtime/state-machine.test.ts`):

- `transitionCard(id, 'start', { goalId })` accept/reject table for every `CardStatus` (accepts `drafting|backlog|changed`, rejects the rest).
- `transitionCard(id, 'restart', { goalId })` accept/reject table for every `CardStatus` (accepts `blocked|changed|done|failed|cancelled`, rejects `active|running|drafting|backlog`).
- `transitionCard(failed-card, 'restart', ...)` produces the legal one-step sequence `failed → backlog`, `backlog → active`, `active → running` via three `cardStore.setStatus` calls in order. No `Invalid transition` thrown.
- `transitionCard(failed-card, 'start', ...)` is rejected by `decide({ role: 'planner', action: 'card.start', targetState: 'failed' })`; machine returns `false` and writes no `cardStore.setStatus` call.
- `transitionCard(failed-card, 'planner_set_status', { requestedStatus: 'active' })` is rejected by `cardStore.validateTransition('failed','active')`; machine returns `false`, writes one `state_machine_planner_status_rejected` log line, leaves the card unchanged.
- `transitionCard(goal-card, 'block', ...)` from `running` produces a single legal step `running → blocked`; from `active` produces `active → running → blocked`; from `drafting|backlog|blocked|changed|done|failed|cancelled` rejects with no writes.
- `transitionCard(goal-card, 'complete', ...)` same shape as `'block'` but the final step is `done`.
- `transitionCard(card, 'crash_recovery_drop_to_backlog')` accepts from `active|running`, rejects elsewhere.
- `transitionCard(card, 'fail', ...)` accepts from any non-terminal status, rejects from `done|failed|cancelled`.

Integration: an end-to-end `dispatchGoal` test with a fake `AgentRuntime` that returns `status: 'failed'` on the executor turn. Asserts `readRuntimeState(root).current_card_id` becomes `null` (or the parent goal id) within 5s; asserts the only `errors.jsonl` line is `card_failed`, not `Invalid transition`. Lives at `tests/runtime/executor-failure-recovery.test.ts`. **This test is the F19 acceptance gate.**

**Acceptance**: §Validation green; `tests/runtime/executor-failure-recovery.test.ts` green; live LXC ping shows the F19 wedge scenario recovers within the 30s outer budget (see Probe-D below — informational only).

## Step 6 — Consolidate tick ownership and runtime-state writes

**Files**: [src/runtime/runtime.ts](../../../../src/runtime/runtime.ts), the machine, the integration tests.

- The machine's `tick()` now performs the I1/I2/I3 corrective writes (auto-correction was already gated on by `enforceInvariants: true` in Step 4; Step 6 fills in the corrective bodies). Each correction emits one `state_machine_invariant` log line.
- Delete `safeTick`, `_safeTickInFlight`, `_autoDispatchFirstBacklogGoal` from `Runtime`. The single callers in `startup()` and `resume()` are replaced with `this._stateMachine.requestImmediateTick()`, which the machine de-dupes against the interval lock.
- Replace the eight inline `updateRuntimeState(... { status, current_card_id: null, current_agent_session_id: null, queue: [], active_card_run: null } as ... as never)` blobs in `runtime.ts` with `this._stateMachine.transition('goal_exit' | 'card_terminated' | 'paused' | 'goal_completed', payload)`. Drop the `as Partial<RuntimeState> as never` casts in the same edit. The L758 `invokeReviewer` write becomes `this._stateMachine.transition('reviewer_started', { goalId, reviewerSessionId, activeCardRun })`; the matching post-reviewer write becomes `transition('reviewer_finished', ...)`.
- The machine schedules re-dispatch via the injected `redispatchGoal` dep when invariant I2 corrects to a parent run with `runtime_intent.status === 'running'`; `Runtime`'s existing `_dispatchInFlight` set is the dedup gate (the dep wraps `dispatchGoal`).

**Tests**: I1–I3 violations triggered in a fixture, machine auto-corrects within one tick, one `state_machine_invariant` line written per `(invariant, key)` tuple, no duplicate writes per tick.

**Acceptance**: §Validation green; the F19 integration test still passes; the F23 integration test in [tests/runtime/](../../../../tests/runtime/) (added by Step 5) still passes.

## Step 7 — Remove staging flag, sweep dead code, lock final invariants

**Files**: machine, runtime, control, possibly `state.ts` if any `as Partial<RuntimeState> as never` casts remain.

- Remove the `enforceInvariants` constructor parameter. Collapse every `if (this.enforceInvariants)` branch in `tick()` to always-enforce. Remove the wiring in `Runtime` that passes the flag.
- Verify nothing else depends on the flag: `rg -n "enforceInvariants" src/ tests/` returns zero matches.
- `rg -n "cardStore\.setStatus|cardStore\.update\([^\n]*status|untrackedChanges\.status" src/runtime/runtime.ts` returns zero matches (the Step 5 gate, re-run as a permanent gate).
- `rg -n "as Partial<RuntimeState> as never" src/runtime/runtime.ts` returns zero matches.
- `rg -n "this\._status\s*=" src/` returns zero matches (already true after Step 4; re-run as a defence-in-depth gate).
- `rg -n "mirrorRuntimeState" src/` returns zero matches (already true after Step 4).
- `rg -n "safeTick\|_safeTickInFlight\|_autoDispatchFirstBacklogGoal" src/runtime/runtime.ts` returns zero matches (already true after Step 6).
- All dead `_status`-era types, helpers, and JSDoc are deleted.

**Acceptance**: every gate above plus §Validation green; one final live probe (see "Live verification" below).

## Live verification (deferred to Step 5 + Step 7)

Run after Step 5 (informational) and after Step 7 (final gate), against `saivage-v3-getrich.service` at `10.0.3.170` (per [saivage-development-validation skill](../../../../../.github/skills/saivage-development-validation/SKILL.md) and repo memory `saivage-v3-build-deploy`).

- **Probe-A** — pause/resume drift regression: `curl -fsS http://10.0.3.170:8080/api/runtime/pause && sleep 2 && curl -fsS http://10.0.3.170:8080/api/runtime/status | jq '.runtime, .paused' && cat /opt/saivage-v3-getrich/.saivage/runtime/runtime.json | jq '.status, .paused' && curl -fsS http://10.0.3.170:8080/api/runtime/resume`. Expected: HTTP `runtime: "paused"`, `paused: true`; disk `status: "paused"`, `paused: true`.
- **Probe-B** — `lastTickAt` liveness: `curl -fsS http://10.0.3.170:8080/api/runtime/status | jq '.lastTickAt'` returns a non-null ISO timestamp that advances on a second call ≥ 5s later.
- **Probe-C** — executor-failure wedge recovery: induce a known-failing executor card; observe `current_card_id` becomes `null` or repoints to the parent within 30s; `tail -n 200 /opt/saivage-v3-getrich/.saivage/runtime/errors.jsonl | grep -E "Invalid transition: failed (→|->) (active|running)"` returns zero matches. The grep is **Unicode-aware**: `CardStore.validateTransition` emits the Unicode `→` arrow ([src/cards/card-store.ts L1081-L1087](../../../../src/cards/card-store.ts#L1081-L1087)); the simpler `grep "Invalid transition: failed"` is also acceptable and avoids the arrow encoding question entirely (use that one if the host lacks UTF-8-aware grep).
- **Probe-D** — invariant auto-correction observability: with the runtime paused at a known terminal-pinned state (reproduce by stopping the service mid-failure or by toggling a card to `failed` while it is `current_card_id`), restart the service and observe one `state_machine_invariant` line appears in `errors.jsonl` within 5s and `/api/runtime/status` then reports a consistent state. **Probe-D INCONCLUSIVE does NOT count as F19 acceptance.** The deterministic acceptance gate is the Jest integration test `tests/runtime/executor-failure-recovery.test.ts` from Step 5 (and its sibling I1-violation auto-correction test from Step 6). Probe-D is informational telemetry: if reproducing the pinned state in the live harness proves flaky, document the inconclusive result and move on. The Jest gate is sufficient to merge.

## Risks and mitigations

- **Tick interval interacts with planner long-running calls.** Mitigated by re-entrancy lock and `_dispatchInFlight` dedup; the tick never enters `dispatchGoal` if one is already running.
- **Operator-API restart racing runtime auto-restart.** The existing per-card lock in `CardStore` decides; no new race introduced.
- **The two regression tests in Step 4** (`pause/resume` and `shutdown-while-frozen`) explicitly fail without the `_status` deletion; they are the canary that the architectural shift held.
- **F13 r3 merge order.** If F19 lands before F13 r3 (against the documented order), Step 3 falls back to the pre-F13 sync-constructor wiring snippet. The seam and every subsequent step are unchanged.
- **Live probe flakiness.** Probe-D specifically (terminal-pinned reproduction in the live harness) may not be reliably reproducible on demand. The plan therefore designates the deterministic Jest tests as the acceptance gate; probes are diagnostic, not gating.

## Changes vs r2

- Reviewer §1 (Step 5 checklist): every site from the analysis inventory table is enumerated one-to-one with its replacement action (or its out-of-scope justification). The action picked at each site is consistent with the design's per-action accept/reject table.
- Reviewer §2 (final rg gates): Step 7 now has explicit `rg` patterns covering `cardStore.setStatus|cardStore.update({...status...})|untrackedChanges.status` in `runtime.ts`, the `as Partial<RuntimeState> as never` cast, `this._status =`, `mirrorRuntimeState`, `safeTick`/`_safeTickInFlight`/`_autoDispatchFirstBacklogGoal`, and the `enforceInvariants` flag itself. The analyst-tools out-of-scope surface is named explicitly and is allowed by scoping the runtime grep to `src/runtime/runtime.ts`, not `src/`.
- Reviewer §3 (Probe-C grep): the grep pattern is Unicode-aware (`grep -E "Invalid transition: failed (→|->) (active|running)"`) to match the verbatim `CardStore.validateTransition` error message, with an ASCII-safe fallback (`grep "Invalid transition: failed"`) documented in case the host's grep mis-handles UTF-8.
- Reviewer §4 (Probe-D acceptance): Probe-D is downgraded to informational telemetry. The deterministic acceptance gate is `tests/runtime/executor-failure-recovery.test.ts` from Step 5 plus the I1 auto-correction test from Step 6. An INCONCLUSIVE Probe-D result is documented and does not block the merge.
- Reviewer §5 (links): all relative links recomputed. `../../../../src/...` resolves to `/home/salva/g/ml/saivage-v3/src/...` (the package root); `../../../../../.github/skills/...` resolves to the workspace root (the skill lives at `/home/salva/g/ml/.github/skills/`, not inside `saivage-v3/`).
- New "Coordination with F13 r3" subsection makes the merge order explicit (F13 first, F19 rebases). Step 3 carries both the canonical post-F13 wiring snippet and the pre-F13 fallback so the implementer can pick the one that matches the actual merge state.
