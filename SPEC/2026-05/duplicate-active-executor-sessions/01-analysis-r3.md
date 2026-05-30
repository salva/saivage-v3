# Analysis r3 — Duplicate Active Executor Sessions After Service Restart

## Changes from r2

Addresses reviewer items 1–4 from the r2 review:
- §6.5 / R5: corrected — `running` **is** in `RuntimeActivationStatus`; only `claimed` is not.
- §6.5 / R5: corrected — `markActivationComplete` runs in the executor restart-repair branch via `appendChildUnwindToolResult`, so the replay engine fires only when `active_card_run` was missing or pointed elsewhere.
- §6.2 / R2: removed the inverted race-window claim. `active_card_run` is written **before** `invokeExecutor`/`createSession`, not after.
- §7.3: dropped the unsupported "log truncated mid-rewrite" claim. `replaceSessionMessages` uses `writeFileAtomic` (temp + rename), so the on-disk file is never partial. The genuine concern is module-scope counter state and the lack of a "compaction in progress" marker, not file truncation.

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

On disk the executor sequence ordered by `started_at` shows three discontinuities — three service restarts:

```
… -1, -2, -3, -4, -5, -6, -7, -8, -9, -10, -11   ← run A (peak 11)
… -1, -2                                          ← run B (peak  2)
… -1, -2, -3, -4, -5                              ← run C (peak  5)
```

The duplicates for `G1.5.C1` straddle the run-A → run-B boundary. Every executor mid-flight at process kill remained `status: "active"` on disk forever, and the new process minted a new session for the same card on next restart.

## 3. How `/api/agents` reports status

