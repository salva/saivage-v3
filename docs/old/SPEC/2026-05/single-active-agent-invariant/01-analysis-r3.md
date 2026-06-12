# Analysis — Replace per-`(role, cardId)` worker uniqueness with the call-stack single-active-agent invariant

## 1. Context and motivation

The prior cycle at [SPEC/2026-05/duplicate-active-executor-sessions/](saivage-v3/SPEC/2026-05/duplicate-active-executor-sessions/) shipped a fix for three orphaned `active` executor manifests observed on the GetRich v2 deployment. The fix introduced:

- [`WORKER_ROLES = {'executor','reviewer'}`](saivage-v3/src/agents/session-persistence.ts#L17) and [`NON_TERMINAL_SESSION_STATUSES = {'active','waiting'}`](saivage-v3/src/agents/session-persistence.ts#L18).
- [`reconcileOrphanedWorkerSessions`](saivage-v3/src/agents/session-persistence.ts#L177-L195) — sweeps worker manifests with `status ∈ {active, waiting}` to `failed` at startup. Wired in at [runtime.ts:603](saivage-v3/src/runtime/runtime.ts#L603).
- [`DuplicateActiveSessionError`](saivage-v3/src/agents/session-persistence.ts#L170-L175) + [`assertNoActiveWorkerSession(saivageDir, role, cardId)`](saivage-v3/src/agents/session-persistence.ts#L199-L213) — a per-`(role, cardId)` precondition. Called from [agent-adapter.ts:273](saivage-v3/src/agents/agent-adapter.ts#L273) immediately before `createSession`, gated to workers only.
- Event kind [`startup_session_sweep`](saivage-v3/src/events/registry.ts) added to the registry.
- Old dead code `failActiveWorkerSessions` removed.

The fix removed the immediate symptom (three orphan workers no longer linger across restart) but **encodes the wrong invariant**. The invariant that actually governs saivage v3's agent execution model — called out by the operator — is stronger and orthogonal to per-card uniqueness:

> **At any instant, at most one non-analyst session has `status: 'active'`.** Sessions suspended on the call stack are `'waiting'`, not `'active'`. Analysts are excluded because they are a separate kind of agent (operator chat surface, not part of the planner→executor/reviewer call stack).

This cycle establishes the facts that motivate replacing the worker-uniqueness fix with the correct call-stack invariant. It is **a correction of an already-applied change**, not a new fix on green code: the analysis must specify what is wrong with the current state and what constraints any correction must honor. Concrete file edits, function renames, and signature designs are left to the design phase.

## 2. Evidence that the call-stack model is the real architecture

### 2.1 Planner yields control by transitioning to `'waiting'`

[`invokeAgent`](saivage-v3/src/agents/agent-adapter.ts#L403) calls [`markSessionWaiting`](saivage-v3/src/agents/session-persistence.ts#L166-L168) on the planner when its result is `status: 'continue'` — i.e. it just spawned children and is yielding control:

```
if (role === 'planner' && resultStatus === 'continue') markSessionWaiting(this.saivageDir, session.id);
```

`markSessionWaiting` delegates to [`setSessionStatus(…, 'waiting')`](saivage-v3/src/agents/session-persistence.ts#L141-L160). The planner manifest is then `status: 'waiting'` for the duration of the child's execution.

### 2.2 Planner re-entry overwrites `'waiting'` → `'active'`

Planner sessions use **deterministic IDs** at [createSession L77](saivage-v3/src/agents/session-persistence.ts#L77):

```ts
const sessionId = requestedSessionId ?? (role === 'planner' && goalCardId && cardId === goalCardId ? `planner:${goalCardId}` : nextSessionId(role));
```

When children return and the parent planner is re-invoked, `createSession` writes a fresh manifest at the same path (`planner:<cardId>.json`) via `writeFileAtomic`. The manifest goes `waiting` → `active` by overwrite. There is no separate "resume" code path.

### 2.3 Executors and reviewers do not transition to `'waiting'` in production

The only call sites of `markSessionWaiting` in production code are:

- [src/agents/agent-adapter.ts:403](saivage-v3/src/agents/agent-adapter.ts#L403), guarded by `role === 'planner' && resultStatus === 'continue'`.
- [src/agents/fake-agent.ts:83](saivage-v3/src/agents/fake-agent.ts#L83), inside `invokePlannerForGoal` (a test-double for the planner; also planner-only).

There is no production call path in which an `executor` or `reviewer` manifest reaches `'waiting'`. Greppable proof:

```bash
$ grep -rn 'markSessionWaiting\|setSessionStatus.*waiting' src/
src/agents/agent-adapter.ts:403:      if (role === 'planner' && resultStatus === 'continue') markSessionWaiting(this.saivageDir, session.id);
src/agents/fake-agent.ts:83:  …markSessionWaiting(this.config.saivageDir, persistedSessionId) … (planner fixture only)
src/agents/session-persistence.ts:166:export function markSessionWaiting(saivageDir: string, sessionId: string): AgentSession {
src/agents/session-persistence.ts:167:  return setSessionStatus(saivageDir, sessionId, 'waiting');
```

(Tests can synthesize a `'waiting'` worker manifest on disk by calling `markSessionWaiting` or `setSessionStatus` directly — see [tests/runtime/startup-session-sweep.test.ts:49](saivage-v3/tests/runtime/startup-session-sweep.test.ts#L49), [tests/agents/session-persistence.test.ts:119](saivage-v3/tests/agents/session-persistence.test.ts#L119), [tests/agents/session-persistence.test.ts:144](saivage-v3/tests/agents/session-persistence.test.ts#L144). That fact is a test artifact and is itself a symptom of the misencoded invariant: those tests were written to validate the applied fix's `WORKER_ROLES × {active, waiting}` predicate, not a state the runtime can actually reach.)

### 2.4 The runtime suspends synchronously while a child runs

The planner→child→planner unwinding is built on `await`:

- [runtime.ts:755](saivage-v3/src/runtime/runtime.ts#L755) — `invokeExecutor(...)` returns a value that is then awaited on the same line (`execResult = result instanceof Promise ? await result : result;`).
- [runtime.ts:692](saivage-v3/src/runtime/runtime.ts#L692) — `invokeReviewer(...)` is awaited synchronously.
- [runtime.ts:744](saivage-v3/src/runtime/runtime.ts#L744) — child goal dispatch recurses into `await this.dispatchGoal(card.id)`.

Node.js is single-threaded; the parent JS frame is suspended while the awaited child runs. The on-disk `'waiting'` state on the parent planner manifest mirrors the suspended JS frame. There is no scenario in correct operation where two non-analyst LLM round-trips are in flight at the same time within the same process.

### 2.5 The runtime singleton handle confirms the invariant

[`RuntimeState.current_agent_session_id`](saivage-v3/src/schemas/types.ts#L96) is a **single-valued** field (`string | null`). It is updated by:

- [`emitAgentEvent`](saivage-v3/src/runtime/runtime.ts#L483) on every `session_started` event — overwriting prior values, no assertion.
- [runtime.ts:680](saivage-v3/src/runtime/runtime.ts#L680) — `updateRuntimeState({ current_agent_session_id: 'planner:'+goalId, … })` when the planner takes back control.
- [runtime.ts:296, 308, 316, 322](saivage-v3/src/runtime/runtime.ts#L296) — startup repair sets it to a single session id.
- [runtime.ts:619 (shutdown)](saivage-v3/src/runtime/runtime.ts#L619) — sets it to `null`.

A single-valued field for "the active agent right now" is direct schema-level evidence that the design assumes one. The current code does not assert the invariant before overwriting; it just trusts callers to honor it.

### 2.6 Analyst is the explicit exception

Analyst sessions have their own surfaces (operator chat at `/api/analyst`, long-lived) and never participate in the dispatch loop. They are correctly excluded by the prior fix and must remain excluded by any correction.

## 3. Why the applied per-`(role, cardId)` fix encodes the wrong invariant

### 3.1 The applied invariant is too weak

[`assertNoActiveWorkerSession`](saivage-v3/src/agents/session-persistence.ts#L199-L213) throws only when a manifest exists with the **same role and same card_id** as the new one. Architecturally illegal states it fails to detect:

- **Two workers on different cards.** If a bug causes the dispatcher to invoke `executor` on `card-B` while another `executor` on `card-A` is still `active`, the precondition passes (different `cardId`). The call stack would have two leaves — impossible under the architecture.
- **Mixed roles.** An `executor` on `card-A` is `active`; a `reviewer` on `goal-X` is dispatched. Different role → precondition passes. Two non-analyst leaves are simultaneously top-of-stack, which the architecture forbids.
- **Planner runaway.** No precondition gates planners at all. If two `dispatchGoal` drivers fire concurrently for two different goals, two planner manifests can become `'active'` simultaneously and the precondition does nothing.

The architecture says "no two non-analyst leaves are simultaneously `active`". The applied check says "no two manifests with the same `(role, cardId)` are simultaneously non-terminal". The applied check is a strict subset of the architectural check.

### 3.2 The applied sweep has a dead branch and an unreconciled orphan class

[`reconcileOrphanedWorkerSessions`](saivage-v3/src/agents/session-persistence.ts#L177-L195) sweeps `WORKER_ROLES` (`executor`, `reviewer`) with `status ∈ NON_TERMINAL_SESSION_STATUSES` ({`active`, `waiting`}). Per §2.3, the production code does not produce a worker manifest with `status: 'waiting'`. So:

- The `'waiting'` branch of the sweep is unreachable through any production path — it implicitly claims a worker can be `'waiting'`, which contradicts §2.3.
- The sweep does **not** touch `planner` manifests with `status: 'active'`. But a planner manifest in `'active'` after a process restart is exactly the same kind of orphan as an `'active'` worker: the LLM round-trip was killed mid-call, and there is no live JS frame to drive it to a terminal. Leaving these `'active'` violates the invariant the next time the runtime starts dispatching, because the singleton in §2.5 and the manifest store now disagree.

The applied fix therefore reconciles only one of the two orphan classes (workers) and pretends a third class (`'waiting'` worker) is possible.

### 3.3 The applied fix unnecessarily diverges from the singleton model

The runtime already maintains a singleton handle (`current_agent_session_id`) for "the active agent right now" (§2.5). The architectural target is for the manifest store to agree with that singleton: at most one non-analyst manifest is `'active'`. The applied per-card precondition introduces a second, weaker, parallel notion of uniqueness that has no architectural rationale.

## 4. Root causes

The mismatch is encoded in the currently-shipped surface, not in the underlying production code paths (which have always assumed the call-stack invariant):

- **R1.** The currently-encoded invariant is per-`(role, cardId)`. The architectural invariant is global: at most one non-analyst manifest is `'active'`.
- **R2.** The current sweep treats `'waiting'` as a worker-orphan state. Production workers never reach `'waiting'`; the branch is unreachable through production code paths.
- **R3.** The current sweep excludes planners from reconciliation. A planner manifest left `'active'` after a restart is also an orphan and must be reconciled.
- **R4.** The current precondition is gated to workers only. The architectural invariant gates all non-analyst sessions; planners must be covered too.
- **R5.** Original symptom: three orphan executors observed on `saivage-v3-getrich-v2`. The current worker-only sweep already cleans them; the corrective surface must continue to do so.

`failActiveWorkerSessions` is already deleted; `repairStartupActiveCardRun` does its (orthogonal) job on `active_card_run` and is not touched here; `_dispatchInFlight` remains the goal-level re-entrancy guard for `dispatchGoal(goalId)` and is not touched here.

## 5. Boundaries: what is correct in the currently-shipped surface and must survive

The currently-shipped surface is not all wrong. The following pieces are architecturally right and must survive any correction:

- **The shape of the solution.** A startup sweep plus a dispatch precondition is the correct architecture. Only the predicates must change.
- **The wiring sites.** Sweep belongs in [`Runtime.startup`](saivage-v3/src/runtime/runtime.ts#L596-L611) after `performCrashRecovery` and before `reconcileProcessRecords`. Precondition belongs immediately before [`createSession`](saivage-v3/src/agents/agent-adapter.ts#L274) with no intervening `await`.
- **A startup sweep event kind** in the registry is the right shape for operator visibility; the event schema `{ swept_session_ids: string[] }` is invariant-agnostic.
- **`_dispatchInFlight` is kept.** It is the goal-level (`goalId`) re-entrancy guard for multiple drivers of `dispatchGoal` (state machine, API, startup tick). It operates at a different layer than the manifest-store invariant. Its production use sites are at [runtime.ts:102](saivage-v3/src/runtime/runtime.ts#L102), [L579](saivage-v3/src/runtime/runtime.ts#L579), [L619](saivage-v3/src/runtime/runtime.ts#L619), [L626-L627](saivage-v3/src/runtime/runtime.ts#L626-L627), and [L722](saivage-v3/src/runtime/runtime.ts#L722). All stay.
- **Analyst exclusion** is correct and must remain.
- **`failActiveWorkerSessions` deletion** is correct and final; the function does not return.
- **`repairStartupActiveCardRun`** at [runtime.ts:282-L328](saivage-v3/src/runtime/runtime.ts#L282-L328) is orthogonal (it reconciles `active_card_run` in the persisted runtime state, not session manifests) and is unchanged.

## 6. Constraints any correction must honor

The design phase decides function names, signatures, deletion lists, and test rewrites. Whatever it produces must obey the following constraints established here:

- **C1.** The startup sweep must reconcile all non-analyst session manifests whose status is `'active'` at startup. It must not reconcile `'waiting'` sessions: those are legitimate suspended call frames whose continuation depends on the planner being re-invokable across the next dispatch tick.
- **C2.** The dispatch precondition must throw whenever a new non-analyst session is about to be created and any other non-analyst session already has status `'active'`. It must allow the deterministic-ID planner re-entry case where the previous manifest is `'waiting'`.
- **C3.** The precondition must be evaluated synchronously immediately before [`createSession`](saivage-v3/src/agents/agent-adapter.ts#L274), with no intervening `await`. This constraint is inherited from the prior cycle's design and remains valid.
- **C4.** Analyst sessions must be excluded from both the sweep and the precondition.
- **C5.** Architecture-first: the corrective change must remove the misnamed surface (`WORKER_ROLES`, `NON_TERMINAL_SESSION_STATUSES` if it has no other consumer, the worker-scoped function and class names, and the worker-only call-site gating) — not preserve it alongside a new surface. No aliases, no shims, no parallel systems.
- **C6.** No on-disk schema change to `AgentSession`. The `SessionStatus` enum and the manifest format are unchanged.
- **C7.** `_dispatchInFlight` is preserved and is not renamed (it is at a different layer; renaming it would conflate concerns).
- **C8.** The corrective change must keep cleaning the three orphan executor manifests observed on GetRich v2 (the original bug must not regress).
- **C9.** Tests written against the worker-uniqueness invariant (the ones that synthesize a `'waiting'` worker manifest to validate sweep behavior, per §2.3) are wrong for the new invariant and must be rewritten or removed, not kept.

## 7. Risks introduced by the correction

| Risk | Likelihood | Impact | Mitigation owner |
|---|---|---|---|
| Renaming the precondition function and its callers requires a multi-file edit; a missed call site would silently bypass the check. | Low — one production call site today ([agent-adapter.ts:273](saivage-v3/src/agents/agent-adapter.ts#L273)). | High if missed. | Design phase: enumerate call sites; implementation must verify with grep. |
| Sweeping `'active'` planners might mark a planner `failed` whose continuation the runtime would otherwise resume. | None — at process restart there is no live JS frame; an `'active'` planner is, by definition, mid-LLM-call with no driver to advance it. | n/a | n/a |
| Removing `NON_TERMINAL_SESSION_STATUSES` may break other consumers. | Low. | Compile failure (caught immediately). | Design phase: grep before removal. |
| The new global precondition fires on a legitimate planner deterministic-ID re-entry from `'waiting'`. | None — previous status is `'waiting'`, predicate is `'active'`. | n/a | Test coverage required (C2). |
| The architecture-first rule forbids parallel systems; the corrective change replaces one set of names with another. | n/a — the prior names must be deleted in the same change, not aliased (C5). | n/a | Implementation must confirm the old names do not remain alongside the new ones. |

## 8. Out of scope

- Refactoring `current_agent_session_id` to be derived from the manifest store (or vice versa). The two will agree after this change, but the deeper unification is a future cycle.
- Adding assertions on `current_agent_session_id` writes (e.g. assert the previous value is `null` or equal to the parent of the new session). This is a related tightening that belongs to a future cycle.
- Compaction-in-flight crash safety.
- Anything in `web/` or the UI rendering of session status.
- Touching analyst sessions or analyst-related code paths.
- Migrating on-disk format of session manifests (no schema change — C6).
- Changing `_dispatchInFlight` semantics or scope.
- Reverting the prior cycle's deletion of `failActiveWorkerSessions`.

## 9. Investigation completeness

Files read end-to-end to produce this analysis:

- [src/agents/session-persistence.ts](saivage-v3/src/agents/session-persistence.ts) — verified the applied fix surface and the planner deterministic-ID convention at L77.
- [src/agents/agent-adapter.ts](saivage-v3/src/agents/agent-adapter.ts#L265-L290) and L403 — verified precondition call site and planner-waiting transition.
- [src/agents/fake-agent.ts](saivage-v3/src/agents/fake-agent.ts#L83) — verified the test-double also restricts `markSessionWaiting` to planner.
- [src/runtime/runtime.ts](saivage-v3/src/runtime/runtime.ts) — verified sweep wiring (L596–L611), `_dispatchInFlight` sites (L102, L579, L619, L626–L627, L722), planner re-entry singleton write (L680), child invocations (L692, L755), and `repairStartupActiveCardRun` (L282–L328).
- [src/schemas/types.ts](saivage-v3/src/schemas/types.ts#L96) — verified `current_agent_session_id` is single-valued.
- [src/events/registry.ts](saivage-v3/src/events/registry.ts) — verified `startup_session_sweep` exists.
- [src/schemas/validators.ts](saivage-v3/src/schemas/validators.ts#L110) — verified runtime-state schema.

Greps performed:

- `markSessionWaiting|setSessionStatus.*waiting` across `src/` and `tests/` — confirmed the only production producers of a non-analyst `'waiting'` manifest are the planner-continue paths.
- `assertNoActiveWorkerSession|reconcileOrphanedWorkerSessions|DuplicateActiveSessionError|WORKER_ROLES|NON_TERMINAL_SESSION_STATUSES` across `src/` and `tests/` — confirmed the applied fix surface area and its consumers.
- `current_agent_session_id|currentAgentSessionId` across `src/` — confirmed the singleton model.

No further investigation is needed before the design phase.
