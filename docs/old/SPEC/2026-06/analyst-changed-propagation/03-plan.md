# Implementation Plan: Analyst `changed` Propagation, `active` Removal, Single Reviewer

This plan sequences the approved design into batches. Foundational/transversal
changes (state-model, schema) go first; the analyst-feature and reviewer
changes build on them. Each batch lists files, the change, validation, and
rollback. Validation commands are from `saivage-v3` repo root unless noted.

Reference decisions: D1-D10 in `00-context.md`. Reference design: `02-design.md`.
Findings: `00-investigation-findings.md`.

## Validation commands (used throughout)

```bash
npm run typecheck
npm test                          # root Jest (tests/)
npm run build
cd web && npm test                # Vitest (web/src/__tests__)
npm run validate:routine
npm run validate:ui-smoke
npm run docs:verify
```

Use focused Jest/Vitest first per batch, then broaden. Do not mark a batch
done until its validation passes.

## Ordering rationale

1. **Batch A — remove `active` and `drafting`** is the deepest transversal
   change (status enum, transition table, permissions, ~9 consumers, web,
   fixtures). Doing it first means every later batch reasons about the final
   state set.
2. **Batch B — terminal->`changed` transitions + completion gate** are small
   state-machine/contract changes the propagation depends on.
3. **Batch C — propagation primitive + analyst rewiring** is the core feature.
4. **Batch D — delete sync reviewer** is an independent deletion; sequenced
   after A-C so the feature tests are green first, but it does not depend on
   them.
5. **Batch E — reviewer-completion note-check** depends on D (single reviewer)
   and C (notes exist).
6. **Batch F — docs** last, reflecting the final code.

Batches A-B touch `src/cards/lifecycle.ts` and `src/runtime/transition-policy.ts`;
keep them sequential (shared files). C-E are largely disjoint from A-B files.

---

## Batch A — Remove the redundant `active` status and the unused `drafting` status (D8, D10)

### Files and changes

1. **`src/schemas/types.ts`** (line 4): remove `'active'` and `'drafting'` from
   `cardStatusValues`.
2. **`src/schemas/lifecycle.ts`** (lines 86, 88, 191, 193): remove the
   `{ status: 'drafting' }` / `{ status: 'active' }` lifecycle union members and
   their zod literals in
   `cardLifecycleStateSchema`. Confirm `validatePersistedCardLifecycle`
   (line 220) and `cardLifecycleStateSchema` (190-201) still compile.
3. **`src/tools/tool-catalog.ts`** (lines 8-18): remove `'active'` and
   `'drafting'` from the
   hardcoded `RUNTIME_CARD_STATUS_VALUES` tuple (the `as [...]` assertion).
   This feeds `runtimeCardStatusSchema` (line 54).
4. **`src/cards/lifecycle.ts`** (`VALID_TRANSITIONS`, lines 72-83): delete the
   `drafting:` and `active:` rows. Because item 5 makes the start plan emit a
   single `running` step directly from `backlog`/`changed`, and `setStatus`
   validates each step against the table (`lifecycle-commands.ts:153`), the
   table **must** make `backlog -> running` and `changed -> running` legal. Set:
   ```
   backlog: [running, cancelled]
   changed: [backlog, running, cancelled]
   cancelled: [backlog]
   ```
   (Terminal `-> changed` entries are added in Batch B, not here.) Remove the
   `drafting` and `active` cases in `buildSetStatusLifecycle` (lines 133-139
   grouping).
   Also update `FULL_EDIT_STATES` (line 36) from `['drafting','backlog']` to
   `['backlog']`; after removing `drafting`, backlog is the only full-edit
   resting state.
   This supersedes the stale `02-design.md` note "do not add `changed -> running`",
   which applied only to the pre-`active`-removal mechanism.
5. **`src/runtime/transition-policy.ts`**:
   - Start/restart plans (lines 56-68): remove the `drafting` start case, drop
     the `'active'` element, and make each remaining path end at `running`
     directly (e.g. `backlog: accept(['running'])`; `cancelled` restart becomes
     `accept(['backlog', 'running'])`).
   - Delete the `from === 'active'` branches in the block/complete/fail/
     reviewer_repair_resume/crash_recovery cases (lines 80, 84, 91, 109, 113).
   - Delete the `from === 'drafting'` fail branch (line 93).
   - Delete the `active`-only executor branch in `selectActivationStartAction`
     (line 23).
   - Drop the `active` disjunct from the planner `none/already_active` guard
     (line 26).
