# Activation Ledger Invariant Tightening Plan

Date: 2026-06-07

Status: revised implementation plan

## Purpose

Tighten Saivage v3 runtime activation handling around a simpler premise: the runtime does not support parallel agent execution. A child activation cannot legitimately complete after its parent planner run has closed in normal runtime flow. If that state appears, it is corrupted ledger state, crash-recovery fallout, a lifecycle interruption, or a bug.

The current interim fix restores a parent planner active run when a child activation completes and falls back to `idle` if no parent planner run is found. That fallback prevented false I2 invariant errors, but it is architecturally too permissive for normal execution. This plan replaces permissive fallback with fail-closed ledger invariants and confines repair behavior to startup/crash/operator recovery paths.

## Current Model

Saivage v3 persists three runtime concepts that together describe execution:

- `RuntimeState.active_card_run`: the single current active runtime frame.
- `RuntimeState.runtime_runs[]`: the runtime run ledger, including root, child, planner, executor, and reviewer phases.
- `RuntimeState.runtime_activations[]`: the activation ledger, including `parent_run_id`, `parent_session_id`, `parent_tool_call_id`, and `child_card_id`.

Although `active_card_run` is a flat pointer, `runtime_activations.parent_run_id` plus `runtime_runs` already encode the active call chain. Because execution is sequential, the active leaf and its parent continuation have deterministic ownership.

Normal child activation completion is a stack pop:

1. The completed child run becomes terminal in `runtime_runs`.
2. The activation record becomes terminal in `runtime_activations`.
3. If the child was `active_card_run`, the parent planner run referenced by `parent_run_id` must still be open.
4. Runtime state switches directly from child active run to parent planner active run.
5. The parent planner receives the activation completion tool result and continues.

The runtime should not pass through a normal idle state between steps 3 and 4.

## Architectural Conclusion

Do not add a new explicit activation stack. The existing activation and run ledgers are already the stack. Adding a fourth persisted structure would create another source of divergence and would be harder to reconcile after interruption. The better architecture is to make the existing ledger relationships authoritative and reject impossible states.

The correct invariant is:

```text
If completeActivation(childCardId) completes an unresolved activation A,
and active_card_run.card_id == childCardId,
then A.parent_run_id must reference an open planner runtime run for A.parent_card_id.
```

If that invariant fails during normal runtime mutation, the mutation should throw rather than silently falling back to idle.

## Code Audit: What Handles Impossible States Today

### Normal-path idle fallback in `reduceActivationCompletion`

File: `src/runtime/runtime-core.ts`

`findParentPlannerRunForResumption()` returns `null` when no matching ledger entry exists. `reduceActivationCompletion` then falls back to `{ status: 'idle', active_card_run: null }`.

Under sequential execution this should be impossible: the parent planner run is open when the child activation was created and nothing closes it until the parent's own invocation completes. The null fallback masks a ledger inconsistency or a bug.

**Verdict:** Remove the fallback. If `findParentPlannerRunForResumption` returns null for an active child, throw `RuntimeStateInvariantError`.

### Executor invocation failure clears `active_card_run`

File: `src/runtime/executor-activation-dispatcher.ts`

`handleExecutorInvocationFailure` calls `clearActiveCardRun(cardId)` which clears `active_card_run` to idle. This happens when an LLM invocation fails after the executor card has already been activated and `active_card_run` set.

Currently this clears to idle without restoring the parent planner, then relies on `maybeRedispatchProjectRoot` to eventually re-discover the goal. Under sequential execution, the parent planner should be directly restorable from the activation ledger.

**Verdict:** Replace `clearActiveCardRun` in this path with activation completion unwinding to the parent planner, same as a successful completion. The executor still fails, but the parent planner should resume to decide what to do next.

### Activation barrier compensation clears `active_card_run`

File: `src/agents/activation-barrier-compensation.ts`

