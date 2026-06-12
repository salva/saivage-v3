# F19 — Implementation Plan (r5)

Implements Proposal B from [02-design-r5.md](02-design-r5.md). Supersedes [03-plan-r4.md](03-plan-r4.md). Each step is a self-contained PR that compiles, passes `npm run typecheck`, passes its own tests, and leaves the system in a runnable state.

## Coordination with F13 r4

F13 r4 converts `Runtime` / `ActiveRuntime` construction to async factories (`Runtime.open(config)` / `ActiveRuntime.open(projectRoot, config, mcpManager)`) AND makes `cardStore.setStatus` / `cardStore.update` awaited. **F13 r4 lands first; F19 rebases.** `RuntimeStateMachine.transitionCard` is `async` (per orchestrator decision); every runtime call site `await`s it; the awaited chain composes with F13 r4's awaited store calls without extra plumbing. **Every post-F13 `cardStore.update(...)` follow-up call in the runtime is `await`ed** ([02-design-r5.md](02-design-r5.md) §Every post-`transitionCard` `cardStore.update` follow-up is awaited); the Step 7 gate enforces this with a second `rg` check.

## Validation commands (run after every step)

Active LXC harness: `saivage-v3-getrich.service` on `10.0.3.170`. Standard commands (recorded in repo memory `saivage-validation-commands`):

```
cd /home/salva/g/ml/saivage-v3
npm run typecheck
NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime --runInBand --forceExit
npm test
npm run web:test:operator-smoke
npm run docs:verify
```

Backend = Jest only. `web/` = Vitest operator smoke only. Step-local extra commands are listed per step.

## Step 1 — Contract: add `lastTickAt` to `RuntimeState` and `/api/runtime/status`

Unchanged from r4. Add `last_tick_at: string | null` to `RuntimeState` (default `null`); update the Zod schema; expose as `lastTickAt` on both active and fallback `/api/runtime/status` branches; round-trip unit test at `tests/runtime/runtime-state-last-tick-at.test.ts`; update relevant docs (`npm run docs:verify` will assert).

**Acceptance**: §Validation green.

## Step 1.5 — Export `STARTABLE_STATES` and `RESTARTABLE_STATES` (NEW in r5; reviewer §P2)

**File**: [src/permissions/card-permissions.ts](../../../../src/permissions/card-permissions.ts).

Currently L28-L29 define both constants as non-exported `const … as const satisfies …`:

```ts
const RESTARTABLE_STATES = ['blocked', 'changed', 'done', 'failed', 'cancelled'] as const satisfies readonly CardState[];
const STARTABLE_STATES   = ['drafting', 'backlog', 'changed']                  as const satisfies readonly CardState[];
```

This step adds the `export` keyword to **both** declarations (no other change):

```ts
export const RESTARTABLE_STATES = ['blocked', 'changed', 'done', 'failed', 'cancelled'] as const satisfies readonly CardState[];
export const STARTABLE_STATES   = ['drafting', 'backlog', 'changed']                    as const satisfies readonly CardState[];
```

**Why export rather than redefine locally in `state-machine.ts`.** The reviewer offered a choice (export the constants OR define local typed sets in the machine with a parity test against the permission matrix). We pick **export**, because:

- The constants are already the source of truth for the permission matrix below them in the same file; the runtime and the machine both branch on the *same* set definitions. A local redefinition needs a parity test to stay honest; an `export` makes the parity structural.
- F19's `start` / `restart` matrix calls in [02-design-r5.md](02-design-r5.md) consult `decide({ role: 'planner', action: 'card.start' | 'card.restart', targetState })` whose answers are computed from these same constants. Exporting them keeps the runtime selection (`STARTABLE.has(card.status) ? 'start' : 'restart'` at [src/runtime/runtime.ts L706](../../../../src/runtime/runtime.ts#L706)) and the decide() answer using *the* set, not a parallel one that could drift.
- One-line diff; no public-surface concern (the constants are `as const`-frozen literal tuples; consumers cannot mutate them).

**Tests**: no new tests. The existing permission-matrix tests continue to pass unchanged. The Step 5 unit tests for the machine (`tests/runtime/state-machine.test.ts`) import the constants directly from `src/permissions/card-permissions.ts` so a regression that drops the `export` keyword breaks the build.

**Acceptance**: §Validation green. `rg -n "^export const (STARTABLE_STATES|RESTARTABLE_STATES)\b" src/permissions/card-permissions.ts` returns two matches.

## Step 2 — Skeleton: `RuntimeStateMachine` class with invariant types, async signatures, staging flag

Unchanged from r4 except for the now-pinned async signatures.

