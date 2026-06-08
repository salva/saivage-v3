# Adversarial Verification — 02-design.md (round 3)

Scope: verify the four prior BLOCKING fixes (B1–B4) and the five non-blocking
items (N1–N5) are now correctly addressed against actual source, that the fixes
introduced no new errors, and (per request) whether the §3.3 peek needs note
kind-filtering. Already-confirmed-correct claims from round 2 are not
re-litigated except where a fix could have regressed them. All file:line
citations below were read directly from the tree.

Outcome: **B1–B4 are all correctly fixed; N1–N5 are all captured; no new
correctness error was introduced.** One genuinely new, non-blocking
observation about the peek's kind scope is recorded (N6). Approving.

---

## BLOCKING

None.

---

## Verification of prior BLOCKING items (now fixed)

### B1 — note-check moved BEFORE `commitReviewerPass`; pass not committed when notes exist ✓ FIXED

- **Source reality.** `reviewer-assessment-handler.ts`: the genuine `pass`
  decision is the `if (input.decision.kind === 'pass')` block at lines 53–92.
  Inside it: `await commitReviewerPass(...)` at lines 67–75 (which calls
  `transitionCard(id, 'complete', ...)` and writes the `done` lifecycle —
  `terminal-commit/commit-reviewer.ts:19–23`), then the unwind/idle branch at
  76–88, then `emitGoalCompleted` (89) and `return { kind: 'completed' }` (91).
  Confirmed `commitReviewerPass` is at ~67–75 *before* the unwind ~76–88.
- **Design reality.** §3.3 line 426 now states the note-check must run
  **"before `commitReviewerPass` (before line 67)"**. Lines 421–424 cite the
  pass-arm order correctly (`commitReviewerPass` lines 67–75, then unwind/idle
  76–88, then `emitGoalCompleted`/return). Lines 440–442: when the peek finds
  notes, **"do not call `commitReviewerPass`, do not unwind/idle. Return
  `{ kind: 'continue_planner' }` with the goal still `running`"** and explicitly
  declares symmetry with `needs_corrections` (neither commits; both
  `continue_planner` on a `running` goal). The prior "76–91" mis-citation of the
  pass-commit is gone (grep for `76-91`/`76–91`: no match).
- **Verdict.** The real correctness bug (goal committed `done` while its planner
  is resumed) is eliminated. The fix is now correct.

### B2 — non-consuming peek required; draining forbidden in the handler ✓ FIXED

- **Source reality.** `drainSyntheticPlannerNotes`
  (`synthetic-planner-notes.ts:62–69`) filters out and rewrites the queue — it
  **removes** the matched notes. No non-consuming accessor exists today. The
  resumed planner's only delivery path drains the same queue
  (`runtime-goal-context.ts:28–35` `buildGoalContextNotes` →
  `drainSyntheticPlannerNotes`, invoked from `planner-phase-runner.ts:28,65`),
  so a pre-emptive drain in the handler would silently drop the note.
- **Design reality.** §3.3 lines 431–439 require a **"Non-consuming peek … A new
  read-only accessor over the synthetic-note queue filtered by
  `target_planner_session_id` is required"** and explicitly: `drainSyntheticPlannerNotes`
  "**removes** notes and must **not** be used here (draining would drop the note
  before the resumed planner's goal-context drain … could deliver it)." The
  earlier unsafe "peek … or drain" either/or wording is gone. §6 (lines 542–543)
  adds explicit coverage for the non-consuming accessor.
- **Verdict.** Correctly fixed.

### B3 — `reviewer_retries_exhausted` dropped; `blocked` terminal kept ✓ FIXED

- **ChangeOrigin union (§2.2 lines 165–167).** Now exactly two members:
  `{ kind: 'analyst_edit'; … }` and `{ kind: 'analyst_correction'; … }`. No
  `reviewer_retries_exhausted`.
- **§3.2 (lines 389–413).** Now states the sync flip is **deleted, not
  re-created** in the async path; the iteration-budget exhaustion already commits
  a terminal **`blocked`** via `terminateIfNonTerminal`, "left unchanged."
  Verified against source: `runtime-planner-dispatcher.ts:190–206`
  (`terminateIfNonTerminal`) calls `commitPlannerBlocked(...)` at line 195 and
  `MAX_PLANNER_ITERATIONS` is referenced at line 79. The design also correctly
  explains (Finding E) that `correction_attempts` is **never incremented**, so
  there is no per-goal review-retry cap — verified by grep of `src/` for
  `correction_attempts`: 12 hits, every one a read or `?? 0` / `: 0` seed
  (`startup-repair.ts:90,113,158`; `runtime-core.ts:735`;
  `activation-reducer.ts:32,49,65`; `activation-unwind.ts:286`;
  `reviewer-phase.ts:35`; `context-builder.ts:144`; plus the `types.ts:110`/
  `validators.ts:107` schema). None is an increment.
