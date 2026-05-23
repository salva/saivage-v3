# F23 — Analysis Review (r2)

## Analysis

Approved. The r2 analysis corrects the r1 blocker: the issue now has the right three-path inventory and separates the two different failure modes cleanly.

The spot-check against `src/runtime/runtime.ts` and `src/cards/card-store.ts` matches the document:

1. L706 is correctly described as the executor retry path. A failed terminal child skips the `backlog` guard and currently throws on `failed → running`; F19 r5 Step 5 closes it with `start`/`restart`, and `restart` from `failed` emits `failed → backlog → active → running`.
2. L766-L782 is correctly reframed as a silent illegal write, not the historical throw. `cardStore.update(...)` bypasses `validateTransition`, and `validateMutablePatch` permits terminal-card `status` changes.
3. L621 is correctly identified as the F23 residual path. `dispatchGoal → activateGoal → setStatus('active')` can throw the exact `Invalid transition: failed → active` message for a failed goal card.

The r1 asks are covered: the diagnosis is corrected; the `errors.jsonl` claim is narrowed; planner-tool direct callers are left out of scope; crash/simulated-crash backlog writes are excluded; and the F23 residual scope is no longer hidden behind F19 closure-mode. The binding orchestrator decision is reflected: F23 is closure-mode for L706 and L766-L782, plus residual scope for the L621 failed-goal activation path.

## Design

Approved. The design uses the F19 r5 state machine instead of adding another recovery abstraction. The proposed `dispatchGoal` conversion selects `start` for `STARTABLE_STATES` and `restart` otherwise, with a no-op branch for goals already `active` or `running`; that is the right shape for preserving current goal-dispatch semantics while routing failed goals through the legal `failed → backlog → active → running` sequence.

The `CardStore.activateGoal` decision is explicit and acceptable: delete the helper, do not wrap it. The reasoning is architecture-consistent because a wrapper would either preserve the bad direct `setStatus('active')` surface or invert the CardStore/runtime dependency boundary. The planning-result seed moves inline as an awaited runtime follow-up, which also composes with F19 r5's awaited `cardStore.update` rule.

F19 r5 ordering and action semantics are pinned: no new `RuntimeCardAction` is introduced, the `planner_set_status` rejection contract remains one-step/no-write, and the design avoids new docstrings or extra machinery. The only implementation caveat is ordinary PR-level care: when deleting `activateGoal`, update the existing helper-based tests and preserve any needed `dispatchGoal` boundary validation in runtime-owned code. That does not block the r2 docs.

## Plan

Approved. The plan pins F19 r5 Steps 1-5 ahead of the F23 residual conversion, then adds the L621 change and helper deletion in the same rebased work. The step order is concrete enough to implement without widening scope.

The three tests are correctly defined with concrete paths and map one-to-one to the reviewed paths:

1. `tests/runtime/f23-errors-jsonl-clean.test.ts` covers the F19-owned L706 executor retry acceptance signal and asserts the restart decomposition plus no `Invalid transition: failed → ...` lines.
2. `tests/runtime/f23-planner-set-status-failed-active.test.ts` covers the L766-L782 silent-write path by asserting the failed card stays failed and rejection bookkeeping is observable.
3. `tests/runtime/f23-goal-activation-failed.test.ts` covers the F23-owned L621 residual by driving `dispatchGoal(goalId)` for a failed goal and asserting restart decomposition, no propagated transition throw, clean `errors.jsonl`, and preserved `result.planning` seed.

The live Probe-C reuse is appropriate, and the acceptance contract includes `rg -n "activateGoal" src/ tests/` returning zero matches. No over-engineered gate or duplicate state-machine design is added.

VERDICT: APPROVED