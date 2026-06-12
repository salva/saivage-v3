# F04: GoalCardRunner.start() has no cancellation path while supervisor is paused/stopping

## Summary

Once `GoalCardRunnerController.start()` begins its planner-review-activation loop (lines 134-204), there is no mechanism to interrupt it if the runtime is paused or the supervisor enters `stopping` mode. The `admission` port checks provider call admission at the start of each LLM turn, but child activations and reviewer turns proceed unchecked. The `CANCEL` event is only processed via `this.actor.send()` as a state recording, and `cancel()` is a separate method that is never called within `start()`.

## Evidence

- `src/runtime/actors/goal-card-runner.ts:142-201`: The `for` loop has no check for supervisor mode changes between iterations. After each `await this.plannerRunner.runTurn()`, child activation, or `await this.reviewPlannerResult()`, the loop continues regardless of supervisor state.
- `src/runtime/actors/runtime-supervisor.ts:90-96`: `requestProviderCall` checks `this.work !== 'ready' || this.mode !== 'running'`, but this is only called inside `LlmRunnerController.runTurn()`. Between LLM turns, no pause/stop check exists.
- `src/runtime/actors/card-runner.ts:95-148`: Same pattern -- the `for` loop in `CardRunner.start()` has no pause/stop check between executor turns.

## Category

Bad assumption / correctness

## Severity

5 -- a paused or stopping runtime will keep executing planner and executor turns until the turn budget is exhausted (up to 20 planner turns or 10 executor turns). This makes graceful shutdown or pause impossible during active execution.

## Transversality

Cross-cutting (goal-card-runner, card-runner, supervisor-runtime-api)