6. **`src/runtime/state-machine.ts`**: no logic change — the step loop (line
   215) simply applies shorter plans. Verify no `active` literal is referenced.
7. **`src/permissions/card-permissions.ts`**: remove `'active'` from
   `PLANNER_MUTABLE_STATES` (line 26) and remove `'drafting'` from
   `STARTABLE_STATES` (line 29). Recompute-derived `NOT_*` sets are automatic.
8. **`src/tools/planner-tools.ts`**: delete `activateCard` (line 256) outright;
   in `restartCard` (line 335) drop the trailing `setStatus(_, 'active')` so it
   rests at `backlog` after the `repairTerminalLifecycle(_, 'backlog')`; drop
   the `active` disjunct in the `card_already_active` guard (line 241). Do not
   preserve a replacement helper; dispatch owns activation.
9. **`src/tools/analyst-card-tools.ts`**: default `create_card` status to
   `backlog` instead of `drafting` (line 104) and update the tool description
   (line 235). Remove `drafting` from analyst/planner card-status schemas via
   item 1/3.
10. **Consumer reads — drop `active`/`drafting` disjuncts:**
   `src/runtime/crash-recovery.ts:21`,
   `src/runtime/startup-blocked-planning.ts:9`,
   `src/runtime/phases/executor-evidence.ts:167`,
   `src/runtime/phases/planner-phase.ts:279-280` (and `:314`
   `buildProjectPlannerRetryPatch` -> set `running` or rely on dispatch),
   `src/tools/analyst-subtree-tools.ts:50`,
   `src/tools/analyst-tool-helpers.ts:62`.
11. **Web UI:**
     `web/src/stores/card-presentation.ts` (`CARD_STATUSES`),
     `web/src/components/cards/CardsBoardView.vue` (`STATUS_ORDER`),
     `web/src/components/cards/CardDetailView.vue` (`statusExplainer` map,
     `counts.active + counts.running` -> `counts.running`, `.status-active` CSS),
     `web/src/components/cards/CardsTimelineView.vue` (status icon map, CSS),
     `web/src/components/cards/CardsTreeView.vue` (`.status-active` CSS),
     `web/src/views/DebugView.vue` (`.s-drafting` status CSS),
     `web/src/stores/card-detail-view-model.ts` (`active: 0` seed,
     `hasActiveChildren` disjunct). Remove `drafting` from the same status
     arrays/columns/explainers/icons/lifecycle phase union/count seeds/CSS.
     Leave session-status `active` and UI `.active` tab/nav classes untouched.
12. **Tests/fixtures:** `tests/runtime/transition-policy.test.ts`,
     `tests/runtime/state-machine.test.ts` (the `cases` table asserting
     `['active','running']` sequences, `drafting` start/restart cases, and the
     block/fail-from-active/drafting rows),
     `tests/agents/agent-adapter-planner-tools.test.ts` (remove the direct
     `service.activateCard(...)` test at lines 268-275), and **every**
     test/fixture defaulting a card to `status: 'active'` or `status: 'drafting'`.
     Update enum-contract fixtures such as
     `tests/contracts/actionable-error-contract.test.ts` so removed statuses are
     not listed as accepted values.
     Do not rely on a named subset — sweep exhaustively:
     `rg "status: ?['\"](active|drafting)['\"]|\bdrafting\b" tests web/src`
     and update each to
     `backlog` or `running` per intent. Known examples include
     `tests/.../card-store.test.ts` and several `web/src/__tests__/*`
     child-order/read-model fixtures, but treat the grep result as
     authoritative.
13. **Source/docs removed-status sweep:** run and resolve a source-wide sweep:
    `rg "\b(active|drafting)\b" src tests web/src docs/agents.md`.
    Explicitly review false positives for session status (`SessionStatus =
    'active'`), runtime `active_card_run`, CSS `.active` UI classes, and prose
    using "active" in the ordinary English sense. No card-status `drafting` or
    card-status `active` literal should remain.

### Validation

```bash
npm run typecheck            # catches the tuple/exhaustive-map breakages
npm test -- tests/runtime/transition-policy.test.ts tests/runtime/state-machine.test.ts
npm test
cd web && npm test
npm run build
```

