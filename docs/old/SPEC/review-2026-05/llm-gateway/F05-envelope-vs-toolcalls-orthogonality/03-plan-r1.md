# F05 — Envelope-vs-toolcalls orthogonality (implementation plan)

All file references are workspace-relative to `/home/salva/g/ml/saivage-v3/` and clickable. No backward-compat shim, no feature flag, no envelope-mode fallback. Project guideline: architecture-first; actively delete dead code.

---

## 1. Scope and selected proposal

Implement **Proposal L (tools-as-only-result)**: every envelope-bearing role (`planner` / `executor` / `reviewer`) returns its result as the validated arguments of a single role-specific terminal tool call (`emit_planner_result` / `emit_executor_result` / `emit_reviewer_result`); `analyst` continues tools-only with no terminal tool. `response_format`, the `LlmEnvelopeOptions` variant, the `kind: 'envelope'` result variant, the gateway flatten shim, `parsePersistedToolCalls`, `parseToolCallsFromResponse`, `extractJson` and the entire `result-parser.ts` family, the `envelopeMode` capability axis, the `forceFinalAnswer` adapter helper, the `handleToolCallsLoop` body, and the chat-shape-leaked `tool_choice` JSON in shared types are all deleted in the same coherent pass.

---

## 2. Pre-flight checks

Run from `/home/salva/g/ml/saivage-v3` on a clean checkout of the target branch:

```bash
git status                                   # MUST be clean
git rev-parse --abbrev-ref HEAD              # confirm target branch
git fetch origin && git log --oneline -5     # confirm head
npm ci                                       # deterministic install
npm run build                                # baseline build green
npx tsc --noEmit                             # baseline typecheck green
npm test -- --run                            # baseline tests green
grep -rn "toolCalls:" tests/ web/src/__tests__/ web/src/utils/ 2>/dev/null | wc -l   # baseline: 32 (per design §6.1)
grep -rn "response_format\|extractJson\|parsePersistedToolCalls\|parseToolCallsFromResponse\|envelopeMode\|forceFinalAnswer\|handleToolCallsLoop\|ResultParseError\|buildExecutorFallbackResult\|parsePlannerResult\|parseExecutorResult\|parseReviewerResult" src/ web/src/ tests/ 2>/dev/null | wc -l   # baseline counter for the "everything is gone" check after batch (k)
```

Live-probe target (only after batch k passes): `saivage-v3` LXC container at `10.0.3.112:8080`, service `saivage.service`. Pre-flight: `curl -fsS http://10.0.3.112:8080/health`.

Editor reset: if any Vue SFC was open during prior session, run `workbench.action.files.saveAll` and `grep -c '<script setup>' web/src/**/*.vue` to detect duplicated blocks before any web edit.

---

## 3. Implementation batches

Twelve batches, labelled (a)–(l), in the design §9 order. Each batch is one commit. Tree compiles at the end of every batch. Each batch lists files, the concrete change (or precise text instruction), the validation step(s), and a commit message.

### Batch (a) — Substrate: types, factory, error class, persisted-row helpers

Goal: introduce the new typed surfaces and helper modules. Old surfaces remain referenced so the tree still compiles at the boundary; old `LlmCompleteOptions` / `LlmCompleteResult` are REWRITTEN in place (no parallel "v2" name).

**Files created**

- [src/agents/role-envelope-schemas.ts](../../../../src/agents/role-envelope-schemas.ts) — re-exports the per-role Zod schemas (`PlannerResultSchema`, `ExecutorResultSchema`, `ReviewerResultSchema`) from their current homes (`src/agents/result-parser.ts` until batch (h)); after (h) the schemas live here outright. Also exports `ENVELOPE_SCHEMAS: Record<EnvelopeBearingRole, ZodSchema>` and `type EnvelopeBearingRole = 'planner' | 'executor' | 'reviewer'`.
- [src/agents/role-result-tools.ts](../../../../src/agents/role-result-tools.ts) — defines `EMIT_PLANNER_RESULT`, `EMIT_EXECUTOR_RESULT`, `EMIT_REVIEWER_RESULT` as `ToolDefinition`s (function-shape with `parameters: zodToJsonSchema(<role>ResultSchema)`); exports `ROLE_RESULT_TOOL_NAMES: Record<AgentRole, string | null>` (`{ planner: 'emit_planner_result', executor: 'emit_executor_result', reviewer: 'emit_reviewer_result', analyst: null }`) and `OTHER_ROLE_TERMINALS: Set<string>` derived from the same map.
- [src/agents/persisted-tool-call.ts](../../../../src/agents/persisted-tool-call.ts) — exports `serializeToolCallMessage(call: ToolCall): string` (`JSON.stringify(call)`), `parseToolCallMessage(content: string): ToolCall` (parses + Zod-validates; raises `LegacyMessageShapeError` when the content has a `.toolCalls` array — i.e. the legacy wrapper shape).
- [web/src/utils/persistedToolCall.ts](../../../../web/src/utils/persistedToolCall.ts) — server-free mirror of the same surface (web bundle cannot import server modules).
- [src/agents/terminal-protocol.ts](../../../../src/agents/terminal-protocol.ts) — `validateTerminalProtocol(result, expectations)` per design §4.2/§4.3; raises `LlmContractMismatchError` with the six named subtypes (`terminal_prose_only`, `terminal_duplicate`, `terminal_mixed_with_actions`, `terminal_wrong_role`, `terminal_missing_on_forced_turn`, `terminal_arguments_*` are raised by §4.4's parser, NOT this module). Also exports `parseRoleEnvelopeArguments(role, raw)` per design §4.4.
- [src/agents/llm-options-factory.ts](../../../../src/agents/llm-options-factory.ts) — `buildLlmOptions(role, phase: 'tools'|'terminal', tools, modelParams, signal, recorder): LlmCompleteOptions` per design §3.3. Throws on `phase === 'terminal'` with a `null` terminal-tool name.

**Files modified**

- [src/agents/llm-contracts.ts](../../../../src/agents/llm-contracts.ts) — REPLACE the current `LlmCompleteResult` interface (currently `{ content; toolCalls; finishReason }`) with the discriminated union `{ kind: 'tools'; calls: ToolCall[]; rawAssistantText: string | null } | { kind: 'terminal_text'; text: string }`. REPLACE the current `LlmCompleteOptions` interface with `LlmToolsOptions extends LlmCommonOptions { mode: 'tools'; tools: ToolDefinition[]; tool_choice: TerminalChoice; parallel_tool_calls: false }` plus `export type LlmCompleteOptions = LlmToolsOptions`. ADD `export type TerminalChoice = { kind: 'auto' } | { kind: 'required_named'; toolName: string }`. CHANGE `LlmCallFn`'s return type from `Promise<string>` to `Promise<LlmCompleteResult>`. CHANGE `LlmInvocationClient.complete` signature's `opts` type to required `LlmCompleteOptions`. DELETE `parsePersistedToolCalls`.
- [src/agents/llm-errors.ts](../../../../src/agents/llm-errors.ts) — ADD `class LlmContractMismatchError extends Error` with a typed `subtype: 'terminal_prose_only' | 'terminal_duplicate' | 'terminal_mixed_with_actions' | 'terminal_wrong_role' | 'terminal_missing_on_forced_turn' | 'terminal_arguments_not_json' | 'terminal_arguments_schema_mismatch'` field and a `details: Record<string, unknown>` field. ADD `class LegacyMessageShapeError extends Error` for legacy persisted-row reads.

**Concrete change snippet (`llm-contracts.ts` core types)**

```ts
export type TerminalChoice =
  | { kind: 'auto' }
  | { kind: 'required_named'; toolName: string };

export interface LlmCommonOptions {
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  signal?: AbortSignal;
  recorder?: LlmExchangeRecorder;
}

export interface LlmToolsOptions extends LlmCommonOptions {
  mode: 'tools';
  tools: ToolDefinition[];                 // never empty
  tool_choice: TerminalChoice;
  parallel_tool_calls: false;
}

export type LlmCompleteOptions = LlmToolsOptions;

export type LlmCompleteResult =
  | { kind: 'tools'; calls: ToolCall[]; rawAssistantText: string | null }
  | { kind: 'terminal_text'; text: string };
```

**Validation**

- `npx tsc --noEmit` — expect failures ONLY in the call sites the later batches own (gateways, adapter, analyst, persistence). The new modules themselves typecheck.
- `npm test -- --run tests/agents/persisted-tool-call.test.ts` — new test file (added in this batch) covers `serializeToolCallMessage` round-trip and `LegacyMessageShapeError` on wrapper input.
- `npm test -- --run tests/agents/terminal-protocol.test.ts` — new test file (added in this batch) covers the four name-based rejection cases that do not need a fake gateway (`terminal_duplicate`, `terminal_mixed_with_actions`, `terminal_wrong_role`, `terminal_missing_on_forced_turn`) and `terminal_prose_only` (both `terminal_text` and empty-tools variants).
- `npm test -- --run tests/agents/parse-role-envelope-arguments.test.ts` — new test file (added in this batch) covers `terminal_arguments_not_json` and `terminal_arguments_schema_mismatch` for all three envelope-bearing roles.

Tree-compile note: This batch BREAKS the build for sites that consume the old `LlmCompleteResult.content` / `LlmCompleteOptions.response_format` / `LlmCompleteOptions.tool_choice` shapes; batches (c)–(g) fix those sites. To keep the batch independently committable, ALL of the call-site fixes ride in their own batch and the substrate batch is committed as a typecheck-only-of-new-modules deliverable. Tests for new modules run in isolation via `vitest --run <path>`. Full `npx tsc --noEmit` green is recovered at the end of batch (g).

> Caveat: batches (a) through (g) are interdependent and only restore `npx tsc --noEmit` together. Each batch is still a self-contained commit (single logical change, atomic revert per §5). The "tree compiles per batch" guarantee resumes from batch (h) onward.

**Commit message**

```
F05: introduce typed substrate, terminal-protocol validator, persisted-row helpers
```

---

### Batch (b) — Terminal-protocol validator + types wiring

Goal: place `validateTerminalProtocol` and `parseRoleEnvelopeArguments` in the import graph of `agent-adapter.ts` and `analyst-llm-resolver.ts` (still unused at runtime), plus extend `InvocationRecoveryPolicy.decideFailure` for `LlmContractMismatchError`.

**Files modified**

- [src/agents/invocation-recovery-policy.ts](../../../../src/agents/invocation-recovery-policy.ts) at line 120 — ADD a branch for `error instanceof LlmContractMismatchError` returning `{ action: 'fail_invocation', markFailed: false, appendModelIssue: true, abort: true, cooldownMs: 0 }`. All seven subtypes share this branch (per design §4.3 and §8.7).
- [src/agents/agent-adapter.ts](../../../../src/agents/agent-adapter.ts) — ADD imports for `validateTerminalProtocol`, `parseRoleEnvelopeArguments`, `LlmContractMismatchError`, `buildLlmOptions`, `ROLE_RESULT_TOOL_NAMES`. No code change to method bodies yet.
- [src/agents/analyst-llm-resolver.ts](../../../../src/agents/analyst-llm-resolver.ts) — ADD imports for `buildLlmOptions` and `ROLE_RESULT_TOOL_NAMES`. No code change to method bodies yet.

**Files created**

- [tests/agents/invocation-recovery-policy-contract-mismatch.test.ts](../../../../tests/agents/invocation-recovery-policy-contract-mismatch.test.ts) — one test per subtype asserts the classifier returns the branch above.

**Validation**

- `npx tsc --noEmit` — same failures as batch (a) (call sites still on old shape); new imports themselves typecheck.
- `npm test -- --run tests/agents/invocation-recovery-policy-contract-mismatch.test.ts` — green.

**Commit**

```
F05: classify LlmContractMismatchError as fail_invocation without cooldown
```

---

### Batch (c) — Gateway request builders (chat + Codex per-provider translations)

Goal: rewrite `buildOpenAIChatRequest` and `buildOpenAICodexRequest` to consume `LlmToolsOptions`, translate `TerminalChoice` per design §3.5, always set `parallel_tool_calls: false`, never forward `response_format`.

**Files modified**

- [src/agents/llm-openai-chat-gateway.ts](../../../../src/agents/llm-openai-chat-gateway.ts) at lines 148–198 (`buildOpenAIChatRequest`):
  - DELETE the `if (opts?.response_format)` branch at line 186.
  - REPLACE `tool_choice` forwarding with the §3.5 chat translation:
    ```ts
    requestBody.tool_choice = opts.tool_choice.kind === 'auto'
      ? 'auto'
      : { type: 'function', function: { name: opts.tool_choice.toolName } };
    ```
  - ADD `requestBody.parallel_tool_calls = false` unconditionally on every role turn.
  - Tighten the function signature: `opts: LlmCompleteOptions` (required) instead of `opts?: LlmCompleteOptions`.
- [src/agents/llm-openai-codex-gateway.ts](../../../../src/agents/llm-openai-codex-gateway.ts) at lines 105–127 (`buildOpenAICodexRequest`):
  - REPLACE the body assembly inside `if (opts?.tools && opts.tools.length > 0)` so it always runs (the new contract requires non-empty tools):
    ```ts
    body.tools = opts.tools.map(codexTool);
    body.tool_choice = opts.tool_choice.kind === 'auto'
      ? 'auto'
      : { type: 'function', name: opts.tool_choice.toolName };   // FLAT shape, not nested
    body.parallel_tool_calls = false;                             // replaces the unconditional `true` at line 125
    ```
  - Tighten the signature: `opts: LlmCompleteOptions` (required).
- [src/agents/llm-openai-codex-gateway.ts#L5](../../../../src/agents/llm-openai-codex-gateway.ts#L5) — DELETE the `parsePersistedToolCalls` import (it is moved off in batch (d)).

**Files created**

- [tests/agents/llm-openai-chat-gateway-request.test.ts](../../../../tests/agents/llm-openai-chat-gateway-request.test.ts) — chat-only request-shape assertions per design §8.1: `response_format` absent, `parallel_tool_calls: false`, terminal-phase `tool_choice` nested function shape with correct role name.
- [tests/agents/llm-openai-codex-gateway-request.test.ts](../../../../tests/agents/llm-openai-codex-gateway-request.test.ts) — Codex-only request-shape assertions per design §8.1: `tool_choice` flat function shape (`{ type: 'function', name }`, no nested `function` object), `parallel_tool_calls: false`, `tools[].name` flat on each tool.

**Validation**

- `npx tsc --noEmit` — gateway sites compile; adapter sites still broken (fixed in (e)).
- `npm test -- --run tests/agents/llm-openai-chat-gateway-request.test.ts tests/agents/llm-openai-codex-gateway-request.test.ts` — green.
- Manual grep `grep -n "response_format" src/agents/llm-openai-chat-gateway.ts` → no hits.
- Manual grep `grep -n "parallel_tool_calls" src/agents/llm-openai-codex-gateway.ts` → only `false`.

**Commit**

```
F05: translate TerminalChoice per provider; remove response_format and parallel_tool_calls=true
```

---

### Batch (d) — Gateway response shape + remove legacy wrappers

Goal: rewrite both gateways' response paths to return the new `LlmCompleteResult` union; delete the flatten line in `agent-llm-gateway.ts`; replace `parsePersistedToolCalls` callers in `codexMessages` and `buildOpenAIChatRequest` message rebuilding with `parseToolCallMessage`.

**Files modified**

- [src/agents/llm-openai-chat-gateway.ts](../../../../src/agents/llm-openai-chat-gateway.ts) at `OpenAIChatGateway.complete` body — REWRITE the SSE accumulator finalization to construct `LlmCompleteResult` directly: if any tool_call deltas arrived → `{ kind: 'tools', calls, rawAssistantText: contentBuffer || null }`; else `{ kind: 'terminal_text', text: contentBuffer }`. Remove any code path that returns the old `{ content, toolCalls, finishReason }` literal.
- [src/agents/llm-openai-chat-gateway.ts#L160](../../../../src/agents/llm-openai-chat-gateway.ts#L160) — REPLACE `parsePersistedToolCalls(m.content)` with a loop that calls `parseToolCallMessage(m.content)` per persisted assistant-tool_call row (the rows are now one-call-per-row by the new persistence contract; the OpenAI `tool_calls` array is rebuilt by collecting consecutive such rows).
- [src/agents/llm-openai-codex-gateway.ts](../../../../src/agents/llm-openai-codex-gateway.ts) at `OpenAICodexGateway.complete` body — same rewrite to return the new union.
- [src/agents/llm-openai-codex-gateway.ts#L130](../../../../src/agents/llm-openai-codex-gateway.ts#L130) and [#L152](../../../../src/agents/llm-openai-codex-gateway.ts#L152) (`codexMessages`) — REPLACE the two `parsePersistedToolCalls(message.content)` calls with `[parseToolCallMessage(message.content)]` (each row carries exactly one call).
- [src/agents/llm-stream-parser.ts](../../../../src/agents/llm-stream-parser.ts) `buildOpenAIChatStreamResult` — change the return type to `LlmCompleteResult` (per design §3.1); finalization at lines 100–113 emits the union variant chosen by `tool_calls`-vs-content presence. `function.arguments` remains a raw string (no `JSON.parse`).
- [src/agents/llm-codex-parser.ts](../../../../src/agents/llm-codex-parser.ts) `finalizeCodexToolCall` and any sibling finalizer — same return-type change. The `'{}'` default at line 131 is preserved (it is the wire-level "no arguments present" default, not a wrapper).
- [src/agents/agent-llm-gateway.ts#L48-L66](../../../../src/agents/agent-llm-gateway.ts#L48-L66) `createLlmCallFn` — DELETE the flatten line `return result.content ?? JSON.stringify({ toolCalls: result.toolCalls });` at L58 and change the return type from `Promise<string>` to `Promise<LlmCompleteResult>`. The body becomes `const result = await client.complete(...); return result;`.

**Files created**

- [tests/agents/llm-openai-chat-gateway-response.test.ts](../../../../tests/agents/llm-openai-chat-gateway-response.test.ts) — response-shape per design §8.1(a)(b)(c)(d): action tool call only → `kind: 'tools'`; terminal tool call (`emit_planner_result` etc.) with valid JSON args → `kind: 'tools'` with unparsed string arguments; prose-only → `kind: 'terminal_text'`; mixed → `kind: 'tools'` with `rawAssistantText: <content>`.
- [tests/agents/llm-openai-codex-gateway-response.test.ts](../../../../tests/agents/llm-openai-codex-gateway-response.test.ts) — same four cases against the Codex SSE shape.
- [tests/agents/llm-stream-parser.test.ts](../../../../tests/agents/llm-stream-parser.test.ts) — extend (or rewrite) the existing tests for the new return type; assert `function.arguments` remains a string after streaming concatenation.
- [tests/agents/llm-codex-parser.test.ts](../../../../tests/agents/llm-codex-parser.test.ts) — same for Codex.

**Validation**

- `npx tsc --noEmit` — gateways and parsers compile; adapter / analyst still broken (fixed in (e)+(f)).
- `npm test -- --run tests/agents/llm-openai-chat-gateway-response.test.ts tests/agents/llm-openai-codex-gateway-response.test.ts tests/agents/llm-stream-parser.test.ts tests/agents/llm-codex-parser.test.ts` — green.
- Manual grep `grep -n "parsePersistedToolCalls\|content ?? JSON.stringify" src/agents/` → no hits.

**Commit**

```
F05: return LlmCompleteResult union from gateways; delete flatten shim and parsePersistedToolCalls
```

---

### Batch (e) — Adapter integration + delete `parseToolCallsFromResponse`

Goal: rewrite `AgentAdapter.invokeAgent` to the design §4.5 single tools loop; delete `handleToolCallsLoop`, `forceFinalAnswer`, the `parseToolCallsFromResponse` wrapper, and the executor-side helper. Persist one row per tool call via `serializeToolCallMessage`. Call `validateTerminalProtocol` before any `executeToolCall`.

**Files modified**

- [src/agents/agent-adapter.ts](../../../../src/agents/agent-adapter.ts):
  - REPLACE the body of `invokeAgent` (currently the `handleToolCallsLoop` setup + `forceFinalAnswer` fallback) with the §4.5 pseudocode. The body uses `buildLlmOptions(role, mustBeTerminal ? 'terminal' : 'tools', tools, modelParams, signal, recorder)` for every turn (replaces both inline `LlmCompleteOptions` literals at L280 and L342).
  - DELETE `handleToolCallsLoop` (at L220) entirely.
  - DELETE `forceFinalAnswer` (at L213) entirely.
  - DELETE the `parseToolCallsFromResponse` wrapper (at L167).
  - DELETE the toolCalls-in-content recovery branch (the code path that re-parses synthesised wrapper strings).
  - At L239 the persisted-row write becomes a `for` loop: `for (const call of result.calls) appendSessionMessage(serializeToolCallMessage(call));` — one row per call, not one bundled row.
  - At L399–L400 (event emission), the `invocation_succeeded` payload sent to BOTH `this.eventLogger.appendEvent(...)` and `eventBus.emit('invocation_succeeded', ...)` MUST include `terminal_tool: ROLE_RESULT_TOOL_NAMES[role]` (always non-null for planner/executor/reviewer; the event is never emitted for analyst per design §7.4).
- [src/agents/agent-tool-executor.ts](../../../../src/agents/agent-tool-executor.ts) at L45 (`buildToolsForRole`) — APPEND the role-specific terminal tool (`EMIT_PLANNER_RESULT` / `EMIT_EXECUTOR_RESULT` / `EMIT_REVIEWER_RESULT`) for envelope-bearing roles; no terminal tool for analyst.
- [src/agents/agent-tool-executor.ts#L52-L56](../../../../src/agents/agent-tool-executor.ts#L52-L56) — DELETE `parseToolCallsFromResponse`.
- [src/agents/agent-tool-catalog.ts#L77](../../../../src/agents/agent-tool-catalog.ts#L77) (`ROLE_TOOL_NAMES`) — extend each envelope-bearing role's entry to include its terminal tool name.

**Files deleted** (none yet — the test files for the deleted helpers are deleted in batch (k)).

**Validation**

- `npx tsc --noEmit` — adapter compiles; analyst still broken (fixed in (f)).
- Existing tests under `tests/agents/` for `invokeAgent` happy paths now exercise the new loop. Some fail because their fakes return the old shape; those are rewritten in batch (k). Run instead the new dedicated tests (added in (k)).
- Manual grep `grep -rn "handleToolCallsLoop\|forceFinalAnswer\|parseToolCallsFromResponse" src/` → no hits.

**Commit**

```
F05: collapse invokeAgent into single tools loop with terminal-protocol validator
```

---

### Batch (f) — Analyst path migration

Goal: rewrite `LlmIntentResolver.chat` and `AnalystHandler.processInbound` to consume the new `LlmCompleteResult` union; replace the wrapper write at `analyst-handler.ts` line 300 with one row per call; restore tree-wide compile.

**Files modified**

- [src/agents/analyst-llm-resolver.ts](../../../../src/agents/analyst-llm-resolver.ts):
  - At L163 — REPLACE the inline `{ tools, tool_choice: 'auto', stream: false, … }` literal with `buildLlmOptions('analyst', 'tools', tools, modelParams, signal, recorder)` (analyst never escalates to `terminal` phase; the factory throws on `terminal` for a role whose `ROLE_RESULT_TOOL_NAMES[role]` is `null`).
  - At L171 — REPLACE `result.toolCalls` iteration with a `switch (result.kind)` that handles `'tools'` (iterate `result.calls`, call `RoleToolPolicy.assertAnalystSurfaceTool` per call) and `'terminal_text'` (the prose-reply case).
  - At L179 — REPLACE the return shape `{ content: result.content ?? '', toolCalls: result.toolCalls }` with the typed union itself (the method's signature changes to `Promise<LlmCompleteResult>`).
  - At L204 — `capabilityRequestForLlmOptions` consumes the new shape (no `responseShape` axis touched here — that's batch (i)).
- [src/agents/analyst-handler.ts](../../../../src/agents/analyst-handler.ts):
  - At L70–L106 (`trimToCleanToolBoundary`) — REPLACE the inline `JSON.parse(content)` + `.toolCalls?.[]` enumeration with `parseToolCallMessage(content)` per persisted row.
  - At L286–L300 — REWRITE to consume the new `LlmCompleteResult` union returned by `LlmIntentResolver.chat`; on `'tools'` iterate `calls`, on `'terminal_text'` use `text` as the assistant reply.
  - At L300 — REPLACE the wrapper write `appendMessage({ … content: JSON.stringify({ toolCalls: [...] }) })` with one `serializeToolCallMessage(call)` row per call.
- [src/agents/fake-agent.ts#L86](../../../../src/agents/fake-agent.ts#L86) — REWRITE the fixture writer to emit one `serializeToolCallMessage(call)` row per call.

**Validation**

- `npx tsc --noEmit` — green tree-wide.
- `npm run build` — green.
- `npm test -- --run tests/agents/analyst-llm-resolver.test.ts tests/agents/analyst-handler.test.ts` — fixtures rewritten in batch (k); for now run the smoke set: `npm test -- --run tests/agents/persisted-tool-call.test.ts tests/agents/terminal-protocol.test.ts tests/agents/parse-role-envelope-arguments.test.ts`.

**Commit**

```
F05: switch analyst path to LlmCompleteResult union; one-row-per-toolcall persistence
```

---

### Batch (g) — Recorder + emission plumbing for `terminalTool`

Goal: plumb the terminal-tool name from `LlmToolsOptions` through the recorder into `LlmExchange.attempts[].terminalTool` AND extend the `invocation_succeeded` event with `terminal_tool` (already added at the emission site in batch (e); this batch adds the typed surface).

**Files modified**

- [src/agents/llm-recording.ts](../../../../src/agents/llm-recording.ts) at L47–L55 (`LlmRecorderRequest`) — ADD `terminalTool: string | null`. ADD the pure function `deriveTerminalTool(opts: LlmCompleteOptions): string | null` returning `opts.tool_choice.kind === 'required_named' ? opts.tool_choice.toolName : (opts.tools.find(t => OTHER_ROLE_TERMINALS.has(t.function.name) || ROLE_RESULT_TOOL_NAMES_VALUES.has(t.function.name))?.function.name ?? null)`. Forward `terminalTool` through `beginRecordedExchange` into `BeginExchangeInput`.
- [src/agents/llm-exchange-recorder.ts](../../../../src/agents/llm-exchange-recorder.ts) at L32–L39 (`BeginExchangeInput`) — ADD `terminalTool: string | null`.
- [src/agents/llm-exchange-recorder.ts#L98-L102](../../../../src/agents/llm-exchange-recorder.ts#L98-L102) — INCLUDE `terminalTool: meta.terminalTool` in the `attempt: ExchangeAttempt` literal.
- [src/agents/llm-openai-chat-gateway.ts#L52](../../../../src/agents/llm-openai-chat-gateway.ts#L52) and [src/agents/llm-openai-codex-gateway.ts#L54-L60](../../../../src/agents/llm-openai-codex-gateway.ts#L54-L60) — at both `beginRecordedExchange(opts?.recorder, { … })` call sites, ADD `terminalTool: deriveTerminalTool(opts)`.
- [src/contracts/llm-exchange.ts#L23-L31](../../../../src/contracts/llm-exchange.ts#L23-L31) (`exchangeAttemptSchema`) — ADD `terminalTool: z.enum(['emit_planner_result','emit_executor_result','emit_reviewer_result']).nullable()` (required field — no `.optional()`).
- [src/schemas/event-catalog.ts](../../../../src/schemas/event-catalog.ts) `EventRegistry.invocation_succeeded` — ADD `terminal_tool: z.enum(['emit_planner_result','emit_executor_result','emit_reviewer_result'])` (NON-NULLABLE, REQUIRED).
- [src/schemas/types.ts#L155](../../../../src/schemas/types.ts#L155) `InvocationSucceededEvent` — ADD `terminal_tool: 'emit_planner_result' | 'emit_executor_result' | 'emit_reviewer_result';` (non-optional).
- [src/schemas/validators.ts#L165](../../../../src/schemas/validators.ts#L165) `invocationSucceededEventSchema` — extend `.extend({ ... })` with the same enum.

**Files created**

- [tests/contracts/llm-exchange-terminal-tool.test.ts](../../../../tests/contracts/llm-exchange-terminal-tool.test.ts) — round-trip each enum value AND `null`; assert rejection of off-enum strings.
- [tests/schemas/event-catalog-terminal-tool.test.ts](../../../../tests/schemas/event-catalog-terminal-tool.test.ts) — round-trip each enum value; assert schema REJECTS `null`; assert schema REJECTS missing field.
- [tests/schemas/validators-terminal-tool.test.ts](../../../../tests/schemas/validators-terminal-tool.test.ts) — same for `invocationSucceededEventSchema`.
- [tests/schemas/types-terminal-tool.test.ts](../../../../tests/schemas/types-terminal-tool.test.ts) — compile-time assertion: a fixture without `terminal_tool` fails to type-check (use `@ts-expect-error`).

**Validation**

- `npx tsc --noEmit` — green.
- `npm test -- --run tests/contracts/llm-exchange-terminal-tool.test.ts tests/schemas/event-catalog-terminal-tool.test.ts tests/schemas/validators-terminal-tool.test.ts tests/schemas/types-terminal-tool.test.ts` — green.

**Commit**

```
F05: plumb terminalTool through recorder, exchange schema, and invocation_succeeded event
```

---

### Batch (h) — `extractJson` and `result-parser.test.ts` deletion

Goal: delete the entire result-parser surface and its tests. The Zod schemas it owned are now in `role-envelope-schemas.ts` (batch (a)).

**Files modified**

- [src/agents/result-parser.ts](../../../../src/agents/result-parser.ts) — DELETE `extractJson` (L278–L292+), `parsePlannerResult`, `parseExecutorResult`, `parseReviewerResult`, `buildExecutorFallbackResult`, `ResultParseError`, and the Zod schemas (already relocated). If the file becomes empty, DELETE the file outright; otherwise keep only the unrelated helpers that remain.
- [src/agents/role-envelope-schemas.ts](../../../../src/agents/role-envelope-schemas.ts) — once `result-parser.ts` no longer holds the schemas, MOVE the schema definitions in-place (the re-export from batch (a) becomes a direct definition).

**Files deleted**

- [tests/agents/result-parser.test.ts](../../../../tests/agents/result-parser.test.ts) — DELETE outright. The parser surface it covers no longer exists.

**Validation**

- `npx tsc --noEmit` — green (after batch (k) rewrites `tests/agents/integration.test.ts`; for now the integration test still imports `parsePlannerResult` — relocate the deletion of those imports into the same commit as this batch to keep typecheck green).
- Manual grep `grep -rn "extractJson\|parsePlannerResult\|parseExecutorResult\|parseReviewerResult\|ResultParseError\|buildExecutorFallbackResult" src/ tests/` → no hits except the integration-test rewrite, which is done in (k).

> Coupling note: deleting these names breaks `tests/agents/integration.test.ts` lines 18–20, 39–41, 151, 183, 214. Do those edits in this same commit (move them out of (k)) so the tree compiles at the end of batch (h).

**Commit**

```
F05: delete extractJson, result-parser surface, and result-parser.test.ts
```

---

### Batch (i) — Capability axis cleanup (delete `envelopeMode`)

Goal: replace the current capability axes with `{ toolsMode, exclusiveToolChoiceSupport }`; rewrite `capabilityRequestForLlmOptions`; never add `envelopeMode`. Migrate every capability-table fixture to the new axes.

**Files modified**

- [src/agents/provider-capabilities.ts](../../../../src/agents/provider-capabilities.ts):
  - Replace `EffectiveProviderCapabilities`'s tool-related axes with `toolsMode: 'native' | 'unsupported'` and `exclusiveToolChoiceSupport: 'native' | 'parallel_off' | 'unsupported'`. DELETE any `responseFormat` / `envelopeMode` axis if present in HEAD.
  - At L53 (`BUILTIN_CAPABILITIES`) — set `opencode`, `opencode-go`, `github-copilot`, `nvidia-nim` to `toolsMode: 'native', exclusiveToolChoiceSupport: 'native'`; set `openai-codex` to `toolsMode: 'native', exclusiveToolChoiceSupport: 'parallel_off'`.
  - At L127 (`capabilityRequestForLlmOptions`) — derive `requiresExclusiveToolChoice: true` for every role invocation; skip candidates with `toolsMode === 'unsupported'` or `exclusiveToolChoiceSupport === 'unsupported'`.
- [tests/agents/agent-adapter-recovery.test.ts](../../../../tests/agents/agent-adapter-recovery.test.ts), [tests/agents/config-schema.test.ts](../../../../tests/agents/config-schema.test.ts), [tests/agents/llm-client-integration.test.ts](../../../../tests/agents/llm-client-integration.test.ts), [tests/agents/model-router.test.ts](../../../../tests/agents/model-router.test.ts), [tests/agents/provider.test.ts](../../../../tests/agents/provider.test.ts) — for every `capabilities: { toolCalls: 'native' }` fixture, REPLACE with `capabilities: { toolsMode: 'native', exclusiveToolChoiceSupport: 'native' }` (or `'parallel_off'` for the Codex case).

**Files created**

- [tests/agents/provider-capabilities-axis.test.ts](../../../../tests/agents/provider-capabilities-axis.test.ts) — assert the built-in table values per provider; assert `capabilityRequestForLlmOptions` always emits `requiresExclusiveToolChoice: true`.

**Validation**

- `npx tsc --noEmit` — green.
- `npm test -- --run tests/agents/provider-capabilities-axis.test.ts tests/agents/agent-adapter-recovery.test.ts tests/agents/model-router.test.ts tests/agents/provider.test.ts tests/agents/config-schema.test.ts tests/agents/llm-client-integration.test.ts` — green.
- Manual grep `grep -rn "envelopeMode\|responseShape\|response_format" src/ tests/` → no hits.

**Commit**

```
F05: swap capability axes to toolsMode + exclusiveToolChoiceSupport; delete envelopeMode
```

---

### Batch (j) — Web migration (presenters + stores + viewer)

Goal: migrate `web/` to the one-row-per-tool-call format and render the `terminal_tool` badge.

**Files modified**

- [web/src/utils/tool-presenters/helpers.ts#L68-L78](../../../../web/src/utils/tool-presenters/helpers.ts#L68-L78) — RENAME `readToolCallEnvelope` to `readToolCallMessage` and rewrite to return `{ name, args }` from a single `ToolCall` row using `parseToolCallMessage` from [web/src/utils/persistedToolCall.ts](../../../../web/src/utils/persistedToolCall.ts).
- [web/src/utils/tool-presenters/registry.ts#L1](../../../../web/src/utils/tool-presenters/registry.ts#L1) — switch the import to `readToolCallMessage`.
- [web/src/utils/tool-presenters/registry.ts#L21](../../../../web/src/utils/tool-presenters/registry.ts#L21) — call `readToolCallMessage(rawContent, fallbackName)`; rename local `envelope` → `message`.
- [web/src/stores/analystChat.ts#L99-L108](../../../../web/src/stores/analystChat.ts#L99-L108) (`toolInvocationMatchesMessage`) — compare against a single `ToolCall` per row.
- LLM-exchange viewer component (find via `grep -rln 'terminalTool\|LlmExchange' web/src/components/`) — render the terminal-tool badge when `attempt.terminalTool !== null`; hide when `null`.
- Event-log row component — render the `terminal_tool` label for `invocation_succeeded` events; render no badge for events lacking the field.

**Files created**

- [web/src/__tests__/llm-exchange-viewer-terminal-tool.test.ts](../../../../web/src/__tests__/llm-exchange-viewer-terminal-tool.test.ts) — assert badge renders per role; hidden on `null`.
- [web/src/__tests__/event-log-terminal-tool.test.ts](../../../../web/src/__tests__/event-log-terminal-tool.test.ts) — assert label per role; absent on events without the field.

**Validation**

- `npm run build` — green (catches the Vue SFC duplicate-block class of bug too).
- `npm test -- --run web/src/__tests__/tool-presenters.test.ts web/src/__tests__/analystChat.test.ts web/src/__tests__/llm-exchange-viewer-terminal-tool.test.ts web/src/__tests__/event-log-terminal-tool.test.ts` — green.
- Sanity grep `grep -c '<script setup>' web/src/**/*.vue` — every file at most 1.

**Commit**

```
F05: web — rename to readToolCallMessage, render terminal_tool badge
```

---

### Batch (k) — Test migration (rewrite/delete per inventory)

Goal: clear every legacy `toolCalls:` wrapper literal and every reference to a deleted source surface. Add the adapter happy-path tests that batch (e) deferred.

**Files modified — REWRITE legacy wrapper fixtures to single-`ToolCall` rows**

- [tests/utils/runtime-project-planner-control-flow.test.ts#L20-L22](../../../../tests/utils/runtime-project-planner-control-flow.test.ts#L20-L22) — call `parseToolCallMessage` instead of inline `JSON.parse` on a wrapper.
- [tests/utils/runtime-executor-fallback-evidence.test.ts#L86](../../../../tests/utils/runtime-executor-fallback-evidence.test.ts#L86) and [#L158](../../../../tests/utils/runtime-executor-fallback-evidence.test.ts#L158) — append one `serializeToolCallMessage(call)` per call (two sites).
- [tests/agents/session-persistence.test.ts#L328](../../../../tests/agents/session-persistence.test.ts#L328) and [#L337](../../../../tests/agents/session-persistence.test.ts#L337) — fixtures rewritten to one-call-per-row; ADD a case asserting `LegacyMessageShapeError` on a wrapper row.
- [tests/agents/agent-runtime.test.ts#L140](../../../../tests/agents/agent-runtime.test.ts#L140) and [#L181](../../../../tests/agents/agent-runtime.test.ts#L181) — fixtures rewritten.
- [tests/agents/codex-deferred-activate-card.test.ts#L71](../../../../tests/agents/codex-deferred-activate-card.test.ts#L71) — fixture rewritten.
- [tests/agents/agent-adapter-reviewer-prompt.test.ts#L134](../../../../tests/agents/agent-adapter-reviewer-prompt.test.ts#L134) — fixture rewritten.
- [tests/agents/agent-adapter-load-skill.test.ts#L201](../../../../tests/agents/agent-adapter-load-skill.test.ts#L201), [#L253](../../../../tests/agents/agent-adapter-load-skill.test.ts#L253), [#L461](../../../../tests/agents/agent-adapter-load-skill.test.ts#L461) — fixtures rewritten.
- [tests/agents/agent-adapter-load-skill.test.ts#L237](../../../../tests/agents/agent-adapter-load-skill.test.ts#L237) — DELETE the `callParseToolCalls(JSON.stringify({ toolCalls: [] }))` case.
- [web/src/__tests__/analyst-chat-panel.test.ts#L31](../../../../web/src/__tests__/analyst-chat-panel.test.ts#L31) — fixture rewritten.
- [web/src/__tests__/analyst-chat-store.test.ts#L85](../../../../web/src/__tests__/analyst-chat-store.test.ts#L85) — fixture rewritten.
- [web/src/__tests__/agents-view.test.ts#L72](../../../../web/src/__tests__/agents-view.test.ts#L72) and [#L256](../../../../web/src/__tests__/agents-view.test.ts#L256) — fixtures rewritten.
- [web/src/__tests__/tool-presenters/_helpers.ts#L4](../../../../web/src/__tests__/tool-presenters/_helpers.ts#L4) — helper emits single-`ToolCall` row strings.

**Files modified — REWRITE around deleted source**

- [tests/agents/integration.test.ts](../../../../tests/agents/integration.test.ts) at L18–L20, L39–L41 — if not yet deleted in batch (h), DELETE those import/load lines now.
- [tests/agents/integration.test.ts#L151](../../../../tests/agents/integration.test.ts#L151) — REWRITE the planner case as: drive `AgentAdapter.invokeAgent` against a fake gateway returning a terminal `emit_planner_result` tool call with valid JSON args; assert the envelope returned by the adapter parses against `PlannerResultSchema`.
- [tests/agents/integration.test.ts#L183](../../../../tests/agents/integration.test.ts#L183) — same for executor with `emit_executor_result`.
- [tests/agents/integration.test.ts#L214](../../../../tests/agents/integration.test.ts#L214) — same for reviewer with `emit_reviewer_result`.

**Files deleted**

- [tests/agents/agent-adapter-force-final-answer.test.ts](../../../../tests/agents/agent-adapter-force-final-answer.test.ts) — DELETE outright (`forceFinalAnswer` was deleted in batch (e)).
- [tests/agents/agent-adapter-executor-fallback.test.ts](../../../../tests/agents/agent-adapter-executor-fallback.test.ts) — DELETE outright (`buildExecutorFallbackResult` was deleted in batch (h)).
- [tests/agents/agent-tool-executor.test.ts](../../../../tests/agents/agent-tool-executor.test.ts) at L35 — DELETE the `parseToolCallsFromResponse` case; preserve remaining cases unless they too target deleted methods (verify with `grep -n "describe\|it(" tests/agents/agent-tool-executor.test.ts`).

**Files created (adapter happy-path coverage)**

- [tests/agents/agent-adapter-invoke-happy-path.test.ts](../../../../tests/agents/agent-adapter-invoke-happy-path.test.ts) — per envelope-bearing role: one or more action tool calls followed by a terminal call; assert the returned envelope, assert one `serializeToolCallMessage` row per call in the session log, assert `invocation_succeeded.terminal_tool` is the correct enum value.
- [tests/agents/agent-adapter-invoke-direct-terminal.test.ts](../../../../tests/agents/agent-adapter-invoke-direct-terminal.test.ts) — action-eligible turn that returns the terminal call directly (no escalation needed); same assertions.
- [tests/agents/agent-adapter-invoke-escalation.test.ts](../../../../tests/agents/agent-adapter-invoke-escalation.test.ts) — escalation to `mustBeTerminal === true` on `turn === MAX_TOOLS_TURNS - 1`; assert `validateTerminalProtocol` is called BEFORE any `executeToolCall` on that final turn (use a side-effect-recording fake tool executor).
- [tests/agents/analyst-handler-result-union.test.ts](../../../../tests/agents/analyst-handler-result-union.test.ts) — analyst path: `kind: 'tools'` is iterated for surface enforcement; `kind: 'terminal_text'` is returned as the assistant reply; `LlmExchange.attempts[].terminalTool` is `null`; no `invocation_succeeded` event is emitted.

**Validation**

- `npx tsc --noEmit` — green.
- `npm test -- --run` — full suite green.
- `npm run build` — green.
- Grep counter: `grep -rn "toolCalls:" tests/ web/src/__tests__/ web/src/utils/ | grep -v "capabilities:" | wc -l` → `0`.
- Grep counter: `grep -rn "response_format\|extractJson\|parsePersistedToolCalls\|parseToolCallsFromResponse\|envelopeMode\|forceFinalAnswer\|handleToolCallsLoop\|ResultParseError\|buildExecutorFallbackResult\|parsePlannerResult\|parseExecutorResult\|parseReviewerResult" src/ web/src/ tests/ | wc -l` → `0`.

**Commit**

```
F05: migrate tests to one-row-per-toolcall and terminal-tool happy paths
```

---

### Batch (l) — Live-probe playbook

Goal: ship the opt-in probe and run it against the `saivage-v3` LXC harness.

**Files created**

- [scripts/probe-llm-contract.ts](../../../../scripts/probe-llm-contract.ts) per design §8.10: per configured provider in `.saivage/saivage.json`, issue one role invocation that (a) executes at least one action tool call and (b) terminates via `emit_<role>_result`. Assert the envelope parses against the role's Zod schema. Reads ONLY `.saivage/saivage.json` (never `.saivage/auth-profiles.json`, never any `apiKey` / `token` field). Output: machine-readable JSON to stdout, one line per `{provider, role, status}`.
- [scripts/README-probe-llm-contract.md](../../../../scripts/README-probe-llm-contract.md) — usage notes, including the deploy-then-probe sequence below.

**Operator playbook**

```bash
# 1. Build and deploy to saivage-v3 container
npm run build
ssh root@10.0.3.112 'systemctl stop saivage.service'
rsync -a --delete dist/ root@10.0.3.112:/opt/saivage-v3/dist/
ssh root@10.0.3.112 'systemctl start saivage.service'
curl -fsS http://10.0.3.112:8080/health

# 2. Run the probe on the container (it reads /work/saivage-v3/.saivage/saivage.json)
ssh salva@10.0.3.112 'cd /work/saivage-v3 && node /opt/saivage-v3/dist/scripts/probe-llm-contract.js'

# 3. Triage: every line MUST show status: "ok". Any "contract_mismatch:<subtype>" failure
#    is a wire-level contract bug — capture the line, file under the relevant F-issue.
```

**Validation**

- `npx tsc --noEmit` — green.
- Probe output on `saivage-v3` shows `status: "ok"` for every `(provider, role)` row currently configured.

**Commit**

```
F05: add scripts/probe-llm-contract.ts live playbook for the new contract
```

---

## 4. Risk register

### Per-batch rollback plan

| Batch | Failure symptom | Rollback action |
| --- | --- | --- |
| (a) | New module unit tests red, or import of `LlmContractMismatchError` fails downstream. | `git revert HEAD`. Re-do the batch; the new modules are additive. |
| (b) | `InvocationRecoveryPolicy.decideFailure` test red for a contract-mismatch subtype. | `git revert HEAD`. Issue is local to the classifier branch; reapply with the corrected branch. |
| (c) | Gateway request-shape test asserts the wrong `tool_choice` shape (chat-vs-Codex confusion). | `git revert HEAD`. The two builders are independent; redo per-builder. Verify shapes against design §3.5 table. |
| (d) | Gateway response-shape test red, or persisted-row read raises unexpected `LegacyMessageShapeError`. | `git revert HEAD`. Inspect the SSE accumulator path; rebuild without changing the request side (batch (c)). |
| (e) | Adapter loop hangs (infinite tool-loop) or never escalates to terminal turn. | `git revert HEAD`. Re-verify the `mustBeTerminal = (turn === MAX_TOOLS_TURNS - 1)` line and the `tool_choice: 'required_named'` plumbing. |
| (f) | Analyst happy path returns the wrong message shape to the UI. | `git revert HEAD`. The `kind` switch is the suspect; rerun the analyst handler smoke tests in isolation. |
| (g) | Schema test rejects the new `terminal_tool` enum value, or the recorder writes `undefined`. | `git revert HEAD`. The four typed-surface edits are atomic — they must land in one commit; do not split them across commits. |
| (h) | A residual caller of `extractJson` / `parsePlannerResult` / `parseExecutorResult` / `parseReviewerResult` survives in `src/` or `tests/`. | `git revert HEAD`. Re-run the grep from §3.2 and address the survivor before re-applying. |
| (i) | Capability test fixture mismatch; router skips every candidate (no provider selectable). | `git revert HEAD`. Inspect `BUILTIN_CAPABILITIES`; verify the `'parallel_off'` value for `openai-codex` and `'native'` for the other four. |
| (j) | Vue build red, or SFC duplicate-block error. | `git revert HEAD`. Run `grep -c '<script setup>' web/src/**/*.vue` to find the duplicate; restart VS Code per workspace memory note before re-editing. |
| (k) | Full suite red on a fixture rewrite. | `git revert HEAD`. Bisect by `git revert --no-commit` per file group; re-land per file group with the broken test fix. |
| (l) | Live probe returns `contract_mismatch:<subtype>` for a real provider. | The runtime change is fine; the probe just discovered a wire bug. File a follow-up F-issue. NOT a rollback. If the probe itself crashes, revert the script-add commit only. |

### Single biggest risk

The chat-vs-Codex `tool_choice` JSON shape leak (design §3.5). If the §3.5 translation table is mis-implemented in either builder — e.g. the Codex builder emits the nested `{ type: 'function', function: { name } }` instead of the flat `{ type: 'function', name }`, or the chat builder emits the flat shape — the Codex Responses transport will silently accept the request and either ignore the forced tool choice or 400 on it intermittently. The mitigation is in batch (c): two SEPARATE test files (`llm-openai-chat-gateway-request.test.ts` and `llm-openai-codex-gateway-request.test.ts`) assert the wire JSON shape against per-provider literal objects. A shared assertion helper that compared both shapes against the same expectation would re-introduce the bug; design §8.1 forbids it.

---

## 5. Acceptance criteria

Every invariant from the approved analysis maps to a passing test name. After batch (l), the following test names exist and pass:

| Analysis invariant | Test(s) |
| --- | --- |
| **1. Single-carrier per turn** | `tests/agents/llm-options-factory.test.ts > buildLlmOptions__rejects_phase_terminal_for_analyst`; structural — `LlmCompleteOptions` is `LlmToolsOptions` only (no `LlmEnvelopeOptions` export). |
| **2. Single-carrier per result** | `tests/agents/llm-openai-chat-gateway-response.test.ts > returns_kind_tools_for_tool_call`, `> returns_kind_terminal_text_for_prose_only`; same in `llm-openai-codex-gateway-response.test.ts`. |
| **3. No string-flatten in the gateway** | `tests/agents/agent-llm-gateway.test.ts > createLlmCallFn__returns_structured_LlmCompleteResult`; grep assertion in §3.2 (`content ?? JSON.stringify` → no hits). |
| **4. No per-turn option drift** | `tests/agents/agent-adapter-invoke-happy-path.test.ts > uses_buildLlmOptions_for_every_turn`; structural — `agent-adapter.ts` contains zero inline `LlmCompleteOptions` literals (grep). |
| **5. Envelope parsed by typed schema, not text heuristics** | `tests/agents/parse-role-envelope-arguments.test.ts > terminal_arguments_not_json__rejects_unparseable_arguments_planner` (and executor, reviewer); `> terminal_arguments_schema_mismatch__rejects_zod_invalid_envelope_planner` (and executor, reviewer); deletion of `tests/agents/result-parser.test.ts`. |
| **6. Capability surface admits the new shape** | `tests/agents/provider-capabilities-axis.test.ts > builtins_have_correct_toolsMode_and_exclusiveToolChoiceSupport`; `> capabilityRequestForLlmOptions_always_requires_exclusive_tool_choice`. |
| **7. Codex Responses is a first-class participant** | `tests/agents/llm-openai-codex-gateway-request.test.ts > terminal_phase_tool_choice_is_flat_function_name`; `> tools_emit_flat_name_field`; `> never_sends_response_format`. |
| **8. Typed failures; contract mismatch does not cooldown** | `tests/agents/invocation-recovery-policy-contract-mismatch.test.ts > terminal_prose_only__classifies_as_fail_invocation_no_cooldown` (and one per subtype). |
| **9. No backward-compat shim survives** | `tests/agents/persisted-tool-call.test.ts > parseToolCallMessage__raises_LegacyMessageShapeError_on_wrapper_input`; grep assertions in §3 batch (k) validation (zero matches for the legacy-name set). |
| **10. Tests cover the matrix AND every direct consumer** | `tests/agents/agent-adapter-invoke-happy-path.test.ts` (adapter path); `tests/agents/analyst-handler-result-union.test.ts` (analyst path); per-provider request and response tests in `tests/agents/llm-openai-{chat,codex}-gateway-{request,response}.test.ts`. |

Additional plan-only acceptance:

- All six §4.3 rejection subtypes have a dedicated test in `tests/agents/terminal-protocol.test.ts` whose name embeds the subtype (`terminal_prose_only`, `terminal_duplicate`, `terminal_mixed_with_actions`, `terminal_wrong_role`, `terminal_missing_on_forced_turn`).
- `tests/agents/parse-role-envelope-arguments.test.ts` covers the seventh family (`terminal_arguments_not_json`, `terminal_arguments_schema_mismatch`) across all three envelope-bearing roles.
- `LlmExchange.attempts[].terminalTool` is `nullable()` and `invocation_succeeded.terminal_tool` is non-nullable; tests in `tests/contracts/llm-exchange-terminal-tool.test.ts` and `tests/schemas/event-catalog-terminal-tool.test.ts` assert both shapes.
- Live probe on `saivage-v3` returns `status: "ok"` for every `(provider, role)` row in `.saivage/saivage.json`.

---

## 6. F-issue absorption notice

This plan, when fully landed, also closes the following sibling F-issues:

- **F01 — `response_format` + `tools[]` requested together.** Closed. The `LlmEnvelopeOptions` variant does not exist under Proposal L; `response_format` is never present on any `LlmCompleteOptions` value or wire request. Batch (a) deletes the variant; batches (c) and (d) delete the gateway forwarding branch and the inline assembler that produced the combination.
- **F02 — DeepSeek prose breaks `extractJson`.** Closed. `extractJson` is deleted in batch (h). Prose responses now arrive as `kind: 'terminal_text'` from the gateway and are rejected by `validateTerminalProtocol` as `terminal_prose_only` on the forced terminal turn.
- **F09 — `extractJson` brace-span fallback can extract wrong substring.** Closed. Same deletion as F02; the brace-span fallback no longer exists.
- **F11 — `response_format` dropped on follow-up turn; tool calls dropped when content non-empty.** Closed. Sub-bug (a) is impossible because `buildLlmOptions` is the only option assembler and is called identically on every turn (batch (a) creates it; batch (e) consumes it). Sub-bug (b) is impossible because the gateway returns a typed union; mixed responses surface as `{ kind: 'tools', calls, rawAssistantText: <content> }` and the calls are not silently discarded (batch (d)).

This plan does NOT close the following sibling F-issues:

- **F03 — cooldown ignores `Retry-After` and never persists.** Separate. F05 reduces the number of spurious cooldowns caused by contract-mismatch misclassification, but the cooldown-policy / persistence work is independent.
- **F04 — observability schemas.** Separate. F05 adds the `terminal_tool` field to the `invocation_succeeded` event and the `terminalTool` field to `LlmExchange.attempts[]` (batch (g)), but the wider observability schema work is out of scope.
- **F06 — typed tool-definition serializer.** Possibly absorbed. The `codexTool` helper at [src/agents/llm-openai-codex-gateway.ts#L181-L184](../../../../src/agents/llm-openai-codex-gateway.ts#L181-L184) and the equivalent in the chat gateway are now uniformly fed from `ToolDefinition` (batches (c), (e)); whether F06's deeper serializer redesign survives is a follow-up decision.
- **F07 — fallback-chain duplication.** Separate. F05 deletes `buildExecutorFallbackResult` (batch (h)) but the broader chain-duplication concern is independent.
- **F08 — failure classifier is HTTP-status-only and string-regex.** Separate. F05 adds the `LlmContractMismatchError` branch (batch (b)) but the wider HTTP-body / Retry-After parsing work is out of scope.
- **F10 — `response_format` is not modelled as a capability.** Closed by deletion. Under Proposal L `response_format` is never on the wire, so the capability axis does not need to be added (and is explicitly NOT added — batch (i) names the prohibition).

---

End of plan.
