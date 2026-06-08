# Functional Analysis: Analyst `changed` Propagation Up the Ancestor Path

## 1. Purpose

This document analyzes how the Saivage v3 analyst currently affects a
running card hierarchy when it edits a card, what state and notification
side effects occur, and where the current behavior diverges from the
required behavior: a `changed` marker that propagates up the **direct
ancestor path** of an edited card, flipping resting ancestors and stopping
at the first live (`running`) ancestor, with explanatory notes delivered to
every live planner above the stop point.

This is a functional analysis only. It establishes facts and the gap. It
does not pick an implementation. It also identifies that the required
behavior **inverts a currently-documented architecture invariant**, so the
gap is partly "missing code" and partly "documented contract says the
opposite" (see §3).

## 2. Domain model facts

### 2.1 Card statuses

The status enum is defined in
[`src/schemas/types.ts`](../../../src/schemas/types.ts) line 4
(`cardStatusValues`):

```
drafting, backlog, active, running, blocked, changed,
done, failed, cancelled, needs_verification
```

Semantics relevant here, per
[`docs/agents.md` §4.2](../../../docs/agents.md):

- `backlog`: not currently active.
- `active`: ready for a planner to choose (not yet started).
- `running`: work is in progress. A goal card is `running` while its planner
  owns the live call stack or is an ancestor of the active leaf.
- `changed`: the card's state was externally modified (by the analyst or by
  a descendant subtree correction) since its planner last saw it. The card
  is not immediately re-activated; the parent planner sees a
  `subtree_changed` note in its next Goal Context and decides whether to
  `activate_card` the affected descendant.
- `done`, `failed`, `blocked`, `cancelled`: terminal-or-resting outcomes.
- `needs_verification`: narrow executor sub-state.

The crucial distinction for this work: **`active` is a resting "not yet
started" status, while `running` denotes a card on the live call stack.**
"Propagate up to the active node" in operator language means "stop at the
first live `running` ancestor", **not** the `active` status. The two are
nearly opposites and must not be conflated.

### 2.2 The valid-transition table

[`src/cards/lifecycle.ts`](../../../src/cards/lifecycle.ts) lines 72-83
(`VALID_TRANSITIONS`), verified exactly:

```
drafting:            [backlog, cancelled]
backlog:             [active, cancelled]
active:              [running, cancelled, backlog]
running:             [done, failed, blocked, changed, cancelled, backlog, needs_verification]
blocked:             [backlog, running, changed, cancelled]
changed:             [backlog, active, cancelled]
done:                [backlog, cancelled]
failed:              [backlog, cancelled]
cancelled:           [drafting]
needs_verification:  [cancelled]
```

Key observations:

- `running -> changed` is legal.
- `blocked -> changed` is legal.
- `done -> changed` is **not** legal.
- `failed -> changed` is **not** legal.
- `cancelled -> changed` is **not** legal (`cancelled` only goes to
  `drafting`).

`isTerminalState` (lines 66-70, 109-111) treats `{done, failed, cancelled}`
as terminal. `blocked` and `needs_verification` are not in that set; they are
"resting but reopenable" states.

### 2.3 How status writes are gated

There are three write paths on
[`CardStore`](../../../src/cards/card-store.ts):

- `setStatus(id, newStatus)` ->
  [`CardLifecycleCommands.setStatus`](../../../src/cards/lifecycle-commands.ts)
  lines 145-162. It refuses `done`/`failed` (those must go through terminal
  commit), calls `validateTransition(card.status, newStatus)` (which throws
  on an illegal step), and builds a fresh lifecycle via
  `buildSetStatusLifecycle`. Therefore `setStatus(id, 'changed')` only works
  from `running` or `blocked` today; from `done`/`failed`/`cancelled` it
  throws `Invalid transition`.
