# F05 — Envelope-vs-toolcalls orthogonality (design proposals)

Scope: two concrete, self-contained designs that replace the current orthogonal `{tools[] + response_format}` contract in [src/agents/llm-contracts.ts#L25](../../../../src/agents/llm-contracts.ts#L25), [src/agents/agent-adapter.ts#L342](../../../../src/agents/agent-adapter.ts#L342), and [src/agents/agent-llm-gateway.ts#L58](../../../../src/agents/agent-llm-gateway.ts#L58). The two designs are alternative implementations of the same set of invariants (1–10 from the approved analysis); the document chooses one as the recommended target. Paths are workspace-relative to `/home/salva/g/ml/saivage-v3/` and clickable.

Both proposals delete the orthogonal-channel assumption outright. Per the workspace architecture-first / no-backward-compatibility guideline, neither proposal includes a feature flag, a "legacy envelope mode" toggle, a data-format migration shim, or a translation layer that bridges old and new shapes. The chosen proposal replaces the old contract in a single coherent pass; on-disk session-history rows that encode the old `{toolCalls: [...]}`-stringified-as-content shape are read with a parser that REJECTS them rather than bridged.

This document presents:

- Proposal F (Focused): two-phase tools-then-envelope protocol (corresponds to Alternative B in the approved analysis).
- Proposal L (Level-up): tools-as-only-result via per-role `emit_<role>_result` (corresponds to Alternative A.1).
- A side-by-side matrix of both proposals against invariants 1–10.
- A final recommendation.

Alternative A.2 (envelope-with-embedded-actions) is excluded: the approved analysis judges it strictly inferior to A.1 because it still text-parses JSON, still leaves `extractJson` ambiguity in place, and widens the gap between the envelope-bearing roles and the analyst path. Alternative C (capability-gated orthogonal) is excluded because it preserves the broken contract.

---

## 1. Shared design substrate (both proposals)

Both proposals share the same new core types, the same option-assembler factory, the same gateway return path, and the same recovery-classifier extension. Only the per-phase request shape and the consumer migration differ. The substrate is defined once here and referenced from each proposal.

### 1.1 New `LlmCompleteOptions` discriminated union

Replaces the flat object at [src/agents/llm-contracts.ts#L31](../../../../src/agents/llm-contracts.ts#L31).

```ts
export type LlmCompleteOptions =
  | LlmToolsOptions
  | LlmEnvelopeOptions;

export interface LlmCommonOptions {
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  signal?: AbortSignal;
  recorder?: LlmExchangeRecorder;
}

export interface LlmToolsOptions extends LlmCommonOptions {
  mode: 'tools';
  tools: ToolDefinition[];                  // NEVER empty in this variant.
  tool_choice: 'auto' | 'required' | { type: 'function'; function: { name: string } };
}

export interface LlmEnvelopeOptions extends LlmCommonOptions {
  mode: 'envelope';
  envelopeSchema: ZodTypeAny;               // canonical role envelope schema
  responseFormatHint: 'json_object';        // forwarded when transport supports it
}
```

Construction invariant (enforced at the call site, validated by the gateway): `tools` and `responseFormatHint` cannot coexist in the same `LlmCompleteOptions` value. The legacy fields `response_format?` and the optional `tools?` are removed; consumers must choose a mode.

### 1.2 New `LlmCompleteResult` discriminated union

Replaces the flat object at [src/agents/llm-contracts.ts#L25](../../../../src/agents/llm-contracts.ts#L25).

```ts
export type LlmCompleteResult =
  | { kind: 'tools'; calls: ToolCall[]; rawAssistantText: string | null }
  | { kind: 'envelope'; envelope: unknown; rawAssistantText: string }
  | { kind: 'terminal_text'; text: string };
```

Notes:

- `kind: 'tools'` corresponds to OpenAI `finish_reason: 'tool_calls'`. `rawAssistantText` carries any prose the model emitted alongside the tool calls (for observability only — no consumer parses it).
- `kind: 'envelope'` is produced by gateways only when the upstream `LlmCompleteOptions.mode === 'envelope'`. The envelope is the Zod-validated parse of the model's content. `rawAssistantText` is preserved for the event recorder.
- `kind: 'terminal_text'` is the analyst-style "free assistant text" result — used by roles that genuinely emit prose (analyst end-of-turn replies; the operator chat surface). Envelope-bearing roles MUST NOT receive this kind; the gateway raises `LlmContractMismatchError` if the upstream mode requested `tools` and the wire returned plain text.

The current `parsePersistedToolCalls` at [src/agents/llm-contracts.ts#L60](../../../../src/agents/llm-contracts.ts#L60) is deleted (no live consumer remains under either proposal; see migration sections).

### 1.3 New option-assembler factory

Replaces the inline spread at [src/agents/agent-adapter.ts#L342](../../../../src/agents/agent-adapter.ts#L342) AND the second build site at [src/agents/agent-adapter.ts#L280](../../../../src/agents/agent-adapter.ts#L280) (`forceFinalAnswer` / the per-turn assembly inside `handleToolCallsLoop`). New file `src/agents/llm-options-factory.ts`:

```ts
export function buildLlmOptions(
  role: AgentRole,
  phase: AgentInvocationPhase,
  tools: ToolDefinition[],
  modelParams: { temperature: number; maxTokens: number },
  signal: AbortSignal,
  recorder: LlmExchangeRecorder,
): LlmCompleteOptions { /* … see per-proposal sections … */ }

export type AgentInvocationPhase = 'tools' | 'envelope';
```

The factory is the single source of truth for `LlmCompleteOptions` shape on the adapter path. Every call site that previously assembled options inline (the two sites cited above plus any others discovered by `grep -nE 'response_format|tool_choice|max_tokens' src/agents/agent-adapter.ts`) is rewritten to call `buildLlmOptions`. Invariant 4 (no per-turn option drift) is enforced by construction.

### 1.4 Gateway return path (no flatten)

`LlmCallFn` at [src/agents/llm-contracts.ts#L52](../../../../src/agents/llm-contracts.ts#L52) changes signature:

```ts
export type LlmCallFn = (
  candidate: Candidate,
  systemPrompt: string,
  messages: AgentMessage[],
  sessionId: string,
  opts: LlmCompleteOptions,                // mandatory; mode is intrinsic
) => Promise<LlmCompleteResult>;          // structured result, NOT string
```

`AgentLlmInvocationGateway.createLlmCallFn` at [src/agents/agent-llm-gateway.ts#L48](../../../../src/agents/agent-llm-gateway.ts#L48) is rewritten to return the structured result verbatim. The line at [src/agents/agent-llm-gateway.ts#L58](../../../../src/agents/agent-llm-gateway.ts#L58) (`return result.content ?? JSON.stringify({ toolCalls: result.toolCalls });`) is DELETED. Invariant 3 is satisfied by construction.

### 1.5 Capability surface extension

Adds an axis to [src/agents/provider-capabilities.ts](../../../../src/agents/provider-capabilities.ts):

```ts
export interface EffectiveProviderCapabilities {
  // …existing axes…
  envelopeMode: 'native_json_object' | 'prompt_only' | 'unsupported';
  toolsMode: 'native' | 'unsupported';
}

export interface CapabilityRequest {
  // …existing axes…
  mode: 'tools' | 'envelope';
}
```

Built-ins ([src/agents/provider-capabilities.ts#L53](../../../../src/agents/provider-capabilities.ts#L53)) updated:

- `opencode` / `opencode-go` / `github-copilot` (chat-completions): `envelopeMode: 'native_json_object'`, `toolsMode: 'native'`.
- `openai-codex` (Codex Responses): `envelopeMode: 'prompt_only'`, `toolsMode: 'native'`.
- Any provider missing tool-call SSE support: `toolsMode: 'unsupported'`.

`capabilityRequestForLlmOptions` at [src/agents/provider-capabilities.ts#L119](../../../../src/agents/provider-capabilities.ts#L119) is rewritten to derive `mode` from `LlmCompleteOptions.mode`. The router skips a candidate when the requested mode is `'unsupported'` on that candidate. Invariant 6 is satisfied.

### 1.6 New typed failure class

Adds `LlmContractMismatchError` to [src/agents/llm-errors.ts](../../../../src/agents/llm-errors.ts). The gateway raises it in three cases:

1. Wire-level rejection of an option combination (e.g. `opencode-go` returning HTTP 400 with body matching `/response format and function call/i`).
2. Mode mismatch: the upstream requested `mode: 'envelope'` and the wire returned tool calls only, or vice versa.
3. Envelope-shape mismatch: Zod validation of the envelope failed.

`InvocationRecoveryPolicy.decideFailure` at [src/agents/invocation-recovery-policy.ts#L120](../../../../src/agents/invocation-recovery-policy.ts#L120) gains a branch:

```ts
if (error instanceof LlmContractMismatchError) {
  return {
    action: 'fail_invocation',        // not cooldown — this is a coding bug, not transient
    failureClass: 'contract_mismatch',
    markFailed: false,                 // do not cooldown the provider
    appendModelIssue: true,
    abort: true,
    cooldownMs: undefined,
    retryDelayMs: undefined,
    message: error.message,
    eventPayload: { … },
  };
}
```

Invariant 8 (typed failures, no spurious cooldown for contract mismatches) is satisfied.

---

## 2. Proposal F — Focused: two-phase tools-then-envelope

### 2.1 Idea in one paragraph

A role invocation is logically two phases: phase 1 collects information and effects side-effects via tool calls; phase 2 emits the canonical role envelope. The runtime makes the phase boundary explicit in the wire protocol: phase 1 turns are issued with `mode: 'tools'` (no `response_format`); phase 2 is a single dedicated turn with `mode: 'envelope'` (no `tools[]`). The model picks at most one carrier per turn, which matches every transport in the matrix in Section 2.1 of the approved analysis.

### 2.2 Type signatures

`buildLlmOptions` body:

```ts
export function buildLlmOptions(role, phase, tools, modelParams, signal, recorder): LlmCompleteOptions {
  if (phase === 'tools') {
    if (tools.length === 0) throw new Error(`Phase 'tools' requires non-empty tool catalog for role ${role}`);
    return {
      mode: 'tools',
      tools,
      tool_choice: 'auto',
      temperature: modelParams.temperature,
      max_tokens: modelParams.maxTokens,
      signal,
      recorder,
    };
  }
  // phase === 'envelope'
  return {
    mode: 'envelope',
    envelopeSchema: ENVELOPE_SCHEMAS[role],   // PlannerResultSchema | ExecutorResultSchema | ReviewerResultSchema
    responseFormatHint: 'json_object',
    temperature: modelParams.temperature,
    max_tokens: modelParams.maxTokens,
    signal,
    recorder,
  };
}
```

`ENVELOPE_SCHEMAS` is a new `src/agents/role-envelope-schemas.ts` that re-exports the existing Zod schemas already used by `result-parser.ts` (`PlannerResult`, `ExecutorResult`, `ReviewerResult`).

### 2.3 Per-provider request/response shape

| Provider | Phase-1 (tools) request | Phase-1 response | Phase-2 (envelope) request | Phase-2 response |
| --- | --- | --- | --- | --- |
| `opencode` (chat) | `tools[]` set, `response_format` unset | `tool_calls` OR `content` per OpenAI semantics | `tools[]` unset, `response_format: {type:'json_object'}` | `content` = JSON string |
| `opencode-go` (chat) | `tools[]` set, `response_format` unset | as above | `tools[]` unset, `response_format` set | `content` = JSON string |
| `github-copilot` (chat) | same | same | same | same |
| `nvidia-nim`/`deepseek-v4-pro` (chat) | same | same | same | `content` = JSON string |
| `openai-codex` (Codex Responses) | `tools` SSE-mapped; `response_format` never sent | `function_call` SSE events OR `output_text` | `tools` unset, `response_format` not forwarded (no such field); phase-2 system suffix enforces JSON | `output_text` = JSON string |

Note for `openai-codex`: phase-2 is implemented by appending a one-paragraph system suffix to the phase-2 turn that says "You have no tools this turn. Reply with ONLY the canonical {role} result JSON envelope; no prose, no code fences." Zod validation on the gateway side catches deviations.

[src/agents/llm-openai-chat-gateway.ts#L186](../../../../src/agents/llm-openai-chat-gateway.ts#L186) (the `if (opts?.response_format)` line) is rewritten to forward `responseFormatHint` only when `opts.mode === 'envelope'`. [src/agents/llm-openai-codex-gateway.ts#L106](../../../../src/agents/llm-openai-codex-gateway.ts#L106) (`buildOpenAICodexRequest`) is rewritten to switch on `opts.mode`: phase-1 builds with tools as today; phase-2 builds with no tools and the system-suffix injection.

### 2.4 Adapter migration

`AgentAdapter.invokeAgent` ([src/agents/agent-adapter.ts#L290](../../../../src/agents/agent-adapter.ts#L290)) is restructured into an explicit two-phase loop:

```ts
// Phase 1: tools loop
let phase1Result: LlmCompleteResult;
for (let turn = 0; turn < MAX_PHASE_1_TURNS; turn++) {
  const opts = buildLlmOptions(role, 'tools', tools, modelParams, signal, recorder);
  phase1Result = await this.llmCallFn!(candidate, systemPrompt, messages, sessionId, opts);
  if (phase1Result.kind !== 'tools' || phase1Result.calls.length === 0) break;     // phase boundary
  await this.executeToolCalls(phase1Result.calls, …);
  messages = this.buildModelMessages(sessionId);
}
// Phase 2: dedicated envelope turn
const envelopeOpts = buildLlmOptions(role, 'envelope', [], modelParams, signal, recorder);
const phase2Result = await this.llmCallFn!(candidate, systemPrompt, messages, sessionId, envelopeOpts);
if (phase2Result.kind !== 'envelope') throw new LlmContractMismatchError(...);
return phase2Result.envelope as RoleEnvelopeType;
```

`handleToolCallsLoop` ([src/agents/agent-adapter.ts#L220](../../../../src/agents/agent-adapter.ts#L220)) is collapsed into the phase-1 body above. `forceFinalAnswer` ([src/agents/agent-adapter.ts#L213](../../../../src/agents/agent-adapter.ts#L213)) is deleted — phase 2 is the structural replacement for the "forced final answer" pattern. The toolCalls-in-content recovery branch ([src/agents/agent-adapter.ts](../../../../src/agents/agent-adapter.ts), the long `else if` block following the `parsed = parser(finalResponse)` try/catch) is deleted because the gateway now delivers tool calls only through `kind: 'tools'`.

### 2.5 Analyst-resolver migration ([src/agents/analyst-llm-resolver.ts](../../../../src/agents/analyst-llm-resolver.ts))

The analyst path is phase-1-only (no envelope). The call at [src/agents/analyst-llm-resolver.ts#L163](../../../../src/agents/analyst-llm-resolver.ts#L163) is rewritten to use the new options factory with `mode: 'tools'`. The result-consumer at [src/agents/analyst-llm-resolver.ts#L171](../../../../src/agents/analyst-llm-resolver.ts#L171) switches on `result.kind`:

```ts
switch (result.kind) {
  case 'tools':
    for (const tc of result.calls) {
      const decision = RoleToolPolicy.assertAnalystSurfaceTool(tc.function.name, 'web');
      if (!decision.allowed) return { kind: 'unsupported', message: ANALYST_UNSUPPORTED_ACTION_TEMPLATE(...) };
    }
    return { kind: 'tools', calls: result.calls };
  case 'terminal_text':
    return { kind: 'text', text: result.text };
  case 'envelope':
    throw new LlmContractMismatchError('Analyst path received envelope; analyst never requests envelope mode');
}
```

The public method return shape `{ content; toolCalls }` at [src/agents/analyst-llm-resolver.ts#L179](../../../../src/agents/analyst-llm-resolver.ts#L179) is replaced with a typed-union return. Every analyst-side consumer of that return is updated in the same pass. No translation shim.

### 2.6 Result-parser migration

[src/agents/result-parser.ts](../../../../src/agents/result-parser.ts) loses its text-channel JSON extraction surface:

- `extractJson` ([src/agents/result-parser.ts#L278](../../../../src/agents/result-parser.ts#L278)) is rewritten to a thin Zod-validation entry point used inside the chat-gateway phase-2 response handler: take the raw `content` string, run `JSON.parse`, run the role envelope schema, throw `LlmContractMismatchError` (with the schema diff and the first 200 chars of raw) on failure. The three-layer brace-span fallback (code-fence, raw, first-`{`-to-last-`}`) is deleted. The throw site at [src/agents/result-parser.ts#L292](../../../../src/agents/result-parser.ts#L292) is replaced by the new typed error.
- `parsePlannerResult`, `parseExecutorResult`, `parseReviewerResult` (currently driven by `extractJson` + role-specific shape checks) keep their per-role Zod logic but are invoked from the chat-gateway's envelope-mode handler rather than from `agent-adapter.ts`. The adapter no longer calls the parser directly; it consumes the validated `envelope` field of `kind: 'envelope'`.
- `buildExecutorFallbackResult` ([src/agents/result-parser.ts#L210](../../../../src/agents/result-parser.ts#L210)) is deleted: under the two-phase contract the executor envelope is delivered by a dedicated turn that cannot mix tool evidence with envelope text, so the "rescue from tool evidence" fallback is unreachable.

### 2.7 Persistence and event-recorder surface

Session message rows in `.saivage/sessions/<id>/messages.jsonl` currently encode:

- assistant tool-call rows as `{ role: 'assistant', kind: 'tool_call', content: JSON.stringify({ toolCalls: [tc] }) }` ([src/agents/agent-adapter.ts](../../../../src/agents/agent-adapter.ts), the loop right above [src/agents/agent-adapter.ts#L213](../../../../src/agents/agent-adapter.ts#L213)).
- assistant envelope rows as `{ role: 'assistant', kind: 'text', content: rawJsonString }`.

Under proposal F:

- Assistant tool-call rows store `content: JSON.stringify(tc)` (single tool call per row, no envelope wrapper). The reader in `codexMessages` ([src/agents/llm-openai-codex-gateway.ts#L130+](../../../../src/agents/llm-openai-codex-gateway.ts#L130)) and the equivalent in `buildOpenAIChatRequest` ([src/agents/llm-openai-chat-gateway.ts#L149](../../../../src/agents/llm-openai-chat-gateway.ts#L149)) are rewritten to `JSON.parse(content) as ToolCall` directly.
- Assistant envelope rows store `content: JSON.stringify(envelope)` (the validated object, not the raw string the model produced). The event recorder ([src/agents/llm-exchange-recorder.ts](../../../../src/agents/llm-exchange-recorder.ts)) still receives the raw assistant text via `LlmCompleteResult.rawAssistantText` for forensic logging.

Old rows of either shape are read by a parser that REJECTS them (raises `LegacyMessageShapeError`) — per the project guideline, old sessions become unreadable rather than silently mis-parsed.

### 2.8 Files to DELETE under proposal F

- `parsePersistedToolCalls` and its export at [src/agents/llm-contracts.ts#L60](../../../../src/agents/llm-contracts.ts#L60).
- The three-layer brace-span fallback inside `extractJson` at [src/agents/result-parser.ts#L278](../../../../src/agents/result-parser.ts#L278). The function name is repurposed to a Zod-validating thin wrapper.
- `buildExecutorFallbackResult` at [src/agents/result-parser.ts#L210](../../../../src/agents/result-parser.ts#L210).
- `forceFinalAnswer` method at [src/agents/agent-adapter.ts#L213](../../../../src/agents/agent-adapter.ts#L213).
- The `toolCalls-in-content` recovery branch inside `invokeAgent` (the `selfCheckValue === null && toolCallsValue !== null …` block in [src/agents/agent-adapter.ts](../../../../src/agents/agent-adapter.ts)).
- The flatten line at [src/agents/agent-llm-gateway.ts#L58](../../../../src/agents/agent-llm-gateway.ts#L58).

### 2.9 Test plan (proposal F)

Unit:

- `buildLlmOptions(role, 'tools', …)` and `buildLlmOptions(role, 'envelope', …)` produce options with mutually-exclusive `tools` vs `responseFormatHint`, asserted by a type-level test and a value-level test.
- `OpenAIChatGateway.complete` against a fake `fetch` returning each of the three `LlmCompleteResult` kinds (tool_calls only, content-only-with-valid-JSON, content-only-with-invalid-JSON). Asserts: `kind: 'tools'` is returned verbatim; `kind: 'envelope'` is returned with the Zod-parsed envelope; invalid JSON raises `LlmContractMismatchError`.
- `OpenAICodexGateway.complete` against a fake SSE stream, same three cases. Asserts that `response_format` is not present in the request body even when `mode: 'envelope'`.
- `InvocationRecoveryPolicy.decideFailure(new LlmContractMismatchError(...))` returns `action: 'fail_invocation'`, `markFailed: false`.

Snapshot:

- `.saivage/sessions/<fixture-id>/messages.jsonl` after a planner invocation: snapshot the row shapes, assert no `{toolCalls: [...]}` envelope wrapper appears.
- Event log after a planner invocation: snapshot the `model_selected` / `invocation_succeeded` payloads (verifies invariants 4 and 8 together).

Live probe (manual, opt-in):

- For each provider in the matrix, issue one phase-1 turn with a known tool, one phase-2 turn with a known envelope schema, assert both succeed end-to-end. The probe script lives at `scripts/probe-llm-contract.ts` and reads `.saivage/saivage.json` directly; it does NOT read `.saivage/auth-profiles.json` or apiKey fields (it relies on the already-resolved transport config from `resolveLlmTransportConfig`).

### 2.10 Risk and rollback notes (proposal F)

Risk: phase 2 adds one additional round-trip per role invocation. Latency cost is bounded (one turn) and predictable; token cost is approximately the prompt + envelope only (no tools, no tool results), which is the smaller end of the typical turn.

Risk: `extractJson`'s relaxation to "strict JSON.parse + Zod" rejects any model that emits surrounding prose in phase 2. Mitigated by the explicit system suffix in phase 2 ("Reply with ONLY the canonical … JSON envelope; no prose, no code fences."). If a specific model is observed to insist on prose, the suffix is tightened per role, not the parser.

Rollback: the contract change touches `LlmCompleteOptions`, `LlmCompleteResult`, both gateways, the adapter loop, the analyst resolver, and the result parser in one pass. There is no rollback flag (per the project guideline). If a critical regression appears in production, the rollback is a git revert of the F05 commit set, not a runtime switch.

---

## 3. Proposal L — Level-up: tools-as-only-result

### 3.1 Idea in one paragraph

Every role's canonical result becomes a tool call. The planner role's tool catalog gains `emit_planner_result(envelope: PlannerResultEnvelope)`; the executor catalog gains `emit_executor_result(envelope: ExecutorResultEnvelope)`; the reviewer catalog gains `emit_reviewer_result(envelope: ReviewerResultEnvelope)`. The role-result `parameters` schema IS the canonical Zod envelope schema. A role invocation is a single-phase tools loop: the model calls action tools as needed, then calls `emit_<role>_result` as its terminal action; the runtime detects that call, validates the arguments against the schema, and returns the envelope. `response_format` is never sent on any role turn. The analyst path is already tools-only and becomes a degenerate case of the same protocol (its terminal tool is whatever analyst tool the model chose to call last; there is no envelope).

### 3.2 Type signatures

`buildLlmOptions` body:

```ts
export function buildLlmOptions(role, _phase, tools, modelParams, signal, recorder): LlmCompleteOptions {
  // Phase is irrelevant under proposal L; every role turn is mode: 'tools'.
  if (tools.length === 0) throw new Error(`Role ${role} requires non-empty tool catalog (including emit_<role>_result terminal tool)`);
  return {
    mode: 'tools',
    tools,
    tool_choice: 'auto',
    temperature: modelParams.temperature,
    max_tokens: modelParams.maxTokens,
    signal,
    recorder,
  };
}
```

`LlmCompleteOptions` loses the `LlmEnvelopeOptions` variant entirely; only `LlmToolsOptions` remains. `responseFormatHint` is removed from the codebase. The `kind: 'envelope'` variant of `LlmCompleteResult` is also removed; only `kind: 'tools'` and `kind: 'terminal_text'` remain.

The role-result tool definitions live in a new `src/agents/role-result-tools.ts`:

```ts
import { z } from 'zod';
import { PlannerResultSchema, ExecutorResultSchema, ReviewerResultSchema } from './role-envelope-schemas.js';

export const EMIT_PLANNER_RESULT: ToolDefinition = {
  type: 'function',
  function: {
    name: 'emit_planner_result',
    description: 'Emit the canonical planner result envelope. Call this exactly once at the end of the turn to deliver the planner result.',
    parameters: zodToJsonSchema(PlannerResultSchema),
  },
};
// …and analogous EMIT_EXECUTOR_RESULT, EMIT_REVIEWER_RESULT.

export const ROLE_RESULT_TOOL_NAMES: Record<AgentRole, string | null> = {
  planner: 'emit_planner_result',
  executor: 'emit_executor_result',
  reviewer: 'emit_reviewer_result',
  analyst: null,                              // analyst has no canonical envelope
};
```

The per-role tool catalogs at [src/agents/agent-tool-catalog.ts#L77](../../../../src/agents/agent-tool-catalog.ts#L77) are extended so each envelope-bearing role's `ROLE_TOOL_NAMES` entry includes its `emit_<role>_result` tool. `buildToolsForRole` at [src/agents/agent-tool-executor.ts#L45](../../../../src/agents/agent-tool-executor.ts#L45) appends the role-result tool to the action tools.

### 3.3 Per-provider request/response shape

| Provider | Request | Response | Terminal action detection |
| --- | --- | --- | --- |
| `opencode` / `opencode-go` / `github-copilot` / `nvidia-nim` (chat) | `tools[]` set (includes `emit_<role>_result`), `response_format` UNSET, `tool_choice: 'auto'` | Either intermediate tool calls (`finish_reason: 'tool_calls'`, function names are action tools) or terminal tool call (`finish_reason: 'tool_calls'`, function name is `emit_<role>_result`) | Adapter inspects the function name of each `ToolCall`. If `emit_<role>_result`, parse the `arguments` string as JSON, validate against `ENVELOPE_SCHEMAS[role]`, return as the role result. |
| `openai-codex` (Codex Responses) | `tools` SSE-mapped (includes `emit_<role>_result`), `response_format` never sent, `tool_choice: 'auto'` | `function_call` SSE events including the terminal `emit_<role>_result` call | Same detection; arguments come through as a typed string. |

Critical property: every provider in the matrix handles this contract cleanly today, without any per-provider branching. `opencode-go`'s HTTP 400 cannot occur (no `response_format` is ever sent). `nvidia-nim`/`deepseek-v4-pro`'s prose-instead-of-JSON cannot occur (the envelope is delivered as a typed tool argument). `openai-codex`'s silent drop of `response_format` cannot occur (it is never sent).

### 3.4 Adapter migration

`AgentAdapter.invokeAgent` becomes a single tools loop:

```ts
let result: LlmCompleteResult;
for (let turn = 0; turn < MAX_TOOLS_TURNS; turn++) {
  const opts = buildLlmOptions(role, 'tools', tools, modelParams, signal, recorder);
  result = await this.llmCallFn!(candidate, systemPrompt, messages, sessionId, opts);
  if (result.kind !== 'tools') throw new LlmContractMismatchError(`Role ${role} expected kind:'tools', got ${result.kind}`);

  const terminalName = ROLE_RESULT_TOOL_NAMES[role];
  const terminal = terminalName ? result.calls.find((c) => c.function.name === terminalName) : null;
  if (terminal) {
    const envelope = ENVELOPE_SCHEMAS[role].parse(JSON.parse(terminal.function.arguments));
    return envelope as RoleEnvelopeType;
  }
  await this.executeToolCalls(result.calls, …);
  messages = this.buildModelMessages(sessionId);
}
throw new Error(`Role ${role} exceeded ${MAX_TOOLS_TURNS} tool-loop turns without calling ${ROLE_RESULT_TOOL_NAMES[role]}`);
```

`handleToolCallsLoop`, `forceFinalAnswer`, `parseToolCallsFromResponse`, the toolCalls-in-content recovery branch, and the `expectsJsonEnvelope` test at [src/agents/agent-adapter.ts](../../../../src/agents/agent-adapter.ts) are all deleted. The adapter's `parser` callback (currently `parsePlannerResult` / `parseExecutorResult` / `parseReviewerResult`) is also removed — the envelope is validated inline against `ENVELOPE_SCHEMAS[role]`. The adapter no longer constructs assistant-text rows for envelope content; it constructs an assistant tool-call row for the `emit_<role>_result` call.

### 3.5 Analyst-resolver migration

Same as proposal F (Section 2.5). The analyst path is already tools-only, so under proposal L it is structurally identical to the envelope-bearing roles' loop, minus the terminal-tool detection (the analyst's `ROLE_RESULT_TOOL_NAMES['analyst']` is `null`). The return-type union becomes:

```ts
type AnalystResult =
  | { kind: 'tools'; calls: ToolCall[] }
  | { kind: 'text'; text: string }
  | { kind: 'unsupported'; message: string };
```

The `LlmIntentResolver.chat` method at [src/agents/analyst-llm-resolver.ts#L179](../../../../src/agents/analyst-llm-resolver.ts#L179) returns `AnalystResult`. No translation shim.

### 3.6 Result-parser migration

[src/agents/result-parser.ts](../../../../src/agents/result-parser.ts) is reduced to just the Zod envelope schemas (which then live in `src/agents/role-envelope-schemas.ts`) plus the role-specific normalization helpers (e.g. `normalizePlannerActions`). The text-channel JSON extraction surface is deleted entirely:

- `extractJson` ([src/agents/result-parser.ts#L278](../../../../src/agents/result-parser.ts#L278)) — DELETED.
- `parsePlannerResult` / `parseExecutorResult` / `parseReviewerResult` — DELETED at this layer (the adapter validates inline against `ENVELOPE_SCHEMAS[role]`). Any role-specific post-processing migrates to `src/agents/role-envelope-schemas.ts` as Zod `.transform()`s.
- `buildExecutorFallbackResult` ([src/agents/result-parser.ts#L210](../../../../src/agents/result-parser.ts#L210)) — DELETED. Under proposal L, an executor that does not call `emit_executor_result` is a typed contract mismatch, not a recovery situation.
- `ResultParseError` ([src/agents/result-parser.ts#L82](../../../../src/agents/result-parser.ts#L82)) — DELETED. Replaced by `LlmContractMismatchError`.

### 3.7 Persistence and event-recorder surface

Session message rows:

- Assistant tool-call rows store `content: JSON.stringify(tc)` (one row per tool call, no envelope wrapper). Same as proposal F.
- There are NO assistant "text" envelope rows for envelope-bearing roles. The role's result is the `emit_<role>_result` tool-call row plus a corresponding `tool` row carrying `{ kind: 'tool_result', content: '<role>_envelope_accepted', tool_call_id: <id> }`.
- The event recorder ([src/agents/llm-exchange-recorder.ts](../../../../src/agents/llm-exchange-recorder.ts)) gains a per-call `terminalTool: 'emit_planner_result' | 'emit_executor_result' | 'emit_reviewer_result' | null` field, so the operator UI can flag envelope-bearing turns in the LLM-exchange viewer.

Old rows of either shape are read by a parser that REJECTS them, per the guideline.

### 3.8 Files to DELETE under proposal L

Everything from proposal F's delete list (Section 2.8) PLUS:

- `parsePlannerResult`, `parseExecutorResult`, `parseReviewerResult` at [src/agents/result-parser.ts](../../../../src/agents/result-parser.ts).
- `ResultParseError` at [src/agents/result-parser.ts#L82](../../../../src/agents/result-parser.ts#L82).
- The `LlmEnvelopeOptions` variant in `src/agents/llm-contracts.ts` (proposal L only needs `LlmToolsOptions`).
- The `kind: 'envelope'` variant of `LlmCompleteResult`.
- The phase-2 system-suffix injection logic in `buildOpenAICodexRequest` ([src/agents/llm-openai-codex-gateway.ts#L106](../../../../src/agents/llm-openai-codex-gateway.ts#L106)) — never built under proposal L.
- The forwarding of `response_format` in `buildOpenAIChatRequest` ([src/agents/llm-openai-chat-gateway.ts#L186](../../../../src/agents/llm-openai-chat-gateway.ts#L186)) — never built under proposal L; the line is replaced by an assertion that `opts.mode === 'tools'`.
- The `responseFormatHint` field across the codebase.
- `envelopeMode` axis on the capability surface (replaced by a simpler `toolsMode` check; every envelope-bearing role now requires `toolsMode: 'native'` and nothing else).

The capability surface change is therefore smaller under proposal L: there is exactly one mode (`tools`) and the only check is "does this provider support native tool calls".

### 3.9 Test plan (proposal L)

Unit:

- `buildLlmOptions(role, …)` always returns `mode: 'tools'`; asserts the role-result tool is in `tools[]` for envelope-bearing roles.
- `OpenAIChatGateway.complete` against a fake `fetch` returning (a) intermediate tool calls, (b) the terminal `emit_planner_result` tool call with valid JSON arguments, (c) the terminal tool call with invalid JSON arguments. Asserts: (a) returns `kind: 'tools'` with action calls; (b) the adapter validates and returns the envelope; (c) raises `LlmContractMismatchError`.
- `OpenAICodexGateway.complete` against a fake SSE stream, same three cases. Asserts `response_format` is never present in the request body.
- `assertCandidateCapabilities` against a candidate with `toolsMode: 'unsupported'` raises before the wire call.
- `InvocationRecoveryPolicy.decideFailure(new LlmContractMismatchError(...))` returns `action: 'fail_invocation'`, `markFailed: false`.

Snapshot:

- Planner invocation produces a `.saivage/sessions/<id>/messages.jsonl` whose terminal assistant row is an `emit_planner_result` tool-call row with `content: JSON.stringify({ id, type:'function', function: { name:'emit_planner_result', arguments: '<envelope JSON>' } })`. Snapshot asserts no `kind: 'text'` row carries an envelope.
- Event log snapshot includes `terminalTool: 'emit_planner_result'` in `invocation_succeeded`.

Live probe (manual, opt-in):

- For each provider in the matrix, issue one role invocation that exercises (a) at least one action tool call followed by (b) the terminal `emit_<role>_result` call. Assert the envelope parses against the role's Zod schema. Script lives at `scripts/probe-llm-contract.ts` and reads `.saivage/saivage.json` directly, NOT `.saivage/auth-profiles.json`.

### 3.10 Risk and rollback notes (proposal L)

Risk: the model may emit prose alongside the terminal tool call. Under OpenAI chat-completions and Codex Responses, this is permitted (the assistant message can carry both `content` and `tool_calls`). The runtime ignores the prose for routing purposes but preserves it in `rawAssistantText` for forensics. No correctness impact.

Risk: the model may "forget" to call the terminal tool and instead emit prose-only (`kind: 'terminal_text'`). The gateway raises `LlmContractMismatchError`, the failure is classified as `contract_mismatch`, the invocation aborts without cooldown. Recovery is operator-visible (clear `invocation_failed` event with `failureClass: 'contract_mismatch'`) rather than silently looped. Mitigation: the role's system prompt explicitly states "You MUST call emit_<role>_result exactly once to deliver your result; the runtime cannot accept a prose answer."

Risk: tool catalogs grow by one entry per role. Token cost is small and bounded; the role-result tool's `parameters` schema is the same JSON-Schema we already render for the inverse direction.

Risk: persisted role envelopes change shape on disk (now nested inside a tool-call row's `function.arguments` string rather than a top-level assistant text row). Downstream consumers (the web UI session viewer, the LLM-exchange viewer, any inspector script) must be updated in the same pass. Per the project guideline, old sessions are not migrated; the reader rejects old shapes.

Rollback: same as proposal F — git revert of the F05 commit set; no runtime switch.

---

## 4. Side-by-side comparison against invariants 1–10

| # | Invariant (from approved analysis §5) | Proposal F (two-phase) | Proposal L (tools-as-only-result) |
| --- | --- | --- | --- |
| 1 | Single-carrier per turn (typed `LlmCompleteOptions` discriminated union) | Yes — `LlmToolsOptions` vs `LlmEnvelopeOptions` discriminated by `mode`. | Yes — only `LlmToolsOptions` exists; the second variant is structurally absent. |
| 2 | Single-carrier per result (`LlmCompleteResult` discriminated union) | Yes — `{kind:'tools'} \| {kind:'envelope'} \| {kind:'terminal_text'}`. | Yes — `{kind:'tools'} \| {kind:'terminal_text'}`. Simpler. |
| 3 | No string-flatten in the gateway | Yes — `agent-llm-gateway.ts` returns the structured result directly. | Yes — same. |
| 4 | No per-turn option drift (single factory) | Yes — `buildLlmOptions(role, phase, …)`. Both phases route through it. | Yes — `buildLlmOptions(role, _, …)`. Single mode, single factory call site. |
| 5 | Envelope parsed by typed schema, not text heuristics | Yes — chat gateway Zod-validates phase-2 `content`; `extractJson` reduced to `JSON.parse + Zod`. | Yes — adapter Zod-validates `emit_<role>_result.arguments`; `extractJson` deleted entirely. |
| 6 | Capability surface admits new shape | Yes — adds `envelopeMode` and `toolsMode` axes. | Yes — adds `toolsMode` axis only; simpler capability surface. |
| 7 | Codex Responses is a first-class participant | Yes — phase-2 uses system-suffix prompt injection; gateway Zod-validates. | Yes — automatic, because `response_format` is never sent on any role. The Codex Responses path is structurally aligned. |
| 8 | Failures are typed; contract mismatches do not cooldown | Yes — `LlmContractMismatchError` → `action: 'fail_invocation'`, `markFailed: false`. | Yes — same. |
| 9 | No backward-compat shim survives | Yes — `parsePersistedToolCalls`, the flatten line, `buildExecutorFallbackResult`, `forceFinalAnswer`, the toolCalls-in-content recovery branch, the three-layer brace-span fallback all deleted; old session rows rejected by the reader. | Yes — additionally `parsePlannerResult` / `parseExecutorResult` / `parseReviewerResult`, `ResultParseError`, the `LlmEnvelopeOptions` variant, the `kind: 'envelope'` variant, `responseFormatHint`, and `envelopeMode` are also deleted. Strictly more deletion. |
| 10 | Tests cover the matrix AND every direct consumer | Yes — unit per gateway per provider per kind; snapshot of session rows and events; adapter and analyst paths separately. Phase boundary adds an extra test axis. | Yes — same, with fewer test axes (single mode, terminal-tool detection covered by one test family). Adapter and analyst paths converge structurally. |

### 4.1 Operational and design-quality comparison

| Axis | Proposal F | Proposal L |
| --- | --- | --- |
| Lines of code deleted | ~150 (gateway flatten, extractJson fallbacks, fallback builder, forceFinalAnswer, toolCalls-in-content branch) | ~280 (everything F deletes, plus the three role result parsers, ResultParseError, the envelope variant, response-format plumbing) |
| Lines of new code | ~120 (factory, two-phase loop, gateway phase switch, capability axes, Zod-on-content validation) | ~110 (factory, single-mode loop, role-result tools, capability axis, Zod-on-arguments validation) |
| Round-trips per role invocation | +1 turn (phase 2) vs today's typical | Same as today (no extra turn — terminal tool is part of the existing tool loop) |
| Token cost per invocation | + phase-2 prompt + envelope tokens | + role-result tool schema in `tools[]` (small, per request); no extra turn |
| Provider compatibility risk | Phase 2 depends on transport tolerating "no tools" turns; all current providers do; CDU on `nvidia-nim`/`deepseek` for the "ONLY JSON" suffix instruction | Zero — every provider in the matrix handles tools-only cleanly today |
| Analyst-path alignment | Analyst is phase-1-only; the path is structurally close to the new loop but not identical (no phase 2) | Analyst is a degenerate case of the same loop (no terminal tool, but identical mechanics); strongest structural convergence |
| Failure-mode coverage | F01, F02, F09, F11 disappear by construction | F01, F02, F09, F11 disappear by construction AND the `extractJson` family disappears, so future "prose around JSON" regressions are impossible by absence |
| Future-proofing | New providers need to support either `tools[]`-only OR `response_format` per-turn (most do both) | New providers only need to support `tools[]` |
| Architectural debt removed | Carrier orthogonality and per-turn drift | Carrier orthogonality, per-turn drift, AND the entire text-channel envelope-extraction surface |

---

## 5. Recommendation: Proposal L

Both proposals satisfy all ten invariants. The recommendation is **proposal L (tools-as-only-result)** for four reasons that follow directly from the workspace architecture-first / no-backward-compatibility guideline.

1. **Strictly more dead code is deleted.** Proposal L removes everything proposal F removes, plus the three role-specific text-channel parsers, plus `ResultParseError`, plus the `LlmEnvelopeOptions` variant, plus `responseFormatHint`, plus `envelopeMode`. The guideline says: "Actively REMOVE code supporting old features/structures." Proposal L removes a larger structurally-coherent surface, not just the minimum to satisfy the invariants.

2. **One less degree of freedom on the wire.** Proposal F still has two request shapes (phase-1 tools, phase-2 envelope) and two response shapes (`kind: 'tools'`, `kind: 'envelope'`). Proposal L has one. Every provider gateway, every test, every operator-facing tool that explains the protocol becomes simpler.

3. **The envelope is delivered as a typed object end-to-end.** Under proposal F, the envelope still travels through the model's text channel before Zod parses it; "the model emitted prose around the JSON" is a recoverable category that the runtime has to choose how to handle. Under proposal L, the envelope is the `arguments` field of a tool call — a typed string that the wire spec guarantees is valid JSON. The category "prose around envelope" cannot exist.

4. **The analyst path and the envelope-bearing roles converge.** Under proposal F, the analyst path is "tools-only, single phase" and the envelope-bearing roles are "tools then envelope, two phases" — two distinct shapes in the code. Under proposal L, every role runs the same single-mode tools loop; the only difference is whether the role has a terminal `emit_<role>_result` tool. This is the strongest structural collapse achievable with the issue's scope.

Proposal F is a reasonable answer to "what if we cannot risk the deeper refactor today?" — but the guideline explicitly says: "Never apply 'minimal change' defaults — refactor broadly when it improves the design." Proposal L is the design that the guideline points to.

### 5.1 Implementation order (single coherent pass, proposal L)

The implementation plan that follows this design proposal will sequence:

1. Introduce `src/agents/role-envelope-schemas.ts` and `src/agents/role-result-tools.ts`.
2. Rewrite `LlmCompleteOptions` and `LlmCompleteResult` at [src/agents/llm-contracts.ts](../../../../src/agents/llm-contracts.ts); delete `parsePersistedToolCalls`.
3. Rewrite `buildOpenAIChatRequest` and `buildOpenAICodexRequest` to assert `opts.mode === 'tools'` and stop forwarding `response_format`.
4. Rewrite both gateways' response parsers to return the new `LlmCompleteResult` union; raise `LlmContractMismatchError` on mismatches.
5. Introduce `src/agents/llm-options-factory.ts`; rewrite the single adapter call site and the analyst call site to use it.
6. Rewrite `AgentAdapter.invokeAgent` to the single-mode tools loop; delete `handleToolCallsLoop`, `forceFinalAnswer`, the toolCalls-in-content recovery branch, `parseToolCallsFromResponse`.
7. Rewrite `analyst-llm-resolver.ts` chat method to switch on `result.kind`; update every analyst-side consumer of the return.
8. Delete `extractJson`, `parsePlannerResult`, `parseExecutorResult`, `parseReviewerResult`, `buildExecutorFallbackResult`, `ResultParseError` from [src/agents/result-parser.ts](../../../../src/agents/result-parser.ts).
9. Update the capability surface (add `toolsMode` axis; update built-ins; update `capabilityRequestForLlmOptions`).
10. Update `InvocationRecoveryPolicy.decideFailure` with the contract-mismatch branch.
11. Update persistence reader to reject the old `{toolCalls: [...]}`-wrapper row shape; update web UI session viewer and LLM-exchange viewer to read the new shape.
12. Land the test suite from Section 3.9 alongside the deletes.

The corresponding work is owned by F01 (option-assembler), F02 / F09 (parser deletions), F10 (capability axis), F11 (flatten and per-turn drift deletions), and F08 (failure classifier branch). Per the approved analysis §6, those sibling issues' plans collapse to "delete the old surface and re-implement against the new contract from F05" once this design lands.
