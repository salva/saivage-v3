# F06: ActiveGoalNoteSinks is a process-global singleton map with no lifecycle management

## Summary

`active-goal-note-sinks.ts` uses a module-level `registries` Map (`new Map<string, ActiveGoalNoteSinks>()`) that is never cleaned up on shutdown. In the `GoalCardRunnerController.start()` method, `getActiveGoalNoteSinks(this.actor.getSnapshot().context.projectRoot)` is called and `noteSinks.register()` / `noteSinks.unregister()` are called in try/finally, but if the process crashes between register and unregister, the sink remains in the global map indefinitely.

## Evidence

- `src/runtime/actors/active-goal-note-sinks.ts:30-31`: `const registries = new Map<string, ActiveGoalNoteSinks>();` -- this is a process-global singleton.
- `src/runtime/actors/goal-card-runner.ts:138-139,203`: `noteSinks.register(this.cardId, this.this)` and `noteSinks.unregister(this.cardId, this)` in try/finally.
- `clearActiveGoalNoteSinks(projectRoot)` exists (line 41) but is only called in tests. No production code calls it on shutdown.

## Category

Bad abstraction / memory leak

## Severity

3 -- the registries grow unboundedly in long-running processes, and stale entries from crashed runs may cause note delivery to dead sinks. However, in current deployment the process restarts between runs.

## Transversality

Local (active-goal-note-sinks.ts, goal-card-runner.ts)