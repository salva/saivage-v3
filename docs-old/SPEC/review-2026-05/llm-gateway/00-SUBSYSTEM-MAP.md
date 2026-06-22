# LLM Gateway Subsystem Map

Scope: every layer between an agent role deciding to call an LLM and the parsed response being returned to that role. Read this before any per-issue file in this folder.

Conventions: paths are workspace-relative to `/home/salva/g/ml/saivage-v3/`. Line numbers are 1-based, validated against HEAD at the time of writing.

## 1. End-to-end call flow

For one role invocation (planner / executor / reviewer):

1. `AgentAdapter.invokeAgent` (entry) — [src/agents/agent-adapter.ts#L290](src/agents/agent-adapter.ts#L290)
2. Build per-role tool catalog and capability request — [src/agents/agent-adapter.ts#L293-L299](src/agents/agent-adapter.ts#L293)
3. Resolve fallback chain via `ModelRouter.resolve` — [src/agents/model-router.ts#L51](src/agents/model-router.ts#L51)
4. For each candidate (`provider/account/model`):
   - Health-check via `ProviderRegistry.isHealthy` — [src/agents/provider.ts#L289](src/agents/provider.ts#L289)
   - Emit `model_selected` — [src/agents/agent-adapter.ts#L334-L335](src/agents/agent-adapter.ts#L334)
   - Assemble `LlmCompleteOptions` (this is where `response_format=json_object` is decided) — [src/agents/agent-adapter.ts#L342](src/agents/agent-adapter.ts#L342)
   - Call `llmCallFn(candidate, system, messages, sessionId, opts)`
5. `AgentLlmInvocationGateway.createLlmCallFn` — [src/agents/agent-llm-gateway.ts#L46](src/agents/agent-llm-gateway.ts#L46)
6. `LlmProviderGateway.complete` (provider dispatch + capability re-check) — [src/agents/llm-provider-gateway.ts#L26](src/agents/llm-provider-gateway.ts#L26)
7. Provider-specific gateway: `OpenAIChatGateway.complete` or `OpenAICodexGateway.complete` — [src/agents/llm-openai-chat-gateway.ts#L52](src/agents/llm-openai-chat-gateway.ts#L52), [src/agents/llm-openai-codex-gateway.ts#L33](src/agents/llm-openai-codex-gateway.ts#L33)
8. HTTP `fetch` → response → `handleLlmHttpError` for non-2xx — [src/agents/llm-errors.ts#L73](src/agents/llm-errors.ts#L73)
9. Stream/JSON parse → `LlmCompleteResult { content, toolCalls, finishReason }` — [src/agents/llm-contracts.ts#L25](src/agents/llm-contracts.ts#L25)
10. `createLlmCallFn` flattens to a string: `result.content ?? JSON.stringify({ toolCalls })` — [src/agents/agent-llm-gateway.ts#L58](src/agents/agent-llm-gateway.ts#L58)
11. `AgentAdapter.handleToolCallsLoop` re-parses tool calls from that string — [src/agents/agent-adapter.ts#L196](src/agents/agent-adapter.ts#L196)
12. On final content, `result-parser.ts` parses the JSON envelope — [src/agents/result-parser.ts#L257](src/agents/result-parser.ts#L257)
13. On any throw, `InvocationRecoveryPolicy.decideFailure` classifies and decides next action — [src/agents/invocation-recovery-policy.ts#L120](src/agents/invocation-recovery-policy.ts#L120)
14. Events `invocation_succeeded` / `invocation_failed` are emitted — [src/agents/agent-adapter.ts#L399-L411](src/agents/agent-adapter.ts#L399)

## 2. Components

### 2.1 Role-to-model resolution and fallback config

Purpose: persisted operator-facing model routing. Roles map to ordered model lists. A separate `models.failover` (and legacy top-level `failover`) maps a model name to an ordered list of alternative model names; `models.equivalents` declares mutually-substitutable model groups.

Key files:
- [src/agents/config-schema.ts#L60-L92](src/agents/config-schema.ts#L60) — `models` section schema (open record of role → model list, plus reserved keys `temperature`, `max_tokens`, `profiles`, `routing`, `equivalents`, `failover`).
- [src/agents/config-schema.ts#L93-L121](src/agents/config-schema.ts#L93) — `providerCapabilitySchema`, `providerAccountSchema`, `providerEntrySchema`.
- [.saivage/saivage.json](.saivage/saivage.json) — live operator config.
- [src/agents/model-router.ts#L51-L100](src/agents/model-router.ts#L51) — `ModelRouter.resolve` reads the role list, applies equivalents and failover, deduplicates by `seenModels`.

Public surface: `getModelListForRole(config, role)`, `getModelParamsForRole(config, role)`, `ModelRouter.resolve(role, capabilityRequest)`, `ModelRouter.getLastCapabilitySkips()`.

Dependencies: upstream — `AgentAdapter.invokeAgent`. Downstream — `ProviderRegistry`, `provider-capabilities`.

### 2.2 Per-role tool catalog

Purpose: deterministic ordered list of tool definitions to expose to each operational role. Decoupled from the runtime tool registry; the executor pulls the runtime definition by name and falls back to the static catalog if not found.

Key files:
- [src/agents/agent-tool-catalog.ts#L26-L75](src/agents/agent-tool-catalog.ts#L26) — `PLANNER_TOOL_DEFINITIONS`, `PLANNER_CONTROL_TOOL_NAMES`, `WORKSPACE_TOOL_NAMES`.
- [src/agents/agent-tool-catalog.ts#L80](src/agents/agent-tool-catalog.ts#L80) — `ROLE_TOOL_NAMES` (planner / executor / reviewer hard-coded).
- [src/agents/agent-tool-executor.ts#L45-L51](src/agents/agent-tool-executor.ts#L45) — `buildToolsForRole(role)`.
- [src/tools/runtime.ts#L96-L107](src/tools/runtime.ts#L96) — `ToolRuntime.schema()` returns entries with extra `roles`/`action` fields.

Public surface: `AgentToolExecutor.buildToolsForRole(role)`, `AgentToolCatalog.definitionFor(name)`, `RoleToolPolicy.listToolNamesForRole(role)`.

Dependencies: upstream — `AgentAdapter`. Downstream — `LlmCompleteOptions.tools`.

### 2.3 LlmCompleteOptions surface

Purpose: provider-agnostic request shape. Single source of typing for what the call site can send.

Key files:
- [src/agents/llm-contracts.ts#L31-L40](src/agents/llm-contracts.ts#L31) — `LlmCompleteOptions { temperature, max_tokens, stream, signal, tools, tool_choice, response_format, recorder }`.
- [src/agents/llm-contracts.ts#L42-L57](src/agents/llm-contracts.ts#L42) — `LlmInvocationClient`, `LlmCallFn`.
- [src/agents/llm-contracts.ts#L25-L29](src/agents/llm-contracts.ts#L25) — `LlmCompleteResult { content, toolCalls, finishReason }`.

Public surface: types only.

Dependencies: every gateway and `agent-adapter` consume it. There is no validator, no boundary check, and no helper for constructing it.

### 2.4 Provider capabilities and built-ins

Purpose: declarative capability matching, used by the router to skip incompatible candidates before they are tried.

Key files:
- [src/agents/provider-capabilities.ts#L46-L72](src/agents/provider-capabilities.ts#L46) — `GLOBAL_DEFAULT_CAPABILITIES`, `BUILT_IN_PROVIDER_CAPABILITIES` (github-copilot, openai-codex, opencode, opencode-go).
- [src/agents/provider-capabilities.ts#L116-L131](src/agents/provider-capabilities.ts#L116) — `capabilityRequestForLlmOptions` and `supportsCapabilityRequest`.

Public surface: `EffectiveProviderCapabilities`, `CapabilityRequest`, `CapabilitySkipReason`, `capabilityRequestForLlmOptions`, `supportsCapabilityRequest`, `builtInCapabilitiesForProvider`, `mergeCapabilities`.

Notable gap: `CapabilityRequest` has no field for `response_format=json_object`; built-in capabilities have no `supportsJsonResponseFormat` axis. Capability matching cannot distinguish providers that accept `response_format` + `tools[]` from those that reject the combination. See F01, F08.

### 2.5 Provider registry, accounts, health

Purpose: candidate resolution and in-memory health tracking (cooldown).

Key files:
- [src/agents/provider.ts#L137-L222](src/agents/provider.ts#L137) — `Provider`, `Account`, candidate construction.
- [src/agents/provider.ts#L225-L365](src/agents/provider.ts#L225) — `ProviderRegistry`, `getHealth`, `isHealthy`, `markFailed`, `markSucceeded`.

Public surface: `Candidate`, `ProviderRegistry`, `Provider`, `Account`, `candidateKey`, `parseCandidateKey`.

Dependencies: registry is held inside `AgentAdapter`. There is one `AgentAdapter` per `ActiveRuntime` ([src/runtime/active-runtime.ts#L164](src/runtime/active-runtime.ts#L164)) — the cooldown map therefore survives within a process but never persists to disk and is not shared across processes. See F03.

### 2.6 Credential source resolver and transport config

Purpose: after a candidate is picked, resolve base URL, API key (or auth-profile-derived bearer), token endpoint, and a non-secret cache key. Strict provider-vs-account precedence.

Key files:
- [src/agents/credential-source-resolver.ts#L1-L200](src/agents/credential-source-resolver.ts#L1)
- [src/agents/llm-transport.ts](src/agents/llm-transport.ts) — `resolveLlmTransportConfig(projectRoot, registry, candidate)` wraps the above and exposes `{ baseUrl, apiKey, cacheKey }` to `agent-llm-gateway`.

Public surface: `CredentialSourceResolver.resolve(provider, account)`, `resolveLlmTransportConfig`.

### 2.7 Provider dispatch

Purpose: pick the right wire gateway for the candidate and re-validate capabilities.

Key files:
- [src/agents/llm-provider-gateway.ts#L26-L40](src/agents/llm-provider-gateway.ts#L26) — `LlmProviderGateway.complete` dispatches by `candidate.provider === 'openai-codex'`.
- [src/agents/llm-provider-gateway.ts#L42-L56](src/agents/llm-provider-gateway.ts#L42) — `assertCandidateCapabilities` re-derives a `CapabilityRequest` and fails fast.

Public surface: `LlmProviderGateway`, `createLlmProviderGateway`.

### 2.8 OpenAI-chat transport (opencode, opencode-go, github-copilot, nvidia-nim)

Purpose: build a `chat/completions` request, POST it, parse the JSON response or SSE stream, return `LlmCompleteResult`.

Key files:
- [src/agents/llm-openai-chat-gateway.ts#L52-L130](src/agents/llm-openai-chat-gateway.ts#L52) — `complete`.
- [src/agents/llm-openai-chat-gateway.ts#L149-L186](src/agents/llm-openai-chat-gateway.ts#L149) — `buildOpenAIChatRequest`. Maps `opts.tools` by `(t) => ({ type, function })` (drops `roles`/`action`). Forwards `opts.response_format` verbatim.
- [src/agents/llm-openai-chat-gateway.ts#L195-L215](src/agents/llm-openai-chat-gateway.ts#L195) — `sanitizeToolCallSequences` strips orphan `tool_calls` for strict providers (DeepSeek-style protocol enforcement).
- [src/agents/llm-stream-parser.ts](src/agents/llm-stream-parser.ts) — `readOpenAIChatStream`.

Dependencies: relies on `LlmCompleteOptions` shape; capabilities are checked upstream (`LlmProviderGateway`); has no per-provider awareness of `response_format` + `tools[]` compatibility. See F01, F02, F06.

### 2.9 OpenAI-codex transport (openai-codex)

Purpose: build a `/codex/responses` request with the `responses=experimental` beta header, POST it, parse the SSE stream.

Key files:
- [src/agents/llm-openai-codex-gateway.ts#L33-L97](src/agents/llm-openai-codex-gateway.ts#L33) — `complete`.
- [src/agents/llm-openai-codex-gateway.ts#L106-L130](src/agents/llm-openai-codex-gateway.ts#L106) — `buildOpenAICodexRequest`. Sets `stream: true`, `parallel_tool_calls: true` when tools present. Does NOT forward `response_format` (different surface, no field for it on this transport).
- [src/agents/llm-codex-parser.ts](src/agents/llm-codex-parser.ts) — `readOpenAICodexStream`.

### 2.10 Result parser (final-envelope JSON)

Purpose: extract the canonical role envelope from the assistant's final text turn.

Key files:
- [src/agents/result-parser.ts#L257-L271](src/agents/result-parser.ts#L257) — `extractJson` (code-fence-first, then raw, then brace span fallback).
- [src/agents/result-parser.ts#L273](src/agents/result-parser.ts#L273) — `parsePlannerResult`.
- [src/agents/result-parser.ts#L82-L94](src/agents/result-parser.ts#L82) — `ResultParseError` (carries `partial`).
- [src/agents/result-parser.ts#L210-L256](src/agents/result-parser.ts#L210) — `buildExecutorFallbackResult` (rescues an executor turn with tool evidence when extractor fails).

Dependencies: receives the string flattened by `agent-llm-gateway` (so `toolCalls` may come as `{"toolCalls":[...]}` text rather than real JSON). See F09.

### 2.11 Failure classifier and recovery policy

Purpose: deterministic mapping from `Error` subtype → `InvocationFailureClass` → `InvocationRecoveryAction`, plus event payload assembly.

Key files:
- [src/agents/llm-errors.ts](src/agents/llm-errors.ts) — error class hierarchy (`LlmAuthError`, `LlmRateLimitError`, `LlmServerError`, `LlmTimeoutError`, `LlmParseError`).
- [src/agents/llm-errors.ts#L73-L96](src/agents/llm-errors.ts#L73) — `handleLlmHttpError` (HTTP-status-only routing; bodies are not inspected for `Retry-After` / `resets_at`).
- [src/agents/invocation-recovery-policy.ts#L99-L116](src/agents/invocation-recovery-policy.ts#L99) — `classify` (instanceof-based, with a regex fallback for free-form parse errors).
- [src/agents/invocation-recovery-policy.ts#L120-L148](src/agents/invocation-recovery-policy.ts#L120) — `decideFailure` (per-class action). Rate-limit / server-transient / timeout all map to `cooldown_and_failover` with `cooldownMs = recoveryDelayMs` (a fixed value from runtime config).

Public surface: `defaultInvocationRecoveryPolicy`, `InvocationRecoveryPolicy`, `InvocationFailureClass`, `InvocationRecoveryAction`, `InvocationRecoveryDecision`.

Dependencies: consumed inside `AgentAdapter.invokeAgent`. See F03 (cooldown does not honour provider-supplied reset time), F08 (classification ignores provider-specific body shape).

### 2.12 Retry / cooldown / failover loop

Purpose: walk the candidate chain, applying cooldowns and retries until success or chain exhaustion. Wrapped by a higher-level recovery loop with its own retry budget.

Key files:
- Inner loop: [src/agents/agent-adapter.ts#L322-L426](src/agents/agent-adapter.ts#L322) — per-candidate `for (;;)` (covers `retry_same_after_delay`), then `break` to next candidate.
- Outer loop: [src/agents/recovery.ts#L82-L172](src/agents/recovery.ts#L82) — `invokeWithRecovery` retries the whole agent function up to `maxRecoveryRetries + 1` times.
- Cooldown storage: `ProviderRegistry.healthStates` — in-memory `Map` per process, no persistence ([src/agents/provider.ts#L226](src/agents/provider.ts#L226)).

Dependencies: tightly coupled to `InvocationRecoveryPolicy` decisions. See F03.

### 2.13 Event recorder / observability

Purpose: structured event log for the runtime dashboard and offline diagnostics.

Key files:
- Emission: [src/agents/agent-adapter.ts#L334-L335](src/agents/agent-adapter.ts#L334) (`model_selected`), [src/agents/agent-adapter.ts#L399-L400](src/agents/agent-adapter.ts#L399) (`invocation_succeeded`), [src/agents/agent-adapter.ts#L410-L411](src/agents/agent-adapter.ts#L410) (`invocation_failed`).
- Schemas: [src/schemas/event-catalog.ts#L49-L51](src/schemas/event-catalog.ts#L49), [src/schemas/validators.ts#L164-L166](src/schemas/validators.ts#L164), [src/schemas/types.ts#L154-L156](src/schemas/types.ts#L154).
- Recorder of full HTTP exchanges: [src/agents/llm-exchange-recorder.ts](src/agents/llm-exchange-recorder.ts), [src/agents/llm-recording.ts](src/agents/llm-recording.ts).

Observability gap quantified: the `model_selected` schema has `{session_id, provider, model, role}` but no `attempt`; `invocation_succeeded` has `{session_id, role, attempt, duration_ms}` but no `provider`/`model`; `invocation_failed` has `{session_id, role, attempt, error_message}` but no `provider`/`model`. The emission sites in the adapter pass extra fields (`failureClass`, `recoveryAction`, `cooldownMs`, `capabilitySkipReasons`) but those are NOT declared in the schemas, so they are stripped if the JSONL writer validates against the catalog. See F04.

### 2.14 Role-to-fallback chain interaction (`agent-adapter` `llmOpts` assembly)

Purpose: take per-role inputs (tool list, model params) and produce a `LlmCompleteOptions`.

Key file: [src/agents/agent-adapter.ts#L342](src/agents/agent-adapter.ts#L342)
```ts
const expectsJsonEnvelope = role === 'planner' || role === 'executor' || role === 'reviewer';
const llmOpts: LlmCompleteOptions = {
  temperature: modelParams.temperature,
  max_tokens: modelParams.maxTokens,
  signal: abortController.signal,
  ...(tools.length > 0 ? { tools, tool_choice } : {}),
  ...(expectsJsonEnvelope ? { response_format: { type: 'json_object' as const } } : {}),
};
```

This is where the F01 regression lives: `expectsJsonEnvelope` is set for the three roles that ALSO always carry `tools[]`, so every planner / executor / reviewer call now sends both, which `opencode-go` rejects and `deepseek-v4-pro` answers with prose.

The decision is duplicated downstream: `OpenAIChatGateway.buildOpenAIChatRequest` forwards `response_format` verbatim — there is no single place that owns the `tools[] ⇄ response_format` mutex. See F05, F10.

## 3. Cross-component invariants worth noting

- The flat-string `LlmCallFn` collapses `LlmCompleteResult.content` and `LlmCompleteResult.toolCalls` into one string ([src/agents/agent-llm-gateway.ts#L58](src/agents/agent-llm-gateway.ts#L58)). If a provider returns both `content` and `toolCalls`, `??` discards the tool calls. See F11.
- The capability system has no axis for `responseFormat` / JSON mode — adding one is a precondition to fixing F01 cleanly.
- The fallback chain in `.saivage/saivage.json` is keyed by `provider/model` (e.g. `"nvidia-nim/moonshotai/kimi-k2.6"`) but everywhere in code models are addressed by bare name. The router supports this via top-level `failover` ([src/agents/model-router.ts#L66-L70](src/agents/model-router.ts#L66)) but it is brittle.