- `src/runtime/state-machine.ts` and `tests/runtime/state-machine.test.ts` added.
- `RuntimeStateMachineEvent` union (unchanged from r3/r4).
- `RuntimeCardAction` union extended per [02-design-r5.md](02-design-r5.md):
  ```ts
  type RuntimeCardAction =
    | 'start' | 'restart' | 'cancel' | 'planner_set_status'
    | 'block' | 'complete' | 'fail'
    | 'executor_finish' | 'reviewer_repair_resume'
    | 'crash_recovery_drop_to_backlog';
  ```
- Constructor deps unchanged (`cardStore, readState, writeState, errorLogger, clock, scheduler, redispatchGoal, enforceInvariants`). No `projectRoot`. No `fs`.
- `transition(event, payload)` is `async`. `transitionCard(cardId, action, payload)` is `async` and returns `Promise<boolean>`. The Step 2 skeleton implements both as delegating stubs that call the existing `cardStore`/`writeState` shape one-to-one; rejection logging is wired but the decomposition logic is empty until Step 5.
- `tick()` is `async`, stamps `last_tick_at = clock().toISOString()`, asserts I4 (monotonicity). `enforceInvariants: false` keeps I1–I3 observe-only — violations are logged once per `(invariant, key)` tuple via `errorLogger`; **the corrective bodies for I1–I3 do not yet exist in the source**.

**Tests**: constructor wiring; `start()`/`stop()` schedule/clear the interval through the injected scheduler; `tick()` writes `last_tick_at`; on-demand `transition('tick')` is gated by the re-entrancy lock; I4 monotonicity test (clock that goes backwards triggers exactly one `state_machine_invariant` error); `enforceInvariants: false` does not auto-correct a forced I1 violation in the test fixture (asserts no corrective write, exactly one log line).

**Not wired into `Runtime` yet.**

**Acceptance**: §Validation green.

## Step 3 — Wire the machine into `Runtime`, observe-only

Unchanged from r4 in shape; flag value pinned to `false`.

- Post-F13: `Runtime.open(config)` instantiates `new RuntimeStateMachine({ cardStore, readState, writeState, errorLogger, clock: () => new Date(), scheduler: globalScheduler, redispatchGoal: (id) => this.dispatchGoal(id), enforceInvariants: false })` after async setup completes; `_stateMachine.start()` in `startup()`; `_stateMachine.stop()` in `shutdown()`. `ActiveRuntime.open(...)` exposes `stateMachine` as a getter.
- No call sites change yet. The machine ticks every 5s and updates `last_tick_at`. **I1–I3 are observed and logged once per tuple but NOT corrected — the corrective bodies are not in the source until Step 4.**

**Tests**: integration test at `tests/runtime/state-machine-wired.test.ts` constructs `Runtime` via `Runtime.open()`, asserts `readRuntimeState(...).last_tick_at` advances after `setTimeout(0)` flush, shuts down cleanly.

**Acceptance**: §Validation green; live `GET /api/runtime/status` on the LXC harness shows `lastTickAt` non-null after one tick.

## Step 4 — Replace `_status` with disk reads; flip `enforceInvariants` to `true`; land I1–I3 corrective bodies

**Files**: [src/runtime/runtime.ts](../../../../src/runtime/runtime.ts), [src/runtime/control.ts](../../../../src/runtime/control.ts), `src/runtime/state-machine.ts`.

- Delete the `_status` field. Replace the `status` getter with a disk read using the same `readRuntimeState(projectRoot)` already used by the machine. Delete every `this._status = ...` assignment (five sites). Update `shutdown()`'s `'frozen'` short-circuit to read disk.
- Replace `mirrorRuntimeState` callers in `control.ts` with `await runtime.stateMachine.transition('paused' | 'resumed')`. Delete `mirrorRuntimeState`.
- Flip `Runtime`'s machine instantiation to `enforceInvariants: true`.
- **Land the corrective bodies for I1, I2, I3 in `RuntimeStateMachine.tick()` in the same PR.** Per [02-design-r5.md](02-design-r5.md), this restores design/plan alignment that was broken in r3.
  - I1 (`status === 'running'` ⇒ `active_card_run !== null`): violation → emit `state_machine_invariant` once per tuple, transition `status` to `'idle'` via `writeState`.
  - I2 (`current_card_id` references a card with status ∉ `TERMINAL_STATUSES`): violation → if `parentPlannerRunFor` returns a non-null run, pop to it (`current_card_id = parentRun.card_id`, `active_card_run = parentRun`, `status = 'running'`); else clear (`current_card_id = null`, `active_card_run = null`, `status = 'idle'`). If `runtime_intent.status === 'running'` and a root run is open, schedule one `redispatchGoal('project')`.
  - I3 (`active_card_run.card_id === current_card_id` or both `null`): violation → reconcile by clearing both and treating as I2.

