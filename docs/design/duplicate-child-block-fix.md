# Duplicate Child Block Fix

Status: proposed fix, scoped to the GetRich v2 incident.

This document replaces an earlier, much larger "runtime dispatch queue redesign" plan. A full code re-verification (see "What the code actually does") showed that the large redesign solved a problem the runtime does not have, fought the runtime's deliberately sequential design, and would have required building infrastructure that does not exist. The earlier plan has been removed. What remains is the small, verified fix for the actual incident.

## Incident

GetRich v2 produced:

- `RuntimeDispatchInvariantError: card 'card-25' cannot transition via 'block' from 'blocked'.`
- `state_machine_invalid_source_state (cardId=card-25 action=block from=blocked)`

Timeline for `card-25`: `done` at 18:18:05, `blocked` at 18:18:55, then a restart/re-activate at 18:20:09. A child goal card was committed to `blocked`, and then a second `block` was attempted on the same already-`blocked` card.

## Root cause (verified against code)

Two facts combine:

1. **Block commits are not idempotent.** A `block` transition is rejected by `planCardTransition` unless the source status is `active` or `running` (`src/runtime/transition-policy.ts`, `case 'block'`). `transitionCard` then throws `RuntimeDispatchInvariantError` (`src/runtime/state-machine.ts`). So committing `block` on an already-`blocked` card throws. Two block-commit helpers call `transitionCard('block')` with no status guard:
   - `commitPlannerBlocked` (`src/runtime/terminal-commit/commit-planner.ts:47`)
   - `commitReviewerInvocationFailure` (`src/runtime/terminal-commit/commit-reviewer.ts:57`)

2. **The child runs synchronously inside the parent planner's tool call**, so the throw is misattributed. In production no `goalDispatcher` is injected, so `activate_card` runs the child goal's `runPlannerLoop` inline via `await activationBarrier.dispatch(...)` (`src/agents/invocation-runner.ts:309`). When the second block throws inside the child, the exception unwinds through the parent planner turn and is recorded as a **parent** planner/LLM failure (`compensateActivationBarrierThrow` writes a `tool_error` on the parent session, then the parent attempt loop records a failed parent planner attempt and ultimately `commitPlannerFailed` on the parent goal).

The incident shape is a cross-context double block on one child: the child's own planner block commits `blocked` and returns; later a reviewer-unavailable path (`commitReviewerInvocationFailure`, also tagged `reviewer_unavailable`) or another block path drives a second `block` on the same already-`blocked` child, which throws.

## The codebase already treats this as a no-op everywhere else

Skipping a terminal transition when the card is already in the target terminal state is the established pattern here. Three existing places already do it:

- `commitReviewerPass` skips `complete` when `card.status === 'done'` (`src/runtime/terminal-commit/commit-reviewer.ts:19`).
- The removed legacy planner dispatcher also treated already-terminal cards as no-ops during cleanup.
- The removed startup blocked-planning repair helper also skipped re-blocking an already-`blocked` card.

The two block-commit helpers are the inconsistent outliers. Making them match is not a hack; it is removing an inconsistency.

## Fix

Guard the `block` transition in both block-commit helpers, mirroring the existing `commitReviewerPass` guard. When the card is already `blocked`, skip the `transitionCard('block')` call (it would only throw) and proceed to write the lifecycle patch, which is idempotent for the same blocked overlay.

`src/runtime/terminal-commit/commit-planner.ts` (`commitPlannerBlocked`):

```ts
// before
await transitionOrThrow(input.effects.transitionCard(input.card.id, 'block', { blocked_reason: input.blockedReason }));
// after
if (input.card.status !== 'blocked') {
  await transitionOrThrow(input.effects.transitionCard(input.card.id, 'block', { blocked_reason: input.blockedReason }));
}
```

`src/runtime/terminal-commit/commit-reviewer.ts` (`commitReviewerInvocationFailure`): same guard around the `transitionCard('block')` at line 57.

That is the whole change: two guarded call sites in the terminal-commit layer, the single chokepoint every block path already flows through.

### Why scope it to `status === 'blocked'`

Keep fail-fast for genuinely impossible transitions. Only skip when the source is already `blocked`. A truly invalid source (for example `done -> block`) must still throw, so do not broaden the guard to "swallow any rejected block". This preserves the strict-terminal-transition contract introduced deliberately in the runtime; it only removes the redundant re-block.

## Explicitly out of scope (and why)

These were in the earlier plan and are removed. They are not needed to fix the incident, and the code does not support them without large, risky changes:

- **De-recursing `activate_card` (run the child outside the parent stack).** The runtime is single-active and sequential by design. There is no existing loop that picks up a parked `pending` activation: the only pending-activation dispatch (`PendingActivationDispatcher.dispatch`/`dispatchActivation`) is called synchronously inside the planner iteration, and the periodic tick only ever redispatches the project root, never scanning `runtime_activations` (`src/runtime/state-machine.ts`, `planProjectRootRedispatch` in `src/runtime/runtime-core.ts`). Parking-and-returning would leave the child `pending` forever and spin the parent planner loop. Decoupling would also break `reduceActivationCompletion` / `findParentPlannerRunForResumption`, which require the parent planner run to remain open while the child completes. This is a real rearchitecture with no incident-level payoff.
  - A "floating Promise" variant (spawn `Promise.resolve().then(() => dispatchChild(...))` un-awaited and return a `{parked:true}` signal) was specifically evaluated and rejected: it is not simpler than the queue design because it still requires building protocol-valid parking of the parent turn plus a resume path. Today the parent turn ends by `await`-ing dispatch then `continue` (`src/agents/invocation-runner.ts:309,314`); replacing the `await` with a floating Promise and `continue` would issue the next provider call while the `activate_card` tool call is still unresolved in the log. It also converts the load-bearing "parent run open when child completes" invariant from a call-stack guarantee into a microtask-ordering assumption.
