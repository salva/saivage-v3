# F16 — Seeded-improvement regex `/capture|announce/i` is non-deterministic across planner runs

## Summary

The Phase-2 G4/T35 pass criterion expected the planner to author a child card whose title matches `/capture|announce/i`. The planner instead chose to implement "stepwise multi-jump continuation" (a different valid improvement against `docs/SPEC.md`). This is a test-matrix authoring problem, not a Saivage code defect: any planner with non-zero temperature will diverge from a literal-string check.

## Evidence

- Phase-2 G4/T35: [tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G4-report.md](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G4-report.md) §T35.
- Test matrix: [tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json).

## Category

over-specified test (matrix-internal)

## Severity

P3 — affects only the E2E test prompt.

## Transversality

Test-tooling only. Lives outside Saivage code; recommend relaxing to "any non-trivial child card linked to the seeded dimension".
