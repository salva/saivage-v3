# F11 — Tool-call follow-up turns silently drop `response_format`; `agent-llm-gateway` discards tool calls when content is non-empty

## Summary

Two related bugs in the same chain of code that I uncovered while mapping the subsystem; neither is in the operator's evidence pack.

(a) When the planner / executor / reviewer first turn sends `response_format=json_object` (per F01) AND the model decides to call a tool, the follow-up assistant turn that delivers the final envelope is issued via a separate `LlmCompleteOptions` build that does NOT include `response_format`. So the first turn is constrained to JSON mode and the second turn is not — provider behaviour changes mid-call.

(b) `AgentLlmInvocationGateway.createLlmCallFn` flattens its `LlmCompleteResult` with `result.content ?? JSON.stringify({ toolCalls })`. When a provider returns BOTH content AND toolCalls in the same message (Anthropic-style and several OpenAI-compatible servers do this), the tool calls are silently dropped and the planner sees only the content. The role then either acts on partial information or fails downstream JSON extraction.

## Evidence

(a) Inconsistent `response_format` across turns:
- First turn assembly: [src/agents/agent-adapter.ts#L342](src/agents/agent-adapter.ts#L342) (see F01 snippet).
- Follow-up turn assembly inside the tool-call loop: search the same file for the second `LlmCompleteOptions` construction near line 256 (within `handleToolCallsLoop`). That builder omits the `response_format` spread present in the first construction.

(b) `LlmCallFn` flattening drops tool calls:
- [src/agents/agent-llm-gateway.ts#L46-L62](src/agents/agent-llm-gateway.ts#L46)
```ts
return async (...args) => {
  const result = await client.complete(args);
  return result.content ?? JSON.stringify({ toolCalls: result.toolCalls });
};
```
`??` returns `result.content` if non-null-non-undefined; an empty string `""` short-circuits to the tool-call stringification, but any non-empty content (even a stray space) preempts the tool calls.

- The downstream parser only inspects whichever channel the flattening produced:
  [src/agents/llm-contracts.ts#L70](src/agents/llm-contracts.ts#L70) — `parsePersistedToolCalls(content)` walks the content string.
- The adapter expects the gateway to be the single source of truth for tool calls:
  [src/agents/agent-adapter.ts#L196-L240](src/agents/agent-adapter.ts#L196) — it text-parses, it does not consult `LlmCompleteResult.toolCalls` directly (because the result has already been flattened into a string by the gateway).

## Category

new — not in the operator's brief.

## Severity

medium — (a) is observable only with providers that change behaviour based on `response_format`; (b) is a silent data loss any time a provider emits mixed content. Either could be biting today and being misdiagnosed as a model artefact.

## Transversality

scoped to `agent-adapter.ts` (the option assembler and tool loop) and `agent-llm-gateway.ts` (the flattening shim). The fix is small.

## Recommended direction

- For (a): factor `buildLlmOptionsForRole(role, tools, modelParams, signal)` out of both call sites so every turn shares one source of truth, then defer to F01's design.
- For (b): change `LlmCallFn` to return `LlmCompleteResult` directly (or a discriminated union per F05). Stop flattening into a string; stop text-parsing tool calls back from content in `agent-adapter`. The persisted `tool_calls` field on the chat history (`parsePersistedToolCalls`) can be preserved as the storage format without dictating the in-memory shape.

## Cross-links

- F01 — same option assembler.
- F05 — same flattening shim; same conflation.
- F10 — capability-side counterpart to (a).
