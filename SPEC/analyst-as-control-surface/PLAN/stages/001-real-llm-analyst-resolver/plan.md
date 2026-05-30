# Stage 001 — Real LLM Analyst Resolver — Plan

## Pre-conditions

Before any step below runs, the implementer verifies:

P.1. Stage S00 is published: `test -f saivage-v3/SPEC/analyst-as-control-surface/PLAN/stages/000-breakage-detection-harness/design.md && test -f saivage-v3/SPEC/analyst-as-control-surface/PLAN/stages/000-breakage-detection-harness/plan.md` exits 0.

P.2. Baseline snapshot parses and has four gates: `jq -e '.schema_version == 1 and (.gates|length == 4)' saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json` exits 0.

P.3. Cumulative ledger is present with the open-entries section: `grep -c '^## Open entries' saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md` prints `1`.

P.4. Validation cookbook is present and complete per S00: `bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/check-cookbook-sections.sh` exits 0.

P.5. `models.analyst` is configured in the operator's project config WITHOUT reading the file contents: `jq -e '.models.analyst | length > 0' saivage-v3/.saivage/saivage.json >/dev/null` exits 0. If it does not, the implementer STOPS and asks the operator to configure an analyst-capable provider; they MUST NOT edit `saivage.json` themselves.

P.6. The four S00 baseline gates currently run end-to-end without environment errors: `bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --diff saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json` terminates with a recognised diff verdict (exit code 0 or 1, not a script-level error).

## Step-by-step implementation

The order below is strict: each later step assumes the previous one has compiled cleanly.

### Phase A — Introduce the real resolver

A.1. Open [saivage-v3/src/agents/analyst-llm-resolver.ts](saivage-v3/src/agents/analyst-llm-resolver.ts). Add a new exported error class `AnalystOfflineError` extending `Error` whose constructor sets `this.name = 'AnalystOfflineError'` and whose default message begins with the literal substring `analyst is offline`.

A.2. In the same file, export a constant `ANALYST_OFFLINE_REPLY` equal to the full SPEC-r7 message text: `analyst is offline: no provider is configured for role=analyst, or the configured provider failed to authenticate. Configure a provider for role 'analyst' in the project configuration and try again.` (ASCII only, no emoji, no Unicode warning glyphs.)

A.3. In the same file, replace the body of `class LlmIntentResolver` so that:

   - The constructor destructures the config: `const { config } = loadConfig(projectRoot);` (matching the actual `ConfigLoadResult` shape returned by [saivage-v3/src/agents/config-schema.ts](saivage-v3/src/agents/config-schema.ts)). It then instantiates a resolver-local `ProviderRegistry(config)`, a `ModelRouter(config, registry)`, captures `runtimeConfig = getRuntimeConfig(config)`, and initialises an `LlmClient` cache keyed by `cacheKey` from `resolveLlmTransportConfig` (mirroring [saivage-v3/src/agents/agent-adapter.ts](saivage-v3/src/agents/agent-adapter.ts) `createLlmCallFn`). The registry and router are private fields; they are NOT exposed via getters.
   - `isAvailable()` calls `router.resolve('analyst', capabilityRequest)` where `capabilityRequest = capabilityRequestForLlmOptions({ tools: getAnalystToolDefinitions(), tool_choice: 'auto', stream: false })`, returning `true` iff the chain is non-empty.
   - `chat(messages, projectContext)` implements the per-turn flow from the design's "Resolver architecture / Per-turn flow" section: iterate the candidate chain; resolve transport per candidate; get or build an `LlmClient`; call `client.complete(candidate, systemPrompt, messages, sessionId, { tools, tool_choice: 'auto', stream: false, temperature: modelParams.temperature, max_tokens: modelParams.maxTokens, signal, recorder })`; advance on `LlmAuthError` after `registry.markFailed(candidate, runtimeConfig.recoveryDelayMs ?? 60000)`; advance on `LlmRateLimitError` / `LlmServerError` / `LlmTimeoutError` / `LlmParseError`; return `{ content, toolCalls }` shaped exactly the way `AnalystHandler.runAnalystLoop` already consumes.
   - System prompt passed to `client.complete` is `getAnalystSystemPrompt() + '\n\n' + projectContext`.
   - `sessionId` forwarded to `LlmClient.complete` is the same `sessionId` the analyst chat session uses on disk.
   - When the candidate chain is empty: throw `new AnalystOfflineError(ANALYST_OFFLINE_REPLY)`.
   - When every candidate fails authentication: throw `new AnalystOfflineError(ANALYST_OFFLINE_REPLY)`.
   - When every candidate fails with a non-auth transport error after at least one was attempted: rethrow the last transport error verbatim so `AnalystHandler.runAnalystLoop` produces its existing `Analyst LLM unavailable: <reason>` reply (ASCII; no emoji).

