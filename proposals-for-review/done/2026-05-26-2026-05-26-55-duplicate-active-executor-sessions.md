# Design: Reconcile orphaned worker session manifests at startup; enforce single-active-worker-per-card invariant

## Problem

The GetRich v2 deployment of saivage-v3 (10.0.3.170) currently shows three worker session manifests stuck `status: "active"` (two on card `G1.5.C1`) in `/api/agents`, even though no executor processes are running. Each is the residue of a previous runtime process that exited mid-invocation: nothing on the next startup reconciles the worker manifest store. Subsequent invocations mint a new manifest for the same card, so `/api/agents` accumulates phantom active workers indefinitely.

Affected files on disk (host paths, GetRich v2 working tree):

- `/home/salva/g/ml/getrich-v2/.saivage/agents/sessions/executor-1779816409491-4.json`
- `/home/salva/g/ml/getrich-v2/.saivage/agents/sessions/executor-1779818547816-11.json`
- `/home/salva/g/ml/getrich-v2/.saivage/agents/sessions/executor-1779818999226-2.json`

Root causes (verified during investigation, citations in approved analysis):

- **R1.** `failActiveWorkerSessions` at [saivage-v3/src/agents/session-persistence.ts](../../saivage-v3/src/agents/session-persistence.ts#L167-L187) is exported but never called — dead code.
- **R2.** `repairStartupActiveCardRun` at [saivage-v3/src/runtime/runtime.ts](../../saivage-v3/src/runtime/runtime.ts#L281-L324) only acts on `active_card_run`; it never mutates worker session manifests.
- **R4.** Dispatch has no precondition by `(role, card_id)` before `createSession` at [saivage-v3/src/agents/agent-adapter.ts](../../saivage-v3/src/agents/agent-adapter.ts#L447). A same-process double `invokeExecutor` would mint two `active` manifests.

(`_dispatchInFlight` at [saivage-v3/src/runtime/runtime.ts](../../saivage-v3/src/runtime/runtime.ts#L101) is the planner-level (`goalId`) in-process re-entrancy guard for `dispatchGoal`; it is at a different layer and is intentionally **kept**.)

This proposal is **independent** of the F01–F04/F05 UI-port batch already in the mailbox (`2026-05-26-52..54`). There is no precondition relationship: the UI-port batch lives entirely in `web/src/`, while this change touches the runtime and persistence layers.

## Decision

A converged design has already been written and reviewed under `SPEC/2026-05/duplicate-active-executor-sessions/`. The harness must implement exactly what those documents specify (no re-litigation).

Authoritative documents (all under `/home/salva/g/ml/saivage-v3/SPEC/2026-05/duplicate-active-executor-sessions/`):

- Analysis (3 iterations, approved): [01-analysis-r3.md](../../saivage-v3/SPEC/2026-05/duplicate-active-executor-sessions/01-analysis-r3.md), [ANALYSIS-APPROVED.md](../../saivage-v3/SPEC/2026-05/duplicate-active-executor-sessions/ANALYSIS-APPROVED.md).
- Design (4 iterations, approved): [02-design-r4.md](../../saivage-v3/SPEC/2026-05/duplicate-active-executor-sessions/02-design-r4.md), [DESIGN-APPROVED.md](../../saivage-v3/SPEC/2026-05/duplicate-active-executor-sessions/DESIGN-APPROVED.md).
- Plan (2 iterations, approved): [03-plan-r2.md](../../saivage-v3/SPEC/2026-05/duplicate-active-executor-sessions/03-plan-r2.md), [PLAN-APPROVED.md](../../saivage-v3/SPEC/2026-05/duplicate-active-executor-sessions/PLAN-APPROVED.md).

The decision in one sentence: **at startup, reconcile every non-terminal worker session manifest to `failed`; at dispatch, refuse to create a second worker session for an `(role, card_id)` that already has one — establishing the invariant "at most one non-terminal worker manifest per `(role ∈ {executor, reviewer}, card_id)` at any instant"**. Workspace rule **architecture-first, no backward compatibility** applies: no shims, no aliases, no migration helpers, dead code deleted.

## Files to change

- [saivage-v3/src/agents/session-persistence.ts](../../saivage-v3/src/agents/session-persistence.ts) — add `WORKER_ROLES`, `DuplicateActiveSessionError`, `reconcileOrphanedWorkerSessions`, `assertNoActiveWorkerSession`. Remove `failActiveWorkerSessions` (L167–L187).
- [saivage-v3/src/agents/agent-adapter.ts](../../saivage-v3/src/agents/agent-adapter.ts) — inside `invokeAgent`, call `assertNoActiveWorkerSession` synchronously between `await this.router.resolve(...)` (L432) and `createSession(...)` (L447), gated to `role === 'executor' || role === 'reviewer'`. No `await` between the precondition and `createSession`.
- [saivage-v3/src/runtime/runtime.ts](../../saivage-v3/src/runtime/runtime.ts) — inside `Runtime.startup`, after `performCrashRecovery()` and before `reconcileProcessRecords(...)`, call `reconcileOrphanedWorkerSessions(join(this.projectRoot, '.saivage'))`; if `swept.length > 0`, emit one `startup_session_sweep` event. Add a one-line clarifying comment above the `_dispatchInFlight` field declaration; do **not** delete `_dispatchInFlight`.
- [saivage-v3/src/events/registry.ts](../../saivage-v3/src/events/registry.ts) — add `startup_session_sweep` entry to `EventRegistry`, placed after the `runtime_fatal_error` entry at L34; schema `payload({ swept_session_ids: z.array(z.string()) })`, domain `runtime`, severity `warning`, tracked/audit/broadcast all true, outbound `operator`.
- [saivage-v3/tests/agents/session-persistence.test.ts](../../saivage-v3/tests/agents/session-persistence.test.ts) — remove any existing `describe('failActiveWorkerSessions', ...)` block; add `describe('reconcileOrphanedWorkerSessions', ...)` and `describe('assertNoActiveWorkerSession', ...)` per design §7 unit-test list.
- [saivage-v3/tests/runtime/startup-session-sweep.test.ts](../../saivage-v3/tests/runtime/startup-session-sweep.test.ts) — **new**, mirror harness pattern at [tests/runtime/f23-dispatch-goal-acceptance.test.ts](../../saivage-v3/tests/runtime/f23-dispatch-goal-acceptance.test.ts#L37-L55) (`initProjectTree` → `Runtime` → `startup`). Pre-seed three executor manifests (`active`, `waiting`, `done`); assert two become `failed` with one `model_issue` system message each, the `done` manifest is byte-identical, one `startup_session_sweep` event was logged, and the HTTP `/api/agents` response reflects the new states.
- [saivage-v3/tests/agents/agent-adapter-dispatch-precondition.test.ts](../../saivage-v3/tests/agents/agent-adapter-dispatch-precondition.test.ts) — **new**, mirror construction pattern at [tests/agents/agent-adapter-executor-fallback.test.ts](../../saivage-v3/tests/agents/agent-adapter-executor-fallback.test.ts) (real `AgentAdapter`, real router with stub LLM transport — *not* `FakeAgentAdapter`, which is a separate `AgentRuntime` implementation). Pre-seed an `active` executor manifest for `(executor, card-X)`; call `invokeExecutor('card-X', ...)`; assert `DuplicateActiveSessionError`, zero LLM-transport calls, no second manifest file created. Repeat for `invokeReviewer`. Add a negative case proving the precondition does not fire when no conflict exists.

## Files / tests / docs to DELETE

- Symbol `failActiveWorkerSessions` in [saivage-v3/src/agents/session-persistence.ts](../../saivage-v3/src/agents/session-persistence.ts#L167-L187) — full function body, signature through closing brace.
- Any existing `describe('failActiveWorkerSessions', ...)` block in [saivage-v3/tests/agents/session-persistence.test.ts](../../saivage-v3/tests/agents/session-persistence.test.ts). If no such block exists, this is a no-op; do not invent one.

**Not deleted**: `_dispatchInFlight` and all its use sites at [saivage-v3/src/runtime/runtime.ts](../../saivage-v3/src/runtime/runtime.ts) L101, L578, L612, L618–L620, L715. Different layer (planner-level re-entrancy), distinct invariant.

## Validation gate

All of the following must pass before moving the proposal to `done/`:

1. `npm run build` clean in `/home/salva/g/ml/saivage-v3/`.
2. The project's full test command (per [saivage-v3/package.json](../../saivage-v3/package.json) `scripts.test`) clean.
3. The new tests above run and pass: `vitest run tests/agents/session-persistence.test.ts tests/runtime/startup-session-sweep.test.ts tests/agents/agent-adapter-dispatch-precondition.test.ts`.
4. **Live E2E against the GetRich v2 deployment** (container `saivage-v3-getrich-v2`, 10.0.3.170, service `saivage-v3-getrich.service`):
   - Before deploy: `curl -s http://10.0.3.170:8080/api/agents | jq '[.sessions[] | select(.status=="active" and .role=="executor")] | length'` shows ≥ 3.
   - Deploy the change. Restart **only** `saivage-v3-getrich.service` on 10.0.3.170 (via `ssh root@10.0.3.170 systemctl restart saivage-v3-getrich.service`). Do **not** touch `saivage.service` on the harness container (10.0.3.112).
   - After restart, before the first new dispatch: same `curl` returns `0`.
   - Tail `.saivage/runtime/events.jsonl` inside the GetRich v2 working tree (`/home/salva/g/ml/getrich-v2/.saivage/runtime/events.jsonl`) for one `{"kind":"startup_session_sweep", ...}` event whose `swept_session_ids` includes `executor-1779816409491-4`, `executor-1779818547816-11`, and `executor-1779818999226-2`.

## Risks / accepted residuals

- The startup sweep marks legitimately running same-process executors `failed` only if they outlive a crash without releasing the project lock; `acquireLock` is exclusive and `performCrashRecovery` runs first, so no concurrent writer exists at sweep time. Accepted: zero residual.
- The dispatch precondition surfaces dispatcher bugs as runtime errors (caught by the existing `dispatchPendingActivations` catch). Accepted: this is the intended behavior — silent retries reintroduce R2.
- Sweep cost scales with project session-file count. Accepted: comparable to existing `/api/agents` listing; no index introduced.
- `_dispatchInFlight` remains an in-process planner-layer guard. Accepted: it is orthogonal to the new manifest invariant, not a parallel system.
- Already-deployed projects (`getrich-v2`, etc.) will have their orphaned manifests cleaned automatically on first restart; no separate migration step.

## Out of scope

- Refactoring [agent-adapter.invokeAgent](../../saivage-v3/src/agents/agent-adapter.ts#L421) beyond the precondition insertion.
- Compaction-in-flight crash safety.
- The `'claimed'` literal vs. `RuntimeActivationStatus` schema mismatch.
- Changing UI / API rendering of session status beyond what the new `failed` transitions naturally produce.
- Touching analyst sessions (analyst is explicitly excluded from `WORKER_ROLES`).
- Collapsing the two-store divergence between session manifests and `runtime-state.json` (Proposal C in the design; long-term direction, not this fix).
- Any work on the F01–F05 UI-port batch (queued separately as `2026-05-26-52..54`).
