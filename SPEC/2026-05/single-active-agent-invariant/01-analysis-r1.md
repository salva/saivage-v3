# Analysis r1 — Replace per-`(role, cardId)` worker uniqueness with the call-stack single-active-agent invariant

## 1. Context and motivation

The prior cycle at [SPEC/2026-05/duplicate-active-executor-sessions/](saivage-v3/SPEC/2026-05/duplicate-active-executor-sessions/) shipped a fix for three orphaned `active` executor manifests observed on the GetRich v2 deployment. The fix introduced:

- [`WORKER_ROLES = {'executor','reviewer'}`](saivage-v3/src/agents/session-persistence.ts#L17) and [`NON_TERMINAL_SESSION_STATUSES = {'active','waiting'}`](saivage-v3/src/agents/session-persistence.ts#L18).
- [`reconcileOrphanedWorkerSessions`](saivage-v3/src/agents/session-persistence.ts#L177-L195) — sweeps worker manifests with `status ∈ {active, waiting}` to `failed` at startup. Wired in at [runtime.ts:603](saivage-v3/src/runtime/runtime.ts#L603).
- [`DuplicateActiveSessionError`](saivage-v3/src/agents/session-persistence.ts#L169-L175) + [`assertNoActiveWorkerSession(saivageDir, role, cardId)`](saivage-v3/src/agents/session-persistence.ts#L199-L213) — a per-`(role, cardId)` precondition. Called from [agent-adapter.ts:273](saivage-v3/src/agents/agent-adapter.ts#L273) immediately before `createSession`, gated to workers only.
- Event kind [`startup_session_sweep`](saivage-v3/src/events/registry.ts) added to the registry.
- Old dead code `failActiveWorkerSessions` removed.

The fix removed the immediate symptom (three orphan workers no longer linger across restart) but **encodes the wrong invariant**. The invariant that actually governs saivage v3's agent execution model — called out by the operator — is stronger and orthogonal to per-card uniqueness:

> **At any instant, at most one non-analyst session has `status: 'active'`.** Sessions suspended on the call stack are `'waiting'`, not `'active'`. Analysts are excluded because they are a separate kind of agent (operator chat surface, not part of the planner→executor/reviewer call stack).

This cycle replaces the worker-uniqueness fix with the correct call-stack invariant. It is **a correction of an already-applied change**, not a new fix on green code: the analysis must specify what to remove, what to rename, and what to add.

## 2. Evidence that the call-stack model is the real architecture

### 2.1 Planner yields control by transitioning to `'waiting'`

[`invokeAgent`](saivage-v3/src/agents/agent-adapter.ts#L403) calls [`markSessionWaiting`](saivage-v3/src/agents/session-persistence.ts#L166-L168) on the planner when its result is `status: 'continue'` — i.e. it just spawned children and is yielding control:

```
if (role === 'planner' && resultStatus === 'continue') markSessionWaiting(this.saivageDir, session.id);
```

`markSessionWaiting` delegates to [`setSessionStatus(…, 'waiting')`](saivage-v3/src/agents/session-persistence.ts#L141-L160). The planner manifest is then `status: 'waiting'` for the duration of the child's execution.

### 2.2 Planner re-entry overwrites `'waiting'` → `'active'`

Planner sessions use **deterministic IDs** at [createSession L74](saivage-v3/src/agents/session-persistence.ts#L74):

```ts
const sessionId = requestedSessionId ?? (role === 'planner' && goalCardId && cardId === goalCardId ? `planner:${goalCardId}` : nextSessionId(role));
```

When children return and the parent planner is re-invoked, `createSession` writes a fresh manifest at the same path (`planner:<cardId>.json`) via `writeFileAtomic`. The manifest goes `waiting` → `active` by overwrite. There is no separate "resume" code path.

### 2.3 Executors and reviewers are leaves

[`invokeExecutor`](saivage-v3/src/agents/agent-adapter.ts#L149-L151) and [`invokeReviewer`](saivage-v3/src/agents/agent-adapter.ts#L152-L154) both terminate the manifest via [`completeSession`](saivage-v3/src/agents/session-persistence.ts#L113-L135) with status ∈ `{done, blocked, failed}`. There is **no code path** in the executor or reviewer that calls `markSessionWaiting`, `setSessionStatus(…, 'waiting')`, or anything equivalent. Greppable proof:

```bash
$ grep -rn 'markSessionWaiting\|setSessionStatus.*waiting' src/agents/ src/runtime/
src/agents/agent-adapter.ts:403:      if (role === 'planner' && resultStatus === 'continue') markSessionWaiting(this.saivageDir, session.id);
src/agents/session-persistence.ts:166:export function markSessionWaiting(saivageDir: string, sessionId: string): AgentSession {
src/agents/session-persistence.ts:167:  return setSessionStatus(saivageDir, sessionId, 'waiting');
```

The only producer of a `'waiting'` non-analyst manifest is the planner-continue path. Therefore, treating `'waiting'` as an orphaned-worker state in [`reconcileOrphanedWorkerSessions`](saivage-v3/src/agents/session-persistence.ts#L185) is dead code: no worker manifest can ever be `'waiting'`.

### 2.4 The runtime suspends synchronously while a child runs

The planner→child→planner unwinding is built on `await`:

- [runtime.ts:755](saivage-v3/src/runtime/runtime.ts#L755) — `invokeExecutor(...)` is awaited synchronously.
- [runtime.ts:692](saivage-v3/src/runtime/runtime.ts#L692) — `invokeReviewer(...)` is awaited synchronously.
- [runtime.ts:751-753](saivage-v3/src/runtime/runtime.ts#L751-L753) — child goal dispatch recurses into `await this.dispatchGoal(card.id)`.

Node.js is single-threaded; the parent JS frame is suspended while the awaited child runs. The on-disk `waiting` state on the parent planner manifest mirrors the suspended JS frame. There is no scenario in correct operation where two non-analyst LLM round-trips are in flight at the same time within the same process.

### 2.5 The runtime singleton handle confirms the invariant

[`RuntimeState.current_agent_session_id`](saivage-v3/src/schemas/types.ts#L96) is a **single-valued** field (`string | null`). It is updated by:

- [`emitAgentEvent`](saivage-v3/src/runtime/runtime.ts#L483) on every `session_started` event — overwriting prior values, no assertion.
- [runtime.ts:680](saivage-v3/src/runtime/runtime.ts#L680) — `updateRuntimeState({ current_agent_session_id: 'planner:'+goalId, … })` when the planner takes back control.
- [runtime.ts:296, 308, 316, 322](saivage-v3/src/runtime/runtime.ts#L296) — startup repair sets it to a single session id.
- [runtime.ts:619 (shutdown)](saivage-v3/src/runtime/runtime.ts#L619) — sets it to `null`.

A single-valued field for "the active agent right now" is direct schema-level evidence that the design assumes one. The current code does not assert the invariant before overwriting; it just trusts callers to honor it.

### 2.6 Analyst is the explicit exception

Analyst sessions have their own surfaces (operator chat at `/api/analyst`, long-lived) and never participate in the dispatch loop. They are correctly excluded by the prior fix and must remain excluded here.

## 3. Why the applied per-`(role, cardId)` fix encodes the wrong invariant

### 3.1 The applied invariant is too weak

[`assertNoActiveWorkerSession`](saivage-v3/src/agents/session-persistence.ts#L199-L213) throws only when a manifest exists with the **same role and same card_id** as the new one. Architecturally illegal states it fails to detect:

- **Two workers on different cards.** If a bug causes the dispatcher to invoke `executor` on `card-B` while another `executor` on `card-A` is still `active`, the precondition passes (different `cardId`). The call stack would have two leaves — impossible under the architecture.
- **Mixed roles.** An `executor` on `card-A` is `active`; a `reviewer` on `goal-X` is dispatched. Different role → precondition passes. Two non-analyst leaves are simultaneously top-of-stack, which the architecture forbids.
- **Planner runaway.** No precondition gates planners at all. If two `dispatchGoal` drivers fire concurrently for two different goals, two planner manifests can become `active` simultaneously and the precondition does nothing.

The architecture says "no two non-analyst leaves are simultaneously `active`". The applied check says "no two manifests with the same `(role, cardId)` are simultaneously non-terminal". The applied check is a strict subset of the architectural check.

### 3.2 The applied sweep encodes a contradiction

[`reconcileOrphanedWorkerSessions`](saivage-v3/src/agents/session-persistence.ts#L177-L195) sweeps `WORKER_ROLES` (`executor`, `reviewer`) with `status ∈ NON_TERMINAL_SESSION_STATUSES` ({`active`, `waiting`}). Per §2.3, no worker can ever reach `'waiting'`. So:

- The `waiting` branch of the sweep is provably dead code — implicitly claiming a worker can be `waiting`, which the architecture forbids.
- The sweep does **not** touch `planner` manifests with `status: 'active'`. But a planner manifest in `active` after a process restart is exactly the same kind of orphan as an `active` worker: the LLM round-trip was killed mid-call, and there is no live JS frame to drive it to a terminal. Leaving these `active` violates the invariant the next time the runtime starts dispatching, because §2.5's `current_agent_session_id` and the manifest store now disagree.

The applied fix therefore reconciles only one of the two orphan classes and pretends a third class (`waiting` worker) is possible.

### 3.3 The applied fix unnecessarily diverges from the singleton model

The runtime already maintains a singleton handle (`current_agent_session_id`) for "the active agent right now". The architectural fix is to make the manifest store agree with that singleton: at most one non-analyst manifest is `active`. The applied per-card precondition introduces a second, weaker, parallel notion of uniqueness that has no architectural rationale.

## 4. Root causes (revised inventory)

- **R1' (mis-fix).** The applied invariant is per-`(role, cardId)`. The architectural invariant is global: at most one non-analyst manifest is `active`.
- **R2' (mis-fix).** The sweep treats `waiting` as a worker-orphan state. Workers never reach `waiting`; the branch is dead.
- **R3' (mis-fix).** The sweep excludes planners from reconciliation. A planner manifest left `active` after a restart is also an orphan and must be reconciled.
- **R4' (mis-fix).** The precondition is gated to workers only. Planners with deterministic IDs are unaffected by their own deterministic overwrite, but two planners on different cards still constitute an architecturally illegal state that the precondition must catch.
- **R5' (orphan symptom, residual).** The original three orphaned executors (analysis r3 of the prior cycle) are now cleaned by the worker-only sweep. This residual is fine — the architectural fix supersets the worker-only sweep and continues to clean them.

The original R1–R4 from the prior cycle's analysis are no longer relevant: `failActiveWorkerSessions` is already deleted, `repairStartupActiveCardRun` still does its (orthogonal) job on `active_card_run`, and `_dispatchInFlight` remains the planner-level re-entrancy guard for `dispatchGoal(goalId)`.

## 5. Boundaries: what stays correct from the applied fix

The applied change is not all wrong. The following pieces are architecturally right and must survive the correction:

- **The shape of the solution.** A startup sweep plus a dispatch precondition is the correct architecture. Only the predicates change.
- **The wiring sites.** Sweep belongs in [`Runtime.startup`](saivage-v3/src/runtime/runtime.ts#L596-L611) after `performCrashRecovery` and before `reconcileProcessRecords`. Precondition belongs immediately before [`createSession`](saivage-v3/src/agents/agent-adapter.ts#L274) with no intervening `await`.
- **The `startup_session_sweep` event kind** is a legitimate addition to the registry. It can be reused (and renamed cosmetically if desired) for the broader sweep.
- **`_dispatchInFlight` remains** — it is the goal-level (`goalId`) re-entrancy guard for multiple drivers (state machine, API, startup tick) of `dispatchGoal`. It is at a different layer than the manifest-store invariant. Both layers are needed.
- **Analyst exclusion is correct** and must remain.
- **Deletion of `failActiveWorkerSessions`** is correct and final; it stays deleted.

## 6. What must change

### 6.1 Predicate changes

| Symbol | Today | Must become |
|---|---|---|
| `WORKER_ROLES` ([session-persistence.ts:17](saivage-v3/src/agents/session-persistence.ts#L17)) | `Set(['executor','reviewer'])` | Removed. Inline check `session.role !== 'analyst'` at each use site. |
| `NON_TERMINAL_SESSION_STATUSES` ([session-persistence.ts:18](saivage-v3/src/agents/session-persistence.ts#L18)) | `Set(['active','waiting'])` | Removed. The sweep cares about `'active'` only; the precondition cares about `'active'` only. `'waiting'` is the legitimate suspended-call-frame state and must be preserved across restart. |
| `reconcileOrphanedWorkerSessions` ([session-persistence.ts:177-195](saivage-v3/src/agents/session-persistence.ts#L177-L195)) | Workers with `active`/`waiting` → `failed`. | Renamed `reconcileOrphanedAgentSessions`. **All non-analyst** sessions with `'active'` only → `'failed'`. `'waiting'` sessions are left intact. |
| `assertNoActiveWorkerSession(saivageDir, role, cardId)` ([session-persistence.ts:199-213](saivage-v3/src/agents/session-persistence.ts#L199-L213)) | Throws on same `(role, cardId)` with `active`/`waiting`. | Renamed `assertNoActiveAgentSession(saivageDir, exceptSessionId?)`. Throws if **any non-analyst session** has `status: 'active'` and its id is not `exceptSessionId`. |
| Call site in [agent-adapter.ts:273](saivage-v3/src/agents/agent-adapter.ts#L273) | Gated to workers (`role === 'executor' || role === 'reviewer'`). | Gated to non-analyst (`role !== 'analyst'`). The `exceptSessionId` is set to the planner's deterministic id when re-entering a planner (analysis §2.2: the previous manifest is `waiting` not `active`, so in practice this is defensive). |

### 6.2 Class rename

`DuplicateActiveSessionError` ([session-persistence.ts:169](saivage-v3/src/agents/session-persistence.ts#L169)) is renamed `ConcurrentAgentSessionError` (or kept — see open choice O3). Its constructor changes from `(role, cardId, existingSessionId)` to `(existingSessionId, attemptedRole, attemptedCardId)`: the conflict is no longer scoped to a card.

### 6.3 Event kind rename or reuse

`startup_session_sweep` in [src/events/registry.ts](saivage-v3/src/events/registry.ts) is either kept (the schema `{ swept_session_ids: string[] }` is still right) or renamed `startup_agent_session_sweep` for accuracy. Decision: see open choice O4.

### 6.4 Tests that must change

The existing unit tests at [tests/agents/session-persistence.test.ts](saivage-v3/tests/agents/session-persistence.test.ts) for `reconcileOrphanedWorkerSessions` and `assertNoActiveWorkerSession` are now wrong (they assert the wrong invariant). They must be rewritten or removed.

The integration tests at [tests/runtime/startup-session-sweep.test.ts](saivage-v3/tests/runtime/startup-session-sweep.test.ts) and [tests/agents/agent-adapter-dispatch-precondition.test.ts](saivage-v3/tests/agents/agent-adapter-dispatch-precondition.test.ts) must be rewritten to:

- Assert that a `waiting` planner manifest is **not** swept (it's a legitimate call frame).
- Assert that an `active` planner manifest **is** swept (it's an orphan).
- Assert that a second non-analyst invocation throws when any non-analyst session is `active`, regardless of card.
- Assert that an analyst session that is `active` does **not** block a dispatch (analyst is excluded).
- Assert that planner deterministic-ID re-entry from `waiting` does not throw.

## 7. What does NOT change

- `failActiveWorkerSessions` stays deleted (it was dead code).
- `_dispatchInFlight` is kept as-is, including its use sites at [runtime.ts:101](saivage-v3/src/runtime/runtime.ts#L101), [L578](saivage-v3/src/runtime/runtime.ts#L578), [L612](saivage-v3/src/runtime/runtime.ts#L612), [L618-L620](saivage-v3/src/runtime/runtime.ts#L618-L620), [L715](saivage-v3/src/runtime/runtime.ts#L715).
- [`repairStartupActiveCardRun`](saivage-v3/src/runtime/runtime.ts#L281-L324) stays as-is. It addresses `active_card_run` in `runtime-state.json`, not session manifests; orthogonal.
- The sweep wiring site in [`Runtime.startup`](saivage-v3/src/runtime/runtime.ts#L596-L611) does not move.
- The precondition wiring site at [agent-adapter.ts:273](saivage-v3/src/agents/agent-adapter.ts#L273) does not move — it stays immediately before `createSession`.
- The analyst role is excluded throughout.

## 8. Risks introduced by the correction

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Renaming the precondition function and its callers requires a multi-file edit; a missed call site would silently bypass the check. | Low (only one call site in production code today). | High if missed. | Reviewer must verify with `grep -rn 'assertNoActiveWorkerSession\|assertNoActiveAgentSession' src/ tests/`. |
| Sweeping `active` planners might mark a planner `failed` whose continuation the runtime would otherwise resume. | None — at process restart there is no live JS frame; an `active` planner is, by definition, mid-LLM-call with no driver. | n/a | n/a |
| Removing `NON_TERMINAL_SESSION_STATUSES` while the codebase still imports it elsewhere. | Low. | Compile failure (caught immediately). | Verify with grep. |
| The new precondition fires on a legitimate planner deterministic-ID re-entry from `waiting`. | None — previous status is `waiting`, predicate is `'active'`. | n/a | Covered by test "planner deterministic-ID re-entry from waiting does not throw". |
| The architecture-first rule forbids parallel systems; this cycle replaces one set of names with another. | n/a — the prior names are deleted in the same change, not aliased. | n/a | Reviewer must confirm the old names do not remain alongside the new ones. |

## 9. Out of scope

- Refactoring `current_agent_session_id` to be derived from the manifest store (or vice versa). The two will agree after this change, but the deeper unification is a future cycle.
- Adding assertions on `current_agent_session_id` writes (e.g. assert the previous value is `null` or equal to the parent of the new session). This is a related tightening that belongs to a future cycle.
- Compaction-in-flight crash safety.
- Anything in `web/` or the UI rendering of session status.
- Touching analyst sessions or analyst-related code paths.
- Migrating on-disk format of session manifests (no schema change).

## 10. Open choices for design phase

- **O1.** Function rename: `reconcileOrphanedWorkerSessions` → `reconcileOrphanedAgentSessions` (literal architecture-first replacement) vs. keeping the prior name and broadening behavior. Recommendation: rename — the name "worker" is the misnomer that encodes the wrong invariant. Architecture-first says delete the old name and the old contract together.
- **O2.** Function rename: `assertNoActiveWorkerSession` → `assertNoActiveAgentSession`. Same recommendation as O1.
- **O3.** Class rename: `DuplicateActiveSessionError` → `ConcurrentAgentSessionError` (more accurate; the conflict is concurrency, not duplication) vs. keep. Recommendation: rename, with the same architecture-first justification. The constructor signature also changes meaningfully, so a rename clarifies the API change.
- **O4.** Event kind rename: `startup_session_sweep` → `startup_agent_session_sweep` vs. keep. Recommendation: keep. The kind is correct as-is; only the sweep predicate broadened. The schema (`{ swept_session_ids: string[] }`) is unchanged.
- **O5.** `exceptSessionId` parameter on the precondition: include (defensive against future planner-active overwrites) vs. omit (rely on the architectural guarantee that the planner-re-entry source manifest is `waiting`, not `active`, so the precondition never sees it as a conflict). Recommendation: omit. Adding `exceptSessionId` would invite calls that pass it for non-architectural reasons; keep the API minimal.
- **O6.** Whether the corrective sweep also marks `runtime-state.json.current_agent_session_id` to `null` if it pointed to a swept session. Recommendation: yes — clearing the singleton handle when the manifest it points to is reconciled is part of the same invariant. Costs one `updateRuntimeState` call in `Runtime.startup` after the sweep.

## 11. Investigation completeness

Files read end-to-end to produce this analysis:

- [src/agents/session-persistence.ts](saivage-v3/src/agents/session-persistence.ts) — verified the applied fix and the call-stack mechanics around `markSessionWaiting`/`setSessionStatus`.
- [src/agents/agent-adapter.ts](saivage-v3/src/agents/agent-adapter.ts#L265-L290) and L403 — verified precondition call site and planner-waiting transition.
- [src/runtime/runtime.ts](saivage-v3/src/runtime/runtime.ts#L596-L611), L680, L692, L755, L483 — verified sweep wiring, planner re-entry singleton write, and child invocations.
- [src/schemas/types.ts](saivage-v3/src/schemas/types.ts#L96) — verified `current_agent_session_id` is single-valued.
- [src/events/registry.ts](saivage-v3/src/events/registry.ts) — verified `startup_session_sweep` exists.
- [src/schemas/validators.ts](saivage-v3/src/schemas/validators.ts#L110) — verified runtime-state schema.

Greps performed:

- `markSessionWaiting|setSessionStatus.*waiting` across `src/` — confirms the only producer of a non-analyst `'waiting'` is the planner-continue path.
- `assertNoActiveWorkerSession|reconcileOrphanedWorkerSessions|DuplicateActiveSessionError|WORKER_ROLES` across `src/` — confirms the applied fix surface area.
- `current_agent_session_id|currentAgentSessionId` across `src/` — confirms the singleton model.

No further investigation is needed before the design phase.
