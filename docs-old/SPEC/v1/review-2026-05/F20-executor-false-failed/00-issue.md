# F20 — Executor declares card `failed` despite producing correct, test-passing artefacts

## Summary

On the `implement-stepwise-multijump` card, the executor's `latest_self_report.result = "failed"` with `status_text = "Updated UI multi-jump tests, but verification was interrupted before npm test/build could complete."` On disk those tests are green (`13/13` via G5/T40) and the production build succeeds (G5/T41). The correct outcome was authored, but because the executor's tool-call loop was terminated before the final verification step the card was committed as `failed`. The lifecycle is missing a `needs_corrections` / `requires_human` / `requires_verification` path for the "I produced something but didn't get to verify" case.

## Evidence

- Phase-2 G5/T38: [tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G5-report.md](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G5-report.md) §T38 (final card JSON), §T40 (vitest green), §T41 (build green).
- Raw artefacts: [t38-card-final.json](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t38-card-final.json), [t40-vitest.txt](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t40-vitest.txt), [t41-build.txt](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t41-build.txt).
- Owner code: [src/agents/](../../../src/agents/) (executor self-report assembly); [src/runtime/lifecycle.ts](../../../src/runtime/lifecycle.ts) (terminal status decision).

## Category

bad design (binary success/fail with no "in-progress, needs verification" outcome) / short-sighted

## Severity

P2 — misleading status; the actual artefact is correct, so no data loss, but operator sees red where green is appropriate.

## Transversality

Cross-cutting: agent self-report schema, runtime lifecycle terminal-status logic, card-store allowed statuses, UI badge mapping. The remediation likely introduces a new status (or repurposes `needs_corrections`).