TypeScript exhaustiveness (`statusExplainer`, status-icon maps,
`RUNTIME_CARD_STATUS_VALUES` tuple) will force-surface any missed site.

### Rollback

Revert the batch commit. No backward-compatibility shim is included; this plan
intentionally removes `active`/`drafting` from the schema and updates fixtures
and defaults in the same batch.

### Commit

`F-statuses: remove redundant active and unused drafting card statuses`

---

## Batch B — Terminal->`changed` transitions and completion gate (D3 partial, D5)

### Files and changes

1. **`src/cards/lifecycle.ts`** (`VALID_TRANSITIONS`): add `changed` to the
   `done`, `failed`, and `cancelled` target lists:
   ```
   done:      [backlog, cancelled, changed]
    failed:    [backlog, cancelled, changed]
    cancelled: [backlog, changed]
   ```
   `blocked -> changed` and `running -> changed` already exist; `isTerminalState`
   stays `{done, failed, cancelled}` (no change). `setStatus` already accepts
   `changed` as a target and `buildSetStatusLifecycle` already builds it.
2. **`src/tools/planner-tools.ts`** completion gate:
   - `SubtreeReadinessReason` type (lines 28-32): change to
     `{ kind: 'descendant_not_terminal'; card_id: string; status: CardStatus }`.
   - `collectSubtreeReadinessReasons` (lines 189-205): reject any descendant
     where `!isTerminalState(descendant.status)`.
   - The `subtree_not_ready` error message (lines 446-448): change "blocked or
     changed" to "non-terminal".
   - Import `isTerminalState` from `../cards/lifecycle.js` if not already.

### Validation

```bash
npm run typecheck
npm test -- tests/cards   tests/runtime   # transition + gate coverage
npm test
```

Add focused tests: `done/failed/cancelled -> changed` legal; gate rejects each
non-terminal descendant status and accepts `{done, failed, cancelled}`.

### Rollback

Revert the batch commit. The transition additions are purely permissive; the
gate change is the only behavior change and is self-contained.

### Commit

`F-changed-gate: allow terminal->changed transitions; reject non-terminal descendants in report_goal_done`

---

## Batch C — Propagation primitive and analyst rewiring (D1, D2, D4, D7)

### Files and changes

1. **`src/runtime/synthetic-planner-notes.ts`:**
   - Add `previous_status?: CardStatus` to `SyntheticPlannerNote` (lines 10-19).
   - Add `findContainingPlannerChain(projectRoot, store, affectedCardId)`
     returning `Array<{ session; goalId }>` deepest-first, preserving the
     ancestor-scan fallback of `findDeepestContainingPlanner`; redefine
     `findDeepestContainingPlanner` as `findContainingPlannerChain(...)[0]` for
     remaining single-target callers.
   - Add a **non-consuming** `peekSyntheticPlannerNotes(projectRoot, sessionId)`
     read-only accessor (used by Batch E) returning queued notes for the
     session without removing them.
   - Update the renderer (line 83) to include `previous_status` when present.
2. **`src/runtime/changed-propagation.ts`** (new module):
   ```ts
   const FLIPPABLE_RESTING = new Set<CardStatus>(['done','failed','cancelled','blocked']);
   export type ChangeOrigin =
     | { kind: 'analyst_edit'; summary: string }
     | { kind: 'analyst_correction'; issues: AnalystIssue[]; note?: string };
   export interface ChangedPropagation { flipped: ...; stopped_at_running: string|null; notified_planner_session_ids: string[]; }
   export function propagateChange(projectRoot, store, editedCardId, origin): ChangedPropagation;
   ```
   - Path = `[editedCardId, ...store.getAncestors(editedCardId).reverse()]`
     (`getAncestors` is root-first; reverse -> nearest-first).
   - Flip walk: stop at first `running` (record `stopped_at_running`); flip
     `FLIPPABLE_RESTING` via `store.setStatus(id, 'changed')` capturing
     `previous_status`; skip `backlog`/`changed`.
   - Note fan-out via `findContainingPlannerChain(editedCardId)` over the full
     chain (independent of the flip stop), kind `subtree_changed` for ancestors,
     `analyst_note` when the edited card is that planner's own goal, plus a
     `pending_subtree_correction` (with `issues`) for the origin planner in the
     `analyst_correction` origin. Populate `previous_status`.
