# Agent Invocation Runtime — Subsystem Map

Scope: the per-turn loop that drives one planner / executor / reviewer invocation
from the moment the surrounding flow calls `invokeAgent` until a typed result is
returned (or the candidate chain is exhausted). Source paths below are relative
to `saivage-v3/`.

## Components grouped by responsibility

### 1. Orchestration entry point — `AgentAdapter`

- Purpose: single fan-in for every role invocation; owns the candidate-chain
  loop, the per-candidate tool-turn loop, session lifecycle, and the
  envelope-to-typed-result projection.
- Key files: [agent-adapter.ts](src/agents/agent-adapter.ts).
- Public surface: `invokePlanner`, `invokeExecutor`, `invokeReviewer`,
  `reinvokeSession`, `callMcpTool`, `cancelSession`, `forceCancelSession`,
  `getHandoffSummary`, `setLlmCallFn`, `setMcpManager`, `setSkillsEngine`,
  `setActivationLedger`.
- Direct dependencies inside the agent layer:
  `AgentSessionCoordinator`, `AgentToolExecutor`, `AgentLlmInvocationGateway`,
  `AgentRoleRunner`, `PlannerControlExecutor`, `RoleToolPolicy` (via the tool
  executor), `defaultInvocationRecoveryPolicy`, `invokeWithRecovery`,
  `ROLE_RESULT_TOOLS` / `ROLE_RESULT_TOOL_NAMES`, `validateTerminalToolCall`,
  `buildLlmOptions`, `buildReviewerPrompt`, `serializeToolCallMessage`,
  `parseDeferredActivationEnvelope`, `injectQueuedSyntheticPlannerNotes`.
- Per-turn contract role: builds the role-aware tool list, swaps phases
  implicitly by passing `'tools'` to `buildLlmOptions` and appending the
  terminal `emit_*_result` tool to the list every turn, detects terminal tool
  calls, validates the envelope shape, synthesises `continue` / `blocked`
  envelopes for deferred `activate_card`, and emits the assistant `model_repair`
  nudge that the tactical mitigation in commit `a2a6f05` introduced.

### 2. Per-turn LLM options shaping — `llm-options-factory`

- Purpose: produce the `LlmCompleteOptions` discriminated union for one turn.
- Key files: [llm-options-factory.ts](src/agents/llm-options-factory.ts),
  [llm-contracts.ts](src/agents/llm-contracts.ts).
- Public surface: `buildLlmOptions(role, phase, tools, modelParams, signal,
  recorder)`, `deriveTerminalTool(opts)`, `LlmRolePhase` (`'tools' |
  'terminal'`), `LlmCompleteOptionsTools`, `LlmCompleteOptionsTerminal`.
- Direct dependencies: `ROLE_RESULT_TOOL_NAMES`, `EnvelopeBearingRole`.
- Per-turn contract role: encodes the phase distinction in the type system —
  the `terminal` branch demands a single tool of the canonical name. The hot
  path in `AgentAdapter.invokeAgent` only ever calls it with `'tools'`, so the
  terminal branch is currently load-bearing only for typing and tests.

### 3. Per-turn LLM call gateway — `AgentLlmInvocationGateway`

- Purpose: lazily build provider transport clients per `(baseUrl, apiKey)`
  cache key, wire an exchange recorder per session, and expose an
  `LlmCallFn(candidate, system, messages, sessionId, opts)` closure that the
  adapter installs via `setLlmCallFn`.
- Key files: [agent-llm-gateway.ts](src/agents/agent-llm-gateway.ts).
- Public surface: `createLlmCallFn()`, `flushRecorders()`.
- Direct dependencies: `LlmProviderGateway`, `resolveLlmTransportConfig`,
  `createLlmExchangeRecorder`.
- Per-turn contract role: turns each adapter call into a transport call and
  returns the typed `LlmCompleteResult` (`tool_calls` or `message`). It does
  not enforce or interpret the role contract; that is the adapter's job.

### 4. Tool dispatch — `AgentToolExecutor`

- Purpose: route an inbound tool call to the right execution surface
  (toolRuntime, planner-control, MCP wrapper, workspace tool, skill loader).
- Key files: [agent-tool-executor.ts](src/agents/agent-tool-executor.ts),
  [planner-control-executor.ts](src/agents/planner-control-executor.ts),
  [role-tool-policy.ts](src/agents/role-tool-policy.ts).
- Public surface: `processToolCall`, `buildToolsForRole`,
  `getToolNamesForRole`, `callMcpTool`. `PlannerControlExecutor.execute`
  handles every planner-control tool (`activate_card`, `cancel_card`, the
  three `report_goal_*` aliases, `move_card`, `reorder_child`,
  `queue_notification`).