- `mutateCard(id, changes, ctx)` -> `applyPatch` with `validateMutablePatch`
  (lines 203-244). This path is gated by `LIFECYCLE_LOCKED_STATES`
  (`{done, failed, blocked, needs_verification, cancelled}`, lines 38-44):
  for a card in those states, writing the `status`/`lifecycle` fields is
  rejected unless the change "reopens" the lifecycle (target status not in
  `LIFECYCLE_LOCKED_STATES`) or carries an explicit runtime-owned reason.
- `repairTerminalLifecycle(id, changes)` ->
  [`applyPatch`](../../../src/cards/card-patch-service.ts) (lines 35-78) with
  the privileged reason `'terminal lifecycle repair'`. The `applyPatch` path
  routes through `validateMutablePatch`, **not** `validateTransition`, so it
  bypasses the `VALID_TRANSITIONS` table entirely. This is the existing
  escape hatch used to push terminal cards into other states.

Net: the only way today to put a `done` card into `changed` is
`repairTerminalLifecycle`, and there is no path at all that puts a
`cancelled` card into `changed`.

### 2.4 Ancestor / descendant walking primitives, and their ORDER

[`CardStore`](../../../src/cards/card-store.ts) (lines 161-175) exposes
`getParent(id)`, `getAncestors(id)`, and `getDescendantIds(id)`. The card
hierarchy is the durable source of parent/child structure; the runtime never
persists an ancestor chain separately
([`docs/agents.md` §15](../../../docs/agents.md)).

**Ordering fact (must not be gotten wrong by the design):**
`getAncestors` delegates to `CardStoreState.ancestorsOf`
([`src/cards/state.ts`](../../../src/cards/state.ts) lines 73-81), which
climbs from the node's parent upward and prepends each parent with
`ancestors.unshift(current.parent)`. Because `unshift` prepends, the result
is **root-first / nearest-last**: index 0 is the project root (farthest
ancestor) and the last element is the immediate parent.
[`CardReader.getAncestors`](../../../src/cards/reader.ts) returns this
verbatim with no reversal.

Consequence for the required walk: a walk that must "start at the edited card
and stop at the **first** (nearest) `running` ancestor going up" must NOT
iterate `getAncestors` front-to-back (that would visit the root first and
stop at the topmost resting ancestor under a running root, the wrong node).
It must either iterate `getAncestors` in reverse, or use repeated
`getParent` from the edited card upward. The design must state which.

### 2.5 The live call stack and why `running` ancestors are special

Per [`docs/agents.md` §6](../../../docs/agents.md): at most one card-run does
real work. The runtime stores only the leaf in
`RuntimeState.active_card_run`; every ancestor planner up to the project root
is `AwaitingChild` and is derivably so by holding an unresolved
`activate_card` tool call. The breadcrumb from project root to leaf is
`walkParents(leaf.card_id)`. While a card is on this stack, its status is
`running`.

**Caller-edge reconstruction does NOT key on `card.status`.** Per §6 lines
316-339, when the active leaf terminates the runtime resolves which planner
receives the synthesized `tool_result` from the **activation/run ledger**:
the unresolved activation's `parent_run_id` must reference an open
`runtime_runs` planner run for `parent_card_id`. "Normal runtime continuation
uses the activation/run ledger as the authoritative call stack." The
open-run lookup in
[`src/runtime/phases/planner-activation-runner.ts`](../../../src/runtime/phases/planner-activation-runner.ts)
keys on `run.card_id` + run phase, not card status.

Therefore the reason a `running` ancestor must not be flipped to `changed` is
**not** that it breaks caller-edge reconstruction. The real hazards are:

1. **`activate_card` source-status semantics** ([§4.2](../../../docs/agents.md)
   transition table): a `running` card is not a valid activation source; only
   `backlog`/`active`/`changed`/terminal goal cards are. A `running` ancestor
   is mid-`activate_card`, not awaiting selection.
2. **The persisted-state invariant** in
   [`src/runtime/state.ts`](../../../src/runtime/state.ts): an idle runtime
   must not retain a non-terminal running `active_card_run`; the live-leaf /
   `AwaitingChild` model assumes ancestors stay `running`.
