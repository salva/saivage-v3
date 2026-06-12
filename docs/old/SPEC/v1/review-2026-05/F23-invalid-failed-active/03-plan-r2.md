# F23 — Implementation Plan (r2)

Supersedes [03-plan-r1.md](03-plan-r1.md). Reflects the corrected diagnosis and residual scope in [01-analysis-r2.md](01-analysis-r2.md) and the design in [02-design-r2.md](02-design-r2.md).

## Ordering

1. [F19 r5 plan](../F19-runtime-pinned-failed-card/03-plan-r5.md) Steps 1–5 land first (introduces `RuntimeStateMachine`, the `'start'`/`'restart'`/`'planner_set_status'` actions, the Step 5 conversion of L706 and L766-L782, and the await-everywhere binding contract).
2. F23 r2 rebases onto F19 r5's merged state and adds the residual conversion + tests in the same PR.

## Step 1 — Convert `dispatchGoal` goal-activation call site

**File**: `src/runtime/runtime.ts`.

**Site**: L621 (the `this.cardStore.activateGoal(goalId)` call inside `dispatchGoal`'s outer `try` block).

**Conversion** (per [02-design-r2.md](02-design-r2.md) §Residual scope):

```ts
// Replace the existing `consumeChangedCardActivation(...); const result = this.cardStore.activateGoal(goalId); planCard = result.goal;` block with:
consumeChangedCardActivation(this.projectRoot, goalId);
const currentGoal = this.cardStore.read(goalId);
if (!currentGoal) throw new Error(`Goal '${goalId}' not found.`);
const currentStatus = currentGoal.status;
if (currentStatus !== 'active' && currentStatus !== 'running') {
  const action = STARTABLE_STATES.includes(currentStatus) ? 'start' : 'restart';
  const transitioned = await this._stateMachine.transitionCard(goalId, action, { reason: 'dispatch_goal' });
  if (!transitioned) throw new Error(`State machine refused ${action} for goal '${goalId}' (status '${currentStatus}').`);
}
planCard = this.cardStore.read(goalId)!;
const existingResult = planCard.result && typeof planCard.result === 'object' ? planCard.result : {};
if (!existingResult.planning || typeof existingResult.planning !== 'object') {
  await this.cardStore.update(goalId, { result: { ...existingResult, planning: { /* lifted verbatim from former activateGoal seed shape at card-store.ts L1097-L1105 */ } } });
  planCard = this.cardStore.read(goalId)!;
}
// rest of the existing block (startedAt, plannerSessionId, updateRuntimeState, bindPlannerSessionToOpenRun) is unchanged
```

`STARTABLE_STATES` is already exported from `src/permissions/card-permissions.ts` per F19 r5 §Step 1.5 (no new export needed).

## Step 2 — Delete `CardStore.activateGoal`

**File**: `src/cards/card-store.ts`.

**Action**: delete the `activateGoal(id)` method ([L1097-L1105](../../../../src/cards/card-store.ts#L1097-L1105)) including its trailing `update` block. Per project guideline "REMOVE dead code, no migration shims" no wrapper is left behind.

**Verification**: `rg -n "activateGoal" src/ tests/` must return zero matches after the call site in `runtime.ts:621` is converted (Step 1) and any tests referring to the helper are updated to drive the public `dispatchGoal` entry instead.

## Step 3 — Tests

### `tests/runtime/f23-errors-jsonl-clean.test.ts` (new)

**Fixture**: pre-seed a terminal child card in `status: 'failed'` whose `current_card_id` is still pinned in `runtime-state.json` (the F19 wedge shape). Drive `dispatchPendingActivations` for the owning goal through `Runtime.open(config)`.

**Assertions**:
- Spy `cardStore` trace contains exactly `['failed → backlog', 'backlog → active', 'active → running']` immediately before the executor turn (the `restart` decomposition from F19 r5).
- After the turn settles, `errors.jsonl` contains zero lines matching `/Invalid transition: failed → /`.

This test covers the F19 r5 executor path; F23 owns it because the acceptance signal is F23's contribution.

### `tests/runtime/f23-planner-set-status-failed-active.test.ts` (new)

**Fixture**: pre-seed a card in `status: 'failed'`. Drive the public planner-result shape via `applyPlannerResult` with `updated_cards: [{ id: <cardId>, status: 'active' }]`.

**Assertions**:
- Card record on disk after the call has `status === 'failed'` (no write occurred).
- Rejection bookkeeping (the `untrackedChanges.rejected` array introduced by F19 r5 Step 5 L766 conversion, or equivalent log surface) contains one entry with `reason: 'state_machine_planner_status_rejected'` for that card id.
- `errors.jsonl` contains zero `Invalid transition: failed → active` lines.

This test fails under pre-F19 runtime (the L766-L782 path silently mutates the failed card to `active`) and passes after F19 r5 Step 5.

### `tests/runtime/f23-goal-activation-failed.test.ts` (new — residual scope)

**Fixture**: pre-seed a goal card in `status: 'failed'` (e.g., after a planner-exception branch at [runtime.ts L635](../../../../src/runtime/runtime.ts#L635) wrote `status: 'failed'`). Spy `cardStore` recording `(id, kind, from→to)` tuples in order.

**Action**: invoke `runtime.dispatchGoal(goalId)`.

**Assertions**:
- Spy trace for the goal card contains exactly `['failed → backlog', 'backlog → active', 'active → running']` (the F19 r5 `restart` decomposition).
- No `Invalid transition` throw is propagated out of `dispatchGoal`.
- `errors.jsonl` contains zero `Invalid transition: failed → active` lines.
- After the call, the goal card's `result.planning` is a non-null object (the inline planning-result seed from Step 1 ran).

This test exclusively covers Path 3 from [01-analysis-r2.md](01-analysis-r2.md) and fails under both pre-F19 runtime (where L621 throws directly from `setStatus`) and a hypothetical F19-only build that did not delete `activateGoal` (because the unchanged L621 call site would still throw).

## Step 4 — Live probe

Adopt F19 r5 Probe-C verbatim:

```bash
ssh root@10.0.3.170 'tail -n 200 /opt/saivage-v3-getrich/.saivage/runtime/errors.jsonl' \
  | grep "Invalid transition: failed"
```

Expected output: empty. The probe covers both `failed → active` and `failed → running` symptoms and is independent of Unicode-arrow rendering.

## Step 5 — Validation

```bash
cd /home/salva/g/ml/saivage-v3
npm run typecheck
npm run lint
npm run test:direct -- tests/runtime/f23-*.test.ts
```

Plus the live LXC Probe-C from Step 4 against the `saivage-v3-getrich-v2` container at `10.0.3.170`, post-deploy of the combined F19 r5 + F23 r2 PR.

## Acceptance

F23 closes when:

1. F19 r5 Step 5 PR is merged.
2. Step 1 + Step 2 conversion is merged in the same PR (or a follow-up PR rebased onto F19 r5).
3. All three integration tests above are green in CI.
4. Live Probe-C on `10.0.3.170` returns zero matches in a post-deploy 200-line tail window.
5. `rg -n "activateGoal" src/ tests/` returns zero matches.