A.4. In the same file, replace the system prompt constant `ANALYST_SYSTEM_PROMPT` with the literal block reproduced in the design's "System prompt (S01 baseline)" section. The `<TOOL_LIST>` placeholder is expanded once at module load from `getAnalystToolDefinitions()`.

A.5. In the same file, delete the unused free function `resolveAnalystLlm` plus its `AnalystLlmRuntimeOptions`, `AnalystLlmResolvedToolCall`, and `AnalystLlmResponse` interfaces — no caller exists in `saivage-v3/src`. Verify: `grep -REn 'resolveAnalystLlm|AnalystLlmRuntimeOptions|AnalystLlmResolvedToolCall|AnalystLlmResponse' saivage-v3/src --include='*.ts'` exits 1.

A.6. Compile-verify: `( cd saivage-v3 && npx tsc -p . )` exits 0. Fix any type error inside this file before moving on.

### Phase B — Delete the offline keyword fallback

B.1. Open [saivage-v3/src/agents/analyst-handler.ts](saivage-v3/src/agents/analyst-handler.ts).

B.2. Delete the top-level declarations: `interface ParsedIntent`; the helpers `extractCardIds`, `extractGoalIds`, `extractProcessIds`, `extractStatus`, `extractPriority`, `extractCardType`, `extractTags`, `extractLines`, `extractTitle`, `extractParentId`, `extractNewParent`, `extractNoteKind`; `refineIntentFromUserContent`; `parseIntent`; `HELP_TEXT`.

B.3. On `class AnalystHandler`, delete the private field `lastIntent: Map<string, ParsedIntent> = new Map();` and every read/write site.

B.4. Delete the method `runOfflineFallback(sessionId, userContent)` in full.

B.5. Rewrite `handleMessageSerial(sessionId, userContent)` so its body, after the duplicate-response guard and the user-message append, is exactly:

   1. `const llmAvailable = await this.llmResolver.isAvailable();`
   2. If `!llmAvailable`: append an assistant-text message whose content equals the exported `ANALYST_OFFLINE_REPLY` constant from [saivage-v3/src/agents/analyst-llm-resolver.ts](saivage-v3/src/agents/analyst-llm-resolver.ts). Return an `AnalystResponse` with `toolInvocations: undefined`.
   3. Otherwise, return `await this.runAnalystLoop(sessionId, userContent)`.

B.6. Inside `runAnalystLoop`, locate the `catch (err)` around `this.llmResolver.chat(...)`. Adjust so that when `err instanceof AnalystOfflineError`, the persisted reply is `err.message` (which begins with `analyst is offline`); for any other error class, keep the existing `Analyst LLM unavailable: <reason>` prefix (verify the prefix is ASCII only; if there is a leading emoji in the source today, strip it as part of this substep).

B.7. Compile-verify: `( cd saivage-v3 && npx tsc -p . )` exits 0. Then verify symbol deletion: `grep -REn 'parseIntent|runOfflineFallback|HELP_TEXT|lastIntent|deterministicIntent' saivage-v3/src --include='*.ts'` exits 1.

### Phase C — Reconcile existing backend tests

C.1. Locate backend Jest tests that referenced deleted symbols: `grep -REn 'parseIntent|runOfflineFallback|HELP_TEXT|lastIntent|deterministicIntent' saivage-v3/tests --include='*.ts'`. For each match:

   - If the test asserted offline-keyword behaviour that is gone by SPEC-r7 (a `parseIntent` regex outcome, `HELP_TEXT` literal, `runOfflineFallback` invocation, `LlmIntentResolver.isAvailable === false` stub assertion), delete the test (the behaviour it described no longer exists).
   - If the test asserted unrelated behaviour and just happened to import a deleted helper, edit the import and keep the test.

