# F04 — Observability event gaps (combined analysis + design + plan, r1)

Closes F04. Cross-link: F05 adds `terminal_tool` to `invocation_succeeded` (three-role, non-nullable). Under the Level-up design recommended here, that field becomes one column of the unified `LlmAttempt` outcome envelope rather than a special case bolted onto a single event kind.

Self-contained. Paths workspace-relative to `/home/salva/g/ml/saivage-v3/`. Architecture-first, zero backward compatibility, no migration shims.

---

## 1. Analysis (target ≤ 120 lines)

### 1.1 Scope

Six event kinds carry the LLM-routing post-mortem signal. Five live in the agent domain, one in the runtime domain. The catalog is the single source of truth (Zod + TS + validator schemas mirror it).

| Kind | Domain | Catalog | Validator | TS type |
|---|---|---|---|---|
| `session_started` | agent | [src/schemas/event-catalog.ts#L48](../../../src/schemas/event-catalog.ts#L48) | [src/schemas/validators.ts#L164](../../../src/schemas/validators.ts#L164) | [src/schemas/types.ts#L153](../../../src/schemas/types.ts#L153) |
| `model_selected` | agent | [src/schemas/event-catalog.ts#L49](../../../src/schemas/event-catalog.ts#L49) | [src/schemas/validators.ts#L165](../../../src/schemas/validators.ts#L165) | [src/schemas/types.ts#L154](../../../src/schemas/types.ts#L154) |
| `invocation_succeeded` | agent | [src/schemas/event-catalog.ts#L50](../../../src/schemas/event-catalog.ts#L50) | [src/schemas/validators.ts#L166](../../../src/schemas/validators.ts#L166) | [src/schemas/types.ts#L155](../../../src/schemas/types.ts#L155) |
| `invocation_failed` | agent | [src/schemas/event-catalog.ts#L51](../../../src/schemas/event-catalog.ts#L51) | [src/schemas/validators.ts#L167](../../../src/schemas/validators.ts#L167) | [src/schemas/types.ts#L156](../../../src/schemas/types.ts#L156) |
| `retry_attempted` | agent | [src/schemas/event-catalog.ts#L52](../../../src/schemas/event-catalog.ts#L52) | [src/schemas/validators.ts#L168](../../../src/schemas/validators.ts#L168) | [src/schemas/types.ts#L157](../../../src/schemas/types.ts#L157) |
| `runtime_run` | runtime | [src/schemas/event-catalog.ts#L41](../../../src/schemas/event-catalog.ts#L41) | (open `runtimeRecordSchema`) | [src/schemas/types.ts#L141](../../../src/schemas/types.ts#L141) |

`runtime_run` is open (`anyRecord`); it carries arbitrary run telemetry and is not the gap. The gap is in the five agent-domain events below.

### 1.2 Per-event field inventory: declared vs needed

A "failure post-mortem" needs to answer: which session, which role, which candidate (`provider`/`model`/account), which attempt index, how long did the call take, what failure class fired, what recovery the policy chose, how long we cooled the candidate down, why other candidates were skipped, and (per F05) which terminal tool produced the envelope.

Each row below is **declared in catalog** vs **passed at the emit site** vs **needed for diagnostics**.

**`session_started`** — declared `{ session_id, role, goal_id, card_id }`. Emit site [src/agents/agent-adapter.ts#L302](../../../src/agents/agent-adapter.ts#L302). No gap; this event correctly carries the join keys for every downstream event.

**`model_selected`** — declared `{ session_id, provider, model, role }`. Emit site [src/agents/agent-adapter.ts#L334-L335](../../../src/agents/agent-adapter.ts#L334-L335). Emitted as `{ session_id, provider, model, role }`. Missing: `attempt` (available in `recoveryCtx.attempt`), `account` (available in `candidate.account.id`), `same_candidate_attempt` (the `sameCandidateRecoveryAttempt` counter declared at [src/agents/agent-adapter.ts#L326](../../../src/agents/agent-adapter.ts#L326)). **Operator impact:** in `runtime/events.jsonl` you see "model X selected" but cannot tell whether it was the first try or the third retry.

**`invocation_succeeded`** — declared `{ session_id, role, attempt, duration_ms }`. Emit site [src/agents/agent-adapter.ts#L399-L400](../../../src/agents/agent-adapter.ts#L399-L400) passes `{ session_id, role, attempt, duration_ms, failureClass, recoveryAction }`. The two extra keys survive only because every schema uses `payload(...)` (a `.passthrough()` object — see [src/schemas/event-catalog.ts#L7](../../../src/schemas/event-catalog.ts#L7)) and the validators mirror it via `passthroughBaseEventSchema.extend(...)`. They are NOT typed in `InvocationSucceededEvent`, so every TS consumer reads `attempt`/`duration_ms` only. Missing typed: `provider`, `model`, `account`, `terminal_tool` (F05). Operator impact: a success record without `provider`/`model` can only be joined back to the candidate by walking backward to the prior `model_selected` with the same `session_id`.

**`invocation_failed`** — declared `{ session_id, role, attempt, error_message }`. Emit site [src/agents/agent-adapter.ts#L410-L411](../../../src/agents/agent-adapter.ts#L410-L411) passes `{ session_id, role, attempt, error_message, failureClass, recoveryAction, cooldownMs, retryDelayMs, capabilitySkipReasons }`. Five undeclared keys, same passthrough survival. Missing typed: `provider`, `model`, `account`, `duration_ms` (the inner `for(;;)` does not record `callStart` to `callDuration` on the failure branch — see [src/agents/agent-adapter.ts#L353](../../../src/agents/agent-adapter.ts#L353) and [src/agents/agent-adapter.ts#L368](../../../src/agents/agent-adapter.ts#L368)), `failureClass`, `recoveryAction`, `cooldownMs`, `retryDelayMs`, `capabilitySkipReasons`, `error_name`, `error_preview` (a redacted body slice — distinct from `error_message` so the JSONL is consistently bounded). Operator impact: this is the single most important event for diagnosis, and the catalog declares the least.

**`retry_attempted`** — declared `{ session_id, role, attempt, directive? }`. Two emit sites: [src/agents/agent-adapter.ts#L296](../../../src/agents/agent-adapter.ts#L296) (outer recovery, fires on every `invokeWithRecovery` re-entry) and [src/agents/agent-adapter.ts#L416](../../../src/agents/agent-adapter.ts#L416) (inner `retry_same_after_delay`). The inner site passes `{ failureClass, recoveryAction, retryDelayMs }` — undeclared. Missing typed: `provider`/`model` for the inner site (the candidate is known), `retry_kind: 'outer_recovery' | 'inner_same_candidate'` (currently indistinguishable), `attempt_in_chain` and `same_candidate_attempt`. Operator impact: you cannot tell from JSONL whether the retry is the recovery loop kicking back in or the cooldown-bypassing same-candidate retry.

### 1.3 Gap quantified

| Event | Declared | Actually emitted | Needed | Declared/needed |
|---|---:|---:|---:|---:|
| `session_started` | 4 | 4 | 4 | 4/4 |
| `model_selected` | 4 | 4 | 7 (+ attempt, account, same_candidate_attempt) | 4/7 |
| `invocation_succeeded` | 4 | 6 | 8 (+ provider, model, account, terminal_tool) | 4/8 |
| `invocation_failed` | 4 | 9 | 13 (+ provider, model, account, duration_ms, error_name, error_preview, failureClass, recoveryAction, cooldownMs, retryDelayMs, capabilitySkipReasons) | 4/13 |
| `retry_attempted` | 4 | 7 | 9 (+ provider, model, retry_kind) | 4/9 |

Total declared/needed across the five agent events: 20/41. Half of the diagnostic surface depends on `payload()`'s `passthrough` keeping untyped fields alive — a contract no TypeScript consumer can rely on. The operator-observed `provider=None`/`model=None`/`attempt=None` pattern is exactly the typed surface; the untyped keys are present in JSONL but invisible to typed UI code.

### 1.4 Why the focused fix isn't enough

The Focused proposal (§2.1) closes the field-count gap. It does not fix the structural issue: a single LLM invocation produces 1×`session_started` + N×`model_selected` + N×(`invocation_failed` ∨ `invocation_succeeded`) + M×`retry_attempted`, all sharing `session_id`. Any operator question ("what did the third attempt try and why did it fail?") requires a multi-event JSONL join with implicit ordering rules. The Level-up proposal (§2.2) collapses the four per-attempt events into one envelope so the join is gone.

---

## 2. Design (target ≤ 200 lines)

### 2.1 Proposal A — Focused: typed fields per event

**Scope:** extend each of the four payload schemas with the missing diagnostic fields; keep four distinct event kinds; declare the currently-untyped passthrough fields.

**Schema changes** (catalog → validators → types in lockstep; the three files mirror each other and Zod is the source of truth).

```ts
// src/schemas/event-catalog.ts (EventRegistry)
const failureClassSchema = z.enum(['auth','rate_limit','server_transient','timeout','parse','capability','cancelled','unknown']);
const recoveryActionSchema = z.enum(['retry_same_after_delay','cooldown_and_failover','abort','succeed','no_candidates']);
const capabilitySkipSchema = z.array(z.object({ provider: z.string(), model: z.string(), reasons: z.array(z.string()) }));

model_selected:      payload({ session_id, provider, model, account: z.string(), role, attempt: z.number(), same_candidate_attempt: z.number() }),
invocation_succeeded: payload({ session_id, role, provider: z.string(), model: z.string(), account: z.string(), attempt: z.number(), duration_ms: z.number(), terminal_tool: z.enum(['emit_planner_result','emit_executor_result','emit_reviewer_result']) }),
invocation_failed:    payload({ session_id, role, provider: z.string(), model: z.string(), account: z.string(), attempt: z.number(), duration_ms: z.number(), failure_class: failureClassSchema, recovery_action: recoveryActionSchema, error_name: z.string(), error_message: z.string(), error_preview: z.string().optional(), cooldown_ms: z.number().optional(), retry_delay_ms: z.number().optional(), capability_skip_reasons: capabilitySkipSchema.optional() }),
retry_attempted:      payload({ session_id, role, provider: z.string().optional(), model: z.string().optional(), attempt: z.number(), retry_kind: z.enum(['outer_recovery','inner_same_candidate']), directive: z.string().optional(), failure_class: failureClassSchema.optional(), recovery_action: recoveryActionSchema.optional(), retry_delay_ms: z.number().optional() }),
```

**Emission-site changes** (all in [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts)):

- L334 `model_selected`: add `attempt: recoveryCtx.attempt`, `same_candidate_attempt: sameCandidateRecoveryAttempt`, `account: candidate.account.id`.
- L368 wrap the `try` so `callDuration = Date.now() - callStart` is computed in both branches; pass `duration_ms` to `invocation_failed`.
- L399 `invocation_succeeded`: add `provider: candidate.provider`, `model: candidate.model`, `account: candidate.account.id`, `terminal_tool` (sourced per F05 from `ROLE_RESULT_TOOL_NAMES[role]`).
- L410 `invocation_failed`: add the same triple plus `duration_ms`, `error_name: lastError.name`, `error_preview` (call existing `redactProviderErrorMessage` over a 240-char slice).
- L296 and L416 `retry_attempted`: split into two call sites carrying `retry_kind: 'outer_recovery'` vs `'inner_same_candidate'`; the inner one adds `provider`/`model`.

**Web-UI consumer changes:**

- [web/src/stores/debug-read-model.ts#L5](../../../web/src/stores/debug-read-model.ts#L5) and [web/src/stores/debug-read-model.ts#L45](../../../web/src/stores/debug-read-model.ts#L45) keep working (they only read `kind === 'invocation_failed'`).
- Cards view (event-log row) and Agents view (per-session timeline) gain four extra columns: provider, model, attempt, duration. Implementation note: today these consumers receive `LoggedEvent`; once the types are extended they pick up the new fields with no template changes beyond rendering.

**Test plan (focused):**

- `tests/schemas/event-catalog.test.ts` — for each of the four event kinds, round-trip a fixture containing every required field; assert the schema REJECTS fixtures missing any newly-required field.
- `tests/agents/agent-adapter.test.ts` — drive a success and a 3-candidate-failure invocation against a stub gateway; assert the captured event-bus payloads carry the typed fields.
- `tests/web/event-log-rendering.test.ts` — render an event-log row from each new payload shape and assert provider/model/attempt are visible.

**Net delta:** ~80 lines of code added across three schema files, ~30 lines in the adapter, four new tests. Architectural debt unchanged: four event kinds, four JOIN keys, untyped passthrough survives.

### 2.2 Proposal B — Level-up (RECOMMENDED): canonical `LlmAttempt` + `LlmInvocationSummary`

**Scope:** delete `model_selected`, `invocation_succeeded`, `invocation_failed`, `retry_attempted`. Introduce two new event kinds. No compat aliases, no dual-emit window, no `kind === 'model_selected'` survivor anywhere.

**Two new event kinds:**

```ts
// One event per attempt (the unit that produced ONE HTTP call to ONE candidate).
llm_attempt: payload({
  session_id: z.string(),
  role: agentRoleSchema,
  attempt: z.number(),                          // outer recovery counter
  same_candidate_attempt: z.number(),           // inner retry_same_after_delay counter
  provider: z.string(),
  model: z.string(),
  account: z.string(),
  started_at: z.string().datetime(),
  duration_ms: z.number(),                      // wall time of the HTTP call
  outcome: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('succeeded'),
      terminal_tool: z.enum(['emit_planner_result','emit_executor_result','emit_reviewer_result']),
    }),
    z.object({
      kind: z.literal('failed'),
      failure_class: failureClassSchema,
      recovery_action: recoveryActionSchema,
      error_name: z.string(),
      error_message: z.string(),
      error_preview: z.string().optional(),
      cooldown_ms: z.number().optional(),
      retry_delay_ms: z.number().optional(),
    }),
  ]),
  capability_skip_reasons: capabilitySkipSchema.optional(), // candidates the router dropped before this attempt
}),

// One event per role invocation (zero or more attempts → one verdict).
llm_invocation_summary: payload({
  session_id: z.string(),
  role: agentRoleSchema,
  goal_id: z.string(),
  card_id: z.string(),
  attempts_count: z.number(),
  total_duration_ms: z.number(),
  verdict: z.enum(['succeeded','exhausted','cancelled']),
  final_provider: z.string().optional(),    // present iff verdict === 'succeeded'
  final_model: z.string().optional(),
  final_account: z.string().optional(),
  final_terminal_tool: z.enum(['emit_planner_result','emit_executor_result','emit_reviewer_result']).optional(),
  last_failure_class: failureClassSchema.optional(), // present iff verdict !== 'succeeded'
}),
```

**What disappears:** the entire bottom block of [src/schemas/event-catalog.ts#L49-L52](../../../src/schemas/event-catalog.ts#L49-L52) (four entries), the four mirror entries in [src/schemas/validators.ts#L165-L168](../../../src/schemas/validators.ts#L165-L168), the four TS interfaces at [src/schemas/types.ts#L154-L157](../../../src/schemas/types.ts#L154-L157), and the four `LoggedEvent` union members.

**Emission-site changes** (collapsed to two call sites in [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts)):

1. Replace the three discrete `appendEvent({ kind: 'model_selected' | 'invocation_succeeded' | 'invocation_failed', ... })` calls with a single helper `emitAttempt(outcome)` called from the success branch (L399) and the failure branch (L410). The helper captures `candidate`, `recoveryCtx.attempt`, `sameCandidateRecoveryAttempt`, `callStart`/`callDuration` from local scope.
2. Replace the two `retry_attempted` emit sites with one `emitAttempt({ kind: 'failed', recovery_action: 'retry_same_after_delay' | ... })` at the cooldown boundary; the outer-recovery retry is implicit in the next `llm_attempt` carrying a higher `attempt` value.
3. After `invokeWithRecovery` returns at [src/agents/agent-adapter.ts#L431](../../../src/agents/agent-adapter.ts#L431), emit one `llm_invocation_summary` carrying the verdict and the snapshot of the last attempt's candidate. If the recovery loop threw, emit summary with `verdict: 'exhausted'` from the `catch` boundary in the caller (e.g. [src/runtime/active-runtime.ts#L164](../../../src/runtime/active-runtime.ts#L164)).

**Web-UI consumer changes:**

- [web/src/stores/debug-read-model.ts#L5](../../../web/src/stores/debug-read-model.ts#L5): replace `^invocation_failed$|_error$|_failed$` with `^llm_attempt$|_error$|_failed$` and read `event.outcome.kind === 'failed'` for severity.
- Cards view event-log row: one row per `llm_attempt`, columns `attempt`/`provider`/`model`/`duration_ms`/`outcome.kind` (+`outcome.failure_class` when failed). One pinned row per `llm_invocation_summary` showing the final verdict.
- Agents view per-session timeline: collapses to N×`llm_attempt` plus 1×`llm_invocation_summary` per role invocation — a single grouped block per invocation, no cross-event joins.

**Test plan (level-up):**

- `tests/schemas/event-catalog.test.ts` — `llm_attempt` schema accepts the two discriminated outcomes, rejects unknown `kind`, rejects missing `terminal_tool` on the `succeeded` branch, rejects missing `failure_class` on the `failed` branch; `llm_invocation_summary` requires `final_provider`/`final_model`/`final_terminal_tool` when `verdict === 'succeeded'` (refine + zod refinement, asserted by test).
- `tests/agents/agent-adapter.test.ts` — drive a 3-candidate-failure-then-success flow against a stub gateway; assert the event-bus saw exactly 4×`llm_attempt` (3 failed, 1 succeeded) with monotonically increasing `attempt` and the expected `provider`/`model`/`account` per row, and exactly 1×`llm_invocation_summary` with `verdict: 'succeeded'` and the success candidate's snapshot.
- `tests/agents/agent-adapter.test.ts` — drive an "all candidates exhausted" flow; assert the summary carries `verdict: 'exhausted'` with `last_failure_class` set and no `final_*` fields.
- `tests/web/event-log-rendering.test.ts` — render an `llm_attempt[failed]` row and assert provider/model/attempt/failure_class are visible; render an `llm_invocation_summary[exhausted]` row and assert verdict + last_failure_class are visible.
- `tests/schemas/types.test.ts` — compile-time fixture: `LoggedEvent` no longer contains `'model_selected' | 'invocation_succeeded' | 'invocation_failed' | 'retry_attempted'` (negative type assertion via `Exclude<LoggedEvent['kind'], 'model_selected'>` distributing back to `LoggedEvent['kind']`).

**Recommendation: B (Level-up).** Per the architecture-first guideline, the deleted event kinds, the deleted JOIN logic in downstream consumers, and the discriminated-union outcome eliminate the schema-vs-emitter drift class entirely (you cannot pass an undeclared `failureClass` on `llm_attempt` because the success branch has no such field). The Focused proposal preserves the drift class — every future failure-class addition (F08) and every future capability axis (F01) would need four parallel edits across four event kinds. Level-up needs one. The only Level-up tradeoff is a larger PR; this is acceptable per the workspace guideline ("refactor broadly when it improves the design").

### 2.3 Cross-link to F05

F05's design (r4) adds `terminal_tool` to `invocation_succeeded` as a non-nullable enum of the three terminal tools, and to `LlmExchange.attempts[].terminalTool` as nullable (analyst exchanges set null). Under Level-up B, `terminal_tool` is a field of the `outcome[succeeded]` branch of `llm_attempt`; the non-nullability falls out of the discriminated union (the failed branch has no `terminal_tool` field at all). `LlmExchange.attempts[].terminalTool` is unaffected (different contract). The plan in §3 schedules F04 to land first; F05's batch that touches `invocation_succeeded.terminal_tool` becomes a write of `outcome.terminal_tool` on the same code path.

---

## 3. Plan (target ≤ 180 lines)

**Strategy:** four batched commits, each a green checkpoint (`npx tsc --noEmit` + the relevant Jest run). Implements Proposal B. No compat shim — the four old event kinds are deleted in B2 and downstream consumers are migrated in the same commit. Batch order is chosen so each commit's invariant is verifiable in isolation.

### Batch B1 — Schemas: add new kinds, keep old kinds temporarily

**Files:**
- [src/schemas/event-catalog.ts](../../../src/schemas/event-catalog.ts) — add `llm_attempt` and `llm_invocation_summary` entries with the §2.2 shapes. DO NOT touch the four old entries yet.
- [src/schemas/validators.ts](../../../src/schemas/validators.ts) — add `llmAttemptEventSchema` and `llmInvocationSummaryEventSchema` mirror entries.
- [src/schemas/types.ts](../../../src/schemas/types.ts) — add `LlmAttemptEvent` and `LlmInvocationSummaryEvent` interfaces; extend the `LoggedEvent` union.

**Tests added:**
- `tests/schemas/event-catalog.test.ts::llm_attempt schema accepts succeeded outcome`
- `tests/schemas/event-catalog.test.ts::llm_attempt schema accepts failed outcome with cooldown`
- `tests/schemas/event-catalog.test.ts::llm_attempt schema rejects missing terminal_tool on succeeded outcome`
- `tests/schemas/event-catalog.test.ts::llm_attempt schema rejects missing failure_class on failed outcome`
- `tests/schemas/event-catalog.test.ts::llm_invocation_summary schema requires final_* iff verdict=succeeded`

**Checkpoint:** `npx tsc --noEmit` clean; `npx jest tests/schemas` green.

**Risk:** registry-driven enums (e.g. `eventKindValues`, `operatorBroadcastEventKindValues` at [src/schemas/event-catalog.ts#L90](../../../src/schemas/event-catalog.ts#L90)) auto-include the new kinds; any consumer doing exhaustive `switch (kind)` on `EventKind` will fail to compile. **Mitigation:** `npx tsc --noEmit` surfaces every such site; fix each `default: never` with a no-op `case 'llm_attempt':`/`case 'llm_invocation_summary':` deferred to B3. **Rollback:** revert the commit; no on-disk artifact written.

### Batch B2 — Emitter: switch agent-adapter to the new envelopes, delete old kinds

**Files:**
- [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts) — introduce a private `emitAttempt(outcome)` helper that resolves `started_at`, `duration_ms`, `provider`/`model`/`account` from local scope. Replace `appendEvent({ kind: 'model_selected', ... })` at L334 with nothing (the attempt event subsumes "candidate chosen"); replace `appendEvent({ kind: 'invocation_succeeded', ... })` at L399 with `emitAttempt({ kind: 'succeeded', terminal_tool: ROLE_RESULT_TOOL_NAMES[role] })`; replace `appendEvent({ kind: 'invocation_failed', ... })` at L410 with `emitAttempt({ kind: 'failed', ... })`; replace both `retry_attempted` emit sites with `emitAttempt({ kind: 'failed', recovery_action: ... })` carrying the recovery action. Compute `callDuration` on the failure branch (currently only on success).
- After `invokeWithRecovery` returns at [src/agents/agent-adapter.ts#L431](../../../src/agents/agent-adapter.ts#L431), emit one `llm_invocation_summary` (verdict from the loop result); add a `try/catch` for `verdict: 'exhausted'` and a cancellation check for `verdict: 'cancelled'`.
- [src/schemas/event-catalog.ts](../../../src/schemas/event-catalog.ts), [src/schemas/validators.ts](../../../src/schemas/validators.ts), [src/schemas/types.ts](../../../src/schemas/types.ts) — DELETE the four old entries (`model_selected`, `invocation_succeeded`, `invocation_failed`, `retry_attempted`).

**Tests added (and old tests deleted):**
- `tests/agents/agent-adapter.test.ts::emits llm_attempt with provider/model/account per attempt and one llm_invocation_summary with verdict succeeded`
- `tests/agents/agent-adapter.test.ts::cooldown_and_failover walks the chain, emits N attempts with monotonic attempt index, summary verdict=exhausted carries last_failure_class`
- `tests/agents/agent-adapter.test.ts::retry_same_after_delay emits a failed attempt with recovery_action=retry_same_after_delay then a succeeded attempt with same candidate`
- DELETE any existing test that asserts emission of the four old kinds (locate via `grep -n "invocation_succeeded\|invocation_failed\|model_selected\|retry_attempted" tests/`).

**Checkpoint:** `npx tsc --noEmit` clean; `npx jest tests/agents tests/schemas` green.

**Risk:** the event-bus consumer at [web/src/stores/debug-read-model.ts#L5](../../../web/src/stores/debug-read-model.ts#L5) is still on the old regex and the operator dashboard will see no LLM events at runtime until B3 lands. **Mitigation:** keep B2 and B3 in a single PR with both commits, merging atomically. **Rollback:** revert the two commits together; old kinds reappear and emitter restored.

### Batch B3 — Consumers: web stores, event-log row, agents-view timeline

**Files:**
- [web/src/stores/debug-read-model.ts](../../../web/src/stores/debug-read-model.ts) — update L5 regex from `^invocation_failed$` to `^llm_attempt$` and L45 severity rule to `event.kind === 'llm_attempt' && event.outcome.kind === 'failed' ? 'warning' : 'error'`.
- Cards view event-log row template — render one row per `llm_attempt` with columns `attempt`, `provider/model`, `duration_ms`, `outcome.kind`, `outcome.failure_class` (when failed); render `llm_invocation_summary` as a distinct row with the verdict badge.
- Agents view per-session timeline — group consecutive `llm_attempt` rows under their `llm_invocation_summary` parent.
- Any `switch (kind)` on `EventKind` flagged by tsc in B1 — implement the new cases properly.

**Tests added:**
- `tests/web/event-log-rendering.test.ts::renders llm_attempt[failed] with provider, model, attempt, failure_class visible`
- `tests/web/event-log-rendering.test.ts::renders llm_attempt[succeeded] with terminal_tool badge`
- `tests/web/event-log-rendering.test.ts::renders llm_invocation_summary[exhausted] with verdict + last_failure_class`
- `tests/web/event-log-rendering.test.ts::renders llm_invocation_summary[succeeded] with final_provider/final_model badges`

**Checkpoint:** `npx tsc --noEmit` clean; full `npx jest` green; `cd web && npx vue-tsc --noEmit` clean.

**Risk:** an `runtime/events.jsonl` written by an older binary in the same project still contains the four deleted kinds; `parseLoggedEventCompat` at [src/schemas/validators.ts#L181](../../../src/schemas/validators.ts#L181) handles unknown kinds via its compatibility branch, so the dashboard will surface them as `unknown-kind` rows rather than crashing. Per workspace guideline (zero backward compat), this is acceptable; operators may delete the stale JSONL. **Mitigation:** none required. **Rollback:** revert B3 alone if web breaks; B2 still emits the new kinds and B1 schemas accept them — the event log is just unrendered until B3 re-lands.

### Batch B4 — Cleanup and invariant guards

**Files:**
- `tests/schemas/event-catalog.test.ts::no LLM event kind has a passthrough escape hatch` — assert that the catalog entries for `llm_attempt` and `llm_invocation_summary` use a non-passthrough schema (refactor `payload` helper variant or wrap the two new entries with `z.object({...}).strict()`); this is the structural guard that closes the original drift class for these two kinds going forward.
- `tests/schemas/types.test.ts::LoggedEvent does not contain old LLM event kinds` — negative type assertion using a `// @ts-expect-error` over a fixture with `kind: 'invocation_succeeded'`.
- `scripts/check-event-emitter-drift.ts` (new) — walk `src/agents/agent-adapter.ts` AST, find every `appendEvent({ kind: 'llm_attempt' | 'llm_invocation_summary', ... })` call, statically assert the literal object's keys are a subset of the catalog's keys for that kind. Wire into `package.json` scripts as `check:event-drift` and into CI alongside `tsc`.

**Tests added:**
- `tests/scripts/check-event-emitter-drift.test.ts::detects an undeclared field on an llm_attempt emit site (fixture)`

**Checkpoint:** full `npx jest` green; `npm run check:event-drift` green.

**Risk:** the new `.strict()` wrapping breaks any code that adds ad-hoc fields at emit time. That is the entire point — failures here are the desired signal. **Mitigation:** none. **Rollback:** revert B4; the system still works on the looser passthrough schemas from B1, just without the drift guard.

### 3.1 Migration & deletion checklist

- DELETE: `model_selected`, `invocation_succeeded`, `invocation_failed`, `retry_attempted` in catalog + validators + types + `LoggedEvent` union (B2).
- DELETE: all emit-site call expressions for the four old kinds (B2).
- DELETE: tests asserting emission of the four old kinds (B2).
- DELETE: `parseLoggedEventCompat`'s warning suppression for these specific kinds if any test special-cases them (none today, verified by grep).
- NO compat: no dual-emit, no alias, no `model_selected → llm_attempt` translator. Operators must accept a hard cutover per the workspace guideline.

### 3.2 Cross-batch invariants

- After B2: every `runtime/events.jsonl` line for the agent domain is either `session_started`, `llm_attempt`, `llm_invocation_summary`, `compaction_triggered`, `self_check_triggered`, `model_issue`, `session_cancelled`, `session_force_cancelled`, `mcp_tool_invocation`. No other agent-domain kinds exist in the catalog.
- After B3: a single role invocation is renderable from exactly one `llm_invocation_summary` + N consecutive `llm_attempt` rows, with no cross-event JOIN at render time.
- After B4: it is a compile-time + structural error to emit an undeclared field on `llm_attempt` or `llm_invocation_summary`.

---

## 4. F-closure

**Closes F04.** The Level-up design replaces four thin, drifted event kinds with one typed-discriminated-union attempt event plus one per-invocation summary; the structural drift class is closed by B4's `.strict()` schema + AST drift check. Cross-link to F05: F05's `terminal_tool` becomes `outcome[succeeded].terminal_tool` on `llm_attempt` and `final_terminal_tool` on `llm_invocation_summary`; F05's batch that adds this field collapses to a single line under the unified envelope. F03 (cooldown observability) and F08 (failure-class expansion) both consume the same `outcome[failed]` branch — adding a new `failure_class` enum value is a one-line schema edit and no per-event-kind plumbing.

