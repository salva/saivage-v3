# F05 — Envelope-vs-toolcalls orthogonality (design)

Scope: replace the orthogonal `{ tools[] + response_format }` contract at [src/agents/llm-contracts.ts#L25](../../../../src/agents/llm-contracts.ts#L25), [src/agents/agent-adapter.ts#L342](../../../../src/agents/agent-adapter.ts#L342), and [src/agents/agent-llm-gateway.ts#L58](../../../../src/agents/agent-llm-gateway.ts#L58) with a single coherent contract that satisfies invariants 1–10 of the approved analysis. File references are workspace-relative to `/home/salva/g/ml/saivage-v3/` and clickable.

Two designs are presented:

- Proposal F (Focused): a two-phase tools-then-envelope protocol.
- Proposal L (Level-up): tools-as-only-result via per-role `emit_<role>_result` terminal tools.

A side-by-side invariant matrix and the recommendation follow in Sections 4–5. Per the workspace architecture-first / no-backward-compatibility guideline, both proposals delete the orthogonal-channel assumption outright; neither preserves a feature flag, a "legacy envelope mode", a data-format migration shim, or a translation layer. Old on-disk session-message rows that encode the `{ toolCalls: [...] }`-stringified-as-content shape are read by parsers that REJECT them rather than bridged.

The proposals share a single substrate (Section 1) and diverge only in the per-phase request shape, the result discriminator, and the consumer migration.

---

## 1. Shared design substrate

### 1.1 New `LlmCompleteOptions` discriminated union

Replaces the flat object at [src/agents/llm-contracts.ts#L31](../../../../src/agents/llm-contracts.ts#L31):

```ts
export type LlmCompleteOptions = LlmToolsOptions | LlmEnvelopeOptions;

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
  parallel_tool_calls: boolean;             // mandatory; see exclusive-terminal protocol (§1.7)
}

export interface LlmEnvelopeOptions extends LlmCommonOptions {
  mode: 'envelope';
  envelopeSchema: ZodTypeAny;               // canonical role envelope schema
  responseFormatHint: 'json_object';        // forwarded only when transport supports it
}
```

Construction invariant (enforced by the type and by the gateway entry-point): `tools` and `responseFormatHint` cannot coexist in a single `LlmCompleteOptions` value. The legacy fields `response_format?` and the optional `tools?` are removed from [src/agents/llm-contracts.ts#L31](../../../../src/agents/llm-contracts.ts#L31); call sites must choose a mode.

### 1.2 New `LlmCompleteResult` discriminated union

Replaces [src/agents/llm-contracts.ts#L25](../../../../src/agents/llm-contracts.ts#L25):

```ts
export type LlmCompleteResult =
  | { kind: 'tools'; calls: ToolCall[]; rawAssistantText: string | null }
  | { kind: 'envelope'; envelope: unknown; rawAssistantText: string }
  | { kind: 'terminal_text'; text: string };
```

- `kind: 'tools'` corresponds to OpenAI `finish_reason: 'tool_calls'` on chat-completions and to `function_call` events on Codex Responses. `rawAssistantText` carries any prose the model emitted alongside the tool calls; no consumer parses it, it exists for forensics.
- `kind: 'envelope'` is produced by gateways only when the upstream `LlmCompleteOptions.mode === 'envelope'`. The envelope is the Zod-validated parse of the model's content.
- `kind: 'terminal_text'` is the analyst-style "free assistant text" result, used by roles that genuinely emit prose (analyst end-of-turn replies; operator chat surface).

Envelope-bearing roles MUST NOT receive `kind: 'terminal_text'`; the gateway raises `LlmContractMismatchError` if the upstream requested a tools or envelope mode and the wire returned plain text.

The legacy `parsePersistedToolCalls` at [src/agents/llm-contracts.ts#L60](../../../../src/agents/llm-contracts.ts#L60) is deleted; the new persisted-row reader (§1.8) replaces it.

### 1.3 New option-assembler factory

Replaces the inline spread at [src/agents/agent-adapter.ts#L342](../../../../src/agents/agent-adapter.ts#L342) AND the second inline spread inside `handleToolCallsLoop` at [src/agents/agent-adapter.ts#L280](../../../../src/agents/agent-adapter.ts#L280). New file `src/agents/llm-options-factory.ts`:

```ts
export function buildLlmOptions(
  role: AgentRole,
  phase: AgentInvocationPhase,
  tools: ToolDefinition[],
  modelParams: { temperature: number; maxTokens: number },
  signal: AbortSignal,
  recorder: LlmExchangeRecorder,
): LlmCompleteOptions { /* per-proposal body in §2.2 or §3.2 */ }

export type AgentInvocationPhase = 'tools' | 'envelope' | 'terminal';
```

Every existing call site that assembles `LlmCompleteOptions` inline (the two cited above plus the analyst call site at [src/agents/analyst-llm-resolver.ts#L163](../../../../src/agents/analyst-llm-resolver.ts#L163)) is rewritten to call `buildLlmOptions`. Invariant 4 (no per-turn option drift) is enforced by construction.

### 1.4 Gateway return path — no flatten, no stringify

`LlmCallFn` at [src/agents/llm-contracts.ts#L52](../../../../src/agents/llm-contracts.ts#L52) changes signature:

```ts
export type LlmCallFn = (
  candidate: Candidate,
  systemPrompt: string,
  messages: AgentMessage[],
  sessionId: string,
  opts: LlmCompleteOptions,            // mandatory; mode is intrinsic
) => Promise<LlmCompleteResult>;       // structured result, NOT string
```

`AgentLlmInvocationGateway.createLlmCallFn` at [src/agents/agent-llm-gateway.ts#L48](../../../../src/agents/agent-llm-gateway.ts#L48) is rewritten to return the structured result verbatim. The flatten line at [src/agents/agent-llm-gateway.ts#L58](../../../../src/agents/agent-llm-gateway.ts#L58) (`return result.content ?? JSON.stringify({ toolCalls: result.toolCalls });`) is DELETED. Invariant 3 is satisfied by construction.

### 1.5 Capability surface extension

Adds axes to [src/agents/provider-capabilities.ts](../../../../src/agents/provider-capabilities.ts):

```ts
export interface EffectiveProviderCapabilities {
  // …existing axes…
  envelopeMode: 'native_json_object' | 'prompt_only' | 'unsupported';
  toolsMode: 'native' | 'unsupported';
  exclusiveToolChoiceSupport: 'native' | 'parallel_off' | 'unsupported';
}

export interface CapabilityRequest {
  // …existing axes…
  mode: 'tools' | 'envelope';
  requiresExclusiveToolChoice: boolean;
}
```

Built-ins at [src/agents/provider-capabilities.ts#L53](../../../../src/agents/provider-capabilities.ts#L53):

- `opencode`, `opencode-go`, `github-copilot`, `nvidia-nim`: `envelopeMode: 'native_json_object'`, `toolsMode: 'native'`, `exclusiveToolChoiceSupport: 'native'`.
- `openai-codex` (Codex Responses): `envelopeMode: 'prompt_only'`, `toolsMode: 'native'`, `exclusiveToolChoiceSupport: 'parallel_off'` (uses `parallel_tool_calls: false` on terminal-eligible turns; the current default `parallel_tool_calls: true` at [src/agents/llm-openai-codex-gateway.ts#L125](../../../../src/agents/llm-openai-codex-gateway.ts#L125) is removed).

`capabilityRequestForLlmOptions` at [src/agents/provider-capabilities.ts#L127](../../../../src/agents/provider-capabilities.ts#L127) is rewritten to derive `mode` and `requiresExclusiveToolChoice` from `LlmCompleteOptions`. The router skips a candidate whose `toolsMode` or `envelopeMode` is `'unsupported'` for the requested mode, or whose `exclusiveToolChoiceSupport` is `'unsupported'` on a turn that requires exclusivity. Invariant 6 is satisfied.

### 1.6 New typed failure classes

Adds two failure classes to [src/agents/llm-errors.ts](../../../../src/agents/llm-errors.ts):

- `LlmContractMismatchError` — raised when the wire returns a payload incompatible with the requested mode (see §1.7 for the full rejection matrix).
- `LegacyMessageShapeError` — raised by the persistence reader when an on-disk session row encodes the old `{ toolCalls: [...] }` wrapper (§1.8).

`InvocationRecoveryPolicy.decideFailure` at [src/agents/invocation-recovery-policy.ts#L120](../../../../src/agents/invocation-recovery-policy.ts#L120) gains a branch:

```ts
if (error instanceof LlmContractMismatchError) {
  return {
    action: 'fail_invocation',
    failureClass: 'contract_mismatch',
    markFailed: false,
    appendModelIssue: true,
    abort: true,
    cooldownMs: undefined,
    retryDelayMs: undefined,
    message: error.message,
    eventPayload: { … },
  };
}
```

A wire-level contract mismatch is a coding bug or model-side defect, not transient — the provider must not be cooled down. Invariant 8 is satisfied.

### 1.7 Exclusive-terminal protocol (Proposal L; trivial under Proposal F)

This subsection is the heart of Proposal L and is also referenced by Proposal F (which uses it only on phase-2 turns, where it is trivially satisfied because no tools are exposed). It defines how the runtime guarantees that a terminal `emit_<role>_result` tool call is the SOLE tool call in its assistant message.

The protocol is layered: the request is shaped to make exclusivity the wire-level expectation, and the response is validated to make any deviation a typed failure.

#### 1.7.1 Request-side enforcement

A role invocation's tools loop has two kinds of turn:

- **Action-eligible turn**: the role can still take useful side-effecting actions. The model may call any action tool, may emit the terminal `emit_<role>_result` tool to finish, or may emit prose (which becomes `kind: 'terminal_text'` and triggers a typed mismatch).
- **Terminal-only turn**: the model has signalled it has nothing left to do (e.g. an action-eligible turn returned with `finishReason: 'stop'` and no tool calls, or the runtime reached `MAX_TOOLS_TURNS - 1`). The runtime forces the next turn to call exactly the role's terminal tool.

Per-provider knobs on each turn type:

| Capability axis | `chat`-completions providers (`opencode`, `opencode-go`, `github-copilot`, `nvidia-nim`) | `openai-codex` (Codex Responses) |
| --- | --- | --- |
| Action-eligible turn `tool_choice` | `'auto'` | `'auto'` |
| Action-eligible turn parallelism | `parallel_tool_calls: false` on the request body | `parallel_tool_calls: false` (replaces the unconditional `true` at [src/agents/llm-openai-codex-gateway.ts#L125](../../../../src/agents/llm-openai-codex-gateway.ts#L125)) |
| Terminal-only turn `tool_choice` | `{ type: 'function', function: { name: 'emit_<role>_result' } }` | same |
| Terminal-only turn tools list | only the terminal `emit_<role>_result` tool is exposed | same |
| Terminal-only turn parallelism | `parallel_tool_calls: false` | `parallel_tool_calls: false` |

`parallel_tool_calls: false` is the request-side mechanism: every provider in the matrix honours this OpenAI-defined field by emitting at most one tool call per assistant message. The terminal-only turn additionally narrows `tools[]` to the single terminal tool so the model cannot decide to call an action tool again at the boundary. The forced `tool_choice` ensures the model must produce that single call.

These knobs are set inside `buildLlmOptions` (§1.3) and forwarded by `buildOpenAIChatRequest` ([src/agents/llm-openai-chat-gateway.ts#L148](../../../../src/agents/llm-openai-chat-gateway.ts#L148)) and `buildOpenAICodexRequest` ([src/agents/llm-openai-codex-gateway.ts#L105](../../../../src/agents/llm-openai-codex-gateway.ts#L105)).

#### 1.7.2 Response-side validation (the strict gate)

After the gateway parses the wire response into `LlmCompleteResult` (via [src/agents/llm-stream-parser.ts](../../../../src/agents/llm-stream-parser.ts) `buildOpenAIChatStreamResult` and [src/agents/llm-codex-parser.ts](../../../../src/agents/llm-codex-parser.ts) `finalizeCodexToolCall`), a single validation function `validateTerminalProtocol(result, expectations)` runs in the adapter loop before any side-effects. `expectations` is `{ role: AgentRole; terminalToolName: string | null; mustBeTerminal: boolean }`. Rejection cases each map to a distinct `LlmContractMismatchError` subtype:

1. **Duplicate terminal**: more than one `ToolCall` in `result.calls` has `function.name === terminalToolName`. Reject with `LlmContractMismatchError('terminal_duplicate', …)`.
2. **Terminal + action mixture**: `result.calls.length > 1` AND any one of them is the terminal. Reject with `LlmContractMismatchError('terminal_mixed_with_actions', …)`. This covers the case where a provider ignores `parallel_tool_calls: false`.
3. **Terminal for the wrong role**: `result.calls` contains a tool call whose name matches another role's terminal tool (e.g. an executor turn returned `emit_planner_result`). Reject with `LlmContractMismatchError('terminal_wrong_role', …)`.
4. **Prose-only terminal**: `mustBeTerminal === true` AND `result.kind === 'terminal_text'` (the gateway produced no tool calls and only free text). Reject with `LlmContractMismatchError('terminal_prose_only', …)`.
5. **Missing terminal at hard limit**: the adapter reached `MAX_TOOLS_TURNS` action-eligible turns and the most recent terminal-only turn still did not produce the terminal call. Reject with `LlmContractMismatchError('terminal_missing_at_limit', …)`.
6. **Terminal arguments not parseable**: see §1.7.3.

All six reject with `LlmContractMismatchError`, which classifies to `action: 'fail_invocation'` with `markFailed: false` (§1.6). The provider is NOT cooled down because none of these are transport failures.

#### 1.7.3 Arguments parse/validate boundary

`ToolCall.function.arguments` is a STRING assembled from wire deltas. On the chat path, the string is concatenated from `tc.function.arguments` deltas across SSE chunks at [src/agents/llm-stream-parser.ts#L86](../../../../src/agents/llm-stream-parser.ts#L86), and the final value is whatever the model emitted at [src/agents/llm-stream-parser.ts#L100-L113](../../../../src/agents/llm-stream-parser.ts#L100-L113) (the value is forwarded as-is, never parsed). On the Codex path, the string is the value of `response.function_call_arguments.done#arguments` (or its `delta` concatenation), defaulted to `'{}'` only when absent at [src/agents/llm-codex-parser.ts#L131](../../../../src/agents/llm-codex-parser.ts#L131); see [src/agents/llm-codex-parser.ts#L85-L134](../../../../src/agents/llm-codex-parser.ts#L85-L134). Neither parser validates that the string is well-formed JSON, nor that it matches any schema.

The runtime treats the arguments as raw JSON text until a single parse/validate boundary, located at the gateway response handler for envelope-bearing roles and at the adapter for action tool calls:

```ts
function parseRoleEnvelopeArguments(role: AgentRole, raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new LlmContractMismatchError('terminal_arguments_not_json', {
      role,
      rawPreview: redactedPreview(raw, 200),
      jsonError: (err as Error).message,
    });
  }
  const validation = ENVELOPE_SCHEMAS[role].safeParse(parsed);
  if (!validation.success) {
    throw new LlmContractMismatchError('terminal_arguments_schema_mismatch', {
      role,
      issues: validation.error.issues,
      rawPreview: redactedPreview(raw, 200),
    });
  }
  return validation.data;
}
```

`redactedPreview` reuses the existing `redactProviderErrorText` from [src/agents/llm-codex-parser.ts](../../../../src/agents/llm-codex-parser.ts) (the helper imported at module load time) to strip API keys and tokens before forensic logging. The raw text is preserved on the `LlmContractMismatchError` for the exchange recorder; nothing else writes the raw envelope arguments to disk.

Action tool calls parse `arguments` against the per-tool Zod schema at the executor (no change to the executor surface; this is already how action tools are validated). The new boundary is exclusively for terminal tool calls.

### 1.8 Persisted assistant tool-call message format

The current on-disk row for an assistant tool call is `{ role: 'assistant', kind: 'tool_call', content: JSON.stringify({ toolCalls: [tc] }) }` (a single tool call wrapped in a `{ toolCalls: [...] }` envelope). Direct producers of this wrapper:

- `AgentAdapter` at [src/agents/agent-adapter.ts#L239](../../../../src/agents/agent-adapter.ts#L239) (one row per tool call inside the loop).
- `AnalystHandler` at [src/agents/analyst-handler.ts#L300](../../../../src/agents/analyst-handler.ts#L300) (one row per assistant turn carrying all of that turn's tool calls).
- `FakeAgent` at [src/agents/fake-agent.ts#L86](../../../../src/agents/fake-agent.ts#L86) (one row per fixture-generated activate_card call).

Direct readers of the wrapper:

- `parsePersistedToolCalls` at [src/agents/llm-contracts.ts#L60](../../../../src/agents/llm-contracts.ts#L60) — invoked by `buildOpenAIChatRequest` at [src/agents/llm-openai-chat-gateway.ts#L160](../../../../src/agents/llm-openai-chat-gateway.ts#L160) to rebuild the assistant's prior `tool_calls` array, AND by the equivalent Codex path inside `codexMessages` at [src/agents/llm-openai-codex-gateway.ts#L130](../../../../src/agents/llm-openai-codex-gateway.ts#L130).
- `session-persistence.ts` private `parseToolCalls` at [src/agents/session-persistence.ts#L379-L397](../../../../src/agents/session-persistence.ts#L379-L397), used by `findUniqueUnresolvedActivateCardToolCall` at [src/agents/session-persistence.ts#L399-L420](../../../../src/agents/session-persistence.ts#L399-L420).
- `runtime.ts` `findUnresolvedActivateCards` at [src/runtime/runtime.ts#L234-L264](../../../../src/runtime/runtime.ts#L234-L264) (parses the row directly with `JSON.parse(message.content)` and dereferences `.toolCalls`).
- `analyst-handler.ts` `trimToCleanToolBoundary` at [src/agents/analyst-handler.ts#L70-L106](../../../../src/agents/analyst-handler.ts#L70-L106) (parses the wrapper to enumerate call ids).
- `web/src/utils/tool-presenters/helpers.ts` `readToolCallEnvelope` at [web/src/utils/tool-presenters/helpers.ts#L68-L78](../../../../web/src/utils/tool-presenters/helpers.ts#L68-L78) (dereferences `.toolCalls[0]` for presenter rendering).
- `web/src/stores/analystChat.ts` `toolInvocationMatchesMessage` at [web/src/stores/analystChat.ts#L99-L108](../../../../web/src/stores/analystChat.ts#L99-L108) (parses the wrapper to match pending invocations).

All of these readers and writers are migrated in a single pass to a canonical pair of helpers in a new module `src/agents/persisted-tool-call.ts`:

```ts
// Single ToolCall per row. No envelope wrapper.
export function serializeToolCallMessage(call: ToolCall): string {
  return JSON.stringify(call);              // { id, type, function: { name, arguments } }
}

export function parseToolCallMessage(content: string): ToolCall {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch {
    throw new LegacyMessageShapeError('tool_call_row_not_json', { contentPreview: content.slice(0, 200) });
  }
  if (parsed && typeof parsed === 'object' && 'toolCalls' in parsed) {
    throw new LegacyMessageShapeError('tool_call_row_uses_legacy_envelope', { contentPreview: content.slice(0, 200) });
  }
  // Zod-validate the single-ToolCall shape.
  return ToolCallSchema.parse(parsed);
}
```

`ToolCallSchema` is the Zod schema for the existing `ToolCall` interface, co-located with the helper.

A web-side mirror lives at `web/src/utils/persistedToolCall.ts` and re-uses the same shape (the web bundle does not import server-side modules). Both helpers reject the legacy wrapper with `LegacyMessageShapeError`; old sessions become explicitly unreadable rather than silently mis-parsed, per the project guideline.

#### 1.8.1 Migration inventory (complete list — all migrated in the same commit pass)

Producers rewritten to emit `serializeToolCallMessage(call)` (one row per tool call):

- [src/agents/agent-adapter.ts#L239](../../../../src/agents/agent-adapter.ts#L239)
- [src/agents/analyst-handler.ts#L300](../../../../src/agents/analyst-handler.ts#L300) — also restructured to write one row per tool call (it currently bundles them into a single row).
- [src/agents/fake-agent.ts#L86](../../../../src/agents/fake-agent.ts#L86)

Readers rewritten to call `parseToolCallMessage(content)`:

- [src/agents/llm-openai-chat-gateway.ts#L160](../../../../src/agents/llm-openai-chat-gateway.ts#L160) (`buildOpenAIChatRequest`) — replaces the `parsePersistedToolCalls(m.content)` call; rebuilds the chat-completions `tool_calls` array from one-call-per-row history.
- [src/agents/llm-openai-codex-gateway.ts#L130](../../../../src/agents/llm-openai-codex-gateway.ts#L130) (`codexMessages`) — same.
- [src/agents/session-persistence.ts#L379-L420](../../../../src/agents/session-persistence.ts#L379-L420) (`parseToolCalls` private helper and `findUniqueUnresolvedActivateCardToolCall`) — the helper becomes a thin loop over rows that each call `parseToolCallMessage` for one `ToolCall`.
- [src/runtime/runtime.ts#L234-L264](../../../../src/runtime/runtime.ts#L234-L264) (`findUnresolvedActivateCards`) — same rewrite.
- [src/agents/analyst-handler.ts#L70-L106](../../../../src/agents/analyst-handler.ts#L70-L106) (`trimToCleanToolBoundary`) — replaces the inline `JSON.parse` + `.toolCalls?.[]` enumeration.
- [web/src/utils/tool-presenters/helpers.ts#L68-L78](../../../../web/src/utils/tool-presenters/helpers.ts#L68-L78) (`readToolCallEnvelope`) — renamed to `readToolCallMessage`; returns `{ name, args }` from a single `ToolCall` row.
- [web/src/stores/analystChat.ts#L99-L108](../../../../web/src/stores/analystChat.ts#L99-L108) (`toolInvocationMatchesMessage`) — compares against a single `ToolCall` per row.

Fixtures and tests that hard-code the wrapper, all of which are rewritten or deleted in the same pass:

- `tests/agents/result-parser.test.ts` — deleted entirely (the parser surface it covers is deleted; see §3.6).
- `tests/agents/llm-client-integration.test.ts` — fixtures rewritten to one-call-per-row.
- `tests/agents/agent-tool-executor.test.ts` — fixtures rewritten.
- `tests/runtime/agent-runtime.test.ts` — fixtures rewritten.
- `tests/agents/codex-deferred-activate-card.test.ts` — fixtures rewritten.
- `tests/agents/session-persistence.test.ts` — fixtures rewritten; the round-trip test for the legacy shape is replaced with a `LegacyMessageShapeError` rejection test.
- `tests/agents/fake-agent.test.ts` (and any fixture file under `tests/fixtures/*sessions*` matching `toolCalls\s*:\s*\[`) — fixtures rewritten.
- Web tests under `web/src/__tests__/` and `web/tests/` that match `\"toolCalls\":\s*\[` — fixtures rewritten or assertions updated to the single-`ToolCall` row shape.

`parsePersistedToolCalls` at [src/agents/llm-contracts.ts#L60](../../../../src/agents/llm-contracts.ts#L60) is deleted; the new `parseToolCallMessage` is its sole replacement on every reader path.

### 1.9 `terminalTool` observability surface

The terminal-tool name (`emit_planner_result` / `emit_executor_result` / `emit_reviewer_result` / `null`) is a first-class observability axis. It lives on TWO schemas, both of which are operator-visible:

- **Per-attempt on the LLM exchange record.** `exchangeAttemptSchema` at [src/contracts/llm-exchange.ts#L23-L31](../../../../src/contracts/llm-exchange.ts#L23-L31) gains an optional `terminalTool: z.enum(['emit_planner_result', 'emit_executor_result', 'emit_reviewer_result']).nullable().optional()` field. It is populated by the gateway when the attempt's `LlmCompleteResult` contains a terminal tool call. The web re-export at [web/src/api/contracts.ts#L91-L92](../../../../web/src/api/contracts.ts#L91-L92) (`export { llmExchangeSchema }` / `export type { LlmExchange }`) picks up the change automatically because the web module re-exports the server schema verbatim; the LLM-exchange viewer reads `attempt.terminalTool` and renders a badge when present.

- **On the agent invocation event.** The `invocation_succeeded` payload at [src/schemas/event-catalog.ts#L51](../../../../src/schemas/event-catalog.ts#L51) is extended to:
  ```ts
  invocation_succeeded: {
    domain: 'agent',
    schema: payload({
      session_id: z.string(),
      role: agentRoleSchema,
      attempt: z.number(),
      duration_ms: z.number(),
      terminal_tool: z.enum(['emit_planner_result', 'emit_executor_result', 'emit_reviewer_result']).nullable(),
    }),
    severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator',
  },
  ```
  The adapter populates `terminal_tool` from the terminal `ToolCall.function.name` it consumed; analyst invocations emit `null`. Event consumers downstream of `event-catalog.ts` (the operator event bus, the audit log writer, the broadcast surface) pick up the schema change at compile time because the schema is the contract.

The corresponding contract updates and test files:

- `src/contracts/llm-exchange.ts` — schema extension.
- `src/schemas/event-catalog.ts` — schema extension.
- `web/src/api/contracts.ts` — re-export passthrough (no code change; covered by the schema's compile-time type).
- `tests/contracts/llm-exchange.test.ts` — assert the new optional field round-trips through Zod.
- `tests/schemas/event-catalog.test.ts` — assert `invocation_succeeded.terminal_tool` parses for each role and for `null`.
- `web/src/__tests__/llm-exchange-viewer.test.ts` — assert the viewer renders the terminal-tool badge when present and omits it when `null`/absent.
- `web/src/__tests__/event-log.test.ts` — assert the event-log row renders the terminal-tool label for envelope-bearing roles.

There is no passthrough untyped field. Both new fields are part of the typed contract from the moment they exist.

---

## 2. Proposal F — Focused: two-phase tools-then-envelope

### 2.1 Idea

A role invocation is two phases. Phase 1 collects information and effects side-effects through action tool calls. Phase 2 is a single dedicated turn that emits the role envelope. The runtime makes the phase boundary explicit on the wire: phase 1 turns are `mode: 'tools'` with no `response_format`; phase 2 is `mode: 'envelope'` with no `tools[]`. The model picks at most one carrier per turn, which matches every transport.

### 2.2 `buildLlmOptions` body (Proposal F)

```ts
export function buildLlmOptions(role, phase, tools, modelParams, signal, recorder): LlmCompleteOptions {
  if (phase === 'tools') {
    if (tools.length === 0) throw new Error(`Phase 'tools' requires non-empty catalog for role ${role}`);
    return {
      mode: 'tools',
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: false,            // exclusivity is cheap insurance even pre-terminal
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

`ENVELOPE_SCHEMAS` lives in a new `src/agents/role-envelope-schemas.ts` re-exporting the existing role envelope Zod schemas currently consumed by [src/agents/result-parser.ts](../../../../src/agents/result-parser.ts) (`PlannerResult`, `ExecutorResult`, `ReviewerResult`).

### 2.3 Per-provider request/response shape

| Provider | Phase-1 (tools) request | Phase-1 response | Phase-2 (envelope) request | Phase-2 response |
| --- | --- | --- | --- | --- |
| `opencode` chat | `tools[]` set, `response_format` unset, `parallel_tool_calls: false`, `tool_choice: 'auto'` | `tool_calls` OR `content` per OpenAI semantics | `tools[]` unset, `response_format: { type: 'json_object' }`, no `tool_choice` | `content` = JSON string |
| `opencode-go` chat | as above | as above | as above (no co-existing tools, no HTTP 400) | `content` = JSON string |
| `github-copilot` chat | as above | as above | as above | `content` = JSON string |
| `nvidia-nim` chat (DeepSeek) | as above | as above | as above | `content` = JSON string |
| `openai-codex` (Codex Responses) | `tools` SSE-mapped, `parallel_tool_calls: false`, `response_format` never sent | `function_call` SSE events OR `output_text` | `tools` unset, `response_format` not forwarded (no such field); phase-2 system suffix enforces JSON | `output_text` = JSON string |

For `openai-codex` phase 2, `buildOpenAICodexRequest` at [src/agents/llm-openai-codex-gateway.ts#L105](../../../../src/agents/llm-openai-codex-gateway.ts#L105) prepends a one-paragraph system suffix to the existing `instructions` string: `"You have no tools this turn. Reply with ONLY the canonical <role> result JSON envelope; no prose, no code fences."` The reply is then `JSON.parse + Zod`-validated on receipt (§1.7.3 boundary, applied to `content` instead of `function.arguments`).

`buildOpenAIChatRequest` at [src/agents/llm-openai-chat-gateway.ts#L178](../../../../src/agents/llm-openai-chat-gateway.ts#L178) is rewritten to forward `response_format: { type: 'json_object' }` only when `opts.mode === 'envelope'`, and to forward `tools` / `tool_choice` / `parallel_tool_calls: false` only when `opts.mode === 'tools'`. The same gateway file at [src/agents/llm-openai-chat-gateway.ts#L186](../../../../src/agents/llm-openai-chat-gateway.ts#L186) loses its `if (opts?.response_format)` branch in favour of the mode discriminator.

### 2.4 Adapter migration

`AgentAdapter.invokeAgent` at [src/agents/agent-adapter.ts#L290](../../../../src/agents/agent-adapter.ts#L290) is restructured into two explicit phases:

```ts
// Phase 1: tools loop
let lastResult: LlmCompleteResult | undefined;
for (let turn = 0; turn < MAX_PHASE_1_TURNS; turn++) {
  const opts = buildLlmOptions(role, 'tools', tools, modelParams, signal, recorder);
  lastResult = await this.llmCallFn!(candidate, systemPrompt, messages, sessionId, opts);
  validateTerminalProtocol(lastResult, { role, terminalToolName: null, mustBeTerminal: false });
  if (lastResult.kind !== 'tools' || lastResult.calls.length === 0) break;     // phase boundary
  for (const tc of lastResult.calls) await this.executeToolCall(tc, …);         // one row per call (§1.8)
  messages = this.buildModelMessages(sessionId);
}

// Phase 2: dedicated envelope turn
const envelopeOpts = buildLlmOptions(role, 'envelope', [], modelParams, signal, recorder);
const phase2 = await this.llmCallFn!(candidate, systemPrompt, messages, sessionId, envelopeOpts);
if (phase2.kind !== 'envelope') throw new LlmContractMismatchError('phase2_unexpected_kind', { kind: phase2.kind, role });
return phase2.envelope as RoleEnvelopeType;
```

`handleToolCallsLoop` at [src/agents/agent-adapter.ts#L220](../../../../src/agents/agent-adapter.ts#L220) is collapsed into the phase-1 body above. The follow-up assembly at [src/agents/agent-adapter.ts#L280](../../../../src/agents/agent-adapter.ts#L280) is deleted (the factory is the only assembler). `forceFinalAnswer` at [src/agents/agent-adapter.ts#L213](../../../../src/agents/agent-adapter.ts#L213) is deleted (phase 2 is its structural replacement). The toolCalls-in-content recovery branch inside the post-loop parser is deleted (`kind: 'tools'` is the only carrier).

### 2.5 Analyst-resolver migration

The analyst path is phase-1-only (it never requests an envelope). The call at [src/agents/analyst-llm-resolver.ts#L163](../../../../src/agents/analyst-llm-resolver.ts#L163) is rewritten to use `buildLlmOptions(role, 'tools', tools, …)`. The result consumer at [src/agents/analyst-llm-resolver.ts#L171](../../../../src/agents/analyst-llm-resolver.ts#L171) switches on `result.kind`:

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
    throw new LlmContractMismatchError('analyst_received_envelope', { role: 'analyst' });
}
```

The public return shape `{ content; toolCalls }` at [src/agents/analyst-llm-resolver.ts#L179](../../../../src/agents/analyst-llm-resolver.ts#L179) is replaced by the typed-union return. `analyst-handler.ts` (the consumer of that return, see [src/agents/analyst-handler.ts#L70-L106](../../../../src/agents/analyst-handler.ts#L70-L106) and [src/agents/analyst-handler.ts#L286-L300](../../../../src/agents/analyst-handler.ts#L286-L300)) is updated in the same pass — no translation shim.

### 2.6 Result-parser migration

[src/agents/result-parser.ts](../../../../src/agents/result-parser.ts) loses its text-channel JSON extraction surface:

- `extractJson` at [src/agents/result-parser.ts#L278](../../../../src/agents/result-parser.ts#L278) is rewritten to a thin `JSON.parse + Zod` wrapper used inside the chat-gateway phase-2 response handler. The three-layer brace-span fallback (code-fence, raw, first-`{`-to-last-`}`) is deleted. The throw at [src/agents/result-parser.ts#L292](../../../../src/agents/result-parser.ts#L292) is replaced by `LlmContractMismatchError('terminal_arguments_not_json' | 'terminal_arguments_schema_mismatch', …)`.
- `parsePlannerResult`, `parseExecutorResult`, `parseReviewerResult` keep their per-role Zod logic but are invoked from the chat-gateway envelope handler, not from `agent-adapter.ts`. The adapter consumes the validated `envelope` field of `kind: 'envelope'`.
- `buildExecutorFallbackResult` at [src/agents/result-parser.ts#L210](../../../../src/agents/result-parser.ts#L210) is deleted — under the two-phase contract the executor envelope is delivered in a dedicated turn that cannot mix tool evidence with envelope text, so the "rescue from tool evidence" fallback is unreachable.

### 2.7 Persistence and event-recorder surface

Session message rows under Proposal F:

- Assistant tool-call rows: `content: serializeToolCallMessage(call)` (one row per tool call, single `ToolCall` shape; §1.8).
- Assistant envelope rows: `content: JSON.stringify(envelope)` (the validated object, not the raw model text).
- `terminalTool` is `null` for every Proposal-F invocation because there is no terminal tool (the envelope arrives via the content channel). `invocation_succeeded.terminal_tool` is always `null` under Proposal F.

The exchange recorder still receives the raw assistant text via `LlmCompleteResult.rawAssistantText` for forensic logging.

### 2.8 Files to DELETE under Proposal F

- `parsePersistedToolCalls` at [src/agents/llm-contracts.ts#L60](../../../../src/agents/llm-contracts.ts#L60).
- The three-layer brace-span fallback inside `extractJson` at [src/agents/result-parser.ts#L278](../../../../src/agents/result-parser.ts#L278).
- `buildExecutorFallbackResult` at [src/agents/result-parser.ts#L210](../../../../src/agents/result-parser.ts#L210).
- `forceFinalAnswer` at [src/agents/agent-adapter.ts#L213](../../../../src/agents/agent-adapter.ts#L213).
- `handleToolCallsLoop` at [src/agents/agent-adapter.ts#L220](../../../../src/agents/agent-adapter.ts#L220) (collapsed into the inline phase-1 loop).
- The duplicate inline options assembler at [src/agents/agent-adapter.ts#L280](../../../../src/agents/agent-adapter.ts#L280).
- The flatten line at [src/agents/agent-llm-gateway.ts#L58](../../../../src/agents/agent-llm-gateway.ts#L58).
- The `{ toolCalls: [...] }` wrapper writes at [src/agents/agent-adapter.ts#L239](../../../../src/agents/agent-adapter.ts#L239), [src/agents/analyst-handler.ts#L300](../../../../src/agents/analyst-handler.ts#L300), [src/agents/fake-agent.ts#L86](../../../../src/agents/fake-agent.ts#L86), and the corresponding readers in §1.8.

### 2.9 Test plan (Proposal F)

Matrix-driven, parameterized over `{ provider: 'opencode' | 'opencode-go' | 'github-copilot' | 'nvidia-nim' | 'openai-codex' } × { phase: 'tools' | 'envelope' }`:

- Request-construction tests: `buildOpenAIChatRequest(candidate, …, opts)` for chat providers and `buildOpenAICodexRequest(candidate, …, opts)` for Codex, parameterized by provider key and `opts.mode`. Assert: phase 1 sends `tools[]` + `parallel_tool_calls: false` and never sends `response_format`; phase 2 sends `response_format: { type: 'json_object' }` (chat) OR injects the system suffix (Codex) and never sends `tools[]`. Each provider entry in the matrix has its own row.
- Capability-selection tests: `capabilityRequestForLlmOptions(opts)` then `assertCandidateCapabilities(candidate, request)` for each provider × mode pair. Assert that no candidate with `envelopeMode: 'unsupported'` is selected for an envelope request, and no candidate with `toolsMode: 'unsupported'` is selected for a tools request.

Per-gateway response-side tests:

- `OpenAIChatGateway.complete` against a fake `fetch` returning each of: tool_calls only with valid argument JSON, tool_calls only with invalid argument JSON, content-only with valid envelope JSON, content-only with invalid envelope JSON, content-only with prose, mixed content + tool_calls (asserts the new contract rejects mixed payloads under `mode: 'envelope'` with `LlmContractMismatchError('phase2_unexpected_kind', …)`).
- `OpenAICodexGateway.complete` against a fake SSE stream, same six cases. Additionally assert that `response_format` is not present in the request body even when `mode: 'envelope'`.

Direct consumer tests:

- `AgentAdapter.invokeAgent` (planner/executor/reviewer): one happy-path test per role asserting that phase 1 executes the action tools, phase 2 returns the validated envelope, and the session-message log contains one `serializeToolCallMessage` row per action call and one JSON envelope row.
- `LlmIntentResolver.chat` + `AnalystHandler.processInbound`: assert that the analyst result switches correctly on `result.kind` and that pending-tool matching works on the single-`ToolCall` row shape.
- `session-persistence.test.ts` and `runtime.test.ts`: assert `findUniqueUnresolvedActivateCardToolCall` and `findUnresolvedActivateCards` correctly enumerate `activate_card` calls under the new row shape, and assert `LegacyMessageShapeError` is raised when fed an old wrapper row.
- Provider stream parsers ([src/agents/llm-stream-parser.ts](../../../../src/agents/llm-stream-parser.ts), [src/agents/llm-codex-parser.ts](../../../../src/agents/llm-codex-parser.ts)): unchanged surface but a new test asserts that `function.arguments` remains a string and is never parsed inside the parser.
- Web: `web/src/__tests__/tool-presenters.test.ts` asserts `readToolCallMessage` parses the new row; `web/src/__tests__/analystChat.test.ts` asserts pending-tool matching; `web/src/__tests__/llm-exchange-viewer.test.ts` and `web/src/__tests__/event-log.test.ts` cover the `terminalTool` field (always `null` under Proposal F).

Removal:

- `tests/agents/result-parser.test.ts`: the cases covering the three-layer brace-span fallback and `buildExecutorFallbackResult` are deleted; the file is reduced to the per-role Zod-validation cases that remain meaningful for phase-2 content parsing.

Live probe (opt-in supplement, not a substitute):

- `scripts/probe-llm-contract.ts` issues one phase-1 turn (action tool) and one phase-2 turn (envelope) per configured provider; reads `.saivage/saivage.json` only (never reads `.saivage/auth-profiles.json` or any `apiKey`/`token` field).

### 2.10 Risk and rollback notes

- One extra round-trip per role invocation. Token cost is bounded (phase 2 carries no tools and no tool results); latency cost is one turn.
- Phase 2 depends on the model honouring the "ONLY JSON envelope" suffix. Zod validation catches deviations as `LlmContractMismatchError`; a persistent regression on a specific model tightens the suffix per role, not the parser.
- Rollback is `git revert` of the F05 commit set. There is no runtime switch.

---

## 3. Proposal L — Level-up: tools-as-only-result

### 3.1 Idea

Every envelope-bearing role's canonical result is delivered as a typed tool call. The planner's tool catalog gains `emit_planner_result(envelope: PlannerResultEnvelope)`; the executor's gains `emit_executor_result(envelope: ExecutorResultEnvelope)`; the reviewer's gains `emit_reviewer_result(envelope: ReviewerResultEnvelope)`. The terminal tool's `parameters` schema IS the canonical Zod envelope schema. A role invocation is a single-phase tools loop with the exclusive-terminal protocol from §1.7: action-eligible turns are `tool_choice: 'auto'` with `parallel_tool_calls: false`; terminal-only turns force the terminal tool. `response_format` is never sent on any role turn. The analyst path runs the same loop with `terminalToolName: null`.

### 3.2 `buildLlmOptions` body (Proposal L)

```ts
export function buildLlmOptions(role, phase, tools, modelParams, signal, recorder): LlmCompleteOptions {
  const terminalName = ROLE_RESULT_TOOL_NAMES[role];               // null for analyst
  if (phase === 'terminal' && terminalName) {
    const terminalOnly = tools.filter((t) => t.function.name === terminalName);
    if (terminalOnly.length !== 1) throw new Error(`Terminal phase for role ${role} requires exactly the ${terminalName} tool`);
    return {
      mode: 'tools',
      tools: terminalOnly,
      tool_choice: { type: 'function', function: { name: terminalName } },
      parallel_tool_calls: false,
      temperature: modelParams.temperature,
      max_tokens: modelParams.maxTokens,
      signal,
      recorder,
    };
  }
  // phase === 'tools' (action-eligible)
  if (tools.length === 0) throw new Error(`Role ${role} requires non-empty tool catalog`);
  return {
    mode: 'tools',
    tools,                                                          // includes terminal tool for envelope-bearing roles
    tool_choice: 'auto',
    parallel_tool_calls: false,
    temperature: modelParams.temperature,
    max_tokens: modelParams.maxTokens,
    signal,
    recorder,
  };
}
```

`LlmEnvelopeOptions` is removed; only `LlmToolsOptions` remains. `responseFormatHint` is removed from the codebase. The `kind: 'envelope'` variant of `LlmCompleteResult` is also removed; only `kind: 'tools'` and `kind: 'terminal_text'` remain.

New file `src/agents/role-result-tools.ts`:

```ts
import { z } from 'zod';
import { PlannerResultSchema, ExecutorResultSchema, ReviewerResultSchema } from './role-envelope-schemas.js';

export const EMIT_PLANNER_RESULT: ToolDefinition = {
  type: 'function',
  function: {
    name: 'emit_planner_result',
    description: 'Emit the canonical planner result envelope. Call this exactly once at the end of the turn to deliver the planner result. This must be the only tool call in its assistant message.',
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

The per-role tool catalogs at [src/agents/agent-tool-catalog.ts#L77](../../../../src/agents/agent-tool-catalog.ts#L77) are extended so each envelope-bearing role's `ROLE_TOOL_NAMES` entry includes its `emit_<role>_result` tool. `buildToolsForRole` at [src/agents/agent-tool-executor.ts#L45](../../../../src/agents/agent-tool-executor.ts#L45) appends the role-result tool to the action tools for envelope-bearing roles.

### 3.3 Per-provider request/response shape

| Provider | Action-eligible request | Terminal-only request | Detection |
| --- | --- | --- | --- |
| `opencode` / `opencode-go` / `github-copilot` / `nvidia-nim` (chat) | `tools[]` includes terminal, `tool_choice: 'auto'`, `parallel_tool_calls: false`, `response_format` UNSET | `tools[]` = `[EMIT_<ROLE>_RESULT]` only, `tool_choice: { type: 'function', function: { name: 'emit_<role>_result' } }`, `parallel_tool_calls: false` | Adapter inspects each `ToolCall.function.name`; the terminal call's `function.arguments` (raw string) is fed to `parseRoleEnvelopeArguments` (§1.7.3). |
| `openai-codex` (Codex Responses) | `tools` SSE-mapped includes terminal, `tool_choice: 'auto'`, `parallel_tool_calls: false` (replaces the current unconditional `true` at [src/agents/llm-openai-codex-gateway.ts#L125](../../../../src/agents/llm-openai-codex-gateway.ts#L125)), `response_format` never sent | tools narrowed to terminal only, `tool_choice` forced, `parallel_tool_calls: false` | Same detection. |

`opencode-go`'s HTTP 400 (`response format and function call at the same time`) cannot occur — `response_format` is never sent. `nvidia-nim`/DeepSeek's prose-instead-of-JSON cannot occur — the envelope is delivered as the typed `arguments` string of a terminal tool call and is `JSON.parse + Zod`-validated at the §1.7.3 boundary; a prose-only reply on a terminal-only turn raises `LlmContractMismatchError('terminal_prose_only', …)`. `openai-codex`'s silent drop of `response_format` cannot occur — it is never sent.

### 3.4 Adapter migration

`AgentAdapter.invokeAgent` becomes a single tools loop with explicit phase escalation:

```ts
const terminalName = ROLE_RESULT_TOOL_NAMES[role];                   // null for analyst
let actionTurns = 0;
while (actionTurns < MAX_TOOLS_TURNS) {
  const opts = buildLlmOptions(role, 'tools', tools, modelParams, signal, recorder);
  const result = await this.llmCallFn!(candidate, systemPrompt, messages, sessionId, opts);
  validateTerminalProtocol(result, { role, terminalToolName: terminalName, mustBeTerminal: false });

  if (result.kind === 'tools') {
    const terminal = terminalName ? result.calls.find((c) => c.function.name === terminalName) : null;
    if (terminal) {
      const envelope = parseRoleEnvelopeArguments(role, terminal.function.arguments);
      return envelope as RoleEnvelopeType;
    }
    for (const tc of result.calls) await this.executeToolCall(tc, …);
    messages = this.buildModelMessages(sessionId);
    actionTurns += 1;
    continue;
  }
  // result.kind === 'terminal_text': model is done with actions, force the terminal turn
  break;
}

if (!terminalName) {
  // Analyst: terminal_text is a valid final reply.
  return { kind: 'text', text: lastTerminalText } as RoleEnvelopeType;
}

// Terminal-only turn: tools narrowed to the terminal tool, tool_choice forced.
const terminalOpts = buildLlmOptions(role, 'terminal', [TERMINAL_TOOL_FOR_ROLE[role]!], modelParams, signal, recorder);
const terminalResult = await this.llmCallFn!(candidate, systemPrompt, messages, sessionId, terminalOpts);
validateTerminalProtocol(terminalResult, { role, terminalToolName: terminalName, mustBeTerminal: true });
const terminal = (terminalResult as Extract<LlmCompleteResult, { kind: 'tools' }>).calls[0];
return parseRoleEnvelopeArguments(role, terminal.function.arguments) as RoleEnvelopeType;
```

`handleToolCallsLoop` at [src/agents/agent-adapter.ts#L220](../../../../src/agents/agent-adapter.ts#L220), `forceFinalAnswer` at [src/agents/agent-adapter.ts#L213](../../../../src/agents/agent-adapter.ts#L213), the duplicate options spread at [src/agents/agent-adapter.ts#L280](../../../../src/agents/agent-adapter.ts#L280), the toolCalls-in-content recovery branch, and the `expectsJsonEnvelope` test at [src/agents/agent-adapter.ts#L341](../../../../src/agents/agent-adapter.ts#L341) are all deleted. The adapter's previous parser callback (`parsePlannerResult` / `parseExecutorResult` / `parseReviewerResult`) is removed — the envelope is validated inline by `parseRoleEnvelopeArguments`. Persisted assistant rows use `serializeToolCallMessage` exclusively (§1.8); there are no envelope-text rows for envelope-bearing roles.

### 3.5 Analyst-resolver migration

The analyst path is structurally the same loop with `terminalToolName: null`. The call at [src/agents/analyst-llm-resolver.ts#L163](../../../../src/agents/analyst-llm-resolver.ts#L163) is rewritten to use `buildLlmOptions(role, 'tools', …)`. The result consumer at [src/agents/analyst-llm-resolver.ts#L171](../../../../src/agents/analyst-llm-resolver.ts#L171) switches on `result.kind`:

```ts
type AnalystResult =
  | { kind: 'tools'; calls: ToolCall[] }
  | { kind: 'text'; text: string }
  | { kind: 'unsupported'; message: string };
```

`LlmIntentResolver.chat` at [src/agents/analyst-llm-resolver.ts#L179](../../../../src/agents/analyst-llm-resolver.ts#L179) returns `AnalystResult`. The two analyst-handler consumers at [src/agents/analyst-handler.ts#L70-L106](../../../../src/agents/analyst-handler.ts#L70-L106) and [src/agents/analyst-handler.ts#L286-L300](../../../../src/agents/analyst-handler.ts#L286-L300) are updated to switch on the new shape; no translation shim survives.

### 3.6 Result-parser migration

[src/agents/result-parser.ts](../../../../src/agents/result-parser.ts) is reduced to the per-role Zod schemas only (which then live in `src/agents/role-envelope-schemas.ts`) plus any role-specific normalization (e.g. `normalizePlannerActions` becomes a Zod `.transform()`):

- `extractJson` at [src/agents/result-parser.ts#L278](../../../../src/agents/result-parser.ts#L278) — DELETED.
- `parsePlannerResult` / `parseExecutorResult` / `parseReviewerResult` — DELETED at this layer; their Zod schemas migrate to `role-envelope-schemas.ts` and are invoked by `parseRoleEnvelopeArguments` (§1.7.3).
- `buildExecutorFallbackResult` at [src/agents/result-parser.ts#L210](../../../../src/agents/result-parser.ts#L210) — DELETED. An executor that does not call `emit_executor_result` is a typed contract mismatch, not a recovery situation.
- `ResultParseError` at [src/agents/result-parser.ts#L82](../../../../src/agents/result-parser.ts#L82) — DELETED. Replaced by `LlmContractMismatchError`.

### 3.7 Persistence and event-recorder surface

- Assistant tool-call rows store `serializeToolCallMessage(call)` (one row per tool call; §1.8). The terminal `emit_<role>_result` call is a normal tool-call row whose `function.name` is the terminal name.
- There are NO assistant "text" envelope rows for envelope-bearing roles. The result lives in the terminal tool-call row's `function.arguments` string and in the corresponding `tool` row carrying `{ kind: 'tool_result', content: '<role>_envelope_accepted', tool_call_id: <id> }`.
- `terminalTool` in `LlmExchange` attempts (§1.9) is the terminal tool name when the attempt produced one, else `null`/absent.
- `invocation_succeeded.terminal_tool` (§1.9) is `'emit_planner_result' | 'emit_executor_result' | 'emit_reviewer_result' | null`; analyst invocations always emit `null`.

### 3.8 Files to DELETE under Proposal L

Everything from §2.8 plus:

- `parsePlannerResult`, `parseExecutorResult`, `parseReviewerResult` at [src/agents/result-parser.ts](../../../../src/agents/result-parser.ts).
- `ResultParseError` at [src/agents/result-parser.ts#L82](../../../../src/agents/result-parser.ts#L82).
- The `LlmEnvelopeOptions` variant of `LlmCompleteOptions` in [src/agents/llm-contracts.ts](../../../../src/agents/llm-contracts.ts).
- The `kind: 'envelope'` variant of `LlmCompleteResult` in [src/agents/llm-contracts.ts](../../../../src/agents/llm-contracts.ts).
- The forwarding of `response_format` in `buildOpenAIChatRequest` at [src/agents/llm-openai-chat-gateway.ts#L186](../../../../src/agents/llm-openai-chat-gateway.ts#L186) (the entire branch).
- The unconditional `body.parallel_tool_calls = true` at [src/agents/llm-openai-codex-gateway.ts#L125](../../../../src/agents/llm-openai-codex-gateway.ts#L125) (replaced by `body.parallel_tool_calls = opts.parallel_tool_calls`, which is always `false` under Proposal L).
- The `responseFormatHint` field across the codebase.
- The `envelopeMode` axis on the capability surface (every envelope-bearing role only requires `toolsMode: 'native'` and `exclusiveToolChoiceSupport ∈ { 'native', 'parallel_off' }`).

### 3.9 Test plan (Proposal L)

Matrix-driven, parameterized over `{ provider: 'opencode' | 'opencode-go' | 'github-copilot' | 'nvidia-nim' | 'openai-codex' } × { phase: 'tools' | 'terminal' } × { role: 'planner' | 'executor' | 'reviewer' | 'analyst' }`:

- Request-construction tests on `buildOpenAIChatRequest` / `buildOpenAICodexRequest` for every provider × phase × role triple. Assert (a) `response_format` is never present in the request body for any case; (b) `parallel_tool_calls` is `false` on every request body (chat AND Codex); (c) on `phase === 'terminal'` for envelope-bearing roles, `tools[]` contains exactly one entry whose `function.name` matches the role's terminal name and `tool_choice` is `{ type: 'function', function: { name: terminalName } }`; (d) on `phase === 'tools'` for envelope-bearing roles, `tools[]` includes the terminal tool but `tool_choice` is `'auto'`; (e) for `role === 'analyst'`, the terminal tool is never present.
- Capability-selection tests on `capabilityRequestForLlmOptions(opts)` then `assertCandidateCapabilities(candidate, request)` for each provider × phase pair. Assert no candidate with `toolsMode: 'unsupported'` or `exclusiveToolChoiceSupport: 'unsupported'` is selected.

Per-gateway response-side tests:

- `OpenAIChatGateway.complete` against a fake `fetch` returning each of: (a) intermediate action tool call (`finishReason: 'tool_calls'`), (b) terminal tool call with valid JSON arguments, (c) terminal tool call with invalid JSON arguments (raises `LlmContractMismatchError('terminal_arguments_not_json', …)`), (d) terminal tool call with valid JSON but schema-invalid arguments (raises `LlmContractMismatchError('terminal_arguments_schema_mismatch', …)`), (e) duplicate terminal tool calls (raises `LlmContractMismatchError('terminal_duplicate', …)`), (f) terminal + action mixed in the same assistant message (raises `LlmContractMismatchError('terminal_mixed_with_actions', …)`), (g) terminal call for the wrong role's tool (raises `LlmContractMismatchError('terminal_wrong_role', …)`), (h) prose-only response on a terminal-only turn (raises `LlmContractMismatchError('terminal_prose_only', …)`), (i) missing terminal at max turns (raises `LlmContractMismatchError('terminal_missing_at_limit', …)`).
- `OpenAICodexGateway.complete` against a fake SSE stream, same nine cases. Additionally assert `response_format` is absent and `parallel_tool_calls` is `false` in the request body for every case.

Per-rejection-case unit-test names (one per case, owned by `tests/agents/terminal-protocol.test.ts`):

- `terminal_duplicate__chat_rejects_two_emit_planner_result_calls`
- `terminal_duplicate__codex_rejects_two_emit_planner_result_calls`
- `terminal_mixed_with_actions__chat_rejects_emit_planner_plus_create_card`
- `terminal_mixed_with_actions__codex_rejects_emit_planner_plus_create_card`
- `terminal_wrong_role__executor_rejects_emit_planner_result`
- `terminal_wrong_role__planner_rejects_emit_executor_result`
- `terminal_prose_only__rejects_prose_on_forced_terminal_turn`
- `terminal_arguments_not_json__rejects_unparseable_arguments`
- `terminal_arguments_schema_mismatch__rejects_zod_invalid_envelope`
- `terminal_missing_at_limit__rejects_when_max_turns_reached_without_emit`

Direct consumer tests:

- `AgentAdapter.invokeAgent` per role (planner/executor/reviewer): happy-path test asserting the loop executes action tools, the terminal-only turn returns the validated envelope, and the persisted-session log contains one `serializeToolCallMessage` row per action call plus one row for the terminal call. Additional test asserting that `invocation_succeeded.terminal_tool` is set to the correct value.
- `LlmIntentResolver.chat` + `AnalystHandler.processInbound`: assert the analyst result switches on `kind`, that `terminalTool` is `null` for analyst invocations, and that pending-tool matching ([web/src/stores/analystChat.ts#L99-L108](../../../../web/src/stores/analystChat.ts#L99-L108)) works on the single-`ToolCall` row shape.
- `session-persistence.test.ts` (`findUniqueUnresolvedActivateCardToolCall` at [src/agents/session-persistence.ts#L399-L420](../../../../src/agents/session-persistence.ts#L399-L420)) and `runtime.test.ts` (`findUnresolvedActivateCards` at [src/runtime/runtime.ts#L234-L264](../../../../src/runtime/runtime.ts#L234-L264)): assert correct enumeration under the new row shape; assert `LegacyMessageShapeError` is raised when fed an old wrapper row.
- Provider stream parsers ([src/agents/llm-stream-parser.ts](../../../../src/agents/llm-stream-parser.ts) `buildOpenAIChatStreamResult`, [src/agents/llm-codex-parser.ts](../../../../src/agents/llm-codex-parser.ts) `finalizeCodexToolCall`): unchanged surface; new tests assert that `function.arguments` remains a string at the parser boundary (never parsed inside the parser) and that streaming-concatenated arguments are preserved verbatim.
- Web: `web/src/__tests__/tool-presenters.test.ts` asserts `readToolCallMessage` parses the new row; `web/src/__tests__/analystChat.test.ts` asserts pending-tool matching; `web/src/__tests__/llm-exchange-viewer.test.ts` and `web/src/__tests__/event-log.test.ts` cover the `terminalTool` field for each role and for `null`.
- Contract schemas: `tests/contracts/llm-exchange.test.ts` and `tests/schemas/event-catalog.test.ts` exercise the new `terminal_tool` field round-trip for each role and for `null`.
- Recovery policy: `tests/agents/invocation-recovery-policy.test.ts` adds a case asserting `LlmContractMismatchError` classifies to `action: 'fail_invocation'` with `markFailed: false`, for each rejection subtype.

Removal of obsolete tests:

- `tests/agents/result-parser.test.ts` — DELETED in its entirety; the parser surface it covers is deleted.
- The current `tests/agents/llm-client-integration.test.ts` cases that assert the `{ toolCalls: [...] }` envelope are replaced with cases that assert the single-`ToolCall` row shape and the `LegacyMessageShapeError` rejection.
- `tests/agents/agent-tool-executor.test.ts`, `tests/runtime/agent-runtime.test.ts`, `tests/agents/codex-deferred-activate-card.test.ts`, `tests/agents/session-persistence.test.ts`, `tests/agents/fake-agent.test.ts`: fixtures that hard-code the wrapper are rewritten in the same pass.

Live probe (opt-in supplement, not a substitute):

- `scripts/probe-llm-contract.ts` issues one role invocation per configured provider that exercises (a) at least one action tool call followed by (b) the terminal `emit_<role>_result` call. Asserts the envelope parses against the role's Zod schema. Reads `.saivage/saivage.json` only; never `.saivage/auth-profiles.json` or any `apiKey`/`token` field.

### 3.10 Risk and rollback notes

- The model may emit prose alongside an action turn (`result.kind === 'tools'` AND `result.calls.length > 0` AND `result.rawAssistantText !== null`). Permitted by OpenAI chat-completions and Codex Responses. Preserved in `rawAssistantText` for forensics; ignored for routing.
- The model may emit prose-only on a forced terminal turn. `LlmContractMismatchError('terminal_prose_only', …)` is raised; the invocation fails without cooldown; the operator sees a clear `invocation_failed` event. The role's system prompt explicitly states `"You MUST call emit_<role>_result exactly once to deliver your result; the runtime cannot accept a prose answer."`
- Tool catalogs grow by one entry per envelope-bearing role. Token cost is small and bounded; the role-result tool's `parameters` schema is the same JSON-Schema the runtime already renders for the inverse direction.
- Persisted role envelopes live nested inside a tool-call row's `function.arguments` string rather than a top-level assistant-text row. The web session viewer, LLM-exchange viewer, and any operator inspector script are updated in the same pass (§1.8.1). Old sessions are not migrated; the reader rejects old shapes with `LegacyMessageShapeError`.
- Rollback is `git revert` of the F05 commit set. There is no runtime switch.

---

## 4. Side-by-side invariants matrix

| # | Invariant (from approved analysis §5) | Proposal F (two-phase) | Proposal L (tools-as-only-result) |
| --- | --- | --- | --- |
| 1 | Single-carrier per turn — `LlmCompleteOptions` is a discriminated union with `tools` xor `responseFormatHint` | Satisfied — `LlmToolsOptions` vs `LlmEnvelopeOptions` keyed by `mode`. | Satisfied — only `LlmToolsOptions` exists; the second variant is structurally absent. |
| 2 | Single-carrier per result — `LlmCompleteResult` is a discriminated union | Satisfied — `{kind:'tools'} \| {kind:'envelope'} \| {kind:'terminal_text'}`. | Satisfied — `{kind:'tools'} \| {kind:'terminal_text'}`. Simpler. |
| 3 | No string-flatten in the gateway | Satisfied — `agent-llm-gateway.ts` returns the structured result directly. | Same. |
| 4 | No per-turn option drift — single factory builds every turn | Satisfied — `buildLlmOptions(role, phase, …)` for both phases. | Satisfied — `buildLlmOptions(role, 'tools' \| 'terminal', …)` for action-eligible and terminal-only turns. |
| 5 | Envelope parsed by typed schema, not text heuristics | Satisfied — chat gateway runs `JSON.parse + Zod` on phase-2 `content`; `extractJson` reduced to that. | Satisfied — adapter runs `parseRoleEnvelopeArguments` on the terminal tool's `function.arguments`; `extractJson` deleted entirely. |
| 6 | Capability surface admits the new shape | Satisfied — `envelopeMode` and `toolsMode` axes added; `exclusiveToolChoiceSupport` added for §1.7 enforcement. | Same. Additionally `envelopeMode` is unused at runtime under Proposal L (envelope mode never selected). |
| 7 | Codex Responses is a first-class participant | Satisfied — phase-2 uses system-suffix prompt; gateway Zod-validates the reply. | Satisfied automatically — `response_format` is never sent on any role turn; Codex aligns structurally. |
| 8 | Typed failures; contract mismatch does not cooldown | Satisfied — `LlmContractMismatchError` → `action: 'fail_invocation'`, `markFailed: false`. | Same, with finer-grained subtypes (`terminal_duplicate`, `terminal_mixed_with_actions`, …). |
| 9 | No backward-compat shim survives | Satisfied — `parsePersistedToolCalls`, the flatten line, `buildExecutorFallbackResult`, `forceFinalAnswer`, the toolCalls-in-content branch, the three-layer brace-span fallback, and every `{ toolCalls: [...] }` producer/consumer in §1.8.1 are deleted; `LegacyMessageShapeError` raised on old rows. | Satisfied — everything above PLUS `parsePlannerResult` / `parseExecutorResult` / `parseReviewerResult`, `ResultParseError`, `LlmEnvelopeOptions`, the `kind: 'envelope'` variant, `responseFormatHint`, `envelopeMode`, the `response_format` forwarding branch, and the unconditional `parallel_tool_calls: true` are deleted. |
| 10 | Tests cover the matrix AND every direct consumer | Satisfied — matrix-driven request-construction and capability-selection tests for every provider × phase pair; direct consumer tests for adapter, analyst, session-persistence/runtime, stream parsers, web; `result-parser.test.ts` reduced to phase-2 Zod cases. | Satisfied — same, with the additional rejection-case test family from §3.9, the role × phase × provider parameterization for terminal-protocol enforcement, and `result-parser.test.ts` deleted entirely. |

### 4.1 Operational and design-quality comparison

| Axis | Proposal F | Proposal L |
| --- | --- | --- |
| Lines of code deleted | ~150 | ~280 |
| Lines of new code | ~120 | ~110 |
| Round-trips per role invocation | +1 turn (phase 2) vs current typical | Same as today's terminal turn cost (terminal turn replaces today's "follow-up envelope" turn one-for-one) |
| Token cost per invocation | + phase-2 prompt + envelope tokens | + role-result tool schema in `tools[]` on every turn; no extra turn |
| Provider compatibility risk | Phase 2 depends on transport tolerating "no tools" turns and on the model honouring the JSON-only suffix on Codex; all current providers do | Zero — every provider in the matrix handles tools-only with `parallel_tool_calls: false` cleanly |
| Analyst-path alignment | Analyst is phase-1-only; close to but not identical to the envelope-role loop | Analyst is a degenerate case of the same loop (terminal name `null`); strongest structural convergence |
| Failure-mode coverage | F01, F02, F09, F11 disappear by construction | F01, F02, F09, F11 disappear by construction AND the `extractJson` family disappears, so future "prose around JSON" regressions are impossible by absence |
| Future-proofing | New providers need either tools-only OR `response_format` per turn (most do both) | New providers only need tools-only with `parallel_tool_calls: false`; this is the OpenAI-defined feature surface every chat-completions clone implements |
| Architectural debt removed | Carrier orthogonality and per-turn drift | Carrier orthogonality, per-turn drift, AND the entire text-channel envelope-extraction surface |

---

## 5. Recommendation: Proposal L

Both proposals satisfy invariants 1–10. **Proposal L (tools-as-only-result)** is the recommendation for four reasons that follow directly from the workspace architecture-first / no-backward-compatibility guideline.

1. **Strictly more dead code is deleted.** Proposal L removes everything Proposal F removes plus `parsePlannerResult` / `parseExecutorResult` / `parseReviewerResult`, `ResultParseError`, `LlmEnvelopeOptions`, the `kind: 'envelope'` variant, `responseFormatHint`, `envelopeMode`, the `response_format` forwarding branch in `buildOpenAIChatRequest`, and the unconditional `parallel_tool_calls: true` in `buildOpenAICodexRequest`. The guideline says: "Actively REMOVE code supporting old features/structures." Proposal L removes a larger structurally-coherent surface.

2. **One less degree of freedom on the wire.** Proposal F still has two request shapes (phase-1 tools, phase-2 envelope) and two response shapes (`kind: 'tools'`, `kind: 'envelope'`). Proposal L has one. Every provider gateway, every test, every operator-facing tool that explains the protocol becomes simpler.

3. **The envelope is delivered as a typed object end-to-end, with explicit failure modes for every wire violation.** The terminal tool's `arguments` field is a raw JSON string at the wire (the chat and Codex parsers concatenate string deltas verbatim and never validate). Proposal L applies a single `parseRoleEnvelopeArguments` boundary that runs `JSON.parse + Zod` and raises `LlmContractMismatchError` with the schema diff and a redacted preview, preserving the raw text for forensics. Combined with the exclusive-terminal protocol from §1.7, every wire-level violation has a named typed failure subtype and a named rejection test.

4. **The analyst path and the envelope-bearing roles converge.** Under Proposal F, the analyst path is "tools-only, single phase" and the envelope-bearing roles are "tools then envelope, two phases" — two distinct shapes in the code. Under Proposal L every role runs the same loop; the only difference is the terminal-tool name (`null` for analyst).

Proposal F is a reasonable answer to "what if we cannot risk the deeper refactor today?" — but the guideline explicitly says: "Never apply 'minimal change' defaults — refactor broadly when it improves the design." Proposal L is the design the guideline points to.

### 5.1 Implementation order (single coherent pass, Proposal L)

1. Introduce `src/agents/role-envelope-schemas.ts` and `src/agents/role-result-tools.ts`; introduce `src/agents/persisted-tool-call.ts` (and the web mirror at `web/src/utils/persistedToolCall.ts`).
2. Rewrite `LlmCompleteOptions` and `LlmCompleteResult` in [src/agents/llm-contracts.ts](../../../../src/agents/llm-contracts.ts); delete `parsePersistedToolCalls`.
3. Rewrite `buildOpenAIChatRequest` at [src/agents/llm-openai-chat-gateway.ts#L148](../../../../src/agents/llm-openai-chat-gateway.ts#L148) to assert `opts.mode === 'tools'`, never forward `response_format`, always forward `parallel_tool_calls: false`, and replace the `parsePersistedToolCalls(m.content)` call at [src/agents/llm-openai-chat-gateway.ts#L160](../../../../src/agents/llm-openai-chat-gateway.ts#L160) with the new `parseToolCallMessage`.
4. Rewrite `buildOpenAICodexRequest` at [src/agents/llm-openai-codex-gateway.ts#L105](../../../../src/agents/llm-openai-codex-gateway.ts#L105) the same way; remove the unconditional `body.parallel_tool_calls = true` at [src/agents/llm-openai-codex-gateway.ts#L125](../../../../src/agents/llm-openai-codex-gateway.ts#L125) and replace the `codexMessages` reader at [src/agents/llm-openai-codex-gateway.ts#L130](../../../../src/agents/llm-openai-codex-gateway.ts#L130) with `parseToolCallMessage`.
5. Rewrite both gateways' response parsers to return the new `LlmCompleteResult` union and raise `LlmContractMismatchError` on mismatches; introduce `validateTerminalProtocol` and `parseRoleEnvelopeArguments`.
6. Introduce `src/agents/llm-options-factory.ts`; rewrite the single adapter call site (replacing both [src/agents/agent-adapter.ts#L280](../../../../src/agents/agent-adapter.ts#L280) and [src/agents/agent-adapter.ts#L342](../../../../src/agents/agent-adapter.ts#L342)) and the analyst call site at [src/agents/analyst-llm-resolver.ts#L163](../../../../src/agents/analyst-llm-resolver.ts#L163).
7. Rewrite `AgentAdapter.invokeAgent` to the single-mode tools loop with the action-eligible vs terminal-only phase escalation; delete `handleToolCallsLoop`, `forceFinalAnswer`, the toolCalls-in-content recovery branch, and the inline persisted-row writes; replace them with `serializeToolCallMessage`.
8. Rewrite `LlmIntentResolver.chat` to switch on `result.kind`; update both `analyst-handler.ts` consumers ([src/agents/analyst-handler.ts#L70-L106](../../../../src/agents/analyst-handler.ts#L70-L106), [src/agents/analyst-handler.ts#L286-L300](../../../../src/agents/analyst-handler.ts#L286-L300)) to the typed-union return; replace the wrapper write at [src/agents/analyst-handler.ts#L300](../../../../src/agents/analyst-handler.ts#L300) with one `serializeToolCallMessage` row per tool call.
9. Rewrite `fake-agent.ts` at [src/agents/fake-agent.ts#L86](../../../../src/agents/fake-agent.ts#L86) to emit `serializeToolCallMessage` rows.
10. Delete `extractJson`, `parsePlannerResult`, `parseExecutorResult`, `parseReviewerResult`, `buildExecutorFallbackResult`, `ResultParseError` from [src/agents/result-parser.ts](../../../../src/agents/result-parser.ts).
11. Migrate `session-persistence.ts` ([src/agents/session-persistence.ts#L379-L420](../../../../src/agents/session-persistence.ts#L379-L420)), `runtime.ts` ([src/runtime/runtime.ts#L234-L264](../../../../src/runtime/runtime.ts#L234-L264)), the web tool presenter ([web/src/utils/tool-presenters/helpers.ts#L68-L78](../../../../web/src/utils/tool-presenters/helpers.ts#L68-L78)), and the analyst chat store ([web/src/stores/analystChat.ts#L99-L108](../../../../web/src/stores/analystChat.ts#L99-L108)) to `parseToolCallMessage`.
12. Update the capability surface (add `toolsMode` and `exclusiveToolChoiceSupport` axes; update built-ins; update `capabilityRequestForLlmOptions` at [src/agents/provider-capabilities.ts#L127](../../../../src/agents/provider-capabilities.ts#L127)).
13. Update `InvocationRecoveryPolicy.decideFailure` at [src/agents/invocation-recovery-policy.ts#L120](../../../../src/agents/invocation-recovery-policy.ts#L120) with the `LlmContractMismatchError` branch.
14. Extend `exchangeAttemptSchema` at [src/contracts/llm-exchange.ts#L23-L31](../../../../src/contracts/llm-exchange.ts#L23-L31) and `invocation_succeeded` at [src/schemas/event-catalog.ts#L51](../../../../src/schemas/event-catalog.ts#L51) with the `terminalTool` / `terminal_tool` field; update the web LLM-exchange viewer and event-log row to render the badge.
15. Land the test suite from §3.9 alongside the deletes.

The corresponding sibling-issue work is owned by F01 (option-assembler), F02 / F09 (parser deletions), F10 (capability axis), F11 (flatten and per-turn drift deletions), and F08 (failure classifier branch). Per the approved analysis §6, those sibling issues' plans collapse to "delete the old surface and re-implement against the new contract from F05" once this design lands.
