# F08 — Failure classification is fragile and provider-agnostic

## Summary

`InvocationRecoveryPolicy.classify` uses `instanceof` for the four canonical error types and falls back to a regex against the error message for everything else. `handleLlmHttpError` itself only branches on HTTP status (`401/403`, `429`, `>=500`, `else`) and never reads the response body. Two consequences:

1. Contract violations from `opencode-go` (HTTP 400 `"You cannot specify response format and function call at the same time"`) collapse into a generic `LlmServerError` → `server_transient` → `cooldown_and_failover`. So F01 also poisons the cooldown ledger.
2. Anything provider-specific (DeepSeek's `error.code = "context_length_exceeded"`, Together's `code: "model_not_found"`, etc.) is invisible to the classifier — every body becomes opaque string regex food.

## Evidence

HTTP error mapping:
- [src/agents/llm-errors.ts#L73-L96](src/agents/llm-errors.ts#L73)
```ts
if (status === 401 || status === 403) throw new LlmAuthError(...);
if (status === 429)                   throw new LlmRateLimitError(...);
if (status >= 500)                    throw new LlmServerError(...);
throw new LlmServerError(...);   // catch-all, includes 400
```
The body is captured into `body` for the error but never parsed into structured fields.

Classifier:
- [src/agents/invocation-recovery-policy.ts#L99-L116](src/agents/invocation-recovery-policy.ts#L99) — `classify(err)` returns one of the eight `InvocationFailureClass` values via `instanceof` for the four error classes plus a regex against `err.message` to detect "capability mismatch" wording.

Decision table:
- [src/agents/invocation-recovery-policy.ts#L120-L148](src/agents/invocation-recovery-policy.ts#L120) — `parse_or_contract` ⇒ `failover_without_cooldown` (good); `server_transient` ⇒ `cooldown_and_failover` (bad for contract bugs).

Concrete proof of the F01 misclassification: opencode-go returns 400 → falls to the catch-all `LlmServerError` branch → classified as `server_transient` → cooldown_and_failover. Verified by walking the code path; the operator-visible symptom is consistent (cooldown applied to a healthy candidate).

## Category

architectural

## Severity

medium-high — alone it is a clean-up item, but combined with F01 it actively damages the cooldown ledger and slows recovery.

## Transversality

scoped to `llm-errors.ts` and `invocation-recovery-policy.ts`, with optional plumbing through `LlmRateLimitError` (carry `retryAfterMs`) and the event schemas (F04).

## Recommended direction

- Introduce a per-provider error-body parser table. Each entry takes `(status, headers, jsonBody, textBody)` and returns either an `InvocationFailureClass` directly (skipping the generic mapper) or a structured `LlmError` with extra fields. Default fallback remains the current status-based table.
- Add `InvocationFailureClass.contract_rejection`, mapped to `failover_without_cooldown` (or `abort_without_retry` when the contract bug is on our side and is provider-independent).
- Map opencode-go's 400 "function call + response format" body to `contract_rejection`. This alone defuses the F01-vs-F08 interaction even before F01 is fixed.

## Cross-links

- F01 — currently masked by misclassification.
- F03 — body-level parsing is also needed to extract reset times.
- F04 — `failureClass` must round-trip through the event payload.
