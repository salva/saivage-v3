# Activation Ledger Invariant Tightening Plan

Date: 2026-06-07

Status: proposed implementation plan

## Purpose

Tighten Saivage v3 runtime activation handling around a simpler premise: the runtime does not support parallel agent execution. A child activation cannot legitimately complete after its parent planner run has closed in normal runtime flow. If that state appears, it is not a race to tolerate; it is corrupted ledger state, crash-recovery fallout, a lifecycle interruption, or a bug.

The current interim fix restores a parent planner active run when a child activation completes and falls back to `idle` if no parent planner run is found. That fallback prevented false I2 invariant errors, but it is architecturally too permissive for normal execution. This plan replaces permissive fallback with fail-closed ledger invariants and confines repair behavior to startup/crash/operator recovery paths.

## Current Model

Saivage v3 persists three runtime concepts that together describe execution:

- `RuntimeState.active_card_run`: the single current active runtime frame.
- `RuntimeState.runtime_runs[]`: the runtime run ledger, including root, child, planner, executor, and reviewer phases.
- `RuntimeState.runtime_activations[]`: the activation ledger, including `parent_run_id`, `parent_session_id`, `parent_tool_call_id`, and `child_card_id`.

Although `active_card_run` is a flat pointer, `runtime_activations.parent_run_id` plus `runtime_runs.parent_run_id` already encode the active call chain. Because execution is sequential, the active leaf and its parent continuation have deterministic ownership.

Normal child activation completion should therefore be a stack pop over the existing ledger:

1. The completed child run becomes terminal in `runtime_runs`.
2. The activation record becomes terminal in `runtime_activations`.
3. If the child was `active_card_run`, the parent planner run referenced by `parent_run_id` must still be open.
4. Runtime state switches directly from child active run to parent planner active run.
5. The parent planner receives the activation completion tool result and continues.

The runtime should not pass through a normal `idle` state between steps 3 and 4.

## Architectural Conclusion

Do not add a new explicit activation stack yet.

The existing activation and run ledgers are already the stack. Adding a fourth persisted structure would create another source of divergence and would be harder to reconcile after interruption. The better architecture is to make the existing ledger relationships authoritative and reject impossible states.

The correct invariant is:

```text
If completeActivation(childCardId) completes an unresolved activation A,
and active_card_run.card_id == childCardId,
then A.parent_run_id must reference an open planner runtime run for A.parent_card_id.
```

If that invariant fails during normal runtime mutation, the runtime should record a hard invariant violation and fail the mutation path rather than silently falling back to idle.

## Normal Versus Repair Modes

The implementation must distinguish two modes explicitly.

### Normal Runtime Mode

Used by executor completion, child-goal activation handoff, activation barrier completion, and any live agent-driven `completeActivation` mutation.

Rules:

- Missing parent planner run is impossible.
- Closed parent planner run is impossible.
- Parent run with non-planner phase is impossible.
- Parent run with `runtime_status !== 'running'` is impossible.
- Multiple matching parent planner runs are impossible.
- Runtime must restore the parent active run, not clear to idle.
- Failure should be loud: throw, record a state-machine invariant error, or both.

### Repair Mode

Used only by startup repair, crash recovery, operator stop/shutdown, session sweep, freeze/resume interruption handling, and explicitly named repair utilities.

Rules:

- Missing parent planner run may happen because the service was interrupted between ledger/card/session writes.
- Repair may synthesize tool results, repair orphan activate-card calls, mark cards failed, or clear `active_card_run`.
- Repair must annotate the event as recovery, not as normal scheduling.
- Repair should not reuse normal `completeActivation` semantics unless it passes a mode flag or calls a repair-specific reducer.

## Detailed Design

### 1. Replace permissive parent lookup with strict planning

File: `src/runtime/runtime-core.ts`

Replace `findParentPlannerRunForResumption()` with a stricter planner such as:

