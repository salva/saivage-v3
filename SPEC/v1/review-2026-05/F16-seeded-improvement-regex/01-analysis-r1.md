# F16 — Analysis (round 1)

## Root cause

The seeded-improvement pass criterion in the Phase-2 audit test matrix is authored as a literal-text regex against the planner's *output title*, not against a stable property of the system under test.

- [tmp/.../test-matrix.json:941](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json#L941) — T35 plan step: `"Locate a child card whose title or description matches /capture|announce/i"`.
- [tmp/.../test-matrix.json:953](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json#L953) — T35 pass criterion: `"at least one child mentions capture/announce"`.
- [tmp/.../test-matrix.json:1035](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json#L1035) — T38 purpose still says `"take the capture-announcement card to status 'done'"`, propagating the same assumption into the long-run dimension.
- [tmp/.../test-matrix.json:1032](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json#L1032) — T38 title: `"Outcome: long-run — wait for seeded improvement to complete"`.

The planner is wired to an LLM (`openai-codex` / `gpt-5.5`, configured at non-zero temperature in `.saivage/saivage.json` per the Phase-2 environment summary) and is asked to choose *any valid improvement* against the project spec. On the Phase-2 run it chose a different valid improvement aligned with `docs/SPEC.md`:

- [tmp/.../G4-report.md:42](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G4-report.md#L42) — actual child card created: `implement-stepwise-multijump`, title `"Implement stepwise multi-jump continuation"`.
- [tmp/.../G4-report.md:47](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G4-report.md#L47) — auditor's own observation: "semantically a multi-jump in checkers *is* a chained capture", flagged the regex itself as too literal, marked T35 PASS-with-caveat.

The G5 long-run subsequently did demonstrate the same seeded gap closing through the *first run's* card (`src/ui.js:210` `"Capture available — you must jump."`), confirming the system-under-test behaves correctly across replans even when individual planner cycles diverge.

## Current behavior

- T35 / T38 hard-code the literal token surface (`capture|announce`) chosen by an earlier planner cycle as if it were a stable contract.
- The Phase-2 auditor's per-test logic had to be overridden by human judgement to record a PASS-with-caveat instead of a FAIL.
- Future planner runs on the same seeded project will deterministically *re-trigger* this false-negative every time the planner picks any other valid improvement (e.g. "multi-jump", "draw detection", "PDN export", any other gap implied by `docs/SPEC.md`).
- No Saivage source code, schema, contract, or runtime behaviour is implicated. Phase-2 finding explicitly classifies this as `over-specified test (matrix-internal)` / P3 / `test-tooling only` ([SPEC/v1/review-2026-05/F16-seeded-improvement-regex/00-issue.md](./00-issue.md)).

## Impact

- **Test-matrix false negatives.** Each Phase-N re-run has a non-trivial probability of marking T35 FAIL purely because the planner exercised its allowed freedom of action.
- **Conclusion drift.** A FAIL on T35 cascades into T38 (depends_on T35) and would suppress the entire G4 outcome-validity dimension on subsequent audits despite the underlying system being correct.
- **Auditor burden.** Any subagent executing the matrix must re-discover the same semantic-vs-literal mismatch and re-justify a manual override; multiplies review cost.
- **No runtime / no user impact.** This is purely a defect in how the audit measures success.

## Scope (transversality)

- Two test-matrix entries: T35 (plan step + pass criterion) and T38 (purpose + title wording).
- One downstream audit artefact references the literal token surface in narrative form: [tmp/.../G4-report.md:47](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G4-report.md#L47). The report is historical and need not be edited.
- One prompt under [prompts/saivage-v3-checkers-e2e-testing-instance.md](../../../../../prompts/saivage-v3-checkers-e2e-testing-instance.md) generates / references the Phase-N matrix authoring; verified by grep that it does not embed the literal regex (so prompt-level guidance is sufficient, no narrative rewrite needed there beyond an authoring rule).
- **Zero files inside `saivage-v3/`** are affected — no `src/`, `web/`, `tests/`, `docs/`, or `SPEC/` source-code or product-documentation edits.
- No schemas, no Zod contracts, no API surface, no deployment artefact.

## Relationship to other Phase-2 findings

- **F22** (planner no default model list) is the only adjacent finding that could *prevent* the planner from running at all; once F22 is fixed (orthogonally), the planner will keep running and keep exercising its freedom of choice — which is exactly what F16 expects to allow for.
- F16 does **not** depend on F12/F13 (card-history / canonical-index drift) — those affect persistence not planner output choice.
- F16 is logically independent of every other F* and can land before or after them.

## Non-goals

- Do not constrain the planner to pick the original "announce-required-captures" improvement. Restricting planner output to fit a test matrix would corrupt the system under test (we'd be measuring a degraded planner, not the real one).
- Do not freeze the matrix at the first planner cycle's literal output. Future Phase-N audits must remain insensitive to which valid improvement the planner picks.
- Do not edit the historical G4 / G5 reports — they are audit artefacts of a specific run.
- Do not introduce backward-compatibility shims for the old regex (per workspace policy, the old criterion disappears in favour of the new, semantically grounded one).