When activation dispatch throws, this compensates by:
1. Appending a tool error to the planner's `activate_card` call.
2. Completing the activation as `failed`.
3. Clearing `active_card_run`.

Step 2 already triggers `reduceActivationCompletion` which (with the current fix) will attempt to restore the parent. Step 3 then immediately overwrites that restoration with idle, making step 2's parent restoration pointless.

**Verdict:** Remove step 3. The `completeActivation` mutation in step 2 already handles `active_card_run`. The separate clear is redundant and harmful once `completeActivation` owns the parent restoration.

### I1/I2 invariant auto-correction on tick

File: `src/runtime/runtime-core.ts`, `observeRuntimeStateInvariants()`

These soft-correct every 5 seconds. I1 corrects `running` + `active_card_run: null` to `idle`. I2 corrects a terminal `active_card_run.card_id` to `idle`.

With strict activation completion, I1 and I2 should never fire during normal execution. They still serve as startup-recovery safety nets, but their corrections should be reviewed:

- I1 correction `{ status: 'idle' }` when `running` + null active run: this can fire during the brief window between child completion (parent not yet restored) if there is a tick between the `reduceActivationCompletion` and the next state write. With atomic mutation, this window should not exist. Keep as a safety net but do not rely on it for normal flow.
- I2 correction `{ status: 'idle', active_card_run: null }` when active card is terminal: this should never fire after the strict `reduceActivationCompletion` fix, because the parent is now restored instead of leaving a terminal card as active. Keep as a safety net.

**Verdict:** Keep I1/I2 as tick-based safety nets. Do not add I9. If `reduceActivationCompletion` throws on missing parent, the state never reaches the tick observer in that impossible configuration.

### `planIdleRunningRootRunReconciliation` 

File: `src/runtime/runtime-core.ts`

Only called from `startup-run-reconciliation.ts`. Properly scoped to startup. No change needed, but add a comment noting it is startup-recovery-only.

### `parentPlannerRunFor` card-hierarchy reconstruction

File: `src/runtime/activation-unwind.ts`

Only called from `startup-repair.ts` via `ActivationRepairRunner`. Properly scoped to startup repair. No rename needed.

**Verdict:** No change. The function is correctly not called from normal runtime paths.

### `planProjectRootRedispatch`

File: `src/runtime/runtime-core.ts`

Called on every tick from `state-machine.ts`. This is a legitimate recovery mechanism for cases where the runtime intent says running but no active card run exists (e.g., after crash recovery). It is not the normal continuation path. No change needed, but the existing parent restoration makes it less necessary for ordinary child completion.

**Verdict:** Keep. It remains a useful safety net for true recovery scenarios. Normal child-to-parent continuation no longer depends on it.

## Simplified Design

### 1. Make `reduceActivationCompletion` fail closed on missing parent

File: `src/runtime/runtime-core.ts`

Current behavior:

```ts
const parentPlannerRun = findParentPlannerRunForResumption(currentState, completedActivation);
if (parentPlannerRun) {
  activeCardRunPatch = { status: 'running', active_card_run: parentPlannerRun };
} else {
  activeCardRunPatch = { status: 'idle', active_card_run: null };
}
```

New behavior:

```ts
const parentPlannerRun = findParentPlannerRunForResumption(currentState, completedActivation);
if (parentPlannerRun) {
  activeCardRunPatch = { status: 'running', active_card_run: parentPlannerRun };
} else if (completedActivation?.parent_card_id) {
  throw new RuntimeStateInvariantError(
    `Activation ${completedActivation.activation_id} for child ${childCardId} ` +
    `completed but parent planner run for ${completedActivation.parent_card_id} ` +
    `not found in runtime_runs. Under sequential execution the parent ` +
    `planner run must be open when the child activation completes.`
  );
}
// No parent_card_id means this is a root-level or orphan activation;
// falling back to idle is correct.
```

