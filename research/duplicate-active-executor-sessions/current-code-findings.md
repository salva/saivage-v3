# Duplicate active executor sessions — current-code findings

Date: 2026-05-26
Stage: `mailbox-008-duplicate-active-executor-sessions`
Task: `t1-scope-and-proposals`

## Executive summary

The mailbox proposal is current and concrete. Saivage v3 still has an unused startup-style helper, `failActiveWorkerSessions`, but runtime startup does not call it, and the helper is too broad because it sweeps planner sessions as well as workers. `AgentAdapter.invokeAgent` still creates executor/reviewer manifests without checking whether a non-terminal manifest already exists for the same `(role, card_id)`. `/api/agents` lists persisted manifests, so stale active worker manifests remain user-visible until the persistence layer is corrected.

Recommended implementation: replace `failActiveWorkerSessions` with worker-specific `reconcileOrphanedWorkerSessions` and `assertNoActiveWorkerSession`; call the reconciliation from `Runtime.startup()` after crash recovery; call the precondition in `AgentAdapter.invokeAgent()` immediately before `createSession`; add a typed `startup_session_sweep` event; replace/add focused tests.

## Evidence

| Finding | Current-code citation |
|---|---|
| `failActiveWorkerSessions` exists and fails non-analyst active/waiting sessions. | `src/agents/session-persistence.ts:167-187` |
| Existing test expects planner sessions to be swept too, which conflicts with worker-only invariant. | `tests/agents/session-persistence.test.ts:111-130` |
| `Runtime.startup()` performs crash recovery and process reconciliation but not session manifest reconciliation. | `src/runtime/runtime.ts:596-603` |
| `repairStartupActiveCardRun` repairs `active_card_run`, not agent session manifests. | `src/runtime/runtime.ts:281-327` |
| `AgentAdapter.invokeAgent` resolves candidates then calls `createSession` with no duplicate precondition. | `src/agents/agent-adapter.ts:421-449` |
| `/api/agents` enumerates `.saivage/agents/sessions/*.json`, so stale manifests are exposed directly. | `src/server/routes/runtime-config-notes.ts:113-115` |
| `_dispatchInFlight` is a goal/planner in-process guard, not a persisted worker-session invariant. | `src/runtime/runtime.ts:101`, `src/runtime/runtime.ts:618-620`, `src/runtime/runtime.ts:714-715` |

## Artifacts produced

- `architecture-audit/mailbox-008-duplicate-active-executor-sessions/scope-check.md`
- `architecture-audit/mailbox-008-duplicate-active-executor-sessions/proposals/proposal-direct.md`
- `architecture-audit/mailbox-008-duplicate-active-executor-sessions/proposals/proposal-restructure.md`

## Boundary note

The mailbox proposal references external GetRich deployment paths, SSH, and `systemctl` validation. Those actions are outside the current project boundary. The implementation stage should validate only inside `/work/saivage-v3` and via the provided local e2e service at `127.0.0.1:8090`, without touching services or files outside the workspace.

## Suggested future wave candidate

After the urgent direct fix, consider a refactor wave to centralize agent session lifecycle policy behind a store/service abstraction. Today, policy is split between `session-persistence.ts`, `AgentAdapter`, fake agents, runtime startup, and server route JSON parsing.
