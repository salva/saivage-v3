# F23 — Analysis (r2)

Supersedes [01-analysis-r1.md](01-analysis-r1.md). Addresses r1 review concerns: corrects the diagnosis of which runtime path actually throws `Invalid transition: failed → active` from `validateTransition`, and identifies the residual `dispatchGoal → activateGoal` path that F19 r5 Step 5 does NOT cover.

## Decision

**F23 is mostly closure-mode** under [F19 r5](../F19-runtime-pinned-failed-card/02-design-r5.md), **plus one residual structural item**: convert the `dispatchGoal → cardStore.activateGoal → setStatus('active')` goal-activation path to route through `RuntimeStateMachine.transitionCard` with a legal `restart` decomposition for failed goal cards.

## Root cause

`Invalid transition: failed → active` is thrown by [card-store.ts L1081-L1087](../../../../src/cards/card-store.ts#L1081-L1087):

```ts
validateTransition(from, to) {
  if (from === to) return;
  const allowed = VALID_TRANSITIONS[from];
  if (allowed && allowed.includes(to)) return;
  throw new Error(`Invalid transition: ${from} → ${to}. ...`);
}
```

with `VALID_TRANSITIONS.failed = ['backlog', 'cancelled']` ([card-store.ts L217-L227](../../../../src/cards/card-store.ts#L217-L227)). The throw fires only on the `setStatus` code path ([card-store.ts L1090-L1094](../../../../src/cards/card-store.ts#L1090-L1094)); `update(...)` does **not** call `validateTransition` ([card-store.ts L799-L806](../../../../src/cards/card-store.ts#L799-L806)) and `validateMutablePatch` explicitly permits a `status` key on terminal cards ([card-store.ts L568-L582](../../../../src/cards/card-store.ts#L568-L582)).

## Runtime caller inventory (corrected)

Three runtime paths can write `status: 'active'` on a `failed` card:

### Path 1 — Executor retry (covered by F19 r5)

[runtime.ts L706](../../../../src/runtime/runtime.ts#L706): `if (card.status === 'backlog') this.cardStore.setStatus(card.id, 'active'); this.cardStore.setStatus(card.id, 'running');`. For a failed terminal child with a pinned `current_card_id`, the `'backlog'` guard skips the activation and the next `setStatus(card.id, 'running')` throws via `validateTransition` — symptom is `failed → running`, not `failed → active`. F19 r5 Step 5 converts this site to `await transitionCard(card.id, STARTABLE_STATES.includes(card.status) ? 'start' : 'restart', { goalId })`. For `status === 'failed'`, the `restart` action emits the uniform legal decomposition `failed → backlog → active → running` (F19 r5 design action table).

**Status: closed by F19 r5.**

### Path 2 — Planner-supplied status forwarder (covered by F19 r5; silent-write, not throw)

[runtime.ts L766-L782](../../../../src/runtime/runtime.ts#L766-L782): `applyPlannerResult` accumulates `update.status` into `untrackedChanges` and writes via `this.cardStore.update(update.id, untrackedChanges)`. Because `update` bypasses `validateTransition` and `validateMutablePatch` permits a `status` key on terminal cards, this path **silently persists** an illegal `failed → active` status change. It does **not** throw and does **not** emit an `Invalid transition: failed → active` line in `errors.jsonl`.

F19 r5 Step 5 replaces the direct `cardStore.update` with `await transitionCard(update.id, 'planner_set_status', { requestedStatus: update.status })`. The machine consults `cardStore.validateTransition(current, requested)` and rejects illegal one-step requests with one `state_machine_planner_status_rejected` log line and zero card writes (F19 r5 design action table).

**Status: silent illegal-write path closed by F19 r5** (the r1 docs incorrectly claimed this site produced the historical `validateTransition` throw; it does not).

### Path 3 — `dispatchGoal → activateGoal → setStatus('active')` (NOT covered by F19 r5)

[runtime.ts L621](../../../../src/runtime/runtime.ts#L621): `const result = this.cardStore.activateGoal(goalId);` inside `dispatchGoal`. The helper at [card-store.ts L1097-L1105](../../../../src/cards/card-store.ts#L1097-L1105) is:

```ts
activateGoal(id) {
  const goal = this.read(id);
  ...
  const activeGoal =
    goal.status === 'active' || goal.status === 'running' ? goal : this.setStatus(id, 'active');
  ...
}
```

For any goal card with `status === 'failed'` (or any other non-`active`/non-`running` status that is not in `VALID_TRANSITIONS.<status>` for target `'active'`), the `setStatus(id, 'active')` call goes through `validateTransition('failed', 'active')` and **throws `Invalid transition: failed → active` verbatim** — the exact text in the F23 issue.

F19 r5 Step 5 does not convert this call site. F19 r5 §Action table treats `activateGoal` only as part of the reviewer-repair construction proof for goal cards already in `'active'`/`'running'`; it does not route the `dispatchGoal` entry point through `RuntimeStateMachine`. Re-entering `dispatchGoal` for a failed goal card (e.g., the planner re-dispatches a previously failed subgoal, or `safeTick` resumes a stale `active_card_run` whose goal was marked `failed` by the planner-exception branch at [runtime.ts L635](../../../../src/runtime/runtime.ts#L635)) reproduces the throw.

**Status: F23 residual scope.**

## Out-of-scope (no F23 contribution)

- **Planner-tool direct callers** at [planner-tools.ts L163, L221](../../../../src/tools/planner-tools.ts#L163) are gated by the planner permission matrix and observed by the runtime only through Path 2. They are explicitly out of scope per F19 r5 §Out-of-scope card-status writers.
- **`performCrashRecovery` / `simulateCrash`** ([runtime.ts L614, L784](../../../../src/runtime/runtime.ts#L614)) write `→ backlog` only, which is legal from any non-terminal source per `VALID_TRANSITIONS`.

## Summary of changes vs r1

- Removes the incorrect claim that Path 2 throws via `validateTransition`. The pre-F19 Path 2 behavior is a silent illegal write; F19 r5 `planner_set_status` closes that silent path, not a historical throw.
- Adds Path 3 as F23 residual scope. Design and plan revisions handle it via `'start'`/`'restart'` through `RuntimeStateMachine.transitionCard`.
- Narrows the `errors.jsonl`-cleanliness claim to the union of (Path 1 via F19 r5) + (Path 3 via F23 r2). Path 2 contributes a different acceptance signal (no silent illegal write, rejection bookkeeping present).
