# F23 — Implementation Plan (r1)

## Closure-mode pointer

All structural work is performed by [F19 r5 plan](../F19-runtime-pinned-failed-card/03-plan-r5.md). F23 adds **two test artifacts** and **one live probe**, all of which can land in the same PR as F19 r5 Step 5.

## Artifact 1 — `errors.jsonl` cleanliness probe (integration test)

**File**: `tests/runtime/f23-errors-jsonl-clean.test.ts` (new).

**Fixture**: pre-seed a card in `status: 'failed'` whose `current_card_id` is still pinned in `runtime-state.json` (the F19 wedge shape). Drive `dispatchPendingActivations` for the goal that owns it through `Runtime.open(config)` from F13 r4.

**Assertions**:

- The spy `cardStore` trace contains exactly `['failed → backlog', 'backlog → active', 'active → running']` immediately before the executor turn (the `restart` decomposition from F19 r5 design action table).
- After the turn settles, the `errors.jsonl` file under the test project root contains **zero** lines matching the regex `/Invalid transition: failed → /`.
- No `card_failed` event is emitted for a state-machine rejection path (those are bookkeeping-only inside the machine).

This test fails under pre-F19 runtime (the L706 path throws `failed → running` and surfaces in `errors.jsonl`) and passes after F19 r5 Step 5.

## Artifact 2 — planner-supplied illegal `failed → active` rejection (integration test)

**File**: `tests/runtime/f23-planner-set-status-failed-active.test.ts` (new).

**Fixture**: pre-seed a card in `status: 'failed'`. Stub `applyPlannerResult` so that `untrackedChanges` contains `{ id: <cardId>, status: 'active' }`.

**Assertions**:

- `transitionCard(id, 'planner_set_status', { requestedStatus: 'active' })` returns `false` (per F19 r5 design contract).
- The card record on disk after the call still has `status === 'failed'` (no write).
- `untrackedChanges.rejected` (the bookkeeping array introduced by F19 r5 Step 5 L766 conversion) contains one entry with `reason: 'state_machine_planner_status_rejected'` for that card id.
- `errors.jsonl` contains zero `Invalid transition: failed → active` lines for this turn; instead, exactly one `state_machine_planner_status_rejected` log line is present (per F19 r5 rejection-logging contract).

This test fails under pre-F19 runtime (the direct `cardStore.update({ status: 'active' })` at L766-L782 throws via `validateTransition` and writes a stack-trace line) and passes after F19 r5 Step 5.

## Artifact 3 — Live probe addendum to F19 Probe-C

F19 r5 Probe-C already asserts that `tail -n 200 /opt/saivage-v3-getrich/.saivage/runtime/errors.jsonl | grep "Invalid transition: failed"` returns zero matches. **F23 adopts Probe-C verbatim as its live acceptance signal**; no additional live probe is required. Run order: F13 r4 → F19 r5 Steps 1–5 → re-run Probe-C → F23 acceptance verified.

## No structural conversions owned by F23

Every call-site conversion needed to close F23 is already in the F19 r5 Step 5 checklist:

- [L706](../../../../src/runtime/runtime.ts#L706) — `restart` action covers `card.status === 'failed'` via `failed → backlog → active → running`.
- [L766-L782](../../../../src/runtime/runtime.ts#L766) — `planner_set_status` rejects illegal one-step `failed → active` with no write.
- [L715](../../../../src/runtime/runtime.ts#L715) (executor-exception catch) — `fail` action emits `running → failed` (1 legal step); was already legal pre-F19 but is now machine-routed.

F23 introduces **no extra conversions** on top of F19 r5 Step 5.

## Acceptance

F23 closes when:

1. F19 r5 Step 5 PR merges.
2. The two integration tests above are green in the same PR (`tests/runtime/f23-errors-jsonl-clean.test.ts`, `tests/runtime/f23-planner-set-status-failed-active.test.ts`).
3. Live Probe-C on `10.0.3.170` returns zero `Invalid transition: failed` matches in the post-Step-5 window.