```ts
export type ActivationCompletionActiveRunPlan =
  | { kind: 'restore_parent'; activeRun: NonNullable<RuntimeState['active_card_run']> }
  | { kind: 'unchanged' }
  | { kind: 'violation'; invariant: 'I9'; message: string; details: Record<string, unknown> };
```

Suggested function:

```ts
export function planActivationCompletionActiveRun(input: {
  state: RuntimeState;
  childCardId: string;
  transitioningActivations: RuntimeActivationRecord[];
  mode: 'normal' | 'repair';
  nowIso: string;
}): ActivationCompletionActiveRunPlan
```

Normal behavior:

- Return `{ kind: 'unchanged' }` if `active_card_run?.card_id !== childCardId`.
- Require exactly one transitioning activation for the child when the child is active.
- Require that activation to have `parent_run_id`, `parent_card_id`, and `parent_session_id`.
- Require exactly one matching parent runtime run by `run_id === parent_run_id`.
- Require `parentRun.card_id === activation.parent_card_id`.
- Require `parentRun.phase === 'planner'`.
- Require `parentRun.runtime_status === 'running'`.
- Require `!parentRun.finished_at`.
- Build a planner `active_card_run` from the parent run and activation session.
- Return `{ kind: 'restore_parent', activeRun }`.

Repair behavior:

- Permit a missing parent and return a repair-specific result.
- Do not silently share normal fallback behavior.
- Prefer a separate return variant like `{ kind: 'repair_idle'; reason: string }` so callers must acknowledge the abnormal path.

The current fallback to `{ status: 'idle', active_card_run: null }` inside normal `reduceActivationCompletion()` should be removed.

### 2. Add a new invariant ID for activation parent continuity

File: `src/runtime/runtime-core.ts`

Extend `InvariantId` with `I9`:

```ts
export type InvariantId = 'I1' | 'I2' | 'I4' | 'I5' | 'I6' | 'I7' | 'I8' | 'I9';
```

Definition:

```text
I9: An active child activation completion must restore exactly one open parent planner run.
```

This invariant is different from I2:

- I2 detects active run pointing at a terminal card.
- I9 prevents the state mutation that would otherwise create an orphaned parent continuation.

Implementation options:

- Throw `RuntimeStateInvariantError` or a new `RuntimeLedgerInvariantError` from the reducer/mutation path.
- Also append an error log entry via the mutation caller if the reducer returns an invariant violation object rather than throwing.

Preferred minimal implementation:

- Keep `runtime-core.ts` pure by returning a violation plan.
- Make `applyRuntimeMutation()` decide whether to throw or log based on mutation mode.
- In normal mode, throw after appending an error if an error logger is available.

### 3. Split normal completion and repair completion APIs

File: `src/runtime/mutations.ts`

Current mutation:

```ts
{ kind: 'completeActivation'; childCardId; outcome; completedAt; lifecycle? }
```

Replace or extend with explicit mode:

```ts
type CompleteActivationMutation = {
  kind: 'completeActivation';
  mode: 'normal' | 'repair';
  childCardId: string;
  outcome: ActivationCompletionOutcome;
  completedAt: string;
  lifecycle?: CardLifecycleState | null;
};
```

Defaulting `mode` is not recommended. Every caller should declare intent.

Normal callers must pass `mode: 'normal'`:

- `ActivationUnwindRunner.markActivationComplete()` during live executor/child completion.
- Activation barrier dispatch completion for planner tool calls.
- Any runtime dispatch completion path used while the service is running.

Repair callers must pass `mode: 'repair'`:

- Startup active-run repair.
- Orphan activate-card repair.
- Crash-recovery synthesis.
- Operator/tool compensation paths that are explicitly compensating for an interrupted activation.

This split makes impossible states visible at call sites.

### 4. Make `ActivationUnwindRunner.parentPlannerRunFor()` ledger-backed or repair-only

File: `src/runtime/activation-unwind.ts`

Current behavior reconstructs a parent planner active run from `CardStore.getParent(childCardId)` and card type. That is too weak for normal execution because card hierarchy alone is not the runtime call stack. The activation ledger and run ledger are authoritative.

