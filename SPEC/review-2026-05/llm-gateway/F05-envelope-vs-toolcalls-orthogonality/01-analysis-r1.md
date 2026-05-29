# F05 — Envelope-vs-toolcalls orthogonality (functional analysis)

Scope of this document: a self-contained functional analysis of how Saivage v3's LLM gateway treats the JSON result envelope and provider tool-call channel as independent carriers, why that assumption diverges from real provider semantics, the failure modes it spawns, and the conceptual design alternatives a correct contract must choose between. No back-references to prior rounds or to the review process — a reader who has never seen this file should be able to implement from it alone. All file references are workspace-relative to `/home/salva/g/ml/saivage-v3/` and clickable as markdown links.

This file does NOT prescribe a single implementation. It frames the problem, surveys the alternatives, and lists the invariants the chosen design must satisfy.

## Project guideline that frames every recommendation

> Architecture-first, no backward compatibility (mandatory project guideline): Clean code and proper architecture are the top priority, even if it means more upfront work. Do NOT preserve backward compatibility with old data structures, on-disk formats, configs, or tests. Actively REMOVE code supporting old features/structures rather than keeping migration shims. Never apply "minimal change" defaults — refactor broadly when it improves the design. Applies workspace-wide.

Concretely, for this issue: do not introduce a feature flag, a "legacy envelope mode" toggle, or any branch that keeps the current orthogonal-channels assumption alive in parallel. The contract chosen below replaces the current one outright; on-disk session message rows, persisted tool-call shapes, and result-parser fallbacks that exist purely to bridge the two carriers should be removed in the same pass.

## 1. Problem statement