**Tests**:

- regression: after `POST /api/runtime/pause`, both `/api/runtime/status.runtime === 'paused'` and `readRuntimeState(root).status === 'paused'`. Red before the fix.
- regression: shutdown-while-frozen — persist `status: 'frozen'`, construct `Runtime` via `Runtime.open()`, call `shutdown()`, asserts clean exit without touching the deleted `_status`.
- I1 fixture: persist `status: 'running'` with `active_card_run: null`; one tick auto-corrects to `'idle'` and writes exactly one `state_machine_invariant` log line.
- I2 fixture: persist `current_card_id` pointing at a card flipped to `'done'` (with a parent run); one tick pops to the parent and `status` stays `'running'`; one tick later, with no parent run, `status` becomes `'idle'`.
- I3 fixture: persist `active_card_run.card_id !== current_card_id`; one tick clears both.

**Acceptance**: §Validation green.

## Step 5 — Route runtime-originating `cardStore` status writes through `await transitionCard`; await every follow-up `cardStore.update`

**Files**: [src/runtime/runtime.ts](../../../../src/runtime/runtime.ts), `src/runtime/state-machine.ts` (decomposition logic), tests under `tests/runtime/`.

**Binding rules for this step** (enforced by the Step 7 gate):

1. Every conversion uses `await this._stateMachine.transitionCard(...)`. No unawaited machine calls.
2. **Every follow-up `this.cardStore.update(...)` call in `src/runtime/runtime.ts` is `await`ed.** This covers the non-status payload writes after the startup repair, the planner-exception catch, the executor terminal restructure (both the optional ignored-evidence payload and the combined non-status payload), and any other runtime-layer `cardStore.update` call site. Rationale in [02-design-r5.md](02-design-r5.md) §Every post-`transitionCard` `cardStore.update` follow-up is awaited.
3. Imports at the top of `src/runtime/runtime.ts` add `STARTABLE_STATES` and `RESTARTABLE_STATES` from `src/permissions/card-permissions.ts` (exported per §Step 1.5). The runtime no longer redefines these sets locally.

Per-site checklist (one bullet per row in the [01-analysis-r5.md](01-analysis-r5.md) inventory table):

