# Stage 001 — Real LLM Analyst Resolver — Design

## Goal

Replace the stub `LlmIntentResolver` in [saivage-v3/src/agents/analyst-llm-resolver.ts](saivage-v3/src/agents/analyst-llm-resolver.ts) with a real implementation that routes every analyst chat turn through the existing OpenAI-compatible LLM pipeline ([saivage-v3/src/agents/llm-client.ts](saivage-v3/src/agents/llm-client.ts), [saivage-v3/src/agents/model-router.ts](saivage-v3/src/agents/model-router.ts), [saivage-v3/src/agents/provider.ts](saivage-v3/src/agents/provider.ts)) under role `analyst`, and remove the offline keyword pathway (`parseIntent`, `runOfflineFallback`, helpers, `HELP_TEXT`, `lastIntent`) from [saivage-v3/src/agents/analyst-handler.ts](saivage-v3/src/agents/analyst-handler.ts). After S01 the analyst chat is conversational by construction. When `models.analyst` resolves to no candidate, or every configured candidate fails authentication, the chat replies with the SPEC-r7 `analyst is offline` failure string and invokes no tool.

S01 owns exactly the four primitives the master plan §S01 description pins:

1. Real LLM call through `LlmClient.complete` under role `analyst` (the resolver is no longer a stub).
2. Offline behaviour: when no candidate resolves, or every candidate fails authentication, no mutating tool is invoked and the reply contains the literal substring `analyst is offline`.
3. Immediate-prior conversation context carry-over: the user message and assistant message from the immediately preceding turn are present in the `messages` payload sent to the provider on the next turn, so the model can resolve deictic references against them.
4. One-clarification-round behaviour: when the LLM returns a content-only reply (no `tool_calls`), the handler does not invoke any tool on that turn and waits for the user's next input.

## Scope

### In scope

- Real implementation of `LlmIntentResolver` in [saivage-v3/src/agents/analyst-llm-resolver.ts](saivage-v3/src/agents/analyst-llm-resolver.ts): `isAvailable()` reflects whether role `analyst` resolves to at least one candidate; `chat(messages, projectContext)` performs a real OpenAI-compatible chat-completions request via the shared `LlmClient` transport and returns the `{ content, toolCalls }` shape `AnalystHandler.runAnalystLoop` already consumes.
- Deletion from [saivage-v3/src/agents/analyst-handler.ts](saivage-v3/src/agents/analyst-handler.ts) of `parseIntent`, `runOfflineFallback`, the `extract*` helper family, `refineIntentFromUserContent`, `ParsedIntent`, the `lastIntent` map, `HELP_TEXT`, and the `deterministicIntent` early-exit at the top of `handleMessageSerial`.
- Refactor of `handleMessageSerial` so it ALWAYS routes through `runAnalystLoop` when the resolver is available, and emits the SPEC-r7 `analyst is offline` reply otherwise.
- System prompt for the analyst that S01 owns (literal block under "System prompt (S01 baseline)" below). Later stages refine it.
- Deletion of any backend or web test that asserted the offline keyword pathway (the behaviour it described is gone). NO edit to [saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json](saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json) is performed by S01; the S00 baseline is an immutable input to S01.
- A backend Jest integration test at [saivage-v3/tests/agents/analyst-llm-resolver.integration.test.ts](saivage-v3/tests/agents/analyst-llm-resolver.integration.test.ts) that exercises a real `AnalystHandler` against a temporary project root with a mocked `fetch` transport intercepting `LlmClient.complete` traffic.

### Out of scope (explicitly belongs to a later stage)

- Tool surface alignment with SPEC-r7 capability classes (adding `reorder_child`, `navigate_workspace`, `start_project`, `stop_project`, `restart_card_or_subtree`, `mark_goal_needs_corrections`, MCP add/edit/remove tools, role-routing tools, failover-order tools, redacted `show_config`; removing `add_note`, `list_notes`, `get_note`, `mark_note_handled`). Owned by S02.
- Centralised audit-wrapped invocation entry point that every mutating analyst tool funnels through, the non-secret inspection boundary, and the response-shape primitives that the SPEC-r7 tool surface vocabulary requires. Owned by S02.
- Card model: ordered children and bounded move. Owned by S03.
- Notification primitive: queue-only ephemeral. Owned by S04.
- Persistent right-side analyst panel and workspace shell restructure. Owned by S05.
- UI removal of mutating affordances. Owned by S06.
- Operator API mutating-route pruning. Owned by S07.
- Analyst-driven SPA navigation and workspace-context awareness on the chat turn. Owned by S08.
- Operator events surface cleanup. Owned by S09.

