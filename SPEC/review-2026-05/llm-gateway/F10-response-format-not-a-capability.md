# F10 — `response_format` is not a capability, has no single owner, and is forwarded blindly

## Summary

`response_format` is a request feature with provider-specific support but Saivage v3 has no capability axis for it. It is set in one place (the `agent-adapter` option assembler — [src/agents/agent-adapter.ts#L342](src/agents/agent-adapter.ts#L342)) and forwarded in another (the chat gateway — [src/agents/llm-openai-chat-gateway.ts#L160-L168](src/agents/llm-openai-chat-gateway.ts#L160)), with no contract telling either side what is permitted. The router cannot skip a candidate that lacks JSON-mode; the gateway cannot warn; the codex gateway silently ignores it because the Responses API has no such field.

## Evidence

Capability request and matcher:
- [src/agents/provider-capabilities.ts#L116-L131](src/agents/provider-capabilities.ts#L116)
```ts
export function capabilityRequestForLlmOptions(opts: LlmCompleteOptions): CapabilityRequest {
  return { tools: !!opts.tools?.length, toolChoice: opts.tool_choice, stream: opts.stream, responseShape: 'openai-chat-choice' };
}
```
No `responseFormat` field. The matcher in `supportsCapabilityRequest` therefore cannot decide based on JSON mode.

Built-in capabilities have no JSON-mode field:
- [src/agents/provider-capabilities.ts#L46-L72](src/agents/provider-capabilities.ts#L46) — every built-in returns the same set of axes: `transportProtocol`, `toolCalls`, `toolChoice`, `responseShape`, `streaming`, `quirks`.

Codex gateway silently ignores it:
- [src/agents/llm-openai-codex-gateway.ts#L106-L130](src/agents/llm-openai-codex-gateway.ts#L106) — `buildOpenAICodexRequest` reads `opts.tools`, `opts.stream`, `opts.temperature`, `opts.max_tokens`. `opts.response_format` is never referenced.

## Category

architectural / missing-capability

## Severity

medium-high — necessary precondition for cleanly fixing F01 (router-level skip) and for F06's typed serializer to make sense for the response side.

## Transversality

cross-cutting like F01: capabilities, router, both gateways, option assembler.

## Recommended direction

- Add `responseFormats: ('text' | 'json_object' | 'json_schema')[]` to `EffectiveProviderCapabilities`. Default to `['text']` for unknown providers, `['text', 'json_object']` for `openai-codex` and `opencode-go-with-tools-off`, and the relevant intersection for each built-in.
- Extend `CapabilityRequest` with `responseFormat?` and update `capabilityRequestForLlmOptions` to populate it from `opts.response_format`.
- Have `supportsCapabilityRequest` reject any candidate whose `responseFormats` list does not include the requested format.
- Document the matrix in one place and make it the only owner of "can provider X return JSON when tools are on?".

## Cross-links

- F01 — direct enabler.
- F05 — both speak to the same conflation.
- F06 — together they form the boundary normalization story.
- F11 — the codex gateway already silently drops `response_format`; once the chat gateway also drops it on follow-up turns the inconsistency is twofold.
