# F16 — Analysis (round 2)

Supersedes [01-analysis-r1.md](./01-analysis-r1.md). Reviewer feedback addressed:
[01-analysis-review-r1.md](./01-analysis-review-r1.md).

## Root cause (unchanged)

The seeded-improvement pass criterion in the Phase-2 audit test matrix is authored as a
literal-text regex against the planner's *output title*, not against a stable property
of the system under test.

- [tmp/.../test-matrix.json:941](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json#L941) — T35 plan step: `"Locate a child card whose title or description matches /capture|announce/i"`.
- [tmp/.../test-matrix.json:953](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json#L953) — T35 pass criterion: `"at least one child mentions capture/announce"`.
- [tmp/.../test-matrix.json:1035](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json#L1035) — T38 purpose: `"take the capture-announcement card to status 'done'"`.
- [tmp/.../test-matrix.json:1032](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json#L1032) — T38 title: `"Outcome: long-run — wait for seeded improvement to complete"`.

The planner runs at non-zero temperature and is allowed any valid improvement against
`docs/SPEC.md`. On the Phase-2 run it picked `implement-stepwise-multijump` (title
"Implement stepwise multi-jump continuation"); the auditor noted the regex was too
literal and recorded T35 PASS-with-caveat
([G4-report.md:47](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G4-report.md#L47)).

## Live card-schema facts (confirmed against Saivage source)

Reviewer feedback objection #2 required confirming the live schema before writing the
fix. Source of truth: [validators.ts:12](../../../../src/schemas/validators.ts#L12).

- Parent-link field on `CardRecord` is **`parent`** (string | null), **not** `parent_id`.
- Valid `CardType` literals are exactly: `project`, `goal`, `architecture`, `code`,
  `test`, `doc`, `data`, `research`, `ops`. **`analysis` is not a valid type** and was a
  mistake in r1.
- Valid `CardStatus` literals are exactly: `drafting`, `backlog`, `active`, `running`,
  `blocked`, `changed`, `done`, `failed`, `cancelled`. Terminal-ish working statuses
  used by the planner are `running`, `active`, `done`, `blocked`. (`planned` and
  `ready` mentioned in r1 do **not** exist in the schema and were also a mistake.)
- `acceptance` is a single `string` (often empty for planner-created cards), **not** an
  array, and is optional on create / update through the operator API
  ([operator-api.ts:173](../../../../src/contracts/operator-api.ts#L173),
  [operator-api.ts:194](../../../../src/contracts/operator-api.ts#L194)).
- `description` is a `string` (required, but may be empty); on the observed Phase-2
  child it is substantial.

## Observed Phase-2 child card (motivating example for the new criterion)

From [t35-cards.json](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t35-cards.json#L1)
(verbatim shape, abbreviated):

```
{
  "id": "implement-stepwise-multijump",
  "type": "code",
  "parent": "project",
  "status": "running",
  "title": "Implement stepwise multi-jump continuation",
  "description": "Fix the checkers UI/game flow so multi-jump captures ...",  // ~600 chars
  "acceptance": "",
  "created_by": "planner",
  "version_seq": 1
}
```

This card is the canonical positive case the new criterion must accept. Note
`acceptance` is empty — so requiring non-empty `acceptance` (as r1 did) would reject
the very card that motivated F16. The reviewer flagged this and it is now fixed.

## Current behavior (unchanged)

- T35 / T38 hard-code the literal token surface (`capture|announce`) chosen by an
  earlier planner cycle as if it were a stable contract.
- The Phase-2 auditor's per-test logic had to be overridden by human judgement to
  record PASS-with-caveat instead of FAIL.
- Future planner runs on the same seeded project will deterministically re-trigger this
  false-negative for any other valid improvement.
- No Saivage source code, schema, contract, or runtime behaviour is implicated.

Additionally surfaced by the reviewer (objection #3): downstream T39 and T42 still
encode the original `/capture available/i` literal in plan steps and pass criteria
([test-matrix.json:1069](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json#L1069),
[test-matrix.json:1076](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json#L1076),
[test-matrix.json:1089](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json#L1089),
[test-matrix.json:1157](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json#L1157),
[test-matrix.json:1166](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json#L1166)).
Once T35/T38 generalize, these become inconsistent: they would pass-gate the wrong
implementation choice for any other valid improvement the planner picks.

## Impact

- **Test-matrix false negatives** at T35 (and cascaded T38) on every Phase-N re-run
  where the planner picks a different valid improvement.
- **Cascade through G4 outcome-validity:** without the T39/T42 fix surfaced by the
  reviewer, even if T35/T38 are made robust, the G4 dimension still fails
  deterministically for any non-capture-announcement improvement.
- **Auditor burden** to re-discover and re-justify the override.
- **No runtime / no user impact.** Pure audit-measurement defect.

## Scope (transversality, revised)

- **T35** plan step and pass criterion (literal regex → structural check).
- **T38** title, purpose, and first plan step (literal "capture-announcement" → planner-selected card carried forward by id).
- **T39** plan step 3 and one pass criterion (the `/capture available/i` grep is
  capture-specific and must be generalized or conditionalized).
- **T42** title, plan steps (driving moves into capture state, asserting capture
  string), and pass criteria (capture-specific assertions). T42 is the most
  capture-bound — see Design r2 for the chosen scoping decision.
- **Authoring prompt:** [prompts/saivage-v3-checkers-e2e-testing-instance.md](../../../../../prompts/saivage-v3-checkers-e2e-testing-instance.md)
  gains a "no literal-match of planner output" rule so the regression cannot re-enter.
- **Zero files inside `saivage-v3/`** are affected. No `src/`, `web/`, `tests/`,
  `docs/`, or `SPEC/` (outside this F16 directory) source-code or product-documentation
  edits. No schemas, no Zod contracts, no API surface, no deployment artefact.

## Relationship to other Phase-2 findings

- **F22** (planner no default model list) is the only adjacent finding that could
  prevent the planner from running. F16 assumes F22 (or an equivalent provider config)
  lets the planner produce some child card.
- F16 does not depend on F12 / F13 (history / index drift) — those affect persistence,
  not planner choice.
- F16 is logically independent of every other F* and can land in any order.

## Non-goals (unchanged)

- Do not constrain the planner to a specific seeded improvement.
- Do not freeze the matrix at the first planner cycle's literal output.
- Do not edit historical G4 / G5 reports.
- Do not introduce backward-compatibility shims for the old regex.