- **§2.3 note-kind list (lines 248–255).** Lists only `subtree_changed`,
  `analyst_note`, and `pending_subtree_correction`. No `reviewer_retries_exhausted`.
  Corroborated by the `SyntheticPlannerNote` kind union itself
  (`synthetic-planner-notes.ts:14`), which has no such member.
- The single remaining mention of `propagateChange(goal.id …)` in the design
  (§3.2 line 404) is the **negative** explanation of why such a call *would be
  incorrect* (the goal is `running`, never flipped), not a prescription. Correct.
- **Verdict.** Correctly fixed; D3 is now satisfied by Part 2 alone.

### B4 — `tool-catalog.ts` `RUNTIME_CARD_STATUS_VALUES` now listed ✓ FIXED

- **Design reality.** §1.2 lines 48–54 add `src/tools/tool-catalog.ts` lines
  8–18, explain that the `.filter()` will yield 8 elements while the `as [...]`
  asserts 9 (a TypeScript compile error), and direct that `'active'` be dropped
  from the asserted tuple (it feeds `runtimeCardStatusSchema` at line 54).
- **Source reality.** `tool-catalog.ts:8–18` is the hardcoded
  `CARD_STATUS_VALUES.filter(... !== 'needs_verification') as ['drafting','backlog','active','running','blocked','changed','done','failed','cancelled']`
  with `'active'` at index 2, feeding `runtimeCardStatusSchema` (line 54).
  Removing `'active'` from `cardStatusValues` does break compilation as the
  design now states.
- **Verdict.** Correctly fixed.

---

## NON-BLOCKING

### N1 — transition-policy / state-machine paths corrected ✓

Design §1.1/§2.1 now cite `src/runtime/transition-policy.ts` and
`src/runtime/state-machine.ts` (e.g. lines 34–36, 61, 141–143). Grep for
`phases/transition-policy`/`phases/state-machine` in the design: no match.
Files confirmed at `src/runtime/transition-policy.ts` and
`src/runtime/state-machine.ts`. The `planner-activation-runner.ts` citations
remain `src/runtime/phases/…` (design lines 150, 297), which is correct — that
file *is* under `phases/` (verified). No regression.

### N2 — `restartCard` rationale corrected ✓

§1.2 lines 79–84 now read: "the card rests at `backlog` until a later
`activate_card` produces the `backlog -> running` start plan." The "runtime
dispatch drives it to running" phrasing is gone. Verified against
`planner-control-executor.ts:213–219`: `restart_card` only calls
`plannerTools.restartCard(...)` and returns; it does not dispatch/activate.

### N3 — dead `selectActivationStartAction` active branch added to deletions ✓