S01 does NOT introduce any response-shape strings tied to the SPEC-r7 tool surface vocabulary. Those response-shape primitives are deferred to a later stage per master plan; pre-committing them in S01 would lock the later stage into a shape it has not yet chosen.

## Resolver architecture

S01 picks **Option A: resolver-owned local `ProviderRegistry`**. The resolver is constructed per project root and owns its own registry, router, and `LlmClient` cache; no constructor signature changes on `AnalystHandler` or on `getAnalystHandler`, and no call sites elsewhere in the repo need to change.

Rationale for picking A over injecting a shared runtime registry into `AnalystHandler`:

- Master plan §S01 scopes the stage to the resolver, not to a runtime-wide injection refactor. Option B (inject shared registry/router) would touch [saivage-v3/src/agents/analyst-handler.ts](saivage-v3/src/agents/analyst-handler.ts), [saivage-v3/src/agents/index.ts](saivage-v3/src/agents/index.ts), [saivage-v3/src/server/websocket.ts](saivage-v3/src/server/websocket.ts), [saivage-v3/src/server/routes/chats-files-debug.ts](saivage-v3/src/server/routes/chats-files-debug.ts), [saivage-v3/src/telegram/bot.ts](saivage-v3/src/telegram/bot.ts), [saivage-v3/tests/analyst.test.ts](saivage-v3/tests/analyst.test.ts), [saivage-v3/tests/server/analyst-tool-invoked-broadcast.test.ts](saivage-v3/tests/server/analyst-tool-invoked-broadcast.test.ts), and [saivage-v3/tests/utils/agents-module-boundary.test.ts](saivage-v3/tests/utils/agents-module-boundary.test.ts) — every one of those would acquire a new required argument. That breadth is master-plan-scope-creep for S01.
- Sharing the cooldown with planner/executor is NOT in §S01's acceptance list and is NOT a SPEC-r7 requirement; the resolver's local registry can mark a candidate failed for the lifetime of the analyst session without coupling planner/executor cooldown to it. If a later stage discovers that cooldown sharing is required, it can ship a focused refactor then.
- The test seam Option A naturally exposes (mocking `globalThis.fetch`) is the same seam `LlmClient` is already tested against in the repo, and observes the resolver's effect via the public `AnalystResponse` returned by `handler.handleMessage(...)` plus the recorded `fetch` calls. No test ever needs to spy on a resolver-private registry handle.

### Construction

`LlmIntentResolver`'s constructor (per project root, one instance per `AnalystHandler`):

1. `const { config } = loadConfig(projectRoot);` — explicitly destructures the `{ config, warnings }` result that [saivage-v3/src/agents/config-schema.ts](saivage-v3/src/agents/config-schema.ts) `loadConfig` returns. Warnings are intentionally discarded at construction; the resolver's job is to fail loudly at `chat()` time when the resolved candidate chain is empty, not to surface config warnings.
2. `const registry = new ProviderRegistry(config);` — local to this resolver.
3. `const router = new ModelRouter(config, registry);` — local to this resolver.
4. Captures `runtimeConfig = getRuntimeConfig(config)` for `recoveryDelayMs` and other shared runtime knobs.
5. Initialises an empty `LlmClient` cache keyed by `cacheKey` from `resolveLlmTransportConfig` (same cache shape as `AgentAdapter.createLlmCallFn` in [saivage-v3/src/agents/agent-adapter.ts](saivage-v3/src/agents/agent-adapter.ts)).

`isAvailable()` calls `router.resolve('analyst', capabilityRequest)` and returns `true` iff the chain is non-empty. It performs NO network I/O per the existing `ModelRouter.resolve` contract.

### Per-turn flow

`AnalystHandler.runAnalystLoop` already implements the tool-loop pattern (call resolver, dispatch any returned tool calls, append results to history, loop). S01 changes only what `LlmIntentResolver.chat` does inside one iteration.

For each call to `chat(messages, projectContext)`:

1. Resolve the candidate chain `router.resolve('analyst', capabilityRequest)`. If empty, throw a typed `AnalystOfflineError` whose message begins with the literal substring `analyst is offline`.
2. For each candidate in order: resolve transport via `resolveLlmTransportConfig(projectRoot, registry, candidate)`; get or build an `LlmClient` from the cache.
3. Build the system prompt as `getAnalystSystemPrompt() + '\n\n' + projectContext`.
4. Call `client.complete(candidate, systemPrompt, messages, sessionId, { tools, tool_choice: 'auto', stream: false, temperature, max_tokens, signal, recorder })` exactly once. `messages` is the bounded conversation history `AnalystHandler` has already trimmed via `trimToCleanToolBoundary`.
5. On `LlmAuthError`: call `registry.markFailed(candidate, runtimeConfig.recoveryDelayMs ?? 60000)`, advance to the next candidate. If every candidate fails with auth, throw `AnalystOfflineError`.
6. On `LlmRateLimitError`, `LlmServerError`, `LlmTimeoutError`, or `LlmParseError`: advance to the next candidate. If every candidate fails with a non-auth transport error, rethrow the last error verbatim so `AnalystHandler.runAnalystLoop` surfaces it as the existing `Analyst LLM unavailable: <reason>` reply.
7. On success, return `{ content, toolCalls }` shaped exactly the way `runAnalystLoop` already consumes.

### Streaming

`stream: false` for S01. The analyst handler persists the assistant turn after the loop terminates; partial-token streaming is not required. Later stages may flip it.

### Recorder

`opts.recorder` is the existing `LlmExchangeRecorder` from [saivage-v3/src/agents/llm-exchange-recorder.ts](saivage-v3/src/agents/llm-exchange-recorder.ts), constructed lazily via `createLlmExchangeRecorder({ saivageDir: <projectRoot>/.saivage, sessionId, eventLogger })`. `eventLogger` is read from `this.activeRuntime?.runtime.eventLogger` on `AnalystHandler` and forwarded to the resolver via a setter, or omitted when the resolver is invoked before a runtime is attached.

### Provider rate-limit handling

The resolver-local `registry.markFailed` controls candidate retry within the analyst chat session only. Planner/executor cooldown sharing is explicitly NOT in S01's scope. The integration test asserts that on `LlmAuthError`, the next call to `isAvailable()` still reports the chain available iff there is at least one non-failed candidate; we do not assert any planner-side effect.

## System prompt (S01 baseline)

`getAnalystSystemPrompt()` returns the literal block below at S01. S02 expands the tool surface vocabulary; S08 adds workspace context; S04 collapses notes to notifications. The S01 prompt establishes identity, the available-tools enumeration, and the four S01-owned conversation primitives.

The tool enumeration line `<TOOL_LIST>` is expanded once at module load from `getAnalystToolDefinitions()` so the prompt cannot drift from the registry.

```text
You are the Saivage Analyst — the user's conversational interface to the Saivage system. You inspect, steer, reconfigure, and repair the autonomous runtime by calling tools. You do not perform delivery work yourself; you delegate by creating or editing cards, by queueing notes, and by issuing runtime control actions.

Available tools (call them via the tool-call API channel, never as plain text):
<TOOL_LIST>

Conversational behaviour:
- Resolve deictic references ("this", "the current one", "that card", "and the other one too", "do it") against the IMMEDIATELY PRIOR user turn and the immediately prior assistant turn in this session. If the prior context does not pin a unique referent, ask ONE clarifying question and call NO tool until the user answers.
- When the user's request is genuinely ambiguous (multiple equally plausible target entities, conflicting constraints, or a verb that maps to several tools), ask exactly ONE clarifying question and call NO tool until the user answers. Do not guess.

Safety and grounding:
- Never read or expose secret-bearing files or credentials.
- Do not use shell commands to mutate source, deploy, run delivery builds/tests, or perform planner/executor work. Delegate work through cards, notes, or runtime controls.
- If a tool returns success=false, explain the failure and suggest the next step. Keep replies grounded in fetched data.

Vocabularies (canonical values; do not invent new ones):
- Card status: drafting | backlog | active | running | blocked | changed | done | failed | cancelled.
- Card type: project | goal | architecture | code | test | doc | data | research | ops.
- Urgency: low | normal | high | critical.
- Note kind: comment | progress | directive | escalation.
- AnalystIssue severity: info | warning | blocker.
```

The prompt deliberately scopes itself to S01-owned primitives. It does NOT include any of the tool-surface response-shape vocabulary that later stages introduce. Those response-shape primitives are deferred to a later stage per master plan; the S01 prompt remains silent on them so the later stage can choose its own canonical wording without a pre-existing prompt fragment to renegotiate.

