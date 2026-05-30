# Batch C — Scaffolding Cleanup: Implementation Plan (r2)

Supersedes [03-plan-r1.md](03-plan-r1.md). Addresses
[03-plan-review-r1.md](03-plan-review-r1.md): the F01 option-shape
rewrite is one atomic multi-file step (production + every test caller
in one commit), not three per-file slices that left the tree red;
root-test validation uses Jest (`npm test -- --runInBand`), not
Vitest, per [00-COORDINATION.md §Validation](../00-COORDINATION.md#validation-commands);
the live smoke target is `saivage-v3-getrich.service` at `10.0.3.170`,
not the v2 harness at `10.0.3.112`. Detailed file inventories, the
full deleted-symbol enumeration, the full test inventory, and the
schema/policy edit detail live in
[03-plan-r2-companion.md](03-plan-r2-companion.md); the plan here is
the authoritative ordering and verification contract.

## 1. Overview

Implements P-C1 from [02-design-r3.md §5](02-design-r3.md#5-recommendation):
F01 per-turn phase deletion, F08 three-axis budget split, F10
`invokeAgent` decomposition into seven injected collaborators. Deletes
`LlmRolePhase`, the `'tools'`/`'terminal'` discriminator across
options/transports/recorder, `TERMINAL_TOOL_NAMES`, the
`role === 'planner'` lifecycle ladder, the `a2a6f05` inline nudge, the
deferred-activation synthesis branch, the four overlapping recovery
counters, and the whole `src/agents/recovery.ts` module plus its
legacy runtime-config migration arms. No backward compatibility is
preserved; every old shape goes in the same change set as the new
shape.

## 2. Ordering relative to Batch A and Batch B

Batch C lands **after** Batch A and the Batch B continuation per
[00-COORDINATION.md §Cross-batch ordering](../00-COORDINATION.md#cross-batch-ordering).
Upstream surfaces consumed (anchors in
[02-design-r3.md §0](02-design-r3.md#0-integration-surface-assumed-from-batches-a-and-b)):
A1/A2 `Contract` + three factories from Batch B (step 2 dep); A3/A7
`contract.terminals` / `isTerminalToolName` replacing
`TERMINAL_TOOL_NAMES` (Batch B owns the deletion; step 1 finishes the
sweep across transports / recorder / tests); A4/A6 Batch A
`ContractVerifier` + `ObligationReport` + `VerifierOutcome` +
`LlmTransportFailure` (step 4 deps on Batch A steps 1, 5, 7); A5
Batch B Position C ships `emit_planner_deferred` (step 4 dep). Batch
C does not depend on Batch A's verifier registry shape — the verifier
is consumed only as a constructor-injected interface.

## 3. Steps

Each numbered step is one atomic commit and leaves the tree
compile-green. F01 deletions and the recovery/orchestrator rewrite are
not sliced per-file: deleting `LlmRolePhase` / `phase` / `recovery.ts`
without simultaneously rewriting every caller would leave
`npx tsc --noEmit` red.

1. **F01 atomic slice — flatten `LlmCompleteOptions`, rewrite
   `buildLlmOptions`, and update every production and test caller in
   one commit.** File set and per-symbol actions in
   [companion §A](03-plan-r2-companion.md#a-f01-atomic-slice--full-file-inventory-plan-step-1).
   Per [02-design-r3.md §2.1 + §2.1.1](02-design-r3.md#21-f01-exact-deletions-and-replacements).
   - Verify: `npx tsc --noEmit`;
     `npm test -- --runInBand tests/agents/llm-openai-chat-gateway-request.test.ts tests/agents/llm-openai-codex-gateway-request.test.ts tests/agents/llm-client-recorder.test.ts tests/agents/llm-client-integration.test.ts`.

2. **Introduce `StatusProjector` + `AgentInvocationPlan`.** New
   `src/agents/status-projector.ts`,
   `src/agents/agent-invocation-plan.ts`; append
   `plannerStatusProjector` / `executorStatusProjector` /
   `reviewerStatusProjector` to the three
   `src/contracts/{planner,executor,reviewer}-contract.ts` modules.
   Per [§2.3.1](02-design-r3.md#231-agentinvocationplan-and-the-status-projector).
   Not consumed in production until step 8. Verify: `npx tsc --noEmit`.

3. **Introduce `CandidateResolver` + `AgentSessionLifecycle`.** New
   `src/agents/candidate-resolver.ts`,
   `src/agents/agent-session-lifecycle.ts`. Per
   [§2.3.2](02-design-r3.md#232-candidateresolver) and
   [§2.3.3](02-design-r3.md#233-agentsessionlifecycle).
   `AgentSessionLifecycle` absorbs `AgentSessionCoordinator` plus the
   inline `createSession` / `assertNoActiveAgentSession` /
   `persistFailure` closures at `agent-adapter.ts` L249–L256.
   Dormant until step 8. Verify: `npx tsc --noEmit`.

4. **Introduce `ConversationRunner`.** New
   `src/agents/conversation-runner.ts` per
   [§2.3.4](02-design-r3.md#234-conversationrunner). Consumes Batch B's
   `Contract` (`terminals`, `isTerminalToolName`, `verify`) and
   Batch A's `ContractVerifier` + `ObligationReport`. The
   `emit_planner_deferred` synthesis branch and the `a2a6f05`
   plain-message nudge are **not** ported. Verify: `npx tsc --noEmit`.

5. **Introduce `InvocationAttemptRecorder` + `OuterAttemptLoop`.** New
   `src/agents/invocation-attempt-recorder.ts`,
   `src/agents/outer-attempt-loop.ts`. Per
   [§2.3.5](02-design-r3.md#235-invocationattemptrecorder) and
   [§2.3.6](02-design-r3.md#236-outerattemptloop). Recorder is the sole
   `replay_outer` producer ([acceptance #9](02-design-r3.md#5-recommendation));
   outer loop only branches on `directive.action`.
   Verify: `npx tsc --noEmit`.

6. **Introduce `InvocationOutcomeProjector`.** New
   `src/agents/invocation-outcome-projector.ts` per
   [§2.3.7](02-design-r3.md#237-invocationoutcomeprojector); verdict
   derivation matches the §2.3.7 table; success status comes from
   `plan.statusProjector(typedResult)`. Verify: `npx tsc --noEmit`.

7. **Reshape runtime-config schema and recovery-policy context in one
   commit (they share renamed fields; splitting them leaves the tree
   red).** Files: `src/agents/config-schema.ts`,
   `src/agents/invocation-recovery-policy.ts`. Edits enumerated in
   [companion §D](03-plan-r2-companion.md#d-schema--policy-detail-plan-step-7);
   loading an old `.saivage.json` is a hard validation error naming
   the new key ([acceptance #10](02-design-r3.md#5-recommendation)).
   - Verify: `npx tsc --noEmit`;
     `npm test -- --runInBand tests/agents/config-schema.test.ts tests/agents/invocation-recovery-policy.test.ts`.

8. **Delete `src/agents/recovery.ts`, rewrite `invokeAgent` as the
   orchestrator body, wire collaborators (atomic).** Deleting the
   module without simultaneously rewriting `agent-adapter.ts` would
   leave the tree red, so r1 steps 11–13 collapse into this commit.
   - Delete: `src/agents/recovery.ts`,
     `tests/agents/recovery.test.ts`.
   - Edit: `src/agents/agent-adapter.ts`, `src/runtime/runtime.ts` (or
     wherever `new AgentAdapter(...)` is called),
     `tests/agents/integration.test.ts` (L18, L221 — replace
     `invokeWithRecovery` with an `OuterAttemptLoop` test driver),
     `tests/utils/agents-module-boundary.test.ts` (L54 — update the
     asserted symbol set; `invokeWithRecovery` no longer expected).
   - Action: replace `agent-adapter.ts` L225–L497 with the ~60-line
     body from [§2.4](02-design-r3.md#24-top-level-orchestration);
     inject the seven collaborators via the constructor; delete
     `envelopeTo{Planner,Executor,Reviewer}Result` (L49–L75) and the
     `role === 'planner' && resultStatus === 'continue'` ladder
     (L484–L495); `invokePlanner` / `invokeExecutor` /
     `invokeReviewer` pass `(contract, statusProjector)` per §2.4.
   - Verify: `npx tsc --noEmit`; `npm run build`;
     `npm test -- --runInBand tests/agents/integration.test.ts tests/utils/agents-module-boundary.test.ts`.

9. **Add unit tests for the new collaborators.** Six new files listed
   in [companion §C](03-plan-r2-companion.md#c-full-test-inventory-plan-6).
   Cover: the four `ConversationOutcome` tags (success,
   `turns_exhausted`, `repair_exhausted`, `transport_failure`) with a
   fake `LlmCallFn` + fake `ContractVerifier` + fake
   `AgentToolExecutor`; the atomic `(candidates, capabilitySkips)`
   resolution; the [§2.2](02-design-r3.md#22-f08-three-axis-budget-model)
   failure-class table (axis consumed + directive emitted per row);
   `replay_outer` produced only for `provider_protocol_error` and
   post-budget transport `parse_error`; the
   [§2.3.7](02-design-r3.md#237-invocationoutcomeprojector) verdict
   table; `candidate_chain_exhausted` does not consume axis 3.
   - Verify: `npm test -- --runInBand tests/agents/conversation-runner.test.ts tests/agents/candidate-resolver.test.ts tests/agents/invocation-attempt-recorder.test.ts tests/agents/outer-attempt-loop.test.ts tests/agents/invocation-outcome-projector.test.ts tests/agents/agent-session-lifecycle.test.ts`.

10. **Run grep-based acceptance gates from
    [§5](02-design-r3.md#5-recommendation).** Confirm each of the 11
    gates: phase / `TERMINAL_TOOL_NAMES` / `maxRecoveryRetries`-family
    / `invokeWithRecovery` greps return nothing; `invokeAgent` body
    < 80 lines; one `action: 'replay_outer'` site in `src/`; verdict
    enum has the four new values; runtime return-handling has no
    `role === 'planner'` / `role === 'executor'` literal.
    See [§7](#7-validation).

## 4. New files (collaborator modules)

- `src/agents/status-projector.ts`,
  `src/agents/agent-invocation-plan.ts` (§2.3.1).
- `src/agents/candidate-resolver.ts`,
  `src/agents/agent-session-lifecycle.ts` (§2.3.2–3).
- `src/agents/conversation-runner.ts` (§2.3.4).
- `src/agents/invocation-attempt-recorder.ts`,
  `src/agents/outer-attempt-loop.ts` (§2.3.5–6).
- `src/agents/invocation-outcome-projector.ts` (§2.3.7).
- `plannerStatusProjector` / `executorStatusProjector` /
  `reviewerStatusProjector` constants appended to the three contract
  factories in `src/contracts/` (§2.3.1).

## 5. Deleted symbols

Full enumeration in
[companion §B](03-plan-r2-companion.md#b-full-deleted-symbol-enumeration-plan-5),
sourced from [02-design-r3.md §2.1](02-design-r3.md#21-f01-exact-deletions-and-replacements)
and [§2.5](02-design-r3.md#25-deletions-outside-agent-adapterts).
Headline groups: phase scaffolding and terminal-arm option types; the
three transport `opts.phase === 'terminal'` branches; the
`TERMINAL_TOOL_NAMES` / `TerminalToolName` / `terminalTool` enum trio
on the contract side; `agent-adapter.ts` per-turn machinery and
role-keyed result helpers; the whole `src/agents/recovery.ts` module;
`config-schema.ts` legacy migration entries plus the three superseded
runtime fields; and the `contract_mismatch` arm of
`invocation-recovery-policy.ts` `decideFailure`.

## 6. Tests

Inventory in
[companion §C](03-plan-r2-companion.md#c-full-test-inventory-plan-6).
Headline: step 1 rewrites the five transport / recorder / integration
suites and the `exchangeAttemptSchema` fixtures; step 7 rewrites
`config-schema.test.ts` and `invocation-recovery-policy.test.ts`;
step 8 deletes `recovery.test.ts` and edits
`integration.test.ts` L18/L221 + `agents-module-boundary.test.ts`
L54; step 9 adds six new collaborator unit tests.

## 7. Validation

After step 10:

1. `npm run typecheck` and `npm run build` are green.
2. Jest is the root test runner per
   [00-COORDINATION.md §Validation](../00-COORDINATION.md#validation-commands);
   `npm test -- --runInBand` is green for the `tests/agents/`,
   `tests/contracts/`, and `tests/utils/agents-module-boundary.test.ts`
   trees. Vitest is wired only for the `web/` workspace; this batch
   does not touch any web surface and does not invoke `npm run web:test`.
3. All 11 acceptance gates from [§5](02-design-r3.md#5-recommendation)
   hold (grep counts; `invokeAgent` body length; verdict-enum
   membership; no `role === 'planner'` / `role === 'executor'`
   literal in runtime return-handling).
4. Live deploy + smoke against the Saivage v3 service per
   [00-COORDINATION.md §Validation](../00-COORDINATION.md#validation-commands).
   Target is `saivage-v3-getrich.service` in the
   `saivage-v3-getrich-v2` container at `10.0.3.170`. The container at
   `10.0.3.112` is the v2 harness on the `saivage-v3` target project
   and is **not** the Saivage v3 deployment under test.

   ```bash
   cd /home/salva/g/ml/saivage-v3
   rsync -a --delete dist/ root@10.0.3.170:/opt/saivage-v3/dist/
   ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service'
   sleep 4
   curl -fsS http://10.0.3.170:8080/health
   curl -fsS http://10.0.3.170:8080/api/providers | jq
   ```

   Health returns 200, `/api/providers` parses, and
   `journalctl -u saivage-v3-getrich.service` shows no startup error
   referencing a deleted runtime key (`maxToolTurns`,
   `recoveryDelayMs`, `maxRecoveryRetries`).

## 8. Rollback

Each step is a single commit; rollback is `git revert` of the
affected commit(s). Steps 1, 7, and 8 each touch a disjoint file set,
so any one can be reverted independently. Steps 2–6 are additive
until step 8 wires them, so reverting step 8 alone restores the old
`invokeAgent` body and `recovery.ts` and leaves the new modules
dormant.

Full Batch C revert is `git revert` of steps 1–10 in reverse order.
No data migration is involved: the runtime-config schema fails loud
on legacy keys ([acceptance #10](02-design-r3.md#5-recommendation))
and the legacy keys are never written back to disk by the new schema,
so operators rolling back must restore the prior `.saivage.json`
runtime block from VCS or backup.