Recommended change:

- Rename current method to `repairParentPlannerRunForCardHierarchy()` or make it private to startup repair.
- Add a ledger-backed method for normal resumption that requires `RuntimeState` and `RuntimeActivationRecord`.
- Do not derive normal parent continuation from only `CardStore.getParent()`.

If startup repair still needs card-hierarchy fallback, keep it behind a repair-specific API name and document why it is less strict.

### 5. Remove redundant active-run clearing after completion compensation

File: `src/agents/activation-barrier-compensation.ts`

Current flow:

```ts
completeActivation(... outcome: 'failed')
planClearActiveCardRunPatch(... child_card_id ...)
```

This becomes suspicious once `completeActivation` owns active-run unwinding.

Plan:

- Decide whether activation barrier compensation is normal or repair.
- If the barrier is compensating for a live failed dispatch, it is probably normal completion with outcome `failed`; parent planner restoration should still happen.
- Remove the separate `planClearActiveCardRunPatch()` call in normal mode.
- If this is truly repair mode, keep clearing only through the repair reducer or a clearly named repair helper.

This removes a second independent active-run mutation that can race conceptually with the completion reducer even though the runtime is sequential.

### 6. Constrain `planClearActiveCardRunPatch()` usage

File: `src/runtime/runtime-core.ts`

Current helper clears current active run by card ID and sets runtime to idle. That is too broad as a normal runtime primitive.

Audit current callers:

- `src/runtime/executor-activation-dispatcher.ts`: executor invocation failure path.
- `src/runtime/startup-blocked-planning.ts`: startup alignment path.
- `src/agents/activation-barrier-compensation.ts`: compensation path.
- Startup/session sweep paths via related helpers.

Plan:

- Rename the helper to `planRepairClearActiveCardRunPatch()` if all remaining uses are repair/interruption paths.
- For executor invocation failure during live execution, prefer activation completion unwinding to the parent planner over clearing to idle.
- Keep direct clearing only for shutdown, stop, pause/freeze interruption, session sweep, or startup repair.
- Add tests asserting normal executor failure restores the parent planner active run when an activation parent exists.

### 7. Narrow root redispatch to recovery, not normal child continuation

Files:

- `src/runtime/state-machine.ts`
- `src/runtime/runtime-core.ts`
- `src/runtime/startup-run-reconciliation.ts`

`planProjectRootRedispatch()` is useful for stale startup/runtime intent reconciliation. It should not be the primary mechanism for normal parent continuation after a child finishes.

Plan:

- Keep project root redispatch for startup and stale-state recovery.
- Add a regression showing normal child completion does not require `status: idle` plus root redispatch to continue.
- Consider renaming diagnostics from generic redispatch to recovery wording where appropriate.
- If runtime ticks still invoke redispatch during normal active parent restoration, refine the predicate to ignore states with a restored parent active run.

### 8. Tighten idle/running reconciliation scope

Files:

- `src/runtime/runtime-core.ts`
- `src/runtime/startup-run-reconciliation.ts`

`planIdleRunningRootRunReconciliation()` currently treats idle runtime with running intent and open runs as something to reconcile. That is valid for startup/crash recovery, but in live normal flow it should be rare.

Plan:

- Confirm it is only called from startup reconciliation.
- Keep it startup-scoped.
- Rename if useful to `planStartupIdleRunningRootRunReconciliation()`.
- Add comments that live normal activation completion must not rely on this reconciler.

### 9. Update session/read-model semantics after strict parent restoration

Files:

- `src/application/read-models/agent-operator-read-model.ts`
- `src/agents/session-lifecycle.ts`
- `src/runtime/session-persistence.ts`

The UI/read model currently distinguishes an active planner turn from a waiting parent planner by checking active run and run ledger. Once child completion restores the parent active run immediately, a parent planner may be active in runtime state while its session manifest is still `waiting` until the next model invocation resumes.

Plan:

- Decide whether restored parent active run should be displayed as `waiting` or `active` before the next model call begins.
- Preferred semantics: runtime state is `running` with parent planner active, but session status may remain `waiting` until the invocation runner changes it to active. The operator read model can display this as `waiting` with `is_current_continuation: true`.
- Avoid changing session lifecycle just to match `active_card_run`; session status and runtime continuation are related but not identical.
- Add a read-model test for restored parent active run plus waiting planner session.

### 10. Update docs to reflect ledger-as-stack, not fallback redispatch

Files:

- `docs/agents.md`
- `docs/design/runtime.md`
- `docs/design/terminal-commit-layer.md`
- This plan file once implemented.

Required documentation changes:

- State that normal child activation completion restores the parent planner from `runtime_activations.parent_run_id`.
- State that missing parent run during normal completion is a hard invariant violation.
- Clarify that idle/root redispatch is recovery behavior, not the normal continuation path.
- Keep startup repair documented as separate from normal runtime mutation.

## Implementation Steps

### Step 1: Introduce strict active-run completion planning

Modify `runtime-core.ts`:

- Add `I9` to `InvariantId`.
- Add `ActivationCompletionActiveRunPlan` type.
- Add `planActivationCompletionActiveRun()`.
- Refactor `reduceActivationCompletion()` to call the planner.
- Remove normal fallback from missing parent planner run.
- Return a structured violation or throw through a dedicated error path.

Focused tests:

- Active child completion restores parent planner run.
- Active child completion with missing parent run returns/throws I9 in normal mode.
- Non-active child completion leaves `active_card_run` unchanged.
- Repair mode can produce an explicit repair-idle plan.

### Step 2: Add explicit mutation mode

Modify `mutations.ts`:

- Add `mode` to `completeActivation`.
- Update all callers.
- Reject missing mode at compile time.
- Route I9 violation into fail-closed behavior in normal mode.

Focused tests:

- Normal mutation throws on missing parent run.
- Repair mutation does not throw but produces documented repair state.

### Step 3: Update activation unwind and compensation callers

Modify:

- `activation-unwind.ts`
- `activation-barrier-compensation.ts`
- `executor-activation-dispatcher.ts`
- `executor-completion-handler.ts` if needed for clearer completion ownership.

Expected changes:

- Live child completion passes `mode: 'normal'`.
- Compensation code no longer clears active run after normal completion.
- Repair-only methods are renamed or moved.

Focused tests:

- Executor success completes child and restores parent without idle.
- Executor failure completes child and restores parent without idle.
- Activation barrier dispatch failure completes activation and restores parent or fails I9.

### Step 4: Audit and rename clear/repair helpers

Modify:

- `planClearActiveCardRunPatch()` and callers.
- Startup repair helper names.
- Any tests expecting live normal clear-to-idle after child completion.

Expected changes:

- Normal child completion does not call a clear helper.
- Clear helper names indicate repair/interruption semantics.
- Startup repair remains allowed to clear state when active session is swept or invalid.

### Step 5: Contract/integration tests

Add or update tests:

- `tests/runtime/runtime-core.test.ts` for strict reducer plans.
- `tests/utils/runtime-integration.test.ts` or a new runtime activation continuation test for end-to-end parent restoration.
- `tests/runtime/runtime-activation-ledger.test.ts` for ledger relationship validation.
- `tests/application` or server read-model tests for restored parent plus waiting session status.

Recommended integration scenario:

1. Root/project planner activates goal A.
2. Goal A planner activates terminal card B.
3. Executor for B completes.
4. Runtime state immediately points back to goal A planner.
5. No I1/I2/I9 invariant errors are logged.
6. Project root redispatch is not required for the continuation.

### Step 6: Update docs and validation gates

Modify active docs after implementation:

- `docs/agents.md`
- `docs/design/runtime.md`
- `docs/design/terminal-commit-layer.md`