- [ ] [src/runtime/runtime.ts L266](../../../../src/runtime/runtime.ts#L266) — reviewer-phase repair: `cardStore.update(run.card_id, { status: 'running' })` → `await this._stateMachine.transitionCard(run.card_id, 'reviewer_repair_resume', { reason: 'reviewer_interrupted' })`. Action precondition: `card.status ∈ {'active', 'running'}`; from `active` emits `active → running`; from `running` is a no-op. Construction proof for the precondition lives in [01-analysis-r5.md](01-analysis-r5.md) §Construction proof. **No follow-up `cardStore.update` is needed at this site** (the only field being written was `status`).
- [ ] [src/runtime/runtime.ts L278](../../../../src/runtime/runtime.ts#L278) — startup executor-phase repair: `cardStore.update(run.card_id, { status: 'failed', error, result })` → `await this._stateMachine.transitionCard(run.card_id, 'fail', { reason: 'service_restart', error })` then `await this.cardStore.update(run.card_id, { error, result })` for the non-status payload.
- [ ] [src/runtime/runtime.ts L614](../../../../src/runtime/runtime.ts#L614) — crash-recovery drop-to-backlog: → `await this._stateMachine.transitionCard(card.id, 'crash_recovery_drop_to_backlog')`. No follow-up payload.
- [ ] [src/runtime/runtime.ts L635](../../../../src/runtime/runtime.ts#L635) — planner-exception catch: `cardStore.update(goalId, { status: 'failed', error, status_text })` → `await this._stateMachine.transitionCard(goalId, 'fail', { reason: 'planner_error', error })` then `await this.cardStore.update(goalId, { error, status_text })`.
- [ ] [src/runtime/runtime.ts L644](../../../../src/runtime/runtime.ts#L644) — planner-blocked exit: the top-level `setStatus(goalId, 'running'); setStatus(goalId, 'blocked')` pair → `await this._stateMachine.transitionCard(goalId, 'block', { blocked_reason })`. **The same line ALSO contains a nested `result: { ..., planning: { status: 'blocked', ... } }` write; that nested `planning.status` payload stays unchanged as an `await`ed direct `cardStore.update` because it is a result-payload field, not a `CardStatus` writer.**
- [ ] L645 — planner-continue / planner-done-with-children: only the nested `result: { ..., planning: { status: 'continue' | 'done', ... } }` payload is touched here (no top-level `status`); leave the call structurally unchanged but `await` it per binding rule 2.
- [ ] [src/runtime/runtime.ts L660](../../../../src/runtime/runtime.ts#L660) — goal-completed happy path: top-level `setStatus(goalId, 'running'); setStatus(goalId, 'done')` → `await this._stateMachine.transitionCard(goalId, 'complete', { assessment })`. The nested `result: { ..., planning: { status: 'done', ... } }` at L663 stays an `await`ed direct `cardStore.update`.
- [ ] [src/runtime/runtime.ts L706](../../../../src/runtime/runtime.ts#L706) — executor-target start (F19/F23 primary): `if (card.status === 'backlog') setStatus(card.id, 'active'); setStatus(card.id, 'running')` → `const action: RuntimeCardAction = STARTABLE_STATES.includes(card.status) ? 'start' : 'restart'; await this._stateMachine.transitionCard(card.id, action, { goalId });` — `STARTABLE_STATES` is imported from [src/permissions/card-permissions.ts](../../../../src/permissions/card-permissions.ts) (exported per Step 1.5).
- [ ] [src/runtime/runtime.ts L715](../../../../src/runtime/runtime.ts#L715) — executor-exception catch: `cardStore.setStatus(card.id, 'failed')` → `await this._stateMachine.transitionCard(card.id, 'fail', { reason: 'executor_exception', error })`. Card is in `'running'` from L706; the machine emits the single legal step `running → failed`. No follow-up payload.
- [ ] **[src/runtime/runtime.ts L725-733](../../../../src/runtime/runtime.ts#L725-L733)** (NEW conversion; reviewer §A1, §P1, §B1) — executor-result writer. The multi-line `cardStore.update(card.id, { status: execResult.status, result: …, error: …, status_text: …, status_text_updated_at: …, status_text_author_session_id: …, latest_self_report: … })` is replaced as part of the **executor terminal restructure**:
  1. Move the registration loops (currently L735-736) and the `evidence_registration_ignored` write (currently L737, now `await this.cardStore.update(...)`) to run **before** any status write.
  2. Compute `registrationFailed = execResult.status === 'done' && (artifactRegistrationErrors.length > 0 || attachmentRegistrationErrors.length > 0)` and `finalStatus: 'done' | 'failed' = registrationFailed ? 'failed' : execResult.status`.
  3. Emit one transition: `await this._stateMachine.transitionCard(card.id, 'executor_finish', { goalId, finalStatus, reason: registrationFailed ? 'evidence_registration_failed' : undefined })`. The card is in `'running'` from L706; the machine emits a single legal step `running → done` or `running → failed`. **The pre-r4 code path `running → done` (at old L725-733) followed by `done → failed` (at old L740) is structurally eliminated; no `done → failed` step is ever emitted.**
  4. Issue **one** `await this.cardStore.update(card.id, { result, error, status_text, status_text_updated_at, status_text_author_session_id, latest_self_report })` for the non-status payload. The `result` value merges `execResult.result`, `executor`, `latest_self_report`, and (when `registrationFailed`) `evidence_registration_failures: { artifacts, attachments }`. The `error` value is `registrationError ?? execResult.error ?? null`.
- [ ] [src/runtime/runtime.ts L740](../../../../src/runtime/runtime.ts#L740) — evidence-registration-failure downgrade: **deleted** by the executor terminal restructure above. The L740 site no longer exists post-Step-5; the registration failure is folded into the `finalStatus` decision at step 2 and the non-status payload at step 4 of the restructure. The Step 7 gate must report zero matches inside the executor-terminal block.
- [ ] L758 — runtime-state owned-fields write only (`updateRuntimeState({ current_card_id, current_agent_session_id, active_card_run })`); not a `CardStatus` writer. No conversion in Step 5. Routed via `await this._stateMachine.transition('reviewer_started', { goalId, reviewerSessionId, activeCardRun })` in Step 6 alongside the rest of the owned-fields rewrite.
- [ ] [src/runtime/runtime.ts L766–L782](../../../../src/runtime/runtime.ts#L766) — `applyPlannerResult.untrackedChanges.status` planner-supplied status: `cardStore.update(update.id, { status: update.status as CardRecord['status'] })` → `const ok = await this._stateMachine.transitionCard(update.id, 'planner_set_status', { requestedStatus: update.status }); if (!ok) untrackedChanges.rejected.push({ id: update.id, requestedStatus: update.status, reason: 'state_machine_planner_status_rejected' });`. Closes the Route-2 silent-write defect. No fire-and-forget `cardStore.update` is introduced.
- [ ] [src/runtime/runtime.ts L784](../../../../src/runtime/runtime.ts#L784) — `simulateCrash`: same shape as L614 → `await this._stateMachine.transitionCard(card.id, 'crash_recovery_drop_to_backlog')`. No follow-up payload.
- [ ] Out-of-scope (do NOT convert): every call site listed under "Out-of-scope card-status writers" in [01-analysis-r5.md](01-analysis-r5.md). Per the no-untouched-code-commentary guideline, no out-of-scope file receives a new comment in this PR.

**Final await sweep (intra-step audit; mirrored by the Step 7 gate).** After the per-site checklist is complete, run:

```
rg -n '^\s*this\.cardStore\.update\(' src/runtime/runtime.ts
```

Zero matches expected. Every `this.cardStore.update(` line in the runtime must be preceded on the same line by `await ` (i.e., match `^\s*await this\.cardStore\.update\(`). The Step 7 gate runs the same check.

### Tests added in this step (in `tests/runtime/state-machine.test.ts` and new test files)

Per [02-design-r5.md](02-design-r5.md) §Test contract, every test asserts **the emitted one-step sequence** via a spy `cardStore`, not just an accept/reject boolean.

Action × source-state matrix (encoded as `it.each` cases; abbreviated steps use the `<from> → <to>` shorthand from the design):

- `start` from each source state:
  - `drafting` → `['drafting → backlog', 'backlog → active', 'active → running']`
  - `backlog` → `['backlog → active', 'active → running']`
  - `changed` → `['changed → active', 'active → running']`
  - `active`, `running`, `blocked`, `done`, `failed`, `cancelled` → reject, `steps == []`.
- `restart` from each source state:
  - `failed` → `['failed → backlog', 'backlog → active', 'active → running']`
  - `done` → `['done → backlog', 'backlog → active', 'active → running']`
  - `cancelled` → `['cancelled → drafting', 'drafting → backlog', 'backlog → active', 'active → running']`
  - `blocked` → `['blocked → backlog', 'backlog → active', 'active → running']`
  - `changed` → `['changed → active', 'active → running']`
  - `drafting`, `backlog`, `active`, `running` → reject, `steps == []`.
- `executor_finish` with `finalStatus: 'done'` from `running` → `['running → done']`; from any other source state → reject.
- `executor_finish` with `finalStatus: 'failed'` from `running` → `['running → failed']`; from any other source state → reject.
- `fail` from each non-terminal source: `running → ['running → failed']`; `active → ['active → running', 'running → failed']`; `backlog → ['backlog → active', 'active → running', 'running → failed']`; `drafting → ['drafting → backlog', 'backlog → active', 'active → running', 'running → failed']`; `blocked → ['blocked → running', 'running → failed']`; `changed → ['changed → active', 'active → running', 'running → failed']`. From `done`/`failed`/`cancelled` → reject (`steps == []`). **No `done → failed` step in any cell.**
- `block` from `active` → `['active → running', 'running → blocked']`; from `running` → `['running → blocked']`; from any other state → reject.
- `complete` from `active` → `['active → running', 'running → done']`; from `running` → `['running → done']`; from any other state → reject.
- `cancel` from each source that has `cancelled` in `VALID_TRANSITIONS[<from>]` → one step `<from> → cancelled`; from `cancelled`/`done`/`failed` → reject.
- `crash_recovery_drop_to_backlog` from `active` → `['active → backlog']`; from `running` → `['running → backlog']`; from any other state → reject.
- `reviewer_repair_resume` from `active` → `['active → running']`; from `running` → `steps == []` (no-op); from any other state → reject with one log line.
- `planner_set_status` illegal one-step cases (NEW; reviewer §P3): `cancelled → backlog` reject (`steps == []`, one `state_machine_planner_status_rejected` log line); `active → failed` reject; `done → backlog` accept (legal one-step in `VALID_TRANSITIONS.done`); `failed → backlog` accept (legal); `done → failed` reject (illegal); `running → done` accept (legal).

Integration tests under `tests/runtime/`:

- `tests/runtime/executor-done.test.ts` — executor returns `status: 'done'` with no registration errors; assert the trace contains exactly the steps `[L706 start/restart sequence] + ['running → done']`; no `done → failed` step; `card_failed` event not emitted; `current_card_id` correctly handled.
- `tests/runtime/executor-failed.test.ts` — executor returns `status: 'failed'`; assert the trace contains `[L706 start/restart sequence] + ['running → failed']`; `card_failed` event emitted exactly once; runtime-state recovers within 5s per the I1/I2 ticks landed in Step 4.
- `tests/runtime/executor-done-evidence-registration-failure.test.ts` — executor returns `status: 'done'` with a missing-file artifact that throws inside `registerArtifactOnCard`; assert the trace contains exactly `[L706 start/restart sequence] + ['running → failed']` (i.e., one step from `running` to `failed`, never via `done`); the non-status payload `cardStore.update` includes `result.evidence_registration_failures.artifacts` populated; `card_failed` event emitted exactly once; `errors.jsonl` contains zero `Invalid transition` lines. **Test also asserts that the spy's `update` call resolved before the next runtime action (i.e., the `await` is honored): the spy records a synchronous timestamp at promise-resolution; the next observed action timestamp is strictly greater.**
- `tests/runtime/executor-failure-recovery.test.ts` (already specified in r3/r4; retained) — end-to-end `dispatchGoal` with a `status: 'failed'` executor; asserts `readRuntimeState(root).current_card_id` becomes `null` or the parent goal id within 5s; asserts no `Invalid transition` line in `errors.jsonl`. This is the F19 acceptance gate.
- `tests/runtime/restartable-states.test.ts` (NEW in r4; retained) — table-driven: pre-seed a card in each member of `RESTARTABLE_STATES` (`blocked`, `changed`, `done`, `failed`, `cancelled`); drive `dispatchPendingActivations` against that goal; assert the emitted spy trace matches the per-state decomposition from the action table (e.g., `cancelled → ['cancelled → drafting', 'drafting → backlog', 'backlog → active', 'active → running']`). Confirms the recovery path is exercised for **every** restartable source state, not only `failed`. Imports `RESTARTABLE_STATES` from `src/permissions/card-permissions.ts` (per Step 1.5) so any future change to the set is auto-covered.

**Acceptance**: §Validation green; the four new integration tests green; live LXC ping shows the F19 wedge scenario recovers within 30s (Probe-C — informational only; the deterministic Jest gate is `executor-failure-recovery.test.ts`).

## Step 6 — Consolidate tick ownership and runtime-state writes (no net-new invariant logic)

**Files**: [src/runtime/runtime.ts](../../../../src/runtime/runtime.ts), `src/runtime/state-machine.ts`, integration tests.

Per [02-design-r5.md](02-design-r5.md) §Construction, the I1–I3 corrective bodies already landed in Step 4. Step 6 is the **dead-code sweep and runtime-state writer consolidation** that depend on the machine's tick being authoritative:

- Delete `safeTick`, `_safeTickInFlight`, `_autoDispatchFirstBacklogGoal` from `Runtime`. Replace single callers in `startup()` and `resume()` with `this._stateMachine.requestImmediateTick()` (de-duped against the interval lock).
- Replace the eight inline `updateRuntimeState({ status, current_card_id: null, current_agent_session_id: null, queue: [], active_card_run: null } as Partial<RuntimeState> as never)` blobs in `runtime.ts` with `await this._stateMachine.transition('goal_exit' | 'card_terminated' | 'paused' | 'goal_completed', payload)`. Drop the `as Partial<RuntimeState> as never` casts in the same edit.
- The L758 `invokeReviewer` runtime-state write becomes `await this._stateMachine.transition('reviewer_started', { goalId, reviewerSessionId, activeCardRun })`; the matching post-reviewer write becomes `await transition('reviewer_finished', ...)`.
- The machine schedules re-dispatch via the injected `redispatchGoal` dep when I2 corrects to a parent run with `runtime_intent.status === 'running'`; `Runtime`'s existing `_dispatchInFlight` set is the dedup gate.

**Tests**: full F19 integration test set from Step 5 still passes; the I1/I2/I3 corrective bodies' fixtures from Step 4 still pass; the `safeTick` self-heal regression in `tests/runtime/` (if present) is updated to drive the machine's tick instead.

**Acceptance**: §Validation green.

## Step 7 — Remove staging flag, sweep dead code, lock final invariants

**Files**: `src/runtime/state-machine.ts`, [src/runtime/runtime.ts](../../../../src/runtime/runtime.ts).

- Remove the `enforceInvariants` constructor parameter; collapse the `if (this.enforceInvariants)` branch in `tick()`; delete `Runtime`'s wiring that passes the flag.
- `rg -n "enforceInvariants" src/ tests/` → zero matches.
- `rg -n "as Partial<RuntimeState> as never" src/runtime/runtime.ts` → zero matches.
- `rg -n "this\._status\s*=" src/` → zero matches.
- `rg -n "mirrorRuntimeState" src/` → zero matches.
- `rg -n "safeTick|_safeTickInFlight|_autoDispatchFirstBacklogGoal" src/runtime/runtime.ts` → zero matches.
- `rg -nU --multiline "this\._stateMachine\.transition(Card)?\(" src/runtime/runtime.ts | rg -v "await this\._stateMachine\.transition"` → zero matches (every machine call site is awaited).

### Final card-status writer gate (multiline `rg`; reviewer §P2 — no new dev dependency)

**Decision (orchestrator).** The r4 plan's ts-morph AST gate is replaced by a multiline `rg` command, because `ts-morph` / `tsx` / `ts-node` are absent from [../../../../package.json](../../../../package.json) and adding a dev dependency for a single PR gate is out of scope. The multiline `rg` pattern below catches multi-line top-level `cardStore.update(...)` writers (the L725-733 shape) while allowing nested `result.planning.status` payloads at L644 / L645 / L663 via an explicit small allowlist.

**Two-part gate.**

**Part A — runtime-originating `CardStatus` writers must not survive in `src/runtime/runtime.ts`:**

```
rg -nU --multiline 'cardStore\.update\([^)]{0,400}\bstatus\s*:' src/runtime/runtime.ts
```

This pattern:

- Uses `--multiline` so the `[^)]{0,400}` body can cross newlines inside the `update(...)` argument list (matching the L725-733 multi-line shape).
- Anchors on a literal `cardStore.update(` followed by up to 400 non-`)` characters terminated by a top-level `\bstatus\s*:` key.
- Will **over-match** on nested `planning.status:` payloads at L644 / L645 / L663 (the substring `status:` appears inside the nested object literal). The explicit allowlist below disposes of those matches by line number; any other surviving match is a real offender.

Companion `setStatus` check:

```
rg -n 'cardStore\.setStatus\(' src/runtime/runtime.ts
```

Expected to return **zero** matches (every `setStatus` site is converted in Step 5).

**Allowlist (false-positives) for Part A.** The only legitimate matches after Step 5 are the nested `result: { ..., planning: { status: ..., ... } }` payload writers at:

- `src/runtime/runtime.ts:644` — planner-blocked exit (nested `planning.status: 'blocked'`).
- `src/runtime/runtime.ts:645` — planner-continue / planner-done-with-children (nested `planning.status: 'continue' | 'done'`).
- `src/runtime/runtime.ts:663` — goal-completed nested `planning.status: 'done'`.

Concrete gate command (committed to CI; line numbers are post-Step-5 and re-verified by the PR author before submit):

```sh
# Part A: top-level CardStatus writers in runtime.ts (multiline-aware)
MATCHES=$(rg -nU --multiline 'cardStore\.update\([^)]{0,400}\bstatus\s*:' src/runtime/runtime.ts \
            | rg -v ':(644|645|663):' || true)
if [ -n "$MATCHES" ]; then
  echo "runtime-status-writer-gate FAIL (Part A): $MATCHES"
  exit 1
fi
# Companion: setStatus must be fully eliminated.
if rg -n 'cardStore\.setStatus\(' src/runtime/runtime.ts; then
  echo "runtime-status-writer-gate FAIL (setStatus survives)"
  exit 1
fi
echo "runtime-status-writer-gate Part A: OK"
```

**Part B — every `cardStore.update(...)` call in `src/runtime/runtime.ts` is `await`ed** (binding rule 2 from Step 5; [02-design-r5.md](02-design-r5.md) §Every post-`transitionCard` `cardStore.update` follow-up is awaited):

```sh
# Part B: no unawaited cardStore.update in runtime.ts.
# Any line that contains `this.cardStore.update(` or `cardStore.update(` must
# also contain `await ` before it on the same line (`await this.cardStore.update(`
# or `await cardStore.update(`).
UNAWAITED=$(rg -n '\bcardStore\.update\(' src/runtime/runtime.ts \
              | rg -v '\bawait\s+(this\.)?cardStore\.update\(' || true)
if [ -n "$UNAWAITED" ]; then
  echo "runtime-status-writer-gate FAIL (Part B): unawaited cardStore.update: $UNAWAITED"
  exit 1
fi
echo "runtime-status-writer-gate Part B: OK"
```

**Sanity probes for the gate itself** (run once at Step 7 PR time, not committed as tests):

- Temporarily reintroduce the pre-Step-5 L725-733 multi-line `cardStore.update(card.id, { status: execResult.status, ... })` writer; **Part A** must report it (`src/runtime/runtime.ts:725:...`) and exit `1`.
- Temporarily reintroduce the pre-Step-5 `cardStore.setStatus(card.id, 'running')` at L706; the **companion `setStatus` check** must report it and exit `1`.
- Without any reintroduction, Part A must report zero offenders even though L644 / L645 / L663 still contain `result: { ..., planning: { status: ..., ... } }` — i.e., the allowlist correctly disposes of the nested-payload false-positives.
- Temporarily drop the `await` from one of the executor-terminal-restructure `cardStore.update(...)` calls; **Part B** must report it and exit `1`.

The two parts run as a single shell script in CI and as a `prepush` hook. Both must exit `0` for Step 7 acceptance.

**Acceptance**: every gate above plus §Validation green; one final live probe set (see "Live verification" below). All Step 5 integration tests still green.

## Live verification (deferred to Step 5 + Step 7)

Run after Step 5 (informational) and after Step 7 (final). Probes A, B, C unchanged from r3/r4:

- **Probe-A** — pause/resume drift regression (HTTP `runtime: "paused"`, `paused: true`; disk identical).
- **Probe-B** — `lastTickAt` liveness (non-null ISO timestamp; advances on a second call ≥ 5s later).
- **Probe-C** — executor-failure wedge recovery (`current_card_id` becomes `null` or repoints to the parent within 30s; `tail -n 200 /opt/saivage-v3-getrich/.saivage/runtime/errors.jsonl | grep "Invalid transition: failed"` returns zero matches).
- **Probe-D** — invariant auto-correction observability: informational only. **Probe-D INCONCLUSIVE does NOT count as F19 acceptance.** The deterministic Jest gates are `tests/runtime/executor-failure-recovery.test.ts`, `tests/runtime/executor-done.test.ts`, `tests/runtime/executor-failed.test.ts`, `tests/runtime/executor-done-evidence-registration-failure.test.ts`, and `tests/runtime/restartable-states.test.ts` from Step 5 plus the I1 / I2 / I3 corrective-body fixtures from Step 4. The live probes are diagnostic telemetry.

## Risks and mitigations

Unchanged from r3/r4 (tick interval interacts with planner long-running calls; operator-API restart racing runtime auto-restart; F13 r4 merge-order rebase; live-probe flakiness). The deterministic Jest tests are the acceptance gate; live probes are diagnostic.

## Changes vs r4

- **Step 1.5 (NEW)**: export `STARTABLE_STATES` and `RESTARTABLE_STATES` from [src/permissions/card-permissions.ts](../../../../src/permissions/card-permissions.ts) (one-line keyword change per constant). Runtime and machine import them directly; no parallel local definition. Rationale spelled out: structural parity over test-enforced parity. (Reviewer §P2.)
- **Step 5 binding rule 2 (NEW)**: every `this.cardStore.update(...)` call in `src/runtime/runtime.ts` is `await`ed. Per-site checklist marks the awaited follow-ups for L278, L635, L645/660/663 nested-payload writes, and the executor terminal restructure (ignored-evidence write + combined non-status payload). Intra-step audit command included. (Reviewer §B1.)
- **Step 7 final gate** is now a multiline `rg` two-part shell gate (Part A: top-level `CardStatus` writers in `runtime.ts` with explicit `644/645/663` allowlist for nested `planning.status`; Part B: no unawaited `cardStore.update` in `runtime.ts`). The ts-morph AST script and the `scripts/gates/runtime-status-writer-gate.ts` file are removed. No `ts-morph` / `tsx` / `ts-node` dependency is introduced — verified absent from [../../../../package.json](../../../../package.json). (Reviewer §P2.)
- **`executor-done-evidence-registration-failure.test.ts`** now also asserts the awaited follow-up `cardStore.update` resolves before the next observed runtime action (timestamp ordering on the spy), making r5 binding rule 2 testable. (Reviewer §B1.)

## Changes vs r3

(Preserved from r4 for traceability.)

- **`transitionCard` is `async`**: every conversion in Step 5 uses `await`; Step 7 gate enforces zero unawaited call sites in `src/runtime/runtime.ts`. (Orchestrator decision.)
- **L725-733 is in the Step 5 checklist** as the executor terminal restructure: registration check moves before the status transition; `await transitionCard(card.id, 'executor_finish', { finalStatus })` emits one legal step (`running → done` or `running → failed`); L740 is deleted in the same step. No `done → failed` step is ever emitted at runtime or in tests. (Reviewer §A1, §P1.)
- **Executor-result tests added** at `tests/runtime/executor-done.test.ts`, `tests/runtime/executor-failed.test.ts`, `tests/runtime/executor-done-evidence-registration-failure.test.ts` — each asserts the exact emitted spy trace.
- **`RESTARTABLE_STATES` and illegal-sequence coverage** lands as `tests/runtime/restartable-states.test.ts` plus illegal-one-step rejections inside `tests/runtime/state-machine.test.ts` (`planner_set_status` for `cancelled → backlog` and `active → failed`; `fail` from `done`/`failed`/`cancelled`). (Reviewer §P3, §D2.)
- **`enforceInvariants` corrective bodies land in Step 4**, not Step 6. Step 6 is now a pure dead-code sweep and runtime-state writer consolidation. Design and plan agree on the lifecycle (Step 3 false / Step 4 true + corrective bodies / Step 7 flag removed). (Reviewer §D3.)
- **Probe-D stays informational**; the Jest gates are the deterministic acceptance bar.
