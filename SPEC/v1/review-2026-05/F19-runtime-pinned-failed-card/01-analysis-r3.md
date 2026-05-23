# F19 — Analysis (r3)

Supersedes [01-analysis-r2.md](01-analysis-r2.md). Changes vs r2 are at the end. All relative links are now repo-root-correct: `../../../../<path>` resolves to `/home/salva/g/ml/saivage-v3/<path>` (the package root) and `../../../../../<path>` resolves to the workspace root (`/home/salva/g/ml/<path>`) for artifacts and skills that live outside the package.

## Symptom

`GET /api/runtime/status` indefinitely returns

```
{ runtime: "running", paused: false, currentCardId: "<failed-card-id>", goalCount: 0 }
```

while the referenced card carries `status="failed"` and `allowedActions=["card.delete","card.restart"]`. The dashboard's runtime badge stays green; the runtime never auto-advances and never replans. Evidence: [tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G5-report.md](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G5-report.md) §T38; raw [t38-runtime-status.json](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t38-runtime-status.json), [t38-card-final.json](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t38-card-final.json).

## How `/api/runtime/status` is assembled

[src/server/server.ts](../../../../src/server/server.ts) registers the route inline in `registerRuntimeDispatchRoutes`:

```ts
if (activeRuntime) {
  const status = activeRuntime.getStatus();
  return reply.send({ runtime: status.status, paused: status.paused, currentCardId: status.currentCardId, goalCount: status.goalCount, ... });
}
// fallback when no active runtime is wired:
const state = readRuntimeState(projectRoot);
return reply.send({ runtime: state?.status ?? 'unknown', paused: state?.paused ?? false, currentCardId: state?.current_card_id ?? null, goalCount: 0, ... });
```

[src/runtime/active-runtime.ts](../../../../src/runtime/active-runtime.ts) `getStatus()`:

```ts
const state: RuntimeState | null = this._runtime.getState();
return {
  status: this._runtime.status,                    // in-memory _status
  paused: this._runtime.paused,                    // in-memory _paused
  currentCardId: state?.current_card_id ?? null,   // persisted disk state
  goalCount: <derived from cardStore.list()>,
};
```

So in the active-runtime path the payload mixes two stores: `status`/`paused` from the in-memory `Runtime` getters, `currentCardId` from on-disk `runtime.json` (re-read on every request). The fallback path reads everything from disk and is consistent — but only the active-runtime path is used in the deployed server.

## Where `_status` is mutated

`grep _status\s*=` in [src/runtime/runtime.ts](../../../../src/runtime/runtime.ts):

- `startup()`: `this._status = state.status` (one-shot at boot).
- `stopProject()` end: `this._status = 'idle'`.
- `shutdown()` end (and the early-`frozen` short-circuit): `this._status = 'idle'`.
- `freeze()`: `this._status = 'frozen'`.
- `resumeFromFreeze()`: `this._status = 'idle'`.

There is **no assignment of `_status` anywhere inside `dispatchGoal`, `dispatchPendingActivations`, `safeTick`, `applyPlannerResult`, or any error path**. The in-memory `_status` is therefore frozen between operator-driven lifecycle calls: whatever the persisted `state.status` happened to be at process start, or whatever the last `startProject`/`stopProject` set, is what `/api/runtime/status.runtime` reports until shutdown/stopProject/freeze/resumeFromFreeze runs again.

For the F19 trace specifically: after `start_project` the persisted state was flipped to `status:"running"` by `Runtime.dispatchGoal`'s goal-activation `updateRuntimeState({ status: 'running', current_card_id: goalId, ... })`; the next service restart picked that up at `startup()`; `_status` has remained `'running'` ever since.

## How `current_card_id` is written and cleared

Writers (all in [src/runtime/runtime.ts](../../../../src/runtime/runtime.ts)):

- `dispatchGoal` goal activation: sets `current_card_id = goalId` and `active_card_run.phase = 'planner'`.
- `dispatchPendingActivations` executor-target write: sets `current_card_id = card.id` before invoking the executor.
- `invokeReviewer`: sets `current_card_id = goalId` before the reviewer turn.

Clearers (each writes the same `{ status: 'idle', current_card_id: null, current_agent_session_id: null, queue: [], active_card_run: null }` blob):

