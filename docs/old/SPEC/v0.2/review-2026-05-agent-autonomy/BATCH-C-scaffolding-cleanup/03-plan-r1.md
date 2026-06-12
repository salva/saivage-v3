# Batch C — Scaffolding Cleanup: Implementation Plan

## 1. Overview

Implements P-C1 from [02-design-r3.md §5](02-design-r3.md#5-recommendation):
the F01 per-turn phase deletion, the F08 three-axis budget split, and
the F10 `invokeAgent` decomposition into seven injected collaborators.
Deletes `LlmRolePhase`, the `'tools'`/`'terminal'` discriminator across
options/transports/recorder, `TERMINAL_TOOL_NAMES`, the
`role === 'planner'` lifecycle ladder, the `a2a6f05` inline nudge, the
deferred-activation synthesis branch, the four overlapping recovery
counters, and the entire `src/agents/recovery.ts` module along with its
legacy runtime-config migration arms. No backward compatibility is
preserved; every old shape is removed in the same change set as the
new shape.

## 2. Ordering relative to Batch A and Batch B

Batch C lands **after** Batch A and Batch B. Concretely:

- The collaborators consume `Contract<Envelope, TypedResult>` from Batch
  B ([02-design-r3.md §0 A1, A2](02-design-r3.md#0-integration-surface-assumed-from-batches-a-and-b))
  via a single import; Batch C step 1 depends on Batch B having shipped
  `src/contracts/contract.ts` and the three contract factories.
- `ConversationRunner` consumes `ContractVerifier` / `ObligationReport` /
  `VerifierOutcome` from Batch A ([§0 A4](02-design-r3.md#0-integration-surface-assumed-from-batches-a-and-b))
  and `LlmTransportFailure` ([§0 A6](02-design-r3.md#0-integration-surface-assumed-from-batches-a-and-b));
  Batch C step 6 depends on Batch A steps 1, 5, 7.
- The terminal-tool name set comes from `contract.terminals` ([§0 A3, A7](02-design-r3.md#0-integration-surface-assumed-from-batches-a-and-b));
  Batch B owns the `TERMINAL_TOOL_NAMES` deletion in its own plan but
  Batch C step 2 finishes the F01 sweep across transports/recorder/tests
  that Batch B does not touch.
- The `emit_planner_deferred` second terminal is Position C from Batch B
  ([§0 A5](02-design-r3.md#0-integration-surface-assumed-from-batches-a-and-b));
  step 6 depends on Batch B having shipped that terminal.

Batch C has no upstream dependency inside its own scope on Batch A's
verifier registry shape — the verifier is consumed only as a
constructor-injected interface.

## 3. Steps

Steps are ordered so `npm run build` is green after each step.

1. **Flatten `LlmCompleteOptions` and rewrite `buildLlmOptions`.**
   - Files: `src/agents/llm-contracts.ts`,
     `src/agents/llm-options-factory.ts`.
   - Action: delete `LlmCompleteOptionsTerminal`, `LlmCompleteOptionsTools`,
     the `phase` discriminator, `LlmRolePhase`, and `deriveTerminalTool`
     per [§2.1 table + §2.1.1](02-design-r3.md#21-f01-exact-deletions-and-replacements);
     export the single `LlmCompleteOptions` record and the new
     `BuildLlmOptionsInput`-based `buildLlmOptions(input)` signature.
     Apply the coordinated rename `tool_choice`→`toolChoice`,
     `max_tokens`→`maxTokens`, `signal`→`abortSignal`.
   - Verify: `npx tsc --noEmit` (surfaces call-site breakage handled
     in steps 2–3 and 4).

2. **Sweep `phase` reads out of the three transports and the recorder.**
   - Files: `src/agents/llm-provider-gateway.ts`,
     `src/agents/llm-openai-chat-gateway.ts`,
     `src/agents/llm-openai-codex-gateway.ts`,
     `src/agents/llm-recording.ts`.
   - Action: delete the `opts.phase === 'terminal'` branches and rename
     `deriveTerminalToolFromOptions` → recorder-receives
     `terminalToolNames: readonly string[]` + `terminalToolFired: string | null`
     per [§2.1 table](02-design-r3.md#21-f01-exact-deletions-and-replacements).
     Tools list is read unconditionally from `opts.tools`.
   - Verify: `npx tsc --noEmit`; `npx vitest run tests/agents/llm-openai-chat-gateway-request.test.ts tests/agents/llm-openai-codex-gateway-request.test.ts tests/agents/llm-client-recorder.test.ts`
     (after rewriting those test bodies per step 14).

3. **Rewrite the call sites that still pass `phase`.**
   - Files: `src/agents/analyst-llm-resolver.ts`,
     `src/scripts/probe-llm-contract.ts`.
   - Action: rewrite per [§2.1 table](02-design-r3.md#21-f01-exact-deletions-and-replacements);
     analyst recorder receives `terminalToolNames: []`; the probe
     collapses to a single round-trip.
   - Verify: `npx tsc --noEmit`.

4. **Introduce `StatusProjector` and `AgentInvocationPlan`.**
   - Files: new `src/agents/status-projector.ts`,
     new `src/agents/agent-invocation-plan.ts`; appended
     `plannerStatusProjector`, `executorStatusProjector`,
     `reviewerStatusProjector` exports inside
     `src/contracts/planner-contract.ts`,
     `src/contracts/executor-contract.ts`,
     `src/contracts/reviewer-contract.ts`.
   - Action: implement per [§2.3.1](02-design-r3.md#231-agentinvocationplan-and-the-status-projector).
     No call site consumes the projector yet; the projector is exported
     from the same module that builds each contract.
   - Verify: `npx tsc --noEmit`.

5. **Introduce `CandidateResolver` and `AgentSessionLifecycle`.**
   - Files: new `src/agents/candidate-resolver.ts`,
     new `src/agents/agent-session-lifecycle.ts`.
   - Action: implement per [§2.3.2](02-design-r3.md#232-candidateresolver)
     and [§2.3.3](02-design-r3.md#233-agentsessionlifecycle).
     `AgentSessionLifecycle` absorbs the existing
     `AgentSessionCoordinator` plus the inline
     `createSession`/`assertNoActiveAgentSession`/`persistFailure`
     closures at `agent-adapter.ts` L249–L256.
   - Verify: `npx tsc --noEmit`.

6. **Introduce `ConversationRunner`.**
   - Files: new `src/agents/conversation-runner.ts`.
   - Action: implement per [§2.3.4](02-design-r3.md#234-conversationrunner).
     Consumes Batch B's `Contract` via `plan.contract.terminals` and
     `plan.contract.isTerminalToolName` / `verify`; consumes Batch A's
     `ContractVerifier` + `ObligationReport`. Deletes the planner
     `emit_planner_deferred` synthesis branch entirely (Position C); the
     `a2a6f05` plain-message nudge is not ported.
   - Verify: `npx tsc --noEmit`; new unit tests added in step 15.

7. **Introduce `InvocationAttemptRecorder` and `OuterAttemptLoop`.**
   - Files: new `src/agents/invocation-attempt-recorder.ts`,
     new `src/agents/outer-attempt-loop.ts`.
   - Action: implement per [§2.3.5](02-design-r3.md#235-invocationattemptrecorder)
     and [§2.3.6](02-design-r3.md#236-outerattemptloop). The recorder is
     the only producer of `replay_outer` ([acceptance #9](02-design-r3.md#5-recommendation));
     the outer loop only ever consumes `directive.action`.
   - Verify: `npx tsc --noEmit`; new unit tests added in step 16.

8. **Introduce `InvocationOutcomeProjector`.**
   - Files: new `src/agents/invocation-outcome-projector.ts`.
   - Action: implement per [§2.3.7](02-design-r3.md#237-invocationoutcomeprojector).
     Verdict derivation table is the one in §2.3.7; success status
     comes from `plan.statusProjector(typedResult)`.
   - Verify: `npx tsc --noEmit`.

9. **Reshape runtime-config schema for the three new knobs.**
   - Files: `src/agents/config-schema.ts`.
   - Action: per [§2.5 table rows for `config-schema.ts`](02-design-r3.md#25-deletions-outside-agent-adapterts):
     delete `LEGACY_RUNTIME_KEYS` entries `recoveryDelayMs` and
     `maxRecoveryRetries` (L13–L40); delete the
     `maxRecoveryRetries`→`max_review_retries` fallback (L39); replace
     the defaults at L181/L187/L188 with `maxAgentTurns: 16`,
     `maxRepairRounds: 3`, `maxTransportRetries: 3`,
     `transportRetryDelayMs: 60000`; delete the legacy rehydration
     block L372–L379; remove `recoveryDelayMs`/`maxRecoveryRetries`/
     `maxToolTurns` from the zod `RuntimeSection` shape and add the
     four new fields. Loading an old `.saivage.json` raises a hard
     validation error naming the new key
     ([acceptance #10](02-design-r3.md#5-recommendation)).
   - Verify: `npx tsc --noEmit`; `npx vitest run tests/agents/config-schema.test.ts`.

10. **Reshape `invocation-recovery-policy.ts` for the three-axis model.**
    - Files: `src/agents/invocation-recovery-policy.ts`.
    - Action: per [§2.2 table + §2.5 last three rows](02-design-r3.md#22-f08-three-axis-budget-model):
      rename `InvocationRecoveryContext.recoveryDelayMs` →
      `transportRetryDelayMs` and `maxRecoveryRetries` →
      `maxTransportRetries`; `attempt` means outer-loop attempt; the
      `parse_error` arm L131–L138 returns a recorder-directive shape
      (`continue_same_candidate{retryDelayMs}` until same-candidate
      budget hit, then `replay_outer{parse_error_transport_exhausted}`).
      The `contract_mismatch` arm L127–L128 was deleted by Batch A; no
      action required if already gone.
    - Verify: `npx tsc --noEmit`; `npx vitest run tests/agents/invocation-recovery-policy.test.ts`.

11. **Delete `src/agents/recovery.ts` and rewire callers to
    `OuterAttemptLoop`.**
    - Files: delete `src/agents/recovery.ts`; touch
      `tests/agents/integration.test.ts` (L18, L221) and
      `tests/utils/agents-module-boundary.test.ts` (L54).
    - Action: per [§2.5 first four rows](02-design-r3.md#25-deletions-outside-agent-adapterts).
      Delete `tests/agents/recovery.test.ts` (covered by §6 below).
    - Verify: `npx tsc --noEmit`; `npx vitest run tests/agents/integration.test.ts tests/utils/agents-module-boundary.test.ts`.

12. **Rewrite `AgentAdapter.invokeAgent` as the orchestrator body.**
    - Files: `src/agents/agent-adapter.ts`.
    - Action: replace L225–L497 with the ~60-line body in
      [§2.4](02-design-r3.md#24-top-level-orchestration); inject the
      seven collaborators via the constructor; delete
      `envelopeToPlannerResult` / `envelopeToExecutorResult` /
      `envelopeToReviewerResult` at L49–L75; delete the
      `role === 'planner' && resultStatus === 'continue'` ladder at
      L484–L495; `invokePlanner`/`invokeExecutor`/`invokeReviewer` now
      pass `(contract, statusProjector)` per §2.4.
    - Verify: `npx tsc --noEmit`; `npm run build`.

13. **Wire collaborator construction in the `AgentAdapter`
    constructor and at the dependency-injection site.**
    - Files: `src/agents/agent-adapter.ts`,
      `src/runtime/runtime.ts` (or wherever `new AgentAdapter(...)` is
      called).
    - Action: instantiate `CandidateResolver`, `AgentSessionLifecycle`,
      `ConversationRunner`, `InvocationAttemptRecorder`,
      `OuterAttemptLoop`, `InvocationOutcomeProjector` from the
      existing dependencies (router, policy, availability, recorder
      deps, eventBus, eventLogger, notificationCenter).
    - Verify: `npx tsc --noEmit`; `npm run build`.

14. **Rewrite transport-options and recorder unit tests for the flat
    shape.**
    - Files: `tests/agents/llm-openai-chat-gateway-request.test.ts`
      (L48, L75, L88); `tests/agents/llm-openai-codex-gateway-request.test.ts`
      (L48, L74, L87); `tests/agents/_llm-test-helpers.ts` (L4);
      `tests/agents/llm-client-recorder.test.ts` (L28);
      `tests/agents/llm-client-integration.test.ts` (L253);
      test fixtures asserting `terminalTool` on `exchangeAttemptSchema`.
    - Action: per [§2.1 table last six rows](02-design-r3.md#21-f01-exact-deletions-and-replacements):
      rewrite every `{ phase: 'tools' }` / `{ phase: 'terminal' }`
      construction; assert `terminalToolOffered: string[]` +
      `terminalToolFired: string | null`.
    - Verify: `npx vitest run tests/agents/llm-openai-chat-gateway-request.test.ts tests/agents/llm-openai-codex-gateway-request.test.ts tests/agents/llm-client-recorder.test.ts tests/agents/llm-client-integration.test.ts`.

15. **Add unit tests for `ConversationRunner` and `CandidateResolver`.**
    - Files: new `tests/agents/conversation-runner.test.ts`,
      new `tests/agents/candidate-resolver.test.ts`.
    - Action: cover the four `ConversationOutcome` tags (success,
      `turns_exhausted`, `repair_exhausted`, `transport_failure`) with
      a fake `LlmCallFn` + fake `ContractVerifier` + fake
      `AgentToolExecutor`; cover the atomic `(candidates,
      capabilitySkips)` resolution.
    - Verify: `npx vitest run tests/agents/conversation-runner.test.ts tests/agents/candidate-resolver.test.ts`.

16. **Add unit tests for `InvocationAttemptRecorder`,
    `OuterAttemptLoop`, `InvocationOutcomeProjector`, and
    `AgentSessionLifecycle`.**
    - Files: new `tests/agents/invocation-attempt-recorder.test.ts`,
      new `tests/agents/outer-attempt-loop.test.ts`,
      new `tests/agents/invocation-outcome-projector.test.ts`,
      new `tests/agents/agent-session-lifecycle.test.ts`.
    - Action: assert the failure-class table from [§2.2](02-design-r3.md#22-f08-three-axis-budget-model)
      (each row asserts which axis is consumed and which directive is
      emitted); assert `replay_outer` is produced only for
      `provider_protocol_error` and post-budget transport `parse_error`;
      assert the verdict table from [§2.3.7](02-design-r3.md#237-invocationoutcomeprojector);
      assert `candidate_chain_exhausted` does not consume axis 3.
    - Verify: `npx vitest run tests/agents/invocation-attempt-recorder.test.ts tests/agents/outer-attempt-loop.test.ts tests/agents/invocation-outcome-projector.test.ts tests/agents/agent-session-lifecycle.test.ts`.

17. **Run grep-based acceptance gates from [§5](02-design-r3.md#5-recommendation).**
    - Action: confirm each of the 11 acceptance gates returns the
      expected result (phase / TERMINAL_TOOL_NAMES /
      maxRecoveryRetries-family / `invokeWithRecovery` greps return
      nothing; `invokeAgent` < 80 lines; one `action: 'replay_outer'`
      site; verdict enum has the four new values; role-string equality
      check absent in runtime return-handling).
    - Verify: see [§7](#7-validation).

## 4. New files (collaborator modules)

- `src/agents/status-projector.ts` ([§2.3.1](02-design-r3.md#231-agentinvocationplan-and-the-status-projector)).
- `src/agents/agent-invocation-plan.ts` (§2.3.1).
- `src/agents/candidate-resolver.ts` ([§2.3.2](02-design-r3.md#232-candidateresolver)).
- `src/agents/agent-session-lifecycle.ts` ([§2.3.3](02-design-r3.md#233-agentsessionlifecycle)).
- `src/agents/conversation-runner.ts` ([§2.3.4](02-design-r3.md#234-conversationrunner)).
- `src/agents/invocation-attempt-recorder.ts` ([§2.3.5](02-design-r3.md#235-invocationattemptrecorder)).
- `src/agents/outer-attempt-loop.ts` ([§2.3.6](02-design-r3.md#236-outerattemptloop)).
- `src/agents/invocation-outcome-projector.ts` ([§2.3.7](02-design-r3.md#237-invocationoutcomeprojector)).
- `plannerStatusProjector` / `executorStatusProjector` /
  `reviewerStatusProjector` constants appended to the three contract
  factory modules in `src/contracts/` (§2.3.1).

## 5. Deleted symbols

Per [§2.1 table](02-design-r3.md#21-f01-exact-deletions-and-replacements)
and [§2.5 table](02-design-r3.md#25-deletions-outside-agent-adapterts):

- `LlmRolePhase`, `LlmCompleteOptionsTerminal`, `LlmCompleteOptionsTools`
  discriminator, `deriveTerminalToolFromOptions`.
- `opts.phase === 'terminal'` branches in
  `llm-provider-gateway.ts`, `llm-openai-chat-gateway.ts`,
  `llm-openai-codex-gateway.ts`.
- `TERMINAL_TOOL_NAMES` constant + `TerminalToolName` type +
  `terminalTool` enum on `exchangeAttemptSchema` + the re-export at
  `src/contracts/index.ts` L100 (Batch B owns the contract-side
  deletion; Batch C finishes the sweep).
- `agent-adapter.ts` per-turn `buildLlmOptions(role, 'tools', ...)`
  call (L295–L300), `terminalToolName` / `terminalToolDef` re-derivation
  (L292–L296), `envelopeToPlannerResult` / `envelopeToExecutorResult` /
  `envelopeToReviewerResult` (L49–L75), the `role === 'planner' &&
  resultStatus === 'continue'` lifecycle ladder (L484–L495), the
  `a2a6f05` plain-message nudge (L302–L320), the synthetic
  `contract_mismatch{terminal_tool_missing}` throw (L386), the
  `decision.abort` contract-failure rethrow (L447–L450), the
  `getLastCapabilitySkips()` re-reads (L243, L270, L395, L431), and
  the deferred-activation synthesis branch (replaced by Batch B
  Position C terminal).
- `src/agents/recovery.ts` whole module (`invokeWithRecovery`,
  `createCancellableRecovery`, `RecoveryContext`, `RecoveryOptions`,
  `InvocationAttempt`, `AgentFn`).
- `config-schema.ts` legacy keys `recoveryDelayMs`, `maxRecoveryRetries`
  in `LEGACY_RUNTIME_KEYS` and the legacy rehydration block; runtime
  fields `recoveryDelayMs`, `maxRecoveryRetries`, `maxToolTurns`.
- `invocation-recovery-policy.ts` `contract_mismatch` arm of
  `decideFailure` (deleted by Batch A; Batch C verifies it stays out).

## 6. Tests

- **Delete:** `tests/agents/recovery.test.ts` (covers the deleted
  module per §2.5 row 2).
- **Rewrite:**
  `tests/agents/llm-openai-chat-gateway-request.test.ts`,
  `tests/agents/llm-openai-codex-gateway-request.test.ts`,
  `tests/agents/_llm-test-helpers.ts`,
  `tests/agents/llm-client-recorder.test.ts`,
  `tests/agents/llm-client-integration.test.ts`,
  fixtures asserting `terminalTool` on `exchangeAttemptSchema`,
  `tests/agents/integration.test.ts` (L18/L221 replace
  `invokeWithRecovery` with an `OuterAttemptLoop` driver),
  `tests/utils/agents-module-boundary.test.ts` (L54 update expected
  symbol set), `tests/agents/config-schema.test.ts` (assert the
  hard-fail message naming the new keys),
  `tests/agents/invocation-recovery-policy.test.ts` (assert
  `parse_error` arm now produces `continue_same_candidate` /
  `replay_outer` directives).
- **New:** seven collaborator unit tests listed in steps 15–16.

## 7. Validation

After step 17:

1. `npm run build` is green.
2. `npx vitest run` is green for the whole `tests/agents/` tree, the
   `tests/contracts/` tree, and `tests/utils/agents-module-boundary.test.ts`.
3. All 11 acceptance gates from [§5](02-design-r3.md#5-recommendation)
   hold (greps return the expected counts; `invokeAgent` body length
   check; verdict-enum membership check; runtime return-handling has
   no `role === 'planner'` / `role === 'executor'` literal).
4. Saivage v3 build artefacts deploy and `curl
   http://10.0.3.112:8080/health` returns 200 with no startup error
   referencing a deleted runtime key.

## 8. Rollback

Each step is a single commit; rollback is `git revert` of the affected
commit(s). Two cross-cutting constraints make a partial revert safe:

- Steps 1–3 (F01 sweep) and steps 9–11 (recovery deletion + runtime
  knob rename) are independently revertable because they touch disjoint
  files apart from `config-schema.ts`.
- Steps 4–8 (new collaborator files) are additive until step 12 wires
  them; reverting step 12 alone restores the old `invokeAgent` body
  while leaving the new modules dormant.

A full Batch C revert is `git revert` of steps 1–17 in reverse order;
no data migration is involved because the runtime-config schema fails
loud on legacy keys ([acceptance #10](02-design-r3.md#5-recommendation))
and the legacy keys are never written back to disk by the new
schema. Operators rolling back must restore the prior `.saivage.json`
runtime block from VCS or backup.
