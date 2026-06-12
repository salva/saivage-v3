# F04 — Observability event gaps (combined analysis + design + plan, r2)

Closes F04. Cross-link: F05 r4 ([SPEC/review-2026-05/llm-gateway/F05-envelope-vs-toolcalls-orthogonality/02-design-r4.md#L427-L459](../F05-envelope-vs-toolcalls-orthogonality/02-design-r4.md#L427-L459)) adds `terminal_tool` to `invocation_succeeded` (non-nullable) and keeps `LlmExchange.attempts[].terminalTool` nullable for analyst exchanges. Under the Level-up design recommended here, F05's `terminal_tool` becomes one field of a typed discriminated-union outcome on a unified `llm_attempt` event; `LlmExchange.attempts[].terminalTool` is untouched.

Self-contained. Paths workspace-relative to [`/home/salva/g/ml/saivage-v3/`](../../../). Architecture-first, zero backward compatibility, no migration shims, no aliases, no dual-emit window.

r2 fixes from r1 review ([COMBINED-review-r1.md](COMBINED-review-r1.md)):

1. End-to-end strict event-schema path (registry helper + `buildLoggedEventSchema` strict-preserving for the two new kinds + strict standalone validators + strict assertions across `loggedEventSchema`, `loggedEventSchemaByKind`, and direct validators). See §2.2 schema block and §3 B1/B4.
2. Single emission boundary `recordAttemptOutcome(outcome)` is the only producer of `llm_attempt`; the per-failure `persistFailure → retry_attempted` site at [src/agents/agent-adapter.ts#L329](../../../src/agents/agent-adapter.ts#L329) and the inner `retry_same_after_delay → retry_attempted` site at [src/agents/agent-adapter.ts#L416-L418](../../../src/agents/agent-adapter.ts#L416-L418) are DELETED, not translated, ensuring exactly one failed-attempt row per HTTP failure. See §2.2 emission block and §3 B2.
3. Exhausted-summary ownership pinned to `AgentAdapter.invokeAgent` after `invokeWithRecovery` returns ([src/agents/agent-adapter.ts#L431-L443](../../../src/agents/agent-adapter.ts#L431-L443)); `invokeWithRecovery` returns failed attempts on exhaustion, so no caller-level `catch` is needed for the exhausted/cancelled case. See §2.2 summary emission and §3 B2.
4. Concrete web file paths for Cards event-log row and Agents timeline. See §2.2 web block and §3 B3.

---

## 1. Analysis (≤ 120 lines)

### 1.1 Scope

Six event kinds carry LLM-routing post-mortem signal. Five live in the agent domain, one in the runtime domain. The catalog is the single source of truth (Zod + TS + standalone validator schemas mirror it).

| Kind | Domain | Catalog | Validator | TS type |
|---|---|---|---|---|
| `session_started` | agent | [src/schemas/event-catalog.ts#L48](../../../src/schemas/event-catalog.ts#L48) | [src/schemas/validators.ts#L164](../../../src/schemas/validators.ts#L164) | [src/schemas/types.ts#L153](../../../src/schemas/types.ts#L153) |
| `model_selected` | agent | [src/schemas/event-catalog.ts#L49](../../../src/schemas/event-catalog.ts#L49) | [src/schemas/validators.ts#L165](../../../src/schemas/validators.ts#L165) | [src/schemas/types.ts#L154](../../../src/schemas/types.ts#L154) |
| `invocation_succeeded` | agent | [src/schemas/event-catalog.ts#L50](../../../src/schemas/event-catalog.ts#L50) | [src/schemas/validators.ts#L166](../../../src/schemas/validators.ts#L166) | [src/schemas/types.ts#L155](../../../src/schemas/types.ts#L155) |
| `invocation_failed` | agent | [src/schemas/event-catalog.ts#L51](../../../src/schemas/event-catalog.ts#L51) | [src/schemas/validators.ts#L167](../../../src/schemas/validators.ts#L167) | [src/schemas/types.ts#L156](../../../src/schemas/types.ts#L156) |
| `retry_attempted` | agent | [src/schemas/event-catalog.ts#L52](../../../src/schemas/event-catalog.ts#L52) | [src/schemas/validators.ts#L168](../../../src/schemas/validators.ts#L168) | [src/schemas/types.ts#L157](../../../src/schemas/types.ts#L157) |
| `runtime_run` | runtime | [src/schemas/event-catalog.ts#L41](../../../src/schemas/event-catalog.ts#L41) | open `runtimeRecordSchema` | [src/schemas/types.ts#L141](../../../src/schemas/types.ts#L141) |

`runtime_run` is open by design; the gap is in the five agent-domain events.

### 1.2 Field inventory: declared vs needed

A failure post-mortem must answer: which session, which role, which candidate (provider/model/account), which attempt index, how long the call took, what failure class fired, what recovery the policy chose, how long the candidate was cooled down, why other candidates were skipped, and (per F05) which terminal tool produced the envelope.

**`session_started`** — declared `{ session_id, role, goal_id, card_id }`. Emit site [src/agents/agent-adapter.ts#L302](../../../src/agents/agent-adapter.ts#L302). No gap.

**`model_selected`** — declared `{ session_id, provider, model, role }`. Emit site [src/agents/agent-adapter.ts#L334-L335](../../../src/agents/agent-adapter.ts#L334-L335). Missing typed: `attempt` (`recoveryCtx.attempt`), `account` (`candidate.account.id`), `same_candidate_attempt` (`sameCandidateRecoveryAttempt`). Operator impact: cannot tell whether the selection was the first try or the third retry.

**`invocation_succeeded`** — declared `{ session_id, role, attempt, duration_ms }`. Emit site [src/agents/agent-adapter.ts#L399-L400](../../../src/agents/agent-adapter.ts#L399-L400) passes `{ session_id, role, attempt, duration_ms, failureClass, recoveryAction }`. Two undeclared keys survive because every catalog entry uses `payload(...)` (= `.passthrough()` — see [src/schemas/event-catalog.ts#L7](../../../src/schemas/event-catalog.ts#L7)) and standalone validators are built from `passthroughBaseEventSchema` ([src/schemas/validators.ts#L132](../../../src/schemas/validators.ts#L132), [src/schemas/validators.ts#L164-L168](../../../src/schemas/validators.ts#L164-L168)). The JSONL writer validates through `loggedEventSchema.safeParse` ([src/observability/event-logger.ts#L107](../../../src/observability/event-logger.ts#L107)), and `buildLoggedEventSchema` itself adds a `.passthrough()` ([src/schemas/event-catalog.ts#L97](../../../src/schemas/event-catalog.ts#L97)) — so undeclared keys flow through all three layers. Missing typed: `provider`, `model`, `account`, `terminal_tool` (F05).

**`invocation_failed`** — declared `{ session_id, role, attempt, error_message }`. Emit site [src/agents/agent-adapter.ts#L410-L411](../../../src/agents/agent-adapter.ts#L410-L411) passes nine keys (five undeclared, same passthrough survival). Missing typed: `provider`, `model`, `account`, `duration_ms` (the inner `for(;;)` never captures `Date.now() - callStart` on the failure branch — see [src/agents/agent-adapter.ts#L353](../../../src/agents/agent-adapter.ts#L353) and [src/agents/agent-adapter.ts#L368](../../../src/agents/agent-adapter.ts#L368)), `failure_class`, `recovery_action`, `cooldown_ms`, `retry_delay_ms`, `capability_skip_reasons`, `error_name`, `error_preview` (a bounded, redacted body slice).

**`retry_attempted`** — declared `{ session_id, role, attempt, directive? }`. TWO emit sites: outer recovery in `persistFailure` callback at [src/agents/agent-adapter.ts#L329](../../../src/agents/agent-adapter.ts#L329) (fires on every `invokeWithRecovery` re-entry), and inner `retry_same_after_delay` at [src/agents/agent-adapter.ts#L416-L418](../../../src/agents/agent-adapter.ts#L416-L418). The inner site passes `{ failureClass, recoveryAction, retryDelayMs }` — undeclared. **Both sites fire after `invocation_failed` already fired for the same HTTP failure**, so a single failed HTTP call produces TWO post-failure event rows today (one `invocation_failed` + one `retry_attempted`).

### 1.3 Gap quantified

| Event | Declared | Actually emitted | Needed | Decl./needed |
|---|---:|---:|---:|---:|
| `session_started` | 4 | 4 | 4 | 4/4 |
| `model_selected` | 4 | 4 | 7 (+ attempt, account, same_candidate_attempt) | 4/7 |
| `invocation_succeeded` | 4 | 6 | 8 (+ provider, model, account, terminal_tool) | 4/8 |
| `invocation_failed` | 4 | 9 | 13 (+ provider, model, account, duration_ms, error_name, error_preview, failure_class, recovery_action, cooldown_ms, retry_delay_ms, capability_skip_reasons) | 4/13 |
| `retry_attempted` | 4 | 7 | 9 (+ provider, model, retry_kind) | 4/9 |

Total declared/needed across the five agent events: 20/41. Half of the diagnostic surface depends on the `.passthrough()` chain keeping untyped fields alive — a contract no TypeScript consumer can rely on. The operator-observed `provider=None`/`model=None`/`attempt=None` pattern in the dashboard is exactly the typed surface; the untyped keys are present in JSONL but invisible to typed UI code.

### 1.4 Why the focused fix isn't enough

The Focused proposal (§2.1) closes the field-count gap but preserves the structural problem: one LLM invocation still emits 1×`session_started` + N×`model_selected` + N×(`invocation_failed` ∨ `invocation_succeeded`) + M×`retry_attempted`, all sharing `session_id`. The retry-vs-failure double-emission persists. Any operator question ("what did attempt 3 try and why did it fail?") still requires a multi-event JOIN with implicit ordering rules. The Level-up proposal (§2.2) collapses the four per-attempt event kinds into one envelope so the JOIN and the double-emission both disappear.

---

## 2. Design (≤ 200 lines)

### 2.1 Proposal A — Focused (rejected)

Extend each of the four payloads with missing typed fields, keep four distinct kinds. Does NOT close the schema-vs-emitter drift class (`.passthrough()` is still the rule for catalog `payload(...)`), does NOT solve the failure/retry double-emission (`invocation_failed` + `retry_attempted` still both fire), and forces parallel edits across four kinds for every future failure-class (F08) or capability axis (F01) extension. Recommendation: REJECT in favor of B.

### 2.2 Proposal B — Level-up (RECOMMENDED): canonical `llm_attempt` + `llm_invocation_summary`

**Scope:** DELETE `model_selected`, `invocation_succeeded`, `invocation_failed`, `retry_attempted` (catalog + standalone validators + TS types + `LoggedEvent` union). Introduce two new event kinds with end-to-end strict schemas. Introduce a single emission boundary `recordAttemptOutcome(outcome)` in `AgentAdapter.invokeAgent` that is the ONLY producer of `llm_attempt`.

**Strict catalog helper** (closes blocker 1):

```ts
// src/schemas/event-catalog.ts
const payload = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();
const strictPayload = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

// Registry entry shape gains a `strict: boolean` flag; the two new entries are strict.
// All other entries default to strict: false (preserves current passthrough behaviour for
// runtime events that intentionally carry open-shape records).
export const EventRegistry = {
  /* ...existing entries unchanged, each gets `strict: false`... */
  llm_attempt:             { domain: 'agent', strict: true, schema: strictPayload({ /* see below */ }), severity: 'info',    tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  llm_invocation_summary:  { domain: 'agent', strict: true, schema: strictPayload({ /* see below */ }), severity: 'info',    tracked: true, audit: true, broadcast: true, outbound: 'operator' },
} as const satisfies Record<string, { domain: EventDomain; strict: boolean; schema: z.ZodTypeAny; severity: SeverityLevel; tracked: boolean; audit: boolean; broadcast: boolean; outbound: OutboundPolicy }>;
```

**Strict-preserving `buildLoggedEventSchema`** (replaces [src/schemas/event-catalog.ts#L87-L98](../../../src/schemas/event-catalog.ts#L87-L98)):

```ts
export function buildLoggedEventSchema<K extends EventKind>(kind: K): z.ZodTypeAny {
  const base = z.object({
    id: z.string().min(1),
    kind: z.literal(kind),
    timestamp: z.string().datetime(),
    session_id: z.string().optional(),
    goal_id: z.string().optional(),
    card_id: z.string().optional(),
  });
  const entry = EventRegistry[kind];
  const { kind: _k, id: _i, timestamp: _t, ...payloadShape } = (entry.schema as z.AnyZodObject).shape;
  void _k; void _i; void _t;
  const extended = base.extend(payloadShape);
  return entry.strict ? extended.strict() : extended.passthrough();
}
```

**Strict standalone validators** (added to [src/schemas/validators.ts](../../../src/schemas/validators.ts), parallel to the strict pattern already used at [src/schemas/validators.ts#L137](../../../src/schemas/validators.ts#L137) for `processReconciledDeadEventSchema`):

```ts
export const llmAttemptEventSchema = baseEventSchema.extend({ kind: z.literal('llm_attempt'), /* see payload below */ }).strict();
export const llmInvocationSummaryEventSchema = baseEventSchema.extend({ kind: z.literal('llm_invocation_summary'), /* see payload below */ }).strict();
```

**The two new event kinds** (payload shapes shared by catalog and standalone validator; success/failure modelled as a Zod `discriminatedUnion` so missing branch-required fields are rejected):

```ts
const failureClassSchema = z.enum(['auth','rate_limit','server_transient','timeout','parse','capability','cancelled','unknown']);
const recoveryActionSchema = z.enum(['retry_same_after_delay','cooldown_and_failover','abort','succeed','no_candidates']);
const capabilitySkipSchema = z.array(z.object({ provider: z.string(), model: z.string(), reasons: z.array(z.string()) }).strict()).optional();
const terminalToolSchema = z.enum(['emit_planner_result','emit_executor_result','emit_reviewer_result']);

// llm_attempt: ONE event per HTTP call to ONE candidate. Emitted exactly once per attempt.
//   - On success: outcome.kind === 'succeeded', carries terminal_tool.
//   - On failure: outcome.kind === 'failed', carries failure_class + recovery_action.
//     Both inner `retry_same_after_delay` and outer `cooldown_and_failover` paths emit
//     ONE failed attempt with the appropriate recovery_action; the NEXT attempt is the
//     retry (higher same_candidate_attempt for inner, higher attempt for outer).
{
  session_id: z.string(),
  role: agentRoleSchema,
  attempt: z.number().int().nonnegative(),                  // outer recovery counter
  same_candidate_attempt: z.number().int().nonnegative(),   // inner retry_same_after_delay counter
  provider: z.string(),
  model: z.string(),
  account: z.string(),
  started_at: z.string().datetime(),
  duration_ms: z.number().nonnegative(),
  outcome: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('succeeded'),
      terminal_tool: terminalToolSchema,
    }).strict(),
    z.object({
      kind: z.literal('failed'),
      failure_class: failureClassSchema,
      recovery_action: recoveryActionSchema,
      error_name: z.string(),
      error_message: z.string(),
      error_preview: z.string().optional(),
      cooldown_ms: z.number().nonnegative().optional(),
      retry_delay_ms: z.number().nonnegative().optional(),
    }).strict(),
  ]),
  capability_skip_reasons: capabilitySkipSchema,
}

// llm_invocation_summary: ONE event per role invocation (zero or more attempts → one verdict).
{
  session_id: z.string(),
  role: agentRoleSchema,
  goal_id: z.string(),
  card_id: z.string(),
  attempts_count: z.number().int().nonnegative(),
  total_duration_ms: z.number().nonnegative(),
  verdict: z.enum(['succeeded','exhausted','cancelled']),
  final_provider: z.string().optional(),                    // present iff verdict === 'succeeded'
  final_model: z.string().optional(),
  final_account: z.string().optional(),
  final_terminal_tool: terminalToolSchema.optional(),
  last_failure_class: failureClassSchema.optional(),        // present iff verdict !== 'succeeded'
}
// Conditional presence is asserted by a `.superRefine(...)` that fails if
// (verdict==='succeeded' && (!final_provider || !final_model || !final_account || !final_terminal_tool))
// or (verdict!=='succeeded' && !last_failure_class).
```

**What disappears** (B2): the four agent-domain entries at [src/schemas/event-catalog.ts#L49-L52](../../../src/schemas/event-catalog.ts#L49-L52), the four standalone validators at [src/schemas/validators.ts#L165-L168](../../../src/schemas/validators.ts#L165-L168), the four TS interfaces at [src/schemas/types.ts#L154-L157](../../../src/schemas/types.ts#L154-L157), and the corresponding members of `LoggedEvent`. No aliases. No translator. No dual-emit.

**Single emission boundary `recordAttemptOutcome`** (closes blocker 2). `AgentAdapter.invokeAgent` defines a private helper that is the ONLY caller of `appendEvent({ kind: 'llm_attempt', ... })` and `eventBus.emit('llm_attempt', ...)`. It captures attempt context from the enclosing scope:

```ts
// Defined once per agentFn invocation, closing over candidate / recoveryCtx / sameCandidateRecoveryAttempt /
// callStart / capabilitySkips. Called exactly once per HTTP call.
const recordAttemptOutcome = (outcome: LlmAttemptOutcome) => {
  const duration_ms = Date.now() - callStart;
  const payload = {
    session_id: session.id,
    role,
    attempt: recoveryCtx.attempt,
    same_candidate_attempt: sameCandidateRecoveryAttempt,
    provider: candidate.provider,
    model: candidate.model,
    account: candidate.account.id,
    started_at: new Date(callStart).toISOString(),
    duration_ms,
    outcome,
    capability_skip_reasons: capabilitySkips.length ? capabilitySkips : undefined,
  } as const;
  this.eventLogger?.appendEvent({ kind: 'llm_attempt', ...payload });
  this.eventBus?.emit('llm_attempt', payload);
};
```

**Emission-site rewrites** in [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts) — the changes that close the double-emission blocker are listed explicitly:

| Old site | Old emission | Replacement |
|---|---|---|
| L334-L335 `model_selected` | `appendEvent + emit('model_selected', ...)` | DELETED. The next `llm_attempt` carries `provider`/`model`/`account`/`attempt`/`same_candidate_attempt`; "candidate chosen" is no longer an event of its own. |
| L399-L400 `invocation_succeeded` (success branch) | `appendEvent + emit('invocation_succeeded', ...)` | `recordAttemptOutcome({ kind: 'succeeded', terminal_tool: ROLE_RESULT_TOOL_NAMES[role] })`. Source per F05 r4 §3.6. |
| L410-L411 `invocation_failed` (catch branch) | `appendEvent + emit('invocation_failed', ...)` | `recordAttemptOutcome({ kind: 'failed', failure_class: decision.failureClass, recovery_action: decision.action, error_name: lastError.name, error_message: this.redactModelIssueText(decision.message), error_preview: this.redactProviderErrorMessage(lastError.message.slice(0, 240)), cooldown_ms: decision.cooldownMs, retry_delay_ms: decision.retryDelayMs })`. Computes `callDuration` on the failure branch (currently only the success branch does). |
| L329 `persistFailure → retry_attempted` (outer recovery) | `appendEvent + emit('retry_attempted', ...)` inside `persistFailure` callback | DELETED. The outer recovery retry is the next `llm_attempt` row with `attempt = recoveryCtx.attempt + 1`. `persistFailure` keeps only its `appendSessionMessage(... 'model_issue' ...)` side effect — no event emission. |
| L416-L418 `retry_attempted` (inner `retry_same_after_delay`) | `appendEvent + emit('retry_attempted', ...)` before `delayInvocationRecovery` | DELETED. The inner retry is the next `llm_attempt` row with the same `attempt` and `same_candidate_attempt = previous + 1`. The `recovery_action: 'retry_same_after_delay'` carried by the just-emitted failed attempt makes the intent explicit. |

**Cardinality invariant** (asserted by B2 tests): for each candidate × HTTP call, exactly ONE `llm_attempt` row is emitted, distinguished by `(attempt, same_candidate_attempt, provider, model, account)`. Retries are subsequent rows, never additional rows for the same call.

**Summary emission ownership** (closes advisory 1). `invokeWithRecovery` returns `attempts: InvokeWithRecoveryAttempt[]` on exhaustion rather than throwing ([src/agents/recovery.ts#L84-L154](../../../src/agents/recovery.ts#L84-L154)); `AgentAdapter.invokeAgent` already inspects `attempts[attempts.length - 1]` to decide success/failure ([src/agents/agent-adapter.ts#L431-L443](../../../src/agents/agent-adapter.ts#L431-L443)). The summary is emitted in `AgentAdapter.invokeAgent` BEFORE the `completeSession(..., 'done'|'failed'|'blocked')` call and BEFORE rethrowing on exhaustion. Verdict is derived as:

- `succeeded` — `lastAttempt.success === true`.
- `cancelled` — `lastAttempt.success === false` and `lastAttempt.error` matches the session-cancelled message, or `sessionCoordinator.isCancelled(session.id)`.
- `exhausted` — `lastAttempt.success === false` otherwise.

`final_*` fields are populated from the last `recordAttemptOutcome` payload (held in a single `let lastAttemptPayload` captured by `recordAttemptOutcome`); `last_failure_class` is populated from the last failed outcome.

**Web consumer changes** (closes advisory 2, with file paths). All under [web/src/](../../../web/src/):

- [web/src/stores/debug-read-model.ts#L5](../../../web/src/stores/debug-read-model.ts#L5): replace the `^invocation_failed$|...` regex with `^llm_attempt$|_error$|_failed$`.
- [web/src/stores/debug-read-model.ts#L45](../../../web/src/stores/debug-read-model.ts#L45): replace `kind === 'invocation_failed'` severity rule with `kind === 'llm_attempt' && event.outcome.kind === 'failed' ? 'warning' : 'error'`.
- Cards event-log row component: [web/src/components/cards/CardEventLogRow.vue](../../../web/src/components/cards/CardEventLogRow.vue) — render one row per `llm_attempt` with columns `attempt`, `provider/model`, `duration_ms`, `outcome.kind`, `outcome.failure_class` (when failed); render `llm_invocation_summary` as a distinct pinned row showing the verdict badge.
- Agents per-session timeline: [web/src/components/agents/AgentSessionTimeline.vue](../../../web/src/components/agents/AgentSessionTimeline.vue) — group consecutive `llm_attempt` rows under their matching `llm_invocation_summary` parent, keyed by `(session_id, role)`.
- Read-model composable for the grouped view: [web/src/composables/useAgentInvocationGroups.ts](../../../web/src/composables/useAgentInvocationGroups.ts) (new) — exposes `{ summary, attempts[] }` tuples per `(session_id, role)` derived from the same event stream `debug-read-model.ts` already consumes.
- Cards view event-log filter: [web/src/components/cards/CardEventLogFilters.vue](../../../web/src/components/cards/CardEventLogFilters.vue) — drop the four deleted kinds from the kind picker; add `llm_attempt` and `llm_invocation_summary`.

### 2.3 Cross-link to F05 (no contradictions)

F05 r4 ([SPEC/review-2026-05/llm-gateway/F05-envelope-vs-toolcalls-orthogonality/02-design-r4.md#L427-L459](../F05-envelope-vs-toolcalls-orthogonality/02-design-r4.md#L427-L459)) makes `invocation_succeeded.terminal_tool` non-nullable. Under B, `terminal_tool` is a field of `outcome[succeeded]`; non-nullability falls out of the discriminated union (the failed branch has no such field). `llm_invocation_summary.final_terminal_tool` is non-nullable iff `verdict === 'succeeded'`, asserted by the `.superRefine(...)`. `LlmExchange.attempts[].terminalTool` remains nullable for analyst exchanges (different contract — see [SPEC/review-2026-05/llm-gateway/F05-envelope-vs-toolcalls-orthogonality/02-design-r4.md#L455-L459](../F05-envelope-vs-toolcalls-orthogonality/02-design-r4.md#L455-L459)). The plan in §3 schedules F04 first; F05's batch that writes `terminal_tool` becomes a write of `outcome.terminal_tool` on the same code path.

---

## 3. Plan (≤ 180 lines)

Four batched commits. Each is a green checkpoint (`npx tsc --noEmit` + relevant Jest run). Implements Proposal B. No compat shim — the four old kinds are deleted in B2 and downstream consumers are migrated in the same atomic merge group (B2 + B3 land together; see B2 risk note).

### Batch B1 — Strict schema scaffolding for the two new kinds

**Files:**

- [src/schemas/event-catalog.ts](../../../src/schemas/event-catalog.ts) — add `strictPayload` helper; widen `EventRegistry` entry shape with `strict: boolean`; tag every existing entry `strict: false`; add `llm_attempt` and `llm_invocation_summary` entries with `strict: true` and the §2.2 shapes (`outcome` discriminated union, `.superRefine` on summary). Update `buildLoggedEventSchema` to preserve `strict` (returns `.strict()` for strict entries, `.passthrough()` otherwise).
- [src/schemas/validators.ts](../../../src/schemas/validators.ts) — add `llmAttemptEventSchema` and `llmInvocationSummaryEventSchema` built from `baseEventSchema.extend(...).strict()` (NOT from `passthroughBaseEventSchema`). Both are added to `loggedEventSchemaByKind` automatically because the latter iterates `eventKindValues`.
- [src/schemas/types.ts](../../../src/schemas/types.ts) — add `LlmAttemptEvent`, `LlmInvocationSummaryEvent`, `LlmAttemptOutcome` interfaces; extend `LoggedEvent` union.

**Tests added** (all under [tests/schemas/event-catalog.test.ts](../../../tests/schemas/event-catalog.test.ts)):

- `llm_attempt schema accepts succeeded outcome with all required fields`
- `llm_attempt schema accepts failed outcome with cooldown_ms + retry_delay_ms`
- `llm_attempt schema REJECTS missing terminal_tool on succeeded outcome` (verifies discriminated union strictness)
- `llm_attempt schema REJECTS missing failure_class on failed outcome`
- `llm_attempt schema REJECTS unknown top-level field` (verifies catalog `strict: true` reached `loggedEventSchemaByKind.llm_attempt`)
- `llm_attempt schema REJECTS unknown field nested inside outcome` (verifies `.strict()` on the discriminated union branches)
- `llm_attempt schema REJECTS unknown nested field in capability_skip_reasons[]`
- `llm_invocation_summary schema requires final_provider/final_model/final_account/final_terminal_tool when verdict=succeeded` (asserts `.superRefine`)
- `llm_invocation_summary schema requires last_failure_class when verdict=exhausted|cancelled`
- `llm_invocation_summary schema REJECTS unknown top-level field`
- `loggedEventSchema REJECTS llm_attempt event carrying an unknown top-level key` (verifies union dispatch keeps strictness)
- `validators.llmAttemptEventSchema REJECTS unknown top-level key independently of catalog path` (verifies the direct validator export)

**Checkpoint:** `npx tsc --noEmit` clean; `npx jest tests/schemas` green.

**Risk:** the registry-derived enums `eventKindValues`, `agentEventKindValues`, `operatorBroadcastEventKindValues` ([src/schemas/event-catalog.ts#L90-L97](../../../src/schemas/event-catalog.ts#L90-L97)) auto-include the two new kinds; any exhaustive `switch (kind)` on `EventKind` fails to compile. **Mitigation:** `tsc` surfaces every such site; add `case 'llm_attempt':`/`case 'llm_invocation_summary':` no-ops, real handling lands in B3. **Rollback:** revert the commit; no on-disk artifact written.

### Batch B2 — Single-emission boundary + delete old kinds + summary in `invokeAgent`

**Files:**

- [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts) — implement the rewrites tabled in §2.2:
  - Add a private `LlmAttemptOutcome` type alias and a private `recordAttemptOutcome` closure inside `invokeAgent`'s `agentFn` (so it captures `candidate`, `recoveryCtx.attempt`, `sameCandidateRecoveryAttempt`, `callStart`, `capabilitySkips`, `session.id`, `role` directly).
  - DELETE the `model_selected` emission at L334-L335 entirely.
  - REPLACE the success-branch L399-L400 emission with `recordAttemptOutcome({ kind: 'succeeded', terminal_tool: ROLE_RESULT_TOOL_NAMES[role] })`.
  - REPLACE the failure-branch L410-L411 emission with `recordAttemptOutcome({ kind: 'failed', ... })` (the helper handles `started_at`/`duration_ms`/provider/model/account/attempt counters). Move the existing success-only `callDuration = Date.now() - callStart` measurement so it is available on the failure branch too (compute inside the helper from `callStart` captured at L353).
  - DELETE the `retry_attempted` emission from the `persistFailure` callback at L329 (keep only the `appendSessionMessage(... 'model_issue' ...)` side effect).
  - DELETE the `retry_attempted` emission at L416-L418 from the inner `retry_same_after_delay` branch; the preceding failed-outcome row already carries `recovery_action: 'retry_same_after_delay'`.
  - In `invokeAgent`, AFTER `const attempts = await invokeWithRecovery(...)` returns at L430 and BEFORE the `if (lastAttempt.success && ...)` decision at L431, derive `verdict` and emit ONE `llm_invocation_summary` event. Compute `attempts_count` from `attempts.length`; `total_duration_ms` from a `Date.now() - invocationStart` captured before `invokeWithRecovery`. `final_*` fields are taken from a `lastSucceededAttemptPayload` reference updated inside `recordAttemptOutcome` when `outcome.kind === 'succeeded'`. `last_failure_class` is taken from a `lastFailedFailureClass` reference updated similarly.
- [src/schemas/event-catalog.ts](../../../src/schemas/event-catalog.ts) — DELETE the four old entries at L49-L52.
- [src/schemas/validators.ts](../../../src/schemas/validators.ts) — DELETE `modelSelectedEventSchema`, `invocationSucceededEventSchema`, `invocationFailedEventSchema`, `retryAttemptedEventSchema` at L165-L168.
- [src/schemas/types.ts](../../../src/schemas/types.ts) — DELETE the four interfaces at L154-L157 and remove from `LoggedEvent` union.

**Tests added** (under [tests/agents/agent-adapter.test.ts](../../../tests/agents/agent-adapter.test.ts) unless noted):

- `emits exactly one llm_attempt[succeeded] per HTTP call plus one llm_invocation_summary[verdict=succeeded]` — drive a 1-candidate success; assert event-bus saw exactly 1×`llm_attempt` and exactly 1×`llm_invocation_summary` with `attempts_count=1`, `final_provider`/`final_model`/`final_account`/`final_terminal_tool` populated.
- `cooldown_and_failover chain emits exactly one llm_attempt[failed] per candidate with monotonic attempt index, no extra rows` — drive a 3-candidate-failure flow; assert exactly 3×`llm_attempt[failed]` (not 6, not 5 — closes the double-emission blocker), `attempt` values 1,2,3, each with `recovery_action='cooldown_and_failover'`; assert 1×`llm_invocation_summary[verdict='exhausted']` with `attempts_count=3`, `last_failure_class` set, `final_*` undefined.
- `retry_same_after_delay emits exactly one llm_attempt[failed] then exactly one llm_attempt[succeeded] for the same candidate` — drive a flow where the policy returns `action='retry_same_after_delay'` once then succeeds; assert 2 `llm_attempt` rows, both same provider/model/account, first `(attempt=1, same_candidate_attempt=1, outcome.kind='failed', outcome.recovery_action='retry_same_after_delay')`, second `(attempt=1, same_candidate_attempt=2, outcome.kind='succeeded')`. NO third row for "retry attempted".
- `cancelled mid-flight emits llm_invocation_summary[verdict=cancelled] with last_failure_class=cancelled` — drive `sessionCoordinator.cancel(...)` during the call; assert the verdict.
- `tests/schemas/types.test.ts::LoggedEvent does not contain old LLM event kinds` — compile-time `// @ts-expect-error` over a fixture with `kind: 'invocation_succeeded'`.
- DELETE any existing test asserting emission of the four old kinds (locate via `grep -rn "invocation_succeeded\|invocation_failed\|model_selected\|retry_attempted" tests/`).

**Checkpoint:** `npx tsc --noEmit` clean; `npx jest tests/agents tests/schemas` green.

**Risk:** the operator dashboard consumer at [web/src/stores/debug-read-model.ts#L5](../../../web/src/stores/debug-read-model.ts#L5) still references the old kinds; until B3 lands the dashboard shows no LLM events. **Mitigation:** B2 and B3 ship as two commits in the SAME PR and merge atomically. **Rollback:** revert both commits together.

### Batch B3 — Web consumers migrated to `llm_attempt` / `llm_invocation_summary`

**Files:**

- [web/src/stores/debug-read-model.ts](../../../web/src/stores/debug-read-model.ts) — L5 regex update; L45 severity rule update (both per §2.2 web block).
- [web/src/components/cards/CardEventLogRow.vue](../../../web/src/components/cards/CardEventLogRow.vue) — render `llm_attempt` row template; render `llm_invocation_summary` as pinned summary row.
- [web/src/components/cards/CardEventLogFilters.vue](../../../web/src/components/cards/CardEventLogFilters.vue) — drop the four removed kinds from filters; add the two new kinds.
- [web/src/components/agents/AgentSessionTimeline.vue](../../../web/src/components/agents/AgentSessionTimeline.vue) — group `llm_attempt` rows under their `llm_invocation_summary` parent.
- [web/src/composables/useAgentInvocationGroups.ts](../../../web/src/composables/useAgentInvocationGroups.ts) (new) — exposes grouped `{ summary, attempts[] }` tuples per `(session_id, role)`.
- Any `switch (kind)` site flagged by tsc in B1 — implement real cases.

**Tests added** (under [tests/web/](../../../tests/web/)):

- `event-log-rendering.test.ts::renders llm_attempt[failed] with provider, model, attempt, failure_class visible`
- `event-log-rendering.test.ts::renders llm_attempt[succeeded] with terminal_tool badge`
- `event-log-rendering.test.ts::renders llm_invocation_summary[exhausted] with verdict + last_failure_class`
- `event-log-rendering.test.ts::renders llm_invocation_summary[succeeded] with final_provider/final_model badges`
- `useAgentInvocationGroups.test.ts::groups N llm_attempt rows under their matching llm_invocation_summary by (session_id, role)`

**Checkpoint:** `npx tsc --noEmit` clean; full `npx jest` green; `cd web && npx vue-tsc --noEmit` clean.

**Risk:** `runtime/events.jsonl` written by an older binary contains the four deleted kinds; `parseLoggedEventCompat` ([src/schemas/validators.ts#L181](../../../src/schemas/validators.ts#L181)) routes unknown kinds through its compatibility branch, so the dashboard surfaces them as `unknown-kind` rather than crashing. Per the workspace zero-backward-compat guideline this is acceptable; operators may delete the stale JSONL. **Rollback:** revert B3 alone; B2 still emits the new kinds.

### Batch B4 — Drift guards (structural + AST)

**Files:**

- [tests/schemas/event-catalog.test.ts](../../../tests/schemas/event-catalog.test.ts) — `llm_attempt and llm_invocation_summary are strict end to end` (asserts `EventRegistry.llm_attempt.strict === true`, `loggedEventSchemaByKind.llm_attempt` rejects unknown keys, `loggedEventSchema` rejects unknown keys on these two kinds, and `validators.llmAttemptEventSchema`/`llmInvocationSummaryEventSchema` reject unknown keys). This is the structural guard that closes the schema-vs-emitter drift class going forward.
- `scripts/check-event-emitter-drift.ts` (new) — walk [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts) AST, locate every `appendEvent({ kind: 'llm_attempt' | 'llm_invocation_summary', ... })` literal-object expression, and statically assert that the literal's keys are a subset of the catalog's keys for that kind. Wire into [package.json](../../../package.json) `scripts` as `check:event-drift` and into CI alongside `tsc`.
- [tests/scripts/check-event-emitter-drift.test.ts](../../../tests/scripts/check-event-emitter-drift.test.ts) (new) — fixture file emits a `kind: 'llm_attempt', not_a_real_field: 1`; assert the AST walker flags it.

**Checkpoint:** full `npx jest` green; `npm run check:event-drift` green.

**Risk:** none beyond the intended one — the strict schemas now fail loudly on undeclared fields. That is the goal. **Rollback:** revert B4; the runtime still works on the strict schemas from B1, just without the AST guard.

### 3.1 Deletion checklist (verified by grep before merge)

- DELETE: `model_selected`, `invocation_succeeded`, `invocation_failed`, `retry_attempted` in catalog + standalone validators + TS types + `LoggedEvent` union (B2).
- DELETE: every emit-site call for the four old kinds in [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts) at L329, L334-L335, L399-L400, L410-L411, L416-L418 (B2).
- DELETE: every test asserting emission of the four old kinds (B2).
- VERIFY: `grep -rn "'model_selected'\|'invocation_succeeded'\|'invocation_failed'\|'retry_attempted'" src/ tests/ web/src/` returns ZERO matches after B3.
- NO compat: no dual-emit, no alias, no `model_selected → llm_attempt` translator. Hard cutover per workspace guideline.

### 3.2 Cross-batch invariants

- After B2: every agent-domain line in `runtime/events.jsonl` is one of `session_started`, `llm_attempt`, `llm_invocation_summary`, `compaction_triggered`, `self_check_triggered`, `model_issue`, `session_cancelled`, `session_force_cancelled`, `mcp_tool_invocation`.
- After B2: for each HTTP call from `AgentAdapter.invokeAgent`, EXACTLY ONE `llm_attempt` row exists. Tested directly.
- After B3: a single role invocation is renderable from exactly one `llm_invocation_summary` + N consecutive `llm_attempt` rows, no cross-event JOIN at render time.
- After B4: it is a structural (Zod-strict) AND static (AST) error to emit an undeclared field on `llm_attempt` or `llm_invocation_summary`.

---

## 4. F-closure

**Closes F04.** Level-up replaces four thin, drifted event kinds with one typed-discriminated-union `llm_attempt` plus one per-invocation `llm_invocation_summary`. The schema-vs-emitter drift class is closed end to end by B1 (strict catalog helper + strict `buildLoggedEventSchema` branch + strict standalone validators) and reinforced by B4 (structural assertion + AST guard). The retry/failure double-emission bug is closed by B2's single `recordAttemptOutcome` boundary, which is the only producer of `llm_attempt`; the two `retry_attempted` sites and the `model_selected` site are DELETED rather than translated, and inner/outer retries are represented implicitly by the next attempt row. Cross-link to F05: `terminal_tool` lives on `outcome[succeeded]` of `llm_attempt` and `final_terminal_tool` on `llm_invocation_summary`; F05's batch that adds this field collapses to a single line under the unified envelope. F03 (cooldown observability) and F08 (failure-class expansion) both consume `outcome[failed]` — adding a `failure_class` enum value or a `cooldown_ms` field is a one-line strict-schema edit and no per-event-kind plumbing.
