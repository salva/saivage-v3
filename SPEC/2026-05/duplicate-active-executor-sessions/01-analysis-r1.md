# Analysis r1 — Duplicate Active Executor Sessions After Service Restart

## 1. Symptom

The GetRich v2 deployment (`saivage-v3-getrich-v2` at 10.0.3.170:8080) shows **three executor agent sessions with `status: "active"` simultaneously**, two of them targeting the **same card `G1.5.C1`**:

| File | role | goal_card_id | card_id | started_at | completed_at | status |
|---|---|---|---|---|---|---|
| `executor-1779816409491-4.json` | executor | G1.3 | G1.3.D1 | 2026-05-26T17:26:49Z | — | active |
| `executor-1779818547816-11.json` | executor | G1.5 | G1.5.C1 | 2026-05-26T18:02:27Z | — | active |
| `executor-1779818999226-2.json` | executor | G1.5 | G1.5.C1 | 2026-05-26T18:09:59Z | — | active |

Source files: `/home/salva/g/ml/getrich-v2/.saivage/agents/sessions/`.

The `/api/agents` endpoint returns whatever `status` the JSON file holds, so the UI naturally renders three "active" executors — two for the same card.

## 2. Direct evidence — process is reproducible from logs

The session-id format is `executor-<wallclock-ms>-<counter>`. The counter source is module-scope in-memory state:

```ts
// src/agents/session-persistence.ts
let sessionCounter = 0;
function nextSessionId(role: string): string {
  sessionCounter++;
  const ts = Date.now();
  return `${role}-${ts}-${sessionCounter}`;
}
```

The counter sequence on disk for executor sessions, sorted by `started_at`, shows three discontinuities where the counter resets to a small number — each reset is a service restart:

```
... -1, -2, -3, -4, -5, -6, -7, -8, -9, -10, -11   ← run A (peaks at 11)
... -1, -2                                          ← run B (peaks at 2)
... -1, -2, -3, -4, -5                              ← run C (peaks at 5)
```

The two duplicates for `G1.5.C1` straddle the run-A → run-B boundary:

- `executor-1779818547816-11` (run A, 18:02:27Z) — counter=11
- `executor-1779818999226-2`  (run B, 18:09:59Z) — counter=2

The G1.3.D1 active session is from an even earlier run.

Conclusion: every time the service restarted, on-disk sessions that the previous process left with `status: "active"` remained "active" forever, and the new process happily minted a fresh session for work on the same card.

## 3. Root cause — five interacting defects

### 3.1 R1 (primary) — `failActiveWorkerSessions` is exported but never wired

`src/agents/session-persistence.ts` defines a sweep that does exactly what restart recovery needs:

```ts
export function failActiveWorkerSessions(
  saivageDir: string,
  reason = 'Session was left active by a previous runtime process.',
): AgentSession[] {
  // marks every non-analyst session whose status is 'active' or 'waiting' as 'failed'
}
```

A grep across the whole `src/` tree shows zero call sites:

```
$ grep -rn 'failActiveWorkerSessions' src/ --include='*.ts'
src/agents/session-persistence.ts:167:export function failActiveWorkerSessions(
```

So the recovery code was written, exported, never connected, and silently ignored. This is the single most important defect — fixing it would already reduce the symptom from "duplicate active executors" to "single active executor that quickly fails on startup".

### 3.2 R2 — startup repair is keyed off `runtime-state.active_card_run`, not the session store

`Runtime.startup()` calls `repairStartupActiveCardRun(state)` (src/runtime/runtime.ts:281). That repair:

- Reads **only** `previousState.active_card_run` (a single record describing the in-process card snapshot).
- For an executor-phase interruption it transitions the **card** to `failed` and clears `active_card_run`.
- It never opens any agent session JSON file. The session's `status` field is left untouched at `"active"`.

So even when the runtime-state snapshot is faithfully recovered, the parallel `agents/sessions/*.json` truth source diverges.

This is an "architecture-first" smell: two persistent stores describe the same fact ("is this agent running?") and only one of them is kept in sync.

### 3.3 R3 — `_dispatchInFlight` dedup lives in process memory only

`src/runtime/runtime.ts:618`:

```ts
async dispatchGoal(goalId: string): Promise<void> {
  if (this._dispatchInFlight.has(goalId)) return;
  this._dispatchInFlight.add(goalId);
  ...
  finally { this._dispatchInFlight.delete(goalId); }
}
```

