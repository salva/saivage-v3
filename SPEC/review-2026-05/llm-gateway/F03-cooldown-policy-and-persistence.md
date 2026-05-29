# F03 — Per-candidate cooldown ignores provider-supplied reset time and never persists

## Summary

`ProviderRegistry.markFailed(candidate, cooldownMs)` stores cooldown in an in-memory `Map<string, CandidateHealth>` ([src/agents/provider.ts#L309-L327](src/agents/provider.ts#L309)). The cooldown duration is always `decision.cooldownMs ?? 60000`, which is sourced from runtime `recoveryDelayMs` (default 60s — [src/agents/invocation-recovery-policy.ts#L120-L148](src/agents/invocation-recovery-policy.ts#L120)). The HTTP response body for 429s commonly carries `resets_at` / `Retry-After` (and the operator brief shows `resets_at=1780172729`, ~24 h ahead) — these are not parsed, so a rate-limited candidate is retried 60 s later and immediately throttled again. There is also no on-disk persistence: a process restart resets every cooldown.

## Evidence

Cooldown storage:
- [src/agents/provider.ts#L226](src/agents/provider.ts#L226) — `private readonly healthStates = new Map<string, CandidateHealth>();`
- [src/agents/provider.ts#L309-L327](src/agents/provider.ts#L309) — `markFailed` sets `cooldownUntilMs = Date.now() + cooldownMs`.
- [src/agents/provider.ts#L289-L307](src/agents/provider.ts#L289) — `isHealthy` clears cooldown when expired.

Cooldown duration source:
- [src/agents/invocation-recovery-policy.ts#L130-L142](src/agents/invocation-recovery-policy.ts#L130) — `cooldownMs: context.recoveryDelayMs` (set per-call by `AgentAdapter` to `runtime.recoveryDelayMs`, default 60 000).

HTTP error mapper does not read body:
- [src/agents/llm-errors.ts#L73-L96](src/agents/llm-errors.ts#L73) — `handleLlmHttpError` only branches on status code; the response body is logged but its fields (`Retry-After` header, `resets_at`, provider-specific `reset_in_seconds`) are not extracted.

`LlmRateLimitError` has no `retryAfterMs` field:
- [src/agents/llm-errors.ts](src/agents/llm-errors.ts) — class declaration carries only `status` and `body`.

Process scoping:
- [src/runtime/active-runtime.ts#L164](src/runtime/active-runtime.ts#L164) — one `AgentAdapter` per runtime; one `ProviderRegistry` per `AgentAdapter`; one runtime per process. So cooldowns live for the life of the process and are lost on every restart of `saivage.service`.

## Category

architectural

## Severity

high — both legs are real. The user-visible symptom ("each new invocation retries the rate-limited model fresh") is the duration-mismatch leg; the persistence leg surfaces every time the service is restarted. Either alone defeats the cooldown's purpose for long-window quotas.

## Transversality

scoped to the recovery/router stack (provider.ts, invocation-recovery-policy.ts, llm-errors.ts, transport gateways). No cross-cutting refactor required.

## Recommended direction

- Parse `Retry-After` and provider-specific reset fields in `handleLlmHttpError`; carry them on `LlmRateLimitError`.
- In `decideFailure`, when the error carries an explicit reset time, use it as the cooldown lower bound; otherwise fall back to `recoveryDelayMs`.
- Persist the cooldown ledger to `.saivage/runtime/provider-health.json` with a write-on-change strategy, and reload on startup. Garbage-collect entries whose `cooldownUntilMs < now()` on load.

## Cross-links

- F08 — same root: HTTP body is not inspected when classifying failures.
- F04 — the `invocation_failed` event should include `cooldownMs` and `cooldownUntilMs` so operators can see why a candidate is parked.
