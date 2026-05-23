# F16 - Analysis Review (r2)

## Findings

No blocking findings.

1. The revised T35 structural criterion admits the observed valid Phase-2 child. The check accepts a card with `parent="project"`, `type="code"`, `status="running"`, `created_by="planner"`, a substantial `description`, and empty `acceptance`, which matches the canonical example in [t35-cards.json](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t35-cards.json#L1). R1's invalid non-empty-acceptance gate is gone.

2. The card-field and enum literals now match the live schema in [src/schemas/validators.ts](../../../../src/schemas/validators.ts#L12): the relationship field is `parent`; allowed card types are drawn from `project`, `goal`, `architecture`, `code`, `test`, `doc`, `data`, `research`, `ops`; and the status wording uses literals from `drafting`, `backlog`, `active`, `running`, `blocked`, `changed`, `done`, `failed`, `cancelled`. The invalid `analysis`, `parent_id`, `planned`, and `ready` references from r1 are removed.

3. The downstream consistency problem is addressed. T39 replaces the capture-string grep with a planner-output-invariant diff plausibility check, while T42 separates unconditional render smoke coverage from conditional capture-announcement assertions. Non-capture improvements get a documented `t42-tierB-skip-reason.txt` and `not-applicable` Tier B result rather than an unconditional failure.

4. The remaining heuristic in T42 (`C.id === "announce-required-captures"` or capture/status/announce substrings) is acceptable for this matrix fix because it only controls whether an optional capture-specific assertion runs. A false negative records a skip instead of failing a valid non-capture planner choice.

## Approval

The r2 analysis, design, and plan satisfy the r1 required fixes and preserve the correct scope: audit matrix plus authoring prompt only, with no Saivage runtime, schema, or deployment change.

VERDICT: APPROVED