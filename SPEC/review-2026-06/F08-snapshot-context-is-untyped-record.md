# F08: Snapshot context type is `Record<string, unknown>` -- all type safety is lost on persistence boundary

## Summary

Every actor snapshot (supervisor, card, LLM, process) stores `context` as `Record<string, unknown>` in `ActorSnapshotRecord` (snapshots.ts:14). This means the typed context objects (`GoalCardRunnerContext`, `TerminalCardRunnerContext`, `LlmRunnerContext`, `RuntimeSupervisorContext`) lose all type information when persisted. On recovery, `actor-recovery.ts` accesses `snapshot.context.publicStatus` and `snapshot.context.state_value` as untyped reads. The `GoalCardRunnerController.snapshot()` method casts context via `snapshot.context as unknown as Record<string, unknown>` (goal-card-runner.ts:237).

## Evidence

- `src/runtime/actors/snapshots.ts:14`: `context: z.record(z.unknown())` in the Zod schema.
- `src/runtime/actors/goal-card-runner.ts:234-241`: `context: { ...(snapshot.context as unknown as Record<string, unknown>), noteBox: {...} }`.
- `src/runtime/actors/actor-recovery.ts:71`: `snapshot.context.publicStatus === 'running'` -- untyped access on a `Record<string, unknown>` value.

## Category

Bad abstraction / type safety

## Severity

3 -- recovery from snapshots is untyped, so any schema change to actor context will silently break recovery without a type error. The Zod schema only validates that context is `Record<string, unknown>`, providing no structural validation.

## Transversality

Cross-cutting (snapshots.ts, actor-recovery.ts, all runner controllers' snapshot() methods)