3. **Status/lifecycle consistency at startup repair.**
   [`src/runtime/startup-repair.ts`](../../../src/runtime/startup-repair.ts)
   `assertTerminalLifecycleMatchesStatus` throws if
   `card.lifecycle.status !== card.status`. Externally forcing a live
   ancestor's `status` to `changed` while its run/lifecycle still says
   planner-running would create exactly that mismatch.

So the constraint "never flip a live ancestor" is correct; the design must
cite the ledger/`active_card_run` invariants as the reason, not caller-edge
reconstruction.

## 3. The required behavior contradicts current documented authority

This is the single most important non-code fact. The required behavior
(flip resting ancestors to `changed`) **inverts a currently-documented
invariant**, and `docs/agents.md` is additionally **internally
inconsistent** about ancestor notification. Per
[`AGENTS.md`](../../../AGENTS.md) the docs are the architecture authority, so
adopting the required model means rewriting these sections, not just adding
code.

- **§4.2 (lines 191-194)** states: "`changed` can land on any card... Ancestors
  of a `changed` card receive `subtree_changed` notes **but keep their
  current status.**" The required "flip resting ancestors to `changed`"
  directly reverses this.
- **§11 (lines 800-811)** states `mark_goal_needs_corrections` "records
  `pending_subtree_correction` notes on the origin **and ancestor goals** and
  may flip **the origin card** to `changed`." So the documented model is:
  flip only the origin, notify ancestors, ancestors keep status.
- **Internal inconsistency on notification:** §4.2 (lines 183-184) says the
  parent planner "and, recursively, any ancestor" sees a `subtree_changed`
  note, and §11 (lines 806-807) says notes are recorded "on the origin and
  ancestor goals" — both promise ancestor fan-out. But §11 "Note routing"
  (lines 837-843) says a synthetic note "is queued on the session of the
  **deepest** planner whose goal subtree contains the affected card" —
  single-planner — which is what the code actually does (see §4.3).

Implication: the "notes to all live planner ancestors" requirement is
**already half-promised** by §4.2/§11 prose and **contradicted** by the §11
"Note routing" paragraph and the implementation. The design is reconciling a
documented inconsistency plus inverting the §4.2 "ancestors keep status"
invariant — both must be called out as authority edits.

## 4. Current analyst edit behavior

### 4.1 `edit_card`

[`src/tools/analyst-card-tools.ts`](../../../src/tools/analyst-card-tools.ts)
`edit_card` (lines 112-127):

1. Filters the patch to `ALLOWED_EDIT_FIELDS` (line 110; includes `title`,
   `description`, `acceptance`, `status`, `depends_on`, etc.).
2. Calls `store.mutateCard(id, changes, { actor, surface, reason: 'analyst edit' })`.
3. Calls `notifyPlannerOfAnalystAction(projectRoot, store, id, 'analyst edited card fields: ...')`
   (line 123) as a best-effort follow-up.

There is **no ancestor walk** here, and `edit_card` does **not** flip status
to `changed` on its own — it only persists whatever fields the caller
supplied. Only the single edited card is mutated, and a single note is routed
(see 4.3).

Note also `edit_card` is registered with `roles: ['analyst', 'planner']` and
`plannerControl: true` (line 236); a **planner** can call it scoped to a
direct child and may supply `status`. Any new propagation logic must decide
whether it applies to planner-invoked edits or is analyst-surface only.

### 4.2 `mark_goal_needs_corrections`

[`src/agents/analyst-stage6.ts`](../../../src/agents/analyst-stage6.ts)
`markGoalNeedsCorrections` (lines 24-36):

1. Reads the origin goal/project card.
2. Routes **one** `pending_subtree_correction` synthetic note to the deepest
   planner containing the origin (`findDeepestContainingPlanner`, line 28-30).
   `notes_recorded_on_goal_ids` is hard-coded to `[]` (line 35) — so despite
   §11's claim of notes "on the origin and ancestor goals", the code records
   exactly one note (a pre-existing doc/code drift to fix).
