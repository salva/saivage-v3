# Cross-Batch Coordination

Single source of truth for resolving contract-ownership, ordering, and validation conflicts across BATCH-A, BATCH-B, BATCH-C plans.

## Contract type ownership

- The per-invocation `Contract<Envelope, TypedResult>` type and its planner/executor/reviewer factories live in `src/contracts/contract.ts` and `src/contracts/{planner,executor,reviewer}-contract.ts`. **Batch B owns these.** They are the single, canonical contract object.
- The `ContractVerifier`, `ObligationReport`, `VerifierOutcome`, and repair-loop driver live in `src/agents/contract-verifier.ts` (and `src/agents/agent-loop.ts` for the state-machine driver). **Batch A owns these** and consumes Batch B's `Contract<E, T>`.
- The scaffolding decomposition (`CandidateResolver`, `ConversationRunner`, `SessionLifecycle`, `InvocationOutcomeProjector`, `InvocationAttemptRecorder`) lives in `src/agents/invocation/`. **Batch C owns these** and consumes both Batch B contracts and Batch A verifier/driver.

There is **one** `Contract` type in the codebase. Batch A's design refers to "Contract<TEnvelope>" as a conceptual stand-in; in implementation, it IS Batch B's `Contract<Envelope, TypedResult>`.

## Cross-batch ordering

Implementation must land in this order. Each batch reaches a compile-green and runtime-healthy state before the next starts.

1. **Batch B step 1-3 (skeleton)**: introduce `src/contracts/contract.ts` and planner/executor/reviewer contract factories as new files. No deletions yet. Tree compiles (new files unused).
2. **Batch A**: introduce verifier + repair driver + failure-class split + new event/exchange schemas + adapter loop rewrite. Imports the Batch B Contract types. Removes `contract_mismatch` from `LlmRequestError`. Replaces inline nudge.
3. **Batch B step 4-end**: rewrite prompt builders, recorder, supervisor entry points, deferred-activation handling against the Contract. Delete `ROLE_RESULT_TOOLS`, `ROLE_RESULT_TOOL_NAMES`, `TERMINAL_TOOL_NAMES`, `validateTerminalToolCall`, `role-envelope-schemas.ts`, the legacy `__saivage_defer_tool_result` parser fallback, and the inline deferred-activation synthesis.
4. **Batch C**: delete `LlmRolePhase` / `LlmCompleteOptionsTerminal` and the terminal-phase branches in `llm-options-factory.ts`, the three gateway consumers, the analyst resolver caller, the probe script, and phase-bearing tests. Delete `recovery.ts`. Decompose `AgentAdapter.invokeAgent` into the five collaborators. Unify budgets per the three-axis model.

If a step is too big to land compile-green in isolation, fold it together with its dependent steps into one atomic numbered step rather than claiming "compile-green after every step" when the claim is aspirational.

## Validation commands

`saivage-v3` is a Jest project for root tests, Vitest only for `web/`. Use the workspace skill `.github/skills/saivage-development-validation/` if present; otherwise:

```bash
cd /home/salva/g/ml/saivage-v3
npm run typecheck
npm test -- --runInBand <focused suites>
npm run build              # full build (cli + web)

# Live deploy + smoke
rsync -a --delete dist/ root@10.0.3.170:/opt/saivage-v3/dist/
ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service'
sleep 4
curl -fsS http://10.0.3.170:8080/health
curl -fsS http://10.0.3.170:8080/api/providers | jq
```

Service: `saivage-v3-getrich.service`. Container: `saivage-v3-getrich-v2` at `10.0.3.170:8080`. The container at `10.0.3.112` is the v2 harness, NOT the Saivage v3 deployment.

## Message-kind split

- `MessageKind: 'model_repair'` — owned exclusively by the `ContractVerifier`.
- `MessageKind: 'context_compaction'` — new kind for `compaction.ts` producers (currently using `model_repair`). Migrate every producer and consumer (frontend included). No backward compatibility.
