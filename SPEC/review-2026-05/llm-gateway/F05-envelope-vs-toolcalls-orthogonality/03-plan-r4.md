# F05 — Envelope-vs-toolcalls orthogonality (implementation plan, r4)

All file references are workspace-relative to `/home/salva/g/ml/saivage-v3/` and clickable. No backward-compat shim, no feature flag, no envelope-mode fallback, no migration shims. Project guideline: architecture-first; actively delete dead code.

Every batch in this plan is a single git commit that ends with both `npx tsc --noEmit` GREEN and the batch-owned tests GREEN. There are no "expected failures", no "typecheck-only-of-new-modules" deliverables, and no fixture rewrites deferred to a later batch. Where the contract flip cannot be safely split without shims, the affected substrate, consumer source, persistence source, and test rewrites are combined into a single coherent batch.

---

## 1. Scope and selected proposal

Implement **Proposal L (tools-as-only-result)**: every envelope-bearing role (`planner` / `executor` / `reviewer`) returns its result as the validated arguments of a single role-specific terminal tool call (`emit_planner_result` / `emit_executor_result` / `emit_reviewer_result`); `analyst` continues tools-only with no terminal tool. The following surfaces are deleted in the same coherent pass: `response_format`, the `LlmEnvelopeOptions` variant, the `kind: 'envelope'` result variant, the gateway flatten shim in `createLlmCallFn`, `parsePersistedToolCalls`, `parseToolCallsFromResponse`, `extractJson` and the entire `result-parser.ts` family (`parsePlannerResult` / `parseExecutorResult` / `parseReviewerResult` / `buildExecutorFallbackResult` / `ResultParseError`), the `envelopeMode` / `responseShape` capability axes, the `forceFinalAnswer` adapter helper, the `handleToolCallsLoop` body, the chat-shape-leaked `tool_choice` JSON in shared types, and every legacy persisted `{toolCalls:[...]}` wrapper reader (production source and tests both).

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
# Baseline wrapper-reader inventory (informational):
grep -rn "\.toolCalls" src/ | grep -v deprecated
grep -rn "toolCalls:" tests/ web/src/__tests__/ web/src/utils/ 2>/dev/null | wc -l
grep -rn "response_format\|extractJson\|parsePersistedToolCalls\|parseToolCallsFromResponse\|envelopeMode\|forceFinalAnswer\|handleToolCallsLoop\|ResultParseError\|buildExecutorFallbackResult\|parsePlannerResult\|parseExecutorResult\|parseReviewerResult" src/ web/src/ tests/ 2>/dev/null | wc -l
```

Live-probe target (only after batch B6 passes): `saivage-v3` LXC container at `10.0.3.112:8080`, service `saivage.service`. Pre-flight: `curl -fsS http://10.0.3.112:8080/health`.

Editor reset: if any Vue SFC was open during a prior session, run `workbench.action.files.saveAll` and `grep -c '<script setup>' web/src/**/*.vue` to detect duplicated blocks before any web edit.

---

## 3. Implementation batches

Six batches, B1–B6, each one commit and one green checkpoint.

### Batch B1 — Substrate-only additions (purely additive, fully green)

Goal: add the new typed surfaces, helpers, terminal-protocol validator, role-envelope schemas, a local Zod→JSON-schema converter, and persisted-row helpers without touching any existing consumer call site. The existing `LlmCompleteOptions` / `LlmCompleteResult` / `LlmCallFn` shapes are NOT changed in this batch, so every existing consumer keeps compiling and existing tests keep passing. The one production-source edit in this batch is the **verbatim MOVE** of the three role Zod schemas out of [src/agents/result-parser.ts](../../../src/agents/result-parser.ts) into a new [src/agents/role-envelope-schemas.ts](../../../src/agents/role-envelope-schemas.ts); `result-parser.ts` keeps working by re-importing them from the new home under the same identifiers until B3 deletes `result-parser.ts` outright.

**Verbatim-move rule.** The Zod bodies of `rawPlannerResultSchema`, `rawExecutorResultSchema`, `rawReviewerResultSchema`, and their dependent sub-schemas, are moved BYTE-IDENTICAL. In particular `ExecutorResultSchema` at [src/agents/result-parser.ts#L137-L142](../../../src/agents/result-parser.ts#L137-L142) keeps `result: z.record(z.string(), z.unknown()).optional()` AND remains a non-strict top-level object (no `.strict()` is added). Tightening the executor schema would be a behaviour change scoped outside this batch; the F05 plan does not do it.

Because the converter must handle these schemas as-is on the wire (B2 ships their JSON-schema parameters to providers), B1's mini Zod→JSON-schema converter explicitly supports `ZodUnknown` and `ZodRecord`, and the B1 converter test asserts the executor schema's expected (non-strict, record-of-unknown) JSON shape — not a counter-factual strict-object shape.

**Files created**

- [src/agents/role-envelope-schemas.ts](../../../src/agents/role-envelope-schemas.ts) — destination of the three role schemas. Exports `PlannerResultSchema`, `ExecutorResultSchema`, `ReviewerResultSchema`, plus `type EnvelopeBearingRole = 'planner' | 'executor' | 'reviewer'` and `ENVELOPE_SCHEMAS: Record<EnvelopeBearingRole, ZodTypeAny>`. The schema bodies are MOVED, not copied — the originals (`rawPlannerResultSchema` at [src/agents/result-parser.ts#L113](../../../src/agents/result-parser.ts#L113), `rawExecutorResultSchema` at [src/agents/result-parser.ts#L137](../../../src/agents/result-parser.ts#L137), `rawReviewerResultSchema` at [src/agents/result-parser.ts#L148](../../../src/agents/result-parser.ts#L148)) and their dependent sub-schemas (`plannerCardCreateSchema`, `plannerCardUpdateSchema`, `executorArtifactDefSchema`, `executorAttachmentDefSchema`, `reviewerResultSchema`) are moved into the new file. The B1 modification of `result-parser.ts` (below) re-imports them so its parser functions at L295 keep working with zero behaviour change. The `.strict()` / non-strict status of each top-level role schema is preserved exactly as it is at HEAD: planner `.strict()`, executor non-strict, reviewer `.strict()`.

- [src/agents/zod-to-jsonschema-mini.ts](../../../src/agents/zod-to-jsonschema-mini.ts) — local Zod → JSON-schema converter covering the subset used by the three role schemas. Exported entry `zodToJsonSchemaMini(schema: ZodTypeAny): JsonSchema`. Supported nodes:

  | Zod node | JSON-schema output |
  | --- | --- |
  | `ZodObject` (`.strict()`) | `{ type: 'object', properties, required, additionalProperties: false }` |
  | `ZodObject` (non-strict, default) | `{ type: 'object', properties, required, additionalProperties: true }` |
  | `ZodString` | `{ type: 'string' }` (with `minLength` honoured when `.min(n)` is present) |
  | `ZodNumber` | `{ type: 'number' }`; `.int()` → `{ type: 'integer' }` |
  | `ZodBoolean` | `{ type: 'boolean' }` |
  | `ZodArray` | `{ type: 'array', items: <inner> }` |
  | `ZodEnum` | `{ type: 'string', enum: [...] }` |
  | `ZodLiteral` | `{ const: value }` |
  | `ZodOptional` | omit from parent's `required`; convert inner |
  | `ZodNullable` | `{ anyOf: [<inner>, { type: 'null' }] }` |
  | `ZodDefault` | convert inner; omit from parent's `required` |
  | `ZodEffects` | transparently convert inner schema; throw if no inner is reachable |
  | `ZodUnknown` | `{}` (the empty schema, accepts any JSON value) |
  | `ZodRecord` | `{ type: 'object', additionalProperties: <valueSchema> }` (the value-schema is itself converted recursively; `ZodRecord<ZodString, ZodUnknown>` therefore yields `{ type: 'object', additionalProperties: {} }`) |

  Any unsupported node MUST throw `Error('zodToJsonSchemaMini: unsupported Zod node: <constructor name>')` — no silent fallback. This avoids adding a `zod-to-json-schema` dependency (current [package.json#L92](../../../package.json#L92) lists only `zod`).

- [src/agents/role-result-tools.ts](../../../src/agents/role-result-tools.ts) — defines `EMIT_PLANNER_RESULT`, `EMIT_EXECUTOR_RESULT`, `EMIT_REVIEWER_RESULT` as `ToolDefinition`s (function-shape with `parameters: zodToJsonSchemaMini(<role>ResultSchema)`); exports `ROLE_RESULT_TOOL_NAMES: Record<AgentRole, string | null>` (`{ planner: 'emit_planner_result', executor: 'emit_executor_result', reviewer: 'emit_reviewer_result', analyst: null }`) and `OTHER_ROLE_TERMINALS: Set<string>` derived from the same map.

- [src/agents/persisted-tool-call.ts](../../../src/agents/persisted-tool-call.ts) — exports `serializeToolCallMessage(call: ToolCall): string` (`JSON.stringify(call)`) and `parseToolCallMessage(content: string): ToolCall` (parses + Zod-validates a single `ToolCall`; raises `LegacyMessageShapeError` when the JSON is an object with a `.toolCalls` array, i.e. the legacy wrapper shape).

- [web/src/utils/persistedToolCall.ts](../../../web/src/utils/persistedToolCall.ts) — server-free mirror of the same surface (web bundle cannot import server modules).

- [src/agents/terminal-protocol.ts](../../../src/agents/terminal-protocol.ts) — `validateTerminalProtocol(result, expectations)` raising `LlmContractMismatchError` with subtypes `terminal_prose_only`, `terminal_duplicate`, `terminal_mixed_with_actions`, `terminal_wrong_role`, `terminal_missing_on_forced_turn`; plus `parseRoleEnvelopeArguments(role, rawArgs)` raising the `terminal_arguments_not_json` and `terminal_arguments_schema_mismatch` subtypes via the same error class. NOTE: this module is created here but not wired into any caller yet — that happens in B2.

- [tests/agents/zod-to-jsonschema-mini.test.ts](../../../tests/agents/zod-to-jsonschema-mini.test.ts) — coverage:
  - Round-trip for every supported node listed in the table above (object/strict, object/non-strict, string/min, number/int, boolean, array, enum, literal, optional, nullable, default, effects, unknown, record).
  - `record_of_unknown_converts_to_object_with_empty_additionalProperties` — asserts `zodToJsonSchemaMini(z.record(z.string(), z.unknown()))` deep-equals `{ type: 'object', additionalProperties: {} }`.
  - `unsupported_node_throws` — `z.union([…])` raises with the diagnostic message above.
  - **Real-schema assertions (the three role schemas as moved verbatim):**
    - `planner_schema_strict_top_level` — `zodToJsonSchemaMini(PlannerResultSchema).additionalProperties === false` (planner IS `.strict()` at HEAD; the moved schema preserves it).
    - `executor_schema_non_strict_top_level` — `zodToJsonSchemaMini(ExecutorResultSchema).additionalProperties === true` (executor is NOT `.strict()` at HEAD; the verbatim move preserves it).
    - `executor_schema_result_is_record_of_unknown` — the converted schema's `properties.result` deep-equals `{ type: 'object', additionalProperties: {} }`. Proves the converter handles the real executor `result: z.record(z.string(), z.unknown()).optional()` field on the wire without throwing or fabricating a strict shape.
    - `executor_schema_optional_result_not_required` — `'result'` is NOT in `properties.required`.
    - `reviewer_schema_strict_top_level` — `zodToJsonSchemaMini(ReviewerResultSchema).additionalProperties === false` (reviewer IS `.strict()` at HEAD).

- [tests/agents/persisted-tool-call.test.ts](../../../tests/agents/persisted-tool-call.test.ts) — round-trip `serializeToolCallMessage`/`parseToolCallMessage`; assert `LegacyMessageShapeError` on `'{ "toolCalls": [...] }'`.

- [tests/agents/terminal-protocol.test.ts](../../../tests/agents/terminal-protocol.test.ts) — one test per name-based rejection subtype (`terminal_prose_only` for both `terminal_text` and empty-tools variants, `terminal_duplicate`, `terminal_mixed_with_actions`, `terminal_wrong_role`, `terminal_missing_on_forced_turn`). Because B1 has NOT flipped `LlmCompleteResult` yet, this test file declares a LOCAL test-only structural type `type TestLlmResult = { kind: 'tools'; calls: ToolCall[]; rawAssistantText: string | null } | { kind: 'terminal_text'; text: string }` and feeds it to `validateTerminalProtocol`. The validator's signature accepts the new union by its own module-local type alias (the validator does not import `LlmCompleteResult` from `llm-contracts.ts` in B1; B2 unifies the two types). A short comment in the test file explains the temporary local type.

- [tests/agents/parse-role-envelope-arguments.test.ts](../../../tests/agents/parse-role-envelope-arguments.test.ts) — `terminal_arguments_not_json` and `terminal_arguments_schema_mismatch` for all three envelope-bearing roles, using the moved schemas from `role-envelope-schemas.ts`.

**Files modified**

- [src/agents/result-parser.ts](../../../src/agents/result-parser.ts) at L113, L137, L148 — DELETE the local `rawPlannerResultSchema`, `rawExecutorResultSchema`, `rawReviewerResultSchema` const declarations AND the dependent sub-schemas (`plannerCardCreateSchema`, `plannerCardUpdateSchema`, `executorArtifactDefSchema`, `executorAttachmentDefSchema`, `reviewerResultSchema`). At the top of the file, ADD `import { PlannerResultSchema as rawPlannerResultSchema, ExecutorResultSchema as rawExecutorResultSchema, ReviewerResultSchema as rawReviewerResultSchema } from './role-envelope-schemas.js';` (aliases preserve the existing in-file identifiers so the parser functions at L295 keep working byte-identically). No other changes to `result-parser.ts` in B1; `parsePlannerResult` / `parseExecutorResult` / `parseReviewerResult` / `buildExecutorFallbackResult` / `extractJson` / `ResultParseError` continue to exist and are deleted in B3.

- [src/agents/llm-errors.ts](../../../src/agents/llm-errors.ts) — ADD `class LlmContractMismatchError extends Error` with typed `subtype` field covering all seven subtypes above, plus `details: Record<string, unknown>`. ADD `class LegacyMessageShapeError extends Error`. (No removals; existing errors are untouched.)

**Validation (B1)**

- `npx tsc --noEmit` — GREEN (no existing public surface changed; result-parser.ts behaves byte-identically because its schemas are re-imported under the same identifiers).
- `npm test -- --run tests/agents/zod-to-jsonschema-mini.test.ts tests/agents/persisted-tool-call.test.ts tests/agents/terminal-protocol.test.ts tests/agents/parse-role-envelope-arguments.test.ts` — GREEN.
- `npm test -- --run tests/agents/result-parser.test.ts` — GREEN (existing parser behaviour unchanged because the schemas are identical Zod objects in a new module).
- `npm test -- --run` (full suite) — GREEN.
- `npm run build` — GREEN.

**Commit message (B1)**

```
F05: add typed substrate (move role schemas verbatim to role-envelope-schemas.ts, add zod-to-jsonschema-mini with ZodUnknown/ZodRecord support, terminal-protocol validator, persisted-row helpers, contract errors)
```

---

### Batch B2 — Contract flip + all consumers + persistence + runtime + tests (one coherent commit)

Goal: flip the `LlmCompleteOptions` / `LlmCompleteResult` / `LlmCallFn` contract, rewrite every direct consumer (both gateways, both stream parsers, `agent-llm-gateway`, `agent-adapter`, `agent-tool-executor`, `agent-tool-catalog`, `analyst-llm-resolver`, `analyst-handler`, `fake-agent`), migrate the two legacy persisted-wrapper readers in production source (`src/agents/session-persistence.ts` and `src/runtime/runtime.ts`), wire the contract-mismatch branch into the recovery policy, add `terminalTool` plumbing through the recorder / exchange schema / `invocation_succeeded` event, and rewrite every consumer test fixture in the same commit so the tree compiles green and the full suite stays green. This batch is large by necessity: the design forbids shims, every consumer reads the new union directly, and persisted-row writers and readers must change atomically (one-row-per-call) or persistence regression tests would fail mid-batch.

**Files created**

- [src/agents/llm-options-factory.ts](../../../src/agents/llm-options-factory.ts) — `buildLlmOptions(role, phase: 'tools' | 'terminal', tools, modelParams, signal, recorder): LlmCompleteOptions`. Body:

  ```ts
  export function buildLlmOptions(role, phase, tools, modelParams, signal, recorder): LlmCompleteOptions {
    const terminalName = ROLE_RESULT_TOOL_NAMES[role];
    if (phase === 'terminal') {
      if (!terminalName) throw new Error(`analyst has no terminal tool`);
      const terminalOnly = tools.filter((t) => t.function.name === terminalName);
      if (terminalOnly.length !== 1) {
        throw new Error(`Terminal phase for role ${role} requires exactly one ${terminalName} tool in the catalog (found ${terminalOnly.length})`);
      }
      return {
        mode: 'tools',
        tools: terminalOnly,                                    // length === 1, name === terminalName
        tool_choice: { kind: 'required_named', toolName: terminalName },
        parallel_tool_calls: false,
        temperature: modelParams.temperature,
        max_tokens: modelParams.maxTokens,
        signal, recorder,
      };
    }
    if (tools.length === 0) throw new Error(`Role ${role} requires non-empty tool catalog`);
    return {
      mode: 'tools',
      tools,
      tool_choice: { kind: 'auto' },
      parallel_tool_calls: false,
      temperature: modelParams.temperature,
      max_tokens: modelParams.maxTokens,
      signal, recorder,
    };
  }
  ```

  Terminal-phase requests MUST send `tools[].length === 1` and that single tool MUST be the role's terminal tool. The factory throws if the caller hands it a tool list that does not contain exactly the role terminal tool (proof-by-construction that terminal-phase requests cannot leak action tools).

- [tests/agents/llm-options-factory.test.ts](../../../tests/agents/llm-options-factory.test.ts) — named cases:
  - `buildLlmOptions__phase_tools_returns_full_catalog_with_auto_choice` (per role).
  - `buildLlmOptions__phase_terminal_returns_single_tool_array` — for each envelope-bearing role, assert `result.tools.length === 1` AND `result.tools[0].function.name === ROLE_RESULT_TOOL_NAMES[role]` AND `result.tool_choice` is `{ kind: 'required_named', toolName: <role tool> }`.
  - `buildLlmOptions__phase_terminal_throws_when_terminal_tool_missing_from_catalog` — pass an action-only tool list with `phase: 'terminal'`; assert the factory throws with the diagnostic above.
  - `buildLlmOptions__phase_terminal_throws_when_terminal_tool_duplicated_in_catalog` — pass `[EMIT_PLANNER_RESULT, EMIT_PLANNER_RESULT]`; assert the factory throws.
  - `buildLlmOptions__rejects_phase_terminal_for_analyst` — `phase: 'terminal'` with `role: 'analyst'`; assert `Error('analyst has no terminal tool')`.
  - `buildLlmOptions__always_sets_parallel_tool_calls_false` (per role × per phase combination).

- [tests/agents/llm-openai-chat-gateway-request.test.ts](../../../tests/agents/llm-openai-chat-gateway-request.test.ts) — chat-only request-shape:
  - `chat_request__never_sends_response_format` (per role × per phase).
  - `chat_request__always_sets_parallel_tool_calls_false`.
  - `chat_request__phase_tools_uses_tool_choice_auto`.
  - `chat_request__phase_terminal_uses_nested_function_tool_choice` — asserts `tool_choice: { type: 'function', function: { name: <role tool> } }`.
  - `chat_request__phase_terminal_sends_exactly_one_tool` — asserts `body.tools.length === 1` AND `body.tools[0].function.name === <role tool>` (per envelope-bearing role).

- [tests/agents/llm-openai-codex-gateway-request.test.ts](../../../tests/agents/llm-openai-codex-gateway-request.test.ts) — Codex-only request-shape:
  - `codex_request__never_sends_response_format`.
  - `codex_request__always_sets_parallel_tool_calls_false`.
  - `codex_request__phase_tools_uses_tool_choice_auto`.
  - `codex_request__phase_terminal_uses_flat_function_tool_choice` — asserts `tool_choice: { type: 'function', name: <role tool> }` (FLAT form, no nested `function` object).
  - `codex_request__phase_terminal_sends_exactly_one_tool_with_flat_name` — asserts `body.tools.length === 1` AND `body.tools[0].name === <role tool>` (flat `name`, top-level).

- [tests/agents/llm-openai-chat-gateway-response.test.ts](../../../tests/agents/llm-openai-chat-gateway-response.test.ts) — four cases: action tool call only → `kind: 'tools'`; terminal tool call with valid JSON args → `kind: 'tools'` with `function.arguments` left as the unparsed raw string; prose-only → `kind: 'terminal_text'`; mixed (prose + tool call) → `kind: 'tools'` with `rawAssistantText` set to the prose content.

- [tests/agents/llm-openai-codex-gateway-response.test.ts](../../../tests/agents/llm-openai-codex-gateway-response.test.ts) — same four cases against the Codex SSE shape.

- [tests/agents/agent-llm-gateway.test.ts](../../../tests/agents/agent-llm-gateway.test.ts) — assert `createLlmCallFn` returns the `LlmCompleteResult` union verbatim (no string flatten, no `JSON.stringify({toolCalls:...})`).

- [tests/agents/invocation-recovery-policy-contract-mismatch.test.ts](../../../tests/agents/invocation-recovery-policy-contract-mismatch.test.ts) — one test per `LlmContractMismatchError` subtype asserts `{ action: 'fail_invocation', markFailed: false, appendModelIssue: true, abort: true, cooldownMs: 0 }`.

- [tests/agents/agent-adapter-invoke-happy-path.test.ts](../../../tests/agents/agent-adapter-invoke-happy-path.test.ts) — per envelope-bearing role: one or more action tool calls followed by the role's terminal call; assert returned envelope, one `serializeToolCallMessage` row per call in the session log, and `invocation_succeeded.terminal_tool` is the correct enum value.

- [tests/agents/agent-adapter-invoke-direct-terminal.test.ts](../../../tests/agents/agent-adapter-invoke-direct-terminal.test.ts) — action-eligible turn that returns the terminal call directly (no escalation needed); same assertions.

- [tests/agents/agent-adapter-invoke-escalation.test.ts](../../../tests/agents/agent-adapter-invoke-escalation.test.ts) — escalation to `mustBeTerminal === true` on the final turn; assert `validateTerminalProtocol` runs BEFORE any `executeToolCall` on that turn (use a side-effect-recording fake tool executor); assert the escalation turn's `LlmCompleteOptions` had `tools.length === 1`.

- [tests/agents/analyst-handler-result-union.test.ts](../../../tests/agents/analyst-handler-result-union.test.ts) — analyst path: `kind: 'tools'` iterates calls through surface enforcement; `kind: 'terminal_text'` returns the prose as the assistant reply; `LlmExchange.attempts[].terminalTool === null`; no `invocation_succeeded` event emitted.

- [tests/contracts/llm-exchange-terminal-tool.test.ts](../../../tests/contracts/llm-exchange-terminal-tool.test.ts) — round-trip each enum value AND `null` for the attempt-level `terminalTool` field; assert rejection of off-enum strings.

- [tests/schemas/event-catalog-terminal-tool.test.ts](../../../tests/schemas/event-catalog-terminal-tool.test.ts) — round-trip each enum value; assert the schema REJECTS `null` for `invocation_succeeded.terminal_tool`; assert it REJECTS a missing field.

- [tests/schemas/validators-terminal-tool.test.ts](../../../tests/schemas/validators-terminal-tool.test.ts) — same for `invocationSucceededEventSchema`.

- [tests/schemas/types-terminal-tool.test.ts](../../../tests/schemas/types-terminal-tool.test.ts) — `@ts-expect-error` assertion that a fixture omitting `terminal_tool` fails to type-check.

- [tests/agents/session-persistence-legacy-wrapper.test.ts](../../../tests/agents/session-persistence-legacy-wrapper.test.ts) — assert that a legacy `{ "toolCalls": [...] }` row in the persisted log makes `findUniqueUnresolvedActivateCardToolCall` raise `LegacyMessageShapeError` (no silent ignore).

- [tests/runtime/runtime-legacy-wrapper.test.ts](../../../tests/runtime/runtime-legacy-wrapper.test.ts) — assert that a legacy wrapper row in the persisted log makes `Runtime.findUnresolvedActivateCards` raise `LegacyMessageShapeError`.

**Files modified — substrate contracts**

- [src/agents/llm-contracts.ts](../../../src/agents/llm-contracts.ts) — REPLACE `LlmCompleteResult` interface with the discriminated union `{ kind: 'tools'; calls: ToolCall[]; rawAssistantText: string | null } | { kind: 'terminal_text'; text: string }`. REPLACE `LlmCompleteOptions` with `LlmToolsOptions extends LlmCommonOptions { mode: 'tools'; tools: ToolDefinition[]; tool_choice: TerminalChoice; parallel_tool_calls: false }` plus `export type LlmCompleteOptions = LlmToolsOptions`. ADD `export type TerminalChoice = { kind: 'auto' } | { kind: 'required_named'; toolName: string }`. CHANGE `LlmCallFn`'s return type from `Promise<string>` to `Promise<LlmCompleteResult>`. MAKE `LlmInvocationClient.complete`'s `opts` parameter required and typed `LlmCompleteOptions`. DELETE `parsePersistedToolCalls`.

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

- Also in B2: `src/agents/terminal-protocol.ts` (created in B1 with a module-local result type) is RETYPED to import `LlmCompleteResult` from `llm-contracts.ts`; the B1 test file's local `TestLlmResult` alias is REMOVED in this commit and replaced with `LlmCompleteResult` because B2 unifies the type.

**Files modified — gateways and stream parsers**

- [src/agents/llm-openai-chat-gateway.ts](../../../src/agents/llm-openai-chat-gateway.ts) (`buildOpenAIChatRequest`, lines 148–198): DELETE the `if (opts?.response_format)` branch at L186. REPLACE `tool_choice` forwarding with `opts.tool_choice.kind === 'auto' ? 'auto' : { type: 'function', function: { name: opts.tool_choice.toolName } }`. ADD `requestBody.parallel_tool_calls = false` unconditionally. Tighten signature to `opts: LlmCompleteOptions` (required). REWRITE `OpenAIChatGateway.complete` finalization to return the new union directly (no `{ content, toolCalls, finishReason }` literal). REPLACE the L160 `parsePersistedToolCalls(m.content)` with a single `parseToolCallMessage(m.content)` per persisted tool-call row.

- [src/agents/llm-openai-codex-gateway.ts](../../../src/agents/llm-openai-codex-gateway.ts) (`buildOpenAICodexRequest`, lines 105–127): always run the tools assembly block (tools are now required). EMIT `body.tool_choice = opts.tool_choice.kind === 'auto' ? 'auto' : { type: 'function', name: opts.tool_choice.toolName }` (FLAT form). EMIT `body.parallel_tool_calls = false` (replaces the unconditional `true` at L125). Tighten signature to `opts: LlmCompleteOptions` (required). DELETE the `parsePersistedToolCalls` import at L5. REWRITE `OpenAICodexGateway.complete` finalization to return the new union. REPLACE the two `parsePersistedToolCalls(message.content)` calls in `codexMessages` at L130 and L152 with `[parseToolCallMessage(message.content)]`.

- [src/agents/llm-stream-parser.ts](../../../src/agents/llm-stream-parser.ts) — `buildOpenAIChatStreamResult` return type becomes `LlmCompleteResult`; finalization at L100–L113 emits the union variant chosen by `tool_calls`-vs-content presence; `function.arguments` stays a raw string.

- [src/agents/llm-codex-parser.ts](../../../src/agents/llm-codex-parser.ts) — `finalizeCodexToolCall` and sibling finalizers return `LlmCompleteResult`; the `'{}'` default at L131 is preserved (it is the wire-level "no arguments" default, not a wrapper).

- [src/agents/agent-llm-gateway.ts](../../../src/agents/agent-llm-gateway.ts) (`createLlmCallFn`, lines 48–66): DELETE the flatten line `return result.content ?? JSON.stringify({ toolCalls: result.toolCalls });` at L58. CHANGE return type from `Promise<string>` to `Promise<LlmCompleteResult>`. Body becomes `const result = await client.complete(...); return result;`.

**Files modified — adapter, executor, catalog, analyst, fake agent**

- [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts): REWRITE `invokeAgent` body to a single tools loop. Every turn calls `buildLlmOptions(role, mustBeTerminal ? 'terminal' : 'tools', mustBeTerminal ? [terminalTool] : tools, modelParams, signal, recorder)` — note that the caller passes the FILTERED single-tool list when `mustBeTerminal`, satisfying the factory's terminal-phase invariant. Replaces both inline `LlmCompleteOptions` literals at L280 and L342. DELETE `handleToolCallsLoop` (at L220), `forceFinalAnswer` (at L213), the `parseToolCallsFromResponse` wrapper (at L167), and the toolCalls-in-content recovery branch. After the LLM call returns, run `validateTerminalProtocol(result, { role, terminalToolName, mustBeTerminal })` BEFORE any `executeToolCall`. On `kind: 'tools'`, iterate `result.calls`; for each persisted assistant-tool_call row, write one `serializeToolCallMessage(call)` row at L239 (replacing the bundled wrapper write). The `invocation_succeeded` payload sent to BOTH `this.eventLogger.appendEvent(...)` and `eventBus.emit('invocation_succeeded', ...)` at L399–L400 MUST include `terminal_tool: ROLE_RESULT_TOOL_NAMES[role]` (always non-null for planner/executor/reviewer; the event is never emitted for analyst).

- [src/agents/agent-tool-executor.ts](../../../src/agents/agent-tool-executor.ts) (`buildToolsForRole`, L45): APPEND the role-specific terminal tool (`EMIT_PLANNER_RESULT` / `EMIT_EXECUTOR_RESULT` / `EMIT_REVIEWER_RESULT`) for envelope-bearing roles; analyst gets no terminal tool. DELETE `parseToolCallsFromResponse` at L52–L56.

- [src/agents/agent-tool-catalog.ts](../../../src/agents/agent-tool-catalog.ts) (`ROLE_TOOL_NAMES`, L77): extend each envelope-bearing role's entry to include its terminal tool name.

- [src/agents/analyst-llm-resolver.ts](../../../src/agents/analyst-llm-resolver.ts): at L163 REPLACE the inline `{ tools, tool_choice: 'auto', stream: false, … }` literal with `buildLlmOptions('analyst', 'tools', tools, modelParams, signal, recorder)`. At L171 REPLACE `result.toolCalls` iteration with `switch (result.kind)` handling `'tools'` (iterate `result.calls` via `RoleToolPolicy.assertAnalystSurfaceTool`) and `'terminal_text'` (prose reply). At L179 change the return shape to the typed union; the method signature becomes `Promise<LlmCompleteResult>`. At L204 `capabilityRequestForLlmOptions` consumes the new shape (response-shape axis is removed in B4).

- [src/agents/analyst-handler.ts](../../../src/agents/analyst-handler.ts): at L70–L106 (`trimToCleanToolBoundary`) REPLACE the inline `JSON.parse(content)` + `.toolCalls?.[]` enumeration with one `parseToolCallMessage(content)` per persisted row. At L286–L300 REWRITE to consume the new `LlmCompleteResult` union (`'tools'` iterates calls; `'terminal_text'` is the assistant reply). At L300 REPLACE the wrapper write with one `serializeToolCallMessage(call)` row per call.

- [src/agents/fake-agent.ts](../../../src/agents/fake-agent.ts) (L86): REWRITE the fixture writer to emit one `serializeToolCallMessage(call)` row per call.

**Files modified — production-source legacy-wrapper migration**

- [src/agents/session-persistence.ts](../../../src/agents/session-persistence.ts) at L379–L420 — DELETE the local `parseToolCalls(content)` helper that reads `JSON.parse(content).toolCalls`. REWRITE `findUniqueUnresolvedActivateCardToolCall` so that for each `assistant` / `tool_call` row at L395 (and L415's matches loop) it calls `parseToolCallMessage(message.content)` exactly once, yielding a single `ToolCall`. A legacy wrapper raises `LegacyMessageShapeError` (no silent ignore, no backward-compat fallback). The function then inspects that one `ToolCall`'s `function.name === 'activate_card'` and resolves `cardId` from `function.arguments` exactly as today.

- [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) at L234–L264 — DELETE both inline `JSON.parse(message.content) as { toolCalls?: ... }` blocks (specifically the loops at L239–L242 and L254–L255). REWRITE `findUnresolvedActivateCards` so each `assistant` / `tool_call` row yields exactly one `ToolCall` via `parseToolCallMessage(message.content)` (one row, one call). A legacy wrapper raises `LegacyMessageShapeError` and propagates.

**Files modified — recovery policy + recorder + exchange schema + event catalog**

- [src/agents/invocation-recovery-policy.ts](../../../src/agents/invocation-recovery-policy.ts) at L120: ADD a branch for `error instanceof LlmContractMismatchError` returning `{ action: 'fail_invocation', markFailed: false, appendModelIssue: true, abort: true, cooldownMs: 0 }` (covers all seven subtypes).

- [src/agents/llm-recording.ts](../../../src/agents/llm-recording.ts) at L47–L55 (`LlmRecorderRequest`): ADD `terminalTool: string | null`. ADD pure function `deriveTerminalTool(opts: LlmCompleteOptions): string | null` returning `opts.tool_choice.kind === 'required_named' ? opts.tool_choice.toolName : (opts.tools.find(t => OTHER_ROLE_TERMINALS.has(t.function.name))?.function.name ?? null)`. Forward `terminalTool` through `beginRecordedExchange` into `BeginExchangeInput`.

- [src/agents/llm-exchange-recorder.ts](../../../src/agents/llm-exchange-recorder.ts) at L32–L39 (`BeginExchangeInput`): ADD `terminalTool: string | null`. At L98–L102 INCLUDE `terminalTool: meta.terminalTool` in the `attempt: ExchangeAttempt` literal.

- [src/agents/llm-openai-chat-gateway.ts](../../../src/agents/llm-openai-chat-gateway.ts) (L52) and [src/agents/llm-openai-codex-gateway.ts](../../../src/agents/llm-openai-codex-gateway.ts) (L54–L60): at both `beginRecordedExchange(opts?.recorder, { … })` call sites, ADD `terminalTool: deriveTerminalTool(opts)`.

- [src/contracts/llm-exchange.ts](../../../src/contracts/llm-exchange.ts) (L23–L31, `exchangeAttemptSchema`): ADD `terminalTool: z.enum(['emit_planner_result','emit_executor_result','emit_reviewer_result']).nullable()` (required field — no `.optional()`).

- [src/schemas/event-catalog.ts](../../../src/schemas/event-catalog.ts) (`EventRegistry.invocation_succeeded`): ADD `terminal_tool: z.enum(['emit_planner_result','emit_executor_result','emit_reviewer_result'])` (NON-NULLABLE, REQUIRED).

- [src/schemas/types.ts](../../../src/schemas/types.ts) (L155, `InvocationSucceededEvent`): ADD `terminal_tool: 'emit_planner_result' | 'emit_executor_result' | 'emit_reviewer_result';` (non-optional).

- [src/schemas/validators.ts](../../../src/schemas/validators.ts) (L165, `invocationSucceededEventSchema`): extend `.extend({ ... })` with the same enum.

**Files modified — consumer-test fixture rewrites (must land in the same commit)**

- [tests/utils/runtime-project-planner-control-flow.test.ts](../../../tests/utils/runtime-project-planner-control-flow.test.ts) at L20–L22 — call `parseToolCallMessage` instead of inline `JSON.parse` on a wrapper.
- [tests/utils/runtime-executor-fallback-evidence.test.ts](../../../tests/utils/runtime-executor-fallback-evidence.test.ts) at L86 and L158 — append one `serializeToolCallMessage(call)` per call.
- [tests/agents/session-persistence.test.ts](../../../tests/agents/session-persistence.test.ts) at L328 and L337 — rewrite fixtures to one-call-per-row; the new `tests/agents/session-persistence-legacy-wrapper.test.ts` (created above) covers the rejection.
- [tests/agents/agent-runtime.test.ts](../../../tests/agents/agent-runtime.test.ts) at L140 and L181 — rewrite fixtures.
- [tests/agents/codex-deferred-activate-card.test.ts](../../../tests/agents/codex-deferred-activate-card.test.ts) at L71 — rewrite fixture.
- [tests/agents/agent-adapter-reviewer-prompt.test.ts](../../../tests/agents/agent-adapter-reviewer-prompt.test.ts) at L134 — rewrite fixture.
- [tests/agents/agent-adapter-load-skill.test.ts](../../../tests/agents/agent-adapter-load-skill.test.ts) at L201, L253, L461 — rewrite fixtures; DELETE the `callParseToolCalls(JSON.stringify({ toolCalls: [] }))` case at L237.
- [tests/agents/analyst-handler.test.ts](../../../tests/agents/analyst-handler.test.ts) and [tests/agents/analyst-llm-resolver.test.ts](../../../tests/agents/analyst-llm-resolver.test.ts) — fixtures rewritten to one-row-per-call and to the new `LlmCompleteResult` union.
- [tests/agents/llm-stream-parser.test.ts](../../../tests/agents/llm-stream-parser.test.ts) and [tests/agents/llm-codex-parser.test.ts](../../../tests/agents/llm-codex-parser.test.ts) — assert the new return type; `function.arguments` remains an unparsed string.
- [web/src/__tests__/analyst-chat-panel.test.ts](../../../web/src/__tests__/analyst-chat-panel.test.ts) at L31 — rewrite fixture.
- [web/src/__tests__/analyst-chat-store.test.ts](../../../web/src/__tests__/analyst-chat-store.test.ts) at L85 — rewrite fixture.
- [web/src/__tests__/agents-view.test.ts](../../../web/src/__tests__/agents-view.test.ts) at L72 and L256 — rewrite fixtures.
- [web/src/__tests__/tool-presenters/_helpers.ts](../../../web/src/__tests__/tool-presenters/_helpers.ts) at L4 — helper emits single-`ToolCall` row strings.

**Files deleted**

- [tests/agents/agent-adapter-force-final-answer.test.ts](../../../tests/agents/agent-adapter-force-final-answer.test.ts) — `forceFinalAnswer` no longer exists.
- [tests/agents/agent-tool-executor.test.ts](../../../tests/agents/agent-tool-executor.test.ts) at L35 — DELETE only the `parseToolCallsFromResponse` case; keep the file if any unrelated cases remain (verify with `grep -n 'describe\|it(' tests/agents/agent-tool-executor.test.ts`).

**Validation (B2)**

- `npx tsc --noEmit` — GREEN.
- `npm run build` — GREEN.
- `npm test -- --run` (full suite) — GREEN. Specifically: `tests/agents/llm-options-factory.test.ts`, `tests/agents/llm-openai-chat-gateway-{request,response}.test.ts`, `tests/agents/llm-openai-codex-gateway-{request,response}.test.ts`, `tests/agents/llm-stream-parser.test.ts`, `tests/agents/llm-codex-parser.test.ts`, `tests/agents/agent-llm-gateway.test.ts`, `tests/agents/agent-adapter-invoke-{happy-path,direct-terminal,escalation}.test.ts`, `tests/agents/analyst-handler-result-union.test.ts`, `tests/agents/invocation-recovery-policy-contract-mismatch.test.ts`, `tests/contracts/llm-exchange-terminal-tool.test.ts`, `tests/schemas/event-catalog-terminal-tool.test.ts`, `tests/schemas/validators-terminal-tool.test.ts`, `tests/schemas/types-terminal-tool.test.ts`, `tests/agents/session-persistence-legacy-wrapper.test.ts`, `tests/runtime/runtime-legacy-wrapper.test.ts`, plus every rewritten fixture file listed above.
- Grep checkpoints: `grep -n 'response_format' src/agents/llm-openai-chat-gateway.ts` → no hits; `grep -n 'parallel_tool_calls' src/agents/llm-openai-codex-gateway.ts` → only `false`; `grep -rn 'handleToolCallsLoop\|forceFinalAnswer\|parseToolCallsFromResponse\|parsePersistedToolCalls' src/` → no hits; `grep -n '\.toolCalls' src/agents/session-persistence.ts src/runtime/runtime.ts` → no hits.

**Commit message (B2)**

```
F05: flip LlmCompleteOptions/Result/CallFn to tools-only union; rewrite gateways, adapter, analyst, session-persistence, runtime, and consumer fixtures in one coherent commit
```

---

### Batch B3 — Delete `result-parser.ts` family + integration-test rewrite

Goal: result-parser.ts and its tests are dead after B2 (no consumer left in `src/`). Delete them and rewrite the integration test that still references the deleted parser surface. The Zod schemas already live in `role-envelope-schemas.ts` (moved in B1).

**Files modified**

- [tests/agents/integration.test.ts](../../../tests/agents/integration.test.ts) at L18–L20 and L39–L41 — DELETE the imports of `parsePlannerResult` / `parseExecutorResult` / `parseReviewerResult` / `extractJson` / `ResultParseError`. At L151 REWRITE the planner case to drive `AgentAdapter.invokeAgent` against a fake gateway returning a terminal `emit_planner_result` tool call with valid JSON args; assert the returned envelope parses against `PlannerResultSchema`. At L183 same for executor with `emit_executor_result`. At L214 same for reviewer with `emit_reviewer_result`.

**Files deleted**

- [src/agents/result-parser.ts](../../../src/agents/result-parser.ts) — DELETE outright (the schemas have already been moved in B1; `extractJson`, `parsePlannerResult`, `parseExecutorResult`, `parseReviewerResult`, `buildExecutorFallbackResult`, `ResultParseError` are gone). If any unrelated helper remains, move it into a topical neighbour file and then delete; do not keep the file alive as a near-empty module.
- [tests/agents/result-parser.test.ts](../../../tests/agents/result-parser.test.ts) — DELETE outright.
- [tests/agents/agent-adapter-executor-fallback.test.ts](../../../tests/agents/agent-adapter-executor-fallback.test.ts) — DELETE outright (`buildExecutorFallbackResult` is gone).

**Validation (B3)**

- `npx tsc --noEmit` — GREEN.
- `npm test -- --run tests/agents/integration.test.ts` — GREEN.
- `npm test -- --run` — GREEN.
- Grep: `grep -rn 'extractJson\|parsePlannerResult\|parseExecutorResult\|parseReviewerResult\|ResultParseError\|buildExecutorFallbackResult' src/ web/src/ tests/` → no hits.

**Commit message (B3)**

```
F05: delete result-parser.ts family (schemas already in role-envelope-schemas.ts since B1)
```

---

### Batch B4 — Capability axis cleanup (delete `envelopeMode` / `responseShape`)

Goal: replace the legacy capability axes with `{ toolsMode, exclusiveToolChoiceSupport }`; rewrite `capabilityRequestForLlmOptions`; migrate every capability fixture.

**Files modified**

- [src/agents/provider-capabilities.ts](../../../src/agents/provider-capabilities.ts): replace `EffectiveProviderCapabilities`'s tool-related axes with `toolsMode: 'native' | 'unsupported'` and `exclusiveToolChoiceSupport: 'native' | 'parallel_off' | 'unsupported'`. DELETE any `responseFormat` / `envelopeMode` / `responseShape` axis. At L53 (`BUILTIN_CAPABILITIES`) set `opencode`, `opencode-go`, `github-copilot`, `nvidia-nim` to `{ toolsMode: 'native', exclusiveToolChoiceSupport: 'native' }`; set `openai-codex` to `{ toolsMode: 'native', exclusiveToolChoiceSupport: 'parallel_off' }`. At L127 (`capabilityRequestForLlmOptions`) derive `requiresExclusiveToolChoice: true` for every role invocation; skip candidates with `toolsMode === 'unsupported'` or `exclusiveToolChoiceSupport === 'unsupported'`.
- [tests/agents/agent-adapter-recovery.test.ts](../../../tests/agents/agent-adapter-recovery.test.ts), [tests/agents/config-schema.test.ts](../../../tests/agents/config-schema.test.ts), [tests/agents/llm-client-integration.test.ts](../../../tests/agents/llm-client-integration.test.ts), [tests/agents/model-router.test.ts](../../../tests/agents/model-router.test.ts), [tests/agents/provider.test.ts](../../../tests/agents/provider.test.ts) — REPLACE each `capabilities: { toolCalls: 'native' }` fixture with `capabilities: { toolsMode: 'native', exclusiveToolChoiceSupport: 'native' }` (or `'parallel_off'` for the Codex case).

**Files created**

- [tests/agents/provider-capabilities-axis.test.ts](../../../tests/agents/provider-capabilities-axis.test.ts) — assert the built-in table values per provider; assert `capabilityRequestForLlmOptions` always emits `requiresExclusiveToolChoice: true`.

**Validation (B4)**

- `npx tsc --noEmit` — GREEN.
- `npm test -- --run tests/agents/provider-capabilities-axis.test.ts tests/agents/agent-adapter-recovery.test.ts tests/agents/model-router.test.ts tests/agents/provider.test.ts tests/agents/config-schema.test.ts tests/agents/llm-client-integration.test.ts` — GREEN.
- `npm test -- --run` — GREEN.
- Grep: `grep -rn 'envelopeMode\|responseShape\|response_format' src/ tests/` → no hits.

**Commit message (B4)**

```
F05: swap capability axes to toolsMode + exclusiveToolChoiceSupport; delete envelopeMode/responseShape
```

---

### Batch B5 — Web migration (presenters, stores, viewer, event-log badge)

Goal: migrate `web/` to the one-row-per-tool-call format and render the `terminal_tool` badge.

**Files modified**

- [web/src/utils/tool-presenters/helpers.ts](../../../web/src/utils/tool-presenters/helpers.ts) at L68–L78 — RENAME `readToolCallEnvelope` to `readToolCallMessage`; rewrite to return `{ name, args }` from a single `ToolCall` row using `parseToolCallMessage` from [web/src/utils/persistedToolCall.ts](../../../web/src/utils/persistedToolCall.ts).
- [web/src/utils/tool-presenters/registry.ts](../../../web/src/utils/tool-presenters/registry.ts) at L1 — switch import to `readToolCallMessage`. At L21 — call `readToolCallMessage(rawContent, fallbackName)`; rename local `envelope` → `message`.
- [web/src/stores/analystChat.ts](../../../web/src/stores/analystChat.ts) at L99–L108 (`toolInvocationMatchesMessage`) — compare against a single `ToolCall` per row.
- LLM-exchange viewer component (locate via `grep -rln 'terminalTool\|LlmExchange' web/src/components/`): render the terminal-tool badge when `attempt.terminalTool !== null`; hide otherwise.
- Event-log row component: render the `terminal_tool` label for `invocation_succeeded` events; render no badge for events lacking the field.

**Files created**

- [web/src/__tests__/llm-exchange-viewer-terminal-tool.test.ts](../../../web/src/__tests__/llm-exchange-viewer-terminal-tool.test.ts) — assert badge renders per role; hidden on `null`.
- [web/src/__tests__/event-log-terminal-tool.test.ts](../../../web/src/__tests__/event-log-terminal-tool.test.ts) — assert label per role; absent on events without the field.

**Validation (B5)**

- `workbench.action.files.saveAll`, then `grep -c '<script setup>' web/src/**/*.vue` — every file ≤ 1.
- `npx tsc --noEmit` — GREEN.
- `npm run build` — GREEN (also catches the Vue SFC duplicate-block class of bug).
- `npm test -- --run web/src/__tests__/tool-presenters.test.ts web/src/__tests__/analystChat.test.ts web/src/__tests__/llm-exchange-viewer-terminal-tool.test.ts web/src/__tests__/event-log-terminal-tool.test.ts` — GREEN.
- `npm test -- --run` — GREEN.

**Commit message (B5)**

```
F05: web — rename to readToolCallMessage, one-row-per-toolcall reads, render terminal_tool badge
```

---

### Batch B6 — Final sweep, dead-code grep checks, and live-probe playbook

Goal: enforce the "no legacy wrapper survives" invariant with explicit grep checks; ship the opt-in live probe and run it against the `saivage-v3` LXC harness.

**Files created**

- [scripts/probe-llm-contract.ts](../../../scripts/probe-llm-contract.ts) — per provider configured in `.saivage/saivage.json`, issue one role invocation that (a) executes at least one action tool call and (b) terminates via `emit_<role>_result`. Assert the envelope parses against the role's Zod schema. Reads ONLY `.saivage/saivage.json` (never `.saivage/auth-profiles.json`, never any `apiKey` / `token` field). Output: machine-readable JSON, one line per `{provider, role, status}`.
- [scripts/README-probe-llm-contract.md](../../../scripts/README-probe-llm-contract.md) — usage notes plus the deploy-then-probe sequence below.
- [scripts/check-no-legacy-toolcalls-wrapper.sh](../../../scripts/check-no-legacy-toolcalls-wrapper.sh) — CI-callable script that runs the sweep commands below and exits non-zero on any hit.

**Sweep commands (must all return empty / zero)**

```bash
# 1. No production source reads the legacy {toolCalls:[...]} wrapper anywhere.
grep -rn "\.toolCalls" src/ | grep -v deprecated
# Expected: empty. The only allowed surviving reference is inside
# scripts/check-no-legacy-toolcalls-wrapper.sh itself (the deletion-checker tool),
# which is in scripts/ not src/, so the grep above never matches it.

# 2. No deleted-surface name survives anywhere under src/, web/src/, or tests/.
grep -rn "response_format\|extractJson\|parsePersistedToolCalls\|parseToolCallsFromResponse\|envelopeMode\|responseShape\|forceFinalAnswer\|handleToolCallsLoop\|ResultParseError\|buildExecutorFallbackResult\|parsePlannerResult\|parseExecutorResult\|parseReviewerResult\|LlmEnvelopeOptions" src/ web/src/ tests/
# Expected: empty.

# 3. No persisted wrapper literal survives in test fixtures.
grep -rn "toolCalls:" tests/ web/src/__tests__/ web/src/utils/ | grep -v "capabilities:"
# Expected: empty.

# 4. Every gateway request omits response_format and forces parallel_tool_calls:false.
grep -n "response_format" src/agents/llm-openai-chat-gateway.ts src/agents/llm-openai-codex-gateway.ts
# Expected: empty.
grep -n "parallel_tool_calls" src/agents/llm-openai-chat-gateway.ts src/agents/llm-openai-codex-gateway.ts | grep -v "false"
# Expected: empty.
```

**Operator playbook (live probe)**

```bash
# 1. Build and deploy to saivage-v3 container
npm run build
ssh root@10.0.3.112 'systemctl stop saivage.service'
rsync -a --delete dist/ root@10.0.3.112:/opt/saivage-v3/dist/
ssh root@10.0.3.112 'systemctl start saivage.service'
curl -fsS http://10.0.3.112:8080/health

# 2. Run the probe on the container (reads /work/saivage-v3/.saivage/saivage.json only)
ssh salva@10.0.3.112 'cd /work/saivage-v3 && node /opt/saivage-v3/dist/scripts/probe-llm-contract.js'

# 3. Triage: every line MUST show status: "ok". Any "contract_mismatch:<subtype>"
#    failure is a wire-level contract bug — capture the line, file under the
#    relevant F-issue.
```

**Validation (B6)**

- `npx tsc --noEmit` — GREEN.
- `npm test -- --run` — GREEN.
- `bash scripts/check-no-legacy-toolcalls-wrapper.sh` — exit 0.
- Live probe on `saivage-v3` shows `status: "ok"` for every `(provider, role)` row currently configured.

**Commit message (B6)**

```
F05: add legacy-wrapper sweep script and probe-llm-contract live playbook
```

---

## 4. Production-source legacy-wrapper migration (explicit assignment)

The two production-source readers of the legacy persisted `{ toolCalls: [...] }` wrapper are migrated in **Batch B2** (the contract-flip commit). Repeated here so an implementer cannot finish the plan with either surviving:

- [src/agents/session-persistence.ts](../../../src/agents/session-persistence.ts) — `parseToolCalls(content)` at L379 (consumed by `findUniqueUnresolvedActivateCardToolCall` at L380–L384 iteration and L415 matches loop). Migration in **B2**: delete the local helper; replace each row read with one `parseToolCallMessage(message.content)` call; raise `LegacyMessageShapeError` on a wrapper row. New test: [tests/agents/session-persistence-legacy-wrapper.test.ts](../../../tests/agents/session-persistence-legacy-wrapper.test.ts).
- [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) — `findUnresolvedActivateCards` at L234–L264 with two inline `JSON.parse(message.content) as { toolCalls?: ... }` loops at L239–L242 and L254–L255. Migration in **B2**: delete both inline parses; each row yields exactly one `ToolCall` via `parseToolCallMessage`. New test: [tests/runtime/runtime-legacy-wrapper.test.ts](../../../tests/runtime/runtime-legacy-wrapper.test.ts).

The B6 sweep (`grep -rn "\.toolCalls" src/ | grep -v deprecated`) is the post-condition that no `.toolCalls` wrapper reader can survive in production source.

---

## 5. Risk register and per-batch rollback

### Per-batch rollback plan

| Batch | Failure symptom | Rollback action |
| --- | --- | --- |
| B1 | New module unit test red, schema-move regression in `result-parser.test.ts`, or import of `LlmContractMismatchError` fails downstream. | `git revert HEAD`. The schema move is purely identifier-aliased; redo the batch after verifying `result-parser.ts`'s imports compile and the existing parser tests still pass. |
| B2 | Any compile or test failure in the full suite. | `git revert HEAD`. The commit is atomic; bisect the substrate vs consumer vs persistence vs recorder edits offline, then reapply as a single commit. Do NOT split into intermediate commits with broken tree — that violates the green-checkpoint rule. |
| B3 | Residual caller of a deleted parser surface. | `git revert HEAD`. Re-run the B3 grep; address each survivor in the same commit before reapplying. |
| B4 | Router skips every candidate (no provider selectable) or capability fixture mismatch. | `git revert HEAD`. Verify `BUILTIN_CAPABILITIES` values (`'parallel_off'` for `openai-codex`, `'native'` for the other four) before reapplying. |
| B5 | Vue build red, SFC duplicate-block error, or web test red. | `git revert HEAD`. Run `grep -c '<script setup>' web/src/**/*.vue`; restart VS Code per workspace memory note before re-editing. |
| B6 | Live probe returns `contract_mismatch:<subtype>` for a real provider. | NOT a rollback — the runtime change is correct; the probe just discovered a wire bug. File a follow-up F-issue. If the probe script itself crashes, revert only the script-add commit. |

### Single biggest risk

The chat-vs-Codex `tool_choice` JSON shape leak. If the per-provider translation is mis-implemented in either builder — for example, the Codex builder emits the nested `{ type: 'function', function: { name } }` instead of the flat `{ type: 'function', name }`, or the chat builder emits the flat shape — the Codex Responses transport will silently accept the request and either ignore the forced tool choice or 400 on it intermittently. The mitigation is in B2: two SEPARATE test files (`llm-openai-chat-gateway-request.test.ts` and `llm-openai-codex-gateway-request.test.ts`) assert the wire JSON shape against per-provider literal objects, AND assert the terminal-phase `body.tools.length === 1` per provider. A shared assertion helper that compared both shapes against the same expectation would re-introduce the bug.

The secondary risk in B2 is the size of the commit. Mitigation: stage the edits in the listed order (substrate types → gateways → adapter → analyst → persistence → runtime → recovery policy → recorder → schemas → consumer-test fixture rewrites → deletions). Run `npx tsc --noEmit` after staging each block (do NOT commit between blocks); only commit when the whole tree compiles and the full suite is green.

---

## 6. Acceptance criteria

Every invariant from the approved analysis maps to a named passing test. After B6, the following test names exist and pass:

| Analysis invariant | Test(s) |
| --- | --- |
| 1. Single-carrier per turn | `tests/agents/llm-options-factory.test.ts > buildLlmOptions__rejects_phase_terminal_for_analyst`; `> buildLlmOptions__phase_terminal_returns_single_tool_array` (per role); `> buildLlmOptions__phase_terminal_throws_when_terminal_tool_missing_from_catalog`; structural — `LlmCompleteOptions` is `LlmToolsOptions` only (no `LlmEnvelopeOptions` export, enforced by B6 grep). |
| 2. Single-carrier per result | `tests/agents/llm-openai-chat-gateway-response.test.ts > returns_kind_tools_for_tool_call`, `> returns_kind_terminal_text_for_prose_only`; same in `llm-openai-codex-gateway-response.test.ts`. |
| 3. No string-flatten in the gateway | `tests/agents/agent-llm-gateway.test.ts > createLlmCallFn__returns_structured_LlmCompleteResult`; B6 grep check #2 (`content ?? JSON.stringify` no hits). |
| 4. No per-turn option drift | `tests/agents/agent-adapter-invoke-happy-path.test.ts > uses_buildLlmOptions_for_every_turn`; `tests/agents/agent-adapter-invoke-escalation.test.ts > escalation_turn_options_have_single_terminal_tool`; structural — `agent-adapter.ts` contains zero inline `LlmCompleteOptions` literals. |
| 5. Envelope parsed by typed schema, not text heuristics | `tests/agents/parse-role-envelope-arguments.test.ts > terminal_arguments_not_json__rejects_unparseable_arguments_<role>` (per role); `> terminal_arguments_schema_mismatch__rejects_zod_invalid_envelope_<role>` (per role); deletion of `tests/agents/result-parser.test.ts`. |
| 6. Capability surface admits the new shape | `tests/agents/provider-capabilities-axis.test.ts > builtins_have_correct_toolsMode_and_exclusiveToolChoiceSupport`; `> capabilityRequestForLlmOptions_always_requires_exclusive_tool_choice`. |
| 7. Codex Responses is a first-class participant | `tests/agents/llm-openai-codex-gateway-request.test.ts > codex_request__phase_terminal_uses_flat_function_tool_choice`; `> codex_request__phase_terminal_sends_exactly_one_tool_with_flat_name`; `> codex_request__never_sends_response_format`. |
| 8. Typed failures; contract mismatch does not cooldown | `tests/agents/invocation-recovery-policy-contract-mismatch.test.ts > <subtype>__classifies_as_fail_invocation_no_cooldown` (one per subtype). |
| 9. No backward-compat shim survives | `tests/agents/persisted-tool-call.test.ts > parseToolCallMessage__raises_LegacyMessageShapeError_on_wrapper_input`; `tests/agents/session-persistence-legacy-wrapper.test.ts > findUniqueUnresolvedActivateCardToolCall__raises_LegacyMessageShapeError_on_wrapper_row`; `tests/runtime/runtime-legacy-wrapper.test.ts > findUnresolvedActivateCards__raises_LegacyMessageShapeError_on_wrapper_row`; B6 grep checks #1–#4. |
| 10. Tests cover the matrix AND every direct consumer | `tests/agents/agent-adapter-invoke-{happy-path,direct-terminal,escalation}.test.ts` (adapter path); `tests/agents/analyst-handler-result-union.test.ts` (analyst path); per-provider request and response tests in `tests/agents/llm-openai-{chat,codex}-gateway-{request,response}.test.ts`. |

Additional plan-only acceptance:

- All six §4.3 rejection subtypes have a dedicated test in `tests/agents/terminal-protocol.test.ts` whose name embeds the subtype.
- `tests/agents/parse-role-envelope-arguments.test.ts` covers the seventh family (`terminal_arguments_not_json`, `terminal_arguments_schema_mismatch`) across all three envelope-bearing roles.
- `tests/agents/llm-options-factory.test.ts > buildLlmOptions__phase_terminal_returns_single_tool_array`, the two chat/codex request tests `*__phase_terminal_sends_exactly_one_tool*`, and the adapter escalation test `escalation_turn_options_have_single_terminal_tool` jointly enforce the terminal-only invariant at three layers (factory, wire builder, adapter).
- `tests/agents/zod-to-jsonschema-mini.test.ts` proves the local converter handles every node used by the three role schemas — including `ZodUnknown` and `ZodRecord` — and reports JSON-schema outputs that match the schemas as they exist at HEAD (planner strict, executor non-strict with `result` as a record-of-unknown, reviewer strict).
- `LlmExchange.attempts[].terminalTool` is `.nullable()` and `invocation_succeeded.terminal_tool` is non-nullable; tests in `tests/contracts/llm-exchange-terminal-tool.test.ts` and `tests/schemas/event-catalog-terminal-tool.test.ts` assert both shapes.
- Live probe on `saivage-v3` returns `status: "ok"` for every `(provider, role)` row in `.saivage/saivage.json`.

---

## 7. F-issue closure list

This plan, when fully landed, **closes** the following sibling F-issues:

- **F01** — `response_format` + `tools[]` requested together. Closed. The `LlmEnvelopeOptions` variant does not exist under Proposal L; `response_format` is never present on any `LlmCompleteOptions` value or wire request. B2 deletes the variant and the gateway forwarding branch.
- **F02** — DeepSeek prose breaks `extractJson`. Closed. `extractJson` is deleted in B3; prose responses arrive as `kind: 'terminal_text'` from the gateway and are rejected by `validateTerminalProtocol` as `terminal_prose_only` on the forced terminal turn.
- **F09** — `extractJson` brace-span fallback can extract wrong substring. Closed. Same deletion as F02.
- **F10** — `response_format` is not modelled as a capability. Closed by deletion. Under Proposal L `response_format` is never on the wire; the capability axis is explicitly NOT added (B4 names the prohibition).
- **F11** — `response_format` dropped on follow-up turn; tool calls dropped when content non-empty. Closed. Sub-bug (a) is impossible because `buildLlmOptions` is the only option assembler and is called identically on every turn (B2). Sub-bug (b) is impossible because the gateway returns a typed union; mixed responses surface as `{ kind: 'tools', calls, rawAssistantText: <content> }` with calls preserved (B2).

This plan does **not** close the following sibling F-issues (separate scopes):

- **F03** — cooldown ignores `Retry-After` and never persists.
- **F04** — broader observability schemas (F05 adds `terminal_tool` only).
- **F06** — typed tool-definition serializer (possibly absorbed; follow-up decision).
- **F07** — fallback-chain duplication (F05 deletes `buildExecutorFallbackResult` only).
- **F08** — failure classifier is HTTP-status-only and string-regex (F05 adds the `LlmContractMismatchError` branch only).

---

End of plan.