- `startProject` background-dispatch `.catch`.
- `stopProject` mid-cleanup.
- `shutdown` end.
- planner exception path inside `dispatchGoal`.
- planner `blocked` exit.
- planner `done` + `hasUnfinishedChildWork` early exit.
- goal-completion happy path.
- `safeTick` stale-`active_card_run` self-heal.

**None of these run on the executor-failure branch.** In `dispatchPendingActivations` at the inner-loop tail:

```ts
executedTerminal = true;
const outcome = execResult.status === 'done' ? 'done' : 'failed';
this.appendChildUnwindToolResult(card.id, outcome, ...);
if (execResult.status === 'failed') {
  this.emit('card_failed', ...);
  this._eventLogger.appendEvent({ kind: 'card_failed', ... });
  failed = true;
  return { dispatchedGoal, executedTerminal, failed };
}
```

`current_card_id` and `active_card_run` are left pinned to the failed child. Control returns to `dispatchGoal`, which sets `plannerDone = false` and re-enters the planner loop. If the planner declares `status === 'done' && !hasGoalDispatch && hasUnfinishedChildWork`, the corresponding clear-state blob fires and the state clears. But if the planner declares `continue` (most common after a child failure) the loop keeps iterating without re-writing `current_card_id`/`active_card_run`. Eventually one of three things ends the dispatch:

- the planner exception path clears state and throws (visible in `errors.jsonl`);
- the `MAX_ITERATIONS = 50` cap exits the `for` without clearing;
- a re-activation of the failed card succeeds in writing `setStatus(card.id, 'running')` at the executor-start site, throws `Invalid transition: failed → running` or `failed → active`, escapes the inner `try/catch`, and tears down `dispatchPendingActivations` without clearing.

In all three of the last two cases (cap-exit, throw-escape) the runtime disk state stays at `{ status: 'running', current_card_id: <failed card>, active_card_run: { card_id: <failed card>, phase: 'executor', ... } }`. `_status` was already `'running'`. `/api/runtime/status` will keep reporting both stale fields forever, because there is no liveness tick that observes "current card is terminal" and clears or pops.

## Pause/resume: same drift, opposite direction

[`RuntimeControl`](../../../../src/runtime/control.ts) `pauseRuntimeControl`/`resumeRuntimeControl` do **not** in fact keep the two stores in lock-step. The sequence is:

```ts
ctx.activeRuntime.pause();                          // Runtime.pause() sets _paused = true
                                                    //   and writes disk { status: 'paused', paused: true, ... }
const runtimeStatus = ctx.activeRuntime.getStatus();// reads _status (stale) and _paused (just set)
mirrorRuntimeState(ctx.projectRoot, {               // writes disk { status: runtimeStatus.status, paused: runtimeStatus.paused }
  status: runtimeStatus.status,                     // <-- this is _status, NOT 'paused'
  paused: runtimeStatus.paused,
});
```

`Runtime.pause()` on its own correctly writes `status: 'paused'` to disk. Then `mirrorRuntimeState` immediately overwrites that disk `status` with whatever `_status` happens to be (typically `'running'` or `'idle'`). Net effect: after `POST /api/runtime/pause`, disk `status` is the in-memory `_status` value, not `'paused'`, while `paused` is `true`. `resumeRuntimeControl` has the same pattern — it reads `runtimeStatus.status` (the unchanged `_status`) and overwrites disk.

So pause/resume is not a counter-example to the drift; it is another instance of it. The in-memory `_status` is the corrupting source on every code path that calls `mirrorRuntimeState`. (Empirically pause/resume "works" in the operator dashboard because consumers only look at the `paused` boolean, not at `status`, in pause-related UI.)

The clear-state writes (eight sites) write `status: 'idle'` to disk but no one writes `this._status = 'idle'` to match. Even the happy-path goal completion leaks: a subsequent `/api/runtime/status` between completion and the next `start_project` reports `runtime: 'running'` from in-memory while `currentCardId` is `null` from disk — a contradiction the dashboard renders as a green idle badge with no card pointer (less visible than F19, same root cause).

## How the failed card becomes eligible again (the F23 path)

Trace by construction:

1. `dispatchPendingActivations` returns `failed = true`. Before returning it calls `appendChildUnwindToolResult(card.id, 'failed', ...)`, which calls `markActivationComplete(card.id, 'failed')` in [src/runtime/runtime.ts](../../../../src/runtime/runtime.ts). `markActivationComplete` flips every `runtime_activations` row with `child_card_id === card.id AND status in {pending, claimed, running}` to `'failed'`. After this, `getPendingActivationCards(goalId)` excludes the failed card.
2. Control returns to `dispatchGoal`, `plannerDone = false`, the loop iterates and re-invokes the planner.
3. Three documented ways the failed card can re-enter the executor target list:
   - **(a) Planner re-emits `activate_card`** on the same child id, producing a new `runtime_activations` row with `status: 'pending'`. `getPendingActivationCards` returns it; the executor-start site runs `if (card.status === 'backlog') setStatus(card.id, 'active'); setStatus(card.id, 'running');`. With `card.status === 'failed'`, the first `setStatus` is skipped (status is not `'backlog'`), and the unconditional `setStatus(card.id, 'running')` throws `Invalid transition: failed → running. Valid transitions from failed are: backlog, cancelled.` (validator in [src/cards/card-store.ts](../../../../src/cards/card-store.ts#L1081-L1087)).
   - **(b) Planner emits `updated_cards: [{ id: <failed card>, status: 'active' }]`**. `applyPlannerResult` routes `status` updates through `cardStore.update(id, { status: 'active' })`. `cardStore.update`'s `validateMutablePatch` explicitly allows `status` edits on terminal cards without consulting `validateTransition`. The card silently becomes `'active'`. On the next iteration, `getPendingActivationCards` may not return it (no new activation row), but a subsequent planner `activate_card` then hits the executor-start site with `card.status === 'active'`, the `if` is skipped (not `'backlog'`), and `setStatus(card.id, 'running')` succeeds (`active → running` is valid). The card is now silently re-running with a wrong audit trail.
   - **(c) `activateGoal`** is only called for goal-type cards; irrelevant for terminal executor cards.

The F23 error message captured by Phase-2 audit (`Invalid transition: failed → active. Valid transitions from failed are: backlog, cancelled.`) does not match the `setStatus(card.id, 'running')` call at the executor-start site verbatim (which would say `failed → running`). The verbatim `failed → active` message must come from a `setStatus(card.id, 'active')` call. The only runtime-layer caller that issues `setStatus(card.id, 'active')` is the very same executor-start conditional `if (card.status === 'backlog') this.cardStore.setStatus(card.id, 'active');`, which would only run if `getPendingActivationCards` returned a card whose status was `'backlog'` at that exact moment but then race-flipped to `'failed'` between the filter and the call — implausible in this single-threaded runtime — or if some external surface wrote `card.status = 'active'` *and then* a planner re-activation came in. The Phase-2 G5/T45 evidence does not capture the assignment that produced `card.status === 'failed'` immediately before the `failed → active` error; the simplest consistent explanation is route (b) followed by an out-of-order `setStatus(card.id, 'active')` from a planner-side tool. **F19 does not need a definitive identification of which caller produced the verbatim `failed → active` message to make the runtime safe**; what F19 needs is a single runtime-layer writer for `CardStatus` that mediates every runtime-originated transition.

## Two distinct bad mutation routes

The runtime layer has two structurally different ways to corrupt card state:

- **Route 1 — Throw-and-wedge**: `cardStore.setStatus(failedCard, 'active' | 'running')` at the executor-start site (and any similar runtime-side `setStatus` call) consults `VALID_TRANSITIONS` and **throws** with a Unicode-arrow message (`failed → active` / `failed → running`) via `CardStore.validateTransition()` ([src/cards/card-store.ts](../../../../src/cards/card-store.ts#L1081-L1087)). The throw escapes the inner `try/catch` and leaves runtime state pinned (F19 visible symptom; F23 audit symptom).
- **Route 2 — Silent illegal write**: `applyPlannerResult` calls `cardStore.update(id, { status: 'active' })` for planner-supplied status, and `validateMutablePatch` lets `status` through unconditionally on terminal cards. No throw, no `errors.jsonl` entry, no audit; the card just changes state. Visible to F23 only after a subsequent legal transition makes it observable.

Both routes need a single chokepoint. Neither can be patched per-call site without re-introducing the missing-chokepoint defect.

## Full runtime-originating `CardStatus` mutation inventory

Generated with `rg -n "cardStore\.setStatus|cardStore\.update\([^)]*status" src/runtime/runtime.ts` and verified by reading each line. Every site that mutates a `CardStatus` from runtime code is enumerated below, with a per-site classification:

- **in-scope-for-machine** — runtime-originated, must route through `RuntimeStateMachine.transitionCard(...)` in Step 5;
- **out-of-scope-with-justification** — runtime-originated but the reason it stays as a direct `cardStore` call is explicit.

| Site (`src/runtime/runtime.ts`) | Code | Caller context | Classification |
|---|---|---|---|
| [L266](../../../../src/runtime/runtime.ts#L266) | `this.cardStore.update(run.card_id, { status: 'running' });` | `repairStartupActiveCardRun()` reviewer-phase repair — runtime is restoring a discarded reviewer back to `running`. | **in-scope-for-machine**. The repair is a runtime-originated transition; the machine's `'startup_repair'` event handles it with `transitionCard(id, 'restart', { reason: 'reviewer_interrupted' })`. |
| [L278](../../../../src/runtime/runtime.ts#L278) | `this.cardStore.update(run.card_id, { status: 'failed', error: '…', result: { …, failure_kind: 'service_restart' } });` | `repairStartupActiveCardRun()` executor-phase repair — a non-terminal executor card whose process died across the service restart is forced to `failed`. | **in-scope-for-machine**. The machine emits `'startup_repair'` with `transitionCard(id, 'fail', { reason: 'service_restart', error })`; the card-result and error payload remain a direct `cardStore.update` of non-status fields done by the runtime after the transition. |
| [L614](../../../../src/runtime/runtime.ts#L614) | `if (card.status === 'active' \|\| card.status === 'running') this.cardStore.setStatus(card.id, 'backlog');` | `performCrashRecovery()` — at startup, any card stuck in `active`/`running` from a previous crashed process is dropped back to `backlog`. | **in-scope-for-machine**. This is the canonical "recover from crash" transition. Routed via `transitionCard(id, 'crash_recovery_drop_to_backlog')`; the machine validates `active → backlog` and `running → backlog` against `VALID_TRANSITIONS` (both legal). |
| [L635](../../../../src/runtime/runtime.ts#L635) | `this.cardStore.update(goalId, { status: 'failed', error: errorMessage, status_text: \`Planner failed: ${errorMessage}\` });` | planner-exception catch inside `dispatchGoal` — planner threw, the goal card itself is marked `failed`. | **in-scope-for-machine**. Goal-card terminal write; routed via `transitionCard(goalId, 'fail', { reason: 'planner_error', error })`. Non-status fields (`error`, `status_text`) stay as a direct `cardStore.update` after the transition. |
| [L644](../../../../src/runtime/runtime.ts#L644) | `this.cardStore.setStatus(goalId, 'running'); this.cardStore.setStatus(goalId, 'blocked');` | planner-blocked exit inside `dispatchGoal` — the planner returned `status: 'blocked'`; the goal card is promoted to `running` (so the `running → blocked` transition is legal) and then `blocked`. | **in-scope-for-machine**. Routed via `transitionCard(goalId, 'block', { blocked_reason })`; the machine knows the `→ running → blocked` micro-sequence and emits it through `cardStore.setStatus` internally, never as two separate runtime-side calls. |
| [L660](../../../../src/runtime/runtime.ts#L660) | `this.cardStore.setStatus(goalId, 'running'); this.cardStore.setStatus(goalId, 'done');` | goal-completed happy-path inside `dispatchGoal` — same `→ running → done` micro-sequence after a pass review. | **in-scope-for-machine**. Routed via `transitionCard(goalId, 'complete', { assessment })`; machine emits the `→ running → done` micro-sequence atomically. |
| [L706](../../../../src/runtime/runtime.ts#L706) | `if (card.status === 'backlog') this.cardStore.setStatus(card.id, 'active'); this.cardStore.setStatus(card.id, 'running');` | executor-target start inside `dispatchPendingActivations` — the F19/F23 primary site. | **in-scope-for-machine**. Routed via `transitionCard(card.id, action, { goalId })` where `action` is `'start'` for cards in `STARTABLE_STATES` (`drafting`, `backlog`, `changed`) and `'restart'` for cards in `RESTARTABLE_STATES` (`blocked`, `changed`, `done`, `failed`, `cancelled`). Closes F23. |
| [L715](../../../../src/runtime/runtime.ts#L715) | `this.cardStore.setStatus(card.id, 'failed');` | executor exception catch inside `dispatchPendingActivations` — executor threw, the child card is marked `failed`. | **in-scope-for-machine**. Routed via `transitionCard(card.id, 'fail', { reason: 'executor_exception', error })`. |
| [L740](../../../../src/runtime/runtime.ts#L740) | `this.cardStore.update(card.id, { status: 'failed', error: registrationError, result: { …, evidence_registration_failures: … } });` | evidence-registration-failure branch — a `done` executor outcome is downgraded to `failed` because artifacts/attachments could not be registered. | **in-scope-for-machine**. Routed via `transitionCard(card.id, 'fail', { reason: 'evidence_registration_failed', error: registrationError })`; the result-payload fields stay as a direct `cardStore.update` after the transition. |
| L758 | `updateRuntimeState({ current_card_id: goalId, current_agent_session_id: reviewerSessionId, active_card_run: { … } });` | `invokeReviewer()` — **not a `CardStatus` writer**; this writes runtime-state owned fields only. | **out-of-scope for the card-status inventory.** Listed for completeness because it appears in the original review's line list; it is in scope for the **runtime-state** writer inventory (Step 6 of the plan, routed through `transition('reviewer_started', …)`). |
| L766–782 (`applyPlannerResult.untrackedChanges.status`) | `this.cardStore.update(update.id, { status: update.status as CardRecord['status'] });` | `applyPlannerResult()` — planner-supplied `status` on any card, bypasses `validateTransition` via the `update` carve-out. | **in-scope-for-machine**. Routed via `transitionCard(update.id, 'planner_set_status', { requestedStatus })`. Closes Route 2. |
| [L784](../../../../src/runtime/runtime.ts#L784) | `if (card.status === 'active' \|\| card.status === 'running') this.cardStore.setStatus(card.id, 'backlog');` | `simulateCrash()` — test/diagnostic helper that mirrors `performCrashRecovery()` to drop in-flight cards to `backlog`. | **in-scope-for-machine**. Same shape as L614; routed via the same `transitionCard(id, 'crash_recovery_drop_to_backlog')`. Keeps the test surface honest. |

After the conversions above, `rg -n "cardStore\.setStatus|cardStore\.update\([^\n]*status" src/runtime/runtime.ts` returns zero matches. The Step 5 checklist in [03-plan-r3.md](03-plan-r3.md) lists every site one-to-one with the action above; the Step 7 cleanup re-runs the same grep as a gate.

## Out-of-scope card-status writers (architecture-first justification)

The "single runtime-layer writer" boundary explicitly excludes these surfaces. Each entry below documents the surface and the reason it stays a direct `cardStore` call:

- [src/agents/analyst-tools.ts](../../../../src/agents/analyst-tools.ts#L142-L144) — `abort_goal` calls `store.setStatus(id, 'cancelled')`; `restart_card` and `restart_goal` call `store.update({ status: 'backlog', … })` and `store.setStatus(id, 'cancelled')`. These are **analyst tool surface** writes invoked from the analyst conversation; they pass through the analyst permission matrix (`decide({ role: 'analyst', … })`) inside `runMutatingTool`. F19's machine is the *runtime-orchestrator* boundary; analyst tools have their own permission/audit envelope and are deliberately not routed through `RuntimeStateMachine.transitionCard`. Moving them would conflate two boundaries and require duplicate analyst-action plumbing inside the machine. Explicit out-of-scope; Step 7 grep allowlist tolerates this file.
- Operator API routes (`src/server/routes/cards-*`) that issue `cardStore.setStatus` / `cardStore.update({ status })` in response to operator clicks — same justification as analyst tools, different role. Operator surface; out of scope. Step 7 grep allowlist scopes to `src/runtime/runtime.ts` only.
- [src/cards/card-store.ts](../../../../src/cards/card-store.ts) itself — the store is the validator; its internal `setStatus`/`update` paths are the implementation surface that `transitionCard` calls into. Out of scope by construction.
- [src/server/routes/runtime-config-notes.ts](../../../../src/server/routes/runtime-config-notes.ts) freeze/resume-from-freeze fallback writes of runtime-state — runtime-state field writes, not `CardStatus`. Out of scope for this card-status inventory; out of scope for the Step 6 runtime-state inventory because they execute only when no active runtime is attached, and the design explicitly narrows the machine boundary to active-runtime callers.

## Where the runtime tick should have noticed

[`Runtime.safeTick`](../../../../src/runtime/runtime.ts) is the only "loop" that runs after a goal exits:

```ts
if (state?.active_card_run) {
  if (state.active_card_run.phase === 'planner') {
    await this.dispatchGoal(state.active_card_run.card_id);
    return;
  }
  if (this._dispatchInFlight.size === 0) {
    updateRuntimeState(... { status: 'idle', current_card_id: null, ..., active_card_run: null });
    // fall through
  } else {
    return;
  }
}
const intentStatus = state?.runtime_intent?.status ?? 'stopped';
const openRootRun = (state?.runtime_runs ?? []).find(...);
if (intentStatus === 'running' && openRootRun) await this.dispatchGoal('project');
```

`safeTick` does the right thing for `phase !== 'planner'` when no dispatch is in flight (clears state and tries to resume from `runtime_intent`), **but**:

1. It is only invoked from `startup()` (one-shot `setTimeout(..., 0)`) and from `resume()`. There is no interval, no post-`dispatchGoal` re-schedule, no card-failure trigger. After the start-project background dispatch exits, nothing kicks `safeTick` again.
2. The `phase === 'planner'` branch reruns `dispatchGoal` for the same goal; that is a no-op when `_dispatchInFlight` already contains the goal id, but after the dispatch silently exits the in-flight set is empty, so it would re-enter `dispatchGoal('project')`. Whether that actually progresses depends on whether the planner makes new decisions; if the planner keeps trying to restart the same failed card it will hit the F23 throw again.
3. `safeTick` never inspects the card status of `active_card_run.card_id`. It treats `phase: 'executor'` with `current_card_id` pointing at a `failed` card the same as a healthy in-flight executor — bails on `_dispatchInFlight.size > 0`, clears `active_card_run` on the other branch but never resets `_status` in-memory, so `/api/runtime/status.runtime` keeps lying even after the disk side recovers.

There is no `setInterval` anywhere in [src/runtime/runtime.ts](../../../../src/runtime/runtime.ts) — only the `StuckAgentSupervisor` runs on a clock and it does not touch runtime status or `active_card_run`.

## Inventory of runtime-state writers (full scope for "single runtime-layer writer")

Writers of owned runtime-state fields (`status`, `current_card_id`, `current_agent_session_id`, `active_card_run`, `paused`, `paused_at`, `last_tick_at`):

- [src/runtime/runtime.ts](../../../../src/runtime/runtime.ts) — `repairStartupActiveCardRun` `saveRuntimeState` branches (5 distinct); `emitAgentEvent` `session_started`'s `current_agent_session_id` write; the eight clear-state blobs in `startProject` catch / `stopProject` cleanup / `shutdown` / planner-exception / blocked-exit / done-with-children / goal-completed / `safeTick` self-heal; `pause()`, `resume()`, `freeze()`, `resumeFromFreeze()` writes; `dispatchGoal` activation and paused-exit writes; the between-iteration `current_agent_session_id` update; the executor-target write at L706 (owned-fields portion); `invokeReviewer` at L758.
- [src/runtime/control.ts](../../../../src/runtime/control.ts) — `mirrorRuntimeState` (called by `pauseRuntimeControl`/`resumeRuntimeControl`); the no-active-runtime fallback `updateRuntimeState` writes in the `else` branches of the same functions.
- [src/server/routes/runtime-config-notes.ts](../../../../src/server/routes/runtime-config-notes.ts) — freeze fallback `updateRuntimeState` and resume-from-freeze fallback `updateRuntimeState` (both only run when no active runtime is attached).

Every entry on this list is a candidate site for the state-machine boundary. The design ([02-design-r3.md](02-design-r3.md)) narrows the boundary explicitly: the in-process `Runtime` and `ActiveRuntime` callers are routed through the machine; the no-active-runtime fallbacks in `control.ts` and `runtime-config-notes.ts` are out of scope for F19 and are documented as a separate later concern.

## Desired contract

For any time `t`, given `S = /api/runtime/status` at `t`:

> **C1 (liveness / recovery).** If `S.runtime === "running"` and `S.currentCardId` references a card with `status ∈ TERMINAL_STATUSES = {done, failed, cancelled}`, then within `N_C1_inner = 5s` of `t` the next tick must either:
> - clear `current_card_id` (or repoint it at a non-terminal parent planner run via `parentPlannerRunFor`), **or**
> - transition `runtime` to `"idle" | "paused" | "frozen"`.
>
> Within `N_C1_outer = 30s` of `t`, either a re-dispatch is in flight (observable as a non-terminal `currentCardId` and an in-flight planner session) or `runtime` is no longer `"running"`. `lastTickAt` is a necessary observability signal but is **not** by itself a proof of C1.

> **C2 (consistency).** `S.runtime`, `S.paused`, and the persisted `RuntimeState.status` / `RuntimeState.paused` agree at all times. No code path may report or persist a `status` value derived from a stale in-memory mirror.

> **C3 (no pinned terminals).** `S.currentCardId` never references a card whose `status ∈ TERMINAL_STATUSES` for longer than one tick (`N_C3 = 5s`).

> **C4 (observability).** `/api/runtime/status` exposes `lastTickAt: ISO8601 | null` so an external probe can prove the tick is alive. `lastTickAt` is monotonic across ticks for a single live runtime.

`TERMINAL_STATUSES = {done, failed, cancelled}` is already declared near the top of [src/runtime/runtime.ts](../../../../src/runtime/runtime.ts) and is the same constant the design reuses.

## Coordination with F13 r3 (construction ordering)

F13 r3 (the umbrella card-store work) is rewiring `Runtime` construction to be asynchronous: `Runtime.open(config)` and `ActiveRuntime.open(projectRoot, config, mcpManager)` factory functions replace the current synchronous `new Runtime(...)` / `new ActiveRuntime(...)` constructors. The F19 state-machine seam ([02-design-r3.md](02-design-r3.md)) is defined as a sync-constructible class (`new RuntimeStateMachine({ … })` with no I/O), so it composes with either construction style. **Ordering**: F13 r3 lands first, then F19 rebases:

- pre-F13: F19 Step 3 would wire the machine inside `Runtime`'s synchronous constructor;
- post-F13: F19 Step 3 wires the machine inside `Runtime.open()` after the async setup completes and before the returned instance is exposed. `RuntimeStateMachine` itself does not change; only its instantiation site moves. `ActiveRuntime.stateMachine` becomes a getter on the `ActiveRuntime` instance returned by `ActiveRuntime.open()`, identical in observable behaviour to the pre-F13 synchronous version.

The F19 design and plan are written to land after F13 r3; if the merge order changes, only the wiring location in Step 3 needs to be adjusted, not the seam itself.

## Assumptions not verifiable from code alone

1. The Phase-2 wedge persisted across at least minutes (per G5/T38 observation); the audit did not measure exactly how many planner iterations ran before exit, only that the symptom did not self-clear. The analysis treats all three loop-exit modes (planner exception, MAX_ITERATIONS, throw escape) as possible producers of the observed symptom; the F19 design must make every one of them safe.
2. The exact stack trace for `Invalid transition: failed → active` was logged to `errors.jsonl` but the audit captured only the message ([F23](../F23-invalid-failed-active/00-issue.md)); see "How the failed card becomes eligible again" above for the construction-based reasoning. F19 does not depend on identifying the literal caller of that specific verbatim message.
3. Operator `card.restart` is assumed working per the permission matrix ([src/permissions/card-permissions.ts](../../../../src/permissions/card-permissions.ts#L28-L50)); the actual restart route was not traced in this audit. The design assumes operator restart correctly drives `failed → backlog → active → running` and only the automatic recovery path is broken.
4. `/api/runtime/status` consumers (the Vue dashboard, the e2e harness) only read the documented fields and will tolerate one additive field (`lastTickAt`). This was true at Phase 2; a contract-level addition is the safe surface change.

## Changes vs r2

- Reviewer §1 (analysis): runtime-originating `CardStatus` mutation inventory expanded to a per-site table covering every site at runtime.ts L266, L278, L614, L635, L644, L660, L706, L715, L740, L766–782, L784 with explicit **in-scope-for-machine** vs **out-of-scope-with-justification** classification. L758 is annotated as a runtime-state writer (not card-status) for completeness.
- Reviewer §1 (design boundary): out-of-scope analyst-tools (`abort_goal`/`restart_card`/`restart_goal`), operator API routes, `CardStore` self, and `runtime-config-notes.ts` fallbacks are each named with their justification.
- Reviewer §2: all relative links recomputed. `../../../../src/...` resolves to `/home/salva/g/ml/saivage-v3/src/...`; `../../../../../tmp/...` and `../../../../../.github/skills/...` resolve to workspace-root artifacts that live outside the `saivage-v3/` package.
- New "Coordination with F13 r3" section makes the construction-ordering ownership explicit.
