# F05 — Tool-calls and JSON-envelope response are not orthogonal

## Summary

Saivage v3 currently demands TWO answer carriers from the same chat turn for planner / executor / reviewer: a tool-call array (so the role can act) and a JSON envelope in the assistant `content` (so the role can deliver its final result). Some providers reject the combination outright (F01); others accept but pick one carrier (F02). The deeper issue is that `LlmCompleteResult` and the call-site option model treat them as orthogonal even though they are not, leaving the contract under-specified and the recovery logic incoherent.

## Evidence

The two channels:
- [src/agents/llm-contracts.ts#L25-L29](src/agents/llm-contracts.ts#L25) — `LlmCompleteResult { content, toolCalls, finishReason }`. Both fields are independent strings/arrays.
- [src/agents/agent-adapter.ts#L342](src/agents/agent-adapter.ts#L342) — request side: `tools` and `response_format` are independent spreads.

Flattening into a string loses the distinction:
- [src/agents/agent-llm-gateway.ts#L58](src/agents/agent-llm-gateway.ts#L58) — `return result.content ?? JSON.stringify({ toolCalls: result.toolCalls });`. When content is present, toolCalls are dropped on the floor (see F11); when content is absent, toolCalls are stringified into a `{"toolCalls":[…]}` blob that the planner loop must text-parse back.

The text re-parse:
- [src/agents/agent-adapter.ts#L196-L240](src/agents/agent-adapter.ts#L196) — `handleToolCallsLoop` calls `parseToolCallsFromResponse(content)` to recover what the gateway has just stringified.

Provider semantics:
- OpenAI chat: tool-call mode is strictly an alternative to text/JSON content; the model is expected to either call tools or produce content, not both. JSON-mode (`response_format: json_object`) implies content, which interacts unpredictably with tool-call mode (see F01).
- OpenAI Codex (Responses API): different surface; `response_format` does not exist, tool calls are first-class events in the SSE stream — [src/agents/llm-openai-codex-gateway.ts#L106-L130](src/agents/llm-openai-codex-gateway.ts#L106).

Net effect: the runtime asks for both carriers, flattens, then re-parses by walking text. The architecture conflates "result envelope" with "model content channel".

## Category

architectural

## Severity

high — this is the root cause behind F01, F02, F09, and F11. Fixing the option-assembler symptom (F01) without addressing this leaves the same trap one regression away.

## Transversality

cross-cutting: `LlmCompleteOptions`, `LlmCompleteResult`, `LlmCallFn`, the two provider gateways, the option assembler, the tool-call loop, and the result parser.

## Recommended direction

Pick one of two coherent designs and apply it across the stack:

1. Tools-as-only-result: define a single `emit_envelope` tool for planner / executor / reviewer that takes the role-specific result as `parameters`. Do not request `response_format`. The result parser becomes a tool-call argument unpacker. This matches the OpenAI Chat semantics cleanly and works for both transports.
2. Envelope-as-only-result, tools off the hot path: leave `response_format=json_object`, but do not declare regular tools on the chat turn — instead expose them as planner-issued "actions" embedded in the envelope, which the executor runs out-of-band. This is closer to the historical Saivage v2 contract but requires more invasive runtime work.

Either way, `LlmCompleteResult` should grow a discriminated union (`{ kind: 'content', text } | { kind: 'tools', calls } | { kind: 'mixed', text, calls }`) so the flattening shim disappears and F11 cannot recur.

## Cross-links

- F01 — direct symptom.
- F02 — direct symptom.
- F09 — text-channel JSON extraction is fragile because the two channels are conflated.
- F11 — tool calls dropped because content carrier was given priority.