3. Calls `markCardChangedForAnalystCorrection(store, originGoalId, status)`
   (lines 38-53), which flips **only the origin card**:
   - `running` or `blocked` -> `store.setStatus(id, 'changed')`.
   - `done` -> `store.repairTerminalLifecycle(id, { status: 'changed', ... })`.
   - any other status (`backlog`, `active`, `failed`, `cancelled`,
     `drafting`, `needs_verification`) -> no flip (returns false).

So `failed` and `cancelled` origins record a note but never flip to
`changed`, and there is no ancestor propagation.

### 4.3 Note routing

[`src/runtime/synthetic-planner-notes.ts`](../../../src/runtime/synthetic-planner-notes.ts):

- `findDeepestContainingPlanner` (lines 33-50) returns the **single** deepest
  planner session whose `goal_card_id` subtree contains the affected card
  (filtering `role === 'planner'`, line 36; with an ancestor-scan fallback if
  no planner session contains it).
- `queueSyntheticPlannerNote` (lines 52-60) persists a `SyntheticPlannerNote`
  (`{ id, target_planner_session_id, target_goal_card_id, kind,
  affected_card_id, descendant_card_ids, summary, created_at }`, lines 10-19)
  to `.saivage/runtime/synthetic-notes.json`, deduplicating on
  `(target_planner_session_id, kind, affected_card_id, summary)`.
- `notifyPlannerOfAnalystAction` (analyst-stage6.ts lines 66-86) picks note
  kind `analyst_note` when the affected card is the planner's own goal, else
  `subtree_changed`.

The note shape carries **no previous status** field. `GoalContextNote` /
`GoalContextCardNode` in [`docs/agents.md` §9](../../../docs/agents.md) (lines
649-672) carry only the descendant's **current** `status` in
`child_card_tree`. So a planner that receives `subtree_changed for card-42`
can see card-42's current status but cannot tell what it was **before** the
change — the required "previous status" is about history/causality, not
current visibility, and is information the operator explicitly called out as
important for previously-cancelled cards.