For three operational roles — `planner`, `executor`, `reviewer` — every LLM turn issued by [src/agents/agent-adapter.ts#L335-L345](src/agents/agent-adapter.ts#L335) is constructed as if the model has TWO independent ways to answer:

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

The `tools` array is non-empty for all three roles by construction — see [src/agents/agent-tool-catalog.ts#L80](src/agents/agent-tool-catalog.ts#L80) (`ROLE_TOOL_NAMES`) and [src/agents/agent-tool-executor.ts#L45](src/agents/agent-tool-executor.ts#L45) (`buildToolsForRole`). So the request always says: "Here are tools you may call AND give me a JSON object as your final answer."

The result type assumes the same orthogonality. [src/agents/llm-contracts.ts#L25-L29](src/agents/llm-contracts.ts#L25):

```ts
export interface LlmCompleteResult {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | null;
}
```

`content` and `toolCalls` are independent fields. There is no discriminator and no invariant relating them.

The gateway then flattens both fields into a single string before the adapter ever sees them — [src/agents/agent-llm-gateway.ts#L58](src/agents/agent-llm-gateway.ts#L58):

```ts
return result.content ?? JSON.stringify({ toolCalls: result.toolCalls });
```

The flatten rule is "content wins by `??`". If `content` is `null`/`undefined`, the gateway synthesises a JSON blob `{"toolCalls":[…]}` and pretends it was the model's text answer. The adapter's tool loop ([src/agents/agent-adapter.ts#L223](src/agents/agent-adapter.ts#L223), `handleToolCallsLoop`) then text-parses that synthesised blob back into tool calls via `parsePersistedToolCalls` ([src/agents/llm-contracts.ts#L60-L70](src/agents/llm-contracts.ts#L60)).

So the runtime:

1. Asks the model for two simultaneous result carriers.
2. Receives both as independent fields.
3. Throws one of them away by `??`.
4. Stringifies whatever remains.
5. Re-parses the string downstream as if it were the original wire payload.

This shape is wrong at the level of types (`LlmCompleteResult` cannot express the model's actual choice), wrong at the level of the request (no provider in the matrix below treats the two channels as independent), and wrong at the level of recovery (the loss happens silently inside a shim).

## 2. Where the current contract diverges from reality

The two channels are NOT orthogonal in the wire protocols Saivage v3 actually speaks. The provider-by-mode reality:

### 2.1 Per-provider behaviour matrix

| provider key | transport | tools-only request | envelope-only request (`response_format=json_object`, no tools) | tools + envelope (today's planner/executor/reviewer request) |
| --- | --- | --- | --- | --- |
| `opencode` (chat-completions proxy) | openai-chat-completions, [src/agents/llm-openai-chat-gateway.ts#L52](src/agents/llm-openai-chat-gateway.ts#L52) | works; chooses between tool_calls or content per OpenAI semantics. | works; returns `content` as a JSON string. | accepts; behaviour depends on upstream model. Some upstreams ignore one carrier; mixed responses observed. |
| `opencode-go` (chat-completions proxy) | openai-chat-completions | works. | works. | rejected at the wire with HTTP 400 `"You cannot specify response format and function call at the same time"`. The 400 is then misclassified as `server_transient` and a 60 s cooldown is applied (see Section 3, F01/F08). |
| `github-copilot` | openai-chat-completions | works. | works. | accepts; behaviour follows OpenAI chat-completions: the model either calls a tool OR produces content for that turn; it does not produce both. The runtime then has to issue a follow-up turn to obtain the envelope, and that follow-up turn drops `response_format` (see Section 3, F11). |
| `nvidia-nim` route to `deepseek-v4-pro` | openai-chat-completions | works. | works. | accepts the HTTP request, but the model answers with free-form prose (no JSON, no tool call). Downstream `extractJson` throws `ResultParseError("Could not extract valid JSON from response")` from [src/agents/result-parser.ts#L257](src/agents/result-parser.ts#L257) (see Section 3, F02). |
| `openai-codex` (Codex Responses backend) | openai-codex-backend, [src/agents/llm-openai-codex-gateway.ts#L33](src/agents/llm-openai-codex-gateway.ts#L33) | works; tool calls are first-class SSE events. | `response_format` does not exist on this transport. [src/agents/llm-openai-codex-gateway.ts#L106-L130](src/agents/llm-openai-codex-gateway.ts#L106) (`buildOpenAICodexRequest`) never forwards it — the field is silently dropped. The model is asked for JSON purely by prompt convention. | exactly equivalent to "tools-only" — `response_format` is dropped on the wire. The envelope is whatever prose the model happens to produce after its tool calls. |

Two facts follow directly from this table:

- Every transport in the matrix either rejects the combined request, conflates the two channels, or silently drops one of the two carriers. No provider in Saivage v3 actually delivers on "give me a JSON envelope AND tool calls in the same turn".
- The Codex Responses backend has no concept of `response_format` at all. It is structurally a tools-and-prose surface; the envelope, if any, is just the assistant text after the tool-call sequence.

### 2.2 Per-mode contract divergence

| call mode (today's intent) | what `LlmCompleteOptions` actually sends | what every transport actually does |
| --- | --- | --- |
| tools-only (e.g. analyst, non-envelope roles) | `tools[]` set, `response_format` unset. | Tools work as the wire spec describes. Either `content` is null and `toolCalls` is non-empty (`finish_reason: tool_calls`), or `content` is the assistant text and `toolCalls` is empty (`finish_reason: stop`). The two channels are STRICTLY EXCLUSIVE per turn — this is the OpenAI chat-completions semantics. |
| envelope-only | `tools[]` unset, `response_format=json_object` set. | Works for chat-completions transports. Silently degrades on `openai-codex-backend` to "ask the prompt to please return JSON". |
| tools + envelope (planner/executor/reviewer today) | both set. | One of: HTTP 400 (`opencode-go`), prose-only response (`nvidia-nim/deepseek-v4-pro`), mode-exclusive (chat-completions: model picks one carrier per turn), silently degraded (`openai-codex`: `response_format` dropped). |

The runtime's mental model is "tools and envelope are two parallel result slots". The wire reality is "every turn picks exactly one of {tool_calls, content}; envelope vs prose is a property of the content slot only".

### 2.3 The capability surface cannot describe this

[src/agents/provider-capabilities.ts#L116-L131](src/agents/provider-capabilities.ts#L116) (`capabilityRequestForLlmOptions`) builds a `CapabilityRequest` from `{ toolCalls, toolChoice, responseShape, streaming }`. There is no `responseFormat` axis, no `mixedCarriersPerTurn` axis, and no `toolsAndJsonModeCompatible` axis. Therefore `ModelRouter` cannot skip a candidate that will reject the combined request — the rejection has to happen at the wire and the failure has to be recovered after the fact.

The built-in capabilities table [src/agents/provider-capabilities.ts#L54-L70](src/agents/provider-capabilities.ts#L54) makes `opencode`, `opencode-go`, `github-copilot` all identical to `GLOBAL_DEFAULT_CAPABILITIES`. There is no axis on which `opencode-go` is differentiated from `opencode`, even though they have materially different acceptance of the `tools[] + response_format` combination.

## 3. Failure modes derived from the orthogonality assumption

The orthogonality assumption is the architectural seed of four sibling failure modes. Each is observable in production today; each disappears or simplifies dramatically under a correct contract (Section 4). Evidence quotes below are quoted verbatim from the sibling issue files alongside this analysis.

### 3.1 F01 — `response_format` + `tools[]` requested together

Direct manifestation of the orthogonality assumption in the option assembler. From `F01-response-format-tools-mutex.md`:

> `AgentAdapter.invokeAgent` unconditionally sets `response_format: { type: 'json_object' }` for the `planner`, `executor`, and `reviewer` roles AND always passes the per-role `tools[]` array. Several configured providers (`opencode-go`, `deepseek-v4-pro` via `nvidia-nim`) treat this combination as illegal: `opencode-go` rejects with HTTP 400 `"You cannot specify response format and function call at the same time"`, `deepseek-v4-pro` accepts the request but answers with prose, which then fails downstream JSON extraction.

F01 is the symptom; F05 is the root cause. Fixing F01 by adding a "skip `response_format` when `opencode-go` is the candidate" branch leaves the architectural contradiction untouched and re-opens the next time another provider rejects the combination or another role catalog adds tools.

### 3.2 F02 — DeepSeek prose breaks `extractJson`

When a provider accepts the combined request and silently picks the wrong carrier, the result-parser sees prose where it expects a JSON envelope. From `F02-deepseek-prose-extractjson-failure.md`:

> When `nvidia-nim/deepseek-v4-pro` is asked with both `response_format=json_object` AND `tools[]` (see F01), it accepts the request, answers with free-form prose, and the runtime then throws `ResultParseError("Could not extract valid JSON from response")` because `extractJson` has only three layered fallbacks (code-fence-first, raw-parse, brace-span slice) — none of them handle prose-with-no-JSON-block.

A contract where envelope and tools cannot be requested in the same turn eliminates the ambiguity at the source: the model is no longer asked "do you want to answer as a tool call OR as JSON content?" with no way to disambiguate.

### 3.3 F09 — `extractJson` brace-span fallback can extract wrong substring

Same module, different failure. From `F09-extractjson-brittle.md`:

> The third fallback in `extractJson` slices from the first `{` to the last `}` in the raw response and tries `JSON.parse` on the slice. For responses such as `"sure, here is the plan: {actions: [...]} and a note { not json }"` the slice spans both braces, yielding invalid JSON or — worse — valid-but-wrong JSON when the prose itself happens to bracket-balance.

F09 only exists because the envelope is delivered through a free-text channel that may contain commentary around it. If the envelope is delivered through a typed channel (a structured tool argument), this code path goes away entirely.

### 3.4 F11 — `response_format` dropped on follow-up turn; tool calls dropped when content non-empty

Two bugs that exist precisely because the runtime conflates carriers and then flattens them. From `F11-response-format-and-toolcalls-dropped-on-followup.md`:

> (a) When the planner / executor / reviewer first turn sends `response_format=json_object` (per F01) AND the model decides to call a tool, the follow-up assistant turn that delivers the final envelope is issued via a separate `LlmCompleteOptions` build that does NOT include `response_format`. So the first turn is constrained to JSON mode and the second turn is not — provider behaviour changes mid-call.
>
> (b) `AgentLlmInvocationGateway.createLlmCallFn` flattens its `LlmCompleteResult` with `result.content ?? JSON.stringify({ toolCalls })`. When a provider returns BOTH content AND toolCalls in the same message (Anthropic-style and several OpenAI-compatible servers do this), the tool calls are silently dropped and the planner sees only the content.

(a) and (b) are both downstream consequences of treating the two channels as a single bag of independent fields. A typed discriminated union for `LlmCompleteResult` removes (b) by construction; a single per-call (not per-turn) `LlmCompleteOptions` builder removes (a) by construction.

### 3.5 Common root pattern

Every failure above traces back to the same architectural decision: the runtime asks the model for two simultaneous result carriers, treats the result as two independent fields, then has to write recovery logic for each combination of (carrier present, carrier missing, carrier carries the wrong shape). The recovery logic is incoherent because the underlying contract is incoherent.

## 4. Conceptual model alternatives

Three coherent contracts are on the table. Each is internally consistent, each removes the F01/F02/F09/F11 failure surface, each has distinct tradeoffs. The chosen design must be ONE of them, not a mixture.

### Alternative A — Strictly exclusive per role: envelope-mode XOR tools-mode

The role declares which carrier it uses for its result. A planner/executor/reviewer turn is either in tools-mode (the role result is delivered as the arguments of a designated tool call, e.g. `emit_envelope`) or in envelope-mode (no tools are exposed at all on that turn). The two modes never coexist in a single request.

Two sub-flavours of this exist depending on which mode the envelope-bearing roles use:

- A.1 **Tools-only result**: define one synthetic tool per role, e.g. `emit_planner_result`, whose `parameters` schema IS the role envelope. The role-specific tool catalog already exists ([src/agents/agent-tool-catalog.ts#L26](src/agents/agent-tool-catalog.ts#L26)); add the result-tool to each catalog and require the model to call it as its terminal action. `response_format` is never requested. The result-parser becomes a tool-call argument unpacker validated by a per-role Zod schema. This matches OpenAI chat-completions semantics exactly (the wire spec already says "per turn the model picks tool_calls XOR content"). It also matches the Codex Responses transport (tool calls are first-class events; the parsed arguments are typed objects).
- A.2 **Envelope-only result, tools off the hot path**: keep `response_format=json_object`, but do not expose the role's actions as tools at all. Instead, the envelope itself carries the actions (e.g. `{ actions: [ { tool: 'create_card', args: { … } }, … ] }`) and the runtime executes them out-of-band. This is closer to the historical Saivage v2 contract.

Tradeoffs:

- A.1 wins on transport alignment: every transport in the matrix in Section 2.1 already supports "tools-only" cleanly, including `opencode-go` (which is the one that today rejects the combined request) and `openai-codex` (which today silently drops `response_format`).
- A.1 wins on parsing simplicity: the envelope arrives as a typed `arguments` JSON object, not as free text. F02 and F09 disappear.
- A.1 wins on observability: the model's intent is unambiguous in the wire log — there is exactly one tool call carrying the result, and it is named after the role.
- A.1 loses some flexibility: the model cannot interleave reasoning prose with the result. This is fine for planner/executor/reviewer (whose contracts already require structured output) and is arguably an improvement (no more prose-leaking-into-envelope incidents).
- A.2 wins on staying close to Saivage v2's mental model and on keeping the runtime tool surface separate from the LLM tool surface. It loses on requiring a parallel "action vocabulary" that is essentially a duplicate of the tool catalog, and it still has to text-parse JSON out of `content`, so F02 and F09 do not fully disappear.

For the architecture-first guideline, A.1 is the cleaner choice: it collapses two carriers into one, deletes `response_format` from the call-site entirely, and lets `extractJson` and its three fallbacks be deleted alongside.

### Alternative B — Two-phase protocol: tools first, envelope last

Recognise that a role turn is logically a two-phase computation: (phase 1) call any number of tools to gather information and effect side-effects; (phase 2) emit the final envelope. Make the phase boundary explicit in the protocol:

- Phase 1 turns are configured with `tools[]` and NO `response_format`. The model either calls tools or signals "I am done with tools" (e.g. by replying with no tool calls). The runtime never asks for an envelope during phase 1.
- Phase 2 is a single terminal turn with `tools[]` UNSET and `response_format=json_object` SET (where the transport supports it; for the Codex Responses backend the envelope is conveyed by prompt and parsed with the same per-role Zod schema). The model produces only the envelope, with no tool calls.

The runtime drives the phase transition by detecting "phase 1 ended" (a model turn with no tool calls and no envelope) and then issuing the dedicated phase-2 turn with a system message that says "Tools are no longer available. Emit your final result envelope now."

Tradeoffs:

- B aligns with how every transport in the matrix actually behaves: each turn picks exactly one carrier; the runtime just makes that explicit.
- B preserves a free-text reasoning surface during phase 1 (the model can intersperse content with tool calls) which is useful when the model wants to think out loud.
- B requires an additional round-trip per role invocation (one explicit phase-2 turn). This is a real cost — latency and token budget — but it is bounded and predictable.
- B leaves `extractJson` in place (the envelope is still in `content`), but the input is now narrower: it is a turn where tools are not available, so the model has nothing else to do but emit the envelope. F09's brace-span ambiguity is much less likely though not structurally eliminated.
- B has a clean boundary for the option assembler: there are exactly two assembled `LlmCompleteOptions` shapes (phase-1 and phase-2), built by named factory functions, never mixed.

### Alternative C — Keep them orthogonal but require provider capability gating

Accept the current contract ("tools and envelope are independent") and make it the provider's responsibility to declare whether it supports the combination. Add a `responseFormats` axis (e.g. `'text' | 'json_object' | 'json_schema'`) and a `combinesToolsAndResponseFormat: boolean` axis to `EffectiveProviderCapabilities`. Plumb them through `capabilityRequestForLlmOptions`. The router skips any candidate that does not support the requested combination.

Tradeoffs:

- C is the smallest local change; the call sites do not move.
- C requires Saivage v3 to know, per provider, which combinations are accepted. This is an external surface that drifts: a provider can change its policy without notifying us. The capability table becomes a maintenance burden of the worst kind — wrong by silent drift, with no test that catches it short of running the live transport.
- C does not address F11 (the carrier flattening shim in `agent-llm-gateway.ts` and the per-turn option drift). Those are architectural, not capability-driven, and survive any amount of capability gating.
- C does not address F09 (brace-span extraction) or F02 (prose-only response): even a provider that "accepts" the combination can answer ambiguously.
- C does not address the Codex Responses backend: there is no `response_format` field on that transport, so capability gating either reports "supports json_object" (lying about the underlying mechanism) or "does not support json_object" (truthfully, but then Codex Responses never gets selected for envelope-bearing roles, which is a major regression).
- C is the option that most clearly violates the architecture-first guideline: it preserves a known-incoherent contract behind a layer of "the providers will tell us when it's safe", instead of fixing the contract.

### Synthesis

A.1 (tools-as-only-result) and B (two-phase) are the two coherent designs. C is incompatible with the project guideline because it preserves the broken contract and outsources the inconsistency to a brittle capability table. The choice between A.1 and B is a design decision the implementation plan must make explicit; the rest of this document assumes EITHER A.1 OR B and lists invariants that must hold under both.

Note that A.1 and B are not orthogonal; the chosen design must commit to one. They cannot be combined ("use A.1 for chat-completions providers and B for Codex Responses") without re-introducing exactly the per-provider branching that A.1 was meant to eliminate.

## 5. What "good" looks like — testable invariants the design must satisfy

The chosen contract must satisfy ALL of the following. Each invariant is phrased so that it can be encoded as a unit test or a static type constraint.

1. **Single-carrier per turn.** For any single `LlmCompleteOptions` value, at most one of `{ tools, response_format }` is set. Encoded in the type: `LlmCompleteOptions` becomes a discriminated union — `{ mode: 'tools'; tools: ToolDefinition[]; tool_choice?: … }` vs `{ mode: 'envelope'; envelopeSchema: ZodSchema | { type: 'json_object' } }`. The current shape at [src/agents/llm-contracts.ts#L31-L40](src/agents/llm-contracts.ts#L31) is replaced.

2. **Single-carrier per result.** `LlmCompleteResult` is a discriminated union of `{ kind: 'tools'; calls: ToolCall[] }` vs `{ kind: 'envelope'; envelope: unknown }` vs `{ kind: 'terminal_text'; text: string }` (the last for non-envelope roles). The current shape at [src/agents/llm-contracts.ts#L25-L29](src/agents/llm-contracts.ts#L25), with both `content` and `toolCalls` populated independently, is replaced. There is no `flatten` step.

3. **No string-flatten in the gateway.** [src/agents/agent-llm-gateway.ts#L58](src/agents/agent-llm-gateway.ts#L58) (`return result.content ?? JSON.stringify({ toolCalls: result.toolCalls })`) is deleted. The gateway returns the structured result. The adapter consumes the structured result. No code anywhere stringifies tool calls to re-parse them later.

4. **No per-turn option drift inside a single call.** `LlmCompleteOptions` for a given role invocation is built by exactly one named factory function (e.g. `buildLlmOptionsForRole(role, phase, tools, modelParams, signal)`). Both the first turn and any follow-up turns inside the same invocation route through the same factory. The current second build site inside `handleToolCallsLoop` ([src/agents/agent-adapter.ts#L196](src/agents/agent-adapter.ts#L196)) is replaced.

5. **Envelope is parsed by a typed schema, not by text heuristics.** Each role declares a Zod schema for its envelope. Under A.1, the envelope IS the validated tool-call arguments. Under B, the envelope is the validated parse of the phase-2 `content`. Either way, `extractJson` at [src/agents/result-parser.ts#L257](src/agents/result-parser.ts#L257) is deleted, along with the three-layer brace-span fallback. The Zod failure carries the schema diff and the first 200 characters of the raw response.

6. **Capability surface admits the new shape.** `EffectiveProviderCapabilities` and `CapabilityRequest` are extended to declare, per provider, which of the two modes it supports (tools-mode always; envelope-mode where applicable). `capabilityRequestForLlmOptions` at [src/agents/provider-capabilities.ts#L116](src/agents/provider-capabilities.ts#L116) is regenerated from the new request shape. The router skips candidates that cannot serve the requested mode BEFORE the wire call, not after.

7. **Codex Responses backend is a first-class participant.** The chosen contract must work on `openai-codex-backend` ([src/agents/llm-openai-codex-gateway.ts#L33](src/agents/llm-openai-codex-gateway.ts#L33)) without `response_format`. Under A.1, this is automatic (`response_format` is never sent). Under B, this requires the phase-2 turn to enforce envelope shape by prompt + Zod validation, with the gateway transparently mapping the absence of `response_format` to a tightened prompt convention.

8. **Failures are typed.** A wire-level rejection of an option combination, a prose-where-envelope-expected response, and a tool-call-with-unexpected-arguments response are three distinct typed failures that classify to three distinct recovery actions in `InvocationRecoveryPolicy.decideFailure` ([src/agents/invocation-recovery-policy.ts#L120](src/agents/invocation-recovery-policy.ts#L120)). None of them maps to `cooldown_and_failover` for a wire-level contract mismatch.

9. **No backward-compatibility shim survives.** No code path remains that constructs the old `tools + response_format` request shape. No on-disk session-history row remains that encodes the old `{toolCalls: [...]}`-stringified-as-content format; rows already on disk that have that shape are not migrated, they are read with a parser that REJECTS them so the older sessions are clearly broken rather than silently mis-parsed. (Per project guideline: actively remove the old shape; do not bridge it.)

10. **Tests cover the matrix.** For each provider entry in Section 2.1 and each mode in Section 2.2, there is a test that asserts the chosen contract is honoured. The matrix is the test plan.

## 6. Out of scope for this issue

F05 is the architectural root. Several adjacent issues own concrete fixes that flow from F05 and should not be designed or merged in this issue's plan:

- **F01** — option-assembler fix at [src/agents/agent-adapter.ts#L335-L345](src/agents/agent-adapter.ts#L335). Owned by `F01-response-format-tools-mutex.md`. Under F05's chosen contract, F01's specific bug ("both spreads always emitted") is impossible by construction; F01's implementation plan should therefore reduce to "delete the old assembler and re-implement the call site against the new typed factory from F05". Do not write the F01 fix in this issue.

- **F02** — `extractJson` cannot recover prose. Owned by `F02-deepseek-prose-extractjson-failure.md`. Under A.1, the entire `extractJson` is deleted. Under B, `extractJson` is restricted to phase-2 input and replaced with a Zod-validated parser. Either way, F02's "harden the extractor" recommendations are subsumed.

- **F09** — brace-span fallback ambiguity. Owned by `F09-extractjson-brittle.md`. Same disposition as F02: deleted under A.1, narrowed under B.

- **F10** — `response_format` is not modelled as a capability. Owned by `F10-response-format-not-a-capability.md`. F05 invariant 6 mandates a capability axis for the mode chosen; F10 owns the concrete schema work for that axis and the per-provider capability table edits.

- **F11** — per-turn option drift and content/toolCalls flattening. Owned by `F11-response-format-and-toolcalls-dropped-on-followup.md`. F05 invariants 3 and 4 make F11's bugs impossible by construction; F11's implementation plan reduces to deleting the flatten shim and the duplicate option-assembler site, against the new types from F05.

- **F08** — failure classifier is HTTP-status-only and string-regex. Owned by `F08-failure-classification-fragile.md`. F05 invariant 8 requires a new failure class for wire-level contract mismatches; F08 owns the classifier change and the HTTP body parsing.

- **F03** — cooldown ignores `Retry-After` and never persists. Owned by `F03-cooldown-policy-and-persistence.md`. Independent of F05, except that F05 reduces the number of spurious cooldowns caused by mis-classified contract rejections (F01/F08 chain).

- **F04, F06, F07** — observability schemas, tool-definition serializer, fallback-chain duplication. Independent of F05.

This issue's job is to fix the contract. The sibling issues' job is to clean up the call-sites, parsers, classifiers, and capabilities that depend on it.
