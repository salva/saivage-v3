# Design r1 — Reconcile orphaned worker session manifests at startup

Companion to [01-analysis-r3.md](saivage-v3/SPEC/2026-05/duplicate-active-executor-sessions/01-analysis-r3.md). Subject to the workspace rule **architecture-first, no backward compatibility**: no shims, no aliases, no dual systems. Dead code is deleted, not repurposed in place.

## 1. Problem recap

After a service restart, every worker session (executor, reviewer) whose process was killed mid-invocation remains `status: "active"` in its `agents/sessions/<id>.json` manifest forever. The next process mints a new manifest for the same card, so `/api/agents` accumulates phantom active workers (see §1 of the analysis for the GetRich v2 observation: 3 active executors, two on `G1.5.C1`). Root causes per §6 of the analysis: **R1** the existing reconciler [failActiveWorkerSessions](saivage-v3/src/agents/session-persistence.ts#L167-L179) is dead code; **R2** [repairStartupActiveCardRun](saivage-v3/src/runtime/runtime.ts#L281-L324) only touches the single `active_card_run` card and never mutates a worker manifest; **R4** dispatch has no precondition guarding against a pre-existing active manifest for the same `role + card_id`. Two stores (`runtime-state.json` and `agents/sessions/*.json`) drift with no invariant tying them together (§4).

## 2. Goals and non-goals

**Goals.**

- After any restart, every worker session manifest left `active`/`waiting` by a dead process is reconciled before the runtime starts dispatching.
- A single function is the canonical "reconcile worker sessions for this project" primitive. It is the same function that runs at startup *and* the same function whose precondition gates dispatch.
- The two-store divergence shrinks: the worker session manifest is the canonical "is this agent running?" projection (per §9 of the analysis), and `runtime-state.json` is scheduler/ledger state.
- Dead code (`failActiveWorkerSessions` and its test) is removed; the replacement lives where the rest of session persistence lives.

**Non-goals.**

- Refactoring [agent-adapter.invokeAgent](saivage-v3/src/agents/agent-adapter.ts#L421) (§10 of analysis).
- Compaction-in-flight crash safety (§7.3, §10).
- The `'claimed'` literal vs. `RuntimeActivationStatus` schema mismatch (§10).
- Changing UI / API rendering of session status (§10).
- Touching analyst sessions; they are intentionally long-lived (§7.4).

## 3. Alternative proposals

### Proposal A — Startup sweep only (minimal)

**Scope.** Replace [failActiveWorkerSessions](saivage-v3/src/agents/session-persistence.ts#L167-L179) with a single `reconcileOrphanedWorkerSessions(saivageDir)` in `session-persistence.ts`, wire it into [Runtime.startup](saivage-v3/src/runtime/runtime.ts#L596-L611) right after [performCrashRecovery](saivage-v3/src/runtime/runtime.ts#L617) and before [repairStartupActiveCardRun](saivage-v3/src/runtime/runtime.ts#L281-L324).

**On-disk semantics.** Every non-analyst session whose manifest status is `active` or `waiting` at startup is transitioned to `failed`; one `model_issue` system message is appended explaining the cause.

**Code shape.** Pure function over the filesystem; no Runtime coupling. No precondition at dispatch.

**Trade-offs.** Fixes the observed bug. Does **not** close R4: a same-process double `invokeExecutor` for the same card (a future bug or a fast supervisor + retry interaction) would still mint two `active` manifests. Leaves `_dispatchInFlight` as the only in-process guard.

### Proposal B — Startup sweep + dispatch precondition (selected)

**Scope.** Proposal A, plus a precondition `assertNoActiveWorkerSession(saivageDir, role, cardId)` called from [invokeAgent](saivage-v3/src/agents/agent-adapter.ts#L421) immediately before [createSession](saivage-v3/src/agents/session-persistence.ts#L67-L91) for worker roles. The precondition reads the manifest store and throws on conflict. Remove `_dispatchInFlight`: the manifest-store query subsumes it across processes, and the same-process race is now caught at the adapter layer instead of the dispatcher layer.

**On-disk semantics.** Same as A. Adds an invariant: at any instant, for every `(role, card_id)` with `role ∈ {executor, reviewer}`, at most one manifest is `active`. The startup sweep restores the invariant; the dispatch precondition preserves it.

**Code shape.** One new exported function in `session-persistence.ts` (the sweep), one new exported function in `session-persistence.ts` (the precondition query), one new call at the head of `invokeAgent`, one new call at the head of `Runtime.startup`. `_dispatchInFlight` and all its uses are deleted.

**Trade-offs.** Eliminates R1, R2 (for worker manifests), and R4 in a single coherent invariant. The precondition adds one directory listing per worker invocation; the manifest count is bounded by project history and the cost is negligible compared to an LLM round-trip. Throwing on conflict surfaces real double-dispatch bugs as runtime errors instead of silently producing duplicate manifests.

### Proposal C — Project the session view from `runtime-state.json` (collapse the two stores)

**Scope.** Stop persisting `status` on the session manifest. Derive each session's status from `runtime-state.json` (`current_agent_session_id`, `runtime_runs`, `runtime_activations`) and the presence of `completed_at` on the manifest. [/api/agents](saivage-v3/src/server/routes/runtime-config-notes.ts#L77-L88) becomes a pure projection.

**On-disk semantics.** The `status` field is removed from `AgentSession`. [sessionStatusSchema](saivage-v3/src/schemas/validators.ts#L39) is deleted. Manifests carry only invariant identity + `completed_at`.

**Code shape.** Large: `setSessionStatus`, `completeSession`, `markSessionWaiting`, every call site that writes `status`, plus all consumers that read `status`, must be rewritten. The startup repair no longer needs to mutate manifests because there is no status to mutate.

**Trade-offs.** Most architecturally clean: kills the divergence at its source instead of patching it. But it is a deep refactor across the agent adapter, persistence, server routes, web UI, and tests — far beyond the bug under analysis, and the analysis explicitly designates the session manifest as canonical (§9). Proposal C is the long-term direction but is **not** the right scope for this fix.

## 4. Selected proposal and reasoning

**Selected: Proposal B.**

Justification grounded in the architecture-first rule and the analysis:

- §6.1 (R1) explicitly calls `failActiveWorkerSessions` dead code. Architecture-first means deleting it and writing the correct version, not wiring the broken one. Proposal B does exactly that.
- §6.4 (R4) is real, even though it is secondary today: dispatch has no precondition. A *startup-only* sweep (Proposal A) leaves the invariant unenforced during steady-state, so any future regression in the dispatcher silently re-creates the bug. Architecture-first prefers a single enforced invariant over a one-shot repair.
- §6.3 (R3): `_dispatchInFlight` is a per-process, per-`goalId` guard that does nothing across restarts and nothing for executor-level duplication. Once the manifest store is authoritative, `_dispatchInFlight` is *both* redundant and a parallel system. Architecture-first ⇒ delete it.
- Proposal C is correct but out of scope; the analysis (§9) names the manifest as canonical for this fix, which Proposal B honours without committing to the larger refactor.

## 5. Detailed specification

### 5.1 New module surface

All new functions live in [src/agents/session-persistence.ts](saivage-v3/src/agents/session-persistence.ts), beside the rest of session manifest I/O. No new file (per requirement E).

```ts
// In src/agents/session-persistence.ts

/**
 * Worker roles whose session manifests must be reconciled at startup
 * and gated at dispatch. Analyst sessions are intentionally excluded
 * (long-lived operator chats, §7.4 of the analysis).
 * Planner sessions are excluded because they use deterministic IDs
 * (`planner:<cardId>`) and are overwritten by writeFileAtomic on the
 * next invocation (§7.2 of the analysis); see open choice 4.
 */
const WORKER_ROLES: ReadonlyArray<AgentRole> = ['executor', 'reviewer'];

/**
 * Reconcile every non-analyst, non-planner session manifest left in a
 * non-terminal state by a previous process. Each swept session is
 * transitioned to `failed` with a `model_issue` system message.
 * Returns the swept sessions for logging.
 *
 * Idempotent: running it twice on the same on-disk state is a no-op
 * the second time.
 */
export function reconcileOrphanedWorkerSessions(
  saivageDir: string,
  reason = 'Session was left active by a previous runtime process; reconciled at startup.',
): AgentSession[];

/**
 * Dispatch precondition. Throws if any session manifest already has
 * `status ∈ {active, waiting}` for the given (role, cardId). Called
 * from `invokeAgent` immediately before `createSession` for worker
 * roles; not called for planner (deterministic id collapses naturally)
 * or analyst (parallel sessions are legal).
 */
export function assertNoActiveWorkerSession(
  saivageDir: string,
  role: AgentRole,
  cardId: string,
): void;
```

`reconcileOrphanedWorkerSessions` iterates [listSessions](saivage-v3/src/agents/session-persistence.ts#L296), filters `role ∈ WORKER_ROLES && status ∈ {active, waiting}`, calls [completeSession](saivage-v3/src/agents/session-persistence.ts#L113-L135) with `'failed'`, then calls [appendMessage](saivage-v3/src/agents/session-persistence.ts#L209) with the system message defined in §5.4.

`assertNoActiveWorkerSession` scans the manifest store for the matching `(role, cardId)` and throws `DuplicateActiveSessionError extends Error` if any matching manifest is non-terminal.

### 5.2 Caller wiring

**Startup sweep call site (requirement A).** Inserted in [Runtime.startup](saivage-v3/src/runtime/runtime.ts#L596-L611) immediately after `acquireLock` and `performCrashRecovery`, and before `repairStartupActiveCardRun`. Justification: the lock guarantees no other process is mutating manifests; `performCrashRecovery` already represents the "fix everything stale on disk" phase; `repairStartupActiveCardRun` then operates on a manifest store that already reflects the invariant. Inserting it later (e.g. after `repairStartupActiveCardRun`) would mean `repairStartupActiveCardRun`'s `appendChildUnwindToolResult` runs against a manifest that the sweep will then mark `failed`, which is fine but reads less cleanly. Inserting it earlier (before `acquireLock`) is incorrect — the lock must hold.

Concretely:

```ts
acquireLock(this.projectRoot);
await this.performCrashRecovery();
const swept = reconcileOrphanedWorkerSessions(saivageDirOf(this.projectRoot));
if (swept.length > 0) {
  this._eventLogger.appendEvent({
    kind: 'startup_session_sweep',
    swept_session_ids: swept.map((s) => s.id),
  });
}
reconcileProcessRecords(this.projectRoot);
```

The single call site is `Runtime.startup` in [runtime.ts](saivage-v3/src/runtime/runtime.ts#L596-L611). [active-runtime.ts](saivage-v3/src/runtime/active-runtime.ts#L128-L131) just delegates to it; no second wiring is needed there.

**Dispatch precondition call site (requirement C).** Inserted at the head of [invokeAgent](saivage-v3/src/agents/agent-adapter.ts#L421), before [createSession](saivage-v3/src/agents/agent-adapter.ts#L447):

```ts
private async invokeAgent<T>(role: AgentRole, goalId: string, cardId: string, ...) {
  if (role === 'executor' || role === 'reviewer') {
    assertNoActiveWorkerSession(this.saivageDir, role, cardId);
  }
  // … existing body, including the unchanged createSession() call.
}
```

Signature: `assertNoActiveWorkerSession(saivageDir: string, role: AgentRole, cardId: string): void`. Behaviour on conflict: throws `DuplicateActiveSessionError` with a message naming the existing session id; the existing exception path through [emitRuntimeDiagnostic](saivage-v3/src/runtime/runtime.ts#L748) (the `catch` block in `dispatchPendingActivations` and in `dispatchGoal` for planner — n/a here) then logs and aborts that dispatch step. No silent recovery: this is exactly the failure we want to surface if it ever happens after the sweep.

### 5.3 `_dispatchInFlight` removal

Per requirement G and the architecture-first rule (no parallel systems), `_dispatchInFlight` is deleted:

- Field declaration at [runtime.ts:101](saivage-v3/src/runtime/runtime.ts#L101).
- Guard at [runtime.ts:618-620](saivage-v3/src/runtime/runtime.ts#L618-L620).
- `delete()` in the `finally` block at [runtime.ts:715](saivage-v3/src/runtime/runtime.ts#L715).
- Use in [Runtime.shutdown](saivage-v3/src/runtime/runtime.ts) (the `if (this._dispatchInFlight.size > 0)` cancellation prelude) is rewritten to iterate the manifest store for active worker sessions instead: the same intent (cancel everything mid-flight before tearing down) is expressed against the canonical store.

Note: `_dispatchInFlight` keys by `goalId` (planner-level); the manifest store keys by `(role, cardId)` (worker-level). The new precondition is **stricter**: it forbids two concurrent executor invocations on the same card, where `_dispatchInFlight` only forbade two concurrent `dispatchGoal` calls on the same goal. This is the correct invariant; the looser one never matched the real failure mode.

### 5.4 System message text and kind (requirement D)

`kind: 'model_issue'` per [MessageKind](saivage-v3/src/schemas/types.ts#L78) — the same kind the existing dead `failActiveWorkerSessions` used; no schema change. `role: 'system'`. Content:

> `Session was left active by a previous runtime process; reconciled at startup. Status set to 'failed' so the agent list reflects reality.`

Single line, no JSON, no parameters — this message is for human/UI consumption only. Reason string is the function's default argument; callers may override.

### 5.5 Schema and type changes

**None.** [sessionStatusSchema](saivage-v3/src/schemas/validators.ts#L39) (`active | waiting | inactive | done | blocked | failed`) and [SessionStatus](saivage-v3/src/schemas/types.ts#L75) are unchanged. Decision on open choice 1 below: reuse `failed`, do not add `abandoned`.

### 5.6 Deletions (requirement G)

| File | Lines / symbols | Reason |
|---|---|---|
| [src/agents/session-persistence.ts](saivage-v3/src/agents/session-persistence.ts#L167-L179) | `failActiveWorkerSessions` (entire export). | Dead code; replaced by `reconcileOrphanedWorkerSessions`. No alias. |
| [src/runtime/runtime.ts](saivage-v3/src/runtime/runtime.ts#L101) | `_dispatchInFlight: Set<string>` field declaration. | Parallel guard; subsumed by manifest-store precondition. |
| [src/runtime/runtime.ts](saivage-v3/src/runtime/runtime.ts#L618-L620) | `if (this._dispatchInFlight.has(goalId)) return; this._dispatchInFlight.add(goalId); try {` | Same. |
| [src/runtime/runtime.ts](saivage-v3/src/runtime/runtime.ts#L715) | `this._dispatchInFlight.delete(goalId);` and surrounding `} finally { … }`. | Same. |
| [src/runtime/runtime.ts](saivage-v3/src/runtime/runtime.ts) (shutdown prelude) | `if (this._dispatchInFlight.size > 0) { await Promise.allSettled(...) }` | Rewritten to walk worker manifests via `listSessions` + `getSession`. |
| [tests/agents/session-persistence.test.ts](saivage-v3/tests/agents/session-persistence.test.ts#L111-L130) | `describe('failActiveWorkerSessions', …)` block. | Tests the deleted symbol; replaced by new tests in §7. |

### 5.7 Open design choices — decisions

| # | Choice | Decision | One-line justification |
|---|---|---|---|
| 1 | New `abandoned` status vs. reuse `failed` for orphaned sessions. | **Reuse `failed`.** | Architecture-first prefers no schema growth; the system message records the *cause*, the status records the *terminal class*; UI consumers already handle `failed`. |
| 2 | Remove `_dispatchInFlight` vs. keep as fast path. | **Remove.** | A fast path that disagrees with the authoritative store *is* the bug we are fixing; no second source of truth. |
| 3 | R4 defence-in-depth: hard throw vs. fail-old-then-start-new reconciliation. | **Hard throw.** | After the startup sweep, a conflict at dispatch can only mean a real dispatcher bug — silently masking it would re-introduce R2. |
| 4 | Sweep scope: workers only vs. include planner. | **Workers only (`executor`, `reviewer`).** | Planner IDs are deterministic (`planner:<cardId>`, [session-persistence.ts](saivage-v3/src/agents/session-persistence.ts#L70-L78)) so writeFileAtomic naturally replaces them; sweeping them would mark `failed` planners that the next tick legitimately resumes. |
| 5 | Defensively reconcile `runtime_activations` rows. | **No.** | The executor restart-repair branch already calls [markActivationComplete](saivage-v3/src/runtime/runtime.ts#L195-L208) for `active_card_run`'s card (§6.5 of the analysis); residual replay is harmless once the dispatch precondition is in place because a re-dispatch will throw, not duplicate. The activation-status / schema mismatch (`'claimed'` literal) is logged as a separate cleanup in §10 of the analysis. |

## 6. Risk analysis

| Risk | Likelihood | Mitigation | Residual |
|---|---|---|---|
| Sweep marks a *legitimate* in-process session `failed` after a crash-then-fast-restart where the OS hasn't released the lock yet. | None — `acquireLock` runs first and is exclusive (see [runtime.ts](saivage-v3/src/runtime/runtime.ts#L598)). | n/a | n/a |
| Sweep is slow on projects with thousands of session files. | Low: existing `/api/agents` listing already scans `listSessions`; cost is comparable. | If observed, add an index file. Out of scope here. | Accept. |
| Dispatch precondition throws on a card whose previous executor crashed *during the same process* (no startup happened). | Real but desirable: this is exactly the future bug we want surfaced. | Caught and logged by the existing `catch` in [dispatchPendingActivations](saivage-v3/src/runtime/runtime.ts), card is failed, parent unwound. | Accept; same behaviour as any other executor exception. |
| `assertNoActiveWorkerSession` races with concurrent `createSession` in the same process. | Impossible: `invokeAgent` is sequential per dispatch loop; the precondition and `createSession` run on the same event-loop turn. | n/a | n/a |
| Removing `_dispatchInFlight` allows `dispatchGoal(goalId)` to recurse if the planner result feeds back into itself. | Already guarded by `MAX_ITERATIONS = 50` in `dispatchGoal`; the dispatch precondition is *worker-level*, not planner-level. Planner uses deterministic ids; `createSession` for a planner overwrites the manifest in place, which is the existing semantics. | n/a | Accept. |

## 7. Testing strategy

### Unit tests

- [tests/agents/session-persistence.test.ts](saivage-v3/tests/agents/session-persistence.test.ts) — replace the deleted `failActiveWorkerSessions` block with:
  - `reconcileOrphanedWorkerSessions` marks every `active`/`waiting` executor and reviewer session `failed`, appends one `model_issue` message with the reason text, leaves `analyst` and `planner` untouched, leaves already-terminal sessions untouched, and is idempotent (second call returns `[]`).
  - `assertNoActiveWorkerSession` throws `DuplicateActiveSessionError` when a matching `active` or `waiting` manifest exists, returns silently otherwise, and never matches `analyst` or `planner`.

### Integration tests

- New `tests/runtime/startup-session-sweep.test.ts`:
  - Arrange: write three executor manifests for `(goal, card)` triples, statuses `active`, `waiting`, `done`. Construct a `Runtime`, call `startup`.
  - Assert: the two non-terminal manifests are now `failed` and carry the system message; the `done` one is untouched. `/api/agents`-equivalent projection (call [buildListedAgentSession](saivage-v3/src/server/routes/runtime-config-notes.ts#L77-L88) directly) returns `failed` for them.
- New `tests/runtime/dispatch-precondition.test.ts`:
  - Arrange: pre-seed an `active` executor manifest for `(executor, card-X)`. Call `agentAdapter.invokeExecutor('card-X', 'goal-Y', …)`.
  - Assert: throws `DuplicateActiveSessionError`; no second manifest is written; no LLM call is issued (verify against `FakeAgentAdapter` call counter).
- [tests/runtime/runtime.test.ts](saivage-v3/tests/runtime/runtime.test.ts) — remove any assertion that depends on `_dispatchInFlight` being a `Set` (`grep _dispatchInFlight tests/`). If a test asserted "second concurrent dispatchGoal returns immediately," replace its expectation with "second concurrent dispatchGoal is a no-op because the goal is already running per `runtime-state.active_card_run`" if such a test exists; otherwise delete the test.

### End-to-end manual check

After deploying to `saivage-v3-getrich-v2` (10.0.3.170):

1. `curl http://10.0.3.170:8080/api/agents | jq '[.sessions[] | select(.status=="active" and .role=="executor")] | length'` — expect 0 before any new dispatch starts.
2. Tail the event log for `kind: "startup_session_sweep"` with the three known orphan session ids from the analysis table.

## 8. Migration

**None.** Per the architecture-first rule, no migration shim, no compatibility code, no schema bump. Existing on-disk orphaned manifests in deployed projects (`getrich-v2`, etc.) will be cleaned by the new startup sweep automatically on the first restart after this change ships. The three sessions from §1 of the analysis (`executor-1779816409491-4`, `executor-1779818547816-11`, `executor-1779818999226-2`) will be transitioned to `failed` in that order.

## 9. Files touched / created / deleted

**Touched.**

- [src/agents/session-persistence.ts](saivage-v3/src/agents/session-persistence.ts) — add `WORKER_ROLES`, `reconcileOrphanedWorkerSessions`, `assertNoActiveWorkerSession`, `DuplicateActiveSessionError`; remove `failActiveWorkerSessions`.
- [src/agents/agent-adapter.ts](saivage-v3/src/agents/agent-adapter.ts) — import `assertNoActiveWorkerSession`; call it at the head of [invokeAgent](saivage-v3/src/agents/agent-adapter.ts#L421) for worker roles.
- [src/runtime/runtime.ts](saivage-v3/src/runtime/runtime.ts) — import `reconcileOrphanedWorkerSessions`; call it in [startup](saivage-v3/src/runtime/runtime.ts#L596-L611) after `performCrashRecovery`; delete `_dispatchInFlight` field, guard, and `finally` cleanup; rewrite the shutdown prelude to consult the manifest store.
- [tests/agents/session-persistence.test.ts](saivage-v3/tests/agents/session-persistence.test.ts) — replace the `failActiveWorkerSessions` block.

**Created.**

- [tests/runtime/startup-session-sweep.test.ts](saivage-v3/tests/runtime/startup-session-sweep.test.ts)
- [tests/runtime/dispatch-precondition.test.ts](saivage-v3/tests/runtime/dispatch-precondition.test.ts)

**Deleted.**

- Symbol `failActiveWorkerSessions` in [src/agents/session-persistence.ts](saivage-v3/src/agents/session-persistence.ts#L167-L179).
- Symbol `_dispatchInFlight` and all references in [src/runtime/runtime.ts](saivage-v3/src/runtime/runtime.ts#L101) / [L618-L620](saivage-v3/src/runtime/runtime.ts#L618-L620) / [L715](saivage-v3/src/runtime/runtime.ts#L715).
- `describe('failActiveWorkerSessions', …)` block in [tests/agents/session-persistence.test.ts](saivage-v3/tests/agents/session-persistence.test.ts#L111-L130).

No new modules or files outside the test directory; no schema files modified; no on-disk format changed.
