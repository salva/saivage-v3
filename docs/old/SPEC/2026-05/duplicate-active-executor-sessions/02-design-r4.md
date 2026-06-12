# Design r2 — Reconcile orphaned worker session manifests at startup

Companion to [01-analysis-r3.md](saivage-v3/SPEC/2026-05/duplicate-active-executor-sessions/01-analysis-r3.md). Subject to the workspace rule **architecture-first, no backward compatibility**: no shims, no aliases, no dual systems. Dead code is deleted, not repurposed in place.

## Changes from r1

Addresses the six items from the r1 review:

1. **`_dispatchInFlight` is no longer deleted.** It is the planner-level (`goalId`) re-entrancy guard for `dispatchGoal`; the new worker-level precondition is at a different layer and does not subsume it. Kept as-is, with a clarifying comment.
2. **Shutdown semantics unchanged** as a consequence of (1). The `for (const cardId of this._dispatchInFlight) ...` cancellation at [runtime.ts:578](saivage-v3/src/runtime/runtime.ts#L578) (stopProject) and the shutdown prelude at [runtime.ts:612](saivage-v3/src/runtime/runtime.ts#L612) stay.
3. **Dispatch precondition is placed atomically with `createSession`**: it executes synchronously immediately before `createSession` at [agent-adapter.ts:447](saivage-v3/src/agents/agent-adapter.ts#L447), with **no awaits** between the precondition call and `createSession`. This rules out the interleaving the reviewer flagged.
4. **Open choice 5 rationale corrected.** The sweep marks old manifests `failed`; on the next tick the precondition sees no conflict and a new manifest is correctly created. This is **intended**: the old session is dead, work may be retried. Rationale rewritten.
5. **Event kind `startup_session_sweep` is added to the EventRegistry** ([src/events/registry.ts](saivage-v3/src/events/registry.ts#L15)) as part of this change, with payload schema `{ swept_session_ids: string[] }`.
6. **Test file references fixed.** Two new integration tests are created: a startup-sweep test under `tests/runtime/` and a dispatch-precondition test under `tests/agents/` (the latter follows the [agent-adapter-executor-fallback.test.ts](saivage-v3/tests/agents/agent-adapter-executor-fallback.test.ts) pattern for constructing a real `AgentAdapter`, not a `FakeAgentAdapter` substitution). The new projection test goes through the fastify HTTP handler the way other route tests do (see [tests/api/](saivage-v3/tests/api/)) instead of calling the unexported `buildListedAgentSession`.

## 1. Problem recap

After a service restart, every worker session (executor, reviewer) whose process was killed mid-invocation remains `status: "active"` in its `agents/sessions/<id>.json` manifest forever. The next process mints a new manifest for the same card, so `/api/agents` accumulates phantom active workers (analysis §1: 3 active executors, two on `G1.5.C1`). Root causes per analysis §6: **R1** the existing reconciler [failActiveWorkerSessions](saivage-v3/src/agents/session-persistence.ts#L167-L179) is dead code; **R2** [repairStartupActiveCardRun](saivage-v3/src/runtime/runtime.ts#L281-L324) never mutates a worker manifest; **R4** dispatch has no precondition guarding against a pre-existing active manifest for the same `(role, card_id)`.

## 2. Goals and non-goals

**Goals.**

- After any restart, every worker session manifest left `active`/`waiting` by a dead process is reconciled before the runtime starts dispatching.
- A single invariant is enforced: at any instant, for every `(role, card_id)` with `role ∈ {executor, reviewer}`, at most one manifest is non-terminal. The startup sweep restores it; the dispatch precondition preserves it.
- The two-store divergence shrinks: the worker session manifest is the canonical "is this agent running?" projection (analysis §9).
- Dead code (`failActiveWorkerSessions` and its test) is removed.

**Non-goals.**

- Refactoring [agent-adapter.invokeAgent](saivage-v3/src/agents/agent-adapter.ts#L421) (analysis §10).
- Compaction-in-flight crash safety (analysis §7.3, §10).
- The `'claimed'` literal vs. `RuntimeActivationStatus` schema mismatch (analysis §10).
- Changing UI / API rendering of session status (analysis §10).
- Touching analyst sessions (analysis §7.4).
- Eliminating the in-process `_dispatchInFlight` planner-level re-entrancy guard. It is at a different layer and is not parallel to the manifest store.

## 3. Alternative proposals

### Proposal A — Startup sweep only (minimal)

**Scope.** Replace [failActiveWorkerSessions](saivage-v3/src/agents/session-persistence.ts#L167-L179) with `reconcileOrphanedWorkerSessions(saivageDir)` in `session-persistence.ts`. Wire it into [Runtime.startup](saivage-v3/src/runtime/runtime.ts#L596-L611) after [performCrashRecovery](saivage-v3/src/runtime/runtime.ts#L617) and before [repairStartupActiveCardRun](saivage-v3/src/runtime/runtime.ts#L281-L324).

**On-disk semantics.** Every non-analyst, non-planner session whose manifest status is `active` or `waiting` at startup is transitioned to `failed`; one `model_issue` system message is appended.

**Code shape.** Pure function over the filesystem; no Runtime coupling. No precondition at dispatch.

**Trade-offs.** Fixes the observed bug. Does **not** close R4: a same-process double `invokeExecutor` for the same card (a future bug or a fast supervisor + retry interaction) would still mint two `active` manifests.

### Proposal B — Startup sweep + atomic dispatch precondition (selected)

**Scope.** Proposal A, plus a precondition `assertNoActiveWorkerSession(saivageDir, role, cardId)` called from [invokeAgent](saivage-v3/src/agents/agent-adapter.ts#L421) **immediately before** [createSession](saivage-v3/src/agents/agent-adapter.ts#L447), with no awaits in between. The precondition reads the manifest store and throws `DuplicateActiveSessionError` on conflict. The in-process `_dispatchInFlight` planner-level guard is left in place (it operates at a different layer).

**On-disk semantics.** Same as A. Adds an invariant: at any instant, for every `(role, card_id)` with `role ∈ {executor, reviewer}`, at most one manifest is non-terminal.

**Code shape.** One new exported function for the sweep, one new exported function for the precondition, one new error class, one new call at the head of `Runtime.startup`, one new call right before `createSession` inside `invokeAgent`. One new entry in `EventRegistry`.

**Trade-offs.** Eliminates R1, R2 (for worker manifests), and R4 in one coherent invariant. Adds one directory listing + per-file parse per worker invocation; cost is negligible vs. an LLM round-trip and bounded by project session-file count.

### Proposal C — Project the session view from `runtime-state.json` (collapse the two stores)

**Scope.** Stop persisting `status` on the session manifest. Derive each session's status from `runtime-state.json` (`current_agent_session_id`, `runtime_runs`, `runtime_activations`) and `completed_at`. [/api/agents](saivage-v3/src/server/routes/runtime-config-notes.ts#L77-L88) becomes a pure projection.

**On-disk semantics.** The `status` field is removed from `AgentSession`. [sessionStatusSchema](saivage-v3/src/schemas/validators.ts#L39) deleted. Manifests carry only invariant identity + `completed_at`.

**Trade-offs.** Most architecturally clean: kills the divergence at its source. But it is a deep refactor across the agent adapter, persistence, server routes, web UI, and tests — far beyond this bug. Analysis §9 explicitly designates the session manifest as canonical for this fix. Proposal C is the long-term direction; not the right scope here.

## 4. Selected proposal and reasoning

**Selected: Proposal B.**

- Architecture-first: §6.1 (R1) calls `failActiveWorkerSessions` dead code; replace, don't wire. ✓
- §6.4 (R4) is real even though secondary today: a startup-only sweep (A) leaves the invariant unenforced during steady-state. Proposal B makes it an enforced invariant, not a one-shot repair. ✓
- §6.3 (R3): `_dispatchInFlight` is **not** a parallel system to the worker manifest store — it gates `dispatchGoal(goalId)` at the planner layer (preventing the same goal-card's planner from being re-entered), while the new precondition gates worker session creation at the `(role, cardId)` layer. Both layers are needed; keep `_dispatchInFlight`. The architecture-first concern is "two systems claiming the same fact", which doesn't apply here.
- Proposal C is correct but out of scope; analysis §9 names the manifest as canonical for this fix.

## 5. Detailed specification

### 5.1 New module surface (requirement E)

All new symbols live in [src/agents/session-persistence.ts](saivage-v3/src/agents/session-persistence.ts), beside the rest of session manifest I/O. No new file.

```ts
// In src/agents/session-persistence.ts

/**
 * Worker roles whose session manifests must be reconciled at startup
 * and gated at dispatch. Analyst sessions are intentionally excluded
 * (long-lived operator chats, analysis §7.4). Planner sessions are
 * excluded because they use deterministic IDs (`planner:<cardId>`,
 * [createSession](#L70-L78)) and are overwritten in place by
 * writeFileAtomic on the next invocation (analysis §7.2).
 */
const WORKER_ROLES: ReadonlyArray<AgentRole> = ['executor', 'reviewer'];

/**
 * Raised by `assertNoActiveWorkerSession` when a non-terminal manifest
 * already exists for the given (role, cardId).
 */
export class DuplicateActiveSessionError extends Error {
  constructor(public readonly role: AgentRole, public readonly cardId: string, public readonly existingSessionId: string) {
    super(`Duplicate ${role} session for card ${cardId}: existing session ${existingSessionId} is still ${'active|waiting'}.`);
    this.name = 'DuplicateActiveSessionError';
  }
}

/**
 * Reconcile every worker session manifest left in a non-terminal state
 * by a previous runtime process. Each swept session is transitioned to
 * `failed` and one `model_issue` system message is appended.
 *
 * Idempotent: running it twice on the same on-disk state returns []
 * the second time.
 *
 * Returns the swept sessions for logging.
 */
export function reconcileOrphanedWorkerSessions(
  saivageDir: string,
  reason = 'Session was left active by a previous runtime process; reconciled at startup.',
): AgentSession[];

/**
 * Dispatch precondition. Throws DuplicateActiveSessionError if any
 * session manifest already has status ∈ {active, waiting} for the
 * given (role, cardId). Must be called synchronously immediately
 * before `createSession`, with no awaits in between, so that two
 * concurrent invocations within the same process cannot both pass.
 *
 * Worker roles only; never called for analyst or planner.
 */
export function assertNoActiveWorkerSession(
  saivageDir: string,
  role: AgentRole,
  cardId: string,
): void;
```

Implementation outline:

- `reconcileOrphanedWorkerSessions` iterates [listSessions](saivage-v3/src/agents/session-persistence.ts#L296) → [getSession](saivage-v3/src/agents/session-persistence.ts#L94), keeps those with `role ∈ WORKER_ROLES && status ∈ {active, waiting}`, calls [completeSession](saivage-v3/src/agents/session-persistence.ts#L113-L135) with `'failed'`, then calls [appendMessage](saivage-v3/src/agents/session-persistence.ts#L209) with `{role: 'system', kind: 'model_issue', content: reason}`.
- `assertNoActiveWorkerSession` iterates the same listing, throws on the first match. (A directory scan, not an in-memory cache — there is no shared state to keep in sync.)

### 5.2 Caller wiring

**Startup sweep call site (requirement A).** In [Runtime.startup](saivage-v3/src/runtime/runtime.ts#L596-L611), immediately after `acquireLock` and `performCrashRecovery`, before `reconcileProcessRecords` and `repairStartupActiveCardRun`:

```ts
acquireLock(this.projectRoot);
await this.performCrashRecovery();
const swept = reconcileOrphanedWorkerSessions(join(this.projectRoot, '.saivage'));
if (swept.length > 0) {
  this._eventLogger.appendEvent({
    kind: 'startup_session_sweep',
    swept_session_ids: swept.map((s) => s.id),
  });
}
reconcileProcessRecords(this.projectRoot);
```

Justification: `acquireLock` is exclusive, so no concurrent writer exists; `performCrashRecovery` is the "fix everything stale on disk" phase, and the sweep belongs to that phase. Inserting it before `acquireLock` would race; inserting it after `repairStartupActiveCardRun` would mean `repairStartupActiveCardRun`'s `appendChildUnwindToolResult` runs against manifests that are about to be marked `failed` — works, but reads less cleanly. The codebase uses `join(this.projectRoot, '.saivage')` inline (e.g. [runtime.ts:168](saivage-v3/src/runtime/runtime.ts#L168), [runtime.ts:216](saivage-v3/src/runtime/runtime.ts#L216), [runtime.ts:265](saivage-v3/src/runtime/runtime.ts#L265)); no `saivageDirOf` helper is introduced.

[active-runtime.ts](saivage-v3/src/runtime/active-runtime.ts#L128-L131) delegates to `Runtime.startup`; no second wiring needed.

**Dispatch precondition call site (requirement C, reviewer item 3).** Inside [invokeAgent](saivage-v3/src/agents/agent-adapter.ts#L421-L447). The body currently is (paraphrased):

```ts
// line 433
const candidates = await this.router.resolve(role, capabilityRequest);
if (candidates.length === 0) { … throw … }
// line 447
const session = createSession(this.saivageDir, role, goalId, cardId, …);
```

Place the precondition **synchronously between line 446 and 447** (no `await` between them):

```ts
const candidates = await this.router.resolve(role, capabilityRequest);
if (candidates.length === 0) { … throw … }
if (role === 'executor' || role === 'reviewer') {
  assertNoActiveWorkerSession(this.saivageDir, role, cardId);
}
const session = createSession(this.saivageDir, role, goalId, cardId, undefined, requestedSessionId);
```

Because Node.js cannot preempt synchronous code between two statements, two concurrent `invokeAgent` calls in the same process cannot both pass the precondition before either reaches `createSession`. The first call's `createSession` writes the new manifest atomically (via [writeFileAtomic](saivage-v3/src/persistence/file-tree.ts#L12-L18)); when the second call eventually resumes after its own `await this.router.resolve` and reaches the precondition, it will see the manifest the first call wrote and throw.

The exception path is the existing `catch` in [dispatchPendingActivations](saivage-v3/src/runtime/runtime.ts#L748-L749) which already calls `emitRuntimeDiagnostic` and transitions the card to `failed`; no additional handling required.

Analyst sessions: `role === 'analyst'` is not in `WORKER_ROLES`; the precondition is gated on `role === 'executor' || role === 'reviewer'` so analyst invocation paths are untouched.

Planner sessions: `role === 'planner'` is also not gated. Planner uses deterministic ids, and `createSession` overwrites `planner:<cardId>` via `writeFileAtomic` (analysis §7.2). Sweeping them at startup would mark `failed` planners that the next tick legitimately resumes; precondition would falsely block legitimate planner resumption since the previous file is `active`.

### 5.3 `_dispatchInFlight` is kept (reviewer item 1 & 2)

Per the r1 review, `_dispatchInFlight` is the planner-level (`goalId`) in-process re-entrancy guard for `dispatchGoal`, used at:

- Field decl: [runtime.ts:101](saivage-v3/src/runtime/runtime.ts#L101).
- Stop-project cancellation: [runtime.ts:578](saivage-v3/src/runtime/runtime.ts#L578).
- Shutdown prelude: [runtime.ts:612](saivage-v3/src/runtime/runtime.ts#L612).
- Guard / track: [runtime.ts:618-620](saivage-v3/src/runtime/runtime.ts#L618-L620), [L715](saivage-v3/src/runtime/runtime.ts#L715).

The new worker-level precondition operates at a different layer (`(role, cardId)`, manifest-store-backed, durable). The two are orthogonal: `_dispatchInFlight` prevents `dispatchGoal(G)` from being re-entered while it is running in *this* process; `assertNoActiveWorkerSession` prevents a second worker manifest for the same `(role, cardId)` regardless of process. Both guards remain.

A one-line comment is added above the field declaration:

```ts
/** Planner-level in-process re-entrancy guard for dispatchGoal(goalId).
 *  NOT a worker-session uniqueness guard — that role belongs to the
 *  manifest store via assertNoActiveWorkerSession. */
private _dispatchInFlight = new Set<string>();
```

### 5.4 System message text and kind (requirement D)

`kind: 'model_issue'` per [MessageKind](saivage-v3/src/schemas/types.ts#L78). `role: 'system'`. Content (single line):

> `Session was left active by a previous runtime process; reconciled at startup. Status set to 'failed' so the agent list reflects reality.`

This is the function's default `reason` argument; tests may override.

### 5.5 New event registry entry (reviewer item 5)

In [src/events/registry.ts](saivage-v3/src/events/registry.ts#L15) add one entry to `EventRegistry`:

```ts
startup_session_sweep: {
  domain: 'runtime',
  schema: payload({ swept_session_ids: z.array(z.string()) }),
  severity: 'warning',
  tracked: true,
  audit: true,
  broadcast: true,
  outbound: 'operator',
},
```

Severity is `warning`, not `info`: a non-empty sweep means the previous process did not shut down cleanly. Placement: after `runtime_fatal_error` and beside other recovery events. No removal of existing kinds.

### 5.6 Schema and type changes

**None on `AgentSession`.** [sessionStatusSchema](saivage-v3/src/schemas/validators.ts) and [SessionStatus](saivage-v3/src/schemas/types.ts#L75) unchanged. Open choice 1: reuse `failed`, do not add `abandoned`.

One addition to [EventRegistry](saivage-v3/src/events/registry.ts#L15) per §5.5.

### 5.7 Deletions (requirement G)

| File | Lines / symbols | Reason |
|---|---|---|
| [src/agents/session-persistence.ts](saivage-v3/src/agents/session-persistence.ts#L167-L187) | `failActiveWorkerSessions` (entire export, signature at L167–L170, body L171–L186, closing brace L187). | Dead code; replaced by `reconcileOrphanedWorkerSessions`. |
| [tests/agents/session-persistence.test.ts](saivage-v3/tests/agents/session-persistence.test.ts) | Any existing `describe('failActiveWorkerSessions', …)` block (search-and-remove; no harm if absent). | Tests the deleted symbol. |

**`_dispatchInFlight` is no longer deleted** (reviewer item 1).

### 5.8 Open design choices — decisions

| # | Choice | Decision | One-line justification |
|---|---|---|---|
| 1 | `abandoned` status vs. reuse `failed`. | **Reuse `failed`.** | Architecture-first prefers no schema growth; system message records cause, status records terminal class; UI already handles `failed`. |
| 2 | Remove `_dispatchInFlight` vs. keep. | **Keep**, with clarifying comment. | Different layer (planner re-entrancy vs. worker uniqueness); not parallel; both needed (reviewer item 1). |
| 3 | R4 defence-in-depth: hard throw vs. fail-old-then-start-new. | **Hard throw (`DuplicateActiveSessionError`).** | After the startup sweep, a conflict at dispatch can only be a dispatcher bug; silently masking it would re-introduce R2. |
| 4 | Sweep scope: workers only vs. include planner. | **Workers only (`executor`, `reviewer`).** | Planner IDs are deterministic; `writeFileAtomic` overwrites them; sweeping would mark `failed` planners the next tick legitimately resumes. |
| 5 | Defensively reconcile `runtime_activations` rows. | **No.** | After the sweep, an unresolved pending activation will cause a *new* executor invocation on the next tick; the new precondition sees no `active` manifest (the orphan is now `failed`) so a fresh session is correctly created. This is intended: the dead session is buried, work is retried. (Reviewer item 4 — rationale corrected.) |

## 6. Risk analysis

| Risk | Likelihood | Mitigation | Residual |
|---|---|---|---|
| Sweep marks a *legitimate* in-process session `failed` after a crash-then-fast-restart where the OS hasn't released the lock yet. | None — `acquireLock` is exclusive (analysis §5). | n/a | n/a |
| Sweep slow on projects with thousands of session files. | Low: existing `/api/agents` listing already scans `listSessions`; cost is comparable. | If observed, add an index file (out of scope). | Accept. |
| Dispatch precondition throws on a card whose previous executor crashed during the same process (no startup happened). | Real but desirable: this is exactly the future regression we want surfaced. | Caught by the existing `catch` in [dispatchPendingActivations](saivage-v3/src/runtime/runtime.ts#L748-L749); card is failed, parent unwound. | Accept. |
| `assertNoActiveWorkerSession` races with concurrent `createSession`. | Impossible by construction: no `await` between precondition and `createSession`; Node.js cannot preempt synchronous code (reviewer item 3). | n/a | n/a |
| Removing `_dispatchInFlight` would break planner re-entrancy. | Not removing it (reviewer item 1). | n/a | n/a |
| New `startup_session_sweep` event broadcasts to operators on every dirty restart. | Intended: operators want to know. Severity `warning` puts it in the right channel. | n/a | Accept. |

## 7. Testing strategy (requirement F)

### Unit tests — extend [tests/agents/session-persistence.test.ts](saivage-v3/tests/agents/session-persistence.test.ts)

- `reconcileOrphanedWorkerSessions`:
  - Marks `active` and `waiting` executor and reviewer sessions `failed`; appends exactly one `model_issue` system message with the default reason.
  - Leaves `analyst` and `planner` manifests untouched regardless of status.
  - Leaves already-terminal sessions (`done`, `failed`, `blocked`) untouched.
  - Idempotent: a second call returns `[]` and writes no new messages.
- `assertNoActiveWorkerSession`:
  - Throws `DuplicateActiveSessionError` when a matching `active` manifest exists; the error carries `existingSessionId`.
  - Throws when a matching `waiting` manifest exists.
  - Returns silently when only terminal manifests exist for the `(role, cardId)`.
  - Returns silently when an `active` manifest exists for a *different* `cardId` or a *different* `role`.
  - Never matches `analyst` or `planner` even when their manifests are `active`.

### Integration test — new [tests/runtime/startup-session-sweep.test.ts](saivage-v3/tests/runtime/startup-session-sweep.test.ts)

- Arrange a project tree with the existing test harness used by [tests/runtime/f23-dispatch-goal-acceptance.test.ts](saivage-v3/tests/runtime/f23-dispatch-goal-acceptance.test.ts#L37-L55) (which calls `initProjectTree`, constructs `Runtime`, and invokes `startup`). Pre-write three executor manifests under `.saivage/agents/sessions/`: statuses `active`, `waiting`, `done`. Construct a `Runtime`, call `startup`.
- Assert:
  - The two non-terminal manifests now have `status: 'failed'` and a `completed_at`.
  - Each has one new `model_issue` system message.
  - The `done` manifest is byte-identical to before.
  - One `startup_session_sweep` event was logged with the two swept ids.
- Assert via HTTP (reviewer item 6): build a fastify instance with the route registered (mirror the pattern in [tests/api/](saivage-v3/tests/api/)), `GET /api/agents`, expect both swept sessions reported with `status: 'failed'`. Do **not** call the unexported `buildListedAgentSession` directly.

### Integration test — new [tests/agents/agent-adapter-dispatch-precondition.test.ts](saivage-v3/tests/agents/agent-adapter-dispatch-precondition.test.ts)

Lives next to the other `agent-adapter-*.test.ts` files; mirrors the construction pattern in [tests/agents/agent-adapter-executor-fallback.test.ts](saivage-v3/tests/agents/agent-adapter-executor-fallback.test.ts) (real `AgentAdapter`, real router with a recording/stub LLM transport — *not* `FakeAgentAdapter`, which is a separate `AgentRuntime` implementation at [src/agents/fake-agent.ts](saivage-v3/src/agents/fake-agent.ts#L57) and is not accepted by [AgentAdapterConfig](saivage-v3/src/agents/agent-adapter.ts#L42)).

- Arrange: pre-seed an `active` executor manifest for `(executor, card-X)` directly on disk via `createSession` + manifest write. Construct the real `AgentAdapter` per the fallback-test template, with the stub LLM transport. Call `invokeExecutor('card-X', 'goal-Y', …)`.
- Assert: rejects with `DuplicateActiveSessionError`; no second manifest file for `card-X` was created; the stub LLM transport recorded zero invocations (proving the precondition fired before any model call).
- Repeat for `invokeReviewer` with the reviewer role.
- Negative case: with no pre-seeded manifest, the invocation proceeds normally (stub transport receives one call).

### End-to-end manual check on `saivage-v3-getrich-v2` (10.0.3.170)

1. Before restart: `curl http://10.0.3.170:8080/api/agents | jq '[.sessions[] | select(.status=="active" and .role=="executor")] | length'` — observe 3.
2. Deploy the change, restart `saivage-v3-getrich.service` via `ssh root@10.0.3.170`.
3. After restart: same `curl`, expect 0 before any new dispatch starts.
4. Tail `.saivage/runtime/events.jsonl` for `kind: "startup_session_sweep"` with the three known orphan session ids from analysis §1.

## 8. Migration

**None.** Per the architecture-first rule, no migration shim, no compatibility code, no schema bump. Existing on-disk orphaned manifests in deployed projects (`getrich-v2`, etc.) will be cleaned by the new startup sweep automatically on first restart. The three sessions from analysis §1 (`executor-1779816409491-4`, `executor-1779818547816-11`, `executor-1779818999226-2`) will be transitioned to `failed` in that order.

## 9. Files touched / created / deleted

**Touched.**

- [src/agents/session-persistence.ts](saivage-v3/src/agents/session-persistence.ts) — add `WORKER_ROLES`, `DuplicateActiveSessionError`, `reconcileOrphanedWorkerSessions`, `assertNoActiveWorkerSession`; remove `failActiveWorkerSessions`.
- [src/agents/agent-adapter.ts](saivage-v3/src/agents/agent-adapter.ts) — import `assertNoActiveWorkerSession`; call it synchronously between candidate resolution and `createSession` inside [invokeAgent](saivage-v3/src/agents/agent-adapter.ts#L421-L447) for `role ∈ {executor, reviewer}`.
- [src/runtime/runtime.ts](saivage-v3/src/runtime/runtime.ts) — import `reconcileOrphanedWorkerSessions`; call it in [startup](saivage-v3/src/runtime/runtime.ts#L596-L611) after `performCrashRecovery`; add comment above `_dispatchInFlight` field declaration. Do **not** delete `_dispatchInFlight`.
- [src/events/registry.ts](saivage-v3/src/events/registry.ts#L15) — add the `startup_session_sweep` event kind.
- [tests/agents/session-persistence.test.ts](saivage-v3/tests/agents/session-persistence.test.ts) — replace any `failActiveWorkerSessions` block with the new unit tests.

**Created.**

- [tests/runtime/startup-session-sweep.test.ts](saivage-v3/tests/runtime/startup-session-sweep.test.ts).
- [tests/agents/agent-adapter-dispatch-precondition.test.ts](saivage-v3/tests/agents/agent-adapter-dispatch-precondition.test.ts).

**Deleted.**

- Symbol `failActiveWorkerSessions` in [src/agents/session-persistence.ts](saivage-v3/src/agents/session-persistence.ts#L167-L187).
- Any existing `describe('failActiveWorkerSessions', …)` block in [tests/agents/session-persistence.test.ts](saivage-v3/tests/agents/session-persistence.test.ts).

No new modules, no schema changes to `AgentSession`, no on-disk format changes.