This ensures:
- Normal path: parent is always found, restored as active run.
- Missing parent runtime state: throws with a clear diagnostic message.
- Parentless activations are not supported. `RuntimeActivationRecord` requires `parent_card_id`, `parent_run_id`, `parent_session_id`, and `parent_tool_call_id` in both TypeScript and the Zod runtime schema, so `completeActivation` should not preserve a root-level fallback branch.
- Startup repair paths do not use `reduceActivationCompletion`; they use `mergeRuntimeStateSnapshot` and direct state patching, so they are unaffected.

### 2. Remove `planClearActiveCardRunPatch` from activation barrier compensation

File: `src/agents/activation-barrier-compensation.ts`

Current flow:

```ts
applyRuntimeMutation(config.projectRoot, { kind: 'completeActivation', ... });
const clearPatch = planClearActiveCardRunPatch({ state: readRuntimeState(...), cardId });
if (clearPatch) applyRuntimeMutation(config.projectRoot, { kind: 'patchRuntimeState', patch: clearPatch });
```

New flow:

```ts
applyRuntimeMutation(config.projectRoot, { kind: 'completeActivation', ... });
```

The `completeActivation` mutation already handles `active_card_run` restoration through `reduceActivationCompletion`. The separate clear is redundant and harmful because it overwrites the parent restoration with idle.

### 3. Replace `clearActiveCardRun` with parent restoration in executor invocation failure

File: `src/runtime/executor-activation-dispatcher.ts`
File: `src/runtime/phases/executor-invocation-failure.ts`

Current behavior: `clearActiveCardRun(cardId)` clears `active_card_run` to idle when executor invocation fails.

New behavior: Instead of clearing to idle, complete the activation as `failed` (which already happens for terminal executor cards via `commitExecutorInvocationFailure`). The activation completion reducer will then restore the parent planner.

If the executor card was never actually activated (activation dispatch itself failed), then there is no `active_card_run` to clear and no activation to complete. In that case, the barrier compensation path in step 2 handles the tool result for the planner.

Implementation approach:
- Remove `clearActiveCardRun` from the `handleExecutorInvocationFailure` effects port.
- The executor failure already transitions the card to `failed` and may complete the activation. If the card was activated and `active_card_run` points at it, the activation completion path will restore the parent.
- If the executor failed before activation, `active_card_run` still points at the child or was never set; either way, the planner will see the error through its tool result.

### 4. Rename `planClearActiveCardRunPatch` to `planClearActiveCardRunForRepair`

File: `src/runtime/runtime-core.ts`

Rename to signal that this helper is for repair/interruption paths only. Audit remaining callers:

- `src/runtime/startup-blocked-planning.ts` — startup repair. Keep.
- Session sweep (`planSweptCurrentAgentSessionPatch`) — startup repair. Keep.

All normal-runtime callers should be removed per steps 2 and 3. If any remain, they indicate an unfinished migration.

### 5. Add a comment to `planIdleRunningRootRunReconciliation`

File: `src/runtime/runtime-core.ts`

Add a doc comment noting this function is startup-recovery-only and should not be called from normal live execution paths.

### 6. No new invariant ID needed

The plan originally proposed I9. After auditing, I9 is redundant: `reduceActivationCompletion` will throw before the state reaches the tick observer. I1 and I2 remain as tick-based safety nets for states that leak in through other paths or through crash recovery.

### 7. No mutation mode flag needed

The plan originally proposed `mode: 'normal' | 'repair'` on `completeActivation`. After auditing, repair paths do not call `reduceActivationCompletion` at all — they use `mergeRuntimeStateSnapshot` and direct state patching. There is no shared code path that needs to distinguish modes. Making `reduceActivationCompletion` throw on invalid state is sufficient.

## Code Paths That No Longer Handle Impossible States

### `reduceActivationCompletion()` fallback-to-idle

**Removed.** When `active_card_run.card_id` matches the completed child, the completion must identify exactly one unresolved activation with a valid parent ledger edge and the parent run must be found. If not, throw. Root-level or parentless activations are invalid by schema and must not fall back to idle.

