# F03 — Cooldown policy and persistence (combined analysis + design + plan, r2)

Scope: replace the in-process, body-blind cooldown mechanism in `ProviderRegistry` with a typed, provider-respecting, on-disk candidate-availability registry that survives restarts and honours `Retry-After` / `resets_at` verbatim. Self-contained; file references are workspace-relative to `/home/salva/g/ml/saivage-v3/` and clickable.

Closes F03. Soft dependency on F08 (failure classification); see §4.

Per workspace architecture-first / no-backward-compatibility guideline: no in-memory fallback, no on-disk legacy schema bridge, no migration shim. The pre-existing in-memory `healthStates` map is removed wholesale in a single transactional batch (§3.2) so no published checkpoint compiles against a half-deleted API.

Changes from r1 (driven by [COMBINED-review-r1.md](COMBINED-review-r1.md)):
- Re-batched (§3): the old "delete legacy in batch 2, rewire in batch 3" split is merged into ONE checkpoint-green batch. No published batch deletes a public method whose callers still reference it.
- `maxCooldownMs` cap REMOVED (§2.2, §2.4). Provider-stated `resets_at` / `Retry-After` are honoured verbatim — the production 24 h `resets_at` produces a 24 h `untilMs`. The local default cooldown applies ONLY when the classifier provides no provider-stated time.
- Single-writer ownership specified precisely (§2.3): `ActiveRuntime` is the sole owner of the `CandidateAvailability` instance and its on-disk store. The analyst path receives the SAME object reference via constructor injection through `AnalystHandler` → `LlmIntentResolver`. A `flock`-style exclusive lock on `.saivage/runtime/candidate-availability.lock` is acquired at store construction; a second writer fails fast.

---

## 1. Analysis

### 1.1 Where cooldown state lives today

One in-memory `Map<string, CandidateHealth>` owned by `ProviderRegistry`:

- [src/agents/provider.ts#L249](../../../../src/agents/provider.ts#L249) — `private healthStates: Map<string, CandidateHealth> = new Map();`
- [src/agents/provider.ts#L51-L67](../../../../src/agents/provider.ts#L51) — `CandidateHealth { inCooldown, cooldownUntilMs, failureCount, successCount, lastAttemptMs, lastFailureMs }`.
- [src/agents/provider.ts#L286-L295](../../../../src/agents/provider.ts#L286) — `getHealth` lazily creates default rows.
- [src/agents/provider.ts#L297-L307](../../../../src/agents/provider.ts#L297) — `isHealthy` clears cooldown when `Date.now() >= cooldownUntilMs`.
- [src/agents/provider.ts#L313-L323](../../../../src/agents/provider.ts#L313) — `markFailed(candidate, cooldownMs = 60000)` sets `cooldownUntilMs = Date.now() + cooldownMs`.
- [src/agents/provider.ts#L326-L334](../../../../src/agents/provider.ts#L326) — `markSucceeded` resets `failureCount` and clears cooldown.

Candidate key: `provider/account/model` ([src/agents/provider.ts#L27-L29](../../../../src/agents/provider.ts#L27), [src/agents/provider.ts#L34-L45](../../../../src/agents/provider.ts#L34)).

### 1.2 Cooldown duration sourcing

Single static knob `runtime.recoveryDelayMs` (default 60 000 ms) applied uniformly:
- [src/agents/invocation-recovery-policy.ts#L130-L135](../../../../src/agents/invocation-recovery-policy.ts#L130) — rate-limit / server-transient / timeout-transient use `cooldownMs: context.recoveryDelayMs`.
- [src/agents/invocation-recovery-policy.ts#L144](../../../../src/agents/invocation-recovery-policy.ts#L144) — `unknown` failure class same.
- [src/agents/agent-adapter.ts#L301](../../../../src/agents/agent-adapter.ts#L301), [src/agents/agent-adapter.ts#L317](../../../../src/agents/agent-adapter.ts#L317), [src/agents/agent-adapter.ts#L322](../../../../src/agents/agent-adapter.ts#L322), [src/agents/agent-adapter.ts#L397](../../../../src/agents/agent-adapter.ts#L397), [src/agents/agent-adapter.ts#L406](../../../../src/agents/agent-adapter.ts#L406) — adapter passes `this.runtimeConfig.recoveryDelayMs ?? 60000`.
- [src/agents/analyst-llm-resolver.ts#L182](../../../../src/agents/analyst-llm-resolver.ts#L182) — analyst path bypasses the policy entirely and calls `this.registry.markFailed(candidate, this.runtimeConfig.recoveryDelayMs ?? 60000)` directly.

### 1.3 Persistence scope

None. One `ActiveRuntime` per process; one `AgentAdapter` per runtime; one `ProviderRegistry` per `AgentAdapter` ([src/runtime/active-runtime.ts#L143-L210](../../../../src/runtime/active-runtime.ts#L143)). The map lives on the `saivage.service` heap and dies with it. The only persisted runtime file is `.saivage/runtime/runtime-state.json`, which carries the system-state machine, not provider health. Cross-restart cooldown is broken by construction.

### 1.4 Per-candidate granularity

Key dimension `(provider, account, model)` is correct. Value side lacks provenance (server vs local clock), reason class, observed reset time, and operator-readable audit; inspection requires reading process memory.

### 1.5 HTTP body / `Retry-After` parsing

Not implemented anywhere. [src/agents/llm-errors.ts#L73-L96](../../../../src/agents/llm-errors.ts#L73) switches on `status` only; body is read, truncated to 500 chars, redacted, and stuffed into `LlmRateLimitError.message`. `LlmRateLimitError` ([src/agents/llm-errors.ts#L15-L24](../../../../src/agents/llm-errors.ts#L15)) carries `message` and `statusCode`; no structured fields. No code references `Retry-After`, `resets_at`, `reset_in`, or `RateLimit-Reset` (grep).

### 1.6 Production evidence

Operator brief: 429 body contains `resets_at=1780172729` (~24 h ahead) for `openai-codex/gpt-5.5`. Today's pipeline:
1. `OpenAICodexGateway.complete` → `handleLlmHttpError` throws `LlmRateLimitError` with the body in `.message`; `resets_at` is not extracted.
2. `InvocationRecoveryPolicy.decideFailure` returns `cooldown_and_failover`, `cooldownMs = 60 000`.
3. `ProviderRegistry.markFailed` sets `cooldownUntilMs = now + 60 000`.
4. 60 s later (or immediately after restart) the same candidate is top of `ModelRouter.resolve`, passes `isHealthy`, gets re-selected, 429 again.

Both legs (24 h window honoured as 60 s; restart erases all state) are independently reproducible from the source above.

---

## 2. Design

Two proposals. Proposal B (Level-up) is recommended (§2.4).

### 2.1 Proposal A — Focused: parse reset, persist a flat JSON map

Keep `ProviderRegistry` as owner; teach it to parse provider reset hints and persist its map.

- Extend `LlmRateLimitError` with `readonly retryAfterMs: number | null` and `readonly resetsAtMs: number | null`. Add the same on `LlmServerError`.
- New `src/agents/llm-rate-limit-parse.ts` exporting `parseRateLimitHints(response, bodyText): { retryAfterMs, resetsAtMs }` in priority order: `Retry-After` header → `RateLimit-Reset` / `X-RateLimit-Reset` → JSON body fields (`resets_at`, `reset_at`, `reset_in_seconds`, `error.retry_after`) → OpenAI-style `try again in (\d+(?:\.\d+)?)s` regex on `error.message`.
- `handleLlmHttpError` reads body once, parses hints, attaches to thrown error.
- `InvocationRecoveryPolicy.decideFailure` for transient classes: `untilMs = error.resetsAtMs ?? (Date.now() + (error.retryAfterMs ?? context.recoveryDelayMs))`. **No cap.**
- New persistence in `ProviderRegistry`: write `.saivage/runtime/cooldown.json` snapshot whenever `markFailed`/`markSucceeded` runs; read at construction; drop expired rows on load.

Trade-offs: small diff, leaves `ProviderRegistry` as an ad-hoc state owner, snapshot JSON races on concurrent writers, no audit trail, analyst-vs-agent inconsistency persists.

### 2.2 Proposal B — Level-up: `CandidateAvailability` registry with JSONL audit log

Dedicated subsystem owns candidate availability as a typed state machine; persists changes append-only; rebuilds at startup by replay. `ProviderRegistry` keeps candidate construction but loses the health surface.

State machine per `candidateKey`:

```
HEALTHY ──markFailed(reason, untilMs from server)──▶ BLOCKED_UNTIL{untilMs, reason}
HEALTHY ──markFailed(reason, untilMs=null)        ──▶ COOLING{untilMs = now+defaultCooldownMs, reason}
BLOCKED_UNTIL / COOLING ──now >= untilMs          ──▶ HEALTHY              // passive transition at read time
BLOCKED_UNTIL ──markFailed(harder)                ──▶ BLOCKED_UNTIL{max(old.untilMs, new.untilMs)}   // monotonic
COOLING       ──markFailed(harder)                ──▶ BLOCKED_UNTIL or COOLING (monotonic)
*             ──markSucceeded                     ──▶ HEALTHY              // resets failure streak
```

Invariants:
- `untilMs` is monotonically non-decreasing within a state until `markSucceeded`.
- `markSucceeded` always wins ties — success is rarer and authoritative.
- `BLOCKED_UNTIL` vs `COOLING` differ only in provenance: `BLOCKED_UNTIL` came from a server-stated reset (`Retry-After` / `resets_at` / `RateLimit-Reset`); `COOLING` came from the local default. The state name IS the audit trail.
- **No upper cap.** A 24 h `resets_at` produces `untilMs = now + 24h`; a 7-day `Retry-After` produces a 7-day window. The provider knows its quota; the client honours it. The only sanity guard is a sign check (`untilMs > Date.now()` required, else the value is discarded as "already-expired hint" and the state stays `HEALTHY`).

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
    dispose(): Promise<void>;          // flushes + releases lock
  }

  export interface AvailabilityDecision {
    failureClass: InvocationFailureClass;
    untilMs: number | null;            // explicit server-stated reset; null => use defaultCooldownMs
    source: 'retry_after' | 'resets_at_body' | 'ratelimit_header' | 'default';
    defaultCooldownMs: number;         // used ONLY when untilMs === null
  }
  ```

  No `maxCooldownMs` field exists on `AvailabilityDecision`, on `RuntimeSection`, or anywhere in this design.

- New `src/agents/candidate-availability-store.ts` — JSONL append-only writer + replay reader:
  - File: `.saivage/runtime/candidate-availability.jsonl`.
  - Lock file: `.saivage/runtime/candidate-availability.lock` (advisory `flock(LOCK_EX | LOCK_NB)` via `fs.openSync` + `fcntl`; on Linux LXC this is the `flock(2)` syscall surface). Acquired at store construction; released on `dispose`. If acquisition fails, construction throws `CandidateAvailabilityLockedError` — fail-fast (§2.3).
  - One line per state transition: `{ ts, key, prev, next, decision? }`.
  - Reader rebuilds the live map by replaying lines and dropping expired `cooling` / `blocked_until` states (`untilMs <= now`).
  - Compaction: when the file exceeds `runtime.candidateAvailabilityCompactBytes` (new config field, default 256 KiB), the writer atomically rewrites it with one synthetic row per live key, then truncates.
  - Crash recovery: a partial last line (no trailing `\n` or JSON parse failure) is detected and skipped at load. No fsync per write; flush on idle and on `dispose`.
  - Tests use an injectable `MemoryCandidateAvailabilityStore` (no file, no lock).

- New `src/agents/llm-rate-limit-parse.ts` (same parser as Proposal A) — feeds `AvailabilityDecision.untilMs` and `.source`.

- `LlmRateLimitError` and `LlmServerError` gain `retryAfterMs: number | null` and `resetsAtMs: number | null`.

- `InvocationRecoveryPolicy.decideFailure` builds an `AvailabilityDecision` (REPLACING the `cooldownMs` field on `InvocationRecoveryDecision`). Construction:

  ```ts
  const serverUntilMs =
    error instanceof LlmRateLimitError || error instanceof LlmServerError
      ? (error.resetsAtMs ?? (error.retryAfterMs != null ? Date.now() + error.retryAfterMs : null))
      : null;
  const validUntilMs = (serverUntilMs != null && serverUntilMs > Date.now()) ? serverUntilMs : null;
  decision.availability = {
    failureClass,
    untilMs: validUntilMs,                    // verbatim server time; no cap
    source: validUntilMs != null
      ? (error.resetsAtMs != null ? 'resets_at_body' : 'retry_after')
      : 'default',
    defaultCooldownMs: context.recoveryDelayMs,
  };
  ```

  `recoveryDelayMs` becomes `defaultCooldownMs`. **No `maxCooldownMs` is introduced.**

- `ProviderRegistry`:
  - DELETE `healthStates`, `getHealth`, `isHealthy`, `markFailed`, `markSucceeded`, `markAttempted`, `getAllHealth`, `resetHealth`, `getCooldownMs`, `CandidateHealth`, `defaultHealth`.
  - `candidateKey` / `parseCandidateKey` stay (consumed by the new module).

- Consumers of the old API (all rewired in the same transactional batch as the deletion — §3.2):
  - [src/agents/agent-adapter.ts#L398](../../../../src/agents/agent-adapter.ts#L398) — `this.registry.markSucceeded(candidate)` → `this.availability.markSucceeded(candidate)`.
  - All `markFailed` adapter sites pass `decision.availability` (the new field on `InvocationRecoveryDecision`).
  - [src/agents/analyst-llm-resolver.ts#L174-L182](../../../../src/agents/analyst-llm-resolver.ts#L174) — DELETE the ad-hoc `registry.markSucceeded`/`registry.markFailed` calls. Replace with `defaultInvocationRecoveryPolicy.decideFailure(err, ctx)` + `this.availability.markFailed(c, decision.availability)` on failure; `this.availability.markSucceeded(c)` on success.
  - [src/agents/model-router.ts#L124](../../../../src/agents/model-router.ts#L124) — candidate-eligibility callback flips from `registry.isHealthy(c)` to `availability.isAvailable(c)`. `ModelRouter` constructor signature adds a `CandidateAvailability` parameter; both construction sites (§2.3) pass the shared instance.

### 2.3 Single-writer ownership of `CandidateAvailability`

Exactly one writer exists per project root, owned by `ActiveRuntime`. The path is fixed and tested:

```
ActiveRuntime (single per project root, lives in saivage.service process)
  └── owns: this._candidateAvailability = new FsCandidateAvailability({ saivageDir, defaults })
       │     ├── acquires flock(LOCK_EX|LOCK_NB) on .saivage/runtime/candidate-availability.lock
       │     └── opens   append-write fd on .saivage/runtime/candidate-availability.jsonl
       │
       ├── injects into AgentAdapter   (constructor field `availability`)
       │     └── AgentAdapter passes the SAME ref to its inner ModelRouter at construct time
       │
       └── injects into AnalystHandler (constructor parameter `candidateAvailability`)
             └── AnalystHandler passes it to `new LlmIntentResolver(projectRoot, candidateAvailability)`
                   └── LlmIntentResolver stores it as readonly field; passes it to its own ModelRouter
```

Concrete construction changes:

- `ActiveRuntime` ([src/runtime/active-runtime.ts#L143](../../../../src/runtime/active-runtime.ts#L143)) gains:

  ```ts
  private readonly _candidateAvailability: CandidateAvailability;
  // ...in constructor, before _agentAdapter is constructed:
  this._candidateAvailability = new FsCandidateAvailability({
    saivageDir,
    defaultCooldownMs: this._config.runtime.recoveryDelayMs ?? 60_000,
  });
  // exposed read-only:
  get candidateAvailability(): CandidateAvailability { return this._candidateAvailability; }
  // and disposed:
  async dispose(): Promise<void> { await this._candidateAvailability.dispose(); /* + existing disposals */ }
  ```

  The `AgentAdapter` constructor at [src/runtime/active-runtime.ts#L164](../../../../src/runtime/active-runtime.ts#L164) gains a `candidateAvailability: this._candidateAvailability` field.

- `AnalystHandler` ([src/agents/analyst-handler.ts](../../../../src/agents/analyst-handler.ts)) constructor — the line `this.llmResolver = new LlmIntentResolver(projectRoot);` becomes `this.llmResolver = new LlmIntentResolver(projectRoot, activeRuntime.candidateAvailability);`. `activeRuntime` is already a constructor parameter.

- `LlmIntentResolver` ([src/agents/analyst-llm-resolver.ts](../../../../src/agents/analyst-llm-resolver.ts)) constructor signature changes to `constructor(private readonly projectRoot: string, private readonly availability: CandidateAvailability)`. It is NOT default-constructed elsewhere — every call site goes through `AnalystHandler`, which receives the instance from `ActiveRuntime`. There is no zero-arg or fallback constructor.

Concurrent-writer rejection. `FsCandidateAvailability` constructor calls `flock(fd, LOCK_EX | LOCK_NB)` on the lock file. If the lock is already held (e.g. a second `saivage.service` or a manual `node dist/cli.js serve ...` against the same project root), construction throws `CandidateAvailabilityLockedError`. The bootstrap path in [src/cli/](../../../../src/cli/) — wherever `serve` constructs the `ActiveRuntime` — surfaces this as a process-fatal "Saivage runtime already running for <projectRoot>" error. Tests inject a `MemoryCandidateAvailabilityStore` to bypass the lock.

Why this enforces the invariant:
- The store layer holds the only OS-level write handle to the JSONL file; nothing else in the codebase opens it for write.
- The single in-memory `CandidateAvailability` reference is passed by value (object reference), so `AgentAdapter`, its `ModelRouter`, `AnalystHandler`, `LlmIntentResolver`, and the analyst's `ModelRouter` all mutate the SAME state machine.
- The analyst path does NOT instantiate `ProviderRegistry`-owned health (it cannot — the methods are deleted). It can only call into the shared `availability` object.

Observability:
- Each transition is one JSONL row — operator-readable via `tail -f .saivage/runtime/candidate-availability.jsonl`.
- The existing `invocation_failed` event payload gains `availability: { state, untilMs, source }`. The payload-schema bump is F04's job; F03 merely populates the field that the policy already constructs.
- New read-only HTTP route `GET /api/runtime/candidate-availability` returns `availability.all()` (§3.3).

### 2.4 Recommendation

Adopt **Proposal B**. Proposal A leaves cooldown owned by a struct that was never the right home and races on concurrent writers. Proposal B (a) removes type-incongruous state from `ProviderRegistry`, (b) gives operators a real audit trail, (c) unifies the analyst and agent failure paths under one writer, (d) honours provider-stated reset times verbatim with no client-imposed cap, and (e) enforces the single-writer invariant at the OS level via `flock`. This is the architecture-first choice.

### 2.5 Interaction with F05

F05 ([02-design-r4.md](../F05-envelope-vs-toolcalls-orthogonality/02-design-r4.md)) introduces `LlmContractMismatchError`, classified by `InvocationRecoveryPolicy.decideFailure` as `action: 'fail_invocation'`, `markFailed: false`, `appendModelIssue: true`, no cooldown. This design preserves that contract: when `decision.markFailed === false` the adapter does NOT call `availability.markFailed`; `decision.availability` is absent. No new failure class is introduced here.

---

## 3. Plan

Three batches. Each batch ends with a green checkpoint: `npx tsc --noEmit` + targeted Jest (`npm test -- --runTestsByPath <paths>`). Per workspace guideline, NO migration shim and NO half-deleted intermediate. The legacy in-memory health surface is deleted in the SAME batch that rewires every consumer (§3.2); operator restarts on the new build start with an empty availability store and rebuild organically.

### Batch 1 — Reset-time parsing and structured rate-limit error (additive, green)

Scope:
- Add `retryAfterMs`, `resetsAtMs` to `LlmRateLimitError` and `LlmServerError` ([src/agents/llm-errors.ts](../../../../src/agents/llm-errors.ts)).
- New `src/agents/llm-rate-limit-parse.ts` (header + body extraction; pure function).
- Update `handleLlmHttpError` to read the body once, parse hints, attach to the thrown error.
- Gateway call sites (`OpenAIChatGateway`, `OpenAICodexGateway`) compile unchanged — `handleLlmHttpError(response, source)` signature is unchanged.

Tests:
- `tests/agents/llm-rate-limit-parse.test.ts` (new):
  - Honours `Retry-After: 120` (seconds).
  - Honours `Retry-After: <http-date>`.
  - Honours JSON `{ resets_at: <epoch_s> }` (the production case).
  - Honours OpenAI `try again in 30.5s` pattern in `error.message`.
  - Returns `{ null, null }` when no hint is present.
- `tests/agents/llm-errors.test.ts` (extend/add):
  - `handleLlmHttpError` on 429 with `resets_at` body produces an `LlmRateLimitError` with the expected `resetsAtMs`.

Green checkpoint: `npx tsc --noEmit && npm test -- --runTestsByPath tests/agents/llm-rate-limit-parse.test.ts tests/agents/llm-errors.test.ts`.

Risk: low (purely additive). Rollback: revert field additions; parser becomes dead code.

### Batch 2 — Substrate + delete legacy + rewire ALL consumers (one transaction, green)

This is the only batch that touches the recovery hot path. It is intentionally larger than r1 split it; the review-r1 finding established that splitting deletion from rewiring leaves the intermediate batch non-compilable. All work below ships together; the checkpoint at the end is the first build that exercises the new substrate.

Scope:
1. New `src/agents/candidate-availability.ts` (types + in-memory `CandidateAvailability` impl with state machine and monotonic-untilMs invariant).
2. New `src/agents/candidate-availability-store.ts` (`FsCandidateAvailability` with JSONL append-only writer, `flock`-based exclusive lock on `.saivage/runtime/candidate-availability.lock`, replay reader, compaction at `runtime.candidateAvailabilityCompactBytes`). Also exports `MemoryCandidateAvailabilityStore` for tests.
3. New config field `runtime.candidateAvailabilityCompactBytes` (default 262 144). **No `maxCooldownMs` field is added** (review-r1 fix).
4. `InvocationRecoveryDecision`: REPLACE `cooldownMs?: number` with `availability?: AvailabilityDecision`. `InvocationRecoveryPolicy.decideFailure` produces it for rate_limit / server_transient / timeout_transient / unknown classes, using server-stated `untilMs` verbatim when present (no cap).
5. DELETE from [src/agents/provider.ts](../../../../src/agents/provider.ts): `healthStates`, `getHealth`, `isHealthy`, `markFailed`, `markSucceeded`, `markAttempted`, `getAllHealth`, `resetHealth`, `getCooldownMs`, `CandidateHealth`, `defaultHealth`.
6. `ModelRouter` ([src/agents/model-router.ts](../../../../src/agents/model-router.ts)) constructor adds `availability: CandidateAvailability`. The eligibility callback that today calls `registry.isHealthy(c)` ([src/agents/model-router.ts#L124](../../../../src/agents/model-router.ts#L124)) becomes `availability.isAvailable(c)`.
7. `AgentAdapter` ([src/agents/agent-adapter.ts](../../../../src/agents/agent-adapter.ts)) constructor adds `candidateAvailability: CandidateAvailability` field. Replace [src/agents/agent-adapter.ts#L398](../../../../src/agents/agent-adapter.ts#L398) `registry.markSucceeded` with `availability.markSucceeded`. The `markFailed` adapter sites at [src/agents/agent-adapter.ts#L301](../../../../src/agents/agent-adapter.ts#L301), [src/agents/agent-adapter.ts#L317](../../../../src/agents/agent-adapter.ts#L317), [src/agents/agent-adapter.ts#L322](../../../../src/agents/agent-adapter.ts#L322), [src/agents/agent-adapter.ts#L397](../../../../src/agents/agent-adapter.ts#L397), [src/agents/agent-adapter.ts#L406](../../../../src/agents/agent-adapter.ts#L406) flip to `if (decision.markFailed && decision.availability) await this.candidateAvailability.markFailed(candidate, decision.availability);`. `AgentAdapter` passes the same `availability` instance into its inner `ModelRouter` at construction.
8. `LlmIntentResolver` ([src/agents/analyst-llm-resolver.ts](../../../../src/agents/analyst-llm-resolver.ts)) constructor becomes `constructor(projectRoot: string, availability: CandidateAvailability)`. DELETE the ad-hoc `registry.markSucceeded`/`registry.markFailed` calls at [src/agents/analyst-llm-resolver.ts#L174-L182](../../../../src/agents/analyst-llm-resolver.ts#L174); replace with `decideFailure` + `availability.markFailed` on failure and `availability.markSucceeded` on success. Pass the same instance into its `ModelRouter`.
9. `AnalystHandler` ([src/agents/analyst-handler.ts](../../../../src/agents/analyst-handler.ts)) constructor — change `this.llmResolver = new LlmIntentResolver(projectRoot);` to `this.llmResolver = new LlmIntentResolver(projectRoot, activeRuntime.candidateAvailability);`. No other signature change is needed (`activeRuntime` is already a parameter).
10. `ActiveRuntime` ([src/runtime/active-runtime.ts](../../../../src/runtime/active-runtime.ts)) — construct `FsCandidateAvailability` BEFORE `AgentAdapter`; pass into `AgentAdapter` constructor; expose `get candidateAvailability()`; dispose in `dispose()`.

Why this compiles end-to-end at the checkpoint:
- The compile-time consumers of the deleted `ProviderRegistry` methods are `ModelRouter`, `AgentAdapter`, and `LlmIntentResolver`. All three are rewired in this batch.
- `InvocationRecoveryDecision.cooldownMs` consumers are the five `AgentAdapter` sites above and the analyst, all rewired in this batch.
- No "temporary `cooldownMs` field" scaffold survives. The field is deleted in the same batch that introduces `availability`.

Tests:
- `tests/agents/candidate-availability.test.ts` (new):
  - HEALTHY → BLOCKED_UNTIL on explicit `untilMs`; `isAvailable` false until time passes.
  - Monotonic untilMs: smaller incoming `markFailed` does not shrink the window.
  - `markSucceeded` clears state and resets `failureCount`.
  - `markFailed` with server `untilMs = now + 24h` produces `state.untilMs ≈ now + 24h` **verbatim** (no cap applied).
  - `markFailed` with server `untilMs <= now` discards the hint and stays HEALTHY (sign-check guard).
- `tests/agents/candidate-availability-store.test.ts` (new):
  - Round-trip: write three transitions, instantiate a new store from the same file, recover the latest live state.
  - **Cooldown survives process restart**: file persists `blocked_until`; a fresh `FsCandidateAvailability` answers `isAvailable === false` until `untilMs`.
  - Partial last line is tolerated.
  - Compaction past threshold collapses to one row per live key.
  - **Lock rejection**: second `FsCandidateAvailability` against the same `saivageDir` throws `CandidateAvailabilityLockedError`.
- `tests/agents/invocation-recovery-policy.test.ts` (extend):
  - **Cooldown honours `resets_at` verbatim**: rate-limit error with `resetsAtMs = now + 24h` produces `decision.availability.untilMs === resetsAtMs` (no truncation). `source === 'resets_at_body'`.
  - Unknown / server / timeout classes with no server hint produce `availability.untilMs === null`, `source: 'default'`.
- `tests/agents/agent-adapter-recovery.test.ts` (extend):
  - **Re-selection avoids any candidate in `blocked_until`**: seed availability with `c1` blocked for 1 h; invoke role wired to `[c1, c2]`; assert `model_selected` event names `c2`. On a second invocation within the hour, `c2` is still selected; `c1` never returns until the window expires.
- `tests/agents/analyst-llm-resolver.integration.test.ts` (extend):
  - Analyst failure goes through `decideFailure`; the SAME `CandidateAvailability` instance receives the write (assert via injected `MemoryCandidateAvailabilityStore`).
  - The analyst and the agent paths writing to the same instance produce a single monotonically-coherent state per candidate key.
- `tests/agents/provider.test.ts` (rewrite):
  - DELETE every test that exercised `markFailed` / `isHealthy` / `getHealth` on `ProviderRegistry`.
  - Keep tests for `getCandidatesForModel`, `getProvidersForModel`, capabilities, account resolution.
- `tests/agents/model-router.test.ts` (extend):
  - Constructor accepts `CandidateAvailability`; eligibility honours `isAvailable`.

Green checkpoint:
```
npx tsc --noEmit
npm test -- --runTestsByPath \
  tests/agents/candidate-availability.test.ts \
  tests/agents/candidate-availability-store.test.ts \
  tests/agents/invocation-recovery-policy.test.ts \
  tests/agents/agent-adapter-recovery.test.ts \
  tests/agents/analyst-llm-resolver.integration.test.ts \
  tests/agents/provider.test.ts \
  tests/agents/model-router.test.ts
```

Risk: high (single transaction touches every recovery path). Rollback: `git revert` of the batch restores the legacy in-memory cooldown; the JSONL file and lock file become orphans (safe to delete).

### Batch 3 — Operator surface and docs

Scope:
- New read-only HTTP route `GET /api/runtime/candidate-availability` returning `availability.all()` as JSON (snapshot, read-only).
- `docs/runbook/operations.md` row for the new route (per the operator API contract verifier).
- `docs/runtime.md` (or wherever provider-recovery is documented; locate via `grep -rn "recoveryDelayMs" docs/`) updates to describe `BLOCKED_UNTIL` / `COOLING` states, the JSONL audit file, the lock file, the no-cap policy on `resets_at`, and the new `candidateAvailabilityCompactBytes` config field.

Tests:
- `tests/server/operator-api-contract-fixtures.test.ts` (extend): assert the new route exists with documented top-level keys.
- `tests/docs-route-verification.test.ts` (extend): route appears in the docs row with the right schema anchors.
- `scripts/docs-verify.sh` passes.

Green checkpoint: `npx tsc --noEmit && npm test -- --runTestsByPath tests/server/operator-api-contract-fixtures.test.ts tests/docs-route-verification.test.ts && ./scripts/docs-verify.sh`. Then full-suite gate: `npm test`.

Risk: low. Rollback: revert route and docs row.

### Summary of deletions (architecture-first checklist)

Verified by `grep` at end of batch 2 — zero hits expected:
- `CandidateHealth`, `defaultHealth` — types.
- `ProviderRegistry.healthStates` / `getHealth` / `isHealthy` / `markFailed` / `markSucceeded` / `markAttempted` / `getAllHealth` / `resetHealth` / `getCooldownMs` — methods.
- `InvocationRecoveryDecision.cooldownMs` — field (replaced by `availability`).
- Ad-hoc `registry.markFailed`/`registry.markSucceeded` calls in `LlmIntentResolver`.
- Any reference to `maxCooldownMs` — must not exist anywhere in the tree (review-r1 cap removal).

### Dependency on F08

F08 sharpens HTTP-body → `InvocationFailureClass` mapping. F03 consumes that mapping via `AvailabilityDecision.failureClass` and the parsed reset hints on the error. Either order is safe; recommended: **F08 → F03**.
