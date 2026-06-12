# Runtime Review Metaplan — 2026-06

## Batching Strategy

Batches are ordered by transversality (foundational first) and then by severity within each batch.

## Batch A: Delete Dead/Legacy Code (F03, F11, F17)

**Scope**: Remove unused production modules and legacy interface files.

**Files**:
- Delete `src/runtime/agent-runtime-factory.ts`
- Delete `src/runtime/candidate-availability-store.ts`
- Delete `src/runtime/crash-recovery.ts`
- Delete `src/runtime/persisted-planner-history.ts`
- Delete `src/runtime/runtime-diagnostics.ts`
- Delete `src/runtime/session-persistence-port.ts`
- Trim or delete legacy shapes from `src/runtime/runtime-config.ts` (`RuntimeAssembly`, `RuntimeCoreParts`, `RuntimeTestAssemblyParts`, `StuckAgentSupervisor` import)
- Assess whether `src/runtime/stuck-agent-supervisor.ts` is wired anywhere in current runtime-composition; if not, delete it too.

**Validation**: `npm run typecheck && npm test && npm run validate:routine`

**Rollback**: Revert the commit.

## Batch B: Hardened Tool Dispatch and Tool-Name Coupling (F12, F15)

**Scope**: Extract shared tool-name constants and argument parsing.

**Files**:
- Create `src/runtime/actors/tool-names.ts` with constants for `'activate_card'`, `'run_process'`, `'wait_process'`, `'inspect_process'`, `'kill_process'`.
- Add Zod-based arg parsing functions that reuse the parameter schemas from `actor-tool-definitions.ts`.
- Update `goal-card-runner.ts` and `card-runner.ts` to use constants and new parsers.

**Validation**: `npm run typecheck && npm test`

**Rollback**: Revert the commit.

## Batch C: Reactive Execution Loop/Cancellation (F01, F04) — Design-level

**Scope**: This is an architectural change that requires design before implementation. The current `for` loop / `await` pattern in `start()` methods needs to be replaced with an event-driven or iterator-based approach that checks supervisor mode between iterations.

**Design options**:
1. **Iterator approach**: Convert the `for` loops to async generators that yield after each turn, with a cooperative cancellation check (`if (this.supervisor.mode !== 'running') break`).
2. **Event-driven approach**: Restructure `start()` to return a cancellable promise and send XState events that actually drive transitions, making the machine the execution driver.
3. **Minimal fix**: Insert `if (this.supervisor.mode !== 'running') { await this.cancel(); return this.complete(...); }` checks at the top of each loop iteration in both runners.

**Recommendation**: Start with option 3 (minimal cooperative cancellation check) as it is the least risky and addresses the most critical correctness issue. Options 1 and 2 can be considered for a future iteration.

**Files**:
- `src/runtime/actors/goal-card-runner.ts`
- `src/runtime/actors/card-runner.ts`

**Validation**: `npm run typecheck && npm test && npm run validate:routine`

## Batch D: Reviewer Response Robustness (F05)

**Scope**: Replace brittle string matching with tool-call-based reviewer protocol or at minimum add case-insensitive/whitespace-tolerant matching.

**Files**:
- `src/runtime/actors/goal-card-runner.ts:262-283`

**Validation**: `npm run typecheck && npm test`

## Batch E: Status and Activity Reporting (F09, F14)

**Scope**: Make `getStatus()` and `getActivityStatus()` return meaningful data from the XState actor state.

**Files**:
- `src/runtime/actors/supervisor-runtime-api.ts:157-170`
- Wire `goalCount` to actual goal card count from the card store.
- Implement `getActivityStatus()` using session/LLM runner state.

**Validation**: `npm run typecheck && npm test`

## Batch F: Snapshot Type Safety and Cleanup (F08, F16)

**Scope**: Add Zod schemas for actor context shapes and clean up completed-card snapshots.

**Files**:
- `src/runtime/actors/snapshots.ts`: Add context schema variants per actor kind.
- `src/runtime/actors/goal-card-runner.ts`: Remove snapshot on completion.
- `src/runtime/actors/card-runner.ts`: Remove snapshot on completion.

**Validation**: `npm run typecheck && npm test`

## Batch G: ActiveGoalNoteSinks Lifecycle (F06)

**Scope**: Add shutdown cleanup and make the sink map scoped to runtime lifecycle.

**Files**:
- `src/runtime/actors/active-goal-note-sinks.ts`: Add cleanup on `shutdown()`, ensure `SupervisorRuntimeApi.shutdown()` calls it.

**Validation**: `npm run typecheck && npm test`

## Batch H: Actor ID Robustness (F07)

**Scope**: Add an `actorKind` field to `ActorSnapshotRecord` and validate it on read, instead of deriving kind from ID prefix.

**Files**:
- `src/runtime/actors/ids.ts`: Make `actorKindFromId` a fallback for legacy IDs, preferring stored `actor_kind`.
- `src/runtime/actors/snapshots.ts`: Already validates `actor_kind` against `actorKindFromId`; tighten the error message.

**Validation**: `npm run typecheck && npm test`

## Batch I: Runner Resource Cleanup (F13)

**Scope**: Add `dispose()` methods to `GoalCardRunnerController` and `TerminalCardRunnerController` that stop XState actors and clean up process handles.

**Files**:
- `src/runtime/actors/goal-card-runner.ts`
- `src/runtime/actors/card-runner.ts`

**Validation**: `npm run typecheck && npm test`

## Batch J: startProject Recovery (F10) — Design-level

**Scope**: This is a feature-level design question. The current `startProject` creates a fresh `GoalCardRunnerController` from scratch. To support restart recovery, it needs to:
1. Read the actor recovery plan on `startProject`.
2. Restore `GoalCardRunnerController` / `TerminalCardRunnerController` instances with persisted state.
3. Only dispatch new turns for active actors.

This is a significant design change that should be specified before implementation.

**Files**:
- `src/runtime/actors/supervisor-runtime-api.ts`
- `src/runtime/actors/actor-recovery.ts`
- `src/runtime/actors/goal-card-runner.ts`
- `src/runtime/actors/card-runner.ts`

**Validation**: Full integration test suite.

## Priority Order

1. **Batch A** (dead code deletion) — Low risk, high clarity, reduces confusion.
2. **Batch B** (tool name constants) — Low risk, immediate robustness gain.
3. **Batch C** (cooperative cancellation) — Critical correctness, minimal change approach.
4. **Batch D** (reviewer parsing) — Important robustness, isolated change.
5. **Batch E** (status reporting) — Important for operator visibility.
6. **Batch F** (snapshot types/cleanup) — Type safety and resource hygiene.
7. **Batch G** (note sinks lifecycle) — Resource hygiene.
8. **Batch H** (actor ID robustness) — Defense in depth.
9. **Batch I** (runner cleanup) — Resource hygiene.
10. **Batch J** (recovery design) — Feature-level, needs design doc first.

Batches B-D and E-I can be parallelized within their dependency constraints (Batch B is independent; C depends on nothing; D-I are independent of each other).