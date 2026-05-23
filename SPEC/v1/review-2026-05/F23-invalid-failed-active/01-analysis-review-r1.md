# F23 — Analysis Review (r1)

## Analysis

The closure decision is not yet sound. The F19 r5 `restart` action genuinely covers the executor-card retry path at [src/runtime/runtime.ts](../../../../src/runtime/runtime.ts#L706): for a failed terminal child, Step 5 routes through `failed → backlog → active → running`, so that part of F23 is correctly subsumed by F19.

However, the r1 analysis misidentifies the exact `errors.jsonl` producer for `Invalid transition: failed → active`. [src/runtime/runtime.ts](../../../../src/runtime/runtime.ts#L766-L782) forwards planner-supplied status with `cardStore.update(...)`, and [CardStore.update](../../../../src/cards/card-store.ts#L799-L806) does not call `validateTransition`; [validateMutablePatch](../../../../src/cards/card-store.ts#L568-L582) explicitly permits a `status` key on terminal cards. That path can silently persist an illegal `failed → active` status change, but it does not produce the `validateTransition` throw cited by the issue. F19 r5's `planner_set_status` rejection is still the right architectural fix for that second caller, but the docs must describe it as closing a silent illegal-write path, not as removing the historical throw from `errors.jsonl`.

There is also a runtime-originating `failed → active` throw path not covered by F19 r5 Step 5: [src/runtime/runtime.ts](../../../../src/runtime/runtime.ts#L621) calls `this.cardStore.activateGoal(goalId)`, and [CardStore.activateGoal](../../../../src/cards/card-store.ts#L1097-L1105) calls `setStatus(id, 'active')` for any goal not already `active` or `running`. If `dispatchGoal` is re-entered for a failed goal card, this produces the exact `failed → active` `validateTransition` error. F19 r5 analyzes `activateGoal` as part of the reviewer-repair construction proof, but Step 5 does not route the goal activation wrapper through `RuntimeStateMachine.transitionCard`. The F23 r1 docs need either a construction proof that this cannot occur in the F23/F19 failure mode, or residual F23/F19 scope to route failed goal activation through a legal `restart` decomposition.

The direct planner-tool entries at [src/tools/planner-tools.ts](../../../../src/tools/planner-tools.ts#L163) and [src/tools/planner-tools.ts](../../../../src/tools/planner-tools.ts#L221) do not justify broadening F23 by themselves; they are outside the runtime-orchestrator boundary and are not the F19 Step 5 surface. The blocker is specifically the runtime `dispatchGoal → activateGoal → setStatus('active')` wrapper plus the incorrect claim about `cardStore.update` throwing.

## Design

The design correctly avoids duplicating F19's state-machine module, action table, and runtime writer sweep. Keeping F23 as an acceptance-oriented issue is still plausible, but only after the call-site inventory is corrected.

The current design statement that, after F19 r5 Step 5, `errors.jsonl` contains zero `Invalid transition: failed → ...` lines for any subsequent runtime turn is too broad while the `activateGoal` wrapper remains direct. The statement should be narrowed to the executor-card F19 wedge, or F19/F23 should add the missing goal-activation conversion.

The `planner_set_status` design point should also be reframed. Its acceptance value is: illegal planner-supplied one-step status updates are rejected with `state_machine_planner_status_rejected` and no card write. It is not the path that currently emits the `validateTransition` stack trace.

No new permission rule or separate recovery abstraction is needed if the missing activation path is handled by the existing `start`/`restart` semantics. The narrow architecture-first fix is to make goal activation use the same state-machine transition boundary as executor activation, or to document a rigorous impossibility proof if that is intentionally out of scope.

## Plan

The two proposed F23 tests are close but need tightening before approval.

For `tests/runtime/f23-errors-jsonl-clean.test.ts`, keep the failed executor-card wedge fixture and expected `['failed → backlog', 'backlog → active', 'active → running']` trace. That is the useful acceptance signal for the L706/F19 path.

For `tests/runtime/f23-planner-set-status-failed-active.test.ts`, change the pre-F19 failure expectation: the old runtime will silently mutate the failed card to `active`, not throw an `Invalid transition` line. The test should drive the public planner-result shape (`updated_cards: [{ id, status: 'active' }]`), then assert the post-F19 card remains `failed`, the rejection bookkeeping contains `state_machine_planner_status_rejected`, and `errors.jsonl` has no `Invalid transition: failed → active` line.

Add or explicitly rule out a third residual test for failed goal activation. A concrete test would pre-seed a goal card in `status: 'failed'`, invoke `dispatchGoal(goalId)` (or the public runtime entry that re-dispatches it), and assert either legal `restart` decomposition or a documented, non-throwing rejection. Without this, the blanket Probe-C/cleanliness claim misses a real runtime `setStatus('active')` caller.

The live Probe-C reference is otherwise correct: F23 should adopt F19 r5 Probe-C's `grep "Invalid transition: failed"` signal, because it avoids Unicode-arrow fragility and covers both `failed → active` and `failed → running`. Once the docs narrow the claim or add the missing activation coverage, Probe-C remains an appropriate live smoke signal and F23 can stay closure-mode without duplicating F19 implementation work.

VERDICT: CHANGES_REQUESTED