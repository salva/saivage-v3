# Architecture investigation findings (pre-design)

Three deep investigations were run before finalizing the design. All are
evidence-based with file:line citations; summaries below.

## Finding A — `active` card status is redundant accidental complexity

`active` is **not a resting state**. The state machine writes `active` then
immediately overwrites it with `running` in the **same synchronous
operation**: `RuntimeStateMachine.transitionCard` applies all plan steps in
one `setStatus` loop (`src/runtime/phases/state-machine.ts:215`), and every
start/restart plan is `[..., 'active', 'running']`
(`src/runtime/phases/transition-policy.ts:56-68`). Proven by
`tests/runtime/state-machine.test.ts` asserting the sequence
`['active','running']`.

No consumer distinguishes `active` from `running`: every read is either
`active || running` (identical treatment) or defensive code that exists only
to bridge `active -> running` (`transition-policy.ts` block/complete/fail/
reviewer_repair_resume/crash_recovery cases). `markCardChangedForAnalystCorrection`
(`src/agents/analyst-stage6.ts:38-52`) already omits `active`, implicitly
assuming it is never a resting state.

`docs/agents.md §4.2` describes `active` as "ready for a planner to choose" —
a selectable pool that does not exist in the code. The doc is legacy.

**Decision: remove `active` as part of this work** (operator-confirmed).
Blast radius: `src/schemas/types.ts:4`, `src/schemas/lifecycle.ts:88,193`,
`src/cards/lifecycle.ts` (VALID_TRANSITIONS, `buildSetStatusLifecycle`),
`src/runtime/phases/transition-policy.ts` (delete `active` step + bridge
branches), `src/permissions/card-permissions.ts` (PLANNER_MUTABLE_STATES),
~7 runtime/tool consumer reads (drop the `active` disjunct),
`src/tools/planner-tools.ts:256` (dead `activateCard`) and `:335`
(`restartCard` -> target `backlog`), ~8 web files (status lists, board
column, exhaustive maps, child-count seeds), `tests/runtime/transition-policy.test.ts`,
`tests/runtime/state-machine.test.ts`, ~10 web/runtime fixtures, and
`docs/agents.md §4.2`.

## Finding B — two reviewer dispatchers; the SYNC one is a vestigial duplicate

There are two fully-implemented reviewers; both invoke a real LLM, so in
production every passing goal is reviewed **twice**:

- **ASYNC** `RuntimeReviewerDispatcher` (`src/runtime/runtime-reviewer-dispatcher.ts`),
  composed at `src/runtime/runtime-dispatch-composition.ts:130-144`, invoked
  from `src/runtime/runtime-planner-dispatcher.ts:107`. Sets
  `active_card_run.phase='reviewer'`.
- **SYNC** inline reviewer inside `report_goal_done`
  (`src/tools/planner-tools.ts:467-584`), wired via
  `src/agents/planner-control-factory.ts:43-72` and
  `src/agents/planner-control-executor.ts:53`.

The double-invocation chain: planner calls `report_goal_done` -> SYNC
reviewer fires inline -> the accepted card is tracked into a `status:'done'`
planner envelope (`src/agents/planner-envelope-tracker.ts:9-13`) ->
`decidePlannerPostDispatch` returns `ready_for_review`
(`src/runtime/phases/planner-phase.ts:207-208`) -> ASYNC reviewer fires. Not
caught by tests because `FakeAgentAdapter` bypasses the tool layer.

## Finding C — which reviewer is architecturally correct (deep analysis)

**Verdict: keep ASYNC, delete SYNC.** Grounded in consistency, not
doc-conformance:

1. **Single-dispatcher invariant** (`docs/agents.md:47-48`: "The Runtime is
   the only dispatcher"). `activate_card` in `PlannerControlExecutor` only
   writes the activation/run ledgers and hands back to the runtime
   (`src/agents/planner-control-executor.ts:146-147,155`); the runtime
   dispatches the child (`src/runtime/pending-activation-dispatcher.ts:95-121`).
   The SYNC reviewer is the unique place where the agent-side tool layer
   dispatches another agent inline (`src/tools/planner-tools.ts:471` ->
   `AgentAdapter.invokeReviewer`). That violates the invariant. ASYNC is a
   runtime collaborator and matches the executor-dispatch pattern.
2. **Activation ledger.** Only ASYNC maintains `active_card_run.phase='reviewer'`
   (`src/runtime/runtime-reviewer-dispatcher.ts:80-92`), consumed by restart
   repair (`src/runtime/startup-repair.ts:37`) and current-session derivation
   (`src/runtime/current-run.ts:14-15`). SYNC leaves the ledger blind to
   review.
3. **Restart recovery.** `reviewer_interrupted` recovery
   (`src/runtime/startup-repair.ts:37,205-228`) is reachable only with ASYNC;
   SYNC-only makes it dead code.
4. **Planner lifecycle.** Docs §5: planner is `Dormant` during review. SYNC
   runs the reviewer while the planner turn is still on the stack
   (`src/agents/invocation-runner.ts:292-330`, session completed only at
   `:656`). ASYNC reviews after the planner session completes
   (`src/runtime/runtime-planner-dispatcher.ts:106-107`).
5. **Terminal-report symmetry.** `report_goal_failed/_blocked` get no
   reviewer; in ASYNC all three flow through one runtime decision
   (`src/runtime/phases/planner-phase.ts:135-220`). SYNC adds a `done`-only
   second decision layer.
6. **Retry model.** Canonical is `active_card_run.correction_attempts`
   (`docs/agents.md:289,951-952`), carried through the activation reducer and
   Goal Context. SYNC invents a parallel `card.retries` counter
   (`src/tools/planner-tools.ts:572-581`) that nothing else reads.

One honest caveat: from the parent's view `activate_card` is "synchronous"
(`docs/agents.md:130-133`), which superficially favors SYNC; but that
synchronicity is about the parent's `activate_card`, already delivered by the
ASYNC activation barrier + unwind, and the same docs sentence requires
restart-resumability that only ASYNC provides.

**Deletion blast radius (delete SYNC):** the reviewer branch in
`PlannerToolsService.reportGoalSync` (`src/tools/planner-tools.ts:467-584`),
`persistReviewerInvocationBlock`, `applyReviewerAssessment`,
`writePendingSubtreeCorrectionNotes`, the `reviewer`/`maxReviewRetries`/
`assessmentIdFactory` fields; the `invokeReviewer` closure in
`src/agents/planner-control-factory.ts:22-72`; the reviewer fields in
`src/agents/planner-control-executor.ts:21-23,53-55`; and the
`invokeReviewer`/`markSession*` args at `src/agents/agent-adapter.ts:155-167`.
**Keep** `AgentAdapter.invokeReviewer` (`:321-333`, the runtime-facing port)
and `PlannerEnvelopeTracker` (minus its now-dead `changed->continue` branch,
since `report_goal_done` can no longer return `changed`). `report_goal_done`
still commits the `done` lifecycle via `acceptReport` and the §8.1/§8.2 gates
(`src/tools/planner-tools.ts:443-455,509-517`) remain intact.

## Finding D — reviewer-completion never checks for the goal's own pending notes

`handleReviewerAssessmentDecision`'s `pass` arm
(`src/runtime/phases/reviewer-assessment-handler.ts:76-91`) unconditionally
unwinds to the parent (activation) or idles (direct). It never peeks
`drainSyntheticPlannerNotes('planner:'+goalId)` for the goal's own planner.
The only paths back into the goal's own planner are `needs_corrections`
(`continue_planner`, `:101-102` -> `runtime-planner-dispatcher.ts:108-109`)
and restart-time `reviewer_interrupted` recovery. Adding a "pending notes ->
resume goal planner instead of unwind" branch here is new but small, and is
the mechanism that replaces the original D6.

Important ordering fact: `commitReviewerPass` runs at
`reviewer-assessment-handler.ts:67-75`, **before** the unwind branch (76-91).
The note-check must therefore be placed **before** `commitReviewerPass` and
must not commit the pass when notes exist (otherwise the goal is `done` while
its planner is resumed). The peek must be **non-consuming**
(`drainSyntheticPlannerNotes` removes notes; the resumed planner's normal
goal-context drain at `runtime-goal-context.ts:28-35` must still find them).

## Finding E — `correction_attempts` is dead; `max_review_retries` (docs §13) is unimplemented in the live path

`active_card_run.correction_attempts` is **never incremented** anywhere.
Every reference is a read or a `0`-seed: `activation-reducer.ts:32,49,65`,
`context-builder.ts:144`, `reviewer-phase.ts:35`, `startup-repair.ts:90,113,158`,
`runtime-core.ts:735`, `activation-unwind.ts:286`,
`schemas/types.ts:110`/`validators.ts:107`. So the async reviewer path has
**no per-goal review-retry cap**; the only bound on the
`needs_corrections` resume loop is `MAX_PLANNER_ITERATIONS = 50`
(`runtime-planner-dispatcher.ts:79`), and iteration-budget exhaustion commits
`blocked` via `terminateIfNonTerminal` (`:190-206`). The documented
`max_review_retries` semantics (`docs/agents.md §13`, §10) are therefore
**not implemented** in the live runtime.

This is a pre-existing divergence exposed by deleting the sync reviewer (the
sync path had its own `card.retries`/`maxReviewRetries` cap and a narrow
`attempts > maxReviewRetries -> changed` flip). It is **out of scope** for this
change (operator decision): keep the `blocked` terminal at iteration-budget
exhaustion; do not add an async `changed`-on-exhaustion flip; the sync flip is
simply deleted with the sync reviewer. Recorded here so the `correction_attempts`
dead field and the docs §13 gap are not lost.
