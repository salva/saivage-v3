# F08 — Failure classification is fragile and provider-agnostic (analysis + design + plan)

Self-contained. File references are workspace-relative to `/home/salva/g/ml/saivage-v3/` and clickable. Per the workspace architecture-first / no-backward-compatibility guideline, no legacy enum is preserved, no migration shim is introduced, and no feature flag survives. F08 closes here.

Cross-links: this issue interlocks with **F03** (cooldown decisions consume the classifier output), **F05** (defines `LlmContractMismatchError` and the terminal-protocol subtypes), and **F04** (the failure class is a typed key field on the unified attempt event).

---

## 1. Analysis (≤ 120 lines)

### 1.1 Where the classifier lives

Two files own the entire failure path between an HTTP response and a recovery action:

- HTTP-status mapper: [src/agents/llm-errors.ts#L70-L96](../../../src/agents/llm-errors.ts#L70).
- String classifier + recovery decision: [src/agents/invocation-recovery-policy.ts#L99-L148](../../../src/agents/invocation-recovery-policy.ts#L99).
- Error class hierarchy (input to the classifier): [src/agents/llm-errors.ts#L3-L57](../../../src/agents/llm-errors.ts#L3).

A single `InvocationFailureClass` string union (eight members) at [src/agents/invocation-recovery-policy.ts#L13-L22](../../../src/agents/invocation-recovery-policy.ts#L13) is the *only* typed surface between transport-level errors and the recovery loop. Every observability event, cooldown decision, and "should we failover?" branch downstream pivots on this string.

### 1.2 The eight current failure classes — trigger conditions and recovery actions

The table below reads `classify` at [src/agents/invocation-recovery-policy.ts#L99-L116](../../../src/agents/invocation-recovery-policy.ts#L99) for trigger conditions and `decideFailure` at [src/agents/invocation-recovery-policy.ts#L120-L148](../../../src/agents/invocation-recovery-policy.ts#L120) for the action.

| Class | Trigger (today) | Action |
| --- | --- | --- |
| `cancelled` | `error instanceof DOMException && name === 'AbortError'`, or regex `/\bcancell?ed\b|\babort(?:ed)?\b/i` on message ([src/agents/invocation-recovery-policy.ts#L83-L88](../../../src/agents/invocation-recovery-policy.ts#L83)) | `abort_without_retry` |
| `capability_mismatch` | Either capability skips are present and message matches `/does not support requested LLM capabilities|unsupported_/i`, or message matches `/does not support requested LLM capabilities|unsupported_(?:tool_calls|tool_choice|transport_protocol|response_shape|streaming)/i` ([src/agents/invocation-recovery-policy.ts#L90-L96](../../../src/agents/invocation-recovery-policy.ts#L90)) | `failover_without_cooldown` |
| `auth_permanent` | `error instanceof LlmAuthError` (raised on HTTP 401/403 at [src/agents/llm-errors.ts#L82-L84](../../../src/agents/llm-errors.ts#L82)) | `failover_without_cooldown` |
| `rate_limit_transient` | `error instanceof LlmRateLimitError` (raised on HTTP 429 at [src/agents/llm-errors.ts#L86-L88](../../../src/agents/llm-errors.ts#L86)) | `cooldown_and_failover`, cooldown = fixed `recoveryDelayMs` |
| `server_transient` | `error instanceof LlmServerError` — raised on HTTP ≥ 500 AND on **every other non-2xx** (catch-all branch at [src/agents/llm-errors.ts#L94-L95](../../../src/agents/llm-errors.ts#L94)), and synthesised by `normalizeLlmTransportError` for `TypeError` and unknowns at [src/agents/llm-errors.ts#L98-L107](../../../src/agents/llm-errors.ts#L98) | `cooldown_and_failover`, cooldown = fixed `recoveryDelayMs` |
| `timeout_transient` | `error instanceof LlmTimeoutError`, also synthesised from `AbortError` at [src/agents/llm-errors.ts#L102-L104](../../../src/agents/llm-errors.ts#L102) | `cooldown_and_failover`, cooldown = fixed `recoveryDelayMs` |
| `parse_or_contract` | `error instanceof LlmParseError`, or `SyntaxError`/`TypeError`, or regex `/parse|schema|contract|validation failed|invalid .*json/i` on message ([src/agents/invocation-recovery-policy.ts#L107-L108](../../../src/agents/invocation-recovery-policy.ts#L107)) | `retry_same_after_delay` if attempt ≤ `maxRecoveryRetries`, else `failover_without_cooldown` |
| `unknown` | Anything not matched above | `cooldown_and_failover` (same as `server_transient`) |

### 1.3 The broken mapping (proof)

Path for opencode-go's HTTP 400 `"You cannot specify response format and function call at the same time"`:

1. Chat gateway POSTs; non-2xx → `handleLlmHttpError(response, 'llm-openai-chat-gateway')` at [src/agents/llm-openai-chat-gateway.ts#L93](../../../src/agents/llm-openai-chat-gateway.ts#L93).
2. Status is 400. The branches at [src/agents/llm-errors.ts#L82-L92](../../../src/agents/llm-errors.ts#L82) check `401|403`, then `429`, then `>= 500`. None match.
3. Fallthrough at [src/agents/llm-errors.ts#L94-L95](../../../src/agents/llm-errors.ts#L94): `throw new LlmServerError(\`LLM request failed (HTTP ${status})${detail}\`, status);`.
4. `InvocationRecoveryPolicy.classify` at [src/agents/invocation-recovery-policy.ts#L104](../../../src/agents/invocation-recovery-policy.ts#L104) hits `error instanceof LlmServerError` first and returns `'server_transient'`.
5. `decideFailure` at [src/agents/invocation-recovery-policy.ts#L132-L134](../../../src/agents/invocation-recovery-policy.ts#L132) returns `cooldown_and_failover` with `cooldownMs = context.recoveryDelayMs`.
6. The candidate is added to the cooldown ledger via `markFailed: true`. The next role invocation skips it via `ProviderRegistry.isHealthy` at [src/agents/provider.ts#L289](../../../src/agents/provider.ts#L289). Recovery is slowed because the model is healthy — we just sent a request our own adapter assembled wrong.

### 1.4 Where the provider body is parsed

Nowhere. `handleLlmHttpError` reads the body once at [src/agents/llm-errors.ts#L72-L77](../../../src/agents/llm-errors.ts#L72) and folds it into the error message as a 500-char `detail` string after redaction. It is **never** JSON-parsed; no fields are extracted; no per-provider matcher runs. The same string then has to survive a regex pass through the classifier to produce anything other than `server_transient`.

`Retry-After` headers, `x-ratelimit-reset`, `resets_at`, DeepSeek's `error.code = "context_length_exceeded"`, Together's `code: "model_not_found"`, anthropic's `type: "overloaded_error"` — none are visible to the recovery loop.

### 1.5 Per-provider failure-shape divergence (opencode-go vs openai-codex)

Both gateways converge on `handleLlmHttpError` via [src/agents/llm-openai-chat-gateway.ts#L93](../../../src/agents/llm-openai-chat-gateway.ts#L93) and [src/agents/llm-openai-codex-gateway.ts#L80](../../../src/agents/llm-openai-codex-gateway.ts#L80). They differ in two ways the classifier ignores:

- **Body shape.** `opencode-go` returns `{"error":{"message":"You cannot specify response format and function call at the same time","type":"invalid_request_error"}}` for the F01 contract bug — a status-400 chat-completions shape. `openai-codex` (Codex Responses) returns a flat `{"error":{"type":"invalid_request_error","message":"…","code":"…"}}` with different `code` enums (`unsupported_value`, `model_not_found`, `context_length_exceeded`), or for tool-mode mismatches a 422 with `code: "unsupported_value"`.
- **Rate-limit headers.** `opencode-go` typically forwards upstream `Retry-After` (seconds), `x-ratelimit-remaining-requests`, `x-ratelimit-reset-requests` (epoch seconds). Codex Responses uses `x-ratelimit-reset` (ISO timestamp) and an inlined `error.message` like `"Rate limit reached … please try again in 12.4s"`. Both end up as a generic `LlmRateLimitError(message, 429)` with no `retryAfterMs` field — see the class at [src/agents/llm-errors.ts#L14-L23](../../../src/agents/llm-errors.ts#L14) — so F03's cooldown picker has no information to honour the provider hint.

Per-provider divergence is invisible to the recovery loop because there is no per-provider parser anywhere in the failure path.

---

## 2. Design (≤ 200 lines)

Two proposals. Both replace the broken HTTP-400 mapping. Proposal A is focused; Proposal B is the level-up. Per the workspace guideline, the recommendation is **Proposal B**.

### 2.1 Proposal A — focused: add a contract-error branch

**Idea.** Keep the eight-class string union and the `instanceof` classifier. Add one extra check in `handleLlmHttpError`: if status is 400 and the body matches a known "our contract" fingerprint, raise `LlmContractMismatchError` (introduced by F05) instead of `LlmServerError`. The recovery policy gains one branch: `LlmContractMismatchError → fail_invocation`, no cooldown, no failover.

**Data model.** Unchanged. `InvocationFailureClass` gains one member, `'contract_mismatch'`; the eight-class union becomes nine. `LlmContractMismatchError` already carries a subtype string (per F05 §4.3); A does not extend it.

**Body-fingerprint match.** A small fixed table in `llm-errors.ts`:

```ts
const CONTRACT_FINGERPRINTS: Array<{ statuses: number[]; bodyPattern: RegExp; subtype: ContractMismatchSubtype }> = [
  { statuses: [400], bodyPattern: /response format.*function call|tools.*response_format|cannot specify response_format/i, subtype: 'tools_and_response_format_conflict' },
];
```

`handleLlmHttpError` reads the body (it already does), then tries each fingerprint in order. First match wins → `throw new LlmContractMismatchError(subtype, { status, bodyRaw, provider: source })`. If none match, fall through to the existing branches.

**Classifier ownership.** Still `InvocationRecoveryPolicy.classify`. Still HTTP-status + `instanceof`-based. Body parsing happens once in the mapper; the classifier never sees the body.

**Recovery policy table addendum.**

| Class | Action |
| --- | --- |
| `contract_mismatch` (new) | `fail_invocation`, `markFailed: false`, `appendModelIssue: true`, `abort: true`, no cooldown |

**Observability tie-in (F04).** `failureClass: 'contract_mismatch'` is added to the failure-class enum F04 declares. Event payload already carries `failureClass` at [src/agents/invocation-recovery-policy.ts#L181-L182](../../../src/agents/invocation-recovery-policy.ts#L181); F04 widens the schema to include the new value.

**Cooldown tie-in (F03).** `markFailed: false` means F03's `ProviderRegistry.markFailed` ([src/agents/provider.ts#L320](../../../src/agents/provider.ts#L320)) is not called → no cooldown entry → the F01-vs-F08 interaction is broken at the source.

**Cost.** Three to four call sites changed. Test surface small.

**Limitations.** Every new per-provider shape (DeepSeek `context_length_exceeded`, Together `model_not_found`, Anthropic `overloaded_error`, rate-limit reset hints) still goes through the same status-only path. The next time we need provider-specific behaviour the same `if-else` chain grows. The string union stays brittle: the classifier still uses regex on the message at [src/agents/invocation-recovery-policy.ts#L108](../../../src/agents/invocation-recovery-policy.ts#L108).

### 2.2 Proposal B — level-up: typed discriminated union + per-provider classifier table

**Idea.** Delete the eight-member string union. Replace it with a typed discriminated union of failure cases, each carrying the fields the recovery loop actually needs. Move body parsing out of the global `handleLlmHttpError` into a per-provider classifier table. Each gateway owns the contract that says "for HTTP 400, this is what to look at".

**Data model.** In a new file `src/agents/llm-failure.ts`:

```ts
export type LlmFailure =
  | { kind: 'auth_permanent'; status: 401 | 403; provider: ProviderName; message: string }
  | { kind: 'rate_limit'; status: 429; provider: ProviderName; message: string; retryAfterMs?: number; resetsAt?: number }
  | { kind: 'server_transient'; status: number; provider: ProviderName; message: string }
  | { kind: 'timeout'; provider: ProviderName; message: string }
  | { kind: 'contract_mismatch'; provider: ProviderName; status?: number; subtype: ContractMismatchSubtype; providerMessage: string }
  | { kind: 'capability_mismatch'; provider: ProviderName; reasons: string[]; message: string }
  | { kind: 'token_budget_exceeded'; provider: ProviderName; status: number; tokensRequested?: number; tokensLimit?: number; message: string }
  | { kind: 'parse_error'; provider: ProviderName; bodyPreview: string; message: string }
  | { kind: 'cancelled'; reason: 'abort' | 'timeout'; message: string }
  | { kind: 'unknown'; provider: ProviderName | null; message: string };

export type ContractMismatchSubtype =
  | 'tools_and_response_format_conflict'    // opencode-go HTTP 400
  | 'terminal_prose_only'                   // owned by F05
  | 'terminal_duplicate'
  | 'terminal_mixed_with_actions'
  | 'terminal_wrong_role'
  | 'terminal_missing_on_forced_turn'
  | 'terminal_arguments_not_json'
  | 'terminal_arguments_schema_mismatch';
```

The error classes in [src/agents/llm-errors.ts](../../../src/agents/llm-errors.ts) (`LlmAuthError`, `LlmRateLimitError`, `LlmServerError`, `LlmTimeoutError`, `LlmParseError`) are **deleted** as a hierarchy and become thin wrappers around `LlmFailure`: a single `LlmRequestError extends Error { readonly failure: LlmFailure }`. F05's `LlmContractMismatchError` is the second concrete class; it constructs an `LlmFailure` with `kind: 'contract_mismatch'`. No other Error subclasses survive in this module.

**Classifier ownership.** A per-provider classifier table in `src/agents/llm-failure-classifiers.ts`:

```ts
export interface ProviderFailureClassifier {
  classifyHttp(status: number, headers: Headers, body: string): LlmFailure | null;
  classifyTransport(err: unknown): LlmFailure | null;
}
export const OpenCodeGoClassifier: ProviderFailureClassifier = { … };
export const OpenAIChatClassifier: ProviderFailureClassifier = { … };
export const OpenAICodexClassifier: ProviderFailureClassifier = { … };
export const GithubCopilotClassifier: ProviderFailureClassifier = { … };
export const NvidiaNimClassifier: ProviderFailureClassifier = { … };
export const DEFAULT_CLASSIFIER_TABLE: Record<ProviderName, ProviderFailureClassifier> = { … };
```

Each classifier owns:

- JSON body parse (best-effort, never throws — returns `null` on undecidable shape).
- Status → `kind` mapping (knows e.g. that this provider returns 422 not 400 for capability mismatches).
- Header → `retryAfterMs` / `resetsAt` extraction. Codex parses ISO `x-ratelimit-reset`; chat parses `Retry-After` seconds; falls back to message regex `"try again in 12.4s"`.
- Contract-mismatch fingerprints (e.g. opencode-go HTTP 400 → `tools_and_response_format_conflict`).
- A `null` return means "I don't recognise this shape; fall through to the default mapper".

`handleLlmHttpError` is **deleted**. Each gateway calls its own classifier:

```ts
// llm-openai-chat-gateway.ts
if (!response.ok) {
  const body = await response.text();
  const failure = classifierFor(candidate.provider).classifyHttp(response.status, response.headers, body)
                ?? defaultHttpClassifier(candidate.provider, response.status, response.headers, body);
  await handle?.recordError({ … });
  throw new LlmRequestError(failure);
}
```

`InvocationRecoveryPolicy.classify` becomes one line: `(err: unknown) => unwrapFailure(err)` returning an `LlmFailure`. `unwrapFailure` handles `LlmRequestError`, `LlmContractMismatchError`, and synthesises `{ kind: 'cancelled' }` / `{ kind: 'unknown' }` for raw `Error`s.

**Recovery policy table.** `decideFailure` switches on `failure.kind` (typed; the compiler enforces exhaustiveness):

| `kind` | `action` | `markFailed` | `cooldownMs` |
| --- | --- | --- | --- |
| `auth_permanent` | `failover_without_cooldown` | false | — |
| `rate_limit` | `cooldown_and_failover` | true | `failure.retryAfterMs ?? (failure.resetsAt - now) ?? recoveryDelayMs` (F03) |
| `server_transient` | `cooldown_and_failover` | true | `recoveryDelayMs` (F03 may grow this with backoff) |
| `timeout` | `cooldown_and_failover` | true | `recoveryDelayMs` |
| `contract_mismatch` | `fail_invocation` | false | — |
| `capability_mismatch` | `failover_without_cooldown` | false | — |
| `token_budget_exceeded` | `fail_invocation` | false | — |
| `parse_error` | `retry_same_after_delay` if `attempt ≤ maxRecoveryRetries`, else `failover_without_cooldown` | false | — |
| `cancelled` | `abort_without_retry` | false | — |
| `unknown` | `cooldown_and_failover` | true | `recoveryDelayMs` |

The `InvocationFailureClass` string union at [src/agents/invocation-recovery-policy.ts#L13-L22](../../../src/agents/invocation-recovery-policy.ts#L13) is **deleted**. Event payloads serialize `failure.kind` directly.

**Observability tie-in (F04).** `failure` is the structured payload that F04 mandates on `invocation_failed`. The F04 schema declares a `failure` object with `kind` plus the per-kind fields (`retryAfterMs?`, `resetsAt?`, `subtype?`, `tokensLimit?`). No information is lost in serialization; `LlmFailure` is JSON by construction.

**Cooldown tie-in (F03).** F03's cooldown picker reads `failure.retryAfterMs` / `failure.resetsAt` directly when `kind === 'rate_limit'`. No header re-parsing in F03 — the classifier already did it.

**Recommendation per architecture-first guideline: Proposal B.** Proposal A defuses the immediate F01-vs-F08 interaction but leaves the next provider-divergence bug one regex away. Proposal B replaces the brittle layer instead of patching it, lets F03 honour provider hints without re-reading bodies, and gives F04 a typed payload to publish. The cost is one extra file (`llm-failure.ts`) and one extra file (`llm-failure-classifiers.ts`); five gateway sites change once and stop changing for every new provider.

---

## 3. Plan (≤ 180 lines)

Three batched commits, each a green checkpoint. No migration shim, no compat enum, no feature flag.

### 3.1 Batch 1 — introduce `LlmFailure`, delete the old error hierarchy

**Changes.**

1. Create [src/agents/llm-failure.ts](../../../src/agents/llm-failure.ts): `LlmFailure` union, `ContractMismatchSubtype`, `ProviderName` re-export, `LlmRequestError` (one concrete `Error` subclass that wraps `LlmFailure`), `unwrapFailure(err)`.
2. Create [src/agents/llm-failure-classifiers.ts](../../../src/agents/llm-failure-classifiers.ts): `ProviderFailureClassifier` interface, the five concrete classifiers (`OpenCodeGoClassifier`, `OpenAIChatClassifier`, `OpenAICodexClassifier`, `GithubCopilotClassifier`, `NvidiaNimClassifier`), `DEFAULT_CLASSIFIER_TABLE`, `defaultHttpClassifier`. Each classifier:
   - parses headers `Retry-After`, `x-ratelimit-reset`, `x-ratelimit-reset-requests`;
   - extracts `error.message`, `error.code`, `error.type` from a best-effort `JSON.parse(body)`;
   - returns `{ kind: 'contract_mismatch', subtype: 'tools_and_response_format_conflict', … }` for the F01 opencode-go HTTP 400 fingerprint;
   - returns `{ kind: 'token_budget_exceeded', … }` for `code: 'context_length_exceeded'` or `code: 'max_tokens_exceeded'`;
   - returns `null` for unrecognised shapes (falls through to default mapper).
3. Delete `LlmAuthError`, `LlmRateLimitError`, `LlmServerError`, `LlmTimeoutError`, `LlmParseError`, `StructuredLlmError`, `isStructuredLlmError`, `handleLlmHttpError`, `normalizeLlmTransportError` from [src/agents/llm-errors.ts](../../../src/agents/llm-errors.ts). The file now contains only `LlmContractMismatchError` (introduced by F05) and `LlmRequestError` re-export. `redactProviderErrorText` survives.
4. Rewrite [src/agents/llm-openai-chat-gateway.ts#L93](../../../src/agents/llm-openai-chat-gateway.ts#L93) and [src/agents/llm-openai-codex-gateway.ts#L80](../../../src/agents/llm-openai-codex-gateway.ts#L80) to read the body once, call `classifierFor(candidate.provider).classifyHttp(…) ?? defaultHttpClassifier(…)`, and `throw new LlmRequestError(failure)`. Transport-level catches (`AbortError`, `TypeError`) call `classifyTransport` similarly.
5. Update unit tests for `llm-errors.ts` to assert `LlmRequestError.failure.kind` instead of `instanceof LlmServerError` etc.

**Migration.** No compat shim. Any consumer of `LlmAuthError`/`LlmRateLimitError`/`LlmServerError`/`LlmTimeoutError`/`LlmParseError` outside the gateway path is rewritten in this batch. `grep -rn "LlmServerError\|LlmRateLimitError\|LlmAuthError\|LlmTimeoutError\|LlmParseError" src/ tests/` must return zero hits after the batch.

**Green checkpoint.** `npm run build` clean. Existing tests for gateways and recovery still pass (recovery still consumes the old string class — Batch 2 changes it).

**Risk.** Body is now read in every gateway exactly once; double-read bugs (the current code reads `errBody` for recording then re-calls `handleLlmHttpError` which re-reads the consumed stream) are gone. Rollback: revert this commit.

### 3.2 Batch 2 — rewrite `InvocationRecoveryPolicy` against `LlmFailure`

**Changes.**

1. Delete `InvocationFailureClass` (the eight-string union) at [src/agents/invocation-recovery-policy.ts#L13-L22](../../../src/agents/invocation-recovery-policy.ts#L13). Delete the `isAbortLike` and `isCapabilityMismatch` helpers (capability-mismatch becomes a typed kind raised by the gateway capability check, not a message regex).
2. Rewrite `classify` to `(err) => unwrapFailure(err)` returning `LlmFailure`.
3. Rewrite `decideFailure` as a `switch (failure.kind)` with exhaustiveness checked by `assertNever(failure)`. Use the §2.2 recovery table. The `parse_or_contract` retry-same logic moves to the `parse_error` branch.
4. `InvocationRecoveryDecision.failureClass: string | undefined` becomes `failure: LlmFailure | undefined`. The event payload at [src/agents/invocation-recovery-policy.ts#L172-L184](../../../src/agents/invocation-recovery-policy.ts#L172) writes `failure: failure` instead of `failureClass: failureClass`. `recoveryAction` survives unchanged.
5. Rewrite call sites in `AgentAdapter.invokeAgent` ([src/agents/agent-adapter.ts#L399-L411](../../../src/agents/agent-adapter.ts#L399)) to read `decision.failure?.kind` instead of `decision.failureClass`.
6. Rewrite `tests/agents/invocation-recovery-policy.test.ts` against the new union; all suites assert `decision.failure.kind`.

**Migration.** No compat shim. Event payloads on disk that carry the old `failureClass: 'server_transient'` field are NOT read back by the recovery loop; they survive only as historical event records and are not migrated. F04's event schema rev (a separate issue) covers the on-disk schema bump.

**Green checkpoint.** `npm run build` clean. `npm run test -- tests/agents/invocation-recovery-policy.test.ts` green; `npm run test -- tests/agents/agent-adapter.test.ts` green.

**Risk.** Any code outside `src/agents/` that read `decision.failureClass` (dashboard, exchange recorder, debug UI) must move to `decision.failure.kind`. `grep -rn "failureClass" src/ web/src/ tests/` must return zero hits after the batch.

### 3.3 Batch 3 — wire F08 into F03 (cooldown) and F04 (event schema)

**Changes.**

1. F03 cooldown picker (per F03's design, in `ProviderRegistry.markFailed` at [src/agents/provider.ts#L320](../../../src/agents/provider.ts#L320)) reads `failure.retryAfterMs ?? (failure.resetsAt && failure.resetsAt - Date.now()) ?? recoveryDelayMs` when `failure.kind === 'rate_limit'`. The fixed `recoveryDelayMs` survives only as the last fallback.
2. F04 event schema (in [src/schemas/event-catalog.ts#L49-L51](../../../src/schemas/event-catalog.ts#L49) and [src/schemas/validators.ts#L164-L166](../../../src/schemas/validators.ts#L164) and [src/schemas/types.ts#L154-L156](../../../src/schemas/types.ts#L154)) declares `invocation_failed.failure` as the typed `LlmFailure` discriminated union (Zod). The bare `error_message` field is deleted; consumers read `failure.message`. The web reader at `web/src/utils/` is updated to render `failure.kind` instead of the old `failureClass` string.
3. Delete every remaining reference to the strings `'server_transient'`, `'rate_limit_transient'`, `'timeout_transient'`, `'parse_or_contract'`, `'capability_mismatch'`, `'auth_permanent'`, `'cancelled'`, `'unknown'` as `InvocationFailureClass` literals. `grep -rn "rate_limit_transient\|server_transient\|timeout_transient" src/ web/src/ tests/` must return zero hits after the batch.

**Green checkpoint.** Full suite: `npm run build && npm run test`.

**Risk.** F03 and F04 are sibling issues; if either lands later, Batch 3 fence-sits behind feature gates of its own commit. Concretely: Batch 3 may merge before F03's full implementation by guarding the new cooldown reads behind `if (failure.kind === 'rate_limit' && failure.retryAfterMs !== undefined)` — the F03 issue still owns the broader cooldown rework. Rollback: revert this commit; Batches 1 and 2 stay green on their own.

### 3.4 Named tests

Each batch adds tests in this order. All live under `tests/agents/`.

1. **`llm-failure-classifiers.test.ts` — Batch 1.**
   - `opencode_go_http_400_tools_and_response_format → contract_mismatch:tools_and_response_format_conflict` — Response `status: 400`, body `'{"error":{"message":"You cannot specify response format and function call at the same time","type":"invalid_request_error"}}'`. Asserts `classifyHttp` returns `{ kind: 'contract_mismatch', subtype: 'tools_and_response_format_conflict', provider: 'opencode-go', providerMessage: 'You cannot specify response format and function call at the same time' }`.
   - `openai_chat_429_with_retry_after_seconds → rate_limit:retryAfterMs=12000` — Status 429, header `Retry-After: 12`. Asserts `{ kind: 'rate_limit', retryAfterMs: 12000 }`.
   - `openai_codex_429_with_iso_reset → rate_limit:resetsAt=…` — Status 429, header `x-ratelimit-reset: 2026-05-29T12:34:56Z`. Asserts `{ kind: 'rate_limit', resetsAt: Date.parse('2026-05-29T12:34:56Z') }`.
   - `deepseek_400_context_length → token_budget_exceeded` — Status 400, body `'{"error":{"code":"context_length_exceeded","message":"…"}}'`. Asserts `{ kind: 'token_budget_exceeded' }`.
   - `unrecognised_4xx → falls_through_to_default_server_transient` — Verifies the `null` fall-through path; `OpenCodeGoClassifier.classifyHttp(418, …, '{}')` returns `null` and `defaultHttpClassifier` yields `{ kind: 'server_transient', status: 418 }`.
   - **Parameterized per-provider table.** Single `describe.each(PROVIDERS)` block reuses fixtures for each of the five classifiers, so a new provider added to the table requires exactly one new fixture line.

2. **`invocation-recovery-policy.test.ts` — Batch 2.**
   - `contract_mismatch_does_not_failover_and_does_not_cooldown` — Input `LlmFailure { kind: 'contract_mismatch', subtype: 'tools_and_response_format_conflict' }`. Asserts `decision.action === 'fail_invocation'`, `decision.markFailed === false`, `decision.cooldownMs === undefined`, `decision.abort === true`.
   - `rate_limit_with_retry_after_uses_provider_hint` — Input `LlmFailure { kind: 'rate_limit', retryAfterMs: 12000 }`. Asserts `decision.action === 'cooldown_and_failover'`, `decision.cooldownMs === 12000` (Batch 3-gated assertion; Batch 2 only asserts `markFailed: true`).
   - `parse_error_retries_then_failovers` — `attempt: 1, maxRecoveryRetries: 2` → `retry_same_after_delay`; `attempt: 3, maxRecoveryRetries: 2` → `failover_without_cooldown`.
   - `capability_mismatch_kind_does_not_cooldown` — Input from gateway's typed capability skip, not from a regex.
   - `cancelled_aborts` — Input `{ kind: 'cancelled', reason: 'abort' }`. Asserts `decision.action === 'abort_without_retry'`.

3. **`agent-adapter.test.ts` — Batch 2 update.**
   - Update the existing F01-regression test (`tools_and_response_format_emitted_simultaneously`) to assert the failure surfaces as `LlmFailure.kind = 'contract_mismatch'` and the candidate is **not** marked as cooldown-bearing (`registry.getHealth(candidate)` shows no failure).

### 3.5 Risk + rollback summary

| Batch | Primary risk | Rollback |
| --- | --- | --- |
| 1 | Body double-read regression in gateways; missed `instanceof` consumer outside `src/agents/`. Mitigated by the post-batch `grep` gate. | `git revert` the batch; old `handleLlmHttpError` returns. |
| 2 | Downstream readers of `decision.failureClass` in web UI / exchange recorder break. Mitigated by the post-batch `grep` for `failureClass`. | `git revert` the batch; old string-union recovery returns. Batch 1's typed gateway throws are caught and wrapped by `unwrapFailure` even on the old policy (the failure flows through `LlmRequestError`), so revert is clean. |
| 3 | F03/F04 schema bumps; F04 event consumers crash on missing `failureClass`. Mitigated by landing F04's schema rev in the same commit. | `git revert` the batch; recovery loop falls back to fixed `recoveryDelayMs`. |

---

## 4. F-closure

This document closes **F08 — Failure classification is fragile and provider-agnostic**.

- **F01 interaction.** Batch 1 alone defuses F01-vs-F08 (contract HTTP 400 no longer poisons the cooldown ledger). F01 may then land independently to fix the request-side mutex; the two issues stop interlocking after Batch 1.
- **F03 (cooldown ledger).** F08 produces the typed `failure.retryAfterMs` / `failure.resetsAt` fields that F03's cooldown picker consumes. F03 owns the persisted ledger, backoff strategy, and process-shared health map; F08 owns the input to those decisions.
- **F05 (`LlmContractMismatchError`).** F05 introduces the class and the six terminal-protocol subtypes; F08 adds one provider-side subtype (`tools_and_response_format_conflict`) and is responsible for routing every `LlmContractMismatchError` through `decideFailure → fail_invocation`. The `ContractMismatchSubtype` enum in [src/agents/llm-failure.ts](../../../src/agents/llm-failure.ts) is the authoritative union; F05 contributes seven of its eight members.
- **F04 (unified attempt event).** F08 provides the typed payload F04 publishes. The event schema's `failure` field IS `LlmFailure`.

Key invariant established by this issue: **the recovery loop never sees an `Error` whose recovery action depends on parsing its `.message`.** Every failure that reaches `InvocationRecoveryPolicy.decideFailure` carries a typed `LlmFailure`, classified at the gateway boundary by the provider's own classifier. Status-only routing and message regexes are removed from the failure path.