[src/server/routes/runtime-config-notes.ts](saivage-v3/src/server/routes/runtime-config-notes.ts#L113) builds each row through `buildListedAgentSession` → `listedStatus` ([same file](saivage-v3/src/server/routes/runtime-config-notes.ts#L77-L88)):

1. If session is `state.current_agent_session_id` → `active` (or `waiting` if a planner run is open but not the active planner turn).
2. Else, if an open planner run is registered for that session → `waiting`.
3. Else, fall through to the manifest `status` field (`active | waiting | done | blocked | failed`).
4. Else → `inactive`.

For the orphan executors, branches 1–2 do not fire after restart (new process's `current_agent_session_id` and `runtime_runs` no longer reference the old ids), so branch 3 returns the manifest value. The manifests were never mutated from `active`, so the UI faithfully reports `active`.

## 4. Two authoritative persistent stores

- **`runtime-state.json`** at `.saivage/tmp/state/runtime.json` ([state.ts](saivage-v3/src/runtime/state.ts#L77-L97), [state.ts](saivage-v3/src/runtime/state.ts#L184-L207)). Scheduler/ledger state: `active_card_run`, `current_agent_session_id`, `runtime_runs`, `runtime_activations`, `queue`, `running_processes`. Schema in [src/schemas/types.ts](saivage-v3/src/schemas/types.ts#L91).
- **`agents/sessions/<id>.json`** — one file per session with its own `status`. Source of truth for `/api/agents` list (branch 3 above).

No consistency invariant binds the two. A startup repair sweep operates on the first; nothing operates on the second. That session-manifest-as-canonical is a **design choice for the fix**, not an established property.

## 5. Catalog of recovery / sweep mechanisms

| Mechanism | File | What it does | Mutates worker session manifest? |
|---|---|---|---|
| `Runtime.startup` | [runtime.ts](saivage-v3/src/runtime/runtime.ts#L596-L611) | Acquires lock; calls `performCrashRecovery` then `repairStartupActiveCardRun`. | No |
| `performCrashRecovery` | [runtime.ts](saivage-v3/src/runtime/runtime.ts#L617) | Transitions cards in `active`/`running` to backlog; cleans temp files. | No |
| `repairStartupActiveCardRun` | [runtime.ts](saivage-v3/src/runtime/runtime.ts#L281-L324) | Repairs from `previousState.active_card_run` only. Executor branch transitions card to `failed` and unwinds the parent's tool-result via `appendChildUnwindToolResult`, which calls `markActivationComplete` ([runtime.ts](saivage-v3/src/runtime/runtime.ts#L195-L208)) and therefore **does** transition the activation row for that child. Reviewer branch resumes planner state without manifest mutation. Reads planner session files via `findCallerEdge` / `repairOrphanActivateCardToolCalls`; **never mutates a worker session manifest**. | No |
| `failActiveWorkerSessions` | [session-persistence.ts](saivage-v3/src/agents/session-persistence.ts#L167-L179) | **Exported but never called.** Would mark every non-analyst `active`/`waiting` session `failed` with a system message. | Would, if wired. |
| `StuckAgentSupervisor` | [stuck-agent-supervisor.ts](saivage-v3/src/runtime/stuck-agent-supervisor.ts#L363-L392), [stuck-agent-supervisor.ts](saivage-v3/src/runtime/stuck-agent-supervisor.ts#L419-L452) | Live-process stuck detection; selects an abort target and cancels. Doesn't run at startup; doesn't reconcile dead-process sessions. | No |
| `agents/recovery.ts` | [recovery.ts](saivage-v3/src/agents/recovery.ts#L76-L150) | Per-invocation retry/recovery wrapper. | No |
| `runtime/cleanup.ts` | [cleanup.ts](saivage-v3/src/runtime/cleanup.ts) | Temp-file cleanup helpers. | No |
| `active-runtime.ts` | [active-runtime.ts](saivage-v3/src/runtime/active-runtime.ts#L128-L131) | Thin wrapper calling `Runtime.startup()`. | No |

Net: zero mechanism mutates stale worker session manifests at startup; the only one that would (`failActiveWorkerSessions`) is dead code.

## 6. Root causes

### 6.1 R1 (primary, verified) — `failActiveWorkerSessions` is dead code

```
$ grep -rn 'failActiveWorkerSessions' src/ --include='*.ts'
src/agents/session-persistence.ts:167:export function failActiveWorkerSessions(
```

Authored, exported, never wired into startup.

### 6.2 R2 (verified) — Startup repair is keyed off `active_card_run` only

[`repairStartupActiveCardRun`](saivage-v3/src/runtime/runtime.ts#L281-L324) only inspects the single card the previous process last flushed to `active_card_run`. Failure modes it misses:
- Any worker session whose `active_card_run` was never flushed (process killed inside `dispatchPendingActivations` after a state save but before the next one — possible whenever multiple terminal cards under one goal queue up).
- Worker session manifest mutation is missing in **all** branches. Executor branch transitions the card status and activation rows, but the executor session manifest itself stays `active`. Reviewer branch resumes planner state without touching the reviewer session manifest.

The race I claimed in r2 ("after `createSession` but before `active_card_run` is rewritten") was wrong: in the executor path, `active_card_run` is written **before** `invokeExecutor` at [runtime.ts](saivage-v3/src/runtime/runtime.ts#L742), and `createSession` runs inside the adapter at [agent-adapter.ts](saivage-v3/src/agents/agent-adapter.ts#L447). So the relevant gap is not an intra-card race but cross-card scope: `active_card_run` tracks one card at a time, while session manifests proliferate.

### 6.3 R3 (verified, demoted) — `_dispatchInFlight` is an in-process `goalId` guard

`Runtime._dispatchInFlight: Set<string>` ([runtime.ts](saivage-v3/src/runtime/runtime.ts#L101), checked at [L618-L620](saivage-v3/src/runtime/runtime.ts#L618-L620), cleared at [L715](saivage-v3/src/runtime/runtime.ts#L715)). Correct within a single process; provides no durable protection. Contributes as the *absence* of a durable substitute — treat as a symptom of R1+R2, not a peer cause.

### 6.4 R4 (verified, secondary) — No defence-in-depth on dispatch

`Runtime.dispatchPendingActivations` calls `agentRuntime.invokeExecutor` ([runtime.ts](saivage-v3/src/runtime/runtime.ts#L748)). Adapter `invokeExecutor` → `invokeAgent` ([agent-adapter.ts](saivage-v3/src/agents/agent-adapter.ts#L273-L274)) calls `createSession` unconditionally ([agent-adapter.ts](saivage-v3/src/agents/agent-adapter.ts#L447)). No precondition checks the manifest store for a conflicting `active` session by `role + card_id`.

### 6.5 R5 (verified, restated more accurately) — Pending activations replay after restart, but only when activation reconciliation also slips

Activations are created with `status: 'pending'` ([planner-control-executor.ts](saivage-v3/src/agents/planner-control-executor.ts#L122-L126)). `RuntimeActivationStatus` is `pending | running | completed | failed | blocked | cancelled | needs_verification` ([types.ts](saivage-v3/src/schemas/types.ts#L32)) (only the `'claimed'` literal in `getPendingActivationCards`'s accept-list is not in the schema — a separate latent inconsistency, not material to this bug).

In the **executor** restart-repair branch the activation row **is** transitioned via `markActivationComplete` ([runtime.ts](saivage-v3/src/runtime/runtime.ts#L195-L208)) called from `appendChildUnwindToolResult` at [runtime.ts](saivage-v3/src/runtime/runtime.ts#L305). So the replay only happens when:
- `active_card_run` was empty/`null` at restart (the process died before the next state-save), or
- `active_card_run` pointed at a different card under the same goal (so the executor branch transitioned that card's activations but not the activations of other sibling cards in `dispatchPendingActivations`'s pending queue).

Either way, on the next tick `getPendingActivationCards` re-selects unresolved activations and the dispatch loop calls `invokeExecutor`. With R1+R2 not addressed, `createSession` mints a new manifest while the old one stays `active`.

This is consistent with the observed timeline: between the run-A kill (counter=11) and run-B (counter=2), some `runtime_activations` rows were never transitioned to terminal, and the in-memory `_dispatchInFlight` set was naturally empty in the new process.

## 7. Adjacent failure modes the design must cover

### 7.1 Reviewer interruption
Reviewer branch of `repairStartupActiveCardRun` ([runtime.ts](saivage-v3/src/runtime/runtime.ts#L287-L298)) resumes planner state, queues a `reviewer_interrupted` synthetic note, but never mutates the reviewer session manifest. Reviewer manifests therefore can stay `active` after restart-during-review. Fix must treat reviewer sessions identically to executor sessions.

### 7.2 Planner sessions and deterministic IDs
Planner sessions use deterministic IDs (`planner:<cardId>`, [session-persistence.ts](saivage-v3/src/agents/session-persistence.ts#L70-L78)). A restart in-flight does not create a duplicate planner manifest — file paths collide and `writeFileAtomic` replaces. But the previous file's `status` was `active`; if the new process never invokes the planner again, the manifest stays stale. A blanket `failActiveWorkerSessions` that includes planners is therefore safe in terms of duplication, but the design must pick whether to (a) fail planner manifests at startup so a later resume creates a fresh active state, or (b) leave planners alone because their deterministic id will be overwritten naturally.

### 7.3 Compaction-in-flight at restart
[`compaction.ts`](saivage-v3/src/agents/compaction.ts#L51-L59), [`compaction.ts`](saivage-v3/src/agents/compaction.ts#L179-L184) uses module-scope state. `replaceSessionMessages` ([session-persistence.ts](saivage-v3/src/agents/session-persistence.ts#L265-L274)) calls `writeFileAtomic` (temp + rename, [file-tree.ts](saivage-v3/src/persistence/file-tree.ts#L12-L18)), so the on-disk message log cannot be left partially written. The real concern is:
- Module-scope flags / counters in compaction lose state at restart.
- There is no "compaction in progress" marker on the session, so a restart between the message-replace and any follow-up update leaves no signal that compaction was interrupted.

Not the same bug, but the same architectural anti-pattern (in-memory state alongside on-disk mutation without a consistency invariant). The design should note it explicitly but may scope the fix to session status reconciliation only.

### 7.4 Analyst sessions
[`failActiveWorkerSessions`](saivage-v3/src/agents/session-persistence.ts#L167-L179) excludes `role === 'analyst'`. Analyst sessions are long-lived chats with the operator and must stay `active` across restarts. Design must preserve this exclusion.

## 8. Severity and impact

- **Observability correctness**: `/api/agents`, dashboard, and any audit/cost-attribution consumer that trusts `agents/sessions/*.json` show phantom active executors. Every restart adds one more.
- **No double-LLM-spend risk in steady state**: original process is gone; no second LLM call is happening for the same card. Risk is observational.
- **Latent hazard**: if any future code path uses `status === 'active'` to gate work, suppress dispatch, or attribute cost, the orphans would silently break it.
- **Diagnostic noise**: a genuine in-process double-dispatch becomes indistinguishable from the restart pattern.

## 9. Constraints from workspace rules

- `AGENTS.md` — architecture-first, no backward compatibility, no migration shims, no aliases.
- Fix must reduce the two-store divergence (R2) rather than add a third reconciler, and must wire the existing recovery primitive (R1) into startup instead of cloning it.
- Session JSON store is the natural canonical for "is this agent running?" because the API/UI already read it; `runtime-state.json` should hold scheduler/ledger state (queue, activations, runs) and project the session view as derived.

## 10. Out of scope

- General refactor of `agent-adapter.invokeAgent`.
- Compaction-in-flight crash safety (§7.3 — separate fix).
- The `'claimed'` literal in `getPendingActivationCards` accept-list vs. `RuntimeActivationStatus` schema (§6.5 note — separate cleanup).
- UI rendering of `active | waiting | done | …` (surface is correct; reads stale data).

## 11. Resolved questions / remaining choices for the design

Resolved:
- Wire `failActiveWorkerSessions` (or its replacement) into the startup path.
- Collapse divergence between `active_card_run`/`runtime_activations` and worker session manifests with the session manifest as canonical "agent status".

For design:
1. Status to assign to orphaned worker sessions at startup — reuse `failed`, or add an explicit `abandoned` status to distinguish "process killed" from "agent errored"? `SessionStatus` schema in [types.ts](saivage-v3/src/schemas/types.ts).
2. Replace in-process `_dispatchInFlight` with a manifest-store query, or keep as a fast path?
3. R4 defence-in-depth — hard throw, or fail-the-old then start-the-new reconciliation?
4. Sweep scope — worker roles only (executor, reviewer), or also planner with explicit semantics (§7.2)?
5. Should the sweep also defensively transition any `runtime_activations` rows whose target card now has a terminal session manifest (belt-and-braces against R5), or rely on existing card-status `failed` to suppress replay?