C.2. Re-run the backend Jest suite to confirm no compile error from a stale import: `( cd saivage-v3 && NODE_OPTIONS=--experimental-vm-modules npx jest --listTests )` exits 0.

C.3. NO edit to [saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json](saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json) is made by S01. The S00 baseline is an immutable input to this stage. If a deleted backend Jest test had previously been listed in the baseline's `failing_ids`, the cookbook diff at Phase F simply observes one fewer failing id (a `REPAIRED` entry in the diff output); the baseline file itself is untouched.

### Phase D — Write the backend integration test

The integration test lives on the backend Jest side at [saivage-v3/tests/agents/analyst-llm-resolver.integration.test.ts](saivage-v3/tests/agents/analyst-llm-resolver.integration.test.ts). Rationale for this location, not [saivage-v3/web/src/__tests__/](saivage-v3/web/src/__tests__/):

   - The web tsconfig and vite resolver are configured for browser-side Vue components, stores, and HTTP contracts; the web Vitest gate command is `( cd saivage-v3/web && npx vitest run )` and runs in jsdom.
   - `AnalystHandler` is a backend module that imports `loadConfig`, `ProviderRegistry`, `ModelRouter`, `LlmClient`, the agent-tools registry, and on-disk persistence. Those imports resolve through the root tsconfig and Jest's NODE_OPTIONS=--experimental-vm-modules runner, not through Vite.
   - Adjacent backend tests already live under [saivage-v3/tests/agents/](saivage-v3/tests/agents/) (the directory exists; see [saivage-v3/tests/analyst.test.ts](saivage-v3/tests/analyst.test.ts) and [saivage-v3/tests/server/analyst-tool-invoked-broadcast.test.ts](saivage-v3/tests/server/analyst-tool-invoked-broadcast.test.ts) which both `import { AnalystHandler } from '../src/agents/...'`). The new integration test uses the same import style.

D.1. Create the test file. The test:

   - Sets up a temporary project root via `mkdtemp`; writes a minimal `.saivage/saivage.json` with a configured `models.analyst` entry pointing at a single provider candidate. The candidate's `baseUrl` is set to `http://test-provider.invalid/v1` so the mocked `fetch` can match on URL prefix; the API key is set to a fixed dummy literal (`'test-key'`) so no real secret is referenced.
   - Mocks `globalThis.fetch` via `jest.spyOn(globalThis, 'fetch')` so every transport call routes through the test mock.
   - Constructs `const handler = new AnalystHandler(tmpRoot);` and calls `handler.handleMessage(sessionId, userContent)` for each `it()` block.
   - Tears down by removing the tmp root and restoring `globalThis.fetch`.

D.2. `it('issues a real LLM POST per turn')` (acceptance A6): mock `fetch` to return one successful chat completions response with no `tool_calls`; call `handler.handleMessage(sessionId, 'list my cards')`; assert exactly one POST observed at `http://test-provider.invalid/v1/chat/completions`, request body `model` equals the configured candidate model, `messages[0].role === 'system'` and `messages[0].content` contains the literal `You are the Saivage Analyst`, and `tools.length > 0`.

D.3. `it('returns analyst is offline when models.analyst is empty')` (acceptance A7): rewrite the temp `.saivage/saivage.json` with `models.analyst: []` before constructing the handler; call `handler.handleMessage`; assert the response content contains the literal substring `analyst is offline`, `response.toolInvocations` is undefined or empty, and the mocked `fetch` was NOT called.

D.4. `it('returns analyst is offline when every candidate fails auth')` (acceptance A8): keep `models.analyst` set to one candidate; mock `fetch` to return `new Response(JSON.stringify({error: 'unauthorized'}), { status: 401 })` for the chat-completions URL; call `handler.handleMessage`; assert the response content contains `analyst is offline`, `response.toolInvocations` is empty, and the mocked `fetch` was called exactly once at the chat-completions URL.

D.5. `it('forwards the immediately prior user and assistant turns')` (acceptance A9): mock `fetch` to return a valid empty-tool-call response on every call; call `handler.handleMessage(sessionId, 'show me goal-7')`; then call `handler.handleMessage(sessionId, 'and the one after it')`; capture the second POST's request body; assert the body's `messages` array contains, in order, the turn-1 user message text, the turn-1 assistant message text, and the turn-2 user message text.