**The previous status is cheaply available at note-production time.** The
flip-and-notify operation necessarily reads the ancestor's status before
transitioning it (to decide whether it is resting and to choose
`setStatus` vs `repairTerminalLifecycle`). That pre-flip value can be
captured inline and embedded directly in the note, with **no** history
lookup (`getCardAt`) and no coupling to the history reader. Concretely this
means adding a `previous_status: CardStatus` field to `SyntheticPlannerNote`
([`synthetic-planner-notes.ts`](../../../src/runtime/synthetic-planner-notes.ts)
lines 10-19) and to the `subtree_changed`/`analyst_note` `GoalContextNote`
kinds ([`docs/agents.md` §9](../../../docs/agents.md)), populated by the
producer from the status it already holds. The pre-flip status really is in
hand: `markGoalNeedsCorrections` already reads `origin.status` and builds
`status_transition = { from: origin.status, to: 'changed' }`
([`analyst-stage6.ts`](../../../src/agents/analyst-stage6.ts) lines 25, 32-33);
`edit_card` reads `store.read(params.id)` before the mutation and the
notify call ([`analyst-card-tools.ts`](../../../src/tools/analyst-card-tools.ts)
lines 118, 122-123). The planner then sees both the current status (in
`child_card_tree`) and the prior status (in the note), which is the
causality signal it needs ("card-42 was `cancelled`, now flagged `changed`
because its objective changed — reconsider scheduling it").

**Dedup hazard the design must resolve (do not treat capture as the only
hard part).** `queueSyntheticPlannerNote`
([`synthetic-planner-notes.ts`](../../../src/runtime/synthetic-planner-notes.ts)
lines 52-60) deduplicates on
`(target_planner_session_id, kind, affected_card_id, summary)` and on a hit
**returns the existing note unchanged**. A new `previous_status` field is
**not** part of that key, and the `summary` is value-independent — for
`edit_card` it is keyed on the changed field *names*
(`analyst edited card fields: ${Object.keys(changes).join(', ')}`,
`analyst-card-tools.ts:123`), and for `mark_goal_needs_corrections` it is the
joined issue summaries (`analyst-stage6.ts:27`). So two producer calls with
the same field-set / same issues on the same affected card produce an
identical dedup key, and the **first** note's `previous_status` is retained
even if the second producer observed a different prior status. This is reachable, not theoretical. The colliding window is two producer
calls that target the same planner session with the same
`(kind, affected_card_id, summary)` and **no intervening turn of that target
planner session** between them — because that session's queued notes are
drained only when it next iterates
([`planner-phase-runner.ts`](../../../src/runtime/phases/planner-phase-runner.ts)
line 65 unconditionally injects/drains `planner:<goalId>` notes on the next
planner turn). Trace using a descendant edit routed to an ancestor planner
`planner:P` that is **not** itself re-run in the window: the analyst edits a
resting descendant D (currently `cancelled`) of P — the producer captures
`previous_status = cancelled`, flips D to `changed`, and queues a
`subtree_changed` note targeting `planner:P` keyed on the changed field
*names*. Before `planner:P` next iterates, the analyst edits D again touching
the **same field name(s)** while D is now `changed` — the producer would
capture `previous_status = changed`, but the dedup key
`(planner:P, subtree_changed, D, "analyst edited card fields: <names>")`
collides and the deduper returns the original note, retaining the stale
`previous_status = cancelled`. (A same-session repeated-`edit_card` collision
on any card whose owning planner has not resumed between the two edits is the
general form; routing a `subtree_changed` to an ancestor that the edits do
not re-run keeps the note un-drained across both captures.) The motivating
use case (`00-context.md`: "critical for previously `cancelled`/`done`
cards") is exactly where this misfires. The design must therefore choose one
of: include `previous_status` in the dedup key; define that the
first-captured pre-flip status is authoritative and justify it; or change the
deduper so a later flip refreshes the existing note. This conflicts with the
naive "preserve the existing dedup" constraint (§8) and must be reconciled
there.

**Delivery touches two projection sites, not only the types.** Surfacing
`previous_status` to the planner requires editing both delivery paths in
addition to the `SyntheticPlannerNote`/`GoalContextNote` types: the
Goal-Context projection `buildGoalContextNotes`
([`runtime-goal-context.ts`](../../../src/runtime/runtime-goal-context.ts)
lines 28-35), which today projects only
`{ kind, origin_card_id, descendant_card_ids, body, at }`, and the
synthetic-turn renderer
([`synthetic-planner-notes.ts`](../../../src/runtime/synthetic-planner-notes.ts)
line 83), which renders only `kind`, `affected_card_id`, `summary`,
`descendant_card_ids`.

Delivery to the planner: `drainSyntheticPlannerNotes` /
`injectQueuedSyntheticPlannerNotes`
([`src/runtime/runtime-goal-context.ts`](../../../src/runtime/runtime-goal-context.ts)
lines 28-35, 70-74) drain notes for `planner:<goalId>` into the rebuilt Goal
Context and inject them as a synthetic user turn when that planner next
resumes. The resume reason is inferred in
[`src/runtime/goal-context.ts`](../../../src/runtime/goal-context.ts) lines
22-23: `pending_subtree_correction` -> `analyst_directive`; `subtree_changed`
-> `subtree_changed`.

Critically: **only one planner is targeted.** If that planner is `Dormant`
and never re-activates the affected descendant, no ancestor planner above it
ever learns of the change. The upward recursion relied on today is the
planner-driven re-report chain (`activate_card` returns -> parent decides to
re-report), which does not fire if the deepest planner takes no action.

### 4.4 The `changed`-consumption mechanism (a hard design constraint)

When a planner activation begins, the runtime consumes the `changed`
markers/notes for the activated card:
`PlannerActivationRunner.activate`
([`src/runtime/phases/planner-activation-runner.ts`](../../../src/runtime/phases/planner-activation-runner.ts)
line 31) calls `consumeChangedCardActivation(projectRoot, goalId)`. That
delegates to `discardSubtreeChangedSyntheticNotes`
([`src/runtime/synthetic-planner-notes.ts`](../../../src/runtime/synthetic-planner-notes.ts)
lines 71-77, 92-94), which removes `subtree_changed` notes whose
`affected_card_id` **or** `descendant_card_ids` reference the activated card.
The same consumption runs from planner-driven activation
([`src/agents/planner-control-executor.ts`](../../../src/agents/planner-control-executor.ts)
around line 154).

**Why this is a constraint:** the consumption is keyed **per activated
card**. If the required design flips multiple resting ancestors to `changed`
and queues a note for each, then when a planner re-activates one `changed`
descendant, only that card's notes/marker are cleared. The higher flipped
ancestors retain their `changed` status. Worse, a `changed` ancestor will
then **block its own `report_goal_done`** via the acceptance gate (§5,
`descendant_blocking`). The design must specify how an ancestor's `changed`
marker is cleared — e.g. when that ancestor is itself re-activated, or by a
broader consumption rule — or the system will deadlock goals that can never
report done.

### 4.5 Notification queue (separate mechanism)

Every `applyPatch` also enqueues a best-effort `card_changed` notification
([`src/cards/card-patch-service.ts`](../../../src/cards/card-patch-service.ts)
lines 65-76). This is a generic operator-observability notification, not a
planner Goal Context note, and does not wake planners
([`docs/agents.md` §15](../../../docs/agents.md) lines 1057-1058).

### 4.6 A second producer of `changed` on goals (reviewer path)

The analyst is not the only producer of `changed`. The reviewer
retry-exhaustion path also sets a goal to `changed`:
`PlannerToolsService.applyReviewerAssessment`
([`src/tools/planner-tools.ts`](../../../src/tools/planner-tools.ts) lines
575-582) calls `repairTerminalLifecycle(goal.id, { status: 'changed', ... })`
after `attempts > maxReviewRetries`, and `writePendingSubtreeCorrectionNotes`
(lines 609-632) queues a `pending_subtree_correction` to the deepest
containing planner. This matters for §7's "single source of truth for
transitions" constraint: any change to how `... -> changed` is legalized must
account for this existing user of `repairTerminalLifecycle` as well.

## 5. The acceptance gate (completion blocking)

[`src/tools/planner-tools.ts`](../../../src/tools/planner-tools.ts)
`collectSubtreeReadinessReasons` (lines 189-205; reason type lines 28-32;
gate use lines 443-451): on `report_goal_done`, the runtime scans
`getDescendantIds(goalId)` and rejects with a `subtree_not_ready` tool error
if any descendant has status `blocked` or `changed`
([`docs/agents.md` §8.2](../../../docs/agents.md) lines 592-600).

It does **not** reject for descendants in `backlog`, `failed`, `active`, or
`drafting`. So a goal can currently report `done` while it has a `failed`
child or an untouched `backlog` child. The operator's requirement is
stricter: a goal cannot be `done` until every descendant is terminal
(`done`/`cancelled`; the treatment of `failed`/`backlog` is an open
question). Tightening this is a behavior change to
`collectSubtreeReadinessReasons`, not just a policy statement.

## 6. Edge cases (facts, not yet resolved)

The card an analyst edits can be in one of these live positions:

1. **Active executor leaf** (`active_card_run.phase === 'executor'`, card
   `running`). Executors get **no** synthetic-note channel:
   `findDeepestContainingPlanner` filters `role === 'planner'`
   ([`synthetic-planner-notes.ts`](../../../src/runtime/synthetic-planner-notes.ts)
   line 36) and injection targets planner sessions only. An executor session
   is one-shot and in-flight. Flipping the card to `changed` mid-run
   conflicts with the executor terminal contract and the `running`
   call-stack invariant (§2.5).

2. **Goal under review** (`active_card_run.phase === 'reviewer'`). The goal
   card is `running`, its planner session is `Dormant`, and a reviewer is
   judging the goal against its **current** objective. An objective edit now
   makes the in-flight assessment judge stale criteria. There is an existing
   structurally-similar recovery path for an interrupted reviewer: a
   `reviewer_interrupted` synthetic note + a resume
   ([`src/runtime/startup-repair.ts`](../../../src/runtime/startup-repair.ts),
   [`docs/agents.md` §10](../../../docs/agents.md) lines 772-781).
   **Accurate caveat:** the `GoalResumeReason` type
   ([`src/runtime/goal-context.ts`](../../../src/runtime/goal-context.ts)
   lines 3-8) does **not** contain `'reviewer_interrupted'`;
   `inferGoalResumeReason` maps a `reviewer_interrupted` note to
   `'service_restart'` (line 21). So "reuse the reviewer-interrupt path"
   today means "surface as `service_restart`"; a distinct
   `objective_changed_during_review` reason would be a genuinely new enum
   member.

3. **Goal that is a live ancestor** (`running`, `AwaitingChild`). Must not be
   flipped (§2.5); should receive a note so its planner replans on its next
   turn.

4. **Resting descendant under a live ancestor.** The normal
   `subtree_changed` case: flip the resting descendant, notify up to the
   relevant planner(s).

## 7. Gap summary

| Required behavior | Current behavior | Evidence |
|---|---|---|
| Flip the **edited card** to `changed` when resting | `mark_goal_needs_corrections` flips only `running`/`blocked`/`done`; `failed`/`cancelled` never flip. `edit_card` does not flip at all | `analyst-stage6.ts:38-53`; `analyst-card-tools.ts:112-127` |
| Flip **resting ancestors** up the path to `changed` | No ancestor walk exists; and §4.2 documents the opposite ("ancestors keep their current status") | `edit_card`, `markGoalNeedsCorrections`; `docs/agents.md` §4.2 lines 191-194 |
| Stop at first `running` ancestor (nearest) | N/A; note `getAncestors` is root-first, so a naive walk goes wrong direction | `state.ts:73-81` |
| `done/failed/cancelled -> changed` legal | Only via `repairTerminalLifecycle` escape hatch; `cancelled -> changed` impossible by any path | `lifecycle.ts:72-83`; `setStatus` lines 145-162 |
| Notes to **all** live planner ancestors | Single deepest planner only; §4.2/§11 prose promise fan-out but §11 "Note routing" + code do deepest-only | `findDeepestContainingPlanner` lines 33-50; `docs/agents.md` §4.2/§11 |
| Note carries **previous status** | No such field; only current status visible. Prior status is cheaply capturable at flip time (no history lookup), but the dedup key excludes it, so a naive add can retain a stale value; delivery also needs two projection-site edits | `SyntheticPlannerNote` lines 10-19; `queueSyntheticPlannerNote` lines 52-60; `docs/agents.md` §9 |
| Cleared `changed` marker per ancestor on re-activation | Consumption is per-activated-card only | `planner-activation-runner.ts:31`; `synthetic-planner-notes.ts:71-77` |
| Goal `done` blocked until all descendants terminal | Only `blocked`/`changed` descendants block | `collectSubtreeReadinessReasons` lines 189-205 |
| Review-in-progress edit invalidates assessment | Not handled | no analyst-edit hook into reviewer phase |
| Active-executor-leaf edit handled safely | Not handled | no executor note channel |
| `docs/agents.md` §4.2/§11 updated to match | Documents the inverse invariant + is internally inconsistent | `docs/agents.md` §4.2 lines 191-194, §11 lines 800-843 |

## 8. Constraints any solution must respect

- **Call-stack invariant.** Never set a `running` ancestor or the active leaf
  to `changed`. The hazard is corrupting the `active_card_run` / activation
  ledger semantics (§6), the `activate_card` source-status rule, and
  status/lifecycle consistency that startup repair asserts — **not**
  caller-edge reconstruction (which keys on the ledger, not `card.status`).
- **`changed`-consumption interaction.** A multi-ancestor flip must define
  how each ancestor's `changed` marker and note are cleared, given that
  `consumeChangedCardActivation` clears only per re-activated card
  (`planner-activation-runner.ts:31`). Otherwise higher ancestors stay
  `changed` and self-block `report_goal_done` (§4.4, §5).
- **`report_goal_done` is the only completion path.** Re-scheduling of a
  `changed` descendant must remain planner-driven (`activate_card`), per
  [`docs/agents.md` §11](../../../docs/agents.md); the analyst does not
  re-activate cards.
- **Single source of truth for transitions.** If terminal -> `changed`
  becomes a normal transition it belongs in `VALID_TRANSITIONS`, not in the
  `repairTerminalLifecycle` escape hatch — but note the reviewer path
  (§4.6) is a second user of that escape hatch and must stay consistent.
- **Architecture principles** ([`AGENTS.md`](../../../AGENTS.md)): no
  backward-compat shims, no migration code, fail fast on impossible states,
  remove dead code, prefer brave refactoring over symptom patching.
- **Authority edits.** Adopting the required model requires rewriting
  `docs/agents.md` §4.2 ("ancestors keep their current status") and §11
  (origin-only flip; deepest-only note routing) because docs are the
  architecture authority.
- **Idempotence / dedup.** Multiple analyst edits must not multiply notes or
  thrash status; preserve the existing note dedup and the
  `changed`-no-op-if-already behavior. **Caveat:** the existing dedup key
  `(target_planner_session_id, kind, affected_card_id, summary)` excludes any
  new `previous_status` field and returns the existing note on a hit, so
  "preserve dedup" and "carry an accurate previous_status" conflict for
  repeated corrections on the same card (§4.3). The design must pick a
  reconciliation (include `previous_status` in the key, declare
  first-captured authoritative, or refresh on collision) rather than treating
  capture as the only work.

## 9. Open questions for the design

1. Does a `failed` (and/or `backlog`) descendant block parent
   `report_goal_done`? Today `collectSubtreeReadinessReasons` ignores both,
   so requiring "all descendants terminal" is a behavior change. Analysis
   recommendation: block on non-terminal descendants; the `failed` case
   should force an explicit planner decision since `failed` is not a
   deliberate closure the way `cancelled` is.
2. Should terminal -> `changed` become a first-class `VALID_TRANSITIONS`
   entry, or remain routed through the privileged repair path (which the
   reviewer retry-exhaustion path also uses)?
3. For the active-executor-leaf edit: defer the flip until unwind, require the
   analyst to cancel/restart first, or queue the `changed` to apply when the
   leaf terminates?
4. For the review-in-progress edit: reuse the `reviewer_interrupted` path
   (which surfaces as `service_restart` today), or introduce a dedicated
   `objective_changed_during_review` resume reason (a new
   `GoalResumeReason` enum member)?
5. Where does the ancestor-walk-and-flip logic live so it is shared by
   `edit_card`, `mark_goal_needs_corrections`, and any future analyst
   objective mutation — and does it also apply to planner-invoked `edit_card`
   (which can also pass `status`), or is it analyst-surface only?
6. How does an ancestor's `changed` marker get consumed so a `changed`
   ancestor does not permanently self-block `report_goal_done`? (The most
   important unasked design question; ties to §4.4.)
7. Is the project deliberately rewriting `docs/agents.md` §4.2/§11 to invert
   the "ancestors keep their current status" invariant and to resolve the
   §4.2-vs-§11-note-routing inconsistency? (Required given docs are
   authority.)
