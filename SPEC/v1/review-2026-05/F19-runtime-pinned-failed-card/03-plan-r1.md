# F19 — Plan (r1)

Implements Proposal B from [02-design-r1.md](02-design-r1.md). The plan is bundled with [F20](../F20-executor-false-failed/00-issue.md) and [F23](../F23-invalid-failed-active/00-issue.md): the F20 and F23 design docs should defer to this plan and add only their respective callback bodies (Step 7 and Step 5 below). The plan is autonomous: each step is one PR with a deterministic acceptance check.

## Coordination summary

- Steps 1–3 land the state machine and the `lastTickAt` field in isolation, no behaviour change.
- Step 4 cuts `Runtime._status` over to the machine; this is where the F19 in-memory/disk drift dies.
- Step 5 retires `failed → active` from runtime callers (closes F23).
- Step 6 reroutes executor-failure cleanup through the machine (closes F19's main symptom).
- Step 7 hooks the post-execution verification pass (closes F20).
- Step 8 deletes the now-orphaned code.

Each step preserves a working build and passes the existing runtime test suite plus its own new tests.

## Step 1 — Add `last_tick_at` field

**Goal:** persist a tick liveness timestamp without changing any logic.

**Files:**

- [src/schemas/index.ts](../../../src/schemas/index.ts) — add `last_tick_at: z.string().nullable()` to `runtimeStateSchema`; default `null`.
- [src/runtime/state.ts](../../../src/runtime/state.ts) — include `last_tick_at: null` in `defaultRuntimeState()`.
- [src/server/server.ts](../../../src/server/server.ts) line 64 — `/api/runtime/status` payload adds `lastTickAt: state?.last_tick_at ?? null`.
- [src/runtime/active-runtime.ts](../../../src/runtime/active-runtime.ts) — `getStatus()` adds `lastTickAt: state?.last_tick_at ?? null`.

**Validation:**

- `npx tsc -p tsconfig.json` clean.
- `npx vitest run src/runtime src/server` green (no behavioural change, schema add is additive).
- One new unit test: default state has `last_tick_at: null`.

**Rollback:** revert the PR; the field is additive and not yet written by anyone.

## Step 2 — Add `src/runtime/state-machine.ts` with invariants but no callers

**Goal:** ship the new module, fully unit-tested, but do not wire it into `Runtime` yet.

**Files added:**

- `src/runtime/state-machine.ts` — `RuntimeStateMachine` class, takes `(deps: { projectRoot, cardStore, errorLogger, clock, readState, writeState })`. Methods: `transition(event, payload)`, `transitionCard(cardId, action, payload)`, `tick()`, `start()`, `stop()`. Imports `decide`, `allowedActions` from [src/permissions/card-permissions.ts](../../../src/permissions/card-permissions.ts) and `TERMINAL_STATUSES` from [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) (move the constant to a new `src/runtime/constants.ts` if a cycle blocks).
- `src/runtime/state-machine.test.ts` — exhaustive unit tests for invariants I1–I4 and for every transition event.

**Validation:**

- `npx tsc -p tsconfig.json` clean.
- `npx vitest run src/runtime/state-machine.test.ts` green with ≥95% branch coverage on the new file.

**Rollback:** delete the two new files; nothing depends on them yet.

## Step 3 — Wire the machine into `Runtime` as a no-op observer

**Goal:** instantiate the machine inside `Runtime`, start its tick timer, but route no writes through it yet. Verify in production logs that invariants do not trip on a healthy run.

**Files:**

- [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) — construct `this._stateMachine = new RuntimeStateMachine({...})` in `Runtime`'s constructor; call `this._stateMachine.start()` at the end of `startup()` and `this._stateMachine.stop()` at the start of `shutdown()`. Register the interval timer via the existing `RuntimeLifecycleScope` machinery from [src/runtime/lifecycle.ts](../../../src/runtime/lifecycle.ts).
- The machine bumps `last_tick_at` on every tick. No other writes.

**Validation:**

- `npx tsc -p tsconfig.json` clean.
- `npx vitest run src/runtime` green.
- **Live LXC probe (probe-A):** see §Live probe sequence below — at the end of a normal `start_project` cycle on the checkers harness, `last_tick_at` advances monotonically and `errors.jsonl` records zero invariant-violation entries.

**Rollback:** revert the constructor/`startup`/`shutdown` lines; the machine becomes unreachable again.

## Step 4 — Cut `Runtime.status` over to the machine; delete `_status`

**Goal:** kill the in-memory/disk drift. After this step, `/api/runtime/status.runtime` always matches the on-disk `RuntimeState.status`.

**Files:**

- [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) — delete the `_status` field (line 99). Replace the `status` getter (line 116) with `get status(): RuntimeStatus { return readRuntimeState(this.projectRoot)?.status ?? 'idle'; }`. Delete all five `this._status = ...` writes (lines 583, 605, 609, 612, 613). The corresponding *disk* writes already exist at the same sites and become the sole source of truth. For the `freeze()` site (line 612) the existing `updateRuntimeState({ ... })` already writes `status: 'frozen'` — verify; add it if absent.

**Validation:**

- `npx tsc -p tsconfig.json` clean.
- `npx vitest run src/runtime src/server` green.
- New unit test: after `Runtime` constructs but before `startup()`, `runtime.status === 'idle'`. After `startup()` on a project whose disk state is `running`, `runtime.status === 'running'`. After `stopProject()`, `runtime.status === 'idle'`. After `freeze()`, `'frozen'`. After `resumeFromFreeze()`, `'idle'`.
- **Live LXC probe (probe-B):** see §Live probe sequence — after `systemctl restart`, `/api/runtime/status.runtime` matches `cat .saivage/tmp/state/runtime.json | jq .status` exactly.

**Rollback:** restore the `_status` field and assignments; the disk-side writes stay (harmless).

## Step 5 — Route every runtime-side card transition through the machine; remove `failed → active` (closes F23)

**Goal:** the runtime layer never calls `cardStore.setStatus(failedCard, 'active')` or `cardStore.update(card, { status: 'active' })` directly. All such writes go through `RuntimeStateMachine.transitionCard(id, action, payload)`, which composes legal multi-step sequences via the matrix.

**Files:**

- [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) — `dispatchPendingActivations` line 706 (`setStatus(card.id, 'active'); setStatus(card.id, 'running')`) becomes `this._stateMachine.transitionCard(card.id, 'start', { goalId })`. The machine reads the current status; if `failed`, it inserts a `backlog → active → running` sequence; if `backlog`, it does `active → running`; if `active`, just `running`. The matrix authorises via `decide({ role: 'planner', action: 'card.start', targetState: card.status })`.
- [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) `applyPlannerResult` — `untrackedChanges.status` writes go through `transitionCard(id, 'planner_set_status', { targetStatus })`. The machine refuses any planner-requested transition that violates `VALID_TRANSITIONS`; refusals are logged and the planner result is preserved minus the offending field.
- [src/runtime/control.ts](../../../src/runtime/control.ts) — `pauseRuntimeControl` and `resumeRuntimeControl` call `activeRuntime.runtime.stateMachine.transition('pause' | 'resume')` instead of `mirrorRuntimeState`. `mirrorRuntimeState` is removed.

**Validation:**

- `npx tsc -p tsconfig.json` clean.
- `npx vitest run src/runtime src/server` green.
- New unit test: a planner result that includes `updated_cards: [{ id, status: 'active' }]` for a `failed` card causes one `errors.jsonl` line ("planner attempted invalid transition failed → active; corrected via backlog") and the card lands in `running`.
- **Live LXC probe (probe-C):** see §Live probe sequence — the `Invalid transition: failed → active` line that F23 captured must not reappear in `errors.jsonl` across a full induced-failure cycle.

**Rollback:** revert; `cardStore.setStatus` callers in `runtime.ts` and `control.ts` resume their old direct path. F23 returns.

## Step 6 — Route runtime exits through the machine; consolidate the eight clear-state blobs (closes F19)

**Goal:** delete every inline `updateRuntimeState({ status: 'idle', current_card_id: null, ... } as Partial<RuntimeState> as never)` in [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) (lines 555, 583, 609, 635, 644, 645, 660, 800) and replace with `this._stateMachine.transition('goal_exit', { reason, parentRun: parentPlannerRunFor(currentCardId) })`. The machine writes `status`, `current_card_id`, `current_agent_session_id`, `queue`, `active_card_run`, `last_tick_at` together, in one disk write, with invariant assertions.

In particular, the missing clear after the executor-failure branch (the F19 root cause) becomes `this._stateMachine.transition('card_terminated', { cardId: card.id, outcome: 'failed' })`. The machine consults `runtime_intent.status`: if `running`, it pops to the parent planner run via `parentPlannerRunFor` so the dispatch loop's next iteration replans; if `stopped`, it transitions to `'idle'`. Either way, `current_card_id` never points at a terminal card after the next tick.

Also delete the stale-`active_card_run` self-heal branch in `safeTick` (lines 793–810) — invariants I1/I3 cover it. `_safeTickInFlight` and the `safeTick` method itself can be deleted; the machine's `tick()` plus its on-demand `transition()` covers everything `safeTick` did.

**Files:**

- [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) — the deletions and replacements listed above.
- [src/runtime/state.ts](../../../src/runtime/state.ts) — no change; `updateRuntimeState` stays for the ledger fields the machine does not own.

**Validation:**

- `npx tsc -p tsconfig.json` clean.
- `npx vitest run src/runtime src/server` green; rewrite tests that asserted exact disk-write argument shapes to assert on machine `transition` calls instead.
- New integration test: fake executor returns `status: 'failed'`. Within 5s of the return, `readRuntimeState().current_card_id` is either `null` or the parent goal id; `runtime.status` is either `'running'` (with parent in flight) or `'idle'`. Never `'running'` + terminal card id.
- **Live LXC probe (probe-D, the F19 acceptance test):** induce a failing card on the checkers harness; observe `/api/runtime/status` self-corrects within 30s. Procedure in §Live probe sequence.

**Rollback:** revert the file; the inline clear blobs return and F19 reopens.

## Step 7 — Add executor verification hook (closes F20)

**Goal:** before the machine commits a `card_terminated` with `outcome: 'failed'`, run a verification pass. If the artefacts on disk satisfy the card's acceptance signal (tests green, build green, expected files exist), reclassify the outcome as `needs_corrections` or `done`.

**Files:**

- `src/runtime/state-machine.ts` — `onCardTerminated(payload)` calls a new `verifyExecutorOutcome(cardId)` helper. Helper is small and pure: inspects `card.artifacts`, `card.result.executor`, and optionally re-checks the executor's declared verification commands. If the executor declared `failed` but artefacts are consistent with success, downgrade to `needs_corrections` (a status the card store already supports via the existing `VALID_TRANSITIONS` — verify; if missing, add it in [src/cards/card-store.ts](../../../src/cards/card-store.ts) line 217 as part of this step).
- `src/runtime/state-machine.test.ts` — new tests for the four outcome quadrants (declared-pass × artefacts-pass, declared-pass × artefacts-fail, declared-fail × artefacts-pass, declared-fail × artefacts-fail).

**Validation:**

- `npx tsc -p tsconfig.json` clean.
- `npx vitest run src/runtime` green.
- **Live LXC probe (probe-E):** the checkers harness's stepwise-multijump card (the original F20 reproducer) lands in `done` (or `needs_corrections`) instead of `failed` when the artefacts are correct.

**Rollback:** revert; F20 reopens but F19/F23 are unaffected.

## Step 8 — Dead-code removal

**Goal:** remove anything orphaned by Steps 1–7.

**Items to delete:**

- `_status` field on `Runtime` (already deleted in Step 4; verify no straggler references in tests).
- `_safeTickInFlight` bool, `safeTick` method, `_autoDispatchFirstBacklogGoal` private method (covered by `RuntimeStateMachine.tick`).
- `mirrorRuntimeState` helper in [src/runtime/control.ts](../../../src/runtime/control.ts).
- The eight inline `updateRuntimeState({ status: 'idle', current_card_id: null, ... } as Partial<RuntimeState> as never)` invocations (already gone after Step 6; verify with `grep -n "as Partial<RuntimeState> as never" src/runtime/runtime.ts` returning zero hits).
- The `setTimeout(() => { void this.safeTick(); }, 0)` at the end of `startup()` (line 607).
- Any test fixtures that exercised the old in-memory `_status` setter behaviour exclusively.

**Validation:**

- `npx tsc -p tsconfig.json` clean.
- `npx vitest run` green (full suite).
- `grep -rn "safeTick\|_safeTickInFlight\|mirrorRuntimeState\|as Partial<RuntimeState> as never" src/` returns zero hits.

**Rollback:** not applicable; this step is the cleanup. If a regression appears, revert Step 8 and the orphans return as no-ops.

## Live probe sequence (LXC)

Container: `saivage-v3-checkers-e2e` @ `10.0.3.180:8080`. Host bind mount of `saivage-v3` repo, systemd unit `saivage-v3-checkers-e2e.service`. Token from `/etc/saivage-v3-checkers-e2e.env`.

Shared header for every probe:

```bash
TOKEN=$(ssh root@10.0.3.180 'cat /etc/saivage-v3-checkers-e2e.env' | sed -n 's/^SAIVAGE_API_TOKEN=//p')
API=http://10.0.3.180:8080
H="Authorization: Bearer $TOKEN"
```

### Probe-A (Step 3) — invariants do not trip on a healthy run

```bash
ssh root@10.0.3.180 'systemctl restart saivage-v3-checkers-e2e.service'
sleep 3
T0=$(date -u +%s)
curl -fsS -H "$H" $API/api/runtime/status | jq .lastTickAt
sleep 7
T1=$(date -u +%s)
curl -fsS -H "$H" $API/api/runtime/status | jq .lastTickAt
ssh root@10.0.3.180 'grep "state_machine_invariant" /work/saivage-e2e-checkers/.saivage/errors.jsonl || echo "no invariant violations"'
```

Pass: two `lastTickAt` values, second strictly later than first; the grep prints `no invariant violations`.

### Probe-B (Step 4) — in-memory/disk consistency

```bash
ssh root@10.0.3.180 'systemctl restart saivage-v3-checkers-e2e.service'
sleep 3
API_STATUS=$(curl -fsS -H "$H" $API/api/runtime/status | jq -r .runtime)
DISK_STATUS=$(ssh root@10.0.3.180 'jq -r .status /work/saivage-e2e-checkers/.saivage/tmp/state/runtime.json')
[[ "$API_STATUS" == "$DISK_STATUS" ]] && echo "consistent: $API_STATUS" || echo "DRIFT api=$API_STATUS disk=$DISK_STATUS"
```

Pass: prints `consistent: idle` (or whichever value).

### Probe-C (Step 5) — no more `failed → active` errors

```bash
ssh root@10.0.3.180 'truncate -s0 /work/saivage-e2e-checkers/.saivage/errors.jsonl'
curl -fsS -X POST -H "$H" $API/api/runtime/start_project
# Wait for a card to fail. In the checkers harness, the seeded multi-jump card
# reliably fails within ~5 minutes; for a deterministic probe, force the failure
# via the existing test seam: write a planner fixture that creates a card whose
# executor returns status='failed' immediately.
sleep 600
ssh root@10.0.3.180 'grep "Invalid transition: failed → active" /work/saivage-e2e-checkers/.saivage/errors.jsonl || echo "no illegal transitions"'
```

Pass: prints `no illegal transitions`.

### Probe-D (Step 6, F19 acceptance) — runtime auto-recovers from failed current card

```bash
curl -fsS -X POST -H "$H" $API/api/runtime/start_project
# Wait until /api/runtime/status reports a non-null currentCardId
while true; do
  CARD=$(curl -fsS -H "$H" $API/api/runtime/status | jq -r .currentCardId)
  [[ "$CARD" != "null" ]] && break
  sleep 5
done
echo "tracking card: $CARD"
# Wait for that card to reach 'failed'
while true; do
  STATUS=$(curl -fsS -H "$H" $API/api/cards/$CARD | jq -r .status)
  [[ "$STATUS" == "failed" ]] && break
  sleep 5
done
T_FAIL=$(date -u +%s)
echo "card failed at $T_FAIL"
# Within 30s of failure, /api/runtime/status must satisfy contract C1
while true; do
  NOW=$(date -u +%s)
  STATE=$(curl -fsS -H "$H" $API/api/runtime/status)
  RT=$(echo "$STATE" | jq -r .runtime)
  CC=$(echo "$STATE" | jq -r .currentCardId)
  if [[ "$RT" != "running" ]] || [[ "$CC" == "null" ]] || [[ "$CC" != "$CARD" ]]; then
    echo "RECOVERED in $((NOW - T_FAIL))s: runtime=$RT currentCardId=$CC"
    break
  fi
  if (( NOW - T_FAIL > 30 )); then
    echo "WEDGE: runtime=$RT currentCardId=$CC after $((NOW - T_FAIL))s"
    exit 1
  fi
  sleep 2
done
```

Pass: prints `RECOVERED in <30s: ...` and exits 0. This is the F19 contract C1 check.

### Probe-E (Step 7, F20 acceptance) — false-failed downgrade

Same as Probe-D but the assertion at the end is: the originally-failing card now lands in `done` or `needs_corrections`, not `failed`, when the on-disk artefacts (tests + build) are green. Procedure: after the dispatch settles, `curl /api/cards/<CARD>` and assert `status != "failed"`.

## Rollback strategy (overall)

Each step is one PR. To revert F19's behaviour to the broken Phase-2 baseline, revert in reverse order: 8 → 7 → 6 → 5 → 4 → 3 → 2 → 1. Steps 1–3 are safe to leave in place even if 4–8 are reverted (additive only). Steps 4 and 6 are the substantive behaviour changes; reverting either alone re-opens F19. Step 5 alone reverts F23. Step 7 alone reverts F20.

## Dead-code removal items (consolidated)

Tracked in Step 8 but listed here for visibility:

- `_status: RuntimeStatus` field and getter on `Runtime`.
- `_safeTickInFlight: boolean` field on `Runtime`.
- `private async safeTick(): Promise<void>` method.
- `private async _autoDispatchFirstBacklogGoal(): Promise<void>` method.
- `setTimeout(() => { void this.safeTick(); }, 0);` at the end of `startup()`.
- `void this.safeTick();` at the end of `resume()`.
- The eight `updateRuntimeState({ status: 'idle', current_card_id: null, current_agent_session_id: null, queue: [], active_card_run: null } as Partial<RuntimeState> as never)` invocations in [src/runtime/runtime.ts](../../../src/runtime/runtime.ts).
- `mirrorRuntimeState` helper in [src/runtime/control.ts](../../../src/runtime/control.ts).
- Any vitest fixtures whose only purpose was exercising the legacy `_status` mutability.