D.6. `it('does not invoke a tool when the LLM returns content only')` (acceptance A10): mock `fetch` to return a chat completions response with one assistant message containing text but no `tool_calls`; call `handler.handleMessage(sessionId, 'delete the cancelled cards')`; assert `response.toolInvocations` is empty and the persisted assistant message content equals the mocked content.

D.7. Tests observe public outputs only: the `AnalystResponse` returned to the caller, plus the recorded `fetch` invocation history. No test spies on the resolver's private `registry` or `router`. (Option A intentionally does not expose them.)

D.8. Run the new test in isolation: `( cd saivage-v3 && NODE_OPTIONS=--experimental-vm-modules npx jest tests/agents/analyst-llm-resolver.integration.test.ts )` exits 0.

### Phase E — Build and broad test sweep

E.1. Root build: `( cd saivage-v3 && npx tsc -p . )` exits 0.

E.2. Web build: `( cd saivage-v3/web && npm run build )` exits 0.

E.3. Web Vitest sweep: `( cd saivage-v3 && npm run web:test:sweep )` exits 0. (This is the script the four-gate `web-vitest` driver uses an equivalent of; running it before the gate driver catches breakage faster.)

E.4. Backend Jest full suite: `( cd saivage-v3 && NODE_OPTIONS=--experimental-vm-modules npx jest )` exits 0.

### Phase F — Run the four baseline gates per the cookbook

S01 references [saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md) for cadence and does not redefine it. The two driver commands below are the cookbook's §4 invocation.

F.1. Produce a fresh snapshot: `bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh` exits with a recognised verdict. Output lands at `saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/out/current-gates.json` plus per-gate raw logs under `out/raw/`.

F.2. Diff the fresh snapshot against the immutable S00 baseline: `bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --diff saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`. Save the diff to `saivage-v3/tmp/S01-gate-diff.txt` for Phase G.

### Phase G — Breakage triage and ledger append

G.1. For each id in the `NEW` set across all four gates in the Phase F diff: attempt the holistic fix described in the design's "Downstream impact" section before adding any ledger entry. If the fix succeeds, re-run Phase F and observe the id disappear from `NEW`. Do NOT silence the failure by `.skip`, deletion of the assertion, or a local conditional.

