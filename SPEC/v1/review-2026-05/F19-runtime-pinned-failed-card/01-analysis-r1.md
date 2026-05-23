# F19 — Analysis (r1)

## Symptom

`GET /api/runtime/status` indefinitely returns

```
{ runtime: "running", paused: false, currentCardId: "<failed-card-id>", goalCount: 0 }
```

while the referenced card carries `status="failed"` and `allowedActions=["card.delete","card.restart"]`. The dashboard's runtime badge stays green; the runtime never auto-advances and never replans. Evidence: [tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G5-report.md](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G5-report.md) §T38; raw [t38-runtime-status.json](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t38-runtime-status.json), [t38-card-final.json](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t38-card-final.json).

## How `/api/runtime/status` is assembled

[src/server/server.ts](../../../src/server/server.ts) line 64 — `registerRuntimeDispatchRoutes` inlines:

```ts
const status = activeRuntime.getStatus();
return reply.send({
  runtime: status.status,
  paused: status.paused,
  currentCardId: status.currentCardId,
  goalCount: status.goalCount,
  ...
});
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

So the payload mixes two stores: `status`/`paused` from the in-memory `Runtime` getters, `currentCardId` from the on-disk `runtime.json` (read on every request by `readRuntimeState`).

## Where `_status` is mutated

`grep _status\s*=` in [src/runtime/runtime.ts](../../../src/runtime/runtime.ts):

- line 605 `startup()`: `this._status = state.status` (one-shot at boot).
- line 583 `stopProject()` end: `this._status = 'idle'`.
- line 609 `shutdown()`: `this._status = 'idle'`.
- line 612 `freeze()`: `this._status = 'frozen'`.
- line 613 `resumeFromFreeze()`: `this._status = 'idle'`.

There is **no assignment of `_status` anywhere inside `dispatchGoal`, `dispatchPendingActivations`, `safeTick`, `applyPlannerResult`, or any error path**. The in-memory `_status` is therefore frozen between boots: whatever the persisted `state.status` happened to be at process start becomes the value reported by `/api/runtime/status.runtime` until the runtime is shutdown/stopped/frozen.

For the F19 trace specifically: after `start_project` the persisted state was flipped to `status:"running"` by [`Runtime.dispatchGoal`](../../../src/runtime/runtime.ts) (line 621 `updateRuntimeState({ status: 'running', current_card_id: goalId, ... })`); the next service restart picked that up at startup (line 605); `_status` has remained `'running'` ever since.

## How `current_card_id` is written and cleared

Writers (all in [src/runtime/runtime.ts](../../../src/runtime/runtime.ts)):

- line 621 `dispatchGoal`: sets `current_card_id = goalId` and `active_card_run.phase = 'planner'` when the goal is activated.
- line 706 `dispatchPendingActivations`: sets `current_card_id = card.id` (executor target) before invoking the executor.
- line 786 `invokeReviewer`: sets `current_card_id = goalId` before the reviewer turn.

Clearers (all clear together as `{ status: 'idle', current_card_id: null, current_agent_session_id: null, queue: [], active_card_run: null }`):

- line 644 planner `blocked` exit.
- line 645 planner `done` + `hasUnfinishedChildWork` early exit.
- line 660 goal completion happy path.
- line 635 planner exception path.
- line 555 `startProject` background-dispatch `.catch`.
- line 583 `stopProject`.
- line 609 `shutdown` end.
- line 800 `safeTick` stale-`active_card_run` self-heal.

**Critically, none of these run on the executor-failure branch.** In [`dispatchPendingActivations`](../../../src/runtime/runtime.ts) line 743+:

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

`current_card_id` is left pinned to the failed child. Control returns to `dispatchGoal` (line 638), which sets `plannerDone = false` and re-enters the loop. The next iteration runs the planner again; the planner may return `done`+`hasUnfinishedChildWork=false` (which would trigger the line-660 cleanup) or `continue`, or — per [F23](../F23-invalid-failed-active/00-issue.md) — attempt to re-dispatch the same failed card. The line-706 entry `setStatus(card.id, 'active')` then throws `Invalid transition: failed → active` because [src/cards/card-store.ts](../../../src/cards/card-store.ts) line 217 only allows `failed → {backlog, cancelled}`. That throw escapes `dispatchPendingActivations`, bubbles into the iteration's outer scope, and on the executor-call branch is caught by the inline `try`/`catch` on line 743 — but on the line-706 path it is not wrapped, so it propagates to `dispatchGoal`'s `for`-loop body and tears down the iteration without entering the clean-up branches.

The `MAX_ITERATIONS = 50` safety cap in `dispatchGoal` (line 622) also exits the loop without clearing runtime state, and the surrounding `try { … } finally { this._dispatchInFlight.delete(goalId); }` only removes the in-flight marker.

Net effect: on any executor failure the disk state stays at `{ status: 'running', current_card_id: <failed card>, active_card_run: { card_id: <failed card>, phase: 'executor', ... } }`. `_status` was already 'running'. `/api/runtime/status` will keep reporting both stale fields forever.

## Where the runtime tick should have noticed

[`Runtime.safeTick`](../../../src/runtime/runtime.ts) line 787 is the only "loop" that runs after a goal exits:

```ts
if (state?.active_card_run) {
  if (state.active_card_run.phase === 'planner') {
    await this.dispatchGoal(state.active_card_run.card_id);
    return;
  }
  if (this._dispatchInFlight.size === 0) {
    // self-heal: clear stale active_card_run, fall through
    updateRuntimeState(... { status: 'idle', current_card_id: null, active_card_run: null });
  } else {
    return;
  }
}
const intentStatus = state?.runtime_intent?.status ?? 'stopped';
const openRootRun = (state?.runtime_runs ?? []).find(...);
if (intentStatus === 'running' && openRootRun) await this.dispatchGoal('project');
```

`safeTick` does the right thing for `phase !== 'planner'` (clears and resumes), **but**:

1. It is only invoked from `startup()` (one-shot `setTimeout`) and from `resume()`. There is no interval, no post-`dispatchGoal` re-schedule, no card-failure trigger. After the start-project background dispatch exits, nothing kicks `safeTick` again.
2. Even if it were invoked, the `phase === 'planner'` branch reruns `dispatchGoal` for the same goal; that is a no-op when `_dispatchInFlight` already contains the goal id, but after the dispatch silently exits the in-flight set is empty, so it would correctly re-enter `dispatchGoal('project')`. Whether that actually progresses depends on whether the planner makes new decisions; if the planner keeps trying to restart the same failed card it will hit `failed→active` again.
3. `safeTick` never inspects the card status of `active_card_run.card_id`. It treats `phase: 'executor'` with `current_card_id` set to a `failed` card the same as a healthy in-flight executor — it bails on `_dispatchInFlight.size > 0`, and even when the dispatch is gone (`_dispatchInFlight.size === 0`) it clears `active_card_run` but never resets `_status` in-memory, so `/api/runtime/status.runtime` keeps lying.

There is also no `setInterval` anywhere in [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) — only the `StuckAgentSupervisor` runs on a clock ([src/runtime/stuck-agent-supervisor.ts](../../../src/runtime/stuck-agent-supervisor.ts) line 252), and it does not touch runtime status or `active_card_run`.

## Pause/resume asymmetry

[`RuntimeControl`](../../../src/runtime/control.ts) `pauseRuntimeControl`/`resumeRuntimeControl` succeed end-to-end because the **call site** explicitly mutates both stores in lock-step:

```ts
ctx.activeRuntime.pause();                                 // sets in-memory _paused = true
const runtimeStatus = ctx.activeRuntime.getStatus();
mirrorRuntimeState(ctx.projectRoot, {                      // writes disk
  status: runtimeStatus.status,
  paused: runtimeStatus.paused,
});
```

Pause has a single, blocking operator entrypoint that updates both stores synchronously. Dispatch has many code paths, each of which writes disk-only and never touches `_status`. The asymmetry is structural: runtime state has two mutually-inconsistent backing stores, and only the pause/resume path knows to keep them in sync.

A secondary asymmetry: the *clearer* set (8 sites, listed above) writes `status: 'idle'` to disk but no one writes `this._status = 'idle'` to match. Even the "happy path" goal completion (line 660) leaks: a subsequent `/api/runtime/status` between completion and the next `start_project` will report `runtime: 'running'` from in-memory while `currentCardId` is `null` from disk — a contradiction that the dashboard renders as a green idle badge with no card pointer (less visible than F19, but the same root cause).

## Desired contract

For any `t`, given `S = /api/runtime/status` taken at `t`:

> **C1 (liveness).** If `S.runtime ∈ {"running"}` then within `N_C1 = 30s` of `t` at least one of the following becomes true:
> - `S'.currentCardId` is non-null and the referenced card has a non-terminal status (`drafting | backlog | active | running | blocked | changed`), or
> - `S'.runtime` transitions to `"idle"` or `"paused"` or `"frozen"`.
>
> **C2 (consistency).** `S.runtime` and the persisted `RuntimeState.status` agree at all times (no in-memory/disk drift).
>
> **C3 (no pinned terminals).** `S.currentCardId` never references a card whose `status ∈ {done, failed, cancelled}` for longer than one tick (`N_C3 = 5s`).
>
> **C4 (observability).** `/api/runtime/status` exposes `lastTickAt: ISO8601 | null` so an external probe can verify (C1) without polling the side effects.

