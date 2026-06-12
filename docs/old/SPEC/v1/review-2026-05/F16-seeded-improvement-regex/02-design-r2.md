# F16 — Design (round 2)

Supersedes [02-design-r1.md](./02-design-r1.md). Addresses
[01-analysis-review-r1.md](./01-analysis-review-r1.md) objections #1, #2, #3.

## Goal

Re-author T35, T38, T39, and T42 in the Phase-2 audit test matrix so the seeded-improvement
chain measures *that the planner started, advanced, and finished work on the seeded gap*,
not *which literal words / which specific UI string the planner chose*. Pass criteria
must be invariant under any valid improvement the planner picks from `docs/SPEC.md`.

## Chosen design — structural linkage on T35/T38, generalize-and-conditionalize on T39/T42

### T35 — replace literal-token regex with structural linkage

Replace the `/capture|announce/i` substring match with a check expressed entirely in
fields of the card-store schema (live names confirmed against
[validators.ts:12](../../../../src/schemas/validators.ts#L12)):

The planner must create at least one child card C such that, by the end of the T35
polling window:

- **`C.parent`** equals `"project"`, **or** an ancestor chain of `C` (following
  `parent` links) reaches the seeded project root id `"project"`.
- **`C.type`** is one of the valid work-card types `{code, test, doc, research, ops}`.
  (Excluded: `project`, `goal`, `architecture`, `data` — these are not typical planner
  child outputs for a code change. Included list is the planner's expected output
  surface for a code-product improvement and is independent of which improvement was
  chosen.)
- **`C.status`** is not `backlog` and not `drafting` — i.e. the planner actually
  advanced it (typically into `active` or `running`).
- **`C.created_by`** equals `"planner"`.
- At least one of `C.description` or `C.acceptance` is **non-empty**. (The observed
  Phase-2 child has `acceptance=""` but a ~600-char `description`, so an OR over the
  two stable string fields keeps the criterion permissive enough to accept the real
  positive case while still rejecting empty placeholder cards.)

Optional advisory (not pass-gating): record `C.id`, `C.title`, `C.description`,
`C.acceptance` verbatim into `t35-cards.json` for human review against `docs/SPEC.md`.

Reviewer objection #1 fix: r1's `non-empty acceptance` requirement is removed — the
canonical positive case has empty acceptance. Replaced with the `description OR
acceptance` disjunction, which is still schema-stable and still rules out trivial
empty cards.

Reviewer objection #2 fix: field name is `parent` (not `parent_id`); `analysis` is
not a valid type and has been removed from the allowed set; the allowed types now use
only literals from the Zod enum.

### T38 — wait for the T35-selected card to reach terminal

- Title becomes: `"Outcome: long-run — wait for the planner-selected seeded improvement to reach a terminal status"`.
- Purpose becomes: `"Allow Saivage up to 5 min after T35 to take the planner-selected seeded-improvement card (whatever its title) to a terminal status (ideally 'done')."`
- First plan step becomes: `"Identify the child card id C produced by T35 (carried forward from t35-cards.json; C.id is the matrix variable used by all downstream T39+ steps)."`
- Pass criteria semantics unchanged but worded in schema terms:
  `C.status ∈ {done, failed, blocked, cancelled}` within 300 s; if `done`, proceed to
  T39–T44; otherwise mark outcome-validity failed and record cause.

### T39 — generalize the diff assertion (drop the capture-specific grep)

Plan step 3 (`grep ui.js for /capture available/i`) and pass criterion
`"capture-availability string present in renderStatus path"` are capture-specific.
Replace with planner-output-invariant alternatives:

- New plan step 3: `"Confirm the diff touches at least one source file referenced
  (or implied) by C.description / C.acceptance, and that the touched files are
  consistent with C.type (e.g. for C.type='code', expect changes under src/)."`
- New pass criterion (replacing the capture-availability one):
  `"diff non-empty and at least one changed file is plausibly the implementation of C
  (heuristic: a changed file path appears as a substring of C.description, or all
  changed files live under the project source roots)."`
- Existing pass criteria preserved (in schema-stable form):
  `"src diff non-empty"`, `"engine.js exports unchanged"` (preserved because the
  *no-regression-of-existing-public-API* invariant is independent of which improvement
  was picked; "engine.js" here is a stable artefact of the seed project under test,
  not of planner output).

### T42 — conditionalize the UI assertion on the planner-chosen improvement

T42 is the most capture-bound entry: it drives moves to a capture state and asserts
`/capture available/i` in the status region. Two-tier scoping:

1. **Tier A (always runs):** generalized smoke check that the built app serves and the
   board renders. Plan steps:
   - Boot `vite preview` as today.
   - Playwright navigates to the URL.
   - Snapshot initial board.
   - Assert the page contains the expected app shell (board DOM, status region
     present). These are properties of the seed project, not of planner output.
   - Pass criteria: page reachable; board DOM present; status region present.
2. **Tier B (conditional on planner choice):** the original capture-announcement
   assertion runs **only if** the planner-selected card C is the capture-announcement
   improvement, detected by `C.id === "announce-required-captures"` (or by a structural
   match on `C.description` containing the substring `"capture"` AND
   `"status"` / `"announce"`). If C is a different valid improvement, Tier B is
   **skipped with reason recorded** rather than failing.

   For non-capture improvements, the auditor records an artefact
   `t42-tierB-skip-reason.txt` describing why Tier B was skipped (C's title +
   improvement category) and the matrix records Tier B as `not-applicable` rather
   than `pass` or `fail`. Tier A continues to gate the overall T42 outcome.

This conditionalization is the minimum change that keeps T42's value (smoke-test that
the built app still serves and renders) while removing the deterministic false-negative
for non-capture improvements. T42's `depends_on=[T41]` and its severity (P1) are
unchanged.

### Title update for T42 and downstream narrative

- T42 title becomes: `"Outcome: playable game — built app serves and (if planner chose capture announcement) UI announces captures"` to reflect the two-tier structure.
- T42 purpose becomes: `"Serve the built checkers app and verify it still renders; additionally, if the planner-selected improvement targets capture announcement, assert the announcement string appears in the status region."`

### T39/T40/T41/T43/T44 — no other changes required

- T40 (vitest 5/5), T41 (npm run build), T43 (engine-API headless eval), and T44
  (any subsequent verifications) are already planner-output-invariant: they assert
  test counts, build success, and engine-API stability — none of which depend on which
  improvement the planner chose. No edits.

### New authoring rule

Add a single guideline to
[prompts/saivage-v3-checkers-e2e-testing-instance.md](../../../../../prompts/saivage-v3-checkers-e2e-testing-instance.md):

> Pass criteria for LLM-output dimensions (planner / executor / reviewer / analyst)
> MUST measure structural properties (`parent`, `type`, `status`, `acceptance`,
> `description` non-emptiness, `version_seq`, transition legality, child-count growth)
> and MUST NOT literal-match planner-chosen tokens (titles, descriptions, acceptance
> text). Downstream tests that depend on the planner-selected card MUST refer to it
> by id (carried forward as a matrix variable from the upstream step) and MUST either
> apply only structural checks, or be conditionalized on the specific improvement
> chosen with a documented skip-reason for other valid improvements.
> See `SPEC/v1/review-2026-05/F16-seeded-improvement-regex/`.

## Why this design (and not the alternatives)

### Why a `description OR acceptance` disjunction at T35

- It is the **narrowest weakening** of r1 that admits the observed canonical positive
  case (`acceptance=""`, `description` substantial) while still rejecting structurally
  trivial cards (both fields empty).
- Both fields are typed `string` in the schema, so the check is purely structural.
- It does not couple to any planner-chosen token — it only looks at length.

### Why the `description OR acceptance` rather than e.g. `description.length > 50`

- Length thresholds are arbitrary and brittle. A non-empty check is sufficient to
  separate "planner advanced this card" from "planner left an empty placeholder".

### Why id-based hand-off T35 → T38 → T39 → T42 (and not title-based)

- `t35-cards.json` already contains `C.id`. Carrying the id forward is deterministic
  and does not require the downstream auditor to re-discover the card.
- The historical matrix wording "the capture-announcement card" was an implicit
  title-based hand-off — exactly the coupling F16 removes.

### Why conditionalize T42 rather than fully generalize it

- T42's value is asserting a *UI-level effect* of the chosen improvement. There is no
  single planner-output-invariant assertion that proves "the planner's UI work is
  visible in the rendered page" without knowing what the work was. A generic Tier-A
  smoke check + an opt-in Tier-B asserting the specific change is the honest
  representation of what we can mechanically verify.
- The Tier-B skip-with-reason path keeps T42 informative on the audit report (we know
  *why* the UI-specific assertion was not run) without producing a deterministic FAIL
  for valid non-capture improvements.

### Alt A (broaden the regex), Alt B (pin the planner), Alt C (manual T35), Alt D (planner-hint contract) — rejected as in r1

Reasoning carried forward from r1 unchanged. The structural-linkage + conditional-UI
approach is the minimum-impact fix that addresses both the original finding and all
three reviewer objections.

## Contracts / schemas

- No changes to Saivage source, Zod contracts, schemas, or operator API.
- The matrix's `pass_criteria` and `plan` fields are free-form prose; no schema
  constrains them.
- T35's `artifacts_to_capture` already lists `json:t35-cards.json` and
  `screenshot:t35-tree.png` — these satisfy the new structural criterion. T38 already
  captures the card-final / history JSON. T42 gains one new artefact:
  `txt:t42-tierB-skip-reason.txt` (only when Tier B is skipped).

## Risks

- **None to runtime / users.** Pure test-matrix and authoring-prompt edits.
- **Auditor-prompt reach.** The new authoring rule must land in the prompt so the
  regression cannot re-enter on the next Phase-N authoring round; mitigated by the
  explicit rule and a back-reference to this F16 directory.
- **Tier-B detection heuristic at T42.** Matching on `C.id ===
  "announce-required-captures"` OR a substring check on `C.description` is a small
  heuristic; documented as such, and Tier-B skip is non-failing by design, so a false
  negative on the heuristic only suppresses an opt-in assertion, never the whole test.
- **In-flight artefact `tmp/` location.** Unchanged — `tmp/` is workspace-local and
  outside `saivage-v3/` git tree; no deployment implication.