3. **`src/runtime/runtime-goal-context.ts`** (lines 28-50): make synthetic notes
   explicitly planner-owned.
   - Stop draining synthetic planner notes from generic `buildGoalContextBlock`.
     Reviewer code calls this method, so it must not consume or render notes
     targeted at `planner:<goalId>`.
   - Add a planner-specific path (for example
     `buildPlannerGoalContext(goalId, fallbackResumeReason)`) that drains
     `planner:<goalId>` notes exactly once, projects `previous_status` into the
     note payload, infers the resume reason from that same drained set, and
     renders that same set into the planner goal context.
   - Keep reviewer context note-free: reviewer prompts see evidence/card state,
     not planner directives.
4. **`src/runtime/phases/planner-phase-runner.ts`** and
   **`src/runtime/phases/planner-iteration-runner.ts`**: replace the current
   sequence `inferResumeReason(...)` then `buildGoalContextBlock(...)` (which
   can consume notes before rendering them) with the planner-specific context
   builder from item 3, returning both `{ resumeReason, goalContext }` from one
   single drain. Remove the post-prompt `injectSyntheticPlannerNotes` call or
   make it unreachable/no-op for planner-context-delivered notes; notes must not
   be delivered through two mechanisms. Keep `ReviewerPhaseRunner` on the
   generic `buildGoalContextBlock` path so reviewer prompts remain note-free.
5. **`src/runtime/runtime-pause-resume.ts`** (lines 37-42): replace the current
   resume sequence `inferResumeReason(...)` -> `appendPlannerResumeContext(...)`
   -> `injectQueuedPlannerNotes(...)` with the same planner-specific single-drain
   context builder from item 3. Pause/resume must append a planner resume context
   that includes pending `planner:<goalId>` notes exactly once, and reviewer
   context must remain note-free.
6. **`src/tools/analyst-card-tools.ts`** `edit_card` (lines 112-127): replace
   the `notifyPlannerOfAnalystAction` call with
   `propagateChange(ctx.projectRoot, store, id, { kind: 'analyst_edit', summary })`.
   Reached only on the analyst surface; no surface branch needed.
7. **`src/agents/analyst-stage6.ts`:** delete `markCardChangedForAnalystCorrection`
   and `notifyPlannerOfAnalystAction`; `markGoalNeedsCorrections` delegates to
   `propagateChange(projectRoot, store, goalId, { kind: 'analyst_correction', issues, note })`.
   Keep `normalizeAnalystIssues` and the issue schema.
8. **`docs/agents.md` §9:** add optional `previous_status` to the
   `subtree_changed`/`analyst_note` `GoalContextNote` kinds. (Other doc edits in
   Batch F.)

### Validation

```bash
npm run typecheck
npm test -- tests/runtime tests/agents tests/tools
npm test
```

Add tests: walk flips resting ancestors, stops at first `running`, notifies the
full planner chain, siblings untouched; `getAncestors` reversal correctness
(root->A(running)->B(done)->C(done), edit under C -> flips C,B, stops at A,
notifies A+root); `previous_status` captured; no-deadlock (`changed` ancestor
blocks its own `report_goal_done` until re-activated); planner-invoked
`edit_card` does not trigger the walk (D7); reviewer context building does not
drain or render `planner:<goalId>` notes; planner context drains notes once and
uses the same notes for both resume-reason inference and prompt rendering;
pause/resume with pending planner notes appends a resume context containing
those notes exactly once.

### Rollback

Revert the batch commit. `notifyPlannerOfAnalystAction` and
`markCardChangedForAnalystCorrection` are restored from git; the new module is
removed.

### Commit

`F-propagation: analyst objective edits flip resting ancestors to changed and fan notes to the planner chain`

---

## Batch D — Delete the synchronous reviewer (D9)

Independent of A-C; sequence after them so feature tests are green, but it has
no dependency on them.

### Files and changes

