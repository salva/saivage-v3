# Design — Replace per-`(role, cardId)` worker uniqueness with the global single-active-non-analyst-session invariant

Binding workspace rule: **architecture-first, no backward compatibility**. No shims, no aliases, no dual systems. The currently-shipped worker-uniqueness surface is deleted in the same change that introduces the global agent-uniqueness surface.

## 1. Problem recap

The currently-shipped startup-sweep + dispatch-precondition pair (in [src/agents/session-persistence.ts](saivage-v3/src/agents/session-persistence.ts) and [src/agents/agent-adapter.ts](saivage-v3/src/agents/agent-adapter.ts), wired in at [src/runtime/runtime.ts L603](saivage-v3/src/runtime/runtime.ts#L603)) encodes the wrong invariant: it gates uniqueness per `(role, cardId)` for `role ∈ {executor, reviewer}` and sweeps `'active'` *and* `'waiting'` worker manifests. The architectural invariant is global and call-stack-shaped: **at any instant at most one non-analyst session has `status: 'active'`**, planners included; `'waiting'` is the legitimate suspended-call-frame state for the planner and must be preserved across restarts; `'active'` workers and `'active'` planners are both orphan classes when their JS frame is gone. This design replaces the misencoded surface with one that matches the real architecture, deletes the old names, and rewrites the tests written against the wrong invariant.

## 2. Goals and non-goals

**Goals.**

- C1. Startup sweep reconciles every non-analyst session manifest whose status is `'active'` at process start; does **not** touch `'waiting'`.
- C2. Dispatch precondition throws whenever any non-analyst session anywhere in the project already has `status: 'active'` and a new non-analyst session is about to be created. Planner deterministic-ID re-entry from `'waiting'` must pass.
- C3. Precondition is evaluated synchronously immediately before [`createSession`](saivage-v3/src/agents/session-persistence.ts#L69), with no intervening `await`.
- C4. Analyst sessions are excluded from sweep and from precondition.
- C5. The misnamed surface is **removed** in this change (no alias, no parallel system): `WORKER_ROLES`, `NON_TERMINAL_SESSION_STATUSES`, `reconcileOrphanedWorkerSessions`, `assertNoActiveWorkerSession`, `DuplicateActiveSessionError`, the worker-only gating at the call site, and the tests written against the worker-uniqueness predicate.
- C6. No on-disk schema change to `AgentSession`; `SessionStatus` enum unchanged.
- C7. `_dispatchInFlight` is preserved and **not** renamed.
- C8. The three orphan executors observed on `saivage-v3-getrich-v2` remain cleaned.
- C9. Tests written against the worker-uniqueness invariant are rewritten or removed, not kept.

**Non-goals.**

- Refactoring `current_agent_session_id` to be *derived* from the manifest store (or vice versa). This change only *reconciles* the singleton when sweep fires; the deeper unification is a future change.
- Adding assertions on every `current_agent_session_id` write site.
- Compaction-in-flight crash safety.
- Anything in `web/` or analyst code paths.
- Migrating on-disk session manifests.
- Changing `_dispatchInFlight` semantics or scope.
- Reverting the existing deletion of `failActiveWorkerSessions`.

## 3. Alternative proposals

### Proposal A — Minimal correction (in-place rename, broaden predicates)

**Scope.** Keep both call sites (startup wiring and `invokeAgent` precondition). In [session-persistence.ts](saivage-v3/src/agents/session-persistence.ts):

- Delete `WORKER_ROLES` and `NON_TERMINAL_SESSION_STATUSES` constants.
- Rename `reconcileOrphanedWorkerSessions` → `reconcileOrphanedAgentSessions`; change predicate from `role ∈ WORKER_ROLES && status ∈ {active, waiting}` to `role !== 'analyst' && status === 'active'`.
- Rename `assertNoActiveWorkerSession(saivageDir, role, cardId)` → `assertNoActiveAgentSession(saivageDir, role)`; drop the `cardId` parameter; change predicate from "same `(role, cardId)` is non-terminal" to "any non-analyst session anywhere is `'active'`". Skip the check entirely when the new session itself is analyst.
- Rename `DuplicateActiveSessionError` → `ConcurrentAgentSessionError`; payload becomes `{ newRole, conflictingSessionId, conflictingRole, conflictingCardId }`.

At the call site in [agent-adapter.ts:273](saivage-v3/src/agents/agent-adapter.ts#L273): change `assertNoActiveWorkerSession(this.saivageDir, role, cardId)` to `assertNoActiveAgentSession(this.saivageDir, role)`; remove the worker-only gating (the function gates itself on `role !== 'analyst'`). No new `await`.

Sweep wiring at [runtime.ts:603](saivage-v3/src/runtime/runtime.ts#L603) is updated to the renamed function. The `startup_session_sweep` event kind is kept verbatim (its payload `{ swept_session_ids: string[] }` is invariant-agnostic).

**On-disk semantics.** Every non-analyst manifest with `status === 'active'` at startup → `failed` + one `model_issue` system message. `'waiting'` planners are left alone (legitimate suspended call frame).

**Trade-offs.** Smallest surface change. Singleton `current_agent_session_id` may briefly point at a session the sweep just marked `failed`; the next `session_started` write overwrites it. The window is restricted to the time between startup and the first dispatch.

### Proposal B — A, plus reconcile `current_agent_session_id` on sweep

**Scope.** Proposal A, plus: after the sweep runs, if the runtime-state singleton `current_agent_session_id` (persisted at [.saivage/tmp/state/runtime.json](saivage-v3/src/runtime/state.ts#L28-L29)) is in the swept set, set it to `null` via [`updateRuntimeState`](saivage-v3/src/runtime/state.ts#L142). The write goes through the same atomic-write path the runtime already uses.

**On-disk semantics.** Same as A, plus the singleton is consistent with the manifest store the moment `Runtime.startup` returns — no transient window in which the singleton points at a `'failed'` manifest.

**Trade-offs.** One extra `readRuntimeState` + conditional `updateRuntimeState` inside `Runtime.startup`. Trivial cost. Architecturally, this is the natural closure of the sweep: the singleton is the in-memory mirror of "the active non-analyst session", and the sweep just declared that there is none. Analysis §8 designates "deriving the singleton from the manifest store" as out of scope, but reconciling the singleton at the same moment the manifests are reconciled is not deriving — it's restoring agreement between two existing stores that the operator expects to agree.

### Proposal C — Bigger refactor (mentioned per requirement, out of scope)

Derive "is there an active non-analyst agent?" purely from the manifest store; remove `current_agent_session_id` write paths from `runtime-state.json`; have `/api/agents` and the state machine both read the manifest store directly. The two stores collapse into one source of truth. This is the architecturally cleanest endpoint but it is a deep refactor across the agent adapter, runtime, server routes, web UI, and tests. Analysis §8 explicitly designates this as a future cycle.

## 4. Selected proposal and reasoning

**Selected: Proposal B.**

- Both A and B satisfy C1–C9. C is out of scope per analysis §8.
- B closes the only remaining inconsistency that A leaves on the table (the singleton briefly disagreeing with the swept manifests), at the cost of one extra `updateRuntimeState` call. That is architecturally proper: the sweep just established a fact; the singleton is the in-memory cache of that fact; failing to update the cache is a defect, not a separate concern.
- Architecture-first (C5) demands deleting the old surface in the same change, which both A and B do.
- B does not introduce a new abstraction or a parallel system. The singleton already exists at [runtime.ts:680](saivage-v3/src/runtime/runtime.ts#L680), [L296, L308, L316, L322](saivage-v3/src/runtime/runtime.ts#L296), [shutdown:L619](saivage-v3/src/runtime/runtime.ts#L619); B only adds one consistent write at the time the sweep happens.
- B does **not** add assertions on every singleton write site (that is the out-of-scope tightening from analysis §8); it only restores agreement at the one moment the sweep declares the manifests authoritative.

## 5. Detailed specification

### 5.1 New module surface in [src/agents/session-persistence.ts](saivage-v3/src/agents/session-persistence.ts)

All new symbols live beside the existing session manifest I/O. No new file. The current constants and three exported names at L17–L18, L170–L175, L177–L195, L199–L213 are deleted (see §6).

```ts
// In src/agents/session-persistence.ts

/**
 * Raised by `assertNoActiveAgentSession` when any non-analyst session
 * manifest already has status 'active' at the moment a new non-analyst
 * session is about to be created.
 *
 * The error carries the new session's role plus the conflicting
 * session's id, role, and card_id so the dispatcher's catch path can
 * log a precise diagnostic.
 */
export class ConcurrentAgentSessionError extends Error {
  constructor(
    public readonly newRole: AgentRole,
    public readonly conflictingSessionId: string,
    public readonly conflictingRole: AgentRole,
    public readonly conflictingCardId: string | null,
  ) {
    super(
      `Cannot start ${newRole} session: a non-analyst session ` +
      `'${conflictingSessionId}' (role=${conflictingRole}, card_id=${conflictingCardId ?? 'null'}) ` +
      `already has status 'active'. At most one non-analyst session may be active at a time.`,
    );
    this.name = 'ConcurrentAgentSessionError';
  }
}

/**
 * Reconcile every non-analyst session manifest left in status 'active'
 * by a previous runtime process. Each swept session is transitioned to
 * 'failed' and one 'model_issue' system message is appended.
 *
 * Sessions with status 'waiting' are NOT swept: that is the legitimate
 * suspended-call-frame state for the planner under the call-stack
 * execution model (analysis §2.1, §2.2). The next dispatch tick will
 * re-invoke the planner, which overwrites the 'waiting' manifest with
 * a fresh 'active' one via deterministic-ID createSession.
 *
 * Analyst sessions are excluded entirely (long-lived operator chat
 * surface, analysis §2.6).
 *
 * Idempotent: a second call on the same on-disk state returns [].
 */
export function reconcileOrphanedAgentSessions(
  saivageDir: string,
  reason = 'Session was left active by a previous runtime process and was failed during startup reconciliation.',
): AgentSession[];

/**
 * Dispatch precondition. Throws ConcurrentAgentSessionError if any
 * non-analyst session manifest currently has status 'active'.
 *
 * MUST be called synchronously immediately before `createSession`,
 * with no awaits in between, so that two concurrent invocations within
 * the same process cannot both pass.
 *
 * The check is skipped when `newRole === 'analyst'`: analyst sessions
 * are not part of the planner→executor/reviewer call stack and are
 * permitted to run concurrently with one non-analyst session.
 *
 * Planner deterministic-ID re-entry passes by construction: the
 * previous manifest at `planner:<cardId>.json` is in status 'waiting'
 * (set by `markSessionWaiting` when the parent yielded), and 'waiting'
 * is not 'active' (analysis §2.1, §2.2).
 */
export function assertNoActiveAgentSession(
  saivageDir: string,
  newRole: AgentRole,
): void;
```

**Implementation notes.**

- `reconcileOrphanedAgentSessions` iterates [`listSessions(saivageDir)`](saivage-v3/src/agents/session-persistence.ts#L322), reads each via [`getSession`](saivage-v3/src/agents/session-persistence.ts#L96), keeps those with `session.role !== 'analyst' && session.status === 'active'`, calls [`completeSession(saivageDir, id, 'failed')`](saivage-v3/src/agents/session-persistence.ts#L116), then [`appendMessage(saivageDir, id, { role: 'system', kind: 'model_issue', content: reason })`](saivage-v3/src/agents/session-persistence.ts#L235). Returns the array of newly-failed sessions.
- `assertNoActiveAgentSession` returns immediately when `newRole === 'analyst'`. Otherwise it iterates `listSessions` and throws on the first session with `role !== 'analyst' && status === 'active'`. No card-id parameter, no role parameter for the conflicting side — the invariant is global.
- Neither function uses an in-memory cache. Cost: one directory scan + one JSON parse per existing session on each call. Bounded by the project's lifetime session count; comparable to the cost of the existing [`/api/agents`](saivage-v3/src/server/routes/runtime-config-notes.ts#L113) handler that already does the same scan on every request.

### 5.2 Caller wiring — Runtime startup

In [`Runtime.startup`](saivage-v3/src/runtime/runtime.ts#L597), the sweep is moved from its current position at [L603–L607](saivage-v3/src/runtime/runtime.ts#L603-L607) (between `performCrashRecovery` and `reconcileProcessRecords`) to immediately **after** [`repairStartupActiveCardRun`](saivage-v3/src/runtime/runtime.ts#L612) returns. The existing block at L603–L607 is deleted; the replacement is inserted after the `repairedState` assignment. The relevant region of `startup` becomes:

```ts
    acquireLock(this.projectRoot);
    await this.performCrashRecovery();
    reconcileProcessRecords(this.projectRoot);
    if (state.running_processes && state.running_processes.length > 0) { this.runningProcesses.clear(); }
    this._startupRepairPending = true;
    const repairedState = await this.repairStartupActiveCardRun(state);
    this._startupRepairPending = false;
    if (!repairedState) state = initRuntimeState(this.projectRoot); else state = repairedState;
    const swept = reconcileOrphanedAgentSessions(join(this.projectRoot, '.saivage'));
    if (swept.length > 0) {
      const sweptSessionIds = swept.map((session) => session.id);
      this.emit('startup_session_sweep', { swept_session_ids: sweptSessionIds });
      this._eventLogger.appendEvent({ kind: 'startup_session_sweep', swept_session_ids: sweptSessionIds });
      // Reconcile the runtime-state singleton with the just-swept manifest store.
      // If current_agent_session_id pointed at a session we just failed (including
      // one that repairStartupActiveCardRun re-pointed it at), clear it so the
      // singleton agrees with on-disk reality (analysis §2.5).
      const sweptSet = new Set(sweptSessionIds);
      const postRepairState = readRuntimeState(this.projectRoot);
      if (postRepairState && postRepairState.current_agent_session_id && sweptSet.has(postRepairState.current_agent_session_id)) {
        updateRuntimeState(this.projectRoot, { current_agent_session_id: null });
        state = readRuntimeState(this.projectRoot) ?? state;
      }
    }
```

The import at the top of `runtime.ts` becomes:

```ts
import { reconcileOrphanedAgentSessions } from '../agents/session-persistence.js';
```

(replacing the existing `reconcileOrphanedWorkerSessions` import). `readRuntimeState`/`updateRuntimeState` are already imported.

Justification for running the sweep **after** `repairStartupActiveCardRun`: `repairStartupActiveCardRun` writes `current_agent_session_id` back to `run.planner_session_id` at [runtime.ts L320–L323](saivage-v3/src/runtime/runtime.ts#L320-L323) based on the pre-sweep snapshot. If the sweep ran before repair, the singleton clear could be undone by repair. Running the sweep last lets it observe the freshly-repaired state, fail any non-analyst session that is still `'active'` after repair (including a planner session repair just re-pointed the singleton at), and reconcile the singleton by re-reading the post-repair state. `acquireLock` is exclusive, so no concurrent writer exists across the whole startup region.

### 5.3 Caller wiring — AgentAdapter dispatch precondition

In [agent-adapter.ts](saivage-v3/src/agents/agent-adapter.ts), the current call site at [L273](saivage-v3/src/agents/agent-adapter.ts#L273) reads:

```ts
    assertNoActiveWorkerSession(this.saivageDir, role as import('../schemas/types.js').AgentRole, cardId);
    const session = createSession(this.saivageDir, role as import('../schemas/types.js').AgentRole, goalId, cardId, undefined, requestedSessionId);
```

Replace with:

```ts
    assertNoActiveAgentSession(this.saivageDir, role as import('../schemas/types.js').AgentRole);
    const session = createSession(this.saivageDir, role as import('../schemas/types.js').AgentRole, goalId, cardId, undefined, requestedSessionId);
```

The named import at the top of the file changes from `assertNoActiveWorkerSession` to `assertNoActiveAgentSession`.

**Synchronous-with-no-await verification.** I read [agent-adapter.ts:258-280](saivage-v3/src/agents/agent-adapter.ts#L258-L280). The relevant lines are:

- L258: `const candidates = await this.router.resolve(role, capabilityRequest);` — the last `await` before the precondition.
- L260–L272: a guard block (`if (candidates.length === 0) { … throw … }`) that contains no `await`.
- L273: the precondition call (current `assertNoActiveWorkerSession`, becoming `assertNoActiveAgentSession`).
- L274: `const session = createSession(...)`.

There is no `await` between L258 and L274 other than as part of the guard's failure path, which `throw`s. The precondition and `createSession` are on adjacent synchronous lines. Node.js cannot preempt synchronous code, so two concurrent `invokeAgent` calls in this process cannot both pass the precondition before either reaches `createSession`. C3 is satisfied.

**No worker-only gating remains.** The previous design's worker-only gating lived *inside* `assertNoActiveWorkerSession` ([session-persistence.ts:204](saivage-v3/src/agents/session-persistence.ts#L204), `if (!WORKER_ROLES.has(role) || !cardId) return;`); the call site at [agent-adapter.ts:273](saivage-v3/src/agents/agent-adapter.ts#L273) was already unconditional. The corrective change deletes the internal worker gate and replaces it with a single internal analyst-exclusion (`if (newRole === 'analyst') return;`), so the call site remains a single unconditional line and the precondition now extends to planner invocations — part of the corrected invariant. Planner deterministic-ID re-entry from `'waiting'` is allowed by the predicate (`'waiting' !== 'active'`); a planner spawned on top of an already-`'active'` non-analyst session is flagged.

### 5.4 `_dispatchInFlight` stays, comment is updated

`_dispatchInFlight` is the goal-level (`goalId`) re-entrancy guard for `dispatchGoal`, kept verbatim per C7 and analysis §5. Its production sites are:

- Field declaration at [runtime.ts:102](saivage-v3/src/runtime/runtime.ts#L102) (the field itself plus an inline comment).
- Stop-project cancellation at [runtime.ts:579](saivage-v3/src/runtime/runtime.ts#L579).
- Shutdown prelude at [runtime.ts:619](saivage-v3/src/runtime/runtime.ts#L619).
- Re-entrancy guard and tracking at [runtime.ts:626-627](saivage-v3/src/runtime/runtime.ts#L626-L627).
- Cleanup at [runtime.ts:722](saivage-v3/src/runtime/runtime.ts#L722).

All five sites are unchanged. The inline comment on the field declaration currently reads:

> `Goal/planner re-entrancy guard; worker manifest uniqueness is enforced in session persistence.`

It is replaced by:

> `Goal-level re-entrancy guard for dispatchGoal(goalId); the global single-active-non-analyst-session invariant is enforced by assertNoActiveAgentSession in session persistence.`

This is a single-line edit, not a behavior change.

### 5.5 Event registry decision — keep `startup_session_sweep` verbatim

The event kind `startup_session_sweep` exists at [src/schemas/event-catalog.ts:35](saivage-v3/src/schemas/event-catalog.ts#L35) with payload schema `{ swept_session_ids: z.array(z.string()) }`. The schema is invariant-agnostic: it carries session ids, not any predicate. Renaming the kind would force a registry edit, an event-catalog edit, two emit-site edits in `runtime.ts`, and a test edit — all without changing what the event carries or what operators see. Architecture-first does not demand renaming a stable schema; it demands removing parallel systems. There is no parallel system here.

**Decision: keep `startup_session_sweep` as-is.** Severity stays `warning`. Payload stays `{ swept_session_ids: string[] }`.

### 5.6 System message text

`kind: 'model_issue'`, `role: 'system'`. Default reason argument (single line):

> `Session was left active by a previous runtime process and was failed during startup reconciliation. The runtime now enforces a global single-active-non-analyst-session invariant.`

Tests may pass a custom `reason` to assert it round-trips through `appendMessage`.

### 5.7 Schema and type changes

**None on `AgentSession`** (C6). [`sessionStatusSchema`](saivage-v3/src/schemas/validators.ts) and [`SessionStatus`](saivage-v3/src/schemas/types.ts) unchanged. [`current_agent_session_id`](saivage-v3/src/schemas/types.ts#L96) field shape unchanged. No new event kinds. No new fields in `RuntimeState`.

## 6. Deletions

The architecture-first rule (C5) requires every name belonging to the misencoded invariant to be removed in this change. Verified by `grep` (see §10 verification log):

| File | Lines | Symbol | Reason |
|---|---|---|---|
| [src/agents/session-persistence.ts](saivage-v3/src/agents/session-persistence.ts#L17) | L17 | `const WORKER_ROLES = new Set<AgentRole>(['executor', 'reviewer'])` | Encodes the wrong predicate. Verified consumers are only inside `session-persistence.ts` itself (L185, L204). |
| [src/agents/session-persistence.ts](saivage-v3/src/agents/session-persistence.ts#L18) | L18 | `const NON_TERMINAL_SESSION_STATUSES = new Set<SessionStatus>(['active', 'waiting'])` | Encodes the wrong predicate (the sweep must target `'active'` only; `'waiting'` is legitimate). Verified consumers are only inside `session-persistence.ts` itself (L185, L209). |
| [src/agents/session-persistence.ts](saivage-v3/src/agents/session-persistence.ts#L170-L175) | L170–L175 | `class DuplicateActiveSessionError` | Renamed to `ConcurrentAgentSessionError` with a new error message and payload shape. Old name and message text deleted. |
| [src/agents/session-persistence.ts](saivage-v3/src/agents/session-persistence.ts#L177-L195) | L177–L195 | `function reconcileOrphanedWorkerSessions` | Renamed to `reconcileOrphanedAgentSessions`; predicate changed (role: `!== 'analyst'`; status: `'active'` only). Old function deleted entirely. |
| [src/agents/session-persistence.ts](saivage-v3/src/agents/session-persistence.ts#L199-L213) | L199–L213 | `function assertNoActiveWorkerSession` | Renamed to `assertNoActiveAgentSession`; signature changes (drops `cardId`); predicate becomes global. Old function deleted entirely. |
| [src/agents/agent-adapter.ts](saivage-v3/src/agents/agent-adapter.ts#L273) | L273 | The call `assertNoActiveWorkerSession(this.saivageDir, role, cardId)` | Replaced one-line at the same position with the new global call (no signature change to the surrounding code; the call site was already unconditional). The deleted worker-only gate lived inside [session-persistence.ts:204](saivage-v3/src/agents/session-persistence.ts#L204), not at the call site. |
| [src/agents/agent-adapter.ts](saivage-v3/src/agents/agent-adapter.ts) imports | top of file | `assertNoActiveWorkerSession` named import | Replaced by `assertNoActiveAgentSession`. |
| [src/runtime/runtime.ts](saivage-v3/src/runtime/runtime.ts) imports | top of file | `reconcileOrphanedWorkerSessions` named import | Replaced by `reconcileOrphanedAgentSessions`. |
| [src/runtime/runtime.ts](saivage-v3/src/runtime/runtime.ts#L102) | L102 | Inline comment on `_dispatchInFlight` declaration | Updated text per §5.4. The field itself is untouched. |
| [tests/agents/session-persistence.test.ts](saivage-v3/tests/agents/session-persistence.test.ts#L111-L161) | L111–L161 | `describe('reconcileOrphanedWorkerSessions', …)` and `describe('assertNoActiveWorkerSession', …)` blocks | Encode the worker-uniqueness invariant; rewritten — see §9. |
| [tests/agents/agent-adapter-dispatch-precondition.test.ts](saivage-v3/tests/agents/agent-adapter-dispatch-precondition.test.ts) | whole file | imports `DuplicateActiveSessionError`, asserts per-`(role, cardId)` duplicate rejection | Rewritten — see §9. |
| [tests/runtime/startup-session-sweep.test.ts](saivage-v3/tests/runtime/startup-session-sweep.test.ts) | whole file | asserts `'waiting'` executor manifests are swept | Rewritten — see §9. |

`NON_TERMINAL_SESSION_STATUSES` and `WORKER_ROLES` have **no external consumers** (grep across `saivage-v3/src/**` returns only the four declaration/use sites within `session-persistence.ts`). Removing them is safe.

`DuplicateActiveSessionError` is referenced in the dispatch-precondition test only; that test is being rewritten anyway.

`failActiveWorkerSessions` was already deleted by the prior cycle and is not relevant here (it does not return).

## 7. Files touched / created / deleted

**Touched.**

- [src/agents/session-persistence.ts](saivage-v3/src/agents/session-persistence.ts) — delete `WORKER_ROLES`, `NON_TERMINAL_SESSION_STATUSES`, `DuplicateActiveSessionError`, `reconcileOrphanedWorkerSessions`, `assertNoActiveWorkerSession`; add `ConcurrentAgentSessionError`, `reconcileOrphanedAgentSessions`, `assertNoActiveAgentSession`.
- [src/agents/agent-adapter.ts](saivage-v3/src/agents/agent-adapter.ts) — update the named import; replace the precondition call at L273 (single line); no other changes.
- [src/runtime/runtime.ts](saivage-v3/src/runtime/runtime.ts) — update the named import; replace the sweep call at L603 and add the `current_agent_session_id` reconciliation block (§5.2); update the `_dispatchInFlight` inline comment at L102.
- [tests/agents/session-persistence.test.ts](saivage-v3/tests/agents/session-persistence.test.ts) — rewrite the two `describe` blocks at L111–L161 against the new invariant (see §9).
- [tests/agents/agent-adapter-dispatch-precondition.test.ts](saivage-v3/tests/agents/agent-adapter-dispatch-precondition.test.ts) — rewrite against the global invariant (see §9).
- [tests/runtime/startup-session-sweep.test.ts](saivage-v3/tests/runtime/startup-session-sweep.test.ts) — rewrite against the new sweep predicate (`'active'` only, planners included, `'waiting'` preserved; see §9).

**Created.** None. The two test files added by the prior cycle are *rewritten* in place, not duplicated.

**Deleted.** No file deletions. All deletions are symbol-level inside `session-persistence.ts` (see §6).

## 8. Risk and rollback

| Risk | Likelihood | Mitigation |
|---|---|---|
| Renaming the precondition and its caller is a multi-file edit; a missed call site would silently bypass the check. | Low: one production call site today ([agent-adapter.ts:273](saivage-v3/src/agents/agent-adapter.ts#L273)); the old name is being deleted in the same change so the compiler catches every missed reference. | Grep before commit: `grep -rn 'assertNoActiveWorkerSession\|reconcileOrphanedWorkerSessions\|DuplicateActiveSessionError\|WORKER_ROLES\|NON_TERMINAL_SESSION_STATUSES' src/ tests/` must return zero matches. |
| Sweeping `'active'` planners might mark a planner `'failed'` whose continuation the runtime would otherwise resume. | None: at process restart there is no live JS frame; an `'active'` planner is, by definition, mid-LLM-call with no driver to advance it (analysis §2.4). | n/a |
| Sweeping skips `'waiting'` planners; an orphaned `'waiting'` planner never gets revived. | Mitigated by the existing state machine: at the next dispatch tick, [`dispatchGoal`](saivage-v3/src/runtime/runtime.ts#L625) re-invokes the planner via deterministic ID, which overwrites the `'waiting'` manifest to `'active'`. If the goal card itself was already terminal, [`performCrashRecovery`](saivage-v3/src/runtime/runtime.ts#L602) drops it to backlog and the manifest stays `'waiting'` until garbage-collected by a future cycle. | This case is the legitimate "operator paused mid-stack" scenario; preserving the `'waiting'` manifest is the whole point (analysis §2.1). |
| Removing `NON_TERMINAL_SESSION_STATUSES` may break other consumers. | Verified zero external consumers (§6, §10). | TypeScript catches any remaining reference at compile time. |
| The new global precondition fires on a legitimate planner deterministic-ID re-entry from `'waiting'`. | None: previous status is `'waiting'`; predicate is `status === 'active'`. The precondition self-gates on `'waiting' !== 'active'`. | Explicit test in §9: planner re-entry from `'waiting'` does not throw. |
| Reconciling `current_agent_session_id` in §5.2 introduces a write inside `Runtime.startup` that races with `repairStartupActiveCardRun` (the prior phase). | None: the sweep + singleton-reconcile block runs **after** `repairStartupActiveCardRun` (§5.2), reads runtime state via [`readRuntimeState`](saivage-v3/src/runtime/state.ts#L134) after repair has returned, and writes via the same atomic [`updateRuntimeState`](saivage-v3/src/runtime/state.ts#L142) helper. `acquireLock` is exclusive across the whole startup region, so there is no concurrent writer. | n/a |
| Architecture-first forbids parallel systems; this change replaces one set of names with another. | n/a — the prior names are deleted in the same change (§6). | Implementation must confirm the old names do not remain alongside the new ones. |

**Rollback.** `git revert` of the corrective commit restores the worker-uniqueness surface. Because no on-disk schema changed (C6), there is no migration to undo. Any sessions failed by the new sweep stay `'failed'` after rollback — that is the correct terminal state regardless of which invariant fails them.

## 9. Testing strategy

All three test files written for the prior cycle's worker-uniqueness invariant are rewritten in place. The patterns follow:

- [tests/runtime/f23-dispatch-goal-acceptance.test.ts](saivage-v3/tests/runtime/f23-dispatch-goal-acceptance.test.ts) — `initProjectTree` → real `Runtime` construction → `startup` → assertions on disk and on the event log. The runtime is supplied with a `NoopAgentRuntime` test double so no LLM is involved.
- [tests/agents/agent-adapter-executor-fallback.test.ts](saivage-v3/tests/agents/agent-adapter-executor-fallback.test.ts) — real `AgentAdapter`, real router, stubbed `LlmCallFn`. Not `FakeAgentAdapter` (which is a separate `AgentRuntime` implementation; the precondition is in `AgentAdapter`).

### 9.1 Unit tests — [tests/agents/session-persistence.test.ts](saivage-v3/tests/agents/session-persistence.test.ts) (rewritten L111–L161)

Replace the two existing `describe` blocks (`reconcileOrphanedWorkerSessions`, `assertNoActiveWorkerSession`) with:

**`describe('reconcileOrphanedAgentSessions', …)`** — five cases:

1. **Active planner is swept.** Create a planner session for `(goal-1, goal-1)` (deterministic id `planner:goal-1`) with `status: 'active'`. Call `reconcileOrphanedAgentSessions`. Assert: returned array contains the planner; its manifest is now `'failed'` with non-null `completed_at`; one `model_issue` system message was appended carrying the default reason.
2. **Active executor and active reviewer are swept; analyst is not.** Create an `executor` (`card-1`), a `reviewer` (`goal-1`), and an `analyst` — all `'active'`. Sweep. Assert: the executor and reviewer are now `'failed'` with one `model_issue` each; the analyst manifest is byte-identical to before; the returned array has exactly two ids (executor + reviewer), excluding the analyst.
3. **Waiting planner is NOT swept.** Create a planner with deterministic id `planner:goal-1` in status `'waiting'` (set via `markSessionWaiting`). Sweep. Assert: planner manifest remains `'waiting'`; the file is byte-identical to before; returned array does not contain the planner id.
4. **Already-terminal manifests are untouched.** Create executors with `status: 'done'`, `'failed'`, `'blocked'`. Sweep. Assert: all three files are byte-identical to before; returned array is empty.
5. **Idempotent.** Run the sweep twice on the same starting state. Assert: second call returns `[]`; no additional `model_issue` messages on any session.

**`describe('assertNoActiveAgentSession', …)`** — six cases:

1. **Throws when an active planner exists and a new executor is requested.** Create planner `'active'` for `goal-1`. Call `assertNoActiveAgentSession(saivageDir, 'executor')`. Assert: throws `ConcurrentAgentSessionError`; the error carries the planner's id, role `'planner'`, and card id `'goal-1'`.
2. **Throws when an active executor exists and a new executor for a different card is requested.** Pre-seed executor `'active'` on `card-A`. Call `assertNoActiveAgentSession(saivageDir, 'executor')`. Assert: throws (architectural correction over the old `(role, cardId)`-scoped check).
3. **Throws when an active executor exists and a new reviewer is requested.** Cross-role case. Pre-seed executor `'active'` on `card-A`. Call `assertNoActiveAgentSession(saivageDir, 'reviewer')`. Assert: throws.
4. **Does NOT throw on planner deterministic-ID re-entry from `'waiting'`.** Create planner `planner:goal-1` and call `markSessionWaiting`. Call `assertNoActiveAgentSession(saivageDir, 'planner')`. Assert: returns silently (the `'waiting'` planner is not `'active'`).
5. **Does NOT throw when the new role is `'analyst'`, even with an active executor present.** Pre-seed executor `'active'`. Call `assertNoActiveAgentSession(saivageDir, 'analyst')`. Assert: returns silently (analyst is exempt by self-gate).
6. **Does NOT throw when only terminal manifests exist.** Pre-seed executor `'done'`, reviewer `'failed'`. Call `assertNoActiveAgentSession(saivageDir, 'executor')`. Assert: returns silently. Also: an active *analyst* must not count as a conflict — pre-seed an `analyst` `'active'` and call `assertNoActiveAgentSession(saivageDir, 'executor')`; assert returns silently.

### 9.2 Integration test — [tests/runtime/startup-session-sweep.test.ts](saivage-v3/tests/runtime/startup-session-sweep.test.ts) (rewritten)

Rewrite the single existing test against the new predicate. Pattern mirrors the existing harness (the file already uses `initProjectTree`, real `Runtime`, `NoopAgentRuntime`).

Single case `'sweeps active non-analyst sessions, preserves waiting planner and analyst, logs one sweep event, clears stale current_agent_session_id'`:

- Arrange:
  - `activeExecutor` — `executor` for `card-1`, status `'active'`.
  - `activeReviewer` — `reviewer` for `goal-1`, status `'active'`.
  - `activePlanner` — `planner:goal-1`, status `'active'` (left mid-call by a dead process).
  - `waitingPlanner` — separate planner for `goal-2` (`planner:goal-2`), set to `'waiting'` via `markSessionWaiting`.
  - `doneExecutor` — `executor` for `card-3`, status `'done'`.
  - `analyst` — analyst session, status `'active'`.
  - `updateRuntimeState(projectRoot, { current_agent_session_id: activePlanner.id })` — seed the singleton to point at one of the soon-to-be-swept sessions.
- Act: `await runtime.startup(); await runtime.shutdown();`.
- Assert:
  - `activeExecutor`, `activeReviewer`, `activePlanner` are now `status: 'failed'` with non-null `completed_at`.
  - Each of those three has exactly one `model_issue` system message.
  - `waitingPlanner` is still `'waiting'`; its manifest file is byte-identical to before.
  - `doneExecutor` manifest is byte-identical to before.
  - `analyst` manifest is byte-identical to before.
  - One `startup_session_sweep` event in `.saivage/runtime/events.jsonl` with `swept_session_ids` equal to the sorted set of the three swept ids (executor + reviewer + active planner).
  - `readRuntimeState(projectRoot).current_agent_session_id === null` (Proposal B reconciliation fired).

### 9.3 Integration test — [tests/agents/agent-adapter-dispatch-precondition.test.ts](saivage-v3/tests/agents/agent-adapter-dispatch-precondition.test.ts) (rewritten)

Rewrite against the global invariant. Construct a real `AgentAdapter` per the existing template (already in the file at L10–L26). Cases:

1. **Active executor blocks a new executor on a different card.** Pre-seed `createSession(saivageDir, 'executor', 'goal-1', 'card-A')` (status `'active'` by default). Call `adapter.invokeExecutor('card-B', 'goal-1', 'prompt')`. Assert: rejects with `ConcurrentAgentSessionError`; the stub LLM transport recorded zero invocations; no new manifest file exists for `card-B`.
2. **Active planner blocks a new executor.** Pre-seed `createSession(saivageDir, 'planner', 'goal-1', 'goal-1')`. Call `adapter.invokeExecutor('card-A', 'goal-1', 'prompt')`. Assert: rejects with `ConcurrentAgentSessionError`; the conflict's role in the error message is `'planner'`.
3. **Active executor blocks a new reviewer (cross-role).** Pre-seed executor `'active'`. Call `adapter.invokeReviewer('goal-1', 'prompt')`. Assert: rejects with `ConcurrentAgentSessionError`.
4. **Waiting planner does NOT block planner re-entry.** Pre-seed `createSession(saivageDir, 'planner', 'goal-1', 'goal-1')` (deterministic id `planner:goal-1`), then `markSessionWaiting(saivageDir, 'planner:goal-1')`. Call `adapter.invokePlanner('goal-1', 'systemPrompt', [])` (third arg `AgentMessage[]`, per [agent-adapter.ts L141](saivage-v3/src/agents/agent-adapter.ts#L141)). Assert: does NOT throw; the new manifest at `planner:goal-1.json` is `'active'` (overwritten in place); the stub LLM transport was invoked once.
5. **Active analyst does NOT block an executor.** Pre-seed an analyst `'active'`. Call `adapter.invokeExecutor('card-A', 'goal-1', 'prompt')`. Assert: does not throw on the precondition; the stub LLM transport is invoked once. (The analyst is the explicit exception per analysis §2.6.)
6. **New analyst is not blocked by an active executor.** Pre-seed executor `'active'`. Call the analyst surface (or directly invoke `AgentAdapter`'s analyst path; if `AgentAdapter` does not expose an analyst entry, this case is dropped — see open choice O1 in §11). Assert: precondition returns silently.
7. **Clean run.** No pre-seeded sessions. `adapter.invokeExecutor('card-A', 'goal-1', 'prompt')` proceeds normally; one new manifest created; LLM stub called once.

Each "rejects" case must also assert `listSessions(saivageDir)` length is unchanged between before and after — proving no manifest leaked through the precondition.

### 9.4 End-to-end manual check on `saivage-v3-getrich-v2` (10.0.3.170)

1. Before restart: `ssh root@10.0.3.170 'curl -fsS http://127.0.0.1:8080/api/agents | jq "[.sessions[] | select(.status==\"active\" and .role != \"analyst\")] | length"'`. Note count.
2. Deploy the change, restart `saivage-v3-getrich.service`.
3. After restart, before the next dispatch tick: same `curl`, expect `0`.
4. Tail `.saivage/runtime/events.jsonl` for one `kind: "startup_session_sweep"` entry whose `swept_session_ids` array contains the orphan ids observed before the restart.
5. `jq '.current_agent_session_id' .saivage/tmp/state/runtime.json` after restart returns `null` (Proposal B reconciliation). The authoritative runtime-state path is `.saivage/tmp/state/runtime.json` per [src/runtime/state.ts L10-L29](saivage-v3/src/runtime/state.ts#L10-L29) (`AUTHORITATIVE_STATE_FILE = 'runtime.json'`, `runtimeStatePath` joins `.saivage/tmp/state/`); the legacy `.saivage/runtime/state.json` path is rejected.

## 10. Migration

**None** (architecture-first). No schema bump, no on-disk format change, no compatibility code. Existing on-disk orphan manifests in deployed projects (`saivage-v3-getrich-v2`, etc.) are cleaned by the new sweep automatically on first restart after deployment. The three orphan executors named in the prior cycle's analysis are still cleaned by the new predicate (`status === 'active'` covers them; analysis §6 C8).

**Verification log** (grep commands an implementer must run to confirm C5):

```bash
# Old surface must be gone after the change.
grep -rn 'WORKER_ROLES\|NON_TERMINAL_SESSION_STATUSES\|reconcileOrphanedWorkerSessions\|assertNoActiveWorkerSession\|DuplicateActiveSessionError' src/ tests/
# Expected: zero matches.

# New surface must be present and consistent.
grep -rn 'reconcileOrphanedAgentSessions\|assertNoActiveAgentSession\|ConcurrentAgentSessionError' src/ tests/
# Expected: declarations in src/agents/session-persistence.ts, one call site each in
# src/agents/agent-adapter.ts and src/runtime/runtime.ts, plus the three test files.

# _dispatchInFlight must be untouched (C7).
grep -n '_dispatchInFlight' src/runtime/runtime.ts
# Expected: same 7 hits at the same lines as before the change (L102, L579, L619 x2, L626, L627, L722),
# differing only in the L102 inline comment text.
```

## 11. Open choices

Only choices that genuinely require a decision are listed. Pure naming is decided in §5.

- **O1. Analyst dispatch surface in `AgentAdapter`.** `AgentAdapter` exposes `invokePlanner`, `invokeExecutor`, `invokeReviewer`; analyst invocations come through a separate operator-chat surface. Test §9.3 case 6 ("new analyst is not blocked by an active executor") may not have a direct entry point in `AgentAdapter`. **Decision needed in implementation:** drop case 6 if no analyst entry exists on `AgentAdapter` and add an equivalent unit test on `assertNoActiveAgentSession` directly (already covered by §9.1 case 5, so the integration version is redundant; preferred outcome is to drop §9.3 case 6).
- **O2. Default reason string in `reconcileOrphanedAgentSessions`.** §5.6 proposes one wording. The exact wording is operator-facing and may benefit from final review by the operator. **Decision needed in implementation:** confirm the wording or shorten it.

No other open choices. Function names, error name, sweep position in startup, precondition position before `createSession`, decision to keep `_dispatchInFlight`, decision to keep `startup_session_sweep` event kind, and decision to reconcile `current_agent_session_id` on sweep are all made in §4 and §5.