- Direct dependencies: `ToolRuntime`, `AgentToolCatalog`, `RoleToolPolicy`,
  `PlannerControlExecutor`, `analyst-tools`, `workspace-tools`,
  `skill-tools`, `SkillsEngine`.
- Per-turn contract role: produces the `tool_result` / `tool_error` rows the
  adapter appends to the session before the next turn. It also produces the
  `deferred` envelope inside `activate_card` results that the adapter then
  pattern-matches to synthesise planner `continue` / `blocked` envelopes.

### 5. Session lifecycle and cancellation — `AgentSessionCoordinator`

- Purpose: own per-session abort controllers, cancelled-session set, hook
  notifications, build the model message window, and surface handoff
  summaries.
- Key files: [agent-session-coordinator.ts](src/agents/agent-session-coordinator.ts).
- Public surface: `notifySessionCreated`, `publishSessionStarted`,
  `trackAbortController`, `clearAbortController`, `cancelSession`,
  `forceCancelSession`, `isCancelled`, `clearCancellation`, `buildModelMessages`,
  `getHandoffSummary`, `getActiveSessionHandoffs`,
  `publishCancelledRetryStop`.
- Direct dependencies: session-persistence helpers, `NotificationCenter`.
- Per-turn contract role: returns the persisted session message log + any
  pending notification injection as the prompt context for each turn, and
  detects whether the loop must abort because a cancel arrived.

### 6. Role identity and self-check accounting — `AgentRoleRunner`

- Purpose: track which role last ran on this adapter and append a self-check
  block to the system prompt every N rounds.
- Key files: [agent-role-runner.ts](src/agents/agent-role-runner.ts),
  `buildSelfCheckPrompt` in [system-prompt.ts](src/agents/system-prompt.ts).
- Public surface: `resetOnRoleChange(role)`, `applySelfCheck(role, system,
  sessionId)`.
- Direct dependencies: `getSelfCheckThreshold`, `buildSelfCheckPrompt`.
- Per-turn contract role: mutates the system prompt outside the contract
  itself — a parallel "talk to the agent" channel that bypasses the envelope.

### 7. System prompts — `system-prompt.ts`

- Purpose: build the planner / executor / reviewer / self-check prompts.
- Key files: [system-prompt.ts](src/agents/system-prompt.ts).
- Public surface: `buildPlannerPrompt`, `buildExecutorPrompt`,
  `buildReviewerPrompt`, `buildSelfCheckPrompt`, `systemPromptBuilder`.
- Direct dependencies: none (string builders).
- Per-turn contract role: documents the JSON envelope the agent should
  produce, but does so as "wrap it in a code block or return raw JSON" — the
  prompt and the runtime contract (`emit_*_result` tool call) disagree about
  the surface form of the return.

### 8. Result envelopes and terminal-tool wiring

- Purpose: define the zod schemas for the three role envelopes; expose them
  as JSON-schema function definitions (`emit_planner_result`,
  `emit_executor_result`, `emit_reviewer_result`); validate the terminal tool
  call.
- Key files: [role-envelope-schemas.ts](src/agents/role-envelope-schemas.ts),
  [role-result-tools.ts](src/agents/role-result-tools.ts),
  [terminal-protocol.ts](src/agents/terminal-protocol.ts),
  [persisted-tool-call.ts](src/agents/persisted-tool-call.ts).
- Public surface: `PlannerResultSchema`, `ExecutorResultSchema`,
  `ReviewerResultSchema`, `ENVELOPE_SCHEMAS`, `EnvelopeBearingRole`,
  `ROLE_RESULT_TOOLS`, `ROLE_RESULT_TOOL_NAMES`, `validateTerminalToolCall`,
  `serializeToolCallMessage`, `parseToolCallMessage`,
  `parseToolCallArgsAgainstSchema`.
- Direct dependencies: `zod`, `reviewerResultSchema` from shared schemas,
  `LlmRequestError`, `zodToJsonSchemaMini`.
- Per-turn contract role: the only place where the runtime expresses the
  "what counts as a finished invocation" answer. The role -> tool-name map and
  the role -> schema map are both global constants — adding a role or
  per-invocation contract is impossible without forking the maps.

### 9. Failure typing and classifiers

- Purpose: shape a typed `LlmFailure` discriminated union used everywhere the
  runtime decides what to do with an error.
- Key files: [llm-failure.ts](src/agents/llm-failure.ts),
  [llm-failure-classifiers.ts](src/agents/llm-failure-classifiers.ts).
- Public surface: `LlmFailure`, `LlmRequestError`, `unwrapFailure`,
  `defaultHttpClassifier`, `classifyTransportFailure`, `classifierFor`,
  `ContractMismatchSubtype` (`terminal_tool_missing`,
  `terminal_tool_unexpected`, `tool_arguments_invalid_json`,
  `tool_arguments_schema_violation`, `legacy_message_shape`, `unknown`).