§1.2 lines 65–70 now direct deletion of "the `active`-only executor branch in
`selectActivationStartAction` (line 23 …)". Verified at
`transition-policy.ts:23`:
`if (fromStatus === 'active') return { action: 'reviewer_repair_resume', … }`,
unreachable after `active` removal; the reviewer-interrupt resume stays valid via
the `from === 'running'` accept at line 110 (matching the design's note).

### N5 — completion-gate error text capture ✓

§2.4 line 283 calls out the message at `planner-tools.ts:446–448` (which "says
'blocked or changed' and must become 'non-terminal'"). Verified: the message at
`planner-tools.ts:448` currently reads "while descendants are blocked or
changed." The type/producer/consumer scope (`:28–32`, `:198`, confined to
`planner-tools.ts`) and the §6 coverage note are intact. (N4 from round 2 was
contingent on B1+B2; both are now fixed, so D6′ holds.)

### N6 — (NEW, non-blocking) the §3.3 peek is unfiltered by note `kind`; correct today, but a `reviewer_interrupted` note could in principle satisfy it

This is the requested "does the peek need kind-filtering" analysis. As specified,
the peek matches **any** note for `planner:<goalId>` regardless of `kind`. I
checked every producer that targets a goal's *own* planner session:

- `subtree_changed` / `analyst_note`: produced **only** by the analyst path —
  `notifyPlannerOfAnalystAction` (`analyst-stage6.ts:66–85`, being replaced by
  `propagateChange`) and the new §2.2/§2.3 `propagateChange` fan-out. No planner-
  or runtime-driven producer exists.
- `pending_subtree_correction`: produced **only** by `markGoalNeedsCorrections`
  (`analyst-stage6.ts:29`) / the `analyst_correction` `propagateChange` leg.
- `reviewer_interrupted`: produced **only** by startup-repair at service restart
  (`startup-repair.ts:212`).
- The sync-reviewer `writePendingSubtreeCorrectionNotes` producer
  (`planner-tools.ts:624`) is **deleted** by §3.1.

Therefore, during a normal in-process review `pass`, the only notes that can be
on `planner:<goalId>` are analyst-originated change/correction notes — i.e.
exactly the D6′ trigger. So the unfiltered peek is **correct for the intended
case and does not cause spurious resume loops** in normal operation: there is no
descendant `subtree_changed` fan-out onto a goal's own planner except from an
analyst edit, and a re-edit of a descendant is itself a legitimate reason to
resume. Confirmed there is no infinite-resume hazard: on the `continue_planner`
resume, `PlannerPhaseRunner.run` drains the queue via
`inferResumeReason`→`buildGoalContextNotes`→`drainSyntheticPlannerNotes`
(`planner-phase-runner.ts:28`) and `injectSyntheticPlannerNotes` (`:65`), so the
**next** `pass` peek finds nothing and commits — bounded, single extra loop.

The one residual: a stale `reviewer_interrupted` note (only ever queued at
restart) would also satisfy an unfiltered peek. It cannot be present during a
single-process review pass (the reviewer dispatch
`runtime-reviewer-dispatcher.ts:65–148` queues no note onto `planner:<goalId>`),
so this is not a live defect. Still, for precision and fail-fast clarity the
implementation plan should scope the peek to the change-relevant kinds
(`subtree_changed`, `analyst_note`, `pending_subtree_correction`) rather than
"any note for the session." **Not blocking** — the design's mechanism is correct
as written; this is a hardening suggestion for the plan/implementation.

---

## New-error checks (B1/B2/B3 fixes did not regress anything)

- **`invalid_pass` interaction.** `invalid_pass` is a separate `if` block handled
  and returned at `reviewer-assessment-handler.ts:30–51`, *before* the
  `if (input.decision.kind === 'pass')` block (53–92). The design inserts the
  note-check "at the top of the `pass` arm" (§3.3 line 429), i.e. inside the pass
  block only. So `invalid_pass` (which also returns `continue_planner`) is
  untouched and the peek is correctly scoped to the genuine pass decision. No
  conflict.
- **State consistency on pass-with-notes.** Returning `continue_planner` before
  `commitReviewerPass` skips `commitReviewerPass`, the parent unwind, and
  `emitGoalCompleted` — exactly the things that must not happen when the goal is
  to be resumed. No per-goal counter is left inconsistent (`correction_attempts`
  is never incremented anyway). The review assessment is not persisted on the
  pass arm except via the skipped `commitReviewerPass`/emit, and the resumed
  planner re-reports, triggering a fresh `runReviewer`; nothing harmful is
  skipped. `runReviewer` returns `false` for `continue_planner`
  (`runtime-reviewer-dispatcher.ts:147`), reusing the established
  `needs_corrections` loop in `runtime-planner-dispatcher.ts:106–110` — no new
  transition shape.
- **Resume-loop / kind-filter.** Covered in N6: correct, bounded, no infinite
  loop; kind-filtering is a non-blocking hardening, not a correctness
  requirement.

---

## D1–D9 conformance (delta from round 2)

- D3: now satisfied by Part 2 alone — the broken `propagateChange`-on-exhaustion
  migration is removed; `blocked` terminal preserved (B3).
- D6′: now satisfied — note-check runs before any `done` commit (B1) and uses a
  non-consuming peek (B2); analyst path does not mutate `active_card_run` and no
  new resume-reason enum is added.
- D8: now complete — the missed `tool-catalog.ts` SET/type site is listed (B4).
- D1, D2, D4, D5, D7, D9: unchanged and still honored.
- Fail-fast / dead code: the round-2 `done`-but-resumed contradiction is gone;
  the dead `transition-policy.ts:23` branch is now slated for deletion (N3).

VERDICT: APPROVED
