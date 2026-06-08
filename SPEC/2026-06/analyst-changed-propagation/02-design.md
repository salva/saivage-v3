# Design: Analyst `changed` Propagation, State-Model Cleanup, and Single Reviewer

## 0. Summary

When the analyst edits a card's objective fields on a running Saivage v3
system, the runtime propagates a `changed` marker up the **direct ancestor
path** of the edited card, flipping each **resting** ancestor to `changed`
and **stopping at the first live (`running`) ancestor**. Every planner on the
ancestor chain above the stop point receives a synthetic note so it can
decide whether to re-schedule the affected subtree. Cancellation is not a
special operation: it becomes "edit objective -> planner reacts -> planner
re-activates or `cancel_card`s", and a tightened completion gate guarantees a
goal cannot report `done` while any descendant is non-terminal.

The investigation phase (see `00-investigation-findings.md`) established two
adjacent simplifications that this design folds in because the propagation
correctness depends on them:

- The `active` card status is redundant accidental complexity and is removed.
- The `drafting` card status is removed with it. It only existed as a
  pre-backlog shaping state, but planner tooling already treats cards as
  backlog-style work items and has no useful behavior for a separate drafting
  phase.
- There are two reviewer dispatchers causing double-review; the synchronous
  in-tool reviewer is deleted, leaving the runtime-owned async dispatcher as
  the sole reviewer. The review-in-progress case is then solved by a small
  addition to that single dispatcher rather than by an analyst-side
  state mutation.

Locked decisions D1-D10 are recorded in `00-context.md`.

## 1. Part 1 — Remove the `active` and `drafting` card statuses (D8, D10)

### 1.1 Rationale

`active` is never a resting state. `RuntimeStateMachine.transitionCard`
applies every plan step in one synchronous `setStatus` loop
([`state-machine.ts`](../../../src/runtime/state-machine.ts) line 215),
and every start/restart plan is `[..., 'active', 'running']`
([`transition-policy.ts`](../../../src/runtime/transition-policy.ts)
lines 56-68). A card is written `active` and overwritten `running` in the same
operation; no planner observes it across an LLM turn. Every consumer treats
`active` and `running` identically or only bridges `active -> running`.

`drafting` is also removed. It represents a "not ready yet" card phase, but the
planner does not have meaningful behavior for preserving such a phase: created
cards are either actionable backlog work or running/changed/terminal lifecycle
state. Removing it makes creation default to `backlog` and removes the
unhelpful `drafting -> backlog` normalization hop.

### 1.2 Changes

- **Status enum.** Remove `'active'` from `cardStatusValues`
  ([`src/schemas/types.ts`](../../../src/schemas/types.ts) line 4) and the
  `{ status: 'active' }` lifecycle union member + zod literal
  ([`src/schemas/lifecycle.ts`](../../../src/schemas/lifecycle.ts) lines 88,
  193). Remove `'drafting'` from the same enum and lifecycle union/schema
  entries (currently line 86 / 191). New cards default to `backlog` rather than
  `drafting`.
- **Runtime status tuple.** Update `RUNTIME_CARD_STATUS_VALUES`
  ([`src/tools/tool-catalog.ts`](../../../src/tools/tool-catalog.ts) lines
  8-18), a hardcoded tuple `as ['drafting','backlog','active','running',...]`.
  Removing statuses from `cardStatusValues` makes its `.filter()` result and
  tuple assertion diverge — a TypeScript compile error. Drop both `'active'` and
  `'drafting'` from the asserted tuple (it feeds `runtimeCardStatusSchema` at
  line 54, the agent-facing runtime status enum).
- **Transition table.** Delete the `active:` and `drafting:` rows; rewrite the
  start path so start goes `backlog/changed -> running` directly. Set
  `backlog: ['running','cancelled']`, `changed: ['backlog','running','cancelled']`,
  and `cancelled: ['backlog']` before Part 2 adds `changed` to terminal rows.
  Remove the `active` and `drafting` cases in `buildSetStatusLifecycle`
  ([`src/cards/lifecycle.ts`](../../../src/cards/lifecycle.ts)). Update
  `FULL_EDIT_STATES` in the same file from `['drafting','backlog']` to
  `['backlog']`.