- Direct dependencies: provider-specific body sniffing
  (`OpenCodeGoClassifier`).
- Per-turn contract role: `contract_mismatch` lives in the same union as
  HTTP 5xx and timeouts — semantic envelope violations and transport faults
  share one channel.

### 10. Recovery policy and retry harness

- Purpose: map a `LlmFailure` plus per-attempt context to a
  `InvocationRecoveryAction` (mark-succeeded, cooldown-and-failover,
  failover-without-cooldown, retry-same-after-delay, abort, fail-invocation)
  and an availability decision.
- Key files: [invocation-recovery-policy.ts](src/agents/invocation-recovery-policy.ts),
  [recovery.ts](src/agents/recovery.ts).
- Public surface: `InvocationRecoveryPolicy`,
  `defaultInvocationRecoveryPolicy`, `decideSuccess`, `decideFailure`,
  `decideNoCandidates`, `sanitizeRecoveryMessage`, `invokeWithRecovery`,
  `createCancellableRecovery`, `recoveryOptionsFromConfig`.
- Direct dependencies: `LlmFailure`, `Candidate`, `AvailabilityDecision`,
  `CapabilitySkipDiagnostic`, `unwrapFailure`.
- Per-turn contract role: turns a `contract_mismatch` of any subtype into
  `fail_invocation` + `abort=true`, which short-circuits the recovery harness
  and bypasses the candidate chain — the runtime gives up on the entire
  invocation as soon as the envelope check fails, regardless of how many
  turns of budget remain.

### 11. Synthetic envelopes for deferred activations

- Purpose: when the only tool the planner called in a turn was
  `activate_card` and the planner-control executor returned a `deferred`
  envelope (the runtime owns the activation lifecycle, not the planner), the
  adapter fabricates a `PlannerResult` envelope on the planner's behalf.
- Key files: in-line inside
  [agent-adapter.ts](src/agents/agent-adapter.ts) (~lines 350-385),
  envelope shape in [schemas](src/schemas/index.ts) via
  `createDeferredActivationEnvelope` and `parseDeferredActivationEnvelope`.
- Per-turn contract role: shortcut that lets the planner "transfer control"
  by calling `activate_card` instead of emitting `emit_planner_result` with
  `status:'continue'`. Couples planner activation semantics directly into the
  generic adapter loop.

### 12. Downstream consumers of the role envelopes

- Purpose: receive the typed `PlannerResult` / `ExecutorResult` /
  `ReviewerResult` returned by `AgentAdapter` and react.
- Key files: [agent-execution.ts](src/contracts/agent-execution.ts),
  [llm-exchange.ts](src/contracts/llm-exchange.ts), planner-control flows in
  `src/cards/`, `src/runtime/`, `src/web/` event consumers.
- Direct dependencies: the three exported result types and the
  `TERMINAL_TOOL_NAMES` constant duplicated in
  `src/contracts/llm-exchange.ts`.
- Per-turn contract role: closes the loop — the adapter's
  `parseEnvelope(envelope)` is the bridge that converts the wire shape into
  the contract types these consumers depend on.

## Hot-path call graph

```
invokeAgent(role, goalId, cardId, prompt, ctx, parseEnvelope)
  AgentSessionCoordinator.publishSessionStarted
  resolve candidate chain (ProviderRegistry + ModelRouter)
  invokeWithRecovery(agentFn, opts)
    agentFn(recoveryCtx):
      for candidate in chain:
        loop turn = 0 .. maxToolTurns:
          AgentSessionCoordinator.isCancelled? -> throw
          AgentLlmInvocationGateway.llmCallFn(candidate, prompt, msgs, opts)
            buildLlmOptions(role, 'tools', tools + emit_*_result, ...)
            LlmProviderGateway.complete -> LlmCompleteResult
          if result.kind == 'message':
            persist text + model_repair nudge, continue  [a2a6f05 mitigation]
          if terminal_tool present:
            validateTerminalToolCall -> envelope; break
          for tc in non-terminal calls:
            AgentToolExecutor.processToolCall
              -> ToolRuntime | PlannerControlExecutor | MCP | workspace | skill
            persist tool_result/tool_error
          if only deferred activate_card returned -> synthesise envelope; break
        if envelope null after loop -> LlmRequestError(contract_mismatch,
                                                       terminal_tool_missing)
      catch LlmRequestError / Error:
        defaultInvocationRecoveryPolicy.decideFailure(err, ctx)
          -> action in {retry_same_after_delay, cooldown_and_failover,
                        failover_without_cooldown, abort_without_retry,
                        fail_invocation}
        if abort -> throw; else honour action
    recovery.ts replays agentFn up to maxRecoveryRetries
  parseEnvelope(envelope) -> PlannerResult | ExecutorResult | ReviewerResult
  completeSession / markSessionWaiting based on status
```
