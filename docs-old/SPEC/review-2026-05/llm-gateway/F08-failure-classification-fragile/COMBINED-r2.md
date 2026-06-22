# F08 — Failure classification is fragile and provider-agnostic (analysis + design + plan, r2)

Self-contained. File references are workspace-relative to `/home/salva/g/ml/saivage-v3/` and clickable. Per the workspace architecture-first / no-backward-compatibility guideline, no legacy enum is preserved, no migration shim is introduced, no feature flag survives. F08 closes here.

Cross-links: **F03** (cooldown consumes the typed classifier output), **F05** (defines `LlmContractMismatchError` and the terminal-protocol subtypes per [F05-r4](../F05-envelope-vs-toolcalls-orthogonality/02-design-r4.md)), **F04** (`invocation_failed.failure` carries the typed payload).

r2 changes vs r1: collapses the substrate/recovery/importer-migration sequence into a single transactional batch (Batch 1) so every checkpoint is a green `npx tsc --noEmit` plus targeted Jest. r1's separate "Batch 1 deletes hierarchy / Batch 2 rewrites recovery" sequence left recovery code referring to deleted classes between commits; r2 deletes the hierarchy only after all importers (recovery policy, capability check, stream parsers, recording, analyst resolver, both gateways, their tests) have been rewritten in the same commit. F03 cooldown wiring and F04 schema rev stay as their own green follow-up batches because they cross issue boundaries.

---

## 1. Analysis (≤ 120 lines)

### 1.1 Where the classifier lives

Two files own the entire failure path between an HTTP response and a recovery action:

- HTTP-status mapper: [src/agents/llm-errors.ts#L70-L96](../../../src/agents/llm-errors.ts#L70).
- String classifier + recovery decision: [src/agents/invocation-recovery-policy.ts#L99-L148](../../../src/agents/invocation-recovery-policy.ts#L99).
- Error class hierarchy (input to the classifier): [src/agents/llm-errors.ts#L3-L57](../../../src/agents/llm-errors.ts#L3).

A single `InvocationFailureClass` string union (eight members) at [src/agents/invocation-recovery-policy.ts#L12-L22](../../../src/agents/invocation-recovery-policy.ts#L12) is the only typed surface between transport-level errors and the recovery loop. Every observability event, cooldown decision, and "should we failover?" branch downstream pivots on this string.

### 1.2 The eight current failure classes — trigger conditions and recovery actions

Read `classify` at [src/agents/invocation-recovery-policy.ts#L99-L116](../../../src/agents/invocation-recovery-policy.ts#L99) for triggers and `decideFailure` at [src/agents/invocation-recovery-policy.ts#L120-L148](../../../src/agents/invocation-recovery-policy.ts#L120) for the action.

| Class | Trigger (today) | Action |
| --- | --- | --- |
| `cancelled` | `AbortError` instance or regex `/\bcancell?ed\b|\babort(?:ed)?\b/i` on message ([invocation-recovery-policy.ts#L83-L88](../../../src/agents/invocation-recovery-policy.ts#L83)) | `abort_without_retry` |
| `capability_mismatch` | Capability-skip context + `/does not support requested LLM capabilities|unsupported_/i`, or the same regex unconditionally ([invocation-recovery-policy.ts#L90-L96](../../../src/agents/invocation-recovery-policy.ts#L90)) | `failover_without_cooldown` |
| `auth_permanent` | `error instanceof LlmAuthError` (raised on HTTP 401/403 at [llm-errors.ts#L82-L84](../../../src/agents/llm-errors.ts#L82)) | `failover_without_cooldown` |
| `rate_limit_transient` | `error instanceof LlmRateLimitError` (HTTP 429 at [llm-errors.ts#L86-L88](../../../src/agents/llm-errors.ts#L86)) | `cooldown_and_failover`, cooldown = fixed `recoveryDelayMs` |
| `server_transient` | `error instanceof LlmServerError` — raised on HTTP ≥ 500 AND every non-2xx catch-all ([llm-errors.ts#L92-L93](../../../src/agents/llm-errors.ts#L92)), plus `TypeError` and unknown synthesis at [llm-errors.ts#L101-L104](../../../src/agents/llm-errors.ts#L101) | `cooldown_and_failover`, cooldown = fixed `recoveryDelayMs` |
| `timeout_transient` | `error instanceof LlmTimeoutError`, also synthesised from `AbortError` at [llm-errors.ts#L98-L100](../../../src/agents/llm-errors.ts#L98) | `cooldown_and_failover`, cooldown = fixed `recoveryDelayMs` |
| `parse_or_contract` | `error instanceof LlmParseError`, or `SyntaxError`/`TypeError`, or regex `/parse|schema|contract|validation failed|invalid .*json/i` on message ([invocation-recovery-policy.ts#L106-L108](../../../src/agents/invocation-recovery-policy.ts#L106)) | `retry_same_after_delay` if `attempt ≤ maxRecoveryRetries`, else `failover_without_cooldown` |
| `unknown` | Anything not matched above | `cooldown_and_failover` |

### 1.3 The broken mapping (proof)

Path for opencode-go's HTTP 400 `"You cannot specify response format and function call at the same time"`:

1. Chat gateway POSTs; non-2xx → `handleLlmHttpError(response, 'llm-openai-chat-gateway')` at [src/agents/llm-openai-chat-gateway.ts#L93](../../../src/agents/llm-openai-chat-gateway.ts#L93).
2. Status is 400. The branches at [llm-errors.ts#L81-L91](../../../src/agents/llm-errors.ts#L81) check `401|403`, then `429`, then `>= 500`. None match.
3. Catch-all at [llm-errors.ts#L93](../../../src/agents/llm-errors.ts#L93): `throw new LlmServerError(\`LLM request failed (HTTP ${status})${detail}\`, status);`.
4. `InvocationRecoveryPolicy.classify` at [invocation-recovery-policy.ts#L104](../../../src/agents/invocation-recovery-policy.ts#L104) hits `error instanceof LlmServerError` first and returns `'server_transient'`.
5. `decideFailure` at [invocation-recovery-policy.ts#L128-L131](../../../src/agents/invocation-recovery-policy.ts#L128) returns `cooldown_and_failover` with `cooldownMs = context.recoveryDelayMs`.
6. The candidate is marked failed via `markFailed: true`. The next role invocation skips it through `ProviderRegistry.isHealthy` at [src/agents/provider.ts#L289](../../../src/agents/provider.ts#L289). Recovery is slowed because the model is healthy — we just sent a request our own adapter assembled wrong.

### 1.4 Where the provider body is parsed

Nowhere. `handleLlmHttpError` reads the body once at [llm-errors.ts#L72-L77](../../../src/agents/llm-errors.ts#L72) and folds it into the error message as a 500-char `detail` string after redaction. It is never JSON-parsed; no fields are extracted; no per-provider matcher runs. `Retry-After`, `x-ratelimit-reset`, DeepSeek `code: "context_length_exceeded"`, Together `code: "model_not_found"`, Anthropic `type: "overloaded_error"` — none reach the recovery loop.

### 1.5 Per-provider failure-shape divergence (opencode-go vs openai-codex)

Both gateways converge on `handleLlmHttpError` via [llm-openai-chat-gateway.ts#L93](../../../src/agents/llm-openai-chat-gateway.ts#L93) and [llm-openai-codex-gateway.ts#L80](../../../src/agents/llm-openai-codex-gateway.ts#L80). They differ in ways the classifier ignores:

- **Body shape.** `opencode-go` returns `{"error":{"message":"You cannot specify response format and function call at the same time","type":"invalid_request_error"}}` at status 400. `openai-codex` (Responses API) returns `{"error":{"type":"invalid_request_error","message":"…","code":"…"}}` with codes `unsupported_value`, `model_not_found`, `context_length_exceeded`, or for tool-mode mismatches a 422 with `code: "unsupported_value"`.
- **Rate-limit headers.** `opencode-go` forwards upstream `Retry-After` (seconds), `x-ratelimit-reset-requests` (epoch seconds). Codex uses `x-ratelimit-reset` (ISO timestamp) and inlines `"Rate limit reached … please try again in 12.4s"`. Both become a generic `LlmRateLimitError(message, 429)` ([llm-errors.ts#L14-L23](../../../src/agents/llm-errors.ts#L14)) with no `retryAfterMs` field, so F03's cooldown picker has no signal.

Per-provider divergence is invisible to the recovery loop because there is no per-provider parser anywhere in the failure path.

---

## 2. Design (≤ 200 lines)

Two proposals. Both replace the broken HTTP-400 mapping. Proposal A is focused; Proposal B is the level-up. Per the workspace guideline, the recommendation is **Proposal B**.

### 2.1 Proposal A — focused: add a contract-error branch

**Idea.** Keep the eight-class string union and the `instanceof` classifier. Add one extra check in `handleLlmHttpError`: if status is 400 and the body matches a known "our contract" fingerprint, raise `LlmContractMismatchError` (introduced by F05) instead of `LlmServerError`. The recovery policy gains one branch: `LlmContractMismatchError → fail_invocation`, no cooldown, no failover.

**Data model.** Unchanged hierarchy plus `LlmContractMismatchError`. `InvocationFailureClass` gains one member, `'contract_mismatch'`; the union becomes nine. `LlmContractMismatchError` already carries a subtype string (F05 §4.3); A does not extend it.

**Body-fingerprint match.** A small fixed table in `llm-errors.ts`:

```ts
const CONTRACT_FINGERPRINTS: Array<{ statuses: number[]; bodyPattern: RegExp; subtype: ContractMismatchSubtype }> = [
  { statuses: [400], bodyPattern: /response format.*function call|tools.*response_format|cannot specify response_format/i, subtype: 'tools_and_response_format_conflict' },
];
```

`handleLlmHttpError` reads the body (it already does), tries each fingerprint, and falls through to the existing branches on no match.

**Recovery policy table addendum.**

| Class | Action |
| --- | --- |
| `contract_mismatch` | `fail_invocation`, `markFailed: false`, `appendModelIssue: true`, `abort: true`, no cooldown |

**Observability + cooldown.** Same wiring as today; only the new class is added to F04's enum and to F03's "do not mark failed" set.

**Cost.** Three to four call sites changed. Test surface small.

**Limitations.** Every new per-provider shape (DeepSeek `context_length_exceeded`, Together `model_not_found`, Anthropic `overloaded_error`, rate-limit reset hints) still rides the same status-only path. The next time we need provider-specific behaviour the `if-else` chain grows. The string union stays brittle: the classifier still uses regex on the message at [invocation-recovery-policy.ts#L108](../../../src/agents/invocation-recovery-policy.ts#L108).

### 2.2 Proposal B — level-up: typed discriminated union + per-provider classifier table

**Idea.** Delete the eight-member string union. Replace it with a typed discriminated union of failure cases, each carrying the fields the recovery loop actually needs. Move body parsing out of the global `handleLlmHttpError` into a per-provider classifier table. Each gateway owns the contract that says "for HTTP 400, this is what to look at".

**Data model.** In a new file [src/agents/llm-failure.ts](../../../src/agents/llm-failure.ts):

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
  | 'tools_and_response_format_conflict'    // opencode-go HTTP 400 (F08-owned)
  | 'terminal_prose_only'                   // F05-owned
  | 'terminal_duplicate'
  | 'terminal_mixed_with_actions'
  | 'terminal_wrong_role'
  | 'terminal_missing_on_forced_turn'
  | 'terminal_arguments_not_json'
  | 'terminal_arguments_schema_mismatch';

export class LlmRequestError extends Error {
  constructor(public readonly failure: LlmFailure) { super(failure.message); this.name = 'LlmRequestError'; }
}

export function unwrapFailure(err: unknown): LlmFailure { /* see §3.1.1 */ }
```

The classes in [src/agents/llm-errors.ts](../../../src/agents/llm-errors.ts) (`LlmAuthError`, `LlmRateLimitError`, `LlmServerError`, `LlmTimeoutError`, `LlmParseError`, `StructuredLlmError`, `isStructuredLlmError`, `handleLlmHttpError`, `normalizeLlmTransportError`) are deleted. F05's `LlmContractMismatchError` survives in `llm-errors.ts`; it constructs an `LlmFailure { kind: 'contract_mismatch' }`. `redactProviderErrorText` survives.

**Classifier ownership.** A per-provider classifier table in [src/agents/llm-failure-classifiers.ts](../../../src/agents/llm-failure-classifiers.ts):

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
export function classifierFor(provider: ProviderName): ProviderFailureClassifier { … }
export function defaultHttpClassifier(provider: ProviderName, status: number, headers: Headers, body: string): LlmFailure { … }
```

Each classifier owns: best-effort JSON body parse (never throws — returns `null` on undecidable shape); status → `kind` mapping; header → `retryAfterMs` / `resetsAt` extraction (Codex parses ISO `x-ratelimit-reset`; chat parses `Retry-After` seconds; falls back to `try again in 12.4s`); contract-mismatch fingerprints (opencode-go HTTP 400 → `tools_and_response_format_conflict`). A `null` return means "I don't recognise this shape; fall through to the default mapper".

Both gateways become:

```ts
if (!response.ok) {
  const body = await response.text();
  const failure = classifierFor(candidate.provider).classifyHttp(response.status, response.headers, body)
                ?? defaultHttpClassifier(candidate.provider, response.status, response.headers, body);
  await handle?.recordError({ errorName: 'LlmRequestError', message: failure.message, status: response.status, bodyRaw: body });
  throw new LlmRequestError(failure);
}
```

`InvocationRecoveryPolicy.classify` becomes `(err: unknown) => unwrapFailure(err)` returning `LlmFailure`. `unwrapFailure` handles `LlmRequestError`, `LlmContractMismatchError`, `AbortError`/`DOMException`, raw `Error`s, and synthesises `{ kind: 'cancelled' }` / `{ kind: 'unknown' }`.

**Recovery policy table.** `decideFailure` switches on `failure.kind` (typed; compiler enforces exhaustiveness via `assertNever`):

| `kind` | `action` | `markFailed` | `cooldownMs` |
| --- | --- | --- | --- |
| `auth_permanent` | `failover_without_cooldown` | false | — |
| `rate_limit` | `cooldown_and_failover` | true | `failure.retryAfterMs ?? (failure.resetsAt - now) ?? recoveryDelayMs` (F03 wires) |
| `server_transient` | `cooldown_and_failover` | true | `recoveryDelayMs` |
| `timeout` | `cooldown_and_failover` | true | `recoveryDelayMs` |
| `contract_mismatch` | `fail_invocation` | false | — |
| `capability_mismatch` | `failover_without_cooldown` | false | — |
| `token_budget_exceeded` | `fail_invocation` | false | — |
| `parse_error` | `retry_same_after_delay` if `attempt ≤ maxRecoveryRetries`, else `failover_without_cooldown` | false | — |
| `cancelled` | `abort_without_retry` | false | — |
| `unknown` | `cooldown_and_failover` | true | `recoveryDelayMs` |

The `InvocationFailureClass` string union at [src/agents/invocation-recovery-policy.ts#L12-L22](../../../src/agents/invocation-recovery-policy.ts#L12) is deleted. Event payloads serialize `failure.kind` directly.

**Observability tie-in (F04).** `failure` is the structured payload F04 mandates on `invocation_failed`. The F04 schema declares a `failure` object with `kind` plus per-kind fields (`retryAfterMs?`, `resetsAt?`, `subtype?`, `tokensLimit?`). `LlmFailure` is JSON by construction.

**Cooldown tie-in (F03).** F03's cooldown picker reads `failure.retryAfterMs` / `failure.resetsAt` directly when `kind === 'rate_limit'`. No header re-parsing in F03.

**Recommendation per architecture-first guideline: Proposal B.** Proposal A defuses the immediate F01-vs-F08 interaction but leaves the next provider-divergence bug one regex away. Proposal B replaces the brittle layer instead of patching it.

---

## 3. Plan (≤ 180 lines)

r1 sequenced this as Batch 1 (delete hierarchy) → Batch 2 (rewrite recovery) → Batch 3 (wire F03/F04). The reviewer ([COMBINED-review-r1.md#L3](COMBINED-review-r1.md#L3)) flagged Batch 1 as uncompilable because recovery, the capability check, both stream parsers, recording, and the analyst resolver still imported the deleted classes. r2 collapses substrate + recovery + every importer migration into ONE transactional batch. F03 cooldown wiring and F04 schema rev stay as their own green follow-up batches because they touch sibling issues.

Each batch ends with: `npx tsc --noEmit` clean, the targeted Jest test files green, and a zero-hit `grep` gate on the names the batch is supposed to retire.

### 3.1 Batch 1 (transactional) — introduce `LlmFailure`, delete the legacy hierarchy, rewrite EVERY importer in the same commit

#### 3.1.1 New files

1. [src/agents/llm-failure.ts](../../../src/agents/llm-failure.ts) — `LlmFailure` union, `ContractMismatchSubtype`, `ProviderName` re-export, `LlmRequestError` (the one concrete `Error` subclass that wraps `LlmFailure`), `unwrapFailure(err)`. `unwrapFailure` rules:
   - `err instanceof LlmRequestError` → `err.failure`.
   - `err instanceof LlmContractMismatchError` → its embedded `LlmFailure { kind: 'contract_mismatch' }`.
   - `err instanceof DOMException && err.name === 'AbortError'` → `{ kind: 'cancelled', reason: 'abort', message }`.
   - `err instanceof Error` with `/parse|schema|contract|validation failed|invalid .*json/i` → `{ kind: 'parse_error', provider: 'unknown', bodyPreview: '', message }`.
   - default → `{ kind: 'unknown', provider: null, message: String(err) }`.
2. [src/agents/llm-failure-classifiers.ts](../../../src/agents/llm-failure-classifiers.ts) — the five `ProviderFailureClassifier`s, `DEFAULT_CLASSIFIER_TABLE`, `classifierFor`, `defaultHttpClassifier`. Each classifier:
   - parses headers `Retry-After`, `x-ratelimit-reset`, `x-ratelimit-reset-requests`;
   - extracts `error.message`, `error.code`, `error.type` from a best-effort `JSON.parse(body)`;
   - emits `{ kind: 'contract_mismatch', subtype: 'tools_and_response_format_conflict', … }` for the opencode-go HTTP 400 fingerprint;
   - emits `{ kind: 'token_budget_exceeded', … }` for `code: 'context_length_exceeded'` / `'max_tokens_exceeded'`;
   - returns `null` for unrecognised shapes (default mapper handles them).

#### 3.1.2 Rewrites (all in the same commit)

3. [src/agents/llm-errors.ts](../../../src/agents/llm-errors.ts) shrinks to: `LlmContractMismatchError` (already F05-owned), `redactProviderErrorText`, and a re-export of `LlmRequestError` and `LlmFailure` from `./llm-failure.js`. Delete `LlmAuthError`, `LlmRateLimitError`, `LlmServerError`, `LlmTimeoutError`, `LlmParseError`, `StructuredLlmError`, `isStructuredLlmError`, `handleLlmHttpError`, `normalizeLlmTransportError`.
4. [src/agents/llm-openai-chat-gateway.ts](../../../src/agents/llm-openai-chat-gateway.ts) — at the `!response.ok` branch ([L93](../../../src/agents/llm-openai-chat-gateway.ts#L93)), call `classifierFor(provider).classifyHttp(...) ?? defaultHttpClassifier(...)`, then `throw new LlmRequestError(failure)`. The `!response.body` guard at [L97](../../../src/agents/llm-openai-chat-gateway.ts#L97) becomes `throw new LlmRequestError({ kind: 'server_transient', status: response.status, provider, message: 'Streaming response has no body' })`. Parse failures at [L112](../../../src/agents/llm-openai-chat-gateway.ts#L112) and [L115](../../../src/agents/llm-openai-chat-gateway.ts#L115) become `throw new LlmRequestError({ kind: 'parse_error', provider, bodyPreview: rawText.slice(0, 500), message })`. The catch at [L127](../../../src/agents/llm-openai-chat-gateway.ts#L127) calls `classifierFor(provider).classifyTransport(err) ?? unwrapFailure(err)` and throws `LlmRequestError` wrapping the result.
5. [src/agents/llm-openai-codex-gateway.ts](../../../src/agents/llm-openai-codex-gateway.ts) — same pattern at [L80](../../../src/agents/llm-openai-codex-gateway.ts#L80), [L82](../../../src/agents/llm-openai-codex-gateway.ts#L82), [L94](../../../src/agents/llm-openai-codex-gateway.ts#L94). The `!this.apiKey` guard at [L41](../../../src/agents/llm-openai-codex-gateway.ts#L41) and the account-id extraction at [L177](../../../src/agents/llm-openai-codex-gateway.ts#L177) throw `new LlmRequestError({ kind: 'auth_permanent', status: 401, provider: 'openai-codex', message })`.
6. [src/agents/llm-provider-gateway.ts#L5](../../../src/agents/llm-provider-gateway.ts#L5) and [L51](../../../src/agents/llm-provider-gateway.ts#L51) — the capability-mismatch throw becomes `throw new LlmRequestError({ kind: 'capability_mismatch', provider, reasons, message })`. The regex-based detection in the recovery policy is deleted because this is now typed.
7. [src/agents/llm-stream-parser.ts](../../../src/agents/llm-stream-parser.ts) — replace `LlmTimeoutError`/`LlmServerError` imports with `LlmRequestError` from `./llm-failure.js`. [L33](../../../src/agents/llm-stream-parser.ts#L33) becomes `if (err instanceof LlmRequestError) throw err;`. [L35](../../../src/agents/llm-stream-parser.ts#L35) becomes `throw new LlmRequestError({ kind: 'cancelled', reason: 'timeout', message: 'Streaming LLM request aborted due to timeout' })`. [L37](../../../src/agents/llm-stream-parser.ts#L37) becomes `throw new LlmRequestError({ kind: 'server_transient', status: 0, provider, message: 'Error reading LLM stream: ...' })`.
8. [src/agents/llm-codex-parser.ts](../../../src/agents/llm-codex-parser.ts) — analogous: imports become `LlmRequestError`; [L38](../../../src/agents/llm-codex-parser.ts#L38), [L40](../../../src/agents/llm-codex-parser.ts#L40), [L42](../../../src/agents/llm-codex-parser.ts#L42), [L118](../../../src/agents/llm-codex-parser.ts#L118), [L120](../../../src/agents/llm-codex-parser.ts#L120) all throw `LlmRequestError` with appropriate `kind` (`cancelled`, `parse_error`, `server_transient`).
9. [src/agents/llm-recording.ts#L3](../../../src/agents/llm-recording.ts#L3) and [L78](../../../src/agents/llm-recording.ts#L78) — replace `err instanceof LlmServerError ? err.statusCode : undefined` with `err instanceof LlmRequestError && 'status' in err.failure ? err.failure.status : undefined`.
10. [src/agents/analyst-llm-resolver.ts](../../../src/agents/analyst-llm-resolver.ts) — delete the imports at [L5-L9](../../../src/agents/analyst-llm-resolver.ts#L5) and rewrite the catch at [L181-L191](../../../src/agents/analyst-llm-resolver.ts#L181):

    ```ts
    } catch (err) {
      const failure = unwrapFailure(err);
      if (failure.kind === 'auth_permanent') {
        this.registry.markFailed(candidate, this.runtimeConfig.recoveryDelayMs ?? 60000);
        lastTransportError = err;
        continue;
      }
      if (failure.kind === 'rate_limit' || failure.kind === 'server_transient' || failure.kind === 'timeout' || failure.kind === 'parse_error') {
        lastTransportError = err;
        continue;
      }
      throw err;
    }
    ```

11. [src/agents/invocation-recovery-policy.ts](../../../src/agents/invocation-recovery-policy.ts) — delete the legacy imports at [L3-L7](../../../src/agents/invocation-recovery-policy.ts#L3), delete `InvocationFailureClass` ([L12-L22](../../../src/agents/invocation-recovery-policy.ts#L12)), delete `isAbortLike` and `isCapabilityMismatch` ([L83-L96](../../../src/agents/invocation-recovery-policy.ts#L83)). Rewrite `classify` to `(err) => unwrapFailure(err)` and `decideFailure` as `switch (failure.kind)` per §2.2 with `assertNever`. `InvocationRecoveryDecision.failureClass: string | undefined` ([L45](../../../src/agents/invocation-recovery-policy.ts#L45)) becomes `failure: LlmFailure | undefined`. `buildDecision`'s second parameter ([L169](../../../src/agents/invocation-recovery-policy.ts#L169)) takes `LlmFailure | undefined`. Event payload fields at [L182](../../../src/agents/invocation-recovery-policy.ts#L182) and [L194](../../../src/agents/invocation-recovery-policy.ts#L194) emit `failure: failure` instead of `failureClass`.
12. [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts) — at [L399](../../../src/agents/agent-adapter.ts#L399), [L410-L411](../../../src/agents/agent-adapter.ts#L410), [L414](../../../src/agents/agent-adapter.ts#L414), [L418-L419](../../../src/agents/agent-adapter.ts#L418) rewrite `decision.failureClass` to `decision.failure?.kind` and the event payloads to emit `failure: decision.failure` instead of `failureClass`. The cancelled-branch check at [L414](../../../src/agents/agent-adapter.ts#L414) becomes `if (decision.failure?.kind === 'cancelled' || …)`.

#### 3.1.3 Tests rewritten in the same commit

13. [tests/agents/invocation-recovery-policy.test.ts](../../../tests/agents/invocation-recovery-policy.test.ts) — delete the `LlmAuthError`/`LlmParseError` etc. imports at [L8-L9](../../../tests/agents/invocation-recovery-policy.test.ts#L8); rewrite every fixture (currently `failureClass: 'auth_permanent'` etc. at [L30](../../../tests/agents/invocation-recovery-policy.test.ts#L30), [L35](../../../tests/agents/invocation-recovery-policy.test.ts#L35), [L41](../../../tests/agents/invocation-recovery-policy.test.ts#L41), [L46](../../../tests/agents/invocation-recovery-policy.test.ts#L46), [L62](../../../tests/agents/invocation-recovery-policy.test.ts#L62), [L77](../../../tests/agents/invocation-recovery-policy.test.ts#L77), [L86](../../../tests/agents/invocation-recovery-policy.test.ts#L86), [L96](../../../tests/agents/invocation-recovery-policy.test.ts#L96), [L108](../../../tests/agents/invocation-recovery-policy.test.ts#L108), [L116](../../../tests/agents/invocation-recovery-policy.test.ts#L116), [L122](../../../tests/agents/invocation-recovery-policy.test.ts#L122)) to assert `decision.failure?.kind` and `decision.action`.
14. [tests/agents/agent-adapter-recovery.test.ts](../../../tests/agents/agent-adapter-recovery.test.ts) — at [L9](../../../tests/agents/agent-adapter-recovery.test.ts#L9), [L67](../../../tests/agents/agent-adapter-recovery.test.ts#L67), [L110](../../../tests/agents/agent-adapter-recovery.test.ts#L110) replace `new LlmAuthError(...)` / `new LlmServerError(...)` with `new LlmRequestError({ kind: 'auth_permanent', status: 401, provider: 'openai-chat', message: '…' })` / `new LlmRequestError({ kind: 'server_transient', status: 502, provider: 'openai-chat', message: 'upstream unavailable' })`.
15. New [tests/agents/llm-failure-classifiers.test.ts](../../../tests/agents/llm-failure-classifiers.test.ts) — per-classifier fixtures (see §3.3).

#### 3.1.4 Gate (single transactional checkpoint)

After the commit:

- `npx tsc --noEmit` — clean.
- `npx jest tests/agents/llm-failure-classifiers.test.ts tests/agents/invocation-recovery-policy.test.ts tests/agents/agent-adapter-recovery.test.ts` — green.
- `grep -rn 'LlmAuthError\|LlmRateLimitError\|LlmServerError\|LlmTimeoutError\|LlmParseError\|StructuredLlmError\|isStructuredLlmError\|handleLlmHttpError\|normalizeLlmTransportError\|InvocationFailureClass\|failureClass\b' src/ tests/ web/src/` — zero hits.
- `grep -rn "'server_transient'\|'rate_limit_transient'\|'timeout_transient'\|'parse_or_contract'" src/ tests/ web/src/` — zero hits.

The current grep audit (run 2026-05-29) confirms the migration scope: legacy-class importers live ONLY in `src/agents/llm-{errors,openai-chat-gateway,openai-codex-gateway,provider-gateway,stream-parser,codex-parser,recording}.ts`, `src/agents/{invocation-recovery-policy,analyst-llm-resolver,agent-adapter}.ts`, and `tests/agents/{invocation-recovery-policy,agent-adapter-recovery}.test.ts`. `web/src/` has no `failureClass` reference. There is no fan-out beyond this list.

**Rollback.** `git revert` the single commit. Because every importer travels with the substrate change, revert is atomic and clean.

### 3.2 Batch 2 — F03 cooldown wiring

**Changes.**

1. `ProviderRegistry.markFailed` at [src/agents/provider.ts#L320](../../../src/agents/provider.ts#L320) gains an optional `LlmFailure` parameter; when `failure.kind === 'rate_limit'` it picks `failure.retryAfterMs ?? (failure.resetsAt && failure.resetsAt - Date.now()) ?? recoveryDelayMs`.
2. `InvocationRecoveryPolicy.decideFailure`'s `rate_limit` branch passes `failure` into `markFailed`. Fixed `recoveryDelayMs` survives only as the last fallback.

**Gate.** `npx tsc --noEmit` clean. `npx jest tests/agents/invocation-recovery-policy.test.ts tests/agents/provider.test.ts` green. Test `rate_limit_with_retry_after_uses_provider_hint` asserts `cooldownMs === failure.retryAfterMs`.

**Rollback.** Revert; Batch 1 stays green on its own — fixed `recoveryDelayMs` resumes.

### 3.3 Batch 3 — F04 event schema rev

**Changes.**

1. `invocation_failed` in [src/schemas/event-catalog.ts#L51](../../../src/schemas/event-catalog.ts#L51) declares `failure` as the Zod-typed `LlmFailure` union; the bare `error_message` field is deleted (consumers read `failure.message`).
2. [src/schemas/types.ts#L156](../../../src/schemas/types.ts#L156) — `InvocationFailedEvent.error_message: string` becomes `failure: LlmFailure`.
3. [src/schemas/validators.ts#L166](../../../src/schemas/validators.ts#L166) — `invocationFailedEventSchema` swaps `error_message: z.string()` for `failure: llmFailureSchema` (Zod discriminated-union, exported from `src/schemas/llm-failure.ts`, generated from `LlmFailure`).
4. `AgentAdapter`'s event emissions ([src/agents/agent-adapter.ts#L410-L411](../../../src/agents/agent-adapter.ts#L410)) replace `error_message: this.redactModelIssueText(decision.message)` with `failure: { …decision.failure, message: this.redactModelIssueText(decision.failure.message) }`.

**Gate.** `npx tsc --noEmit` clean. `npx jest tests/schemas tests/agents/agent-adapter.test.ts` green.

**Rollback.** Revert; Batches 1–2 stay green on their own.

### 3.4 Named tests

All under `tests/agents/`.

1. **[tests/agents/llm-failure-classifiers.test.ts](../../../tests/agents/llm-failure-classifiers.test.ts) — Batch 1.**
   - `opencode_go_http_400_tools_and_response_format → contract_mismatch:tools_and_response_format_conflict` — Status 400, body `'{"error":{"message":"You cannot specify response format and function call at the same time","type":"invalid_request_error"}}'`. Asserts `{ kind: 'contract_mismatch', subtype: 'tools_and_response_format_conflict', provider: 'opencode-go', providerMessage: 'You cannot specify response format and function call at the same time' }`.
   - `openai_chat_429_with_retry_after_seconds → rate_limit:retryAfterMs=12000` — Status 429, header `Retry-After: 12`. Asserts `{ kind: 'rate_limit', retryAfterMs: 12000 }`.
   - `openai_codex_429_with_iso_reset → rate_limit:resetsAt=…` — Status 429, header `x-ratelimit-reset: 2026-05-29T12:34:56Z`. Asserts `{ kind: 'rate_limit', resetsAt: Date.parse('2026-05-29T12:34:56Z') }`.
   - `deepseek_400_context_length → token_budget_exceeded` — Status 400, body `'{"error":{"code":"context_length_exceeded","message":"…"}}'`. Asserts `{ kind: 'token_budget_exceeded' }`.
   - `unrecognised_4xx → null_falls_through_to_default_server_transient` — `OpenCodeGoClassifier.classifyHttp(418, …, '{}')` returns `null`; `defaultHttpClassifier` yields `{ kind: 'server_transient', status: 418 }`.
   - Parameterized `describe.each(PROVIDERS)` reuses fixtures so adding a provider is one fixture line.

2. **[tests/agents/invocation-recovery-policy.test.ts](../../../tests/agents/invocation-recovery-policy.test.ts) — Batch 1.**
   - `contract_mismatch_does_not_failover_and_does_not_cooldown` — Input `{ kind: 'contract_mismatch', subtype: 'tools_and_response_format_conflict' }`. Asserts `decision.action === 'fail_invocation'`, `decision.markFailed === false`, `decision.cooldownMs === undefined`, `decision.abort === true`.
   - `rate_limit_with_retry_after_uses_provider_hint` — Input `{ kind: 'rate_limit', retryAfterMs: 12000 }`. Asserts `decision.action === 'cooldown_and_failover'`, `decision.markFailed === true`; the `cooldownMs === 12000` assertion is gated to Batch 2.
   - `parse_error_retries_then_failovers` — `attempt: 1, maxRecoveryRetries: 2` → `retry_same_after_delay`; `attempt: 3` → `failover_without_cooldown`.
   - `capability_mismatch_kind_does_not_cooldown` — Input from gateway's typed capability skip, not from a regex.
   - `cancelled_aborts` — `{ kind: 'cancelled', reason: 'abort' }` → `abort_without_retry`.

3. **[tests/agents/agent-adapter.test.ts](../../../tests/agents/agent-adapter.test.ts) — Batch 1 update.**
   - The F01-regression case (`tools_and_response_format_emitted_simultaneously`) asserts the failure surfaces as `LlmFailure.kind === 'contract_mismatch'` and the candidate is NOT marked cooldown-bearing (`registry.getHealth(candidate)` shows no failure).

### 3.5 Risk + rollback summary

| Batch | Primary risk | Rollback |
| --- | --- | --- |
| 1 (transactional) | Forgotten importer outside the listed files. Mitigated by the §3.1.4 zero-hit `grep` gate, which is part of the checkpoint. | `git revert` the single commit; legacy hierarchy returns atomically with every importer. |
| 2 | F03 cooldown picker reads malformed `retryAfterMs`. Mitigated by classifier-side validation in Batch 1. | `git revert`; fixed `recoveryDelayMs` resumes. |
| 3 | Persisted events on disk with the old `error_message` field cannot be re-validated. F04 ships a one-shot reader migration; F08 does not own backfill. | `git revert`; old `error_message` field returns. |

---

## 4. F-closure

This document closes **F08 — Failure classification is fragile and provider-agnostic**.

- **F01 interaction.** Batch 1 alone defuses F01-vs-F08 (contract HTTP 400 no longer poisons the cooldown ledger). F01 may then land independently to fix the request-side mutex; the two issues stop interlocking after Batch 1.
- **F03 (cooldown ledger).** F08 produces the typed `failure.retryAfterMs` / `failure.resetsAt` fields that F03's cooldown picker consumes (Batch 2). F03 owns the persisted ledger, backoff strategy, and process-shared health map.
- **F05 (`LlmContractMismatchError`).** F05 introduces the class and the six terminal-protocol subtypes per [02-design-r4.md](../F05-envelope-vs-toolcalls-orthogonality/02-design-r4.md); F08 adds one provider-side subtype (`tools_and_response_format_conflict`) and routes every `LlmContractMismatchError` through `decideFailure → fail_invocation`. The `ContractMismatchSubtype` enum in [src/agents/llm-failure.ts](../../../src/agents/llm-failure.ts) is the authoritative union; F05 contributes seven of its eight members.
- **F04 (unified attempt event).** F08 provides the typed payload F04 publishes (Batch 3). The event schema's `failure` field IS `LlmFailure`.

Key invariant established: **the recovery loop never sees an `Error` whose recovery action depends on parsing its `.message`.** Every failure that reaches `InvocationRecoveryPolicy.decideFailure` carries a typed `LlmFailure`, classified at the gateway boundary by the provider's own classifier. Status-only routing and message regexes are removed from the failure path.
