# F01 — `response_format=json_object` + `tools[]` requested together for planner/executor/reviewer

## Summary

`AgentAdapter.invokeAgent` unconditionally sets `response_format: { type: 'json_object' }` for the `planner`, `executor`, and `reviewer` roles AND always passes the per-role `tools[]` array. Several configured providers (`opencode-go`, `deepseek-v4-pro` via `nvidia-nim`) treat this combination as illegal: `opencode-go` rejects with HTTP 400 `"You cannot specify response format and function call at the same time"`, `deepseek-v4-pro` accepts the request but answers with prose, which then fails downstream JSON extraction.

## Evidence

Call-site:
- [src/agents/agent-adapter.ts#L342](src/agents/agent-adapter.ts#L342)
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

The two spreads are independent: `tools` are present (all three roles ship with a non-empty role tool catalog — [src/agents/agent-tool-catalog.ts#L80](src/agents/agent-tool-catalog.ts#L80)) and `response_format` is present at the same time.

Forwarding:
- [src/agents/llm-openai-chat-gateway.ts#L160-L168](src/agents/llm-openai-chat-gateway.ts#L160) — `buildOpenAIChatRequest` writes `body.tools` and `body.response_format` to the request body unconditionally when the option is present.

Capability gating cannot save us:
- [src/agents/provider-capabilities.ts#L116-L131](src/agents/provider-capabilities.ts#L116) — `capabilityRequestForLlmOptions` builds the `CapabilityRequest` from `{ tools, tool_choice, stream, responseShape }`. There is NO field for `response_format`. So `ModelRouter.resolve` cannot skip a candidate that lacks JSON-mode support.

Production failure surfaces:
- `opencode-go` → HTTP 400 → mapped by [src/agents/llm-errors.ts#L73-L96](src/agents/llm-errors.ts#L73) to a generic `LlmServerError` (because 400 falls through the `>=500` branch and the explicit `401`/`403`/`429` checks). This makes the failure classify as `server_transient` and triggers `cooldown_and_failover`. So the regression silently corrupts the cooldown ledger as well.
- `deepseek-v4-pro` via `nvidia-nim` → succeeds at the HTTP layer, returns prose, throws `ResultParseError("Could not extract valid JSON from response")` from [src/agents/result-parser.ts#L257-L271](src/agents/result-parser.ts#L257). See F02.

Regression source: introduced by commit `1370cb5` (per the operator brief) — earlier code did not request `response_format` when `tools[]` were present.

## Category

regression

## Severity

critical — every planner, executor, and reviewer invocation that lands on an affected provider in the failover chain fails. The failover then either masks the issue (when a JSON-mode-capable provider is later in the chain) or exhausts the chain (when several incompatible providers are stacked first).

## Transversality

cross-cutting. Touches:
- `LlmCompleteOptions` semantics (request shape).
- Provider capabilities (missing JSON-mode axis).
- Role-tool catalog (tools are always present for the three roles).
- Failure classifier (HTTP 400 collapsed into `server_transient`).
- Cooldown ledger (false transient → spurious cooldowns on healthy candidates).
- Event payload (the failed candidate ends up cooled down for the wrong reason).

## Recommended direction (sketch, not a plan)

1. Move the `tools[] ⇄ response_format` decision behind a single helper and define the contract: tools-mode trumps JSON-mode (the envelope is delivered via a dedicated `emit_envelope` tool call or, for chat-style providers, by relaxing to `response_format: 'auto'`).
2. Add a `supportsJsonResponseFormat` axis (or, better, `responseFormats: ('text' | 'json_object' | 'json_schema')[]`) to `EffectiveProviderCapabilities`. Plumb it through `capabilityRequestForLlmOptions` so incompatible candidates are skipped by the router instead of erroring at the wire.
3. Add HTTP-400 body parsing to `handleLlmHttpError` and a new `InvocationFailureClass.contract_rejection` that maps to `failover_without_cooldown`, so contract bugs do not pollute the health ledger.

## Cross-links

- F02 — downstream symptom on `deepseek-v4-pro`.
- F05 — architectural: tool-mode vs envelope-mode orthogonality.
- F08 — HTTP 400 misclassification.
- F10 — `response_format` is not modelled as a capability.
- F11 — `response_format` is silently dropped on tool-call follow-up turns, making behaviour inconsistent across turns of the same call.
