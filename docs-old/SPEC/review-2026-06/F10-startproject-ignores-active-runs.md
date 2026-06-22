# F10: SupervisorRuntimeApi.startProject ignores active runs and goal tree state

## Summary

`startProject()` (supervisor-runtime-api.ts:75-143) creates a `GoalCardRunnerController` for the project card and calls `runner.start()`, but it never checks whether there are existing active runs, cards in the backlog, or child goals. It does not restore any previous planner session or run state. The `recoveryPlan` is built at startup (line 55) but never used to seed `GoalCardRunnerController` or restore running actors. The entire previous session state is abandoned.

## Evidence

- `src/runtime/actors/supervisor-runtime-api.ts:55`: `this.recoveryPlan = buildActorRecoveryPlan(...)` -- recovery plan is computed but never consumed. `getRecoveryPlan()` (line 172-174) just returns it for external reading.
- `src/runtime/actors/supervisor-runtime-api.ts:116-128`: `GoalCardRunnerController` is created fresh with `publicStatus: undefined` (defaults to `'backlog'`), ignoring any persisted card state.
- `src/runtime/actors/goal-card-runner.ts:60`: `publicStatus: input.publicStatus ?? 'backlog'` -- default is backlog, but recovery should restore the saved public status.

## Category

Half-implemented / bad assumption

## Severity

4 -- After a server restart, the XState runtime will start a brand-new goal card run from scratch instead of resuming from the persisted card state. This means any in-progress planning, execution, or review work is lost on restart.

## Transversality

Cross-cutting (supervisor-runtime-api, goal-card-runner, actor-recovery)