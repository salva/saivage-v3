# F04 — Observability event gaps (combined analysis + design + plan, r3)

Closes F04. Cross-link: F05 r4 ([SPEC/review-2026-05/llm-gateway/F05-envelope-vs-toolcalls-orthogonality/02-design-r4.md#L427-L459](../F05-envelope-vs-toolcalls-orthogonality/02-design-r4.md#L427-L459)) adds `terminal_tool` to `invocation_succeeded` (non-nullable) and keeps `LlmExchange.attempts[].terminalTool` nullable for analyst exchanges. Under the Level-up design recommended here, F05's `terminal_tool` becomes one field of a typed discriminated-union outcome on a unified `llm_attempt` event; `LlmExchange.attempts[].terminalTool` is untouched.

Self-contained. Paths workspace-relative to [`/home/salva/g/ml/saivage-v3/`](../../../). Architecture-first, zero backward compatibility, no migration shims, no aliases, no dual-emit window.

r3 fixes from r2 review ([COMBINED-review-r2.md](COMBINED-review-r2.md)):

1. **Strict registry composition vs `.superRefine`.** The r2 plan stored `schema: z.object(...).strict().superRefine(...)` and then re-extracted `(entry.schema as z.AnyZodObject).shape` inside `buildLoggedEventSchema`. After `.superRefine(...)` the schema is `ZodEffects` and `.shape` is undefined — `loggedEventSchemaByKind.llm_invocation_summary` would either silently drop the refinement or fail to build. **Fixed in r3** by splitting registry entries into `{ baseShape: ZodRawShape; refine?: (data, ctx) => void }`. `buildLoggedEventSchema` composes `z.object({ ...envelope, ...baseShape }).strict()` and conditionally applies `.superRefine(refine)`. The standalone validator for `llm_invocation_summary` is built the same way so the refinement reaches both schema paths. New tests assert that `loggedEventSchema`, `loggedEventSchemaByKind.llm_invocation_summary`, and `validators.llmInvocationSummaryEventSchema` all reject (a) unknown keys AND (b) invalid verdict/final-field combinations. See §2.2 schema block and §3 B1.
2. **`attempts_count` counts emitted `llm_attempt` rows.** The r2 plan computed it from `attempts.length` (the `invokeWithRecovery` outer-loop counter). One outer recovery attempt can contain multiple candidate HTTP calls (the inner `for(;;)` over `candidates`), so `attempts.length` undercounts. **Fixed in r3** by keeping a local `let attemptOutcomeCount = 0` in `AgentAdapter.invokeAgent`'s scope; `recordAttemptOutcome` increments it before emitting; `llm_invocation_summary.attempts_count` is read from it. The 3-HTTP-failure failover test is updated to assert `attempts_count === 3` even though `attempts.length === 1` (single outer recovery iteration). See §2.2 emission block and §3 B2.
3. (Carry-forward from r2.) End-to-end strict event-schema path (registry helper + `buildLoggedEventSchema` strict-preserving for the two new kinds + strict standalone validators + strict assertions across `loggedEventSchema`, `loggedEventSchemaByKind`, and direct validators).
4. (Carry-forward.) Single emission boundary `recordAttemptOutcome(outcome)` is the only producer of `llm_attempt`; the per-failure `persistFailure → retry_attempted` site at [src/agents/agent-adapter.ts#L329](../../../src/agents/agent-adapter.ts#L329) and the inner `retry_same_after_delay → retry_attempted` site at [src/agents/agent-adapter.ts#L416-L418](../../../src/agents/agent-adapter.ts#L416-L418) are DELETED, not translated.
5. (Carry-forward.) Exhausted-summary ownership pinned to `AgentAdapter.invokeAgent` after `invokeWithRecovery` returns ([src/agents/agent-adapter.ts#L431-L443](../../../src/agents/agent-adapter.ts#L431-L443)).
6. (Carry-forward.) Concrete web file paths for Cards event-log row and Agents timeline.

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

**`model_selected`** — declared `{ session_id, provider, model, role }`. Emit site [src/agents/agent-adapter.ts#L334-L335](../../../src/agents/agent-adapter.ts#L334-L335). Missing typed: `attempt`, `account`, `same_candidate_attempt`.

**`invocation_succeeded`** — declared `{ session_id, role, attempt, duration_ms }`. Emit site [src/agents/agent-adapter.ts#L399-L400](../../../src/agents/agent-adapter.ts#L399-L400) passes `{ session_id, role, attempt, duration_ms, failureClass, recoveryAction }`. Two undeclared keys survive because every catalog entry uses `payload(...)` (= `.passthrough()` — see [src/schemas/event-catalog.ts#L7](../../../src/schemas/event-catalog.ts#L7)) and standalone validators are built from `passthroughBaseEventSchema` ([src/schemas/validators.ts#L132](../../../src/schemas/validators.ts#L132)). The JSONL writer validates through `loggedEventSchema.safeParse` ([src/observability/event-logger.ts#L107](../../../src/observability/event-logger.ts#L107)), and `buildLoggedEventSchema` itself adds a `.passthrough()` ([src/schemas/event-catalog.ts#L97](../../../src/schemas/event-catalog.ts#L97)) — so undeclared keys flow through all three layers. Missing typed: `provider`, `model`, `account`, `terminal_tool` (F05).

**`invocation_failed`** — declared `{ session_id, role, attempt, error_message }`. Emit site [src/agents/agent-adapter.ts#L410-L411](../../../src/agents/agent-adapter.ts#L410-L411) passes nine keys (five undeclared). Missing typed: `provider`, `model`, `account`, `duration_ms` (the inner `for(;;)` never captures `Date.now() - callStart` on the failure branch — see [src/agents/agent-adapter.ts#L353](../../../src/agents/agent-adapter.ts#L353) and [src/agents/agent-adapter.ts#L368](../../../src/agents/agent-adapter.ts#L368)), `failure_class`, `recovery_action`, `cooldown_ms`, `retry_delay_ms`, `capability_skip_reasons`, `error_name`, `error_preview`.

**`retry_attempted`** — declared `{ session_id, role, attempt, directive? }`. TWO emit sites: outer recovery in `persistFailure` callback at [src/agents/agent-adapter.ts#L329](../../../src/agents/agent-adapter.ts#L329), and inner `retry_same_after_delay` at [src/agents/agent-adapter.ts#L416-L418](../../../src/agents/agent-adapter.ts#L416-L418). **Both fire after `invocation_failed` already fired for the same HTTP failure** — a single failed HTTP call produces TWO post-failure event rows today.

### 1.3 Gap quantified

| Event | Declared | Actually emitted | Needed | Decl./needed |
|---|---:|---:|---:|---:|
| `session_started` | 4 | 4 | 4 | 4/4 |
| `model_selected` | 4 | 4 | 7 | 4/7 |
| `invocation_succeeded` | 4 | 6 | 8 | 4/8 |
| `invocation_failed` | 4 | 9 | 13 | 4/13 |
| `retry_attempted` | 4 | 7 | 9 | 4/9 |

Total declared/needed across the five agent events: 20/41. Half of the diagnostic surface depends on the `.passthrough()` chain keeping untyped fields alive — a contract no TypeScript consumer can rely on. The operator-observed `provider=None`/`model=None`/`attempt=None` pattern in the dashboard is exactly the typed surface; the untyped keys are present in JSONL but invisible to typed UI code.

### 1.4 Why the focused fix isn't enough

The Focused proposal (§2.1) closes the field-count gap but preserves the structural problem: one LLM invocation still emits 1×`session_started` + N×`model_selected` + N×(`invocation_failed` ∨ `invocation_succeeded`) + M×`retry_attempted`, all sharing `session_id`. The retry-vs-failure double-emission persists. Any operator question ("what did attempt 3 try and why did it fail?") still requires a multi-event JOIN with implicit ordering rules. The Level-up proposal (§2.2) collapses the four per-attempt event kinds into one envelope so the JOIN and the double-emission both disappear.

---

## 2. Design (≤ 200 lines)

### 2.1 Proposal A — Focused (rejected)

Extend each of the four payloads with missing typed fields, keep four distinct kinds. Does NOT close the schema-vs-emitter drift class (`.passthrough()` is still the rule for catalog `payload(...)`), does NOT solve the failure/retry double-emission, and forces parallel edits across four kinds for every future failure-class (F08) or capability axis (F01) extension. Recommendation: REJECT in favor of B.

### 2.2 Proposal B — Level-up (RECOMMENDED): canonical `llm_attempt` + `llm_invocation_summary`

**Scope:** DELETE `model_selected`, `invocation_succeeded`, `invocation_failed`, `retry_attempted` (catalog + standalone validators + TS types + `LoggedEvent` union). Introduce two new event kinds with end-to-end strict schemas. Introduce a single emission boundary `recordAttemptOutcome(outcome)` in `AgentAdapter.invokeAgent` that is the ONLY producer of `llm_attempt`.

**Registry stores shape and refine separately** (closes r2 blocker 1). The catalog entry no longer holds a pre-composed `ZodTypeAny`; it holds a raw shape plus an optional refinement. Composition into a usable schema (with or without `.superRefine`) happens in `buildLoggedEventSchema` and in the standalone validators, identically.

```ts
// src/schemas/event-catalog.ts
import { z } from 'zod';

type RegistryEntry = {
  domain: EventDomain;
  strict: boolean;                                 // true → compose .strict(); false → .passthrough()
  baseShape: z.ZodRawShape;                        // payload-only shape, NEVER wrapped in z.object here
  refine?: (data: unknown, ctx: z.RefinementCtx) => void;  // optional cross-field check
  severity: SeverityLevel;
  tracked: boolean;
  audit: boolean;
  broadcast: boolean;
  outbound: OutboundPolicy;
};

// Existing entries: convert each `schema: payload({...})` to `baseShape: {...}` with strict: false.
// New entries: strict: true, baseShape only. The summary's cross-field rule lives in `refine`.

const llmAttemptBaseShape = {
  session_id: z.string(),
  role: agentRoleSchema,
  attempt: z.number().int().nonnegative(),
  same_candidate_attempt: z.number().int().nonnegative(),
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
  capability_skip_reasons: z.array(z.object({
    provider: z.string(), model: z.string(), reasons: z.array(z.string()),
  }).strict()).optional(),
} satisfies z.ZodRawShape;

const llmInvocationSummaryBaseShape = {
  session_id: z.string(),
  role: agentRoleSchema,
  goal_id: z.string(),
  card_id: z.string(),
  attempts_count: z.number().int().nonnegative(),
  total_duration_ms: z.number().nonnegative(),
  verdict: z.enum(['succeeded','exhausted','cancelled']),
  final_provider: z.string().optional(),
  final_model: z.string().optional(),
  final_account: z.string().optional(),
  final_terminal_tool: terminalToolSchema.optional(),
  last_failure_class: failureClassSchema.optional(),
} satisfies z.ZodRawShape;

const llmInvocationSummaryRefine = (data: unknown, ctx: z.RefinementCtx): void => {
  const d = data as {
    verdict: 'succeeded' | 'exhausted' | 'cancelled';
    final_provider?: string; final_model?: string; final_account?: string; final_terminal_tool?: string;
    last_failure_class?: string;
  };
  if (d.verdict === 'succeeded') {
    for (const k of ['final_provider','final_model','final_account','final_terminal_tool'] as const) {
      if (!d[k]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: `${k} required when verdict='succeeded'` });
    }
  } else {
    if (!d.last_failure_class) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['last_failure_class'], message: "last_failure_class required when verdict!='succeeded'" });
    }
  }
};

export const EventRegistry = {
  /* ...existing entries, each converted to { baseShape, strict: false }... */
  llm_attempt: {
    domain: 'agent', strict: true, baseShape: llmAttemptBaseShape,
    severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator',
  },
  llm_invocation_summary: {
    domain: 'agent', strict: true, baseShape: llmInvocationSummaryBaseShape,
    refine: llmInvocationSummaryRefine,
    severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator',
  },
} as const satisfies Record<string, RegistryEntry>;
```

**Strict-preserving `buildLoggedEventSchema`** (replaces [src/schemas/event-catalog.ts#L87-L98](../../../src/schemas/event-catalog.ts#L87-L98)). Composes envelope + baseShape in `z.object`, applies `.strict()` or `.passthrough()` per entry, then `.superRefine(refine)` if present. No `ZodEffects.shape` re-extraction anywhere.

```ts
export function buildLoggedEventSchema<K extends EventKind>(kind: K): z.ZodTypeAny {
  const entry = EventRegistry[kind];
  const base = z.object({
    id: z.string().min(1),
    kind: z.literal(kind),
    timestamp: z.string().datetime(),
    session_id: z.string().optional(),
    goal_id: z.string().optional(),
    card_id: z.string().optional(),
    ...entry.baseShape,
  });
  const shaped = entry.strict ? base.strict() : base.passthrough();
  return entry.refine ? shaped.superRefine(entry.refine) : shaped;
}
```

**Strict standalone validators** (added to [src/schemas/validators.ts](../../../src/schemas/validators.ts), built from the SAME `baseShape`/`refine` so both schema paths enforce identical rules):

```ts
import { EventRegistry } from './event-catalog';

const composeStrictKind = <K extends EventKind>(kind: K) => {
  const entry = EventRegistry[kind];
  const base = baseEventSchema.extend({ kind: z.literal(kind), ...entry.baseShape }).strict();
  return entry.refine ? base.superRefine(entry.refine) : base;
};

export const llmAttemptEventSchema = composeStrictKind('llm_attempt');
export const llmInvocationSummaryEventSchema = composeStrictKind('llm_invocation_summary');
```

**The two new event kinds — operational contract.** `llm_attempt`: ONE event per HTTP call to ONE candidate. Emitted exactly once per attempt. On success: `outcome.kind === 'succeeded'`, carries `terminal_tool`. On failure: `outcome.kind === 'failed'`, carries `failure_class` + `recovery_action`. Both inner `retry_same_after_delay` and outer `cooldown_and_failover` paths emit ONE failed attempt with the appropriate `recovery_action`; the NEXT attempt is the retry (higher `same_candidate_attempt` for inner, higher `attempt` for outer). `llm_invocation_summary`: ONE event per role invocation (zero or more attempts → one verdict).

**What disappears** (B2): the four agent-domain entries at [src/schemas/event-catalog.ts#L49-L52](../../../src/schemas/event-catalog.ts#L49-L52), the four standalone validators at [src/schemas/validators.ts#L165-L168](../../../src/schemas/validators.ts#L165-L168), the four TS interfaces at [src/schemas/types.ts#L154-L157](../../../src/schemas/types.ts#L154-L157), and the corresponding members of `LoggedEvent`. No aliases. No translator. No dual-emit.

**Single emission boundary `recordAttemptOutcome`** (carry-forward + r2 advisory fix). `AgentAdapter.invokeAgent` defines a private helper that is the ONLY caller of `appendEvent({ kind: 'llm_attempt', ... })` and `eventBus.emit('llm_attempt', ...)`. It captures attempt context from the enclosing scope AND increments a local `attemptOutcomeCount` so the summary counts emitted rows, not outer-loop iterations.

```ts
// Defined once per invokeAgent call. Captures candidate / recoveryCtx / sameCandidateRecoveryAttempt /
// callStart / capabilitySkips / session.id / role.
let attemptOutcomeCount = 0;                  // ← counts EMITTED llm_attempt rows (closes r2 advisory)
let lastSucceededAttemptPayload: LlmAttemptPayload | undefined;
let lastFailedFailureClass: FailureClass | undefined;

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
  attemptOutcomeCount += 1;
  if (outcome.kind === 'succeeded') lastSucceededAttemptPayload = payload;
  else lastFailedFailureClass = outcome.failure_class;
  this.eventLogger?.appendEvent({ kind: 'llm_attempt', ...payload });
  this.eventBus?.emit('llm_attempt', payload);
};
```

**Emission-site rewrites** in [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts):

| Old site | Old emission | Replacement |
|---|---|---|
| L334-L335 `model_selected` | `appendEvent + emit('model_selected', ...)` | DELETED. The next `llm_attempt` carries `provider`/`model`/`account`/`attempt`/`same_candidate_attempt`. |
| L399-L400 `invocation_succeeded` | `appendEvent + emit('invocation_succeeded', ...)` | `recordAttemptOutcome({ kind: 'succeeded', terminal_tool: ROLE_RESULT_TOOL_NAMES[role] })`. Source per F05 r4 §3.6. |
| L410-L411 `invocation_failed` | `appendEvent + emit('invocation_failed', ...)` | `recordAttemptOutcome({ kind: 'failed', failure_class: decision.failureClass, recovery_action: decision.action, error_name: lastError.name, error_message: this.redactModelIssueText(decision.message), error_preview: this.redactProviderErrorMessage(lastError.message.slice(0, 240)), cooldown_ms: decision.cooldownMs, retry_delay_ms: decision.retryDelayMs })`. Computes `callDuration` on the failure branch (currently only the success branch does). |
| L329 `persistFailure → retry_attempted` | `appendEvent + emit('retry_attempted', ...)` in `persistFailure` | DELETED. `persistFailure` keeps only its `appendSessionMessage(... 'model_issue' ...)` side effect. |
| L416-L418 `retry_attempted` (inner) | `appendEvent + emit('retry_attempted', ...)` | DELETED. The preceding failed-outcome row already carries `recovery_action: 'retry_same_after_delay'`. |

**Cardinality invariant** (asserted by B2 tests): for each candidate × HTTP call, exactly ONE `llm_attempt` row is emitted, distinguished by `(attempt, same_candidate_attempt, provider, model, account)`. `attemptOutcomeCount` equals the number of `llm_attempt` rows by construction.

**Summary emission ownership.** `invokeWithRecovery` returns `attempts: InvokeWithRecoveryAttempt[]` on exhaustion ([src/agents/recovery.ts#L84-L154](../../../src/agents/recovery.ts#L84-L154)); `AgentAdapter.invokeAgent` already inspects `attempts[attempts.length - 1]` to decide success/failure ([src/agents/agent-adapter.ts#L431-L443](../../../src/agents/agent-adapter.ts#L431-L443)). The summary is emitted in `AgentAdapter.invokeAgent` BEFORE `completeSession(..., 'done'|'failed'|'blocked')` and BEFORE rethrowing on exhaustion. Verdict:

- `succeeded` — `lastAttempt.success === true`.
- `cancelled` — `lastAttempt.success === false` and the error matches the session-cancelled message, or `sessionCoordinator.isCancelled(session.id)`.
- `exhausted` — `lastAttempt.success === false` otherwise.

`attempts_count` is read from `attemptOutcomeCount` (NOT `attempts.length` — closes r2 advisory). `final_*` fields are taken from `lastSucceededAttemptPayload` (when verdict==='succeeded'); `last_failure_class` from `lastFailedFailureClass`. The `.superRefine` in the registry rejects any payload that violates the verdict↔final-field invariant, so a coding bug in `invokeAgent` becomes a loud Zod parse failure at the event-logger boundary.

### 2.3 Web consumer changes

All under [web/src/](../../../web/src/):

- [web/src/stores/debug-read-model.ts#L5](../../../web/src/stores/debug-read-model.ts#L5): replace the `^invocation_failed$|...` regex with `^llm_attempt$|_error$|_failed$`.
- [web/src/stores/debug-read-model.ts#L45](../../../web/src/stores/debug-read-model.ts#L45): replace `kind === 'invocation_failed'` severity rule with `kind === 'llm_attempt' && event.outcome.kind === 'failed' ? 'warning' : 'error'`.
- [web/src/components/cards/CardEventLogRow.vue](../../../web/src/components/cards/CardEventLogRow.vue): render one row per `llm_attempt` with `attempt`, `provider/model`, `duration_ms`, `outcome.kind`, `outcome.failure_class` (when failed); render `llm_invocation_summary` as a distinct pinned row with the verdict badge.
- [web/src/components/agents/AgentSessionTimeline.vue](../../../web/src/components/agents/AgentSessionTimeline.vue): group consecutive `llm_attempt` rows under their matching `llm_invocation_summary` parent, keyed by `(session_id, role)`.
- [web/src/composables/useAgentInvocationGroups.ts](../../../web/src/composables/useAgentInvocationGroups.ts) (new): exposes `{ summary, attempts[] }` tuples.
- [web/src/components/cards/CardEventLogFilters.vue](../../../web/src/components/cards/CardEventLogFilters.vue): drop the four deleted kinds; add the two new kinds.

### 2.4 Cross-link to F05 (no contradictions)

F05 r4 makes `invocation_succeeded.terminal_tool` non-nullable. Under B, `terminal_tool` is a field of `outcome[succeeded]`; non-nullability falls out of the discriminated union. `llm_invocation_summary.final_terminal_tool` is non-nullable iff `verdict === 'succeeded'`, enforced by `llmInvocationSummaryRefine`. `LlmExchange.attempts[].terminalTool` remains nullable for analyst exchanges (different contract — see [SPEC/review-2026-05/llm-gateway/F05-envelope-vs-toolcalls-orthogonality/02-design-r4.md#L455-L459](../F05-envelope-vs-toolcalls-orthogonality/02-design-r4.md#L455-L459)). F04 lands first; F05's batch that writes `terminal_tool` becomes a write of `outcome.terminal_tool` on the same code path.

---

## 3. Plan (≤ 180 lines)

Four batched commits. Each is a green checkpoint (`npx tsc --noEmit` + relevant Jest run). Implements Proposal B.

### Batch B1 — Strict schema scaffolding for the two new kinds

**Files:**

- [src/schemas/event-catalog.ts](../../../src/schemas/event-catalog.ts) — widen `EventRegistry` entry shape to `{ baseShape: ZodRawShape; refine?: (data, ctx) => void; strict: boolean; ... }`. Convert every existing `schema: payload({...})` to `baseShape: {...}, strict: false`. Add `llm_attempt` (strict, no refine) and `llm_invocation_summary` (strict, with `llmInvocationSummaryRefine`) per §2.2. Rewrite `buildLoggedEventSchema` to compose `z.object({ ...envelope, ...entry.baseShape })`, apply `.strict()` or `.passthrough()` per `entry.strict`, then `.superRefine(entry.refine)` if present. No `(entry.schema as z.AnyZodObject).shape` anywhere.
- [src/schemas/validators.ts](../../../src/schemas/validators.ts) — add `composeStrictKind(kind)` helper that reads `EventRegistry[kind].baseShape` and `.refine`, builds `baseEventSchema.extend({ kind: literal, ...baseShape }).strict().superRefine(refine?)`. Export `llmAttemptEventSchema = composeStrictKind('llm_attempt')` and `llmInvocationSummaryEventSchema = composeStrictKind('llm_invocation_summary')`. Both are added to `loggedEventSchemaByKind` automatically because the latter iterates `eventKindValues`.
- [src/schemas/types.ts](../../../src/schemas/types.ts) — add `LlmAttemptEvent`, `LlmInvocationSummaryEvent`, `LlmAttemptOutcome`, `LlmAttemptPayload`; extend `LoggedEvent` union.

**Tests added** (under [tests/schemas/event-catalog.test.ts](../../../tests/schemas/event-catalog.test.ts) and [tests/schemas/validators.test.ts](../../../tests/schemas/validators.test.ts)):

- `llm_attempt schema accepts succeeded outcome with all required fields`
- `llm_attempt schema accepts failed outcome with cooldown_ms + retry_delay_ms`
- `llm_attempt schema REJECTS missing terminal_tool on succeeded outcome`
- `llm_attempt schema REJECTS missing failure_class on failed outcome`
- `llm_attempt schema REJECTS unknown top-level field`
- `llm_attempt schema REJECTS unknown field nested inside outcome`
- `llm_attempt schema REJECTS unknown nested field in capability_skip_reasons[]`
- `llm_invocation_summary catalog-derived schema (loggedEventSchemaByKind.llm_invocation_summary) REJECTS unknown top-level field` ← closes r2 blocker, asserts strict composition reaches the catalog path
- `llm_invocation_summary catalog-derived schema REJECTS verdict='succeeded' missing final_provider` ← asserts refinement reaches catalog path
- `llm_invocation_summary catalog-derived schema REJECTS verdict='succeeded' missing final_terminal_tool`
- `llm_invocation_summary catalog-derived schema REJECTS verdict='exhausted' missing last_failure_class`
- `validators.llmInvocationSummaryEventSchema (standalone) REJECTS unknown top-level field` ← asserts strict composition reaches the validator path
- `validators.llmInvocationSummaryEventSchema (standalone) REJECTS verdict='succeeded' missing final_account` ← asserts refinement reaches validator path
- `loggedEventSchema (top-level union) REJECTS llm_attempt event carrying an unknown top-level key`
- `loggedEventSchema (top-level union) REJECTS llm_invocation_summary event with verdict='cancelled' missing last_failure_class`

**Checkpoint:** `npx tsc --noEmit` clean; `npx jest tests/schemas` green.

**Risk:** the registry-derived enums `eventKindValues`, `agentEventKindValues`, `operatorBroadcastEventKindValues` ([src/schemas/event-catalog.ts#L90-L97](../../../src/schemas/event-catalog.ts#L90-L97)) auto-include the two new kinds; any exhaustive `switch (kind)` on `EventKind` fails to compile. **Mitigation:** `tsc` surfaces every such site; add no-op cases in B1, real handling in B3. **Rollback:** revert the commit.

### Batch B2 — Single-emission boundary + delete old kinds + summary in `invokeAgent`

**Files:**

- [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts) — implement the rewrites tabled in §2.2:
  - Declare `let attemptOutcomeCount = 0`, `let lastSucceededAttemptPayload`, `let lastFailedFailureClass`, `const invocationStart = Date.now()` in `invokeAgent` scope.
  - Add a private `LlmAttemptOutcome` type alias and the private `recordAttemptOutcome` closure inside `invokeAgent`'s `agentFn` (so it captures `candidate`, `recoveryCtx.attempt`, `sameCandidateRecoveryAttempt`, `callStart`, `capabilitySkips`, `session.id`, `role` directly AND increments `attemptOutcomeCount`).
  - DELETE the `model_selected` emission at L334-L335 entirely.
  - REPLACE the success-branch L399-L400 with `recordAttemptOutcome({ kind: 'succeeded', terminal_tool: ROLE_RESULT_TOOL_NAMES[role] })`.
  - REPLACE the failure-branch L410-L411 with `recordAttemptOutcome({ kind: 'failed', ... })`. Compute `callDuration` on the failure branch (currently only success branch does).
  - DELETE the `retry_attempted` emission from the `persistFailure` callback at L329.
  - DELETE the `retry_attempted` emission at L416-L418.
  - AFTER `const attempts = await invokeWithRecovery(...)` at L430 and BEFORE the `if (lastAttempt.success && ...)` at L431, emit ONE `llm_invocation_summary` with `attempts_count: attemptOutcomeCount` (NOT `attempts.length` — closes r2 advisory), `total_duration_ms: Date.now() - invocationStart`, verdict derived per §2.2, `final_*` from `lastSucceededAttemptPayload`, `last_failure_class` from `lastFailedFailureClass`.
- [src/schemas/event-catalog.ts](../../../src/schemas/event-catalog.ts) — DELETE the four old entries at L49-L52.
- [src/schemas/validators.ts](../../../src/schemas/validators.ts) — DELETE `modelSelectedEventSchema`, `invocationSucceededEventSchema`, `invocationFailedEventSchema`, `retryAttemptedEventSchema` at L165-L168.
- [src/schemas/types.ts](../../../src/schemas/types.ts) — DELETE the four interfaces at L154-L157; remove from `LoggedEvent`.

**Tests added** (under [tests/agents/agent-adapter.test.ts](../../../tests/agents/agent-adapter.test.ts)):

- `emits exactly one llm_attempt[succeeded] per HTTP call plus one llm_invocation_summary[verdict=succeeded] with attempts_count=1`
- `cooldown_and_failover with 3 candidate HTTP failures emits exactly 3 llm_attempt[failed] rows and one llm_invocation_summary with attempts_count=3` — drive a flow where the single outer `invokeWithRecovery` iteration walks 3 candidates inside the inner `for` loop; assert `attempts.length === 1` (outer counter) AND `attemptOutcomeCount === 3` AND the emitted summary's `attempts_count === 3`. This is the test that proves `attempts_count` counts emitted rows, not outer-loop iterations. ← closes r2 advisory
- `retry_same_after_delay emits exactly one llm_attempt[failed] then exactly one llm_attempt[succeeded] for the same candidate; summary attempts_count=2` — first row `(attempt=1, same_candidate_attempt=1, outcome.kind='failed', outcome.recovery_action='retry_same_after_delay')`, second `(attempt=1, same_candidate_attempt=2, outcome.kind='succeeded')`. NO third row for "retry attempted".
- `mixed flow: 2 inner retries on candidate A then failover to candidate B then success emits attempts_count=4 (NOT 2 outer iterations)` — explicitly distinguishes `attemptOutcomeCount` from `attempts.length`.
- `cancelled mid-flight emits llm_invocation_summary[verdict=cancelled] with last_failure_class=cancelled`
- `tests/schemas/types.test.ts::LoggedEvent does not contain old LLM event kinds` — compile-time `// @ts-expect-error` over a fixture with `kind: 'invocation_succeeded'`.
- DELETE existing tests asserting emission of the four old kinds (locate via `grep -rn "invocation_succeeded\|invocation_failed\|model_selected\|retry_attempted" tests/`).

**Checkpoint:** `npx tsc --noEmit` clean; `npx jest tests/agents tests/schemas` green.

**Risk:** the dashboard at [web/src/stores/debug-read-model.ts#L5](../../../web/src/stores/debug-read-model.ts#L5) still references the old kinds; until B3 lands the dashboard shows no LLM events. **Mitigation:** B2 and B3 ship as two commits in the SAME PR and merge atomically. **Rollback:** revert both commits together.

### Batch B3 — Web consumers migrated

**Files:** the six listed in §2.3, plus any `switch (kind)` site flagged by tsc in B1.

**Tests added** (under [tests/web/](../../../tests/web/)):

- `event-log-rendering.test.ts::renders llm_attempt[failed] with provider, model, attempt, failure_class visible`
- `event-log-rendering.test.ts::renders llm_attempt[succeeded] with terminal_tool badge`
- `event-log-rendering.test.ts::renders llm_invocation_summary[exhausted] with verdict + last_failure_class`
- `event-log-rendering.test.ts::renders llm_invocation_summary[succeeded] with final_provider/final_model badges`
- `useAgentInvocationGroups.test.ts::groups N llm_attempt rows under their matching llm_invocation_summary by (session_id, role)`

**Checkpoint:** `npx tsc --noEmit` clean; full `npx jest` green; `cd web && npx vue-tsc --noEmit` clean.

**Risk:** older `runtime/events.jsonl` contains the four deleted kinds; `parseLoggedEventCompat` ([src/schemas/validators.ts#L181](../../../src/schemas/validators.ts#L181)) routes unknown kinds through its compatibility branch, so the dashboard surfaces them as `unknown-kind` rather than crashing. Per the workspace zero-backward-compat guideline this is acceptable; operators may delete the stale JSONL. **Rollback:** revert B3 alone.

### Batch B4 — Drift guards (structural + AST)

**Files:**

- [tests/schemas/event-catalog.test.ts](../../../tests/schemas/event-catalog.test.ts) — `llm_attempt and llm_invocation_summary are strict end to end` (asserts `EventRegistry.llm_attempt.strict === true`, `loggedEventSchemaByKind.llm_attempt` rejects unknown keys, `loggedEventSchema` rejects unknown keys on these two kinds, `validators.llmAttemptEventSchema`/`llmInvocationSummaryEventSchema` reject unknown keys, AND that the summary's refinement reaches every path).
- `scripts/check-event-emitter-drift.ts` (new) — walk [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts) AST, locate every `appendEvent({ kind: 'llm_attempt' | 'llm_invocation_summary', ... })` literal-object expression, and statically assert that the literal's keys are a subset of the catalog's keys for that kind. Wire into [package.json](../../../package.json) `scripts` as `check:event-drift` and into CI alongside `tsc`.
- [tests/scripts/check-event-emitter-drift.test.ts](../../../tests/scripts/check-event-emitter-drift.test.ts) (new) — fixture file emits a `kind: 'llm_attempt', not_a_real_field: 1`; assert the AST walker flags it.

**Checkpoint:** full `npx jest` green; `npm run check:event-drift` green.

**Rollback:** revert B4; runtime still works on the strict schemas from B1.

### 3.1 Deletion checklist (verified by grep before merge)

- DELETE: `model_selected`, `invocation_succeeded`, `invocation_failed`, `retry_attempted` in catalog + standalone validators + TS types + `LoggedEvent` union (B2).
- DELETE: every emit-site call for the four old kinds in [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts) at L329, L334-L335, L399-L400, L410-L411, L416-L418 (B2).
- DELETE: every test asserting emission of the four old kinds (B2).
- VERIFY: `grep -rn "'model_selected'\|'invocation_succeeded'\|'invocation_failed'\|'retry_attempted'" src/ tests/ web/src/` returns ZERO matches after B3.
- VERIFY: `grep -rn "as z.AnyZodObject" src/schemas/` returns ZERO matches after B1 (proves the `ZodEffects.shape` re-extraction is gone).
- NO compat: no dual-emit, no alias, no `model_selected → llm_attempt` translator.

### 3.2 Cross-batch invariants

- After B1: `EventRegistry[kind]` always exposes a raw `baseShape`; `buildLoggedEventSchema` never reads `.shape` off any composed schema. The summary refinement is enforceable through both the catalog and the standalone validator paths because they consume the same `baseShape`/`refine` pair.
- After B2: every agent-domain line in `runtime/events.jsonl` is one of `session_started`, `llm_attempt`, `llm_invocation_summary`, `compaction_triggered`, `self_check_triggered`, `model_issue`, `session_cancelled`, `session_force_cancelled`, `mcp_tool_invocation`.
- After B2: for each HTTP call from `AgentAdapter.invokeAgent`, EXACTLY ONE `llm_attempt` row exists. `attemptOutcomeCount === count(llm_attempt rows for this invocation) === llm_invocation_summary.attempts_count`. Tested directly via the 3-failover and mixed-flow tests.
- After B3: a single role invocation is renderable from exactly one `llm_invocation_summary` + N consecutive `llm_attempt` rows, no cross-event JOIN at render time.
- After B4: it is a structural (Zod-strict + refinement) AND static (AST) error to emit an undeclared field on `llm_attempt` or `llm_invocation_summary`, OR to emit a summary whose verdict/final-field combination is invalid.

---

## 4. F-closure

**Closes F04.** Level-up replaces four thin, drifted event kinds with one typed-discriminated-union `llm_attempt` plus one per-invocation `llm_invocation_summary`. The r2-review blockers are closed: (1) the registry now stores `baseShape` and `refine` separately so `buildLoggedEventSchema` composes `z.object(...).strict().superRefine(...)` without ever needing `.shape` from a `ZodEffects` — and `loggedEventSchemaByKind.llm_invocation_summary` plus `validators.llmInvocationSummaryEventSchema` carry the refinement identically, asserted by B1 tests; (2) `llm_invocation_summary.attempts_count` is sourced from `attemptOutcomeCount`, a counter incremented inside `recordAttemptOutcome` itself, so it equals the number of emitted `llm_attempt` rows even when one outer `invokeWithRecovery` iteration produces multiple inner candidate HTTP calls — asserted by the dedicated 3-failover test in B2. The schema-vs-emitter drift class is closed end to end by B1 (strict catalog helper + strict `buildLoggedEventSchema` branch + strict standalone validators) and reinforced by B4 (structural assertion + AST guard). The retry/failure double-emission bug is closed by B2's single `recordAttemptOutcome` boundary. Cross-link to F05: `terminal_tool` lives on `outcome[succeeded]` of `llm_attempt` and `final_terminal_tool` on `llm_invocation_summary`; F05's batch that adds this field collapses to a single line under the unified envelope. F03 (cooldown observability) and F08 (failure-class expansion) both consume `outcome[failed]` — adding a `failure_class` enum value or a `cooldown_ms` field is a one-line strict-schema edit.
