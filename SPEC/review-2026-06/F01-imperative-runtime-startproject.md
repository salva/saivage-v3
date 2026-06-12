# F01: SupervisorRuntimeApi.startProject is synchronous-imperative, not reactive

## Summary

`SupervisorRuntimeApi.startProject()` (supervisor-runtime-api.ts:75-143) is a single synchronous-imperative method that creates a `GoalCardRunnerController`, calls `runner.start()`, and awaits the result. It blocks the caller until the entire planning-execution-review tree completes. This is not a reactive/runtime-orchestrated design -- it is a batch call that monopolizes the event loop.

## Evidence

- `src/runtime/actors/supervisor-runtime-api.ts:129`: `const outcome = await runner.start(...)` -- the full goal card lifecycle runs to completion inside `startProject`.
- `src/runtime/actors/goal-card-runner.ts:142-201`: `start()` contains a `for` loop (turn budget 20) that runs planner turns, review, and child activation end-to-end.
- `src/runtime/actors/card-runner.ts:95-148`: `start()` contains a `for` loop (turn budget 10) that runs executor turns end-to-end.
- No cancellation/abort path is wired to the XState supervisor's `stopping` mode. If the supervisor is paused/stopped while `startProject` is in-flight, the `GoalCardRunner` keeps running until it completes or exhausts its turn budget.

## Category

Architectural / bad assumption

## Severity

5 -- the XState machines model running/paused/stopping states, but the actual execution bypasses them entirely by using imperative `for` loops with `await`. The supervisor's mode and admission port are checked at the start of each LLM call but not between child activations or reviewer turns. The XState state machine transitions are side effects of imperative calls, not the driving mechanism.

## Transversality

Cross-cutting (affects all actor runners and the runtime API surface)