## Deletion of the offline keyword fallback

### Symbols removed from [saivage-v3/src/agents/analyst-handler.ts](saivage-v3/src/agents/analyst-handler.ts)

- `parseIntent`, `refineIntentFromUserContent`, all `extract*` helpers (`extractCardIds`, `extractGoalIds`, `extractProcessIds`, `extractStatus`, `extractPriority`, `extractCardType`, `extractTags`, `extractLines`, `extractTitle`, `extractParentId`, `extractNewParent`, `extractNoteKind`).
- `interface ParsedIntent`.
- `runOfflineFallback(sessionId, userContent)`.
- `HELP_TEXT`.
- The `lastIntent: Map<string, ParsedIntent>` field on `AnalystHandler` and every read/write site.
- The `deterministicIntent` block and the `if (deterministicIntent && ['pause_runtime','resume_runtime'].includes(...))` early-exit at the top of `handleMessageSerial`.

### `handleMessageSerial` shape after S01

After the duplicate-response guard and the user-message append, the body is exactly:

1. `const llmAvailable = await this.llmResolver.isAvailable();`
2. If `!llmAvailable`: persist an assistant-text message whose content is the SPEC-r7 `analyst is offline` reply (the constant exported from [saivage-v3/src/agents/analyst-llm-resolver.ts](saivage-v3/src/agents/analyst-llm-resolver.ts) by Phase A). Return an `AnalystResponse` with `toolInvocations: undefined`.
3. Otherwise, return `await this.runAnalystLoop(sessionId, userContent)`.

Inside `runAnalystLoop` the only change is the `catch (err)` around `this.llmResolver.chat(...)`: when `err instanceof AnalystOfflineError`, persist `err.message` (which begins with `analyst is offline`); for any other error class, keep the existing `Analyst LLM unavailable: <reason>` prefix (ASCII only, no emoji).

## Downstream impact

Per master plan section 6.1, each subsystem touched, the holistic fix, and the gate that catches regressions.

- [saivage-v3/src/agents/analyst-llm-resolver.ts](saivage-v3/src/agents/analyst-llm-resolver.ts): stub `LlmIntentResolver` becomes real; the unused `resolveAnalystLlm` free function and its `AnalystLlmRuntimeOptions` / `AnalystLlmResolvedToolCall` / `AnalystLlmResponse` types are deleted (no caller exists). Holistic fix: replace the body wholesale. Gate: `tsc-build`, `web-vite-build`, plus the new backend integration test.
- [saivage-v3/src/agents/analyst-handler.ts](saivage-v3/src/agents/analyst-handler.ts): all symbols listed above are deleted; `handleMessageSerial` collapses to the three-step body above. Holistic fix: rewrite in one commit, no `// TODO remove later` shim. Gate: `tsc-build`.
- [saivage-v3/src/server/websocket.ts](saivage-v3/src/server/websocket.ts), [saivage-v3/src/server/routes/chats-files-debug.ts](saivage-v3/src/server/routes/chats-files-debug.ts), [saivage-v3/src/telegram/bot.ts](saivage-v3/src/telegram/bot.ts): instantiate `AnalystHandler` (or call `getAnalystHandler`) with the unchanged constructor signature. No edit required. Gate: `tsc-build`.
- Backend Jest tests at [saivage-v3/tests/analyst.test.ts](saivage-v3/tests/analyst.test.ts) and [saivage-v3/tests/server/analyst-tool-invoked-broadcast.test.ts](saivage-v3/tests/server/analyst-tool-invoked-broadcast.test.ts): if any asserts `LlmIntentResolver.isAvailable === false`, asserts `runOfflineFallback` produced `HELP_TEXT`, or pins a `parseIntent` regex outcome, the test is rewritten or deleted because the behaviour is gone. Holistic fix: change the assertion to the new behaviour, or delete when the behaviour is gone by SPEC-r7. Gate: backend Jest run (out of the four-gate set, but compile breakage from a deleted symbol surfaces in `tsc-build` regardless).
- Web Vitest tests under [saivage-v3/web/src/__tests__/](saivage-v3/web/src/__tests__/) that exercise `AnalystChatPanel` and the chat store mock the `sendChatMessage` API at the HTTP boundary; the transport shape over WebSocket and HTTP is unchanged by S01. They should remain green. Gate: `web-vitest`.
- E2E analyst suite at [saivage-e2e-checkers/e2e/analyst/scenarios.spec.js](saivage-e2e-checkers/e2e/analyst/scenarios.spec.js): scenarios that were previously LIMITATION because the chat was keyword-only may now reach a real model. The four-gate driver counts LIMITATION-coded scenarios as non-failures (the S00 baseline records `failing_ids: []` for `analyst-e2e`), so a scenario flipping from LIMITATION to FAIL is a NEW S01 failure that needs a ledger entry. Holistic fix per scenario: see Breakage forecast below. Gate: `analyst-e2e`.
- `LlmClient` retry/backoff/observability hooks: reused unmodified. Gate: `tsc-build` for the typed reuse; the backend integration test asserts no regression in the call shape.
- Logging schema for assistant turns (`ControlActionRecordedEvent` in [saivage-v3/src/schemas/types.ts](saivage-v3/src/schemas/types.ts)): unchanged. Gate: `tsc-build`.
- Operator dashboards in sibling projects that read analyst assistant-turn logs: no schema change. No gate.

## Breakage forecast

Predicted NEW failures S01 itself can introduce, relative to the S00 baseline at [saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json](saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json). Each entry below is a CANDIDATE entry: it is appended to the ledger at Phase G only if BOTH of these mechanical conditions hold:

- The id is NOT present in `baseline-gates.json.gates[*].failing_ids` for the matching gate (so it is a genuinely new failure).
- The id IS present in the `NEW` set of the S01 fresh-snapshot diff (so the failure actually materialised).

If a scenario is already in the baseline, S00 owns it and S01 must NOT duplicate the entry. If a scenario passes at S01 close, the entry is NOT appended.

The entry shape matches the S00-pinned form exactly: an H3 heading `### <failing-id>` followed by exactly four labeled lines `Failure mode`, `Reason acceptable now`, `Target fix stage`, `Recorded by`. The failing-id string already encodes the gate prefix (e.g. `analyst-e2e:...`), so no separate `Gate` line is added. The authoring stage id and ISO date are recorded in `Recorded by`.

Candidate entries (each conditional on the two mechanical conditions above):

1. `analyst-e2e:e2e/analyst/scenarios.spec.js::S2 — Bootstrap project from short description`. Failure mode: scenario expects a multi-step decomposition followed by a successful `move_card`; current `move_card` rejects unbounded targets with `Action 'card.move' requires an authorized surface`. Reason acceptable now: SPEC-r7 bounded card-move and removal of the `confirmed/preview_hash` gate is S03's scope. Target fix stage: S03.
2. `analyst-e2e:e2e/analyst/scenarios.spec.js::S4 — Reorder children`. Failure mode: there is no `reorder_child` tool today; the LLM cannot satisfy the scenario. Reason acceptable now: tool addition is S02; ordered-children data model is S03. Target fix stage: S02.
3. `analyst-e2e:e2e/analyst/scenarios.spec.js::S5 — Navigate workspace`. Failure mode: there is no `navigate_workspace` tool today and the SPA does not honour analyst-driven navigation. Reason acceptable now: tool addition is S02; SPA wiring is S08. Target fix stage: S02.
4. `analyst-e2e:e2e/analyst/scenarios.spec.js::S6 — Queue ephemeral notification`. Failure mode: notification primitive is still v2-style notes; the v2 note-inbox tools still present. Reason acceptable now: queue-only ephemeral notification semantics is S04; tool retirement is S02. Target fix stage: S04.

Entries 1–4 may also surface as `tsc-build` errors when later stages introduce typed tool names; that is normal and handled by those stages, not S01.

Forecast entries for S7 (full runtime control verb set) and S8 (investigate and apply fix) are intentionally NOT pre-declared by S01. The reasons each scenario fails belong to later-stage tool-surface and response-shape vocabulary that S01 does not own; if those scenarios materialise as `NEW` in the Phase F diff they are triaged at close time per Phase G.5 as "unforeseen" with a holistic-fix attempt first.

S01 does NOT forecast `web-vitest:saivage-v3/web/src/__tests__/app-shell-analyst-drawer.test.ts::*`. That test exercises the togglable drawer UI shell, which is S05's territory; S01 does not touch the drawer code path and cannot newly break it.

S01 APPENDS only. S01 never edits an existing ledger entry. S01 DELETES an existing ledger entry only when both conditions hold: the entry's `Target fix stage` equals `S01` AND the underlying failure is no longer observed in the S01 fresh snapshot. (At the start of S01 the ledger is empty, so no deletions are expected; the procedure is documented to match master plan section 6.2.)

