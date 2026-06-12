# F13: GoalCardRunner.start does not clean up its LlmRunnerController instances on failure

## Summary

In `GoalCardRunnerController.start()`, if an exception is thrown during planner review or child activation (lines 142-204), the `finally` block at line 203 only unregisters the note sink. It does not clean up the `plannerRunner` or `reviewerRunner` instances. These controllers hold XState actors that persist snapshots and may have pending file handles. More critically, the `ProcessRunnerController` instances created by `TerminalCardRunnerController` (stored in `this.processes`) are never cleaned up when the runner finishes or fails.

## Evidence

- `src/runtime/actors/goal-card-runner.ts:142-204`: `try { ... } finally { noteSinks.unregister(...); }` -- no cleanup of `this.plannerRunner` or `this.reviewerRunner`.
- `src/runtime/actors/card-runner.ts:80`: `private readonly processes = new Map<string, ProcessRunnerController>()` -- this map grows with each `run_process` call and is never cleaned. The `ProcessRunnerController` class has a XState actor that is never stopped.

## Category

Resource leak / bad assumption

## Severity

3 -- XState actors are lightweight, but ProcessRunnerController spawns child processes. The `processes` map retains references to completed processes, and the XState actors inside planners/reviewers are never explicitly stopped.

## Transversality

Local (goal-card-runner.ts, card-runner.ts)