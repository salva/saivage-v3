# F19 — Analysis (r2)

Supersedes [01-analysis-r1.md](01-analysis-r1.md). Changes vs r1 are summarised at the end.

## Symptom

`GET /api/runtime/status` indefinitely returns

```
{ runtime: "running", paused: false, currentCardId: "<failed-card-id>", goalCount: 0 }
```

while the referenced card carries `status="failed"` and `allowedActions=["card.delete","card.restart"]`. The dashboard's runtime badge stays green; the runtime never auto-advances and never replans. Evidence: [tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G5-report.md](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G5-report.md) §T38; raw [t38-runtime-status.json](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t38-runtime-status.json), [t38-card-final.json](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t38-card-final.json).

## How `/api/runtime/status` is assembled

[src/server/server.ts](../../../src/server/server.ts) registers the route inline in `registerRuntimeDispatchRoutes`:

```ts
if (activeRuntime) {
  const status = activeRuntime.getStatus();
  return reply.send({ runtime: status.status, paused: status.paused, currentCardId: status.currentCardId, goalCount: status.goalCount, ... });
}
// fallback when no active runtime is wired:
const state = readRuntimeState(projectRoot);
return reply.send({ runtime: state?.status ?? 'unknown', paused: state?.paused ?? false, currentCardId: state?.current_card_id ?? null, goalCount: 0, ... });
```

[src/runtime/active-runtime.ts](../../../src/runtime/active-runtime.ts) `getStatus()`:

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

`grep _status\s*=` in [src/runtime/runtime.ts](../../../src/runtime/runtime.ts):

- line 605 `startup()`: `this._status = state.status` (one-shot at boot).
- line 583 `stopProject()` end: `this._status = 'idle'`.
- line 609 `shutdown()` end (and the early-`frozen` short-circuit): `this._status = 'idle'`.
- line 612 `freeze()`: `this._status = 'frozen'`.
- line 613 `resumeFromFreeze()`: `this._status = 'idle'`.

There is **no assignment of `_status` anywhere inside `dispatchGoal`, `dispatchPendingActivations`, `safeTick`, `applyPlannerResult`, or any error path**. The in-memory `_status` is therefore frozen between operator-driven lifecycle calls: whatever the persisted `state.status` happened to be at process start, or whatever the last `startProject`/`stopProject` set, is what `/api/runtime/status.runtime` reports until shutdown/stopProject/freeze/resumeFromFreeze runs again.

For the F19 trace specifically: after `start_project` the persisted state was flipped to `status:"running"` by [`Runtime.dispatchGoal`](../../../src/runtime/runtime.ts) line 621 (`updateRuntimeState({ status: 'running', current_card_id: goalId, ... })`); the next service restart picked that up at startup (line 605); `_status` has remained `'running'` ever since.

## How `current_card_id` is written and cleared

Writers (all in [src/runtime/runtime.ts](../../../src/runtime/runtime.ts)):

- line 621 `dispatchGoal`: sets `current_card_id = goalId` and `active_card_run.phase = 'planner'` when the goal is activated.
- line 706 `dispatchPendingActivations`: sets `current_card_id = card.id` (executor target) before invoking the executor.
- line 786 `invokeReviewer`: sets `current_card_id = goalId` before the reviewer turn.

Clearers (each writes the same `{ status: 'idle', current_card_id: null, current_agent_session_id: null, queue: [], active_card_run: null }` blob):

- line 555 `startProject` background-dispatch `.catch`.
- line 581 `stopProject` mid-cleanup.
- line 609 `shutdown` end.
- line 635 planner exception path inside `dispatchGoal`.
- line 644 planner `blocked` exit.
- line 645 planner `done` + `hasUnfinishedChildWork` early exit.
- line 660 goal completion happy path.
- line 800 `safeTick` stale-`active_card_run` self-heal.

**Critically, none of these run on the executor-failure branch.** In [`dispatchPendingActivations`](../../../src/runtime/runtime.ts) at the inner-loop tail:

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

`current_card_id` and `active_card_run` are left pinned to the failed child. Control returns to `dispatchGoal` (line 638), which sets `plannerDone = false` and re-enters the planner loop. If the planner then declares `status === 'done' && !hasGoalDispatch && hasUnfinishedChildWork`, the line-645 blob fires and the state clears. But if the planner declares `continue` (most common after a child failure) the loop keeps iterating without re-writing `current_card_id`/`active_card_run`. Eventually one of three things ends the dispatch:

- the planner exception path (line 635) clears state and throws (visible in `errors.jsonl`);
- the `MAX_ITERATIONS = 50` cap exits the `for` without clearing;
- a re-activation of the failed card succeeds in writing `setStatus(card.id, 'running')` at line 706 (see "F23 path" below), throws `Invalid transition: failed → running` or `failed → active`, escapes the inner `try/catch`, and tears down `dispatchPendingActivations` without clearing.

In all three of the last two cases (cap-exit, throw-escape) the runtime disk state stays at `{ status: 'running', current_card_id: <failed card>, active_card_run: { card_id: <failed card>, phase: 'executor', ... } }`. `_status` was already `'running'`. `/api/runtime/status` will keep reporting both stale fields forever, because there is no liveness tick that observes "current card is terminal" and clears or pops.

## Pause/resume: same drift, opposite direction

[`RuntimeControl`](../../../src/runtime/control.ts) `pauseRuntimeControl`/`resumeRuntimeControl` do **not** in fact keep the two stores in lock-step. The sequence is:

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

The clear-state writes (8 sites) write `status: 'idle'` to disk but no one writes `this._status = 'idle'` to match. Even the happy-path goal completion (line 660) leaks: a subsequent `/api/runtime/status` between completion and the next `start_project` reports `runtime: 'running'` from in-memory while `currentCardId` is `null` from disk — a contradiction the dashboard renders as a green idle badge with no card pointer (less visible than F19, same root cause).

## How the failed card becomes eligible again (the F23 path)

The previous revision claimed the orchestrator necessarily returns to line 706 for the same card. That overstates the evidence. Trace by construction:

1. `dispatchPendingActivations` returns `failed = true`. Before returning it calls `appendChildUnwindToolResult(card.id, 'failed', ...)`, which calls `markActivationComplete(card.id, 'failed')` ([src/runtime/runtime.ts](../../../src/runtime/runtime.ts#L172-L188)). `markActivationComplete` flips every `runtime_activations` row with `child_card_id === card.id AND status in {pending, claimed, running}` to `'failed'`. After this, `getPendingActivationCards(goalId)` ([src/runtime/runtime.ts](../../../src/runtime/runtime.ts#L687-L696)) excludes the failed card.
2. Control returns to `dispatchGoal`, `plannerDone = false`, the loop iterates and re-invokes the planner.
3. Three documented ways the failed card can re-enter the executor target list:
   - **(a) Planner re-emits `activate_card`** on the same child id, producing a new `runtime_activations` row with `status: 'pending'`. `getPendingActivationCards` returns it; line 706 runs `if (card.status === 'backlog') setStatus(card.id, 'active'); setStatus(card.id, 'running');`. With `card.status === 'failed'`, the first `setStatus` is skipped (status is not `'backlog'`), and the unconditional `setStatus(card.id, 'running')` throws `Invalid transition: failed → running. Valid transitions from failed are: backlog, cancelled.` ([src/cards/card-store.ts](../../../src/cards/card-store.ts#L217-L227), [src/cards/card-store.ts](../../../src/cards/card-store.ts#L1081-L1105)).
   - **(b) Planner emits `updated_cards: [{ id: <failed card>, status: 'active' }]`**. `applyPlannerResult` ([src/runtime/runtime.ts](../../../src/runtime/runtime.ts#L766-L782)) routes `status` updates through `cardStore.update(id, { status: 'active' })`. `cardStore.update`'s `validateMutablePatch` ([src/cards/card-store.ts](../../../src/cards/card-store.ts#L567-L576)) explicitly allows `status` edits on terminal cards without consulting `validateTransition`. The card silently becomes `'active'`. On the next iteration, `getPendingActivationCards` may not return it (no new activation row), but a subsequent planner `activate_card` then hits line 706 with `card.status === 'active'`, the `if` is skipped (not `'backlog'`), and `setStatus(card.id, 'running')` succeeds (`active → running` is valid). The card is now silently re-running with a wrong audit trail.
   - **(c) `activateGoal`** is only called for goal-type cards (line 619); irrelevant for terminal executor cards.

The F23 error message captured by Phase-2 audit (`Invalid transition: failed → active. Valid transitions from failed are: backlog, cancelled.`) does not match the `setStatus(card.id, 'running')` call at line 706 verbatim (which would say `failed → running`). The verbatim `failed → active` message must come from a `setStatus(card.id, 'active')` call. The only runtime-layer caller that issues `setStatus(card.id, 'active')` is the very same line 706 conditional `if (card.status === 'backlog') this.cardStore.setStatus(card.id, 'active');`, which would only run if `getPendingActivationCards` returned a card whose status was `'backlog'` at that exact moment but then race-flipped to `'failed'` between the filter and the call — implausible in this single-threaded runtime — or if some external surface (operator tool, analyst tool, or planner `card.update`-style invocation) wrote `card.status = 'active'` *and then* a planner re-activation came in. The Phase-2 G5/T45 evidence does not capture the assignment that produced `card.status === 'failed'` immediately before the `failed → active` error; the simplest consistent explanation is route (b) followed by an out-of-order `setStatus(card.id, 'active')` from a planner-side tool. **F19 does not need a definitive identification of which caller produced the verbatim `failed → active` message to make the runtime safe**; what F19 needs is a single writer for `CardStatus` that mediates every runtime-layer transition. The design therefore treats both line 706 and `applyPlannerResult`'s untracked-status write as in-scope for replacement, and the F23 design can scope the remaining out-of-runtime callers separately.

## Two distinct bad mutation routes

The runtime layer has two structurally different ways to corrupt card state:

- **Route 1 — Throw-and-wedge**: `cardStore.setStatus(failedCard, 'active' | 'running')` at line 706 (and any similar runtime-side `setStatus` call) consults `VALID_TRANSITIONS` ([src/cards/card-store.ts](../../../src/cards/card-store.ts#L1081-L1105)) and **throws**. The throw escapes the inner `try/catch` and leaves runtime state pinned (F19 visible symptom; F23 audit symptom).
- **Route 2 — Silent illegal write**: `applyPlannerResult` calls `cardStore.update(id, { status: 'active' })` for planner-supplied status, and `validateMutablePatch` ([src/cards/card-store.ts](../../../src/cards/card-store.ts#L567-L576)) lets `status` through unconditionally on terminal cards. No throw, no `errors.jsonl` entry, no audit; the card just changes state. Visible to F23 only after a subsequent legal transition makes it observable.

Both routes need a single chokepoint. Neither can be patched per-call site without re-introducing the missing-chokepoint defect.

## Where the runtime tick should have noticed

[`Runtime.safeTick`](../../../src/runtime/runtime.ts) line 787 is the only "loop" that runs after a goal exits:

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

There is no `setInterval` anywhere in [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) — only the `StuckAgentSupervisor` runs on a clock ([src/runtime/stuck-agent-supervisor.ts](../../../src/runtime/stuck-agent-supervisor.ts) line 252), and it does not touch runtime status or `active_card_run`.

## Inventory of runtime-state writers (full scope for "single writer")

Writers of fields the design will own (`status`, `current_card_id`, `current_agent_session_id`, `active_card_run`, `paused`, `paused_at`, `last_tick_at`):

- [src/runtime/runtime.ts](../../../src/runtime/runtime.ts)
  - line 271 / 282 / 290 / 296: `repairStartupActiveCardRun` `saveRuntimeState` calls (5 distinct branches).
  - line 487 `emitAgentEvent`: writes `current_agent_session_id` for `session_started`.
  - line 555 / 581 / 609: clear-state blobs in `startProject` catch / `stopProject` cleanup / `shutdown`.
  - line 610 `pause`: writes `status: 'paused', paused, paused_at`.
  - line 611 `resume`: writes `status: 'running' | 'idle', paused, paused_at`.
  - line 612 `freeze`: writes `status: 'frozen', current_card_id, current_agent_session_id, paused, paused_at`.
  - line 613 `resumeFromFreeze`: writes `status: 'idle', current_card_id, current_agent_session_id, paused, paused_at`.
  - line 621 `dispatchGoal` activation: writes `status: 'running', current_card_id, current_agent_session_id, active_card_run`.
  - line 624 `dispatchGoal` paused-exit: writes `status: 'paused'`.
  - line 635 / 644 / 645 / 660: clear-state blobs.
  - line 637 between iterations: writes `current_agent_session_id`.
  - line 706 executor-target write: `current_card_id`, `active_card_run`.
  - line 758 `invokeReviewer`: writes `current_card_id`, `current_agent_session_id`, `active_card_run`.
  - line 800 `safeTick` self-heal blob.
- [src/runtime/control.ts](../../../src/runtime/control.ts)
  - `mirrorRuntimeState` (called by `pauseRuntimeControl` and `resumeRuntimeControl`): writes `status`, `paused`, `paused_at` from in-memory `getStatus()`. Also writes the fallback `status: 'paused' | 'idle'` blob in the no-active-runtime branch.
- [src/server/routes/runtime-config-notes.ts](../../../src/server/routes/runtime-config-notes.ts)
  - line 175 freeze fallback: writes `status: 'frozen', paused, paused_at, frozen_reason` when no active runtime is present.
  - line 176 resume-from-freeze fallback: writes `status: 'idle', current_card_id, current_agent_session_id, paused, paused_at, queue, running_processes, frozen_reason`.

Every entry on this list is a candidate site for the state-machine boundary. The design ([02-design-r2.md](02-design-r2.md)) narrows the boundary explicitly: the in-process `Runtime` and `ActiveRuntime` callers are routed through the machine; the no-active-runtime fallbacks in `control.ts` and `runtime-config-notes.ts` are out of scope for F19 and are documented as a separate later concern.

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

`TERMINAL_STATUSES = {done, failed, cancelled}` is already declared in [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) line 83 and is the same constant the design reuses.

## Assumptions not verifiable from code alone

1. The Phase-2 wedge persisted across at least minutes (per G5/T38 observation); the audit did not measure exactly how many planner iterations ran before exit, only that the symptom did not self-clear. The analysis treats all three loop-exit modes (planner exception, MAX_ITERATIONS, throw escape) as possible producers of the observed symptom; the F19 design must make every one of them safe.
2. The exact stack trace for `Invalid transition: failed → active` was logged to `errors.jsonl` but the audit captured only the message ([F23](../F23-invalid-failed-active/00-issue.md)); see "How the failed card becomes eligible again" above for the construction-based reasoning. F19 does not depend on identifying the literal caller of that specific verbatim message.
3. Operator `card.restart` is assumed working per the permission matrix ([src/permissions/card-permissions.ts](../../../src/permissions/card-permissions.ts#L49)); the actual restart route was not traced in this audit. The design assumes operator restart correctly drives `failed → backlog → active → running` and only the automatic recovery path is broken.
4. `/api/runtime/status` consumers (the Vue dashboard, the e2e harness) only read the documented fields and will tolerate one additive field (`lastTickAt`). This was true at Phase 2; a contract-level addition is the safe surface change.

## Changes vs r1

- Reviewer §1: pause/resume drift corrected. Pause/resume is now described as another instance of the same in-memory→disk drift (via `mirrorRuntimeState` reading `_status`), not a counter-example.
- Reviewer §2: F23 path tightened. The proven inputs (`appendChildUnwindToolResult` → `markActivationComplete` excludes the failed card from the next `getPendingActivationCards`) are stated, the three plausible re-entry routes (planner re-`activate_card`, planner `updated_cards.status`, `activateGoal`) are enumerated, and the line-706 caller is framed as one of several rather than as proven.
- Reviewer §3: Two distinct status-mutation routes called out — Route 1 (throw-and-wedge via `setStatus`) and Route 2 (silent illegal write via `cardStore.update`'s `validateMutablePatch` carve-out).
- Reviewer §4: C1 split into an inner (5s) and outer (30s) clause with explicit recovery actions; `lastTickAt` is demoted to observability only.
- Reviewer §5: Writer inventory expanded to include the `repairStartupActiveCardRun` branches, `emitAgentEvent`'s `current_agent_session_id` write, the executor-target write at line 706, `invokeReviewer` at line 758, the fallback freeze/resume routes in `runtime-config-notes.ts`, and `control.ts`'s `mirrorRuntimeState`. The design narrows the boundary explicitly.