- **Transition policy.** In
  [`transition-policy.ts`](../../../src/runtime/transition-policy.ts):
  start/restart plans end at `running` (drop the `'active'` element and any
  `drafting` restart hop); delete
  the `from === 'active'` branches in `block`/`complete`/`fail`/
  `reviewer_repair_resume`/`crash_recovery` (lines 80, 84, 91, 109, 113, now
  unreachable); delete the `active`-only executor branch in
  `selectActivationStartAction` (line 23,
  `if (fromStatus === 'active') return { action: 'reviewer_repair_resume', ... }`,
  unreachable after removal — reviewer-interrupt resume stays valid because
  the interrupted goal is `running`, handled by the `from === 'running'`
  accept at line 110); drop the `active` disjunct from the planner
  `none/already_active` guard.
- **Permissions.** Remove `'active'` from `PLANNER_MUTABLE_STATES`
  ([`src/permissions/card-permissions.ts`](../../../src/permissions/card-permissions.ts)
  line 26) and remove `'drafting'` from `STARTABLE_STATES` (line 29).
  `RESTARTABLE_STATES` already excludes `active`/`drafting`.
- **Dead/aligned planner tools.** Delete `PlannerToolsService.activateCard`
  ([`src/tools/planner-tools.ts`](../../../src/tools/planner-tools.ts) line
  256, except for direct tests). `restartCard` (line 335) already does
  `repairTerminalLifecycle(_, 'backlog')` then `setStatus(_, 'active')`; drop
  the `setStatus('active')` so restart **rests at `backlog`**. `restart_card`
  ([`planner-control-executor.ts`](../../../src/agents/planner-control-executor.ts)
  lines 213-219) does not dispatch; the card rests at `backlog` until a later
  `activate_card` produces the `backlog -> running` start plan. `backlog` is
  in `STARTABLE_STATES` (unlike the old `active`), so this is strictly more
  correct.
- **Grouped reads.** Drop the `active` disjunct in
  `planner-tools.ts:241` (`card_already_active` guard),
  `src/runtime/crash-recovery.ts:21`,
  `src/runtime/startup-blocked-planning.ts:9`,
  `src/runtime/phases/executor-evidence.ts:167`,
  `src/runtime/phases/planner-phase.ts:279-280`,
  `src/tools/analyst-subtree-tools.ts:50`,
  `src/tools/analyst-tool-helpers.ts:62` (drop both `active` and `drafting`).
  The project-planner retry patch
  `buildProjectPlannerRetryPatch` (`planner-phase.ts:314`) sets lifecycle
  `running` (or relies on the immediately-following dispatch).
- **Web UI.** Remove `'active'` from `CARD_STATUSES`
  (`web/src/stores/card-presentation.ts`), the board `STATUS_ORDER` column
  (`web/src/components/cards/CardsBoardView.vue`), the
  `statusExplainer`/icon exhaustive maps and `counts.active` sums
  (`web/src/components/cards/CardDetailView.vue`,
  `CardsTimelineView.vue`), and the child-count seeds / `hasActiveChildren`
  (`web/src/stores/card-detail-view-model.ts`) plus `DebugView.vue` status CSS.
  Remove `drafting` from the same status arrays, columns, explanations, icons,
  lifecycle phase union, child-count seeds, and CSS. Session-status `active` and
  UI `.active` classes are unrelated and untouched.
- **Docs.** Rewrite `docs/agents.md` §4.2 status list and the activate_card
  transition table to remove `active` and `drafting`; card creation defaults to
  `backlog`.
- **Tests/fixtures.** Update `tests/runtime/transition-policy.test.ts`,
  `tests/runtime/state-machine.test.ts`, direct `PlannerToolsService.activateCard`
  tests, and the web/runtime fixtures that default cards to `status: 'active'`
  or `status: 'drafting'` to use `backlog`/`running`; update enum-contract
  fixtures so removed statuses are not listed as accepted values.

### 1.3 Why first