## Acceptance criteria

Each criterion is mechanically checkable: an exact command (absolute or `cd`-prefixed) and an exact expected result. Numbered for cross-reference with [plan.md](plan.md).

A1. tsc compile clean: `( cd saivage-v3 && npx tsc -p . )` exits 0.

A2. Web vite build clean: `( cd saivage-v3/web && npm run build )` exits 0.

A3. Offline keyword fallback symbols are gone from source: `grep -REn 'parseIntent|runOfflineFallback|HELP_TEXT|lastIntent|deterministicIntent' saivage-v3/src --include='*.ts'` exits 1 (no matches).

A4. Stub-resolver shape is gone: `grep -En 'async isAvailable.*return false|async chat.*return \{ content: ..., toolCalls: \[\] \}' saivage-v3/src/agents/analyst-llm-resolver.ts` exits 1 (no matches for either stub pattern).

A5. Backend integration test passes: `( cd saivage-v3 && NODE_OPTIONS=--experimental-vm-modules npx jest tests/agents/analyst-llm-resolver.integration.test.ts )` exits 0. This single test file contains the focused `it()` blocks for A6, A7, A8, A9, and A10 below.

A6. Real LLM call is observed: within the integration test from A5, the `it('issues a real LLM POST per turn')` block configures `models.analyst` to a single candidate, mocks `globalThis.fetch` to return a valid empty-tool-call chat completions response, invokes `handler.handleMessage(sessionId, 'list my cards')`, and asserts:
   - exactly one POST observed at the candidate's chat-completions URL,
   - request body `model` equals the configured candidate model,
   - `messages[0].role === 'system'` and `messages[0].content` contains the literal `You are the Saivage Analyst`,
   - `tools.length > 0`.

A7. No-candidate offline branch: the `it('returns analyst is offline when models.analyst is empty')` block configures `models.analyst` to an empty list, calls `handler.handleMessage`, and asserts the response content contains the literal substring `analyst is offline`, `response.toolInvocations` is undefined or empty, and the mocked `fetch` was NOT called.

A8. Auth-failure offline branch: the `it('returns analyst is offline when every candidate fails auth')` block configures `models.analyst` to a single candidate, mocks `fetch` to return HTTP 401 on the chat-completions endpoint, calls `handler.handleMessage`, and asserts:
   - the response content contains `analyst is offline`,
   - `response.toolInvocations` is empty,
   - the mocked `fetch` was called exactly once on the chat-completions URL (proves the auth failure was observed at transport, not short-circuited).

This test observes the resolver's effect through public outputs only (the `AnalystResponse` returned to the handler caller, and the recorded `fetch` invocations). It does NOT spy on `registry.markFailed` because the resolver-local registry is not exposed by Option A.

A9. Immediate-prior-context carry-over: the `it('forwards the immediately prior user and assistant turns')` block mocks `fetch` to return a valid empty-tool-call response on turn 1 and again on turn 2, sends `handler.handleMessage(sessionId, 'show me goal-7')` followed by `handler.handleMessage(sessionId, 'and the one after it')`, and asserts the `messages` array on the second POST contains both the turn-1 user message AND the turn-1 assistant message, in chronological order, ahead of the turn-2 user message.

A10. One-clarification on ambiguity: the `it('does not invoke a tool when the LLM returns content only')` block mocks `fetch` to return a content-only chat completions response (no `tool_calls`), calls `handler.handleMessage('delete the cancelled cards')`, and asserts `response.toolInvocations` is empty and the persisted assistant message content equals the mocked content.

A11. Autonomy gate: case-insensitive grep over [drafts/001-real-llm-analyst-resolver/](saivage-v3/SPEC/analyst-as-control-surface/PLAN/drafts/001-real-llm-analyst-resolver/) for the canonical forbidden-anchor pattern defined in master plan section 9.3 returns zero matches. The reviewer reproduces the exact `grep -REni` pattern from master plan section 9.3 (which is the single source of truth for the pattern) and asserts exit code 1 (no matches).

A12. Baseline-driven close check: `bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --diff saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json` either exits 0 (no NEW failures), or exits 1 with every id in its `NEW` set matching an open `### <gate>:<id>` H3 block in [saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md) whose `Target fix stage` is one of `S02`..`S10`. This is the close criterion the validation cookbook pins; S01 references [saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md) for the cadence and does not redefine it.
