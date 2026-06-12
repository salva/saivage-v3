# Design APPROVED

Approved file: [02-design-r3.md](./02-design-r3.md).

Iterations: r1 (3 findings: stale session-persistence.ts citations, stale runtime.ts and agent-adapter.ts citations including the nonexistent `src/persistence/runtime-state.ts` path, wrong claim about where the worker-only gate lived) → r2 (1 finding: stale `/api/agents` line) → r3 APPROVED.

Selected proposal: B — global single-active-non-analyst sweep + global precondition + reconcile `current_agent_session_id` when it referenced a swept session. Old worker-uniqueness surface deleted in the same change (`WORKER_ROLES`, `NON_TERMINAL_SESSION_STATUSES`, `reconcileOrphanedWorkerSessions`, `assertNoActiveWorkerSession`, `DuplicateActiveSessionError`).

Verdict source: GPT-5.5 reviewer, no blocking findings.