The propagation logic (Part 2) reasons about "resting vs running"; removing
`active` and `drafting` makes that dichotomy exact (resting = `backlog`,
`blocked`, `changed`, terminals; running = on the live stack). Doing it first
means Part 2 never has to special-case phantom/preparatory states.

## 2. Part 2 — Analyst `changed` propagation up the ancestor path

### 2.1 State machine (D3)

Add terminal->`changed` transitions to `VALID_TRANSITIONS`
([`src/cards/lifecycle.ts`](../../../src/cards/lifecycle.ts)):

```
done:      [backlog, cancelled, changed]
failed:    [backlog, cancelled, changed]
cancelled: [backlog, changed]
```

`blocked -> changed` and `running -> changed` already exist. `changed` stays
non-terminal (`isTerminalState` unchanged = `{done, failed, cancelled}`), so a
`changed` card keeps blocking its parent's completion gate (§2.4).
`buildSetStatusLifecycle` already produces the `changed` lifecycle, and
`setStatus` accepts `changed` as a target (it refuses only `done`/`failed`),
so `setStatus(id, 'changed')` works from every resting source once the
transitions above are legal.

Note on re-activation (correct mechanism): re-activating a `changed` goal does
**not** use a direct `changed -> running` step.
`selectActivationStartAction('changed', 'planner')` returns `start` (`changed`
is startable), and after Part 1 the start plan is `changed -> running`
([`transition-policy.ts`](../../../src/runtime/transition-policy.ts);
applied stepwise by
[`state-machine.ts`](../../../src/runtime/state-machine.ts) line 215).
The planner session id is convention-derived as `planner:<goalId>`, and the
required open `runtime_runs` row is created by the parent's `activate_card`
([`planner-control-executor.ts`](../../../src/agents/planner-control-executor.ts)
lines 146-147), so a previously-terminal goal flipped to `changed` re-resumes
with no surviving session and no new code in the activation path. The
planning-field/`retries: 0` reset for a `changed` re-activation already exists
([`planner-activation-runner.ts`](../../../src/runtime/phases/planner-activation-runner.ts)
lines 56-67, gated on `currentStatus === 'changed'`).

