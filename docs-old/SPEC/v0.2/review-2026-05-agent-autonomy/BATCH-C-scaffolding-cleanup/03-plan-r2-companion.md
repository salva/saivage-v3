# Batch C Plan r2 — Companion

Detail spilled out of [03-plan-r2.md](03-plan-r2.md) to stay under the
250-line budget. Read alongside the plan; nothing here changes the
plan's commitments.

## A. F01 atomic slice — full file inventory (plan step 1)

Production files edited in one commit:

- `src/agents/llm-contracts.ts`
- `src/agents/llm-options-factory.ts`
- `src/agents/llm-provider-gateway.ts`
- `src/agents/llm-openai-chat-gateway.ts`
- `src/agents/llm-openai-codex-gateway.ts`
- `src/agents/llm-recording.ts`
- `src/agents/analyst-llm-resolver.ts`
- `src/scripts/probe-llm-contract.ts`

Tests rewritten in the same commit:

- `tests/agents/llm-openai-chat-gateway-request.test.ts`
- `tests/agents/llm-openai-codex-gateway-request.test.ts`
- `tests/agents/_llm-test-helpers.ts`
- `tests/agents/llm-client-recorder.test.ts`
- `tests/agents/llm-client-integration.test.ts`
- Any fixtures asserting `terminalTool` on `exchangeAttemptSchema`.

Per [02-design-r3.md §2.1 + §2.1.1](02-design-r3.md#21-f01-exact-deletions-and-replacements):
delete `LlmRolePhase`, `LlmCompleteOptionsTerminal`,
`LlmCompleteOptionsTools` discriminator, `deriveTerminalTool`,
`deriveTerminalToolFromOptions`; export the single
`LlmCompleteOptions` record and the `BuildLlmOptionsInput`-based
`buildLlmOptions(input)` signature; apply renames
`tool_choice`→`toolChoice`, `max_tokens`→`maxTokens`,
`signal`→`abortSignal`; delete the `opts.phase === 'terminal'`
branches; rewrite the recorder to consume `terminalToolNames` +
`terminalToolFired`; analyst recorder receives `terminalToolNames: []`;
probe collapses to a single round-trip; rewrite every
`{ phase: 'tools' }` / `{ phase: 'terminal' }` test construction;
assert `terminalToolOffered` + `terminalToolFired` in fixtures.

## B. Full deleted-symbol enumeration (plan §5)

Per [§2.1 table](02-design-r3.md#21-f01-exact-deletions-and-replacements)
and [§2.5 table](02-design-r3.md#25-deletions-outside-agent-adapterts):

- `LlmRolePhase`, `LlmCompleteOptionsTerminal`,
  `LlmCompleteOptionsTools` discriminator, `deriveTerminalTool`,
  `deriveTerminalToolFromOptions`.
- `opts.phase === 'terminal'` branches in `llm-provider-gateway.ts`,
  `llm-openai-chat-gateway.ts`, `llm-openai-codex-gateway.ts`.
- `TERMINAL_TOOL_NAMES`, `TerminalToolName`, `terminalTool` enum on
  `exchangeAttemptSchema`, and the re-export at
  `src/contracts/index.ts` L100 (Batch B owns the contract-side
  deletion; Batch C finishes the sweep).
- `agent-adapter.ts` per-turn `buildLlmOptions(role, 'tools', ...)`
  (L295–L300), `terminalToolName` / `terminalToolDef` re-derivation
  (L292–L296),
  `envelopeTo{Planner,Executor,Reviewer}Result` (L49–L75), the
  `role === 'planner' && resultStatus === 'continue'` ladder
  (L484–L495), the `a2a6f05` plain-message nudge (L302–L320), the
  synthetic `contract_mismatch{terminal_tool_missing}` throw (L386),
  the `decision.abort` contract-failure rethrow (L447–L450), the
  `getLastCapabilitySkips()` re-reads (L243, L270, L395, L431), the
  deferred-activation synthesis branch.
- `src/agents/recovery.ts` whole module (`invokeWithRecovery`,
  `createCancellableRecovery`, `RecoveryContext`, `RecoveryOptions`,
  `InvocationAttempt`, `AgentFn`).
- `config-schema.ts` legacy keys `recoveryDelayMs`,
  `maxRecoveryRetries` in `LEGACY_RUNTIME_KEYS` and the legacy
  rehydration block; runtime fields `recoveryDelayMs`,
  `maxRecoveryRetries`, `maxToolTurns`.
- `invocation-recovery-policy.ts` `contract_mismatch` arm of
  `decideFailure` (deleted by Batch A; Batch C verifies it stays out).

## C. Full test inventory (plan §6)

- **Delete:** `tests/agents/recovery.test.ts` (step 8).
- **Rewrite (step 1 unless noted):**
  `tests/agents/llm-openai-chat-gateway-request.test.ts`,
  `tests/agents/llm-openai-codex-gateway-request.test.ts`,
  `tests/agents/_llm-test-helpers.ts`,
  `tests/agents/llm-client-recorder.test.ts`,
  `tests/agents/llm-client-integration.test.ts`, fixtures asserting
  `terminalTool` on `exchangeAttemptSchema`;
  `tests/agents/integration.test.ts` L18/L221 (step 8),
  `tests/utils/agents-module-boundary.test.ts` L54 (step 8);
  `tests/agents/config-schema.test.ts` (step 7 — assert hard-fail
  naming the new keys);
  `tests/agents/invocation-recovery-policy.test.ts` (step 7 — assert
  `parse_error` arm produces `continue_same_candidate` /
  `replay_outer` directives).
- **New (step 9):** `tests/agents/conversation-runner.test.ts`,
  `tests/agents/candidate-resolver.test.ts`,
  `tests/agents/invocation-attempt-recorder.test.ts`,
  `tests/agents/outer-attempt-loop.test.ts`,
  `tests/agents/invocation-outcome-projector.test.ts`,
  `tests/agents/agent-session-lifecycle.test.ts`.

## D. Schema + policy detail (plan step 7)

`config-schema.ts`: per
[§2.5 rows for `config-schema.ts`](02-design-r3.md#25-deletions-outside-agent-adapterts)
delete `LEGACY_RUNTIME_KEYS` entries L13–L40 and the
`maxRecoveryRetries`→`max_review_retries` fallback (L39); replace
defaults at L181/L187/L188 with `maxAgentTurns: 16`,
`maxRepairRounds: 3`, `maxTransportRetries: 3`,
`transportRetryDelayMs: 60000`; delete the legacy rehydration block
L372–L379; remove `recoveryDelayMs` / `maxRecoveryRetries` /
`maxToolTurns` from the zod `RuntimeSection` and add the four new
fields. Loading an old `.saivage.json` is a hard validation error
naming the new key
([acceptance #10](02-design-r3.md#5-recommendation)).

`invocation-recovery-policy.ts`: per
[§2.2 + §2.5 last three rows](02-design-r3.md#22-f08-three-axis-budget-model)
rename `InvocationRecoveryContext.recoveryDelayMs` →
`transportRetryDelayMs` and `maxRecoveryRetries` →
`maxTransportRetries`; `attempt` means outer-loop attempt only; the
`parse_error` arm L131–L138 returns a recorder-directive shape
(`continue_same_candidate{retryDelayMs}` until same-candidate budget
hit, then `replay_outer{parse_error_transport_exhausted}`).
