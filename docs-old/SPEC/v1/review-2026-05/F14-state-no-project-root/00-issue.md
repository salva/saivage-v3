# F14 — `/api/state` contract drift: no `projectRoot` field

## Summary

`GET /api/state` returns keys `{ runtime, cardIndex, cardStoreHealth, serverAvailability }`. The Phase-2 test matrix and at least one historical contract doc expected a top-level `projectRoot` field, but no such field is exposed (`/api/project` is 404, no `projectRoot` token in `src/server`). Operators auditing multiple deployments must read the systemd EnvironmentFile to determine which project they are inspecting; combined with [F08](#) (header subtitle shows only `saivage-v3`) and [F18](../F18-runtime-status-pid-null/00-issue.md) (`runtime.pid` null), this compounds into a deployment-identity ambiguity.

## Evidence

- Phase-2 G2/T23: [tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G2-report.md](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G2-report.md) §T23; raw payload [t23-state.json](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t23-state.json).
- Owner code: [src/server/routes/operator-contracts.ts](../../../src/server/routes/operator-contracts.ts) ~line 82-88 (state assembler).

## Category

inconsistency (contract drift vs docs)

## Severity

P3 — informational; no operator path is blocked.

## Transversality

Local: one route + one schema. May or may not require a corresponding update in [src/contracts/](../../../src/contracts/) and the test matrix.
