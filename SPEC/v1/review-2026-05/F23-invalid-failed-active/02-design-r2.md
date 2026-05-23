# F23 — Design (r2)

Supersedes [02-design-r1.md](02-design-r1.md). Mostly closure-mode under [F19 r5](../F19-runtime-pinned-failed-card/02-design-r5.md), plus residual structural scope for the `dispatchGoal → activateGoal` path identified in [01-analysis-r2.md](01-analysis-r2.md).

## Closure-mode portion (Paths 1 and 2)

Owned by F19 r5 Step 5; F23 contributes the acceptance signal:

1. **Path 1 — executor retry** (L706). After F19 r5, the `restart` action decomposes `failed → backlog → active → running` for failed terminal children. F23 asserts the emitted sequence and `errors.jsonl` cleanliness for this site.
2. **Path 2 — planner-supplied status forwarder** (L766-L782). After F19 r5, `planner_set_status` rejects illegal one-step requests with `state_machine_planner_status_rejected` bookkeeping and zero card writes. F23 asserts the pre-F19 silent-write path no longer mutates the failed card and that the rejection bookkeeping is observable. The acceptance signal is **not** the disappearance of an `errors.jsonl` line (the pre-F19 path was silent), it is the **absence of an illegal post-write card state** plus the presence of the rejection record.

## Residual scope (Path 3 — F23-owned)

### Conversion: `dispatchGoal` routes goal activation through `RuntimeStateMachine`

[runtime.ts L621](../../../../src/runtime/runtime.ts#L621) currently invokes `this.cardStore.activateGoal(goalId)`, which writes `failed → active` directly via `setStatus` and throws on a failed goal card. The F23 conversion replaces the helper call with a state-machine transition matching the goal card's current status:

```ts
// Pre-r2 (current):
const result = this.cardStore.activateGoal(goalId);
planCard = result.goal;

// Post-r2 (F23):
const currentGoal = this.cardStore.read(goalId);
if (!currentGoal) throw new Error(`Goal '${goalId}' not found.`);
const currentStatus = currentGoal.status;
const action: RuntimeCardAction = currentStatus === 'active' || currentStatus === 'running'
  ? null  // no-op: skip transition, reuse existing active goal (mirrors activateGoal's early-return branch)
  : STARTABLE_STATES.includes(currentStatus) ? 'start' : 'restart';
if (action) {
  const transitioned = await this._stateMachine.transitionCard(goalId, action, { reason: 'dispatch_goal' });
  if (!transitioned) {
    // Machine refused; one log line already written. Surface as runtime diagnostic and bail.
    throw new Error(`State machine refused ${action} for goal '${goalId}' (status '${currentStatus}').`);
  }
}
// Re-read; goal is now in 'running' (or unchanged if it was already active/running).
planCard = this.cardStore.read(goalId)!;
// Existing planning-result preservation (the result/planning block writes previously done inside
// activateGoal) is now performed inline by dispatchGoal via the awaited cardStore.update follow-up
// rule documented in F19 r5 §Every post-transitionCard cardStore.update follow-up is awaited.
```

For `currentStatus === 'failed'`, `'restart'` emits the legal sequence `failed → backlog → active → running` (F19 r5 design action table). All four writes flow through `validateTransition`; none throws.

### `CardStore.activateGoal` is deleted

Per project guideline "REMOVE dead code, no migration shims": `activateGoal` is **deleted**, not wrapped. Justification:

- The helper's status-write branch (`setStatus(id, 'active')`) is exactly the illegal path F23 closes; preserving it as a wrapper preserves the throw surface for any future caller.
- The helper's planning-result-preservation branch (the `result.planning` block) is a non-status `cardStore.update` payload. Per F19 r5 §Every post-`transitionCard` `cardStore.update` follow-up is awaited, non-status writes belong inline at the runtime call site, not inside `card-store.ts`. Inlining the planning-result block into `dispatchGoal` (alongside the conversion above) removes a CardStore-layer responsibility that belongs to the runtime.
- The wrapper alternative (a) keeps the `activateGoal` symbol but routes it through the state machine. Rejected because (a) introduces a layering inversion — `CardStore` would need to import `RuntimeStateMachine` or call back into `Runtime` — and (b) the only other caller of `activateGoal` in the repo is the same `dispatchGoal` site; there is no abstraction to preserve.

The single remaining piece of `activateGoal`'s public contract used by `dispatchGoal` — guaranteeing that a `result.planning` object exists after activation — is satisfied inline by:

```ts
const existingResult = planCard.result && typeof planCard.result === 'object' ? planCard.result : {};
if (!existingResult.planning || typeof existingResult.planning !== 'object') {
  await this.cardStore.update(goalId, { result: { ...existingResult, planning: { /* seed shape from card-store.ts L1097-L1105 */ } } });
  planCard = this.cardStore.read(goalId)!;
}
```

The seed shape is the exact object literal previously returned by `activateGoal` (lifted verbatim from [card-store.ts L1097-L1105](../../../../src/cards/card-store.ts#L1097-L1105) and the trailing `update` block in that same method).

### Composition with F19 r5

- `transitionCard` is `async`; the new `dispatchGoal` call site `await`s it (F19 r5 binding contract).
- The follow-up `cardStore.update` for the `result.planning` seed is `await`ed (F19 r5 §Every post-`transitionCard` `cardStore.update` follow-up is awaited).
- F19 r5 Step 7 multiline `rg` gate catches any unawaited `transitionCard` or `cardStore.update` call inside `src/runtime/runtime.ts`; the F23 conversion satisfies that gate by construction.
- No new action is added to `RuntimeCardAction`. `'start'` and `'restart'` already cover every reachable goal-card source status; the unreachable cases (`'done'`, `'cancelled'`) are accepted by `'restart'` per F19 r5 design action table and produce the same uniform decomposition.

## Files deleted

- `CardStore.activateGoal` method ([card-store.ts L1097-L1105](../../../../src/cards/card-store.ts#L1097-L1105) and the trailing `update` block at L1106+).
- The `consumeChangedCardActivation` import is unchanged (it remains called inline at L621); only the `activateGoal` helper is removed.

## Files added

None. The conversion lives in `src/runtime/runtime.ts:621` and reuses the existing `RuntimeStateMachine` introduced by F19 r5.

## Acceptance contract

After F19 r5 Step 5 and the F23 r2 conversion land:

1. `errors.jsonl` contains zero `Invalid transition: failed → ...` lines for any runtime turn that re-dispatches a failed goal card.
2. The `dispatchGoal` call site's emitted card-status trace for a failed goal is exactly `['failed → backlog', 'backlog → active', 'active → running']`.
3. `rg "activateGoal" src/` returns zero matches (helper removal verified).
4. Planner-supplied illegal `failed → active` on a goal or terminal card: card remains `failed`, rejection bookkeeping present, no silent illegal write.