Run validation:

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime/runtime-core.test.ts --runInBand --forceExit
npm run typecheck
npm run validate:routine
npm run build
```

If behavior affects the deployed GetRich v2 service, rebuild and restart:

```bash
npm run build
ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service && systemctl is-active saivage-v3-getrich.service'
curl -fsS http://10.0.3.170:8080/health
```

## Code Paths To Reconsider Because They Tolerate Impossible States

### `reduceActivationCompletion()` fallback-to-idle

This should be removed for normal mode. A child activation cannot complete without an open parent planner run if it was launched by a parent planner and no parallel execution exists.

### `ActivationUnwindRunner.parentPlannerRunFor()` card-parent reconstruction

This is not valid as a normal runtime continuation mechanism. Card hierarchy is not enough; the runtime ledger is authoritative. Keep this only for startup repair or replace it with ledger-backed lookup.

### `activation-barrier-compensation.ts` clear-after-complete

This performs a second active-run mutation after completion. Once completion owns unwinding, the extra clear is either redundant or wrong. It should be removed from normal mode.

### `planClearActiveCardRunPatch()` as a generic utility

Generic clear-to-idle hides whether a caller is handling shutdown/repair or normal completion. Rename or split it so normal runtime code cannot casually clear an active child instead of unwinding to parent.

### `planProjectRootRedispatch()` as normal continuation safety net

Root redispatch should remain a recovery/scheduling safety net, not the expected way to resume a parent after child completion. Tests should prove normal child completion restores parent state directly.

### Startup idle/running reconciliation

This remains valid, but it should be named and documented as startup recovery. If it is ever called in live normal flow, that should be treated as suspicious.

### Session sweep active-run clearing

If startup sweeps the session derived from `active_card_run`, clearing is acceptable because the runtime has lost the agent continuation. This is repair mode, not normal completion.

## Failure Semantics

Normal I9 failure should be loud because continuing could corrupt the planner tree.

Recommended normal-mode error payload:

```json
{
  "code": "runtime_activation_parent_missing",
  "invariant": "I9",
  "child_card_id": "card-21",
  "activation_id": "act-...",
  "parent_card_id": "card-8",
  "parent_run_id": "run-...",
  "parent_session_id": "planner:card-8",
  "message": "Child activation completed but its parent planner run is not open. This is impossible during sequential runtime execution."
}
```

Operator guidance:

- Inspect `/api/debug/errors` and `/api/debug/timeline`.
- Use startup/crash repair if the service was interrupted.
- Do not silently resume from the project root unless repair explicitly chooses that path.

## Acceptance Criteria

- Normal child activation completion never leaves runtime `idle` when an open parent planner run exists.
- Normal child activation completion fails closed if the parent run is missing, closed, duplicated, or not a running planner run.
- Repair paths remain available but are explicitly named and tested as repair paths.
- No normal live path calls a generic clear-active-run helper after child activation completion.
- Existing root redispatch remains useful for stale startup/runtime-intent recovery but is not required for ordinary parent continuation.
- `/api/agents` and `/api/state` present a consistent state while parent planner is restored and waiting for the next model invocation.
- Tests cover success, failure, orphaned parent, repair mode, and no-I1/I2 regression cases.

## Non-Goals

- Do not implement parallel agent execution.
- Do not add a new persisted activation stack unless the ledger proves insufficient after strict invariants are implemented.
- Do not add compatibility shims for historical malformed runtime state in normal runtime code.
- Do not silently normalize missing parent planner runs during normal live execution.

## Open Questions

- Should normal I9 failure throw from `applyRuntimeMutation()` or return a structured failure that the caller converts to a runtime error? Throwing is simpler and more fail-fast; structured return preserves reducer purity.
- Should repair mode live in the same `completeActivation` mutation with `mode: 'repair'`, or should it use a separate `repairCompleteActivation` mutation? A separate mutation is clearer but touches more call sites.
- Should the operator read model expose a distinct `resuming` state for a restored parent planner whose session manifest is still `waiting`? This may improve UI clarity without changing runtime semantics.
