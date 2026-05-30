# Batch A — Contract Verifier Core: Implementation Plan

## 1. Overview

Implements P-A2 from [02-design-r3.md §5](02-design-r3.md#5-recommendation):
introduce `Contract<TEnvelope>`, the contract verifier, the explicit
agent-loop state machine + driver, the `signal_done` tool, and the
transport/contract failure-type split. Deletes the per-turn phase
machinery, the role-specific result tools, `terminal-protocol.ts`, and the
tactical `model_repair` nudge. No backward compatibility is preserved;
every old shape is removed in the same change set as the new shape.

## 2. Ordering relative to Batch B and Batch C

Batch A is the *foundational* batch and must land before Batch B and
Batch C. Concretely:

- Batch B's `Contract<Envelope, TypedResult>` extension
  ([BATCH-B/02-design-review-r1.md](../BATCH-B-contract-surface/02-design-review-r1.md))
  imports `Contract<TEnvelope>` from `src/agents/contract.ts` introduced
  in step 4 below. Batch B step 1 depends on Batch A step 4–6.
- Batch C's verifier-related items
  ([BATCH-C/02-design-r2.md A1–A5, item 17](../BATCH-C-scaffolding-cleanup/02-design-r2.md))
  consume `ContractVerifier`, `ObligationReport`, and
  `VerifierOutcome` from `src/agents/contract-verifier.ts` introduced in
  step 5 below. Batch C step 1 depends on Batch A step 5–7.
- The deletion of the `contract_mismatch` arm of `decideFailure` is owned
  by Batch A step 3 (per [02-design-r3.md §2.1.6](02-design-r3.md#216-recovery-policy-slimming));
  Batch C's plan item that re-lists it
  ([BATCH-C/02-design-r2.md L840](../BATCH-C-scaffolding-cleanup/02-design-r2.md))
  becomes a no-op once Batch A lands.
- The `context_compaction` `MessageKind` split
  ([02-design-r3.md §2.1.9](02-design-r3.md#219-messagekind-split-for-context-compaction))
  ships in Batch A step 10; Batch C presumes it.

Batch A has no upstream dependency on Batch B or Batch C.

## 3. Steps

Steps are ordered so `npm run build` is green after each step.

1. **Add `provider_protocol_error` and rewrite `LlmTransportFailure`.**
   - Files: `src/agents/llm-failure.ts`, `src/agents/llm-errors.ts`.
   - Action: rewrite per [02-design-r3.md §2.1.1](02-design-r3.md#211-failure-split);
     delete `LlmFailure`, `ContractMismatchSubtype`, the `contract_mismatch`
     arm; export `LlmTransportFailure`, `LlmRequestError`,
     `unwrapFailure`; drop the corresponding re-exports from `llm-errors.ts`.
   - Verify: `npx tsc --noEmit` (will surface call-site breakage handled
     in steps 2–3).

2. **Update failure classifier.** Stop minting `contract_mismatch`; map
   HTTP-400-with-unrecognised-body to `provider_protocol_error`.
   - Files: `src/agents/llm-failure-classifiers.ts`.
   - Action: rewrite per [02-design-r3.md §2.1.6](02-design-r3.md#216-recovery-policy-slimming).
   - Verify: `npx tsc --noEmit`; `npx vitest run tests/agents/llm-failure-classifiers.test.ts`.

3. **Slim the recovery policy.** Delete the `contract_mismatch` arm of
   `decideFailure`; add `assertNever` exhaustiveness.
   - Files: `src/agents/invocation-recovery-policy.ts`.
   - Action: rewrite per [02-design-r3.md §2.1.6](02-design-r3.md#216-recovery-policy-slimming).
     `sanitizeRecoveryMessage` is preserved; it will be re-used by the
     verifier in step 6.
   - Verify: `npx tsc --noEmit`; `npx vitest run tests/agents/invocation-recovery-policy.test.ts`.

4. **Introduce `Contract<TEnvelope>` and the contract registry.**
   - Files: new `src/agents/contract.ts`; new directory
     `src/agents/contracts/` with `planner-contract.ts`,
     `executor-contract.ts`, `reviewer-contract.ts`,
     `analyst-contract.ts`, `index.ts` (factory registry).
   - Action: introduce types per [02-design-r3.md §3.1](02-design-r3.md#31-the-contract-object)
     and §3.3 (modules to introduce). Each per-role factory owns its zod
     envelope schema (moved from `role-envelope-schemas.ts` in step 11);
     the analyst contract uses `doneSignal.kind: 'message'`. No call site
     consumes the registry yet.
   - Verify: `npx tsc --noEmit`.

5. **Introduce the contract verifier.**
   - Files: new `src/agents/contract-verifier.ts`.
   - Action: implement per [02-design-r3.md §2.1.3](02-design-r3.md#213-contract-verifier-surface)
     with the P-A2 signature variant from §3.3
     (`check<TEnvelope>(contract, parse)`). `renderRepairMessage` routes
     through `contract.repairFormat` and pipes the rendered string
     through `sanitizeRecoveryMessage` from
     `src/agents/invocation-recovery-policy.ts`.
   - Verify: `npx tsc --noEmit`; new unit tests added in step 17.

6. **Introduce the `signal_done` tool helper.**
   - Files: new `src/agents/done-signal-tool.ts`.
   - Action: implement per [02-design-r3.md §2.1.4](02-design-r3.md#214-done-signal-tool)
     and §3.3 (contract-derived `toolName` and `argsSchema`). Export
     `DONE_SIGNAL_TOOL_NAME` and `DoneSignalToolName`.
   - Verify: `npx tsc --noEmit`.

7. **Introduce `InvocationOutcomeOf<TEnvelope>` and `RepairBudget`.**
   - Files: new `src/agents/invocation-outcome.ts`.
   - Action: implement per [02-design-r3.md §3.1](02-design-r3.md#31-the-contract-object)
     (P-A2 generic variant) and §2.1.5 (budget scope = per-`agentFn`
     attempt).
   - Verify: `npx tsc --noEmit`.

8. **Introduce the loop state machine and driver.**
   - Files: new `src/agents/agent-loop-state.ts`,
     `src/agents/agent-loop-driver.ts`.
   - Action: implement per [02-design-r3.md §3.2](02-design-r3.md#32-state-machine-for-the-agent-loop)
     and §3.3. Driver owns I/O (message persistence, event emission,
     budget increment); transitions are pure. Driver exposes
     `signalDoneFromRuntime(envelope)` per §3.4.
   - Verify: `npx tsc --noEmit`; new driver unit tests added in step 17.

9. **Collapse `LlmCompleteOptions` to the flat shape.**
   - Files: `src/agents/llm-contracts.ts`, `src/agents/llm-options-factory.ts`,
     `src/agents/llm-provider-gateway.ts`,
     `src/agents/llm-openai-chat-gateway.ts`,
     `src/agents/llm-openai-codex-gateway.ts`,
     `src/agents/analyst-llm-resolver.ts`,
     `src/agents/llm-recording.ts`, `src/scripts/probe-llm-contract.ts`.
   - Action: delete `phase`, `LlmCompleteOptionsTerminal`,
     `LlmRolePhase`, `terminalToolName`, `terminalToolDefinition`, and
     `TerminalToolName`; introduce `TerminalChoice` and `tool_choice`
     per [02-design-r3.md §2.1.8](02-design-r3.md#218-llm-option-type-and-gateway-consumers).
     Rename recorder field `terminalTool` → `doneSignalTool` and rewrite
     `deriveDoneSignalToolFromOptions`. Analyst resolver and the probe
     script switch to the flat shape.
   - Verify: `npx tsc --noEmit`;
     `npx vitest run tests/agents/llm-options-factory.test.ts tests/agents/llm-openai-chat-gateway.test.ts tests/agents/llm-openai-codex-gateway.test.ts tests/agents/llm-recording.test.ts`.

10. **Split `MessageKind` (`model_repair` vs `context_compaction`).**
    - Files: `src/schemas/types.ts`, `src/schemas/validators.ts`,
      `src/agents/compaction.ts`, `web/src/api/types.ts`,
      `web/src/utils/agent-timeline/timeline.ts`, fixture file
      `tests/agents/session-persistence.test.ts`.
    - Action: per [02-design-r3.md §2.1.9](02-design-r3.md#219-messagekind-split-for-context-compaction).
      `compaction.ts` writes `'context_compaction'`; the timeline diagnostic
      predicate widens; the adapter round-stamper update lands in step 13.
    - Verify: `npx tsc --noEmit`; `npx vitest run tests/agents/compaction.test.ts`;
      `npm --prefix web run build`.

11. **Delete `terminal-protocol.ts`, `role-result-tools.ts`,
    `role-envelope-schemas.ts`; rewrite `agent-tool-catalog.ts`.**
    - Files (deleted): `src/agents/terminal-protocol.ts`,
      `src/agents/role-result-tools.ts`,
      `src/agents/role-envelope-schemas.ts`.
    - Files (edited): `src/agents/agent-tool-catalog.ts`.
    - Action: per [02-design-r3.md §2.2](02-design-r3.md#22-modules-rewritten-end-to-end-delete--replace)
      and §3.4. Tool catalogue drops `EMIT_*_RESULT`; the done-signal tool
      is appended by the driver via `buildDoneSignalTool(contract)`. Zod
      schemas were already migrated into the contract factories in step 4.
    - Verify: `npx tsc --noEmit` — call-site breakage in adapter is
      resolved in step 13.

12. **Rewrite `persisted-tool-call.ts` to throw `PersistedRowCorruptError`.**
    - Files: `src/agents/persisted-tool-call.ts`.
    - Action: per [02-design-r3.md §2.1.2](02-design-r3.md#212-persistence-errors-are-not-llmrequesterror).
      Delete `parseToolCallArgsAgainstSchema`; update callers
      (`agent-session-coordinator.ts`, session-resume code surfaced by
      `tsc`) to handle the new error class.
    - Verify: `npx tsc --noEmit`; `npx vitest run tests/agents/persisted-tool-call.test.ts`.

13. **Rewrite the adapter inner loop around the driver.**
    - Files: `src/agents/agent-adapter.ts` (constructor + `invokeAgent`
      body + diagnostic round-stamper + plain-message branch + post-loop
      throw + deferred-activation branch).
    - Action: per [02-design-r3.md §2.3](02-design-r3.md#23-agent--runtime-repair-conversation),
      §2.7, §3.4. Delete the inline `model_repair` template literals
      (L302–L320), the post-loop `terminal_tool_missing` throw (L385–L387),
      and `parseEnvelope` (L46–L60). Public methods (`invokePlanner`,
      `invokeExecutor`, `invokeReviewer`, `invokeAnalyst`) now return
      `Promise<InvocationOutcomeOf<...>>`. The round-stamper widening
      for `context_compaction` from step 10 lands here.
    - Verify: `npx tsc --noEmit`;
      `npx vitest run tests/agents/agent-adapter.test.ts`.

14. **Rewrite `PlannerControlExecutor` to use
    `driver.signalDoneFromRuntime`.**
    - Files: `src/agents/planner-control-executor.ts`.
    - Action: per [02-design-r3.md §3.4](02-design-r3.md#34-modules-rewritten-end-to-end-delete--replace)
      (planner-control bullet). Deferred-`activate_card` synthesises an
      envelope and feeds it through the same verifier path.
    - Verify: `npx tsc --noEmit`;
      `npx vitest run tests/agents/planner-control-executor.test.ts`.

15. **Update consumers of the adapter's return types.**
    - Files: `src/agents/agent-role-runner.ts` (delete `applySelfCheck`),
      `src/agents/system-prompt.ts` (read done-signal definition from
      `Contract`), supervisor/planner-control callers surfaced by `tsc`.
    - Action: per [02-design-r3.md §3.4](02-design-r3.md#34-modules-rewritten-end-to-end-delete--replace).
      Each caller narrows `outcome.kind === 'succeeded'` to access
      `envelope`; non-success arms surface upstream.
    - Verify: `npx tsc --noEmit`;
      `npx vitest run tests/agents/agent-role-runner.test.ts tests/agents/system-prompt.test.ts`.

16. **Rewrite event/exchange schemas.**
    - Files: `src/contracts/llm-exchange.ts`, `src/schemas/types.ts`,
      `src/schemas/event-catalog.ts`.
    - Action: per [02-design-r3.md §2.1.7](02-design-r3.md#217-event-and-exchange-schema-rewrites)
      and §3.10. Delete `TERMINAL_TOOL_NAMES`, `TerminalToolName`,
      `final_terminal_tool`, `terminal_tool` from `succeeded` arm and
      `'contract_mismatch'` from `LlmFailureClass`; add `contract_verdict`,
      `repair_attempts`, `contract_id`, and the
      `llm_verifier_rejection` event. Driver emits the new event from
      step 8; recorder shape lands in step 9.
    - Verify: `npx tsc --noEmit`;
      `npx vitest run tests/schemas tests/contracts`.

17. **Tests: add verifier + driver + outcome-flow tests; rewrite touched
    suites.** See §6.
    - Verify: full `npx vitest run`.

18. **Validation pass.** See §7.

## 4. New files

- `src/agents/contract.ts` — `Contract<TEnvelope>`, `ContractRegistry`,
  `DoneSignalForm`, `RepairFormat`, `ContractCheckResult<TEnvelope>`
  (signatures: [02-design-r3.md §3.1](02-design-r3.md#31-the-contract-object)).
- `src/agents/contracts/{planner,executor,reviewer,analyst}-contract.ts` —
  one factory per contract owning its zod envelope schema
  ([02-design-r3.md §3.3](02-design-r3.md#33-new-modules-to-introduce)).
- `src/agents/contracts/index.ts` — `ContractRegistry` implementation
  exposing `forPlanner/forExecutor/forReviewer/forAnalyst`.
- `src/agents/contract-verifier.ts` — `ContractVerifier`, `Obligation`,
  `ObligationReport`, `DoneArgsParse`, `createContractVerifier`
  ([02-design-r3.md §2.1.3 + §3.3](02-design-r3.md#213-contract-verifier-surface)).
- `src/agents/done-signal-tool.ts` — `DONE_SIGNAL_TOOL_NAME`,
  `buildDoneSignalTool(contract)`, `DoneSignalToolDefinition`
  ([02-design-r3.md §2.1.4](02-design-r3.md#214-done-signal-tool)).
- `src/agents/invocation-outcome.ts` — `InvocationOutcomeOf<TEnvelope>`,
  `RepairBudget`, `createRepairBudget`
  ([02-design-r3.md §3.1](02-design-r3.md#31-the-contract-object)).
- `src/agents/agent-loop-state.ts` — `AgentLoopState<TEnvelope>`,
  `AgentLoopTransitions<TEnvelope>`, `extractDoneSignal`
  ([02-design-r3.md §3.2](02-design-r3.md#32-state-machine-for-the-agent-loop)).
- `src/agents/agent-loop-driver.ts` — drives the state machine; owns
  message persistence, event emission, budget increments, and
  `signalDoneFromRuntime` ([02-design-r3.md §3.3 + §3.4](02-design-r3.md#33-new-modules-to-introduce)).

## 5. Deleted files / symbols

- `src/agents/terminal-protocol.ts` (file).
- `src/agents/role-result-tools.ts` (file).
- `src/agents/role-envelope-schemas.ts` (file; schemas migrated into
  `src/agents/contracts/`).
- `LlmFailure`, `ContractMismatchSubtype` (and their re-exports from
  `src/agents/llm-errors.ts`).
- `LlmFailureClass.'contract_mismatch'`.
- `LlmCompleteOptionsTerminal`, `LlmCompleteOptionsTools`,
  `LlmRolePhase`, `phase`, `terminalToolName`, `terminalToolDefinition`.
- `TERMINAL_TOOL_NAMES`, `TerminalToolName`, `final_terminal_tool`,
  `terminal_tool` on `LlmAttemptOutcome.succeeded`.
- `EMIT_PLANNER_RESULT`, `EMIT_EXECUTOR_RESULT`, `EMIT_REVIEWER_RESULT`,
  `ROLE_RESULT_TOOL_NAMES`, `ROLE_RESULT_TOOLS`.
- `parseToolCallArgsAgainstSchema` from `persisted-tool-call.ts`.
- `parseEnvelope` from `agent-adapter.ts`.
- `applySelfCheck` from `agent-role-runner.ts`.
- `deriveTerminalToolFromOptions`, `validateTerminalToolCall`.
- The inline `model_repair` template branch
  ([agent-adapter.ts#L302-L320](../../../../src/agents/agent-adapter.ts#L302-L320))
  and the post-loop `terminal_tool_missing` throw
  ([agent-adapter.ts#L385-L387](../../../../src/agents/agent-adapter.ts#L385-L387)).

## 6. Tests

### Delete
- `tests/agents/terminal-protocol.test.ts` (module deleted).
- `tests/agents/role-result-tools.test.ts` (module deleted).
- Any test asserting `LlmRequestError({kind:'contract_mismatch'})` or
  `LlmFailureClass.contract_mismatch` — fixtures listed in
  `tests/agents/llm-failure-classifiers.test.ts` and
  `tests/agents/invocation-recovery-policy.test.ts`.

### Rewrite
- `tests/agents/agent-adapter.test.ts` — drop terminal-tool-missing
  assertions; assert driver-mediated `succeeded` / `repair_exhausted` /
  `no_progress` outcomes.
- `tests/agents/persisted-tool-call.test.ts` — assert
  `PersistedRowCorruptError` instead of `LlmRequestError`.
- `tests/agents/llm-options-factory.test.ts` — flat-options shape, no
  `phase`.
- `tests/agents/llm-openai-{chat,codex}-gateway.test.ts` — `tool_choice`
  branches.
- `tests/agents/llm-recording.test.ts` — `doneSignalTool` field.
- `tests/agents/compaction.test.ts` — `'context_compaction'` kind.
- `tests/agents/planner-control-executor.test.ts` — driver
  `signalDoneFromRuntime` path.
- `tests/schemas/event-catalog.test.ts` — new `contract_verdict`,
  `repair_attempts`, `contract_id`, `llm_verifier_rejection` shape.

### New
- `tests/agents/contract-verifier.test.ts` —
  `parseDoneArgs`/`check`/`renderRepairMessage` per
  [02-design-r3.md §2.1.3](02-design-r3.md#213-contract-verifier-surface)
  (good envelope, invalid JSON, schema violation, redaction).
- `tests/agents/agent-loop-state.test.ts` — pure-transition table per
  [§3.2](02-design-r3.md#32-state-machine-for-the-agent-loop) covering
  `agent_turn` → `verifying` → {`done`, `repairing`, `repair_exhausted`}
  and `no_progress`.
- `tests/agents/agent-loop-driver.test.ts` — end-to-end with scripted
  LLM results: success, single-round repair, exhaustion, duplicate
  `signal_done` (`'ignored_duplicate_done'`), `no_progress`, cancellation,
  `signalDoneFromRuntime`.
- `tests/agents/done-signal-tool.test.ts` — schema built from each
  contract; tool name override path.
- `tests/agents/contracts/planner-contract.test.ts`,
  `executor-contract.test.ts`, `reviewer-contract.test.ts`,
  `analyst-contract.test.ts` — `Contract.check` golden cases per role
  envelope; analyst exercises the `doneSignal.kind: 'message'` branch.
- `tests/schemas/llm-verifier-rejection-event.test.ts` — zod parse of
  the new event with `contract_id`, `repair_round`, `obligation_codes`.

## 7. Validation

```bash
cd /home/salva/g/ml/saivage
npm run build                              # tsc + bundling
npx vitest run                             # full suite
npm --prefix web run build                 # frontend type/check (MessageKind change)
node dist/scripts/probe-llm-contract.js \
  --role planner --provider openai-chat \
  --model gpt-5 --candidate _ --signal-done
# Deploy + restart per .github/skills/saivage-development-validation/
rsync -a --delete dist/ root@10.0.3.170:/opt/saivage-v3/dist/
ssh root@10.0.3.170 systemctl restart saivage-v3-getrich.service
curl -fsS http://10.0.3.170:8080/health
```

Smoke-test the verifier loop end-to-end against the candidate that
originally triggered the operator complaint
([00-REDESIGN-BRIEF.md](../00-REDESIGN-BRIEF.md)):

```bash
node dist/scripts/probe-llm-contract.js \
  --role planner --provider nvidia-nim --account _ \
  --model meta/llama-3.3-70b-instruct \
  --simulate-plain-message --expect-no-abort
```

## 8. Rollback

Revert the change-set commit; the deletions are wholesale and the new
modules are self-contained so a `git revert` restores the pre-change
state. Restart `saivage-v3-getrich.service` after rollback.
