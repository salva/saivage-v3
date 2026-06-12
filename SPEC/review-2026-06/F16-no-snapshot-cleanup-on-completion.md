# F16: No actor snapshot cleanup on goal/terminal card completion

## Summary

When a `GoalCardRunnerController` or `TerminalCardRunnerController` completes (calling `this.complete()` or `this.fail()`), it persists a final snapshot via `this.persist()` but never removes that snapshot. Over time, `.saivage/runtime/actors/` accumulates actor snapshots for completed cards that will never be used again. `removeActorSnapshot` exists in `snapshots.ts:64-72` but is never called from any runner controller.

## Evidence

- `src/runtime/actors/goal-card-runner.ts:244-249`: `complete()` calls `this.persist()` and then `this.statusPort?.commitGoalOutcome()`, but never calls `removeActorSnapshot`.
- `src/runtime/actors/card-runner.ts:150-160`: `fail()` calls `this.persist()` and `this.statusPort?.commitTerminalOutcome()`, but never calls `removeActorSnapshot`.
- `src/runtime/actors/snapshots.ts:64-72`: `removeActorSnapshot(projectRoot, actorId)` is available but unused.
- `actor-recovery.ts` reads all snapshots on startup, potentially loading stale completed-card data.

## Category

Resource leak / over-retention

## Severity

2 -- snapshots are small JSON files, but in a long-running system they accumulate without bound. Recovery scans will load and process completed-card snapshots unnecessarily.

## Transversality

Local (goal-card-runner.ts, card-runner.ts, snapshots.ts)