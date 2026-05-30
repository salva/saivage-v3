# Batch A Plan Review R1

## Verdict

Changes requested. The plan tracks the approved P-A2 direction and covers most of the intended deletion/introduction inventory, but it has substantive execution holes that should be fixed before approval.

## Findings

1. **Step ordering does not keep the tree compiling after each step.** The plan says steps are ordered so `npm run build` is green after each step, but step 1 deletes/renames the failure union and explicitly says `npx tsc --noEmit` will surface call-site breakage handled in steps 2-3. Step 11 similarly deletes `terminal-protocol.ts`, `role-result-tools.ts`, and `role-envelope-schemas.ts` before the adapter rewrite in step 13, while acknowledging adapter call-site breakage remains. Those are forward references to later repair work, not compile-green implementation slices. Reorder or widen the affected steps so each step removes a symbol only after all imports/callers are updated in the same step.

2. **Cross-batch contract ownership is inconsistent with Batch B and Batch C.** Batch A states Batch B will import/extend `Contract<TEnvelope>` from `src/agents/contract.ts`, but Batch B's plan creates and owns `src/contracts/contract.ts` with `Contract<Envelope, TypedResult>`, and Batch C consumes that Batch B contract surface from `src/contracts/contract.ts`. Batch A also says Batch C consumes `VerifierOutcome` from `src/agents/contract-verifier.ts`, but the Batch A new-file list does not introduce `VerifierOutcome`; it introduces `ContractCheckResult`, `ObligationReport`, and `InvocationOutcomeOf`. The ordering section needs to be reconciled with the actual Batch B/C plans: either Batch A owns the shared contract surface and B/C must be rewritten around it, or Batch A should describe itself as providing the verifier/driver primitives that Batch B later adapts into `src/contracts/contract.ts`.

3. **Validation commands target the wrong project/toolchain.** The plan under review lives under `saivage-v3`, the approved design says paths are workspace-relative to `saivage-v3/`, and Batch B/C validation runs from `/home/salva/g/ml/saivage-v3`. Batch A §7 instead starts with `cd /home/salva/g/ml/saivage` and repeatedly uses `npx vitest run`. The `saivage-v3` package uses Jest via `npm test` and has `npm run typecheck`/`npm run build`; `vitest` is not its test runner. The validation block must be rewritten to run against `/home/salva/g/ml/saivage-v3` with concrete commands from that package, plus the appropriate web/build/deploy smoke checks.

## Non-Blocking Notes

- The no-backward-compatibility rule is respected in the planned deletions; I did not find compatibility shims leaking into the implementation steps.
- The rollback story is acceptable for a batch-level revert, but it depends on the plan being implemented as a coherent change set. Once the compile-green step ordering is fixed, the rollback section should clarify whether rollback is per-step or whole-batch.

VERDICT: CHANGES_REQUESTED