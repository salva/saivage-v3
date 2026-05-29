# F03 — Cooldown policy and persistence (combined analysis + design + plan, r1)

Scope: replace the in-process, body-blind cooldown mechanism in `ProviderRegistry` with a typed, provider-respecting, on-disk candidate-availability registry that survives restarts and honours `Retry-After` / `resets_at`. Self-contained; file references are workspace-relative to `/home/salva/g/ml/saivage-v3/` and clickable.

Closes F03. Has a soft dependency on F08 (failure classification); see §4.

Per workspace architecture-first / no-backward-compatibility guideline: no in-memory fallback, no on-disk legacy schema bridge, no migration shim. The pre-existing in-memory `healthStates` map is removed wholesale.

---

## 1. Analysis

### 1.1 Where cooldown state lives today

The entire cooldown state is one in-memory `Map<string, CandidateHealth>` owned by `ProviderRegistry`:

- [src/agents/provider.ts#L249](../../../../src/agents/provider.ts#L249) — `private healthStates: Map<string, CandidateHealth> = new Map();`
- [src/agents/provider.ts#L51-L67](../../../../src/agents/provider.ts#L51) — `CandidateHealth { inCooldown, cooldownUntilMs, failureCount, successCount, lastAttemptMs, lastFailureMs }`.
- [src/agents/provider.ts#L286-L295](../../../../src/agents/provider.ts#L286) — `getHealth` lazily creates default rows.
- [src/agents/provider.ts#L297-L307](../../../../src/agents/provider.ts#L297) — `isHealthy` clears cooldown when `Date.now() >= cooldownUntilMs`.
- [src/agents/provider.ts#L313-L323](../../../../src/agents/provider.ts#L313) — `markFailed(candidate, cooldownMs = 60000)` sets `cooldownUntilMs = Date.now() + cooldownMs`.
- [src/agents/provider.ts#L326-L334](../../../../src/agents/provider.ts#L326) — `markSucceeded` resets `failureCount` and clears cooldown.

The candidate key is `provider/account/model`:
- [src/agents/provider.ts#L27-L29](../../../../src/agents/provider.ts#L27) — `candidateKey(c) => \`${c.provider}/${c.account ?? '_'}/${c.model}\``.
- [src/agents/provider.ts#L34-L45](../../../../src/agents/provider.ts#L34) — `parseCandidateKey` (round-trip helper).

### 1.2 Cooldown duration sourcing

The cooldown duration is a single static knob — `runtime.recoveryDelayMs` (default 60 000 ms) — applied uniformly to every transient class:

- [src/agents/invocation-recovery-policy.ts#L130-L135](../../../../src/agents/invocation-recovery-policy.ts#L130) — rate-limit / server-transient / timeout-transient all set `cooldownMs: context.recoveryDelayMs`.
- [src/agents/invocation-recovery-policy.ts#L144](../../../../src/agents/invocation-recovery-policy.ts#L144) — `unknown` failure class same.
- [src/agents/agent-adapter.ts#L301](../../../../src/agents/agent-adapter.ts#L301), [src/agents/agent-adapter.ts#L317](../../../../src/agents/agent-adapter.ts#L317), [src/agents/agent-adapter.ts#L322](../../../../src/agents/agent-adapter.ts#L322), [src/agents/agent-adapter.ts#L397](../../../../src/agents/agent-adapter.ts#L397), [src/agents/agent-adapter.ts#L406](../../../../src/agents/agent-adapter.ts#L406) — adapter passes `this.runtimeConfig.recoveryDelayMs ?? 60000`.
- [src/agents/analyst-llm-resolver.ts#L182](../../../../src/agents/analyst-llm-resolver.ts#L182) — analyst path bypasses the policy entirely and calls `this.registry.markFailed(candidate, this.runtimeConfig.recoveryDelayMs ?? 60000)` directly.

### 1.3 Persistence scope

There is no persistence. Concretely:
- [src/runtime/active-runtime.ts#L143-L164](../../../../src/runtime/active-runtime.ts#L143) — one `ActiveRuntime` per process; one `AgentAdapter` per runtime; one `ProviderRegistry` per `AgentAdapter`. The map lives on the heap of `saivage.service` and dies with it.
- No `readFileSync`/`writeFileSync` on `.saivage/runtime/` or anywhere else carries cooldown rows. The only persisted runtime file is `.saivage/runtime/runtime-state.json` (verified by `ls .saivage/runtime/`), and it carries the system-state machine, not provider health.
- Scope is therefore: per-invocation cooldown works inside one process; per-session works only if it stays within one process; cross-restart is broken by construction.

### 1.4 Per-candidate granularity

Granularity is `(provider, account, model)` (good). What is missing is dimensionality on the value side: every cooldown is one timestamp with no provenance, no reason class, no observed reset time, no source-of-truth (clock vs server header), and no eviction outside `markSucceeded` / passive `isHealthy` expiry. Operator inspection requires reading process memory.

### 1.5 HTTP body / `Retry-After` parsing

Not implemented anywhere.

- [src/agents/llm-errors.ts#L73-L96](../../../../src/agents/llm-errors.ts#L73) — `handleLlmHttpError` switches on `status` only; the body is read, truncated to 500 chars, redacted, and stuffed into the error message.
- [src/agents/llm-errors.ts#L15-L24](../../../../src/agents/llm-errors.ts#L15) — `LlmRateLimitError` carries `message` and `statusCode`. There is no `retryAfterMs`, no `resetsAt`, no structured body field.
- No code in `src/agents/` references `Retry-After`, `resets_at`, `reset_in`, or `RateLimit-Reset` (grep returned nothing).

### 1.6 Production evidence

Operator brief reports a 429 response body containing `resets_at=1780172729` (~24 h ahead of the time of the failure) for `openai-codex/gpt-5.5`. The current pipeline:
1. `OpenAICodexGateway.complete` receives 429 → `handleLlmHttpError` throws `LlmRateLimitError` with the redacted body string in `.message` — `resets_at` is not extracted.
2. `InvocationRecoveryPolicy.decideFailure` classifies as `rate_limit_transient`, returns `cooldown_and_failover` with `cooldownMs = 60 000`.
3. `ProviderRegistry.markFailed` sets `cooldownUntilMs = now + 60 000`.
4. 60 s later (or after restart, immediately) the same candidate is the top of the priority order in `ModelRouter.resolve`, passes `isHealthy`, gets re-selected, and is 429-throttled again.

Both legs (24 h window mis-honoured as 60 s; restart erases all state) are independently reproducible from the source above.

---

## 2. Design

Two proposals are presented. Proposal B (Level-up) is recommended (§2.4).

### 2.1 Proposal A — Focused: parse reset, persist a flat JSON map

Minimal surgery: keep `ProviderRegistry` as the owner; teach it to parse provider reset hints and persist its map to disk.

Changes:
- Extend `LlmRateLimitError` with `readonly retryAfterMs: number | null` and `readonly resetsAtMs: number | null`. Add a private `LlmServerError.retryAfterMs` for `503` honouring.
- New helper `src/agents/llm-rate-limit-parse.ts` exporting `parseRateLimitHints(response: Response, bodyText: string): { retryAfterMs: number | null; resetsAtMs: number | null }`. Read in priority order:
  1. `Retry-After` header (RFC 7231 — seconds integer or HTTP-date).
  2. `RateLimit-Reset` / `X-RateLimit-Reset` headers (seconds or epoch).
  3. JSON body fields: `resets_at` (epoch s), `reset_at` (ISO), `reset_in_seconds`, `error.retry_after`, OpenAI-style `error.message` regex `try again in (\d+(?:\.\d+)?)s`.
  4. None matched → both null.
- `handleLlmHttpError` constructs the structured error with these fields.
- `InvocationRecoveryPolicy.decideFailure` for `rate_limit_transient`: `cooldownMs = max(error.resetsAtMs - Date.now(), error.retryAfterMs, context.recoveryDelayMs)`, capped at `runtime.maxCooldownMs` (new config field, default 6 h).
- New persistence in `ProviderRegistry`: write `.saivage/runtime/cooldown.json` whenever `markFailed` / `markSucceeded` runs (debounced, single-writer); read at construction time; drop expired rows on load. Format:

```json
{
  "version": 1,
  "rows": {
    "openai-codex/_/gpt-5.5": {
      "cooldownUntilMs": 1780172729000,
      "lastReason": "rate_limit_transient",
      "source": "resets_at_body",
      "failureCount": 3,
      "lastFailureMs": 1780086300000
    }
  }
}
```

Trade-offs:
- Pro: small diff, no architectural movement, easy to roll back, and "fixes the reported bug".
- Con: keeps `ProviderRegistry` as an ad-hoc state owner; no state machine, no audit trail (last-write-wins on a snapshot JSON, so concurrent writers race; we have only one writer per process but two `saivage.service` instances or a manual `node` invocation would corrupt it). Observability requires reading the file by hand. The `inCooldown` boolean (already redundant with `cooldownUntilMs > now`) stays in the type.

### 2.2 Proposal B — Level-up: `CandidateAvailability` registry with JSONL audit log

Introduce a dedicated subsystem that owns candidate availability as a typed state machine, persists changes append-only, and rebuilds in-memory state by replay at startup. `ProviderRegistry` retains candidate construction (`getCandidatesForModel`, etc.) but the health surface is extracted.

State machine (per `candidateKey`):

```
HEALTHY ──markFailed(reason, untilMs)──▶ BLOCKED_UNTIL{untilMs, reason}
HEALTHY ──markFailed(reason, untilMs=null) // unknown duration ──▶ COOLING{untilMs = now+defaultMs, reason}
BLOCKED_UNTIL ──now >= untilMs──▶ HEALTHY                  // passive transition at read time
COOLING ──now >= untilMs──▶ HEALTHY
BLOCKED_UNTIL ──markFailed(harder)──▶ BLOCKED_UNTIL{max(old.untilMs, new.untilMs)}   // monotonic
COOLING ──markFailed(harder)──▶ BLOCKED_UNTIL or COOLING (monotonic)
* ──markSucceeded──▶ HEALTHY                                // resets failure streak
```

Invariants:
- `untilMs` is monotonically non-decreasing within a state until `markSucceeded`.
- A successful call wins ties — `markSucceeded` always clears, regardless of any concurrent `markFailed` for the same key during the same invocation (success is rarer and authoritative).
- `BLOCKED_UNTIL` vs `COOLING` differ only in provenance: `BLOCKED_UNTIL` was derived from a server-stated reset time (`Retry-After` / `resets_at`), `COOLING` from the local default. The state name is the audit trail.

Files:

- New `src/agents/candidate-availability.ts`:

  ```ts
  export type CandidateState =
    | { kind: 'healthy' }
    | { kind: 'cooling';        untilMs: number; reason: InvocationFailureClass; source: 'default' }
    | { kind: 'blocked_until';  untilMs: number; reason: InvocationFailureClass; source: 'retry_after' | 'resets_at_body' | 'ratelimit_header' };

  export interface CandidateAvailabilityEntry {
    key: string;                      // provider/account/model
    state: CandidateState;
    failureCount: number;
    successCount: number;
    lastAttemptMs: number;
    lastFailureMs: number;
    lastSuccessMs: number;
    updatedMs: number;
  }

  export interface CandidateAvailability {
    isAvailable(candidate: Candidate): boolean;
    snapshot(candidate: Candidate): CandidateAvailabilityEntry;
    markFailed(candidate: Candidate, decision: AvailabilityDecision): Promise<void>;
    markSucceeded(candidate: Candidate): Promise<void>;
    markAttempted(candidate: Candidate): Promise<void>;
    all(): ReadonlyMap<string, CandidateAvailabilityEntry>;
  }

  export interface AvailabilityDecision {
    failureClass: InvocationFailureClass;
    untilMs: number | null;         // explicit reset time if known
    source: 'retry_after' | 'resets_at_body' | 'ratelimit_header' | 'default';
    defaultCooldownMs: number;      // used when untilMs === null
    maxCooldownMs: number;          // upper bound (cap) applied to both branches
  }
  ```

- New `src/agents/candidate-availability-store.ts` — JSONL append-only writer + replay reader:
  - File: `.saivage/runtime/candidate-availability.jsonl`
  - One line per state transition: `{ ts, key, prev, next, decision? }` where `prev`/`next` are full `CandidateState` snapshots.
  - Reader rebuilds the in-memory map by replaying lines and dropping expired `cooling` / `blocked_until` states (`untilMs <= now`).
  - Compaction: when the file exceeds `runtime.candidateAvailabilityCompactBytes` (new field, default 256 KiB), the writer atomically rewrites it with one synthetic row per live key (current state only), then truncates.
  - Single-writer invariant: only `ActiveRuntime`'s `CandidateAvailability` instance writes. The `ActiveRuntime` constructor opens the store; tests get an in-memory `MemoryCandidateAvailabilityStore` injectable seam.
  - Crash recovery: append-only + JSONL means a partial last line is detected (no trailing `\n` or JSON parse failure) and skipped at load. No fsync per write; flush on idle and on `ActiveRuntime.dispose`.

- New `src/agents/llm-rate-limit-parse.ts` (same parser as Proposal A) — feeds `AvailabilityDecision.untilMs` and `.source`.

- `LlmRateLimitError` and `LlmServerError` gain `retryAfterMs: number | null` and `resetsAtMs: number | null`.

- `InvocationRecoveryPolicy.decideFailure` builds an `AvailabilityDecision` (replacing the raw `cooldownMs` field on `InvocationRecoveryDecision`). The decision is passed through unchanged by the adapter to `availability.markFailed`. `recoveryDelayMs` becomes the `defaultCooldownMs`; new config `runtime.maxCooldownMs` (default 6 h) caps both branches.

- `ProviderRegistry`:
  - DELETE `healthStates`, `getHealth`, `isHealthy`, `markFailed`, `markSucceeded`, `markAttempted`, `getAllHealth`, `resetHealth`, `getCooldownMs`, `CandidateHealth`, `defaultHealth`.
  - The registry's surface narrows to provider/account/candidate construction and capabilities. It no longer carries state.

- Consumers of the old API:
  - [src/agents/agent-adapter.ts#L398](../../../../src/agents/agent-adapter.ts#L398) — `this.registry.markSucceeded(candidate)` → `this.availability.markSucceeded(candidate)`.
  - All `markFailed` adapter sites pass `decision.availability` (the new field on `InvocationRecoveryDecision`).
  - [src/agents/analyst-llm-resolver.ts#L174-L182](../../../../src/agents/analyst-llm-resolver.ts#L174) — must go through the policy too (no more ad-hoc `markFailed(_, recoveryDelayMs)`); call `policy.decideFailure(err, ctx)` then `availability.markFailed(...)`. This removes the analyst-vs-agent inconsistency.
  - [src/agents/model-router.ts](../../../../src/agents/model-router.ts) — candidate-eligibility callback flips from `registry.isHealthy(c)` to `availability.isAvailable(c)`.

- `ActiveRuntime` ([src/runtime/active-runtime.ts#L143-L164](../../../../src/runtime/active-runtime.ts#L143)) constructs one `CandidateAvailability` per project root and injects it into `AgentAdapter` and `AnalystLlmResolver`.

Observability:
- Each transition is one JSONL row — direct operator audit by `tail -f .saivage/runtime/candidate-availability.jsonl`.
- The existing `invocation_failed` event payload gains `availability: { state, untilMs, source }` (this also satisfies an F04 ask, but the F03 work merely populates the field — the schema bump is F04's job; we emit the extra field as the policy already constructs it).
- New CLI/HTTP read-only inspector: `GET /api/runtime/candidate-availability` returns the current map (read-only mirror of `availability.all()`). Add to operator runbook in the F03 closing batch.

Trade-offs:
- Pro: deletes ad-hoc state from `ProviderRegistry`; one owner per concern; append-only crash recovery is robust; audit log is operator-readable; analyst path joins the same policy path (fixes a parallel bug for free); the JSONL substrate matches the existing pattern under `.saivage/cards/*.jsonl` and `.saivage/runtime/`.
- Con: more code than Proposal A; introduces a new file under `.saivage/runtime/`; requires updating every `registry.markFailed` / `registry.isHealthy` call site.

### 2.3 Interaction with F05

F05 (envelope-vs-toolcalls orthogonality) introduces `LlmContractMismatchError`, classified by `InvocationRecoveryPolicy.decideFailure` as `action: 'fail_invocation'`, `markFailed: false`, no cooldown. This design preserves that contract: when `markFailed === false` the adapter does NOT call `availability.markFailed`; the contract-mismatch class produces no `AvailabilityDecision`. Conversely this design does not introduce a new failure class; the F05 class is propagated through unchanged.

### 2.4 Recommendation

Adopt **Proposal B**. The Focused proposal only hides the symptom: it leaves cooldown owned by a struct that was never the right home (a "registry" of providers should not be a stateful failure tracker). Proposal B is the smallest change that (a) removes the type-incongruous state from `ProviderRegistry`, (b) gives operators a real audit trail, (c) unifies the analyst and agent failure paths, and (d) replaces redundant `inCooldown` + `cooldownUntilMs` with a single discriminated state. This is the architecture-first choice.

---

## 3. Plan

Four batches. Each batch ends with a green checkpoint: `npx tsc --noEmit` + targeted Jest (`npm test -- --runTestsByPath <paths>`). Per the workspace guideline, NO migration shim: legacy in-memory state is deleted in batch 2; any operator restart on the new build starts with an empty availability store and rebuilds organically.

### Batch 1 — Reset-time parsing and structured rate-limit error

Scope:
- Add `retryAfterMs`, `resetsAtMs` to `LlmRateLimitError` and `LlmServerError` ([src/agents/llm-errors.ts](../../../../src/agents/llm-errors.ts)).
- New `src/agents/llm-rate-limit-parse.ts` (header + body extraction; pure function).
- Update `handleLlmHttpError` to read the body once, parse hints, attach to the thrown error.
- All affected gateway call sites (`OpenAIChatGateway`, `OpenAICodexGateway`) compile against the new signature unchanged (`handleLlmHttpError(response, source)` still takes a `Response`).

Tests:
- `tests/agents/llm-rate-limit-parse.test.ts` (new):
  - Honours `Retry-After: 120` (seconds).
  - Honours `Retry-After: <http-date>`.
  - Honours JSON `{ resets_at: <epoch_s> }` (the production case).
  - Honours OpenAI `try again in 30.5s` pattern in `error.message`.
  - Returns `{ null, null }` when no hint is present.
- `tests/agents/llm-errors.test.ts` (extend if exists; otherwise add):
  - `handleLlmHttpError` on 429 with `resets_at` body produces an `LlmRateLimitError` with the expected `resetsAtMs`.

Green checkpoint: `npx tsc --noEmit && npm test -- --runTestsByPath tests/agents/llm-rate-limit-parse.test.ts tests/agents/llm-errors.test.ts`.

Risk: low (additive). Rollback: revert error-class field additions; parser becomes dead code.

### Batch 2 — `CandidateAvailability` substrate and JSONL store; delete legacy `healthStates`

Scope:
- New `src/agents/candidate-availability.ts` (types + in-memory implementation).
- New `src/agents/candidate-availability-store.ts` (JSONL append-only writer + replay reader + compaction).
- DELETE from [src/agents/provider.ts](../../../../src/agents/provider.ts): `healthStates`, `getHealth`, `isHealthy`, `markFailed`, `markSucceeded`, `markAttempted`, `getAllHealth`, `resetHealth`, `getCooldownMs`, `CandidateHealth`, `defaultHealth`. `candidateKey` / `parseCandidateKey` stay (used by the new module).
- `InvocationRecoveryDecision` field rename: `cooldownMs?: number` → `availability?: AvailabilityDecision`. `decideFailure` produces it for rate_limit / server_transient / timeout_transient / unknown classes. New runtime field `maxCooldownMs` in config schema; default 21 600 000 (6 h).

Tests:
- `tests/agents/candidate-availability.test.ts` (new):
  - HEALTHY → BLOCKED_UNTIL on explicit `untilMs`; `isAvailable` false until time passes.
  - Monotonic untilMs: smaller incoming `markFailed` does not shrink the window.
  - `markSucceeded` clears state and resets `failureCount`.
  - `markFailed` with `untilMs > now + maxCooldownMs` is capped at the max.
- `tests/agents/candidate-availability-store.test.ts` (new):
  - Round-trip: write three transitions, instantiate a new store from the same file, recover the latest live state.
  - **Cooldown survives process restart**: file persists `blocked_until`; a fresh `CandidateAvailability` built from it answers `isAvailable === false` for the candidate until `untilMs`.
  - Partial last line is tolerated.
  - Compaction: writing past the threshold collapses the file to one row per live key.
- `tests/agents/invocation-recovery-policy.test.ts` (extend):
  - **Cooldown honours `resets_at`**: rate-limit error with `resetsAtMs = now + 24h` produces `decision.availability.untilMs ≈ now + 24h` (within max-cap).
  - Unknown / server / timeout classes still produce `availability` with `source: 'default'` and `untilMs: null`.

Green checkpoint: `npx tsc --noEmit && npm test -- --runTestsByPath tests/agents/candidate-availability.test.ts tests/agents/candidate-availability-store.test.ts tests/agents/invocation-recovery-policy.test.ts`. Build must NOT yet reference the new substrate from `AgentAdapter`; that wiring is batch 3. To keep `tsc` green during this batch, the policy emits both `availability` (new) and (temporarily, ONLY for the duration of this batch) a derived `cooldownMs` so the unchanged adapter still compiles. **The derived field is removed in batch 3** — this is not a backward-compat shim, it is one-batch scaffolding that does not survive the green checkpoint at the end of batch 3.

Risk: medium. The deletion in `ProviderRegistry` touches a hot path. Rollback: `git revert` of the batch restores in-memory cooldown; the JSONL file becomes orphaned (safe to delete).

### Batch 3 — Wire `CandidateAvailability` through the runtime and adapters; collapse analyst path

Scope:
- `ActiveRuntime` constructs `CandidateAvailability` from `.saivage/runtime/candidate-availability.jsonl` and injects into `AgentAdapter` and `AnalystLlmResolver`.
- `AgentAdapter`:
  - Replace `this.registry.markSucceeded(candidate)` with `this.availability.markSucceeded(candidate)` (one call site at [src/agents/agent-adapter.ts#L398](../../../../src/agents/agent-adapter.ts#L398)).
  - On `decision.markFailed === true` and `decision.availability != null`, call `this.availability.markFailed(candidate, decision.availability)`.
  - `ModelRouter` candidate-eligibility callback (used in resolve) switches from `registry.isHealthy(c)` to `availability.isAvailable(c)`. Verify `model-router.ts` constructor signature accordingly.
- `AnalystLlmResolver`:
  - DELETE the ad-hoc `markSucceeded` / `markFailed` calls at [src/agents/analyst-llm-resolver.ts#L174-L182](../../../../src/agents/analyst-llm-resolver.ts#L174).
  - Replace with `defaultInvocationRecoveryPolicy.decideFailure(err, ctx)` + `availability.markFailed(c, decision.availability)` on failure; `availability.markSucceeded(c)` on success.
- Remove the batch-2 scaffolding `cooldownMs` field from `InvocationRecoveryDecision`.

Tests:
- `tests/agents/agent-adapter-recovery.test.ts` (extend):
  - **Re-selection avoids any candidate in `blocked_until`**: seed availability with `c1` blocked for 1 h; invoke role wired to `[c1, c2]`; assert `model_selected` event names `c2` and `c1` is not even health-checked (or is checked and reported unavailable). On a second invocation (still within the hour) the same `c2` is selected — `c1` never returns to the top until the window expires.
- `tests/agents/analyst-llm-resolver.integration.test.ts` (extend):
  - Analyst failure goes through `decideFailure`; availability state is populated with the same fields as the agent path.
- `tests/agents/provider.test.ts` (rewrite):
  - DELETE every test that exercised `markFailed` / `isHealthy` / `getHealth` on `ProviderRegistry` (those methods no longer exist).
  - Keep tests for `getCandidatesForModel`, `getProvidersForModel`, capabilities, account resolution.

Green checkpoint: `npx tsc --noEmit && npm test -- --runTestsByPath tests/agents/agent-adapter-recovery.test.ts tests/agents/analyst-llm-resolver.integration.test.ts tests/agents/provider.test.ts tests/agents/model-router.test.ts`.

Risk: medium-high (touches every recovery path and the analyst). Rollback: `git revert` reinstates the legacy path; recovery still works because batch 2's deletion is also reverted.

### Batch 4 — Operator surface and docs

Scope:
- New read-only HTTP route `GET /api/runtime/candidate-availability` returning `availability.all()` snapshot (JSON). Read-only; not idempotent-write.
- `docs/runbook/operations.md` row for the new route (per the operator API contract verifier already enforced in the repo).
- `docs/runtime.md` (or wherever provider-recovery is documented; locate via `grep -rn "recoveryDelayMs" docs/`) updates to describe `BLOCKED_UNTIL` / `COOLING` states, the JSONL file, and the new `maxCooldownMs` config field.
- Optional CLI: `saivage runtime availability` (if a CLI surface exists for runtime inspection — adopt only if a parallel command already exists, otherwise skip).

Tests:
- `tests/server/operator-api-contract-fixtures.test.ts` (extend): assert the new route exists with documented top-level keys.
- `tests/docs-route-verification.test.ts` (extend): the route appears in the docs row with the right schema anchors.
- `scripts/docs-verify.sh` passes.

Green checkpoint: `npx tsc --noEmit && npm test -- --runTestsByPath tests/server/operator-api-contract-fixtures.test.ts tests/docs-route-verification.test.ts && ./scripts/docs-verify.sh`. Then a final full-suite gate: `npm test`.

Risk: low. Rollback: revert the route and docs row.

### Summary of deletions (architecture-first checklist)

After all four batches, the following are gone (must be verified with `grep` at the end of batch 4 — zero hits expected):
- `CandidateHealth`, `defaultHealth` — types.
- `ProviderRegistry.healthStates` / `getHealth` / `isHealthy` / `markFailed` / `markSucceeded` / `markAttempted` / `getAllHealth` / `resetHealth` / `getCooldownMs` — methods.
- `InvocationRecoveryDecision.cooldownMs` — field (replaced by `availability`).
- Ad-hoc analyst path in `AnalystLlmResolver` that bypassed the recovery policy.

### Dependency on F08

F08 (failure classification) sharpens the mapping from HTTP body to `InvocationFailureClass`. F03 consumes that mapping via `InvocationRecoveryDecision.availability.failureClass` and the parsed reset hints on the error. If F08 lands first, the F03 `failureClass` in availability rows is already accurate (e.g., distinguishing `quota_exhausted` from `rate_limit_transient`). If F03 lands first, behaviour is correct but the audit log records the coarser classes from today's classifier. Recommended order: **F08 → F03**. Either order is safe.
