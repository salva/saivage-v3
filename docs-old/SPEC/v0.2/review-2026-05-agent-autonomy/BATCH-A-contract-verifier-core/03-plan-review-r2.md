# Batch A Plan Review R2

## Verdict

Approved. I reviewed R2 only against the three R1 findings: compile-green step ordering honesty, cross-batch ownership reconciliation, and validation commands.

## R1 Resolution Check

1. **Step ordering compile-green honesty: resolved.** R2 now states that each numbered step is an atomic change set and only claims `npm run typecheck` at step boundaries. The failure split, message-kind split, schema changes, and adapter rewrite are grouped with their consumers/tests instead of relying on later steps to repair known breakage. The plan also explicitly leaves Batch B/C-owned deletions out of Batch A.

2. **Cross-batch ownership reconciliation: resolved.** R2 now consumes Batch B's skeleton contract surface from `src/contracts/contract.ts` and the per-role contract factories, while Batch A owns the verifier, driver, done-signal tool, adapter integration, and failure/message-kind rewrites. It also reserves the legacy contract-surface deletions and scaffolding cleanup for the later Batch B and Batch C steps, matching the coordination document.

3. **Validation commands: resolved.** R2 runs from `/home/salva/g/ml/saivage-v3`, uses `npm run typecheck`, Jest via `npm test -- --runInBand`, `npm run build`, and the `saivage-v3-getrich.service` deploy/smoke target at `10.0.3.170:8080`. It no longer targets `/home/salva/g/ml/saivage` or root Vitest for the `saivage-v3` package, and it correctly notes that the web build is covered by `npm run build`.

## Non-Blocking Notes

None within the requested review scope.

VERDICT: APPROVED