1. **`src/tools/planner-tools.ts`:** delete the reviewer branch in
   `reportGoalSync` (lines 467-507), collapsing to the existing plain
   `acceptReport` commit (509-517). Delete `applyReviewerAssessment` (543-584),
   `persistReviewerInvocationBlock` (520-541),
   `writePendingSubtreeCorrectionNotes` (609-632), the
   `reviewer_invocation_failed` error kind (line 26), and the
   `reviewer`/`maxReviewRetries`/`assessmentIdFactory` fields (68-84, 208-229).
   **Consolidate the report methods:** there is a pre-existing synchronous
   `reportGoal` (lines 408-421, which throws if the reviewer returns a Promise)
   and `reportGoalAsync` (line 423). With the reviewer gone, both are now purely
   synchronous; collapse to a single synchronous `reportGoal` and delete
   `reportGoalAsync`. Keep the §8.1/§8.2 gates (443-455). Remove now-unused
   imports (`createReviewerContract`/`buildReviewerPrompt`/reviewer types) if
   local.
2. **`src/agents/planner-control-executor.ts`** (line 240): update the sole
   caller `await plannerTools.reportGoalAsync(...)` to call the consolidated
   `reportGoal(...)` (the `await` on a now-synchronous return is harmless). Also
   (lines 21-23, 53-55) remove `reviewer`/`maxReviewRetries`/`assessmentIdFactory`
   from the execution context and `createService()`.
3. **`src/agents/planner-control-factory.ts`** (lines 22-29, 43-72): delete the
   `invokeReviewer` config field and the `reviewer` closure; remove now-unused
   imports.
4. **`src/agents/agent-adapter.ts`** (lines 155-167): remove the
   `invokeReviewer`/`maxReviewRetries`/`markSessionWaiting`/`markSessionActive`
   args from the `createPlannerControlExecutor` call. **Keep**
   `AgentAdapter.invokeReviewer` (lines 321-333) — it is the runtime-facing port
   the async dispatcher uses.
5. **`src/agents/planner-envelope-tracker.ts`** (lines 15-22): delete the
   now-dead `changed -> continue` branch in `synthesizeReportGoalEnvelope`
   (`report_goal_done` can no longer return a `changed` card after this batch).

### Validation

```bash
npm run typecheck
npm test -- tests/agents tests/runtime
npm test
npm run build
```

Add/adjust tests (the plan MUST update these — they are hard-wired to the sync
reviewer and will otherwise fail):

- `tests/agents/agent-adapter-reviewer-prompt.test.ts`: it asserts the sync
  reviewer fires inside `invokePlanner`. Invert it to assert **no** inline
  reviewer, and that `report_goal_done` returns `{status:'done'}` which then
  drives the single async review.
- `tests/agents/planner-control-executor.test.ts`: 4 tests are coupled to the
  injected `reviewer`/`maxReviewRetries` and the sync-review result handling
  (pass/needs_corrections/exhaustion-`changed`). Update/remove them to reflect
  that `report_goal_done` now only commits the terminal lifecycle and gates;
  the reviewer no longer runs in this layer.
- Confirm reviewer-interrupt restart recovery tests still pass.

### Rollback

Revert the batch commit. The sync reviewer wiring is restored from git. Note
this would reintroduce the double-review bug, so prefer fixing forward.

### Commit

`F-reviewer: delete the vestigial synchronous in-tool reviewer; the runtime dispatcher is the sole reviewer`

---

## Batch E — Reviewer-completion note check (D6')

Depends on D (single reviewer) and C (notes + `peekSyntheticPlannerNotes`).

### Files and changes

1. **`src/runtime/phases/reviewer-assessment-handler.ts`** `pass` arm (the
   `if (input.decision.kind === 'pass')` block, lines 53-92): at the **top of
   the block, before `commitReviewerPass` (line 67)**, add a non-consuming peek
   of the goal's own planner notes:
   ```ts
   const pending = peekSyntheticPlannerNotes(projectRoot, `planner:${input.goalId}`)
     .filter((n) => n.kind === 'subtree_changed' || n.kind === 'analyst_note' || n.kind === 'pending_subtree_correction');
   if (pending.length > 0) {
     return { kind: 'continue_planner' };  // do NOT commit pass, do NOT unwind; goal stays running, notes stay queued
   }
   ```
    The kind filter excludes the restart-only `reviewer_interrupted` (N6
    hardening). `peekSyntheticPlannerNotes` does not remove the notes; the
    resumed planner-specific context path from Batch C drains and delivers them.
   - This requires `projectRoot` and the peek accessor in the handler's
     `effects`/dependencies. The async dispatcher already holds
     `this.deps.projectRoot`
     (`src/runtime/runtime-reviewer-dispatcher.ts:46`), so thread it (and the
     peek) into `ReviewerAssessmentEffects` and pass it at the
     `handleReviewerAssessmentDecision` call site
     (`src/runtime/runtime-reviewer-dispatcher.ts:121-146`). Adding a field to
     `ReviewerAssessmentEffects` is a contract change to that interface
     (`reviewer-assessment-handler.ts:8-18`).
2. **`tests/runtime/reviewer-assessment-handler.test.ts`:** changing
   `ReviewerAssessmentEffects` breaks the test harness. Update the `testEffects`
   default object and the ~6 call sites that construct effects to supply the new
   `projectRoot` + peek dependency (a stub returning `[]` by default). This is
   required for the batch to compile its tests.
3. The `needs_corrections` and `invalid_pass` arms already return
   `continue_planner` without committing; no change.

### Validation

```bash
npm run typecheck
npm test -- tests/runtime
npm test
```

Add tests: on `pass` with a pending analyst note for `planner:<goalId>`, the
handler returns `continue_planner`, the goal is **not** committed `done`, the
note is **not** drained (peek), and the resumed planner-specific context path on
the next iteration drains and sees it; reviewer prompt/context construction does
not drain or render the planner note; on `pass` with no pending note, normal
`commitReviewerPass` -> unwind/idle; a `reviewer_interrupted` note alone does
not trigger the resume (kind filter).

### Rollback

Revert the batch commit. The handler returns to unconditional commit+unwind.

### Commit

`F-review-notecheck: on review pass, resume the goal planner instead of unwinding when its planner has pending analyst notes`

---

## Batch F — Documentation (`docs/agents.md`)

### Changes

- §4.2: remove `active` from the status list and the activate_card transition
  table; add `done/failed/cancelled -> changed`; replace "ancestors keep their
  current status" with the resting-ancestor flip + stop-at-first-running +
  planner-chain fan-out rule.
- §8.2: `SubtreeReadinessReason` -> `descendant_not_terminal`; any non-terminal
  descendant blocks `report_goal_done`.
- §9: optional `previous_status` on `subtree_changed`/`analyst_note` notes.
- §9/§10: synthetic planner notes are primary-planner directives only. Reviewer
  goal context must not drain or render notes queued for `planner:<goalId>`.
- §2.1/§7/§10/§16: state the single runtime-owned reviewer; remove any
  tool-layer-reviewer implication.
- §10: add the reviewer-completion note-check (pending analyst notes for the
  goal's own planner -> resume that planner instead of unwinding).
- §11: ancestor walk + planner-chain fan-out; reconcile the §4.2-vs-§11
  note-routing inconsistency.
- §13 (optional): add a note that `max_review_retries`/`correction_attempts`
  are currently not enforced in the live path (Finding E), or scope it to a
  separate follow-up.

### Validation

```bash
npm run docs:verify
npm run validate:routine
```

`docs:verify` also re-checks the agent tool matrix against
`role-tool-policy.ts`; confirm the analyst/planner tool lists still match after
the `analyst-stage6`/`planner-tools` edits.

### Rollback

Revert the batch commit.

### Commit

`F-docs: update agents.md for active removal, changed propagation, single reviewer, and the gate change`

---

## Final full-suite gate (after all batches)

```bash
npm run typecheck
npm test
npm run build
cd web && npm test
npm run validate:routine
npm run validate:ui-smoke
npm run validate:release
npm run docs:verify
```

Then optionally exercise a live deployment per the saivage-development-validation
skill (analyst edits a resting card under a running subtree; confirm the chain
flips to `changed`, the planner chain receives notes, and `report_goal_done` is
blocked while a `changed` descendant exists).

## Cross-batch invariants to re-assert in tests

- No card is ever persisted in `active` (grep tests/fixtures after Batch A).
- A `running` card is never set to `changed` by the propagation primitive.
- Exactly one reviewer session per passing goal (no double review).
- Reviewer prompt/context construction never drains or renders synthetic planner
  notes; those notes are delivered only to the primary planner.
- A `pass` is never committed `done` while the goal's planner has pending
  analyst notes.
- Iteration-budget exhaustion still commits `blocked`, not `changed`.
- `correction_attempts` remains unincremented (documented gap; not changed
  here).

## Out of scope (recorded, not implemented)

- Implementing the documented `max_review_retries` / `correction_attempts`
  per-goal review cap (Finding E).
- Any analyst-side mutation of `active_card_run` (explicitly avoided by D6').