### `activation-barrier-compensation.ts` clear-after-complete

**Removed.** The separate `planClearActiveCardRunPatch` call after `completeActivation` is redundant. `completeActivation` owns active-run unwinding.

### `executor-invocation-failure.ts` clear-to-idle

**Replaced.** Executor failure no longer clears `active_card_run` to idle. If the executor card was activated and has an activation, the activation completion path restores the parent planner. If it was never activated, there is nothing to clear.

### `planClearActiveCardRunPatch` as generic utility

**Renamed** to `planClearActiveCardRunForRepair`. Only called from startup repair and session sweep. Normal runtime code no longer calls it.

## What Stays

### I1/I2 invariant observers

Keep. They are tick-based safety nets. With strict `reduceActivationCompletion`, they should fire even less frequently, but they catch states that leak through crash recovery, manual state editing, or other code paths.

### `parentPlannerRunFor()` card-hierarchy reconstruction

Keep as-is. Only called from startup repair. Already properly scoped.

### `planProjectRootRedispatch()`

Keep. It remains a useful recovery mechanism. Normal child-to-parent continuation no longer depends on it.

### `planIdleRunningRootRunReconciliation()`

Keep. Add doc comment noting it is startup-recovery-only.

### `planClearActiveCardRunForRepair` (renamed from `planClearActiveCardRunPatch`)

Keep for startup repair and session sweep callers only.

## Implementation Steps

### Step 1: Make `reduceActivationCompletion` fail closed

- Replace the fallback-to-idle with a throw when no matching parent run is found.
- Remove any parentless/root-level activation branch from the reducer.
- Add tests: active child with parent restores parent; active child with missing parent throws; missing/duplicate transitioning activation throws.

### Step 2: Remove barrier compensation clear

- Remove the `planClearActiveCardRunPatch` call from `activation-barrier-compensation.ts`.
- Add test that barrier compensation does not override parent restoration.

### Step 3: Replace executor failure clear with parent restoration

- Remove `clearActiveCardRun` from `handleExecutorInvocationFailure` effects.
- Ensure executor failure path completes the activation (which restores parent).
- Add test that executor failure restores parent planner active run.

### Step 4: Rename `planClearActiveCardRunPatch` to `planClearActiveCardRunForRepair`

- Rename the function.
- Update all callers (should only be startup repair and session sweep at this point).
- Add a deprecation-style comment if any normal-runtime callers remain.

### Step 5: Add doc comments to startup-recovery functions

- `planIdleRunningRootRunReconciliation`: note it is startup-recovery-only.
- `planClearActiveCardRunForRepair`: note it is for repair/interruption paths only.

### Step 6: Validation

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime/runtime-core.test.ts --runInBand --forceExit
npm run typecheck
npm run validate:routine
npm run build
```

Rebuild and redeploy if the GetRich v2 service is affected.

## Acceptance Criteria

- Normal child activation completion never produces `idle` when an open parent planner run exists.
- Normal child activation completion throws if the parent run is missing from the ledger.
- Parentless/root-level activation completion is not supported and throws.
- No normal-runtime path calls `planClearActiveCardRunForRepair`.
- Repair paths (startup, session sweep) still clear `active_card_run` correctly.
- Executor failure and activation barrier failure restore the parent planner instead of going idle.
- I1/I2 invariant observers remain as tick-based safety nets.
- No new invariant ID is needed.
- No mutation mode flag is needed.

## Non-Goals

- Do not implement parallel agent execution.
- Do not add a new persisted activation stack.
- Do not add a mutation mode flag on `completeActivation`.
- Do not add I9.
- Do not rename `parentPlannerRunFor` (already correctly scoped to startup repair).
- Do not create a separate `repairCompleteActivation` mutation.
- Do not change session lifecycle to match `active_card_run`.