Table consequence of removing `active` (Part 1): once the start plan emits a
single `running` step directly (no intermediate `active`), `setStatus` validates
each step against `VALID_TRANSITIONS`
([`lifecycle-commands.ts`](../../../src/cards/lifecycle-commands.ts) line 153),
so the table **must** make `backlog -> running` and `changed -> running` legal.
Those entries are added in Part 1 (the same batch that makes the start plan
direct), so dispatch stays self-consistent. (Before `active` removal the start
plan went `changed -> active -> running` and a direct `changed -> running` entry
was unnecessary; after removal it is required. The earlier-design advice "do not
add `changed -> running`" applied only to the pre-removal mechanism.)

### 2.2 The propagation primitive (runtime-owned)

The primitive belongs under `src/runtime/`, not `src/agents/`, because it
reads the card hierarchy, owns the call-stack-stop rule, flips status via the
`CardStore` lifecycle, and fans notes into `.saivage/runtime/`. New module
`src/runtime/changed-propagation.ts`:

```ts
const FLIPPABLE_RESTING: ReadonlySet<CardStatus> =
  new Set(['done', 'failed', 'cancelled', 'blocked']);

export type ChangeOrigin =
  | { kind: 'analyst_edit'; summary: string }
  | { kind: 'analyst_correction'; issues: AnalystIssue[]; note?: string };

export interface ChangedPropagation {
  flipped: Array<{ card_id: string; previous_status: CardStatus }>;
  stopped_at_running: string | null;
  notified_planner_session_ids: string[];
}

export function propagateChange(
  projectRoot: string,
  store: CardStore,
  editedCardId: string,
  origin: ChangeOrigin,
): ChangedPropagation;
```

Walk and flip:

1. **Path.** `path = [editedCardId, ...nearestFirstAncestors]`, where
   `nearestFirstAncestors = store.getAncestors(editedCardId)` **reversed**.
   `getAncestors` returns **root-first / nearest-last**
   ([`src/cards/state.ts`](../../../src/cards/state.ts) `ancestorsOf` uses
   `unshift`), so the reversal yields nearest-first for the stop-at-first-
   running rule.
2. **Flip walk.** Iterate `path` upward. For each card:
   - status `running`: record `stopped_at_running`, **stop the flip walk**
     (do not flip; do not continue above for flipping).
   - status in `FLIPPABLE_RESTING`: capture `previous_status` from the in-hand
     card, `store.setStatus(card_id, 'changed')` (no-op-safe if already
     `changed`), record in `flipped`.
   - else (`backlog`, `changed`): no flip, continue upward (`backlog` reads
     the fresh objective when next activated; `changed` is already flagged).
3. **Note fan-out.** Independently of where the flip stopped, queue one note
   per planner on the ancestor chain (every goal/project card on `path`,
   including `stopped_at_running` and continuing to the project root, that has
   a live planner session). Flip-stop and note-fan-out are decoupled: flipping
   must respect the call-stack invariant; notification must reach every
   planner whose subtree contains the change.

The note fan-out above the running stop is reachable: by the call-stack model
the chain from the running stop up to the root is a contiguous run of
`running`/`AwaitingChild` planners, each of which drains its queued notes when
it next resumes on child unwind
([`runtime-goal-context.ts`](../../../src/runtime/runtime-goal-context.ts)
lines 28-35). Its value is the explicit `subtree_changed` signal plus the
`previous_status` hint; those planners would replan on unwind regardless, so
the fan-out is a causal aid, not a reachability requirement.

### 2.3 Note shape and routing (D4)

Add an optional `previous_status` to `SyntheticPlannerNote`
([`src/runtime/synthetic-planner-notes.ts`](../../../src/runtime/synthetic-planner-notes.ts)):

```ts
previous_status?: CardStatus; // best-effort causality hint
```

Dedup is **unchanged** (key
`(target_planner_session_id, kind, affected_card_id, summary)`, returns the
existing note on a hit). `previous_status` is therefore first-captured-wins —
an accepted best-effort behavior: the planner always sees the descendant's
current status in `child_card_tree`, so a stale hint across a rapid
same-session re-edit is harmless. No dedup-key change, no refresh logic.

Add a chain router beside the existing single-target one:

```ts
export function findContainingPlannerChain(
  projectRoot: string, store: CardStore, affectedCardId: string,
): Array<{ session: AgentSession; goalId: string }>;
```

It collects, for the affected card (if a goal/project) and each ancestor
goal/project, the live planner session whose `goal_card_id` equals that card,
ordered deepest-first. It preserves the ancestor-scan fallback semantics of
`findDeepestContainingPlanner` (find a planner session for a card even when no
session's `goal_card_id` exactly equals it); `findDeepestContainingPlanner`
becomes `findContainingPlannerChain(...)[0]` for the remaining single-target
callers.

Per chain entry, queue a note:
- `kind`: `subtree_changed` when the entry's goal is an ancestor of the edited
  card; `analyst_note` when the edited card is that planner's own goal (for
  `analyst_edit`); `pending_subtree_correction` additionally for the origin's
  planner in the `analyst_correction` origin (carrying `issues`).
- `affected_card_id = editedCardId`,
  `descendant_card_ids = [editedCardId]` for `subtree_changed`.
- `previous_status` = the edited card's pre-flip status.

`previous_status` is surfaced only through **primary-planner delivery**:
the planner goal-context note projection and the planner-session synthetic-turn
renderer ([`synthetic-planner-notes.ts`](../../../src/runtime/synthetic-planner-notes.ts)
line 83). Synthetic planner notes are not reviewer inputs. Reviewer prompt
construction must neither drain nor render notes targeted at `planner:<goalId>`;
the reviewer evaluates evidence/result state, while the primary planner owns
reacting to analyst/runtime directives.

### 2.4 Completion gate (D5)

Change `collectSubtreeReadinessReasons`
([`src/tools/planner-tools.ts`](../../../src/tools/planner-tools.ts) lines
189-205) to reject any **non-terminal** descendant:

```ts
for (const descendantId of store.getDescendantIds(goalId)) {
  const d = requireCard(store, descendantId);
  if (!isTerminalState(d.status)) {
    reasons.push({ kind: 'descendant_not_terminal', card_id: descendantId, status: d.status });
  }
}
```

`SubtreeReadinessReason` becomes
`{ kind: 'descendant_not_terminal'; card_id: string; status: CardStatus }`.
This is a contract **shape** change (the `kind` literal and `status` type),
not additive — update the type at `planner-tools.ts:28-32`, the producer at
`:198`, the error message at `:446-448` (which currently says "blocked or
changed" and must become "non-terminal"), `docs/agents.md` §8.2, and any
payload consumers reading `descendant_blocking` (a grep shows it is confined
to `planner-tools.ts`; no `tests/`/`web/` consumers today, so §6 must add
coverage). Terminal = `{done, failed, cancelled}`, so `failed` passes and
`backlog`/`running`/`blocked`/`changed`/`needs_verification` block.
This is the linchpin: a `changed` descendant the analyst flipped is
non-terminal, so the parent cannot close until the planner re-activates it or
`cancel_card`s it.

### 2.5 `consumeChangedCardActivation` and the no-deadlock argument

When a planner re-activates a `changed` card,
`consumeChangedCardActivation(projectRoot, cardId)`
([`planner-activation-runner.ts`](../../../src/runtime/phases/planner-activation-runner.ts)
line 31) discards `subtree_changed` notes referencing that card, and the
activation transitions it to `running` (§2.1). Each `changed` ancestor clears
independently when its planner re-activates it; a higher `changed` ancestor
stays `changed` and keeps blocking its own `report_goal_done` until then.

No-deadlock argument (load-bearing, must be tested): a card is flipped only if
it is resting (D1), and the flip walk stops at the first `running` ancestor
(D2). Therefore a flipped-`changed` card is never on the live call stack, so
its owning planner is `Dormant`/`AwaitingChild` and re-activation is always
available. "flipped => not on the live stack => re-activatable" holds.

### 2.6 Surface gating (D7) and caller rewiring

Analyst-invoked `edit_card` and planner-invoked `edit_card` are **separate
dispatch paths**:

- Analyst `edit_card`
  ([`src/tools/analyst-card-tools.ts`](../../../src/tools/analyst-card-tools.ts)
  lines 112-127) is reached only on the analyst surface. Replace its single
  `notifyPlannerOfAnalystAction` call with
  `propagateChange(projectRoot, store, id, { kind: 'analyst_edit', summary })`.
  No internal surface branch is needed.
- Planner `edit_card` routes through
  [`planner-control-executor.ts`](../../../src/agents/planner-control-executor.ts)
  (its own `edit_card` case calling `mutateCard` directly) and is left
  **unchanged** — it never calls the propagation primitive. D7 holds because
  the two paths are distinct functions, not because of a guard.
- `mark_goal_needs_corrections`
  ([`src/agents/analyst-stage6.ts`](../../../src/agents/analyst-stage6.ts))
  delegates to
  `propagateChange(projectRoot, store, goalId, { kind: 'analyst_correction', issues, note })`.
  `markCardChangedForAnalystCorrection` and the bespoke
  `notifyPlannerOfAnalystAction` are deleted (dead code removal).

### 2.7 Active executor leaf (Q3)

If the edited card is the active executor leaf (`running`,
`active_card_run.phase === 'executor'`): per D1 the flip walk does not flip it
(it is `running`). The edit is allowed and persists via `mutateCard`; the note
fan-out reaches the parent planner chain (executors have no note channel, the
parent planner does). When the executor unwinds, the parent planner has the
`subtree_changed` note and re-reads the edited objective. No special-casing
beyond the generic "never flip running" rule.

## 3. Part 3 — Single reviewer + reviewer-completion note check (D9, D6')

### 3.1 Delete the synchronous in-tool reviewer (D9)

Keep the async `RuntimeReviewerDispatcher`
([`src/runtime/runtime-reviewer-dispatcher.ts`](../../../src/runtime/runtime-reviewer-dispatcher.ts))
as the sole reviewer, because it is the only path consistent with "the runtime
is the only dispatcher" ([`docs/agents.md`](../../../docs/agents.md) §2.1), the
activation ledger (`phase:'reviewer'`), restart recovery
(`reviewer_interrupted`), the `Dormant`-planner-during-review lifecycle, and
the `correction_attempts` retry model.

Delete (per `00-investigation-findings.md` Finding C blast radius):

- The reviewer branch in `PlannerToolsService.reportGoalSync`
  ([`src/tools/planner-tools.ts`](../../../src/tools/planner-tools.ts) lines
  467-507), collapsing to the existing plain `acceptReport` commit
  (`:509-517`). Delete `applyReviewerAssessment` (`:543-584`),
  `persistReviewerInvocationBlock` (`:520-541`),
  `writePendingSubtreeCorrectionNotes` (`:609-632`), the
  `reviewer_invocation_failed` error kind (`:26`), and the
  `reviewer`/`maxReviewRetries`/`assessmentIdFactory` fields (`:68-84`,
  `:208-229`). `reportGoalAsync` becomes synchronous `reportGoal`. The
  §8.1/§8.2 evidence and subtree gates (`:443-455`) **stay**.
- The `invokeReviewer` config + `reviewer` closure in
  [`src/agents/planner-control-factory.ts`](../../../src/agents/planner-control-factory.ts)
  lines 22-29, 43-72, with now-unused imports.
- The `reviewer`/`maxReviewRetries`/`assessmentIdFactory` fields in
  [`src/agents/planner-control-executor.ts`](../../../src/agents/planner-control-executor.ts)
  lines 21-23, 53-55.
- The `invokeReviewer`/`maxReviewRetries`/`markSessionWaiting`/
  `markSessionActive` args at
  [`src/agents/agent-adapter.ts`](../../../src/agents/agent-adapter.ts) lines
  155-167.

Keep `AgentAdapter.invokeReviewer` (`:321-333`, the runtime-facing port used
by the async dispatcher) and `PlannerEnvelopeTracker` — minus its now-dead
`changed -> continue` branch
([`src/agents/planner-envelope-tracker.ts`](../../../src/agents/planner-envelope-tracker.ts)
lines 15-22), since `report_goal_done` can no longer return a `changed` card.

`report_goal_done` after deletion: commits the `done` lifecycle via
`acceptReport` -> `repairTerminalLifecycle`; the tracker synthesizes
`status:'done'`; the runtime sees `ready_for_review`
([`src/runtime/phases/planner-phase.ts`](../../../src/runtime/phases/planner-phase.ts)
lines 207-208) and runs the single authoritative review.

### 3.2 Reviewer retry-exhaustion: keep the `blocked` terminal (no `changed` migration)

The sync reviewer had a narrow `attempts > maxReviewRetries -> changed` flip
([`planner-tools.ts`](../../../src/tools/planner-tools.ts) lines 575-581) using
a private `card.retries` counter. That flip is simply **deleted** with the sync
reviewer; it is **not** re-created in the async path. Reason (verified, recorded
in `00-investigation-findings.md` Finding E): the async path never increments
`active_card_run.correction_attempts` (every reference is a read or `0`-seed),
so there is no per-goal review-retry cap at all — the only bound on the
`needs_corrections` resume loop is `MAX_PLANNER_ITERATIONS = 50`
([`runtime-planner-dispatcher.ts`](../../../src/runtime/runtime-planner-dispatcher.ts)
line 79), and iteration-budget exhaustion already commits a terminal **`blocked`**
via `terminateIfNonTerminal` (`:190-206`). That `blocked` terminal is left
unchanged.

A `propagateChange(goal.id, ...)` call here would also be incorrect: the goal is
`running` at the exhaustion point, and per D1 a `running` card is never flipped
(it is recorded as `stopped_at_running`), so it would flip nothing. Implementing
the documented `max_review_retries` semantics (`docs/agents.md` §13) by wiring
`correction_attempts` is a separate, out-of-scope concern recorded as Finding E.

Consequently D3 is satisfied by Part 2 alone: the only producers of a `changed`
flip after this change are the analyst paths through `propagateChange`, all
`setStatus`-based; no `changed` flip uses `repairTerminalLifecycle`. The
`ChangeOrigin` union has exactly two members, both analyst-originated.

### 3.3 Reviewer-completion note check (D6', replaces original D6)

This handles "analyst edited a goal while it was under review", without any
analyst-side `active_card_run` mutation.

The `pass` arm of `handleReviewerAssessmentDecision`
([`src/runtime/phases/reviewer-assessment-handler.ts`](../../../src/runtime/phases/reviewer-assessment-handler.ts))
runs in this order: `commitReviewerPass` (lines 67-75, which transitions the
goal card to `done`), then the unwind/idle branch (lines 76-88), then
`emitGoalCompleted` / `return { kind: 'completed' }`.

The note-check must run **before `commitReviewerPass` (before line 67)** — i.e.
before any `done` commit — because resuming the goal planner on a `done` goal
would be contradictory (goal terminal, yet its planner re-planning). Insert, at
the top of the `pass` arm:

- **Non-consuming peek** of the goal's own pending synthetic notes for session
  `planner:<goalId>`. A new read-only accessor over the synthetic-note queue
  filtered by `target_planner_session_id` is required;
  `drainSyntheticPlannerNotes`
  ([`synthetic-planner-notes.ts`](../../../src/runtime/synthetic-planner-notes.ts)
  lines 62-69) **removes** notes and must **not** be used here. Reviewer prompt
  construction must also not drain these notes: they are planner-owned work
  directives, not reviewer context.
- If the peek finds notes: **do not** call `commitReviewerPass`, **do not**
  unwind/idle. Return `{ kind: 'continue_planner' }` with the goal still
  `running` and the notes still queued. This is the same shape
  `needs_corrections` already returns (lines 101-102 ->
  `runtime-planner-dispatcher.ts:108-109`), so no new transition shape is
  introduced, and the two paths become symmetric (neither commits; both
  `continue_planner` on a `running` goal). On the next planner iteration, the
  planner path drains the queued notes **once**, uses that same drained set to
  infer the resume reason, and renders the same set into the planner goal
  context. This avoids the current bug where `inferResumeReason` can consume
  notes before `buildGoalContextBlock` renders them, and it keeps reviewer
  context construction non-consuming and note-free. The same planner-specific
  single-drain path is used by pause/resume resume-context appending
  (`runtime-pause-resume.ts`), not only by ordinary planner dispatch. The old
  post-prompt `injectQueuedSyntheticPlannerNotes` path is removed or made
  unreachable for planner-context-delivered notes so notes are never delivered
  twice.
- If the peek finds nothing: proceed exactly as today (`commitReviewerPass` ->
  unwind/idle -> `completed`).

`needs_corrections` is unaffected: it already returns `continue_planner` without
committing or draining, so the note-check is only needed on the `pass` arm.

This means: the analyst edits the goal during review and queues a
`subtree_changed`/`analyst_note` (via §2.2 propagation, which does not flip the
`running` goal). The in-flight review completes; on `pass`, the dispatcher sees
the pending note and loops the goal planner back **instead of** committing
`done` and returning a possibly-stale completion to the parent. No
`objective_changed_during_review` enum, no analyst write to `active_card_run`,
no note dropped.

Consequence for the `pass` path: a `pass` is only committed and delivered
upward when the goal has no pending notes for its own planner, guaranteeing the
parent never receives a completion the analyst has already invalidated
mid-review.

### 3.4 Authority edits (`docs/agents.md`)

- §2.1/§7/§10/§16: state the single runtime-owned reviewer; remove any
  implication of a tool-layer reviewer.
- §10: add the reviewer-completion note-check (pending notes for the goal's
  own planner -> resume that planner instead of unwinding).
- §4.2: remove `active`; add `done/failed/cancelled -> changed`; replace
  "ancestors keep their current status" with the resting-ancestor flip +
  stop-at-running + planner-chain fan-out rule.
- §8.2: `descendant_not_terminal`; any non-terminal descendant blocks
  `report_goal_done`.
- §9: optional `previous_status` on `subtree_changed`/`analyst_note` notes.
- §11: ancestor walk + planner-chain fan-out; reconcile the §4.2-vs-§11
  note-routing inconsistency the analysis identified.

## 4. Invariants preserved

- **Runtime is the only dispatcher.** Removing the sync reviewer eliminates
  the sole place an agent-side tool dispatched another agent. The propagation
  primitive flips status and queues notes; it never dispatches an agent.
- **Never flip a `running` card.** Flip walk stops at the first `running`
  ancestor and skips the executor leaf. `active_card_run`/activation-ledger
  semantics, the `activate_card` source-status rule, and startup-repair
  status/lifecycle consistency are unaffected.
- **`report_goal_done` is the only completion path; re-scheduling is
  planner-driven.** The primitive and the note-check never call
  `activate_card`; they hand control to planners.
- **Single source of truth for transitions.** Terminal->`changed` is in
  `VALID_TRANSITIONS`, flips go through `setStatus`, and the reviewer
  exhaustion flip is migrated off `repairTerminalLifecycle`.
- **No-deadlock.** §2.5 argument: flipped => not on live stack =>
  re-activatable.
- **Fail fast.** No defensive recovery: not-found edits fail before
  propagation; ancestors of an existing card must exist (a missing ancestor is
  an impossible state and may throw).

## 5. Edge-case matrix

| Edited card position | Flip? | Notes |
|---|---|---|
| Resting leaf (`done`/`failed`/`cancelled`/`blocked`), planner Dormant | Flip card + resting ancestors; stop at first `running` | Fan-out to all planner ancestors above |
| `backlog` leaf | No flip (reads fresh objective on next activation) | Fan-out notifies owning planner chain |
| Active executor leaf (`running`, phase executor) | No flip | Edit persists; parent planner notified; re-reads on unwind |
| Live ancestor (`running`, AwaitingChild) | No flip; flip walk stops here | Notified; replans next turn |
| Goal under review (`running`, phase reviewer) | No flip | Note queued; reviewer completes; dispatcher resumes goal planner via §3.3 note-check |
| Already `changed` | No-op flip | Note dedup may collapse; harmless |

## 6. Test plan (outline; detailed in the implementation plan)

- Part 1: removing `active` keeps start/restart producing `running`; no
  consumer regresses; transition-policy/state-machine tests updated; web
  exhaustive maps compile.
- Transitions: `done/failed/cancelled -> changed` legal; no illegal pair
  opened; `changed` re-activation goes `changed -> running` via the start plan.
- Propagation walk: resting ancestors flip; first `running` stops the flip;
  notes reach every planner ancestor above the stop; siblings untouched;
  `getAncestors` reversal correctness (deep edit under
  root->A(running)->B(done)->C(done) flips B,C, stops at A, notifies A+root
  planners).
- Completion gate: `report_goal_done` rejected for any non-terminal
  descendant; accepted when all descendants in `{done, failed, cancelled}`.
- No-deadlock: a `changed` ancestor blocks its own `report_goal_done` until
  re-activated; re-activation always available.
- Single reviewer: a real-LLM `report_goal_done` triggers exactly one reviewer
  session (no double review); `report_goal_done` still commits `done` and
  gates; reviewer-interrupt restart recovery still works.
- Reviewer-completion note check: on `pass`, a pending note for the goal's own
  planner causes resume-goal-planner (`continue_planner`, goal stays `running`,
  note NOT committed `done`, note NOT drained) instead of unwind/idle; with no
  pending note, normal `commitReviewerPass` -> unwind/idle. Assert the goal is
  not left `done` while resumed, and the note is still delivered on the resumed
  planner's goal-context drain.
- Non-consuming peek accessor: returns queued notes for `planner:<goalId>`
  without removing them (distinct from `drainSyntheticPlannerNotes`).
- Reviewer iteration-budget exhaustion: still commits terminal `blocked` via
  `terminateIfNonTerminal`; no `changed` flip is introduced on the goal at
  exhaustion.
