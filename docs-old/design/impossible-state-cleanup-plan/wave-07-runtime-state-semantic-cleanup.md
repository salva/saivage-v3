# Wave 7: Runtime State Semantic Cleanup

Findings covered: C22 and final cross-wave cleanup.

## Objective

Make `active_card_run` semantically current-only and remove any remaining terminal active-run persistence from idle runtime state.

## Current Problem

Persistence currently permits idle runtime with terminal active-run records. Source reference: `src/runtime/state.ts#L55-L80`.

This is not as severe as non-terminal active runs while idle, which already throw. The semantic problem is that `active_card_run` sounds like current work, while terminal active-run history belongs in `runtime_runs`.

## Architecture Decision

`active_card_run` means current active work only. Therefore:

- `status: 'idle'` requires `active_card_run: null`
- terminal run history lives in `runtime_runs`
- command history and events provide audit trail
- no terminal active-run snapshot is retained as current state

## Implementation Design

### Step 1: Tighten Runtime State Invariant

Change `src/runtime/state.ts#L55-L80` so idle plus any non-null `active_card_run` throws.

Remove `TERMINAL_IDLE_ACTIVE_RUN_STATUSES` unless it is still needed elsewhere.

### Step 2: Audit Idle Transitions

Audit all reducers/transitions that set `status: 'idle'`:
- goal/card termination
- reviewer finished
- project completion
- stop/cancel/pause flows
- startup reconciliation

Every idle transition must set `active_card_run: null` and ensure terminal details are copied into `runtime_runs` before clearing.

Known sites to include in the audit:
- `src/runtime/runtime-core.ts#L342-L351` (`reduceRuntimeEvent` terminal events)
- `src/runtime/runtime-core.ts#L247-L254` (`buildShutdownRuntimeStatePatch`)
- `src/runtime/runtime-core.ts#L224-L235` (`planClearActiveCardRunForRepair`)
- `src/runtime/runtime-core.ts#L237-L245` (`planSweptCurrentAgentSessionPatch`)
- `src/runtime/runtime-core.ts#L542-L597` (`planIdleRunningRootRunReconciliation`)
- `src/runtime/startup-repair.ts#L119-L131` (`buildBlockedPlannerStartupState`)

Before implementing this wave, verify no path sets `status: 'idle'` in one mutation and clears `active_card_run` in a later mutation. The status and active-run change must be atomic.

### Step 3: Align Runtime Status Read Models

Operator state, health/ready state, and debug state should treat non-null `active_card_run` as active current work. They should not need to special-case terminal active runs.

Freeze/resume must follow the same semantics. `buildResumeFromFreezeRuntimeStatePatch()` must not restore a terminal active run as current work. If a freeze manifest contains a terminal active run, startup/resume should either clear it after preserving run history or fail with a runtime-state invariant error.

### Step 4: Remove Remaining Compatibility Tests

Delete tests that expect idle plus terminal active run to be accepted. Replace with tests that assert it throws.

## Tests

Add/update:

- `saveRuntimeState()` throws for idle plus stopped/cancelled active run
- all normal idle transitions clear `active_card_run`
- runtime read models do not special-case terminal active run snapshots
- startup reconciliation preserves terminal details in `runtime_runs` before clearing active snapshot
- freeze/resume does not restore terminal `active_card_run` as current work
- persisted idle plus terminal `active_card_run` fails startup or is cleared by an explicit startup repair path

Focused command:

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/utils/runtime-state-invariant.test.ts tests/runtime/runtime-reducers.test.ts tests/runtime/transition-policy.test.ts --runInBand --forceExit
```

## Validation

```bash
npm run typecheck
npm test
npm run validate:docs
npm run build
```

## Stop Criteria

Wave 7 is complete when `active_card_run` has one meaning: current work only. Idle runtime with any active-run snapshot is invalid.