The set is a `private _dispatchInFlight = new Set<string>()` field on the `Runtime` instance. It is correct as a within-process guard against re-entrant ticks, but it provides **zero** protection across process boundaries, which is exactly the scenario this bug occupies.

Note also that the guard is keyed on the parent `goalId`, not the child `card_id` actually being executed. Two consecutive crashes mid-execution of *different* cards under the same goal would not be deduped by this set even within a single process if the parent dispatch was retried.

### 3.4 R4 — executor dispatch never asks "is there already an active session for this card?"

`Runtime.dispatchPendingActivations()` (runtime.ts ~728) picks pending activations and unconditionally calls `agentRuntime.invokeExecutor(card.id, goalId, …)`, which calls `agent-adapter.invokeAgent` (line 421), which calls `createSession()` unconditionally (line 447). There is no precondition like:

```ts
const conflicting = listSessions(saivageDir)
  .map(id => getSession(saivageDir, id))
  .filter(s => s && s.role === role && s.card_id === cardId && s.status === 'active');
if (conflicting.length > 0) throw new Error('…');
```

So even within a single live process, a logic bug elsewhere that double-dispatches a card would silently create a duplicate session without any defence in depth.

### 3.5 R5 — `runtime_activations` records get replayed without checking session state

`getPendingActivationCards(goalId)` selects activations whose status is `pending | claimed | running` and returns the matching cards. After a restart, an activation in `running` state (because the previous process didn't get to mark it `done` or `failed`) is replayed: a new executor is dispatched for the same card.

The repair in R2 reaches a `running` activation through `active_card_run`, but only the *one* the runtime was last tracking. Any other `running` activation under the same goal — or any activation whose `runtime-state` snapshot was not flushed before the kill — slips through.

## 4. Why the symptom appeared specifically now

GetRich v2 is the busy deployment with many short cards, many process restarts (the operator restarts the service whenever provider routing or planner prompts change), and a runtime that uses a single `active_card_run` snapshot. The three observed orphans correspond to three distinct restart-during-executor events. The same defects exist in every other v3 deployment but are less visible there because they restart less and run fewer cards.

## 5. Severity / impact

- **Correctness**: the dashboard misrepresents the actual number of running agents — operator decisions based on "I see two executors working on the same card" are based on a lie. Every audit / debugging / cost-attribution flow that reads `agents/sessions/*.json` is poisoned.
- **No double-execution risk in steady state**: because the original process is dead, no second `node` process is in fact talking to the LLM for the same card. The risk is purely accounting / observability — *unless* a future feature ever resurrects sessions or trusts their `status` to gate work, in which case the orphan would gate a legitimate dispatch.
- **Compounding**: every restart-during-executor adds another orphan permanently. Over weeks the session list silently grows a queue of phantom active executors.
- **Hides real bugs**: a genuine in-process double-dispatch (a hypothetical bug where R3/R4 actually triggers in one process) would be indistinguishable from the restart-orphan pattern, so root-causing a future incident is harder.

## 6. Constraints from workspace rules

- `AGENTS.md` mandates architecture-first, no backward compatibility, no migration shims, no dual systems.
- The session JSON store is the durable source of truth surfaced to the UI; `runtime-state.active_card_run` is an in-process snapshot that is also persisted but should be a *projection* of session truth, not a parallel store.
- The fix must collapse the two stores into one canonical state (session JSON is the natural choice — it's already the UI's source) and ensure every code path that mutates "is this agent running?" goes through one place.

## 7. Out of scope for this analysis

- General refactor of `agents/agent-adapter.ts` invocation pipeline.
- UI changes (the `/api/agents` route is correct — it reflects on-disk truth).
- The `planner:<cardId>` deterministic session-id convention; the bug is specifically about non-planner worker roles (executor, reviewer).
- Existing orphan cleanup as a one-off operator action vs. an automatic repair — the design must handle both.

## 8. Open questions for design

1. Should startup recovery treat orphan `active` sessions as **`failed`** or as a new **`abandoned`** status that distinguishes "process killed" from "agent errored"? The schema currently has `active | waiting | done | blocked | failed`.
2. Should defence-in-depth check (R4) be a hard `throw` (fail the dispatch loop) or a soft "fail-the-old, start-the-new" reconciliation?
3. Should the in-memory `_dispatchInFlight` set be removed entirely in favour of session-store inspection, or kept as a fast path with the session store as the authoritative gate?
4. Should `_dispatchInFlight` key on `card_id` instead of `goalId`?
5. Reviewer sessions: same defects apply (their files also have `status`). Scope this fix to all worker roles (executor, reviewer) or executor only?
