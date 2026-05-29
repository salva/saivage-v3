# F05 — Envelope-vs-toolcalls orthogonality (design)

Scope: replace the orthogonal `{ tools[] + response_format }` contract at [src/agents/llm-contracts.ts#L25](../../../../src/agents/llm-contracts.ts#L25), [src/agents/agent-adapter.ts#L342](../../../../src/agents/agent-adapter.ts#L342), and [src/agents/agent-llm-gateway.ts#L58](../../../../src/agents/agent-llm-gateway.ts#L58). File references are workspace-relative to `/home/salva/g/ml/saivage-v3/` and clickable. Per the workspace architecture-first / no-backward-compatibility guideline, no feature flag, no envelope-mode fallback, and no data-format migration shim survives. Persistence rows that encode the legacy `{ toolCalls: [...] }` wrapper are REJECTED by the reader, not bridged.

This document presents Proposal F (two-phase tools-then-envelope) compactly in §2 and recommends Proposal L (tools-as-only-result). The depth lives in §3 (Proposal L substrate, including the provider-neutral terminal choice and per-provider wire translation), §4 (single-owner adapter validator for the exclusive terminal protocol), §6 (complete migration inventory), §7 (`terminalTool` end-to-end plumbing), and §8 (matrix-driven test plan with separate chat vs Codex body assertions). Sections §1 and §5 are short; §9–§10 cover ordering and the recommendation.

---

## 1. Recap of the shared substrate

Five primitives are introduced once and reused under both proposals.

1. **`LlmCompleteOptions` discriminated union** at [src/agents/llm-contracts.ts#L31](../../../../src/agents/llm-contracts.ts#L31). Under Proposal F: `LlmToolsOptions | LlmEnvelopeOptions`. Under Proposal L: `LlmToolsOptions` only. Construction invariant: `tools[]` and `responseFormatHint` cannot coexist. Legacy flat fields `response_format?` and optional `tools?` are deleted from the options surface.

2. **`LlmCompleteResult` discriminated union** at [src/agents/llm-contracts.ts#L25](../../../../src/agents/llm-contracts.ts#L25). Members under Proposal L: `{ kind: 'tools'; calls: ToolCall[]; rawAssistantText: string | null } | { kind: 'terminal_text'; text: string }`. Proposal F adds a third `{ kind: 'envelope'; envelope: unknown; rawAssistantText: string }`. Roles that request a typed result never receive `kind: 'terminal_text'` on a terminal-only turn; the adapter validator raises `LlmContractMismatchError` if they do (§4).

3. **Single option-assembler factory** in a new `src/agents/llm-options-factory.ts`. Function `buildLlmOptions(role, phase, tools, modelParams, signal, recorder, terminalToolName): LlmCompleteOptions`. Every existing call site that assembles `LlmCompleteOptions` inline is rewritten to use this factory — the adapter sites at [src/agents/agent-adapter.ts#L280](../../../../src/agents/agent-adapter.ts#L280) and [src/agents/agent-adapter.ts#L342](../../../../src/agents/agent-adapter.ts#L342) and the analyst site at [src/agents/analyst-llm-resolver.ts#L163](../../../../src/agents/analyst-llm-resolver.ts#L163). Per-turn option drift becomes structurally impossible.

4. **Structured gateway return path**. `LlmCallFn` at [src/agents/llm-contracts.ts#L52](../../../../src/agents/llm-contracts.ts#L52) returns `Promise<LlmCompleteResult>`. `AgentLlmInvocationGateway.createLlmCallFn` at [src/agents/agent-llm-gateway.ts#L48](../../../../src/agents/agent-llm-gateway.ts#L48) returns the structured result verbatim. The flatten line at [src/agents/agent-llm-gateway.ts#L58](../../../../src/agents/agent-llm-gateway.ts#L58) (`return result.content ?? JSON.stringify({ toolCalls: result.toolCalls });`) is DELETED.

5. **`LlmContractMismatchError`** in [src/agents/llm-errors.ts](../../../../src/agents/llm-errors.ts), classified by `InvocationRecoveryPolicy.decideFailure` at [src/agents/invocation-recovery-policy.ts#L120](../../../../src/agents/invocation-recovery-policy.ts#L120) as `action: 'fail_invocation'`, `markFailed: false`, `appendModelIssue: true`, `abort: true`, no cooldown — a wire contract mismatch is a coding or model-side defect, not transport-transient. A second class `LegacyMessageShapeError` is raised by the persisted-row reader (§6) when an on-disk row encodes the old wrapper.

6. **Provider-neutral `TerminalChoice` type** (the substrate change that fixes the chat-vs-Codex shape leak). Defined in [src/agents/llm-contracts.ts](../../../../src/agents/llm-contracts.ts):

```ts
export type TerminalChoice =
  | { kind: 'auto' }
  | { kind: 'required_named'; toolName: string };
```

`LlmToolsOptions.tool_choice` uses this type — not the chat-completions nested function-choice JSON. Per-provider translation to wire JSON is owned by the gateway request builders (§3.5). The chat-completions JSON shape `{ type: 'function'; function: { name } }` and the Codex Responses JSON shape `{ type: 'function'; name }` never appear in shared types.

---

## 2. Substrate for Proposal F

Proposal F splits a role invocation into two explicit phases on the wire. Phase 1 is `mode: 'tools'` with no `response_format`. Phase 2 is `mode: 'envelope'` with no `tools[]`. Single carrier per turn by construction.

- `buildLlmOptions(role, phase, …)` returns `LlmToolsOptions` for `phase === 'tools'` (with `parallel_tool_calls: false`, `tool_choice: { kind: 'auto' }`) and `LlmEnvelopeOptions` for `phase === 'envelope'` (with `envelopeSchema = ENVELOPE_SCHEMAS[role]`, `responseFormatHint: 'json_object'`). `ENVELOPE_SCHEMAS` lives in a new `src/agents/role-envelope-schemas.ts` and re-exports the existing per-role Zod schemas.
- `AgentAdapter.invokeAgent` is restructured into a phase-1 tools loop followed by one phase-2 envelope turn. `handleToolCallsLoop` at [src/agents/agent-adapter.ts#L220](../../../../src/agents/agent-adapter.ts#L220) is collapsed into the loop body. `forceFinalAnswer` at [src/agents/agent-adapter.ts#L213](../../../../src/agents/agent-adapter.ts#L213) is DELETED (phase 2 is its structural replacement). The toolCalls-in-content recovery branch is DELETED.
- Chat-completions providers send `response_format: { type: 'json_object' }` on phase 2 only. Codex Responses cannot accept `response_format`; instead phase 2 injects a one-paragraph system suffix `"You have no tools this turn. Reply with ONLY the canonical <role> result JSON envelope; no prose, no code fences."` and the reply is `JSON.parse + Zod`-validated.
- `terminalTool` is always `null` under Proposal F (the envelope arrives via the content channel; no terminal tool exists).
- Capability surface keeps `envelopeMode ∈ {'native_json_object','prompt_only','unsupported'}` AND `toolsMode ∈ {'native','unsupported'}`. `exclusiveToolChoiceSupport` is unused.
- Round-trip cost: +1 turn per invocation. Token cost: bounded (phase-2 carries no tools, no tool results).

Proposal F is presented for comparison only. The rest of this document describes Proposal L, the recommendation.

---

## 3. Substrate for Proposal L

Under Proposal L there is no envelope mode at any layer. The only carrier the wire ever uses for a role result is a typed terminal tool call.

### 3.1 Options/result union

`LlmCompleteOptions` collapses to a single variant; `tool_choice` uses the provider-neutral `TerminalChoice` from §1.

```ts
export interface LlmToolsOptions extends LlmCommonOptions {
  mode: 'tools';
  tools: ToolDefinition[];                 // NEVER empty
  tool_choice: TerminalChoice;             // { kind: 'auto' } | { kind: 'required_named'; toolName }
  parallel_tool_calls: false;              // structurally fixed
}
export type LlmCompleteOptions = LlmToolsOptions;
```

`LlmEnvelopeOptions`, `responseFormatHint`, and the `kind: 'envelope'` variant of `LlmCompleteResult` do not exist under Proposal L. `LlmCompleteResult` is:

```ts
export type LlmCompleteResult =
  | { kind: 'tools'; calls: ToolCall[]; rawAssistantText: string | null }
  | { kind: 'terminal_text'; text: string };
```

The chat-completions parser at [src/agents/llm-stream-parser.ts](../../../../src/agents/llm-stream-parser.ts) and the Codex parser at [src/agents/llm-codex-parser.ts](../../../../src/agents/llm-codex-parser.ts) keep their existing surfaces but their return type is the new union. `function.arguments` remains a raw string at the parser boundary (§5).

### 3.2 Role-result tools and per-role catalogs

New file `src/agents/role-result-tools.ts`:

```ts
import { z } from 'zod';
import { PlannerResultSchema, ExecutorResultSchema, ReviewerResultSchema } from './role-envelope-schemas.js';

export const EMIT_PLANNER_RESULT: ToolDefinition = {
  type: 'function',
  function: {
    name: 'emit_planner_result',
    description: 'Emit the canonical planner result envelope. Call this exactly once at the end of the turn. This must be the only tool call in its assistant message.',
    parameters: zodToJsonSchema(PlannerResultSchema),
  },
};
// EMIT_EXECUTOR_RESULT and EMIT_REVIEWER_RESULT analogous.

export const ROLE_RESULT_TOOL_NAMES: Record<AgentRole, string | null> = {
  planner: 'emit_planner_result',
  executor: 'emit_executor_result',
  reviewer: 'emit_reviewer_result',
  analyst: null,  // analyst has no canonical envelope
};
```

`buildToolsForRole` at [src/agents/agent-tool-executor.ts#L45](../../../../src/agents/agent-tool-executor.ts#L45) appends the role-result tool for envelope-bearing roles. `AgentToolCatalog` at [src/agents/agent-tool-catalog.ts#L77](../../../../src/agents/agent-tool-catalog.ts#L77) lists the new tools in each role's `ROLE_TOOL_NAMES` entry.

### 3.3 `buildLlmOptions` body

```ts
export function buildLlmOptions(role, phase, tools, modelParams, signal, recorder): LlmCompleteOptions {
  const terminalName = ROLE_RESULT_TOOL_NAMES[role];
  if (phase === 'terminal' && terminalName) {
    const terminalOnly = tools.filter((t) => t.function.name === terminalName);
    if (terminalOnly.length !== 1) throw new Error(`Terminal phase for role ${role} requires exactly the ${terminalName} tool`);
    return {
      mode: 'tools',
      tools: terminalOnly,
      tool_choice: { kind: 'required_named', toolName: terminalName },
      parallel_tool_calls: false,
      temperature: modelParams.temperature,
      max_tokens: modelParams.maxTokens,
      signal,
      recorder,
    };
  }
  if (tools.length === 0) throw new Error(`Role ${role} requires non-empty tool catalog`);
  return {
    mode: 'tools',
    tools,                                // includes terminal tool for envelope-bearing roles
    tool_choice: { kind: 'auto' },
    parallel_tool_calls: false,
    temperature: modelParams.temperature,
    max_tokens: modelParams.maxTokens,
    signal,
    recorder,
  };
}
```

`phase` enum: `'tools' | 'terminal'`. The `'envelope'` phase does not exist under Proposal L.

### 3.4 Capability axes under Proposal L

Proposal L's capability surface in [src/agents/provider-capabilities.ts](../../../../src/agents/provider-capabilities.ts) has TWO axes only:

```ts
export interface EffectiveProviderCapabilities {
  // …existing axes…
  toolsMode: 'native' | 'unsupported';
  exclusiveToolChoiceSupport: 'native' | 'parallel_off' | 'unsupported';
}

export interface CapabilityRequest {
  // …existing axes…
  mode: 'tools';                           // structural; the only value
  requiresExclusiveToolChoice: boolean;    // true on every role turn in this codebase
}
```

There is NO `envelopeMode` axis under Proposal L. The axis is not added, not retained-unused, and not re-exported. Built-ins at [src/agents/provider-capabilities.ts#L53](../../../../src/agents/provider-capabilities.ts#L53):

- `opencode`, `opencode-go`, `github-copilot`, `nvidia-nim`: `toolsMode: 'native'`, `exclusiveToolChoiceSupport: 'native'`.
- `openai-codex` (Codex Responses): `toolsMode: 'native'`, `exclusiveToolChoiceSupport: 'parallel_off'` (always sends `parallel_tool_calls: false`; the current unconditional `parallel_tool_calls = true` at [src/agents/llm-openai-codex-gateway.ts#L125](../../../../src/agents/llm-openai-codex-gateway.ts#L125) is DELETED).

`capabilityRequestForLlmOptions` at [src/agents/provider-capabilities.ts#L127](../../../../src/agents/provider-capabilities.ts#L127) is rewritten to derive `requiresExclusiveToolChoice: true` for every role invocation and to skip any candidate with `toolsMode: 'unsupported'` or `exclusiveToolChoiceSupport: 'unsupported'`.

### 3.5 Provider-neutral terminal choice — per-provider wire translation

`LlmToolsOptions.tool_choice` is the provider-neutral `TerminalChoice` (§1, §3.1). Each gateway request builder owns the translation to its wire JSON. The shared types NEVER carry a provider-specific tool_choice JSON object.

| `TerminalChoice` value | `buildOpenAIChatRequest` wire JSON | `buildOpenAICodexRequest` wire JSON |
| --- | --- | --- |
| `{ kind: 'auto' }` | `tool_choice: 'auto'` | `tool_choice: 'auto'` |
| `{ kind: 'required_named'; toolName: T }` | `tool_choice: { type: 'function', function: { name: T } }` | `tool_choice: { type: 'function', name: T }` |

**Codex Responses shape rationale.** The Codex Responses transport at [src/agents/llm-openai-codex-gateway.ts#L33](../../../../src/agents/llm-openai-codex-gateway.ts#L33) serializes function tools with a top-level `name` field — `CodexTool` at [src/agents/llm-openai-codex-gateway.ts#L18](../../../../src/agents/llm-openai-codex-gateway.ts#L18) (`{ type: 'function'; name; description; parameters }`), assembled by `codexTool` at [src/agents/llm-openai-codex-gateway.ts#L181-L184](../../../../src/agents/llm-openai-codex-gateway.ts#L181-L184). The function-call history items emitted by `codexMessages` use top-level `name` and `arguments` at [src/agents/llm-openai-codex-gateway.ts#L152](../../../../src/agents/llm-openai-codex-gateway.ts#L152) and the matching `function_call_output` shape — consistent with the OpenAI Responses API surface, which is structurally flat (no nested `function` object). Therefore the function-choice variant on this transport is the flat `{ type: 'function', name }` shape, NOT the chat-completions nested `{ type: 'function', function: { name } }` shape. The current `buildOpenAICodexRequest` line at [src/agents/llm-openai-codex-gateway.ts#L123-L124](../../../../src/agents/llm-openai-codex-gateway.ts#L123-L124) (`body.tool_choice = opts.tool_choice ?? 'auto'`) forwards whatever the options object carries verbatim — which is exactly the leak Proposal L closes by introducing `TerminalChoice` and per-gateway translation.

`buildOpenAIChatRequest` translation (in [src/agents/llm-openai-chat-gateway.ts#L148](../../../../src/agents/llm-openai-chat-gateway.ts#L148)):

```ts
if (opts.tool_choice.kind === 'auto') {
  requestBody.tool_choice = 'auto';
} else {
  requestBody.tool_choice = { type: 'function', function: { name: opts.tool_choice.toolName } };
}
```

`buildOpenAICodexRequest` translation (in [src/agents/llm-openai-codex-gateway.ts#L105](../../../../src/agents/llm-openai-codex-gateway.ts#L105)):

```ts
if (opts.tool_choice.kind === 'auto') {
  body.tool_choice = 'auto';
} else {
  body.tool_choice = { type: 'function', name: opts.tool_choice.toolName };
}
```

Both builders ALSO write `parallel_tool_calls: false` unconditionally on every role turn; the chat builder NEVER forwards `response_format` (the branch at [src/agents/llm-openai-chat-gateway.ts#L186](../../../../src/agents/llm-openai-chat-gateway.ts#L186) is DELETED, and the unconditional `body.parallel_tool_calls = true` at [src/agents/llm-openai-codex-gateway.ts#L125](../../../../src/agents/llm-openai-codex-gateway.ts#L125) is REPLACED with `false`).

§8.1 asserts the two wire shapes SEPARATELY: chat-completions `tool_choice` against the nested object, Codex Responses `tool_choice` against the flat object. The two shapes are NEVER conflated in a single shared assertion.

---

## 4. Exclusive terminal protocol — single-owner adapter validator

The terminal protocol guarantees that an `emit_<role>_result` tool call is the SOLE tool call in its assistant message, that it carries the right role's terminal name, and that prose-only or schema-invalid envelopes fail fast as typed errors. **All six rejection cases are owned by `validateTerminalProtocol`** (no split between adapter and validator).

### 4.1 Request-side knobs

A role invocation has two kinds of turn:

- **Action-eligible turn** — the model may call any action tool, may call the terminal tool to finish, or may emit prose (treated as "done with actions"; runtime escalates to a terminal-only turn).
- **Terminal-only turn** — the runtime exposes ONLY the terminal tool, sets `tool_choice` to `{ kind: 'required_named', toolName: terminalName }`, and rejects any deviation.

Per-provider request shape (after the §3.5 translation):

| Capability axis | `chat`-completions (`opencode`, `opencode-go`, `github-copilot`, `nvidia-nim`) | `openai-codex` (Codex Responses) |
| --- | --- | --- |
| Action-eligible `tool_choice` | `'auto'` | `'auto'` |
| Action-eligible parallelism | `parallel_tool_calls: false` | `parallel_tool_calls: false` (replaces the unconditional `true` at [src/agents/llm-openai-codex-gateway.ts#L125](../../../../src/agents/llm-openai-codex-gateway.ts#L125)) |
| Terminal-only `tool_choice` | `{ type: 'function', function: { name: terminalName } }` | `{ type: 'function', name: terminalName }` |
| Terminal-only `tools[]` | exactly one entry, the terminal tool | same |
| Terminal-only parallelism | `parallel_tool_calls: false` | `parallel_tool_calls: false` |

Request shaping is owned by the gateway request builders ([src/agents/llm-openai-chat-gateway.ts#L148](../../../../src/agents/llm-openai-chat-gateway.ts#L148), [src/agents/llm-openai-codex-gateway.ts#L105](../../../../src/agents/llm-openai-codex-gateway.ts#L105)) that consume `LlmToolsOptions` as built by `buildLlmOptions`.

### 4.2 Response-side validator — ADAPTER owns it; SINGLE owner for all six cases

`validateTerminalProtocol(result, expectations)` lives in the adapter module (new file `src/agents/terminal-protocol.ts`, imported by `AgentAdapter.invokeAgent`). It runs in the adapter loop BEFORE any side-effecting `executeToolCall`, BEFORE any `parseRoleEnvelopeArguments` call, and BEFORE any cast to `kind: 'tools'`. Signature:

```ts
export interface TerminalExpectations {
  role: AgentRole;
  terminalToolName: string | null;          // null for analyst
  mustBeTerminal: boolean;                  // true on terminal-only turns
}
export function validateTerminalProtocol(
  result: LlmCompleteResult,
  expectations: TerminalExpectations,
): void;                                    // throws LlmContractMismatchError on violation
```

The gateway does NOT see `role`, `terminalToolName`, or `mustBeTerminal`. Gateways consume `LlmToolsOptions` and produce `LlmCompleteResult`; they validate wire-shape correctness only (well-formed SSE, well-formed tool_call deltas, well-formed `function.arguments` as a string — see §5). Gateway tests cover wire parsing and request shape; they do not cover role/turn rejection.

**Ordering.** Explicit so the `kind: 'tools'` cast in the adapter is safe:

```ts
// Step 1: mustBeTerminal === true requires kind: 'tools' AND a non-empty calls[] before any calls[0] access.
if (expectations.mustBeTerminal) {
  if (result.kind !== 'tools') throw new LlmContractMismatchError('terminal_prose_only', { role: expectations.role, observedKind: result.kind });
  if (result.calls.length === 0) throw new LlmContractMismatchError('terminal_prose_only', { role: expectations.role, observedKind: 'tools_empty' });
}
// Step 2: only after Step 1 is it safe to inspect result.calls[i].function.name.
// Step 3: name-based checks (duplicate, mixed, wrong_role, missing-on-forced) below.
```

The adapter's pseudocode at §4.5 only casts to `kind: 'tools'` and dereferences `calls[0]` after `validateTerminalProtocol` has returned successfully.

### 4.3 Six named rejection cases — ALL owned by `validateTerminalProtocol`

Each case maps to a distinct `LlmContractMismatchError` subtype. All six classify to `action: 'fail_invocation'`, `markFailed: false`, no cooldown. ALL SIX are raised by `validateTerminalProtocol`; no other site in the adapter rejects on turn-level contract violations.

1. **`terminal_prose_only`** — `mustBeTerminal === true` AND (`result.kind === 'terminal_text'` OR `result.kind === 'tools'` with empty `result.calls`). The forced terminal turn produced no terminal tool call. Covers the case where the model ignores the forced `tool_choice` and replies in prose, or returns an empty tool_calls array.

2. **`terminal_duplicate`** — `result.kind === 'tools'` AND `result.calls.filter(c => c.function.name === expectations.terminalToolName).length > 1`. Two or more terminal calls in one assistant message.

3. **`terminal_mixed_with_actions`** — `result.kind === 'tools'` AND `result.calls.length > 1` AND `result.calls.some(c => c.function.name === expectations.terminalToolName)`. Terminal call mixed with one or more action calls. Covers providers that ignore `parallel_tool_calls: false`.

4. **`terminal_wrong_role`** — `result.kind === 'tools'` AND `result.calls.some(c => OTHER_ROLE_TERMINALS.has(c.function.name))`. The model emitted another role's terminal tool (e.g. executor returned `emit_planner_result`). Includes both action-eligible and terminal-only turns.

5. **`terminal_missing_on_forced_turn`** — `mustBeTerminal === true` AND `result.kind === 'tools'` AND `result.calls.length >= 1` AND `result.calls.every(c => c.function.name !== expectations.terminalToolName)`. The model emitted only normal action tool call(s) on a forced terminal turn — a `tool_choice: { kind: 'required_named' }` violation. This is the only-action-on-forced-terminal-turn case the critique flagged; it is rejected here, by the validator, BEFORE the adapter executes any tool. This case is renamed from r3's `terminal_missing_at_limit` to remove the adapter-loop framing; the `MAX_TOOLS_TURNS` counter is unrelated — the case applies on EVERY forced terminal turn regardless of attempt index.

6. **`terminal_arguments_not_json` / `terminal_arguments_schema_mismatch`** — raised by `parseRoleEnvelopeArguments` (§4.4), which the adapter calls AFTER `validateTerminalProtocol` returns successfully on the terminal call. Listed as one case-family because they share parsing layer ownership; tests in §8 split them.

Note on role-membership: `expectations.role` is consumed by `terminal_wrong_role` to look up `OTHER_ROLE_TERMINALS`. The role enum used by `validateTerminalProtocol` is the same `AgentRole` used throughout `src/agents/`; this is intentionally NOT the narrower `agentRoleSchema` from [src/schemas/event-catalog.ts#L10](../../../../src/schemas/event-catalog.ts#L10) (see §7).

### 4.4 Arguments parse boundary

`parseRoleEnvelopeArguments(role, raw)` runs once per terminal call, inside the adapter, AFTER `validateTerminalProtocol` has confirmed the terminal call is the sole call and is for the right role:

```ts
function parseRoleEnvelopeArguments(role: EnvelopeBearingRole, raw: string): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    throw new LlmContractMismatchError('terminal_arguments_not_json', {
      role, rawPreview: redactedPreview(raw, 200), jsonError: (err as Error).message,
    });
  }
  const validation = ENVELOPE_SCHEMAS[role].safeParse(parsed);
  if (!validation.success) {
    throw new LlmContractMismatchError('terminal_arguments_schema_mismatch', {
      role, issues: validation.error.issues, rawPreview: redactedPreview(raw, 200),
    });
  }
  return validation.data;
}
```

`redactedPreview` reuses `redactProviderErrorText` from [src/agents/llm-codex-parser.ts](../../../../src/agents/llm-codex-parser.ts). The raw text is preserved on the error for the exchange recorder; nothing else writes it to disk.

Action tool calls keep their existing per-tool Zod validation in the tool executor; the new boundary applies only to terminal calls.

### 4.5 Adapter pseudocode (single tools loop)

```ts
// AgentAdapter.invokeAgent — Proposal L body
for (let turn = 0; turn < MAX_TOOLS_TURNS; turn++) {
  const mustBeTerminal = (turn === MAX_TOOLS_TURNS - 1);  // last turn escalates
  const options = buildLlmOptions(role, mustBeTerminal ? 'terminal' : 'tools', tools, modelParams, signal, recorder);
  const terminalToolName = ROLE_RESULT_TOOL_NAMES[role];
  const result = await llmCall(options);                  // returns LlmCompleteResult
  validateTerminalProtocol(result, { role, terminalToolName, mustBeTerminal });
  // After validation: if mustBeTerminal, result.kind === 'tools' and calls[0] is the terminal call.
  if (result.kind === 'terminal_text') return handleAnalystTerminalText(result.text);
  // result.kind === 'tools'
  for (const call of result.calls) appendSessionMessage(serializeToolCallMessage(call));
  const terminalCall = result.calls.find((c) => c.function.name === terminalToolName);
  if (terminalCall) return parseRoleEnvelopeArguments(role, terminalCall.function.arguments);
  // No terminal call → execute action tools and continue.
  for (const call of result.calls) await executeToolCall(call);
  if (turn === MAX_TOOLS_TURNS - 2) /* next iteration sets mustBeTerminal */;
}
```

The escalation to the terminal-only turn happens at `turn === MAX_TOOLS_TURNS - 1`; the validator rejects any non-terminal/empty/wrong-named result on that turn via the six cases above.

---

## 5. Wire-shape correctness

`ToolCall.function.arguments` is a STRING at every layer between SSE and the §4.4 boundary.

- Chat parser at [src/agents/llm-stream-parser.ts#L86](../../../../src/agents/llm-stream-parser.ts#L86) concatenates `tc.function.arguments` deltas; finalization at [src/agents/llm-stream-parser.ts#L100-L113](../../../../src/agents/llm-stream-parser.ts#L100-L113) forwards the value verbatim, no JSON.parse, no schema check.
- Codex parser at [src/agents/llm-codex-parser.ts#L85-L134](../../../../src/agents/llm-codex-parser.ts#L85-L134) uses `response.function_call_arguments.done#arguments` (or delta concatenation), defaulting to `'{}'` only when absent at [src/agents/llm-codex-parser.ts#L131](../../../../src/agents/llm-codex-parser.ts#L131).
- Gateway response handlers return the unparsed string on every `ToolCall` they emit; they NEVER `JSON.parse` argument strings inside the gateway.
- The single parse/validate boundary for terminal arguments is `parseRoleEnvelopeArguments` (§4.4), invoked once by the adapter. Action tool arguments are parsed inside the tool executor per tool.

Tests in §8 assert "function.arguments remains a string at the parser boundary" for both parsers across each rejection case.

---

## 6. Migration inventory (complete)

Every producer and reader of the legacy `{ toolCalls: [...] }` wrapper. Each row says `DELETE` (the source is removed) or `REWRITE` (the source is restructured to call `serializeToolCallMessage` / `parseToolCallMessage`). The new helper pair lives in a new `src/agents/persisted-tool-call.ts` plus a web mirror at `web/src/utils/persistedToolCall.ts` (web bundle cannot import server modules). Both raise `LegacyMessageShapeError` when fed an old wrapper.

### 6.1 Verification grep (run from `/home/salva/g/ml/saivage-v3`)

```bash
grep -rn "toolCalls:" tests/ web/src/__tests__/ web/src/utils/ 2>/dev/null
grep -rn "readToolCallEnvelope\|parsePersistedToolCalls\|parseToolCallsFromResponse" src/ tests/ web/src/ 2>/dev/null
grep -rn "parsePlannerResult\|parseExecutorResult\|parseReviewerResult\|extractJson\|buildExecutorFallbackResult\|ResultParseError" src/ tests/ web/src/ 2>/dev/null
```

Match counts at HEAD: 32 hits for `toolCalls:` across `tests/`, `web/src/__tests__/`, and `web/src/utils/`; every match is itemized in §6.4 or §6.2 below. Capability-table fixtures of the form `capabilities: { toolCalls: 'native' }` are NOT legacy wrappers (they are router/provider tests against the OLD capability axis) and are migrated under §11 of the implementation order as part of the `toolsMode`/`exclusiveToolChoiceSupport` axis swap.

### 6.2 Source producers (write the persisted row)

| Site | Disposition |
| --- | --- |
| [src/agents/agent-adapter.ts#L239](../../../../src/agents/agent-adapter.ts#L239) | REWRITE — one `serializeToolCallMessage(call)` row per call (currently bundles via wrapper). |
| [src/agents/analyst-handler.ts#L300](../../../../src/agents/analyst-handler.ts#L300) | REWRITE — restructure to one row per tool call (currently bundles them into one row). |
| [src/agents/fake-agent.ts#L86](../../../../src/agents/fake-agent.ts#L86) | REWRITE — fixture writer emits single-`ToolCall` rows. |

### 6.3 Source readers (parse the persisted row, or are the deleted parser surface)

| Site | Disposition |
| --- | --- |
| [src/agents/llm-contracts.ts#L60](../../../../src/agents/llm-contracts.ts#L60) `parsePersistedToolCalls` | DELETE — replaced by `parseToolCallMessage` on every caller. |
| [src/agents/llm-openai-chat-gateway.ts#L160](../../../../src/agents/llm-openai-chat-gateway.ts#L160) (`buildOpenAIChatRequest`) | REWRITE — call `parseToolCallMessage` per row; rebuild OpenAI `tool_calls` array from one-call-per-row history. |
| [src/agents/llm-openai-codex-gateway.ts#L130](../../../../src/agents/llm-openai-codex-gateway.ts#L130) (`codexMessages`) | REWRITE — same. |
| [src/agents/session-persistence.ts#L379-L420](../../../../src/agents/session-persistence.ts#L379-L420) (`parseToolCalls` + `findUniqueUnresolvedActivateCardToolCall`) | REWRITE — loop over rows, each row parses to one `ToolCall`. |
| [src/runtime/runtime.ts#L234-L264](../../../../src/runtime/runtime.ts#L234-L264) (`findUnresolvedActivateCards`) | REWRITE — same. |
| [src/agents/analyst-handler.ts#L70-L106](../../../../src/agents/analyst-handler.ts#L70-L106) (`trimToCleanToolBoundary`) | REWRITE — replace inline `JSON.parse` + `.toolCalls?.[]` enumeration with `parseToolCallMessage`. |
| [src/agents/agent-tool-executor.ts#L52-L56](../../../../src/agents/agent-tool-executor.ts#L52-L56) `parseToolCallsFromResponse` | DELETE — under Proposal L the adapter consumes `LlmCompleteResult.calls` directly; the flattened-string parser is dead. |
| [src/agents/agent-adapter.ts#L167](../../../../src/agents/agent-adapter.ts#L167) (`parseToolCallsFromResponse` wrapper re-export) | DELETE — wrapper method around the deleted helper; its only callers are `handleToolCallsLoop`. |
| [src/agents/agent-adapter.ts#L224](../../../../src/agents/agent-adapter.ts#L224) (`handleToolCallsLoop` call to `this.parseToolCallsFromResponse`) | DELETE — entire `handleToolCallsLoop` body is replaced by the §4.5 adapter pseudocode that switches on `LlmCompleteResult.kind`. |
| [web/src/utils/tool-presenters/helpers.ts#L68-L78](../../../../web/src/utils/tool-presenters/helpers.ts#L68-L78) `readToolCallEnvelope` | REWRITE — rename `readToolCallMessage`; return `{ name, args }` from a single `ToolCall` row. |
| [web/src/utils/tool-presenters/registry.ts#L1](../../../../web/src/utils/tool-presenters/registry.ts#L1) (`import { … readToolCallEnvelope … }`) | REWRITE — switch import to `readToolCallMessage`. |
| [web/src/utils/tool-presenters/registry.ts#L21](../../../../web/src/utils/tool-presenters/registry.ts#L21) (`const envelope = readToolCallEnvelope(rawContent, fallbackName);`) | REWRITE — call `readToolCallMessage` instead; rename local `envelope` → `message` to remove the legacy term. |
| [web/src/stores/analystChat.ts#L99-L108](../../../../web/src/stores/analystChat.ts#L99-L108) `toolInvocationMatchesMessage` | REWRITE — compare against a single `ToolCall` per row. |

### 6.4 Test fixtures and helpers — every legacy `toolCalls:` wrapper literal

Verified by the `grep -rn "toolCalls:"` from §6.1. Tests under `tests/agents/` and `web/src/__tests__/` listed below; capability-table `capabilities: { toolCalls: 'native' }` fixtures (in `agent-adapter-recovery.test.ts`, `config-schema.test.ts`, `llm-client-integration.test.ts`, `model-router.test.ts`, `provider.test.ts`) are migrated under §9 step 11 as part of the capability axis swap, NOT here.

| Site | Disposition |
| --- | --- |
| [tests/agents/agent-adapter-force-final-answer.test.ts#L51-L52](../../../../tests/agents/agent-adapter-force-final-answer.test.ts#L51-L52) `toolCallEnvelope()` helper (`return JSON.stringify({ toolCalls: calls });`) | DELETE — `forceFinalAnswer` itself is DELETED (§4.5); the test file is removed wholesale. |
| [tests/utils/runtime-project-planner-control-flow.test.ts#L20-L22](../../../../tests/utils/runtime-project-planner-control-flow.test.ts#L20-L22) `activateToolCallIds` inline `JSON.parse` of wrapper | REWRITE — call `parseToolCallMessage`. |
| [tests/utils/runtime-executor-fallback-evidence.test.ts#L86](../../../../tests/utils/runtime-executor-fallback-evidence.test.ts#L86) `appendMessage(... JSON.stringify({ toolCalls: [...] }))` | REWRITE — append one `serializeToolCallMessage(call)` row. |
| [tests/utils/runtime-executor-fallback-evidence.test.ts#L158](../../../../tests/utils/runtime-executor-fallback-evidence.test.ts#L158) second occurrence of same pattern | REWRITE — same. |
| [tests/agents/session-persistence.test.ts#L328](../../../../tests/agents/session-persistence.test.ts#L328) and [#L337](../../../../tests/agents/session-persistence.test.ts#L337) | REWRITE — fixtures rewritten to one-call-per-row; the legacy-shape round-trip case becomes a `LegacyMessageShapeError` rejection test. |
| [tests/agents/agent-tool-executor.test.ts#L35](../../../../tests/agents/agent-tool-executor.test.ts#L35) `executor().parseToolCallsFromResponse(JSON.stringify({ toolCalls: […] }))` | DELETE — `parseToolCallsFromResponse` is DELETED; the test case is removed. |
| [tests/agents/agent-runtime.test.ts#L140](../../../../tests/agents/agent-runtime.test.ts#L140) and [#L181](../../../../tests/agents/agent-runtime.test.ts#L181) | REWRITE — fixtures rewritten. |
| [tests/agents/codex-deferred-activate-card.test.ts#L71](../../../../tests/agents/codex-deferred-activate-card.test.ts#L71) | REWRITE — fixture rewritten. |
| [tests/agents/agent-adapter-reviewer-prompt.test.ts#L134](../../../../tests/agents/agent-adapter-reviewer-prompt.test.ts#L134) | REWRITE — fixture rewritten. |
| [tests/agents/agent-adapter-load-skill.test.ts#L201](../../../../tests/agents/agent-adapter-load-skill.test.ts#L201), [#L237](../../../../tests/agents/agent-adapter-load-skill.test.ts#L237), [#L253](../../../../tests/agents/agent-adapter-load-skill.test.ts#L253), [#L461](../../../../tests/agents/agent-adapter-load-skill.test.ts#L461) | DELETE/REWRITE — `callParseToolCalls(JSON.stringify({ toolCalls: [] }))` at `#L237` exercises the deleted parser surface and is DELETED; remaining `toolCalls: [` fixtures at `#L201`, `#L253`, `#L461` are rewritten to one-call-per-row rows. |
| [tests/agents/agent-adapter-executor-fallback.test.ts#L53](../../../../tests/agents/agent-adapter-executor-fallback.test.ts#L53) | DELETE — `buildExecutorFallbackResult` is DELETED (§9 step 9); the file is removed. |
| [tests/agents/integration.test.ts#L18-L20](../../../../tests/agents/integration.test.ts#L18-L20) (`let parsePlannerResult: …`, `let parseExecutorResult: …`, `let parseReviewerResult: …` type imports) | DELETE — the imported result-parser surface is DELETED (§9 step 9). |
| [tests/agents/integration.test.ts#L39-L41](../../../../tests/agents/integration.test.ts#L39-L41) (`parsePlannerResult = parserMod.parsePlannerResult; …`) | DELETE — same. |
| [tests/agents/integration.test.ts#L151](../../../../tests/agents/integration.test.ts#L151) (`const parsed = parsePlannerResult(rawResponse);`) | DELETE — the "config → router → parse planner result" case is REWRITTEN to drive an `AgentAdapter.invokeAgent` happy path against a fake gateway that returns a terminal `emit_planner_result` tool call, and to assert the parsed envelope round-trips via `parseRoleEnvelopeArguments`. |
| [tests/agents/integration.test.ts#L183](../../../../tests/agents/integration.test.ts#L183) (`const parsed = parseExecutorResult(rawResponse);`) | DELETE — same rewrite for executor with `emit_executor_result`. |
| [tests/agents/integration.test.ts#L214](../../../../tests/agents/integration.test.ts#L214) (`const parsed = parseReviewerResult(rawResponse);`) | DELETE — same rewrite for reviewer with `emit_reviewer_result`. |
| [web/src/__tests__/analyst-chat-panel.test.ts#L31](../../../../web/src/__tests__/analyst-chat-panel.test.ts#L31) | REWRITE — fixture rewritten to one-call-per-row. |
| [web/src/__tests__/analyst-chat-store.test.ts#L85](../../../../web/src/__tests__/analyst-chat-store.test.ts#L85) | REWRITE — fixture rewritten. |
| [web/src/__tests__/agents-view.test.ts#L72](../../../../web/src/__tests__/agents-view.test.ts#L72) and [#L256](../../../../web/src/__tests__/agents-view.test.ts#L256) | REWRITE — fixtures rewritten. |
| [web/src/__tests__/tool-presenters/_helpers.ts#L4](../../../../web/src/__tests__/tool-presenters/_helpers.ts#L4) | REWRITE — helper emits single-`ToolCall` row strings. |
| `tests/agents/result-parser.test.ts` | DELETE — entire parser surface it covers is DELETED. |

### 6.5 Additional source deletions

`parsePlannerResult`, `parseExecutorResult`, `parseReviewerResult`, `extractJson`, `buildExecutorFallbackResult`, `ResultParseError` at [src/agents/result-parser.ts](../../../../src/agents/result-parser.ts); the `LlmEnvelopeOptions` variant of `LlmCompleteOptions` and `kind: 'envelope'` variant of `LlmCompleteResult` in [src/agents/llm-contracts.ts](../../../../src/agents/llm-contracts.ts); the `response_format` forwarding branch in `buildOpenAIChatRequest` at [src/agents/llm-openai-chat-gateway.ts#L186](../../../../src/agents/llm-openai-chat-gateway.ts#L186); the unconditional `body.parallel_tool_calls = true` at [src/agents/llm-openai-codex-gateway.ts#L125](../../../../src/agents/llm-openai-codex-gateway.ts#L125); `responseFormatHint` throughout the codebase; the `envelopeMode` capability axis (§3.4).

---

## 7. `terminalTool` plumbing — typed surfaces AND emission sites

The terminal-tool name (`emit_planner_result` / `emit_executor_result` / `emit_reviewer_result` / `null`) is a first-class observability axis. It lives on TWO contracts, each with typed surfaces AND emission-site work. Schemas/typed surfaces ALONE are insufficient — the implementation must plumb the value from `LlmToolsOptions` through the recorder into `LlmExchange.attempts[].terminalTool` AND through the adapter into the `invocation_succeeded` event.

### 7.1 Per-attempt on the LLM exchange record (nullable — analyst attempts have no terminal tool)

| Surface | File | Change |
| --- | --- | --- |
| Zod schema (server) | [src/contracts/llm-exchange.ts#L23-L31](../../../../src/contracts/llm-exchange.ts#L23-L31) (`exchangeAttemptSchema`) | Add `terminalTool: z.enum(['emit_planner_result','emit_executor_result','emit_reviewer_result']).nullable()`. NULLABLE because analyst attempts emit `null`. Required field (no `.optional()` — every exchange record must carry the axis explicitly). |
| Web re-export | [web/src/api/contracts.ts#L91-L92](../../../../web/src/api/contracts.ts#L91-L92) (`export { llmExchangeSchema }` / `export type { LlmExchange }`) | No code change — re-export is structural; the typed field flows through. |

### 7.2 `invocation_succeeded.terminal_tool` — three typed surfaces (NON-NULLABLE)

The `invocation_succeeded` event is emitted ONLY for planner/executor/reviewer (analyst uses its existing `analyst_tool_invoked` event; analyst is not a member of `agentRoleSchema` at [src/schemas/event-catalog.ts#L10](../../../../src/schemas/event-catalog.ts#L10) — verified). Therefore the event field's domain is the three envelope-bearing roles, and the schema is NON-NULLABLE. This is consistent across all three surfaces and all tests.

| Surface | File | Change |
| --- | --- | --- |
| Zod registry entry | [src/schemas/event-catalog.ts](../../../../src/schemas/event-catalog.ts) `EventRegistry.invocation_succeeded` | Add `terminal_tool: z.enum(['emit_planner_result','emit_executor_result','emit_reviewer_result'])` (NON-NULLABLE, required). |
| TypeScript interface | [src/schemas/types.ts#L155](../../../../src/schemas/types.ts#L155) `InvocationSucceededEvent` | Add `terminal_tool: 'emit_planner_result' \| 'emit_executor_result' \| 'emit_reviewer_result';` (NON-NULLABLE, required). |
| Standalone Zod validator | [src/schemas/validators.ts#L165](../../../../src/schemas/validators.ts#L165) `invocationSucceededEventSchema` | Extend `passthroughBaseEventSchema.extend({ … })` with the same NON-NULLABLE enum. |

The web bundle does not redefine `InvocationSucceededEvent`; web event consumers either import the server type (via `web/src/api/contracts.ts`) or treat the wire payload as the registry's parsed output. No additional non-derived web surface exists for this event. (Verified by grep: no `InvocationSucceededEvent` redeclaration under `web/`.) The `LlmExchange.attempts[].terminalTool` field remains NULLABLE because the analyst path uses the same exchange recorder; the analyst's `ROLE_RESULT_TOOL_NAMES['analyst']` is `null` (§3.2), so attempts emit `null` and the event is never fired for analyst.

### 7.3 Emission sites — how the value REACHES the typed surfaces

The terminal tool name flows from `buildLlmOptions` (which already knows `ROLE_RESULT_TOOL_NAMES[role]`) into two destinations.

**Recorder pipeline (per attempt).**

| Site | Current shape | Change |
| --- | --- | --- |
| [src/agents/llm-recording.ts#L47-L55](../../../../src/agents/llm-recording.ts#L47-L55) (`LlmRecorderRequest`) | `{ transport; candidate; endpoint; headers; body }` | Add `terminalTool: string \| null`. The chat and Codex gateways populate it from `opts.tool_choice` (when `kind === 'required_named'`) OR from `ROLE_RESULT_TOOL_NAMES[role]` if threaded; under Proposal L the value is `opts.tool_choice.kind === 'required_named' ? opts.tool_choice.toolName : (the role's terminal tool from the catalog of `opts.tools`, found by intersection with `OTHER_ROLE_TERMINALS ∪ {planner,executor,reviewer}` known names)`. For analyst-only-tool turns no terminal tool exists; pass `null`. |
| [src/agents/llm-recording.ts](../../../../src/agents/llm-recording.ts) `beginRecordedExchange` body | Maps `LlmRecorderRequest` → `recorder.beginExchange({ transport, candidate, request })` | Extend to forward `terminalTool` into `BeginExchangeInput`. |
| [src/agents/llm-exchange-recorder.ts#L32-L39](../../../../src/agents/llm-exchange-recorder.ts#L32-L39) (`BeginExchangeInput`) | `{ transport; candidate; request }` | Add `terminalTool: string \| null`. |
| [src/agents/llm-exchange-recorder.ts#L98-L102](../../../../src/agents/llm-exchange-recorder.ts#L98-L102) (attempt construction `const attempt: ExchangeAttempt = { attempt: attemptIndex, startedAt, status: 'in-progress', request: redactedRequest };`) | Missing `terminalTool` | Include `terminalTool: meta.terminalTool` in the literal. |
| Both gateways: [src/agents/llm-openai-chat-gateway.ts#L52](../../../../src/agents/llm-openai-chat-gateway.ts#L52) (`OpenAIChatGateway.complete` body, at the `beginRecordedExchange(opts?.recorder, { … })` call site) AND [src/agents/llm-openai-codex-gateway.ts#L54-L60](../../../../src/agents/llm-openai-codex-gateway.ts#L54-L60) (same on the codex side) | Currently pass `{ transport, candidate, endpoint, headers, body }` | Must additionally pass `terminalTool: deriveTerminalTool(opts)` where `deriveTerminalTool` returns `opts.tool_choice.kind === 'required_named' ? opts.tool_choice.toolName : (the role's terminal in opts.tools, by intersecting names with the ROLE_RESULT_TOOL_NAMES set)`. Under Proposal L `deriveTerminalTool` is a pure function in `src/agents/llm-recording.ts`. |

**`invocation_succeeded` event emission.**

| Site | Current shape | Change |
| --- | --- | --- |
| [src/agents/agent-adapter.ts#L399-L400](../../../../src/agents/agent-adapter.ts#L399-L400) (`this.eventLogger.appendEvent({ kind: 'invocation_succeeded', session_id: session.id, role: …, attempt: …, duration_ms: …, failureClass: …, recoveryAction: … });` and the parallel `eventBus.emit('invocation_succeeded', { … })` on the same path) | Missing `terminal_tool` field | MUST pass `terminal_tool: terminalToolName` where `terminalToolName = ROLE_RESULT_TOOL_NAMES[role]` (NON-NULL for planner/executor/reviewer by definition; the call site only fires for envelope-bearing roles). The validated terminal tool name from `validateTerminalProtocol`'s expectations is the same value. |

The validator's `expectations.terminalToolName` and the event's `terminal_tool` field are the SAME string; the adapter holds the value in a single local variable for the entire turn and reuses it for both the validator call and the event emission.

### 7.4 Analyst role membership decision (kept from r3)

`agentRoleSchema` at [src/schemas/event-catalog.ts#L10](../../../../src/schemas/event-catalog.ts#L10) is `z.enum(['planner','executor','reviewer','manager','researcher','coder','tester','ux','critic'])`. It does NOT include `'analyst'`. Adding `'analyst'` would expand the schema for every event that uses it. The analyst role does NOT emit `invocation_succeeded`; its observability path is the existing `analyst_tool_invoked` event. Therefore `invocation_succeeded.terminal_tool` has the three-role domain only and is NON-NULLABLE; `LlmExchange.attempts[].terminalTool` is NULLABLE because analyst attempts pass `null`.

`agentRoleSchema` is NOT modified.

---

## 8. Test plan

Matrix-driven, parameterized over `{ provider: 'opencode' | 'opencode-go' | 'github-copilot' | 'nvidia-nim' | 'openai-codex' } × { phase: 'tools' | 'terminal' } × { role: 'planner' | 'executor' | 'reviewer' | 'analyst' }`. Tests are split between three layers (gateway request/response, adapter validator, direct consumer); ownership matches §4.2.

### 8.1 Gateway layer — wire-shape and request-shape only; chat and Codex bodies asserted SEPARATELY

`buildOpenAIChatRequest` ([src/agents/llm-openai-chat-gateway.ts#L148](../../../../src/agents/llm-openai-chat-gateway.ts#L148)) and `buildOpenAICodexRequest` ([src/agents/llm-openai-codex-gateway.ts#L105](../../../../src/agents/llm-openai-codex-gateway.ts#L105)) tests, parameterized by every provider × phase × role triple. Assertions per case — split by builder, because the wire JSON shape differs:

Common assertions (BOTH builders, every triple):

- `response_format` is NEVER present in the request body.
- `parallel_tool_calls` is `false` in the request body.

Chat-completions ONLY (provider ∈ {`opencode`, `opencode-go`, `github-copilot`, `nvidia-nim`}):

- On `phase === 'terminal'` for envelope-bearing roles: `tools[].length === 1`, `tools[0].function.name === ROLE_RESULT_TOOL_NAMES[role]`, `tool_choice` is `{ type: 'function', function: { name: ROLE_RESULT_TOOL_NAMES[role] } }` (NESTED `function` object).
- On `phase === 'tools'` for envelope-bearing roles: `tools[]` includes the terminal tool AND `tool_choice === 'auto'`.

Codex Responses ONLY (provider === `openai-codex`):

- On `phase === 'terminal'` for envelope-bearing roles: `tools[].length === 1`, `tools[0].name === ROLE_RESULT_TOOL_NAMES[role]` (FLAT `name`, top-level), `tools[0].parameters` is the role envelope JSON schema, `tool_choice` is `{ type: 'function', name: ROLE_RESULT_TOOL_NAMES[role] }` (FLAT shape, no nested `function`).
- On `phase === 'tools'` for envelope-bearing roles: `tools[]` includes the terminal tool with the flat `name` field AND `tool_choice === 'auto'`.

Universal:

- On `role === 'analyst'`: the terminal tool is NEVER present and `phase === 'terminal'` is never used (by `buildLlmOptions` construction).

The chat-only and Codex-only assertion blocks are in SEPARATE `describe` blocks. A shared helper that asserted both shapes against the same object literal would be a regression of the very bug the §3.5 translation fixes.

Per-gateway response-side tests against fake `fetch` / fake SSE. Each case asserts that `OpenAIChatGateway.complete` / `OpenAICodexGateway.complete` returns the structured `LlmCompleteResult` correctly:

- (a) intermediate action tool call (`finishReason: 'tool_calls'`) → `{ kind: 'tools', calls: [<one call>], rawAssistantText: null|string }`.
- (b) terminal tool call with valid JSON arguments → `{ kind: 'tools', calls: [<terminal call>] }`; `function.arguments` is the unparsed string.
- (c) prose-only response → `{ kind: 'terminal_text', text }`.
- (d) tool_calls + content mixed → `{ kind: 'tools', calls, rawAssistantText: content }` (gateway does NOT raise; the adapter validator decides whether the mix is legal).

Gateway tests DO NOT cover any of the six §4.3 cases. Those are adapter tests (§8.2).

### 8.2 Adapter terminal-protocol validator — `tests/agents/terminal-protocol.test.ts`

New file. One test per case in §4.3. Each test feeds a synthesized `LlmCompleteResult` directly to `validateTerminalProtocol` and asserts the right subtype is raised. **All six cases are validator-direct tests — none rely on adapter-loop integration.**

- `terminal_prose_only__rejects_terminal_text_on_forced_terminal_turn`
- `terminal_prose_only__rejects_empty_tools_array_on_forced_terminal_turn`
- `terminal_duplicate__rejects_two_emit_planner_result_calls`
- `terminal_duplicate__rejects_two_emit_executor_result_calls`
- `terminal_duplicate__rejects_two_emit_reviewer_result_calls`
- `terminal_mixed_with_actions__rejects_emit_planner_plus_create_card`
- `terminal_mixed_with_actions__rejects_emit_executor_plus_update_card`
- `terminal_wrong_role__executor_rejects_emit_planner_result`
- `terminal_wrong_role__planner_rejects_emit_executor_result`
- `terminal_wrong_role__reviewer_rejects_emit_executor_result`
- `terminal_missing_on_forced_turn__rejects_when_only_action_calls_returned` — `mustBeTerminal: true`, `result.kind: 'tools'`, `result.calls: [{ function: { name: 'create_card', … } }]`; asserts `LlmContractMismatchError` subtype `terminal_missing_on_forced_turn` BEFORE any side-effecting tool execution. This replaces r3's `terminal_missing_at_limit` adapter-loop test.
- `terminal_missing_on_forced_turn__rejects_multiple_action_calls_no_terminal` — same with two action calls; ensures the validator catches the case regardless of `calls.length`.

Plus the parse-boundary tests in `tests/agents/parse-role-envelope-arguments.test.ts` (one per envelope-bearing role × per case):

- `terminal_arguments_not_json__rejects_unparseable_arguments` × {planner, executor, reviewer}
- `terminal_arguments_schema_mismatch__rejects_zod_invalid_envelope` × {planner, executor, reviewer}

### 8.3 Adapter happy-path and analyst tests

- `AgentAdapter.invokeAgent` per envelope-bearing role: happy path executes one or more action tool calls, escalates to the terminal-only turn, returns the validated envelope. Assert the session log contains one `serializeToolCallMessage` row per action call and one row for the terminal call. Assert `invocation_succeeded.terminal_tool` is set to the right enum value (`emit_planner_result` / `emit_executor_result` / `emit_reviewer_result`) — verified against the event log and the in-memory event bus.
- `AgentAdapter.invokeAgent` for an action-eligible turn that returns the terminal call directly (no escalation needed) — happy path without forcing; `invocation_succeeded.terminal_tool` still emitted.
- `LlmIntentResolver.chat` + `AnalystHandler.processInbound`: assert the analyst result switches on `kind`, that `LlmExchange.attempts[].terminalTool` is `null` for analyst invocations, that NO `invocation_succeeded` event is emitted for analyst, and that pending-tool matching at [web/src/stores/analystChat.ts#L99-L108](../../../../web/src/stores/analystChat.ts#L99-L108) works on the single-`ToolCall` row shape.
- `tests/agents/agent-adapter-force-final-answer.test.ts` — DELETED. `forceFinalAnswer` is DELETED under Proposal L.

The "action-only output on a forced terminal turn" case is NOT in adapter-loop tests. It lives in §8.2 against `validateTerminalProtocol` directly. The adapter happy-path tests verify only that the validator is called before any tool executor side-effect.

### 8.4 Persistence/runtime consumer tests

- `tests/agents/session-persistence.test.ts` (`findUniqueUnresolvedActivateCardToolCall` at [src/agents/session-persistence.ts#L399-L420](../../../../src/agents/session-persistence.ts#L399-L420)) and `tests/runtime/agent-runtime.test.ts` (`findUnresolvedActivateCards` at [src/runtime/runtime.ts#L234-L264](../../../../src/runtime/runtime.ts#L234-L264)): assert correct enumeration under the single-call-per-row shape; assert `LegacyMessageShapeError` is raised when fed an old wrapper row.
- `tests/utils/runtime-project-planner-control-flow.test.ts` and `tests/utils/runtime-executor-fallback-evidence.test.ts`: rewritten as in §6.4.

### 8.5 Parser tests

- [src/agents/llm-stream-parser.ts](../../../../src/agents/llm-stream-parser.ts) `buildOpenAIChatStreamResult`: existing tests adapt to the new `LlmCompleteResult` return; new test asserts `function.arguments` remains a string at the parser boundary (never JSON.parsed inside the parser) and that streaming-concatenated arguments are preserved verbatim.
- [src/agents/llm-codex-parser.ts](../../../../src/agents/llm-codex-parser.ts) `finalizeCodexToolCall`: same.

### 8.6 Contract-schema tests

- `tests/contracts/llm-exchange.test.ts` — round-trip `terminalTool` for each envelope-bearing role and for `null` (analyst path); assert schema rejects values outside the enum.
- `tests/schemas/event-catalog.test.ts` — round-trip `invocation_succeeded.terminal_tool` for each of the three envelope-bearing role enum values; assert the schema REJECTS `null`; assert the schema REJECTS absence of the field (§7.2 decision: required, non-nullable).
- `tests/schemas/types.test.ts` (or wherever `InvocationSucceededEvent` is exercised) — compile-time assertion via test fixture: a fixture without `terminal_tool` fails to type-check.
- `tests/schemas/validators.test.ts` — `invocationSucceededEventSchema` round-trip for each enum value; rejects `null`; rejects absence.

### 8.7 Recovery policy

- `tests/agents/invocation-recovery-policy.test.ts`: one case per `LlmContractMismatchError` subtype from §4.3 (`terminal_prose_only`, `terminal_duplicate`, `terminal_mixed_with_actions`, `terminal_wrong_role`, `terminal_missing_on_forced_turn`, `terminal_arguments_not_json`, `terminal_arguments_schema_mismatch`), asserting `action: 'fail_invocation'`, `markFailed: false`, no `cooldownMs`.

### 8.8 Web tests

- `web/src/__tests__/tool-presenters.test.ts`: `readToolCallMessage` parses the new single-`ToolCall` row.
- `web/src/__tests__/analystChat.test.ts`: pending-tool matching on the new row shape.
- `web/src/__tests__/llm-exchange-viewer.test.ts`: terminal-tool badge renders per role and is hidden on `null`.
- `web/src/__tests__/event-log.test.ts`: event-log row renders the terminal-tool label for each envelope-bearing role; renders no badge for events without the field (analyst has no such event).
- `web/src/__tests__/agents-view.test.ts`: fixtures rewritten as in §6.4.

### 8.9 Deleted test files / cases

- `tests/agents/result-parser.test.ts` — DELETED in its entirety; the parser surface it covers is DELETED.
- `tests/agents/agent-tool-executor.test.ts` — the `parseToolCallsFromResponse` case is DELETED; remaining cases (if any) keep covering non-deleted methods.
- `tests/agents/agent-adapter-force-final-answer.test.ts` — DELETED (the helper it tests is DELETED).
- `tests/agents/agent-adapter-executor-fallback.test.ts` — DELETED (`buildExecutorFallbackResult` is DELETED).
- `tests/agents/agent-adapter-load-skill.test.ts` — cases that exercise `callParseToolCalls` are DELETED; remaining skill-load cases keep covering non-deleted behaviour.
- `tests/agents/integration.test.ts` — the `parsePlannerResult` / `parseExecutorResult` / `parseReviewerResult` cases are REWRITTEN to drive `AgentAdapter.invokeAgent` against a fake gateway that returns terminal tool calls (§6.4). The result-parser type imports at L18-L20 and the runtime loads at L39-L41 are DELETED.

### 8.10 Live probe (opt-in supplement only)

`scripts/probe-llm-contract.ts` issues one role invocation per configured provider exercising (a) at least one action tool call and (b) the terminal `emit_<role>_result` call. Asserts the envelope parses against the role's Zod schema. Reads `.saivage/saivage.json` only; never `.saivage/auth-profiles.json` or any `apiKey`/`token` field.

---

## 9. Implementation order (single coherent pass, Proposal L)

Strict batched order — each batch leaves the tree compiling against the new contract. No backward-compat shim is introduced between batches.

1. New modules: `src/agents/role-envelope-schemas.ts`, `src/agents/role-result-tools.ts`, `src/agents/persisted-tool-call.ts`, `web/src/utils/persistedToolCall.ts`, `src/agents/terminal-protocol.ts`, `src/agents/llm-options-factory.ts`. No existing imports change yet.
2. Rewrite `LlmCompleteOptions` and `LlmCompleteResult` in [src/agents/llm-contracts.ts](../../../../src/agents/llm-contracts.ts); introduce `TerminalChoice` (§1); delete `parsePersistedToolCalls`. Add `LlmContractMismatchError` (with subtype names per §4.3) and `LegacyMessageShapeError` to [src/agents/llm-errors.ts](../../../../src/agents/llm-errors.ts).
3. Rewrite `buildOpenAIChatRequest` at [src/agents/llm-openai-chat-gateway.ts#L148](../../../../src/agents/llm-openai-chat-gateway.ts#L148) to assert `opts.mode === 'tools'`, never forward `response_format`, always forward `parallel_tool_calls: false`, and translate `opts.tool_choice` per §3.5 (chat nested function-choice shape). Replace `parsePersistedToolCalls(m.content)` at [src/agents/llm-openai-chat-gateway.ts#L160](../../../../src/agents/llm-openai-chat-gateway.ts#L160) with `parseToolCallMessage`. Delete the `if (opts?.response_format)` branch at [src/agents/llm-openai-chat-gateway.ts#L186](../../../../src/agents/llm-openai-chat-gateway.ts#L186).
4. Rewrite `buildOpenAICodexRequest` at [src/agents/llm-openai-codex-gateway.ts#L105](../../../../src/agents/llm-openai-codex-gateway.ts#L105) similarly: translate `opts.tool_choice` per §3.5 (Codex flat function-choice shape, NOT the chat nested shape); replace the unconditional `body.parallel_tool_calls = true` at [src/agents/llm-openai-codex-gateway.ts#L125](../../../../src/agents/llm-openai-codex-gateway.ts#L125) with `parallel_tool_calls: false`; replace `parsePersistedToolCalls` callers in `codexMessages` at [src/agents/llm-openai-codex-gateway.ts#L130](../../../../src/agents/llm-openai-codex-gateway.ts#L130) and [src/agents/llm-openai-codex-gateway.ts#L152](../../../../src/agents/llm-openai-codex-gateway.ts#L152) with `parseToolCallMessage`. Delete the `parsePersistedToolCalls` import at [src/agents/llm-openai-codex-gateway.ts#L5](../../../../src/agents/llm-openai-codex-gateway.ts#L5).
5. Rewrite both gateways' response paths to return the new `LlmCompleteResult` union; delete the flatten line at [src/agents/agent-llm-gateway.ts#L58](../../../../src/agents/agent-llm-gateway.ts#L58).
6. Recorder pipeline (§7.3 emission-site work): in the same commit as the gateway rewrites, (a) add `terminalTool: string | null` to `LlmRecorderRequest` at [src/agents/llm-recording.ts#L47-L55](../../../../src/agents/llm-recording.ts#L47-L55), (b) forward it through `beginRecordedExchange` to `BeginExchangeInput` at [src/agents/llm-exchange-recorder.ts#L32-L39](../../../../src/agents/llm-exchange-recorder.ts#L32-L39), (c) include it in the `ExchangeAttempt` literal at [src/agents/llm-exchange-recorder.ts#L98-L102](../../../../src/agents/llm-exchange-recorder.ts#L98-L102), (d) at both gateway `beginRecordedExchange(opts?.recorder, { … })` call sites compute `terminalTool = deriveTerminalTool(opts)` (pure function in `llm-recording.ts` per §7.3) and pass it through.
7. Rewrite `AgentAdapter.invokeAgent` to the §4.5 single tools loop with action-eligible vs terminal-only escalation. Delete `handleToolCallsLoop` at [src/agents/agent-adapter.ts#L220](../../../../src/agents/agent-adapter.ts#L220), `forceFinalAnswer` at [src/agents/agent-adapter.ts#L213](../../../../src/agents/agent-adapter.ts#L213), the `parseToolCallsFromResponse` wrapper at [src/agents/agent-adapter.ts#L167](../../../../src/agents/agent-adapter.ts#L167), and the toolCalls-in-content recovery branch. Delete `parseToolCallsFromResponse` at [src/agents/agent-tool-executor.ts#L52-L56](../../../../src/agents/agent-tool-executor.ts#L52-L56). Replace inline persisted-row writes with `serializeToolCallMessage`. Use `buildLlmOptions` for both call sites at [src/agents/agent-adapter.ts#L280](../../../../src/agents/agent-adapter.ts#L280) and [src/agents/agent-adapter.ts#L342](../../../../src/agents/agent-adapter.ts#L342). Call `validateTerminalProtocol` before any `executeToolCall` or `calls[0]` cast. At [src/agents/agent-adapter.ts#L399-L400](../../../../src/agents/agent-adapter.ts#L399-L400) (and the parallel `eventBus.emit('invocation_succeeded', …)` on the same path) add `terminal_tool: terminalToolName` to BOTH the event-logger payload and the event-bus payload (§7.3).
8. Rewrite the analyst path: `LlmIntentResolver.chat` at [src/agents/analyst-llm-resolver.ts#L163](../../../../src/agents/analyst-llm-resolver.ts#L163) uses `buildLlmOptions(role, 'tools', …)`; consumer at [src/agents/analyst-llm-resolver.ts#L171](../../../../src/agents/analyst-llm-resolver.ts#L171) switches on `result.kind`; update both `analyst-handler.ts` consumers ([src/agents/analyst-handler.ts#L70-L106](../../../../src/agents/analyst-handler.ts#L70-L106), [src/agents/analyst-handler.ts#L286-L300](../../../../src/agents/analyst-handler.ts#L286-L300)); replace the wrapper write at [src/agents/analyst-handler.ts#L300](../../../../src/agents/analyst-handler.ts#L300) with one `serializeToolCallMessage` row per call. Analyst-path `deriveTerminalTool(opts)` returns `null` (no role-result tool in the catalog).
9. Rewrite `fake-agent.ts` at [src/agents/fake-agent.ts#L86](../../../../src/agents/fake-agent.ts#L86) to emit `serializeToolCallMessage` rows.
10. Delete `extractJson`, `parsePlannerResult`, `parseExecutorResult`, `parseReviewerResult`, `buildExecutorFallbackResult`, `ResultParseError` from [src/agents/result-parser.ts](../../../../src/agents/result-parser.ts). After this step `src/agents/result-parser.ts` either no longer exists or only contains unrelated helpers; if empty, delete the file.
11. Migrate `session-persistence.ts` ([src/agents/session-persistence.ts#L379-L420](../../../../src/agents/session-persistence.ts#L379-L420)), `runtime.ts` ([src/runtime/runtime.ts#L234-L264](../../../../src/runtime/runtime.ts#L234-L264)), the web tool presenter ([web/src/utils/tool-presenters/helpers.ts#L68-L78](../../../../web/src/utils/tool-presenters/helpers.ts#L68-L78)) and the registry ([web/src/utils/tool-presenters/registry.ts#L1](../../../../web/src/utils/tool-presenters/registry.ts#L1), [#L21](../../../../web/src/utils/tool-presenters/registry.ts#L21)) — rename `readToolCallEnvelope` → `readToolCallMessage` in BOTH the helper and the import site in `registry.ts` in the same commit — and the analyst chat store ([web/src/stores/analystChat.ts#L99-L108](../../../../web/src/stores/analystChat.ts#L99-L108)) to `parseToolCallMessage`.
12. Update the capability surface: add `toolsMode` and `exclusiveToolChoiceSupport` axes in [src/agents/provider-capabilities.ts](../../../../src/agents/provider-capabilities.ts); update built-ins at [src/agents/provider-capabilities.ts#L53](../../../../src/agents/provider-capabilities.ts#L53); rewrite `capabilityRequestForLlmOptions` at [src/agents/provider-capabilities.ts#L127](../../../../src/agents/provider-capabilities.ts#L127). The `envelopeMode` axis is NOT added. Migrate every test fixture of the form `capabilities: { toolCalls: 'native' }` in `agent-adapter-recovery.test.ts`, `config-schema.test.ts`, `llm-client-integration.test.ts`, `model-router.test.ts`, `provider.test.ts` to the new axes.
13. Update `InvocationRecoveryPolicy.decideFailure` at [src/agents/invocation-recovery-policy.ts#L120](../../../../src/agents/invocation-recovery-policy.ts#L120) with the `LlmContractMismatchError` branch.
14. Extend the three `terminalTool` typed surfaces in one commit: `exchangeAttemptSchema` at [src/contracts/llm-exchange.ts#L23-L31](../../../../src/contracts/llm-exchange.ts#L23-L31) (nullable), `EventRegistry.invocation_succeeded` in [src/schemas/event-catalog.ts](../../../../src/schemas/event-catalog.ts) (non-nullable), `InvocationSucceededEvent` at [src/schemas/types.ts#L155](../../../../src/schemas/types.ts#L155) (non-nullable), and `invocationSucceededEventSchema` at [src/schemas/validators.ts#L165](../../../../src/schemas/validators.ts#L165) (non-nullable). Update the web LLM-exchange viewer and event-log row to render the badge.
15. Migrate every test/fixture per §6.4, and land the test suite per §8. The `tests/agents/integration.test.ts` rewrites at L18-L20, L39-L41, L151, L183, L214 land in this step alongside the deletion of the result-parser source from step 10.

The sibling-issue plans (F01 option-assembler, F02 / F09 parser deletions, F10 capability axis, F11 flatten / per-turn drift, F08 failure classifier branch) collapse to "delete the old surface and re-implement against the new contract from F05" once this batch lands.

### 9.1 Invariant matrix (Proposal L only)

| # | Invariant | Status under Proposal L |
| --- | --- | --- |
| 1 | Single-carrier per turn | Satisfied — only `LlmToolsOptions` exists; the second variant is structurally absent. |
| 2 | Single-carrier per result | Satisfied — `{ kind: 'tools' } \| { kind: 'terminal_text' }`. |
| 3 | No string-flatten in the gateway | Satisfied — `agent-llm-gateway.ts` returns the structured result directly; flatten line DELETED. |
| 4 | No per-turn option drift | Satisfied — `buildLlmOptions(role, phase, …)` is the only assembler. |
| 5 | Envelope parsed by typed schema, not text heuristics | Satisfied — `parseRoleEnvelopeArguments` is the single boundary; `extractJson` DELETED. |
| 6 | Capability surface admits the new shape | Satisfied by `{ toolsMode, exclusiveToolChoiceSupport }`; `envelopeMode` is structurally absent. |
| 7 | Codex Responses is a first-class participant | Satisfied — `response_format` is never sent on any role turn AND the §3.5 translation produces the FLAT Codex function-choice JSON, not the chat nested shape. |
| 8 | Typed failures; contract mismatch does not cooldown | Satisfied — `LlmContractMismatchError` → `action: 'fail_invocation'`, `markFailed: false`. |
| 9 | No backward-compat shim survives | Satisfied — see §6 (every legacy-wrapper site DELETED or REWRITTEN); `LegacyMessageShapeError` raised on old rows. |
| 10 | Tests cover the matrix AND every direct consumer | Satisfied — §8 covers gateway × adapter × consumer; chat and Codex bodies asserted separately; `result-parser.test.ts` DELETED. |

---

## 10. Recommendation

Proposal L (tools-as-only-result) is the recommendation. It deletes a strictly larger surface than Proposal F (the entire envelope mode, the `extractJson` family, the `envelopeMode` capability axis, the `response_format` forwarding branch, the unconditional `parallel_tool_calls: true`, the `ResultParseError` class, and the chat-shape-leaked `tool_choice` JSON in shared types); it has one request shape and one result variant on the wire instead of two; it gives every wire-level violation a named typed failure with a named rejection test (§4.3, §8.2); the provider-neutral `TerminalChoice` type with per-gateway translation (§3.5) keeps the Codex Responses backend first-class; and it unifies the analyst path and the envelope-bearing roles into a single loop whose only per-role difference is `terminalToolName`.

Per the workspace architecture-first / no-backward-compatibility guideline, Proposal L is the design the guideline points to.
