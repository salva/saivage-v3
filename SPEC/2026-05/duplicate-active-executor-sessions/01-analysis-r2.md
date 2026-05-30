# Analysis r2 — Duplicate Active Executor Sessions After Service Restart

## Changes from r1

Addresses reviewer items 1–7. Major changes:
- (Item 2) `/api/agents` status overlay correctly described — manifest is not the only input.
- (Item 3) `runtime-state.json` is recognized as the authoritative scheduler/ledger store, not a mere snapshot.
- (Item 1) `repairStartupActiveCardRun` distinction tightened: it does read planner session files (via `repairOrphanActivateCardToolCalls` / `findCallerEdge`) but does not *mutate* the interrupted worker session's manifest.
- (Item 4) R5 reworded — there is no observed `status: 'running'` activation in code; the replay is driven by unresolved `pending` activations plus `active_card_run` repair gaps.
- (Item 5) R3 demoted from a co-equal cause to a contributing factor.
- (Item 6) Recovery / sweep mechanisms catalog added.
- (Item 7) Failure modes for reviewer interruption, planner deterministic-id overwrite, and compaction-mid-restart added.

## 1. Symptom

The GetRich v2 deployment (`saivage-v3-getrich-v2` at 10.0.3.170:8080) shows **three executor agent sessions persisting with `status: "active"`**, two of them on the **same card `G1.5.C1`**:

| File | role | goal_card_id | card_id | started_at | completed_at | status |
|---|---|---|---|---|---|---|
| `executor-1779816409491-4.json` | executor | G1.3 | G1.3.D1 | 2026-05-26T17:26:49Z | — | active |
| `executor-1779818547816-11.json` | executor | G1.5 | G1.5.C1 | 2026-05-26T18:02:27Z | — | active |
| `executor-1779818999226-2.json` | executor | G1.5 | G1.5.C1 | 2026-05-26T18:09:59Z | — | active |

Source: `/home/salva/g/ml/getrich-v2/.saivage/agents/sessions/`.

## 2. Reproduction trace from session-id counter resets

Session ids are `executor-<wallclock-ms>-<counter>`. The counter is in-memory module state in [src/agents/session-persistence.ts](saivage-v3/src/agents/session-persistence.ts#L40-L44):

```ts
let sessionCounter = 0;
function nextSessionId(role: string): string {
  sessionCounter++;
  const ts = Date.now();
  return `${role}-${ts}-${sessionCounter}`;
}
```

On disk the counter sequence for executor sessions ordered by `started_at` shows three discontinuities — three service restarts:

```
… -1, -2, -3, -4, -5, -6, -7, -8, -9, -10, -11   ← run A (peak 11)
… -1, -2                                          ← run B (peak  2)
… -1, -2, -3, -4, -5                              ← run C (peak  5)
```

The duplicates for `G1.5.C1` straddle the run-A → run-B boundary (counter=11 then counter=2). The G1.3.D1 orphan is from a still earlier run.

Therefore every executor that was mid-flight at process kill remained `status: "active"` on disk forever, and the new process minted a new session for the same card on next restart.

## 3. How `/api/agents` reports status (corrected)

The endpoint at [src/server/routes/runtime-config-notes.ts](saivage-v3/src/server/routes/runtime-config-notes.ts#L113) builds each row through `buildListedAgentSession` → `listedStatus` ([same file](saivage-v3/src/server/routes/runtime-config-notes.ts#L77-L88)). The algorithm is:

1. If the session is the current `state.current_agent_session_id`, it is `active` unless there's an open planner run that is not the active planner turn, in which case it is `waiting`.
2. Else, if there is an open planner run for that session, it is `waiting`.
3. Else, fall through to the manifest `status` field (`active | waiting | done | blocked | failed`).
4. Else, `inactive`.

For the orphan executor sessions in question, branches 1–2 don't fire (the new process's `current_agent_session_id` and `runtime_runs` no longer reference the old session ids), so branch 3 returns whatever the **manifest** holds. Because the manifests were never mutated from `active` to `failed`, the UI faithfully reports `active`.

## 4. Two authoritative persistent stores (corrected)

The codebase persists "is this agent running?" in **two** durable places:

- **`runtime-state.json`** at `.saivage/tmp/state/runtime.json` — written by `saveRuntimeState` ([src/runtime/state.ts](saivage-v3/src/runtime/state.ts#L77-L97), [src/runtime/state.ts](saivage-v3/src/runtime/state.ts#L184-L207)). Contains scheduler/ledger state: `active_card_run`, `current_agent_session_id`, `runtime_runs`, `runtime_activations`, `queue`, `running_processes`. Schema in [src/schemas/types.ts](saivage-v3/src/schemas/types.ts#L91).
- **`agents/sessions/<id>.json`** — one file per session, with its own `status` field. Source of truth for the UI list (branch 3 above) and for any cross-process consumer.

These two stores are not bound by any consistency invariant. A startup repair sweep operates on the first; nothing operates on the second. R1 architecture conclusion (session manifest is the natural canonical source) is a **design choice for the fix**, not an established property of the current code.

## 5. Catalog of recovery / sweep mechanisms (new in r2)

| Mechanism | File | What it does | Covers session manifest? |
|---|---|---|---|
| `Runtime.startup` | [runtime.ts](saivage-v3/src/runtime/runtime.ts#L596-L611) | Acquires lock, calls `performCrashRecovery` then `repairStartupActiveCardRun`. | No |
| `performCrashRecovery` | [runtime.ts](saivage-v3/src/runtime/runtime.ts#L617) | Transitions cards in `active`/`running` to backlog; cleans temp files. **Does not touch session manifests.** | No |
| `repairStartupActiveCardRun` | [runtime.ts](saivage-v3/src/runtime/runtime.ts#L281-L324) | Recovers from `previousState.active_card_run` only. Executor branch transitions the card to `failed` but **does not mutate the interrupted executor session manifest**. Reviewer branch resumes planner state and **does not mutate the interrupted reviewer session manifest** either. Reads planner files indirectly via `repairOrphanActivateCardToolCalls` and `findCallerEdge`. | No (read-only on session files; no mutation of worker-session status) |
| `failActiveWorkerSessions` | [session-persistence.ts](saivage-v3/src/agents/session-persistence.ts#L167-L179) | **Exported but never called.** Would mark every non-analyst `active`/`waiting` session `failed` with a system note. | Would, if wired. |
| `StuckAgentSupervisor` | [stuck-agent-supervisor.ts](saivage-v3/src/runtime/stuck-agent-supervisor.ts#L363-L392), [stuck-agent-supervisor.ts](saivage-v3/src/runtime/stuck-agent-supervisor.ts#L419-L452) | At runtime, selects an abort target from `getActiveSessions()` and calls `abortSession` / force-cancel. This is a live-process stuck-detection loop. It does not run at startup, and it does not complete a stale on-disk session whose process is dead. | No |
| `agents/recovery.ts` | [recovery.ts](saivage-v3/src/agents/recovery.ts#L76-L150) | Per-invocation retry/recovery wrapper (`invokeWithRecovery`). Not a startup sweep. | No |
| `runtime/cleanup.ts` | [cleanup.ts](saivage-v3/src/runtime/cleanup.ts) | Temp-file cleanup helpers. | No |
| `active-runtime.ts` | [active-runtime.ts](saivage-v3/src/runtime/active-runtime.ts#L128-L131) | Thin wrapper that calls `Runtime.startup()`. | No |

**Net**: zero mechanism mutates a stale worker session manifest at startup, and the only one that would (`failActiveWorkerSessions`) is dead code.

## 6. Root causes (revised)

### 6.1 R1 (primary, verified) — `failActiveWorkerSessions` is dead code

```
$ grep -rn 'failActiveWorkerSessions' src/ --include='*.ts'
src/agents/session-persistence.ts:167:export function failActiveWorkerSessions(
```

The recovery routine was authored, exported, and never wired into startup. This is the single biggest defect; fixing it would eliminate the persistent-orphan symptom.

### 6.2 R2 (verified) — Startup repair is keyed off `active_card_run` only

[`repairStartupActiveCardRun`](saivage-v3/src/runtime/runtime.ts#L281-L324) only inspects the single card that the previous process happened to flush to `active_card_run`. Any worker session whose interruption was not reflected there (e.g., the very brief window after `createSession` but before `active_card_run` is rewritten, or any worker that was open under a previous still-running parent that was itself overwritten) is skipped. Even for the card that **is** in `active_card_run`, the executor and reviewer branches transition the card status but leave the worker session manifest at `active`. So the two stores actively diverge.

### 6.3 R3 (verified, demoted) — `_dispatchInFlight` is an in-process `goalId` guard only

`Runtime._dispatchInFlight: Set<string>` at [runtime.ts](saivage-v3/src/runtime/runtime.ts#L101) is checked at [runtime.ts](saivage-v3/src/runtime/runtime.ts#L618-L620) and cleared at [runtime.ts](saivage-v3/src/runtime/runtime.ts#L715). It works correctly within one process. It contributes to this bug only as the *absence* of a durable substitute — its restart loss is a consequence, not an independent cause. The taxonomy should treat it as a symptom of R1 + R2, not a peer.

### 6.4 R4 (verified, secondary) — No "is there already an active session for this card?" gate on dispatch

`Runtime.dispatchPendingActivations` calls `agentRuntime.invokeExecutor` ([runtime.ts](saivage-v3/src/runtime/runtime.ts#L748)). Adapter's `invokeExecutor` → `invokeAgent` ([agent-adapter.ts](saivage-v3/src/agents/agent-adapter.ts#L273-L274)) calls `createSession` unconditionally ([agent-adapter.ts](saivage-v3/src/agents/agent-adapter.ts#L447)). Even within a single live process, no precondition checks the manifest store for a conflicting `active` session. If R1+R2 are fixed, this is defence in depth; if they're not, it would also block restart-driven duplication.

### 6.5 R5 (verified, restated) — Pending activations replay after restart

Activation records are created by the planner-control bridge with `status: 'pending'` ([planner-control-executor.ts](saivage-v3/src/agents/planner-control-executor.ts#L122-L126)). `getPendingActivationCards(goalId)` accepts `pending | claimed | running` ([runtime.ts](saivage-v3/src/runtime/runtime.ts#L719-L729)). Two notes:
- `'claimed'` and `'running'` are not in `RuntimeActivationStatus` ([src/schemas/types.ts](saivage-v3/src/schemas/types.ts#L23-L35)) — that's a separate latent inconsistency the design may want to surface, but it does not change this bug.
- On restart, `repairStartupActiveCardRun` clears `active_card_run` for the interrupted executor and marks the card `failed`, but the **activation row** that drove the original dispatch is not necessarily transitioned to `resolved`/`failed`. On the next tick `getPendingActivationCards` re-selects it, the dispatch loop calls `invokeExecutor` for the same card, and `createSession` mints a new session manifest — exactly the observed duplicate.

So R5 is the "replay engine"; R1+R2 are the "no garbage collection of the previous session"; R4 is "no last-line defence". Together they produce the symptom.

## 7. Adjacent failure modes the design must cover (new in r2)

### 7.1 Reviewer interruption

`repairStartupActiveCardRun` has a reviewer branch ([runtime.ts](saivage-v3/src/runtime/runtime.ts#L287-L298)): it resumes planner state, queues a `reviewer_interrupted` synthetic note, but never mutates the reviewer session manifest. After restart-during-review the reviewer manifest stays `active`. The fix must treat reviewer sessions identically to executor sessions.

### 7.2 Planner sessions and deterministic IDs

Planner sessions use deterministic IDs (`planner:<cardId>`) constructed in [`createSession`](saivage-v3/src/agents/session-persistence.ts#L70-L78). A restart in-flight does **not** create a duplicate planner manifest — the new process writes the same file path, atomically replacing it. But the previous file's `status` was `active` and the new file inherits `active` only if dispatch reaches that point again; if the planner is paused mid-recovery, the manifest may stay stale.

A blanket `failActiveWorkerSessions` that includes planners is therefore safe (no UI duplication because the IDs collide), but the design should make the inclusion explicit and consider whether a planner session being failed at startup is desired or whether it should be transitioned to `waiting` / cleared so that the resumed planner uses a fresh "active" status. Either is defensible; the design must pick one.

### 7.3 Compaction-in-flight at restart

[`compaction.ts`](saivage-v3/src/agents/compaction.ts#L51-L59) and [`compaction.ts`](saivage-v3/src/agents/compaction.ts#L179-L184) use module-scope state and `replaceSessionMessages` independently of the session `status` field. A restart during compaction can leave the message log truncated mid-rewrite. This is not the same bug, but the same architectural anti-pattern (in-memory state + on-disk mutations that lack a consistency invariant). The design should at least call out whether the same authoritative store applies, even if the fix is scoped to session-status reconciliation.

### 7.4 Analyst sessions

[`failActiveWorkerSessions`](saivage-v3/src/agents/session-persistence.ts#L167-L179) explicitly excludes `role === 'analyst'`. Analyst sessions are long-lived chats with the operator and must stay `active` across restarts. The design must preserve this exclusion.

## 8. Severity and impact

- **Correctness of observability**: the dashboard, the `/api/agents` consumers, and any audit / cost-attribution flow that trusts `agents/sessions/*.json` show phantom active executors. Every restart adds one more.
- **No double-LLM-spend risk in steady state**: the original process is gone; no real second LLM call is happening for the same card. The risk is observational, not financial.
- **Latent hazard**: if any future code path ever uses `status === 'active'` to gate work, suppress dispatch, or attribute cost, the orphans would silently break it.
- **Diagnostic noise**: a genuine in-process double-dispatch (R3/R4 firing without restart) becomes indistinguishable from the restart pattern.

## 9. Constraints from workspace rules

- `AGENTS.md` — architecture-first, no backward compatibility, no migration shims, no aliases.
- The fix must reduce the two-store divergence (R2) rather than add a third reconciler, and must wire the existing recovery primitive (R1) into the startup path instead of cloning it.
- The session JSON store is the natural choice as authoritative for "is this agent running?" because the API and UI already read it; `runtime-state.json` should hold scheduler/ledger state (queue, activations, runs) and project the session view as derived, not duplicated.

## 10. Out of scope

- General refactor of `agent-adapter.invokeAgent`.
- Compaction-in-flight crash safety (called out in §7.3 but a separate fix).
- The `RuntimeActivationStatus` schema vs. `getPendingActivationCards` accept-list inconsistency (§6.5; noted, not addressed here).
- UI rendering of `active | waiting | done | …` states (the surface is correct; it just reads stale data).

## 11. Resolved questions / remaining choices for the design

Resolved:
- The fix must wire `failActiveWorkerSessions` (or its replacement) into the startup path.
- The fix must collapse the divergence between `active_card_run` and worker-session manifests, with the session manifest as the canonical "agent status".

Remaining for the design phase:
1. Status to assign to orphaned worker sessions at startup — reuse `failed` with a system message, or add an explicit `abandoned` status? (`SessionStatus` is in [src/schemas/types.ts](saivage-v3/src/schemas/types.ts).)
2. Should the in-process `_dispatchInFlight` set be removed and replaced by a manifest-store query, or retained as a fast path?
3. Should R4's defence-in-depth check `throw` (hard) or perform a fail-the-old-then-start-the-new reconciliation? (Hard throw + log seems aligned with architecture-first.)
4. Scope of the sweep at startup — worker roles only (executor, reviewer), or also planner with explicit semantics (see §7.2)?
5. Should the design also reconcile `runtime_activations` rows whose target now has a `failed` session, to prevent the R5 replay engine from re-firing immediately? Or is the existing card-status `failed` already terminal enough to block replay?