- **A new reducer module, reducer-command catalog, or parked-result ledger.** Runtime state already has a single-writer reducer (`RuntimeStateMutationPort` / `applyRuntimeMutation`, `src/runtime/mutations.ts`). The child outcome is already delivered to the parent's `activate_card` call idempotently by `appendActivateCardToolResultOnce` (`src/runtime/session-persistence.ts:418`). The parent already resumes via the existing planner loop. None of this needs rebuilding.
- **New activation states, a `planner_waiting_for_activation` run phase, or terminal-event keys.** The existing `RuntimeActivationStatus` and records are sufficient; the incident does not require new state.

If a future requirement (for example genuinely concurrent activations) needs out-of-stack dispatch, that is a separate design with its own justification, not a prerequisite for this fix.

## Non-Goals

- Do not catch `RuntimeDispatchInvariantError` and continue. The fix prevents the impossible transition from being attempted; it does not swallow the error.
- Do not broaden the guard so that any rejected `block` becomes a no-op. Only `block` from `blocked` is skipped.
- Do not change the `transitionCard` fail-fast contract or the synchronous dispatch structure.

## Dead code noticed (optional cleanup, not required for the fix)

The re-verification found that `transitionCard` can no longer return `false` (it returns `true` or throws), so the `=== false` arms in `transitionOrThrow` (`src/runtime/terminal-commit/commit-planner.ts:54`, `src/runtime/terminal-commit/commit-reviewer.ts:54`, `src/runtime/terminal-commit/commit-executor.ts:127`) are unreachable. Related dead guards in the legacy activation dispatch path were removed with that obsolete runtime-loop path. Removing the remaining terminal-commit arms is a safe, separate cleanup. It is not needed to fix the incident; do it only if touching those files anyway.

## Implementation plan

### Phase 1: Regression test that reproduces the incident

Add a focused test that drives a child card to `blocked` and then triggers a second block commit on the same card, asserting that today this throws `RuntimeDispatchInvariantError` (and, through the synchronous activation barrier, surfaces as a parent planner failure).

Targets:

- A terminal-commit-level test calling `commitPlannerBlocked` / `commitReviewerInvocationFailure` twice on the same card (smallest reproduction).
- Optionally, an integration test through the planner/reviewer dispatch path that shows the parent planner being failed by the child's duplicate block.

Expected before the fix: the second commit throws.

### Phase 2: Apply the idempotency guard

- Add the `if (input.card.status !== 'blocked')` guard around `transitionCard('block')` in `commitPlannerBlocked` (`src/runtime/terminal-commit/commit-planner.ts:47`) and `commitReviewerInvocationFailure` (`src/runtime/terminal-commit/commit-reviewer.ts:57`).
- Keep the subsequent `updateCard(... lifecyclePatch ...)` call; it is idempotent for the same blocked overlay.

After the fix:

- The Phase 1 regression test passes: a second block on an already-`blocked` card is a no-op, no throw.
- A truly invalid source (for example `done -> block`) still throws.
- The parent planner is no longer failed by a child's duplicate block.

### Phase 3: Validate

From `/home/salva/g/ml/saivage-v3`:

```bash
npm run typecheck
npm test
npm run validate:routine
```

## Acceptance criteria

- Committing `block` on an already-`blocked` card is a no-op, not a throw, in both `commitPlannerBlocked` and `commitReviewerInvocationFailure`.
- A `block` from a non-terminal, non-blocked invalid source still throws `RuntimeDispatchInvariantError` (fail-fast preserved).
- A child goal's duplicate block can no longer be recorded as a parent planner/LLM failure.
- A regression test fails on the current code and passes after the guard.
- `npm run validate:routine` passes.

## Code anchors (verify with grep before editing)

| Concept | Symbol | File |
|---|---|---|
| Block-commit helper (planner) | `commitPlannerBlocked` (unguarded `transitionCard('block')`) | `src/runtime/terminal-commit/commit-planner.ts:47` |
| Block-commit helper (reviewer-unavailable) | `commitReviewerInvocationFailure` (unguarded `transitionCard('block')`) | `src/runtime/terminal-commit/commit-reviewer.ts:57` |
| Existing idempotent precedent | `commitReviewerPass` (`if status !== 'done'`) | `src/runtime/terminal-commit/commit-reviewer.ts:19` |
| Transition rejection | `planCardTransition` `case 'block'` default `reject()` | `src/runtime/transition-policy.ts` |
| Throw on rejected transition | `RuntimeStateMachine.transitionCard` | `src/runtime/state-machine.ts` |
| Synchronous child dispatch (misattribution source) | `await activationBarrier.dispatch({ activation })` | `src/agents/invocation-runner.ts:309` |
| Throw compensation onto parent session | `compensateActivationBarrierThrow` | `src/agents/activation-barrier-compensation.ts` |