G.2. For each id in `NEW` whose holistic fix legitimately belongs to a later stage (per the design's Breakage forecast), append exactly one H3 block to [saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md) under `## Open entries`, in this exact shape:

   ```text
   ### <failing-id>
   - Failure mode: <one sentence describing the symptom>.
   - Reason acceptable now: <which SPEC-r7 clause or earlier-stage decision forces it>.
   - Target fix stage: <S02..S10; never S00 or S01>
   - Recorded by: S01 / <YYYY-MM-DD>
   ```

   The four labelled lines (`Failure mode`, `Reason acceptable now`, `Target fix stage`, `Recorded by`) are the S00-pinned shape from the entry-shape section of [saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md) §8. The failing-id already encodes the gate prefix (e.g. `analyst-e2e:...`), so no additional `Gate` line is added; the authoring stage id and ISO date are recorded in `Recorded by`.

G.3. S01 APPENDS only. S01 NEVER edits an existing ledger entry. S01 DELETES an existing entire H3 block ONLY when both: the entry's `Target fix stage` line equals `S01`, AND the underlying failure id is no longer present in the Phase F fresh snapshot. At the start of S01 the ledger is empty (S00 published an empty `## Open entries` section), so no deletions are expected; the procedure is recorded to match master plan section 6.2.

G.4. NO edit to [saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json](saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json) is performed at any point in S01. The S00 baseline is an immutable input.

G.5. Record in this `plan.md`'s post-execution log (appended as a new H2 section at close time, not now) the delta against the design's Breakage forecast: forecast entries that materialised, forecast entries that did not, and any close-time entry that was not foreseen.

### Phase H — Close

H.1. Commit the ledger appends from G.2 in the same commit that lands the code change.

H.2. Re-run Phase F one final time. Save the final diff to `saivage-v3/tmp/S01-final-diff.txt`.

H.3. Mechanical close check (cookbook §6 close criterion): every id in `NEW` across all gates must have a matching open ledger entry whose `Target fix stage` is strictly later than S01. The single command that decides close:

   `bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --diff saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json` either exits 0 (zero NEW failures) or exits 1 with every NEW id matching an open `### <gate>:<id>` H3 block in [saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md) whose `Target fix stage` is one of `S02`..`S10`.

H.4. Autonomy gate: run the case-insensitive grep with the canonical forbidden-anchor pattern from master plan section 9.3 over [drafts/001-real-llm-analyst-resolver/](saivage-v3/SPEC/analyst-as-control-surface/PLAN/drafts/001-real-llm-analyst-resolver/); the grep must exit 1 (no matches). Master plan section 9.3 is the single source of truth for the pattern and is reproduced by the reviewer at gate time.

## Validation gate at end

The single decisive command is `bash saivage-v3/SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --diff saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`, evaluated together with the post-Phase-G ledger per the [validation cookbook](saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md) §6 close criterion.

## Expected breakage ledger entries to append at close

Concrete entries the implementer commits at Phase H.1, conditional on materialising as a `NEW` id in the Phase F diff AND being absent from `baseline-gates.json.gates[*].failing_ids` for the matching gate. If a candidate id is already in the baseline (S00 owns it), S01 must NOT add a duplicate entry. If a candidate id does not materialise as `NEW`, S01 must NOT add the entry.

```text
### analyst-e2e:e2e/analyst/scenarios.spec.js::S2 — Bootstrap project from short description
- Failure mode: scenario expects a multi-step decomposition followed by a `move_card` that succeeds; current `move_card` rejects unbounded targets with `Action 'card.move' requires an authorized surface`.
- Reason acceptable now: SPEC-r7 bounded card-move and removal of the `confirmed/preview_hash` gate is S03's scope.
- Target fix stage: S03
- Recorded by: S01 / <YYYY-MM-DD>

### analyst-e2e:e2e/analyst/scenarios.spec.js::S4 — Reorder children
- Failure mode: no `reorder_child` tool exists; the analyst cannot satisfy the scenario.
- Reason acceptable now: tool addition is S02's scope; ordered-children data model is S03's scope.
- Target fix stage: S02
- Recorded by: S01 / <YYYY-MM-DD>

### analyst-e2e:e2e/analyst/scenarios.spec.js::S5 — Navigate workspace
- Failure mode: no `navigate_workspace` tool exists; SPA does not honour analyst-driven navigation.
- Reason acceptable now: tool addition is S02's scope; SPA wiring is S08's scope.
- Target fix stage: S02
- Recorded by: S01 / <YYYY-MM-DD>

### analyst-e2e:e2e/analyst/scenarios.spec.js::S6 — Queue ephemeral notification
- Failure mode: notification primitive is still v2-style notes; the v2 note-inbox tools still present.
- Reason acceptable now: queue-only ephemeral notification semantics is S04's scope; tool retirement is S02's scope.
- Target fix stage: S04
- Recorded by: S01 / <YYYY-MM-DD>
```

Any candidate entry above whose underlying failure does NOT materialise as `NEW` at Phase F is not added. Any close-time `NEW` failure NOT enumerated above is justified in Phase G.5's post-execution log as "unforeseen" and triggers a follow-up review of the design per master plan section 6.1.

## Done definition

S01 is done when:

D.1. Every acceptance criterion A1 through A12 in [drafts/001-real-llm-analyst-resolver/design.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/drafts/001-real-llm-analyst-resolver/design.md) holds. Cross-reference:
   - A1 covered by Phase A.6 / E.1.
   - A2 covered by Phase E.2.
   - A3 covered by Phase B.7.
   - A4 covered by Phase A.3 (stub branches replaced).
   - A5, A6, A7, A8, A9, A10 covered by Phase D.8.
   - A11 covered by Phase H.4.
   - A12 covered by Phase H.3.

D.2. The mechanical close check from cookbook §6 passes against the post-stage ledger and the post-stage gate diff (Phase H.3).

D.3. The autonomy gate from master plan §9.3 passes: zero forbidden-anchor matches under [drafts/001-real-llm-analyst-resolver/](saivage-v3/SPEC/analyst-as-control-surface/PLAN/drafts/001-real-llm-analyst-resolver/); every external link in design.md and plan.md resolves to an existing workspace path; every cross-stage reference points at a directory already present under [stages/](saivage-v3/SPEC/analyst-as-control-surface/PLAN/stages/) (S00).

D.4. The pre-publication operator check from master plan §9.4 passes: the forbidden-anchor grep over the to-be-published tree returns zero matches.