Terminal statuses are already enumerated as `TERMINAL_STATUSES = {done, failed, cancelled}` in [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) line 83 — the same constant the design will reuse.

## Assumptions not verifiable from code alone

1. The Phase-2 wedge persisted across at least minutes (per G5/T38 observation); the audit did not measure exactly how many planner iterations ran before exit, only that the symptom did not self-clear. The analysis above assumes the dispatch loop did exit (either via MAX_ITERATIONS=50 or via the `failed→active` throw); a "still spinning planner" interpretation is also consistent with the evidence and would have the same external symptom but a different fix surface (the planner-loop quotas would need tightening).
2. The exact stack trace for `Invalid transition: failed → active` was logged to `errors.jsonl` but the audit captured only the message ([F23](../F23-invalid-failed-active/00-issue.md)); we are assuming the call originates from line 706 `setStatus(card.id, 'running')` inside `dispatchPendingActivations`. An alternative caller is the planner's tool-call surface (`activate_card` tool resolution), which would also throw at the store boundary; either way the fix surface is the same (route recovery through `backlog`, never re-`activate` a `failed` card).
3. We assume the operator does have working `card.restart` available — i.e. that an explicit operator-initiated restart correctly goes `failed → backlog → active → running`. The permission matrix in [src/permissions/card-permissions.ts](../../../src/permissions/card-permissions.ts) confirms `card.restart` is allowed for both `operator` and `planner` on `failed`, but the actual restart implementation was not traced for this analysis; the design assumes restart works and only the *automatic* path is broken.
4. We assume `/api/runtime/status` consumers (the Vue dashboard, the e2e harness) only read the four documented fields and will tolerate one additive field (`lastTickAt`). This was true at Phase 2; a contract-level addition is the safer surface change.
