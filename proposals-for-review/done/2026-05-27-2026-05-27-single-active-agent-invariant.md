# Design: Replace per-(role, cardId) worker uniqueness with the global single-active-non-analyst-session invariant

## Problem

The currently-shipped startup-sweep + dispatch-precondition pair in
[src/agents/session-persistence.ts](../src/agents/session-persistence.ts) and
[src/agents/agent-adapter.ts](../src/agents/agent-adapter.ts), wired in at
[src/runtime/runtime.ts L603](../src/runtime/runtime.ts#L603), encodes the wrong
invariant. It gates uniqueness per `(role, cardId)` for `role ∈ {executor, reviewer}`
and sweeps `'active'` *and* `'waiting'` worker manifests.

The architectural invariant that actually governs saivage v3 is global and
call-stack-shaped:

> **At any instant, at most one non-analyst session has `status: 'active'`.**
> Sessions suspended on the call stack are `'waiting'`, not `'active'`. Analysts
> are excluded (separate operator-chat surface, not part of the
> planner→executor/reviewer call stack).

This is a corrective change to an already-shipped fix that encoded a strictly
weaker, misaligned invariant. The full reasoning, alternatives, and
verification approach are in three companion documents that must be read
before implementation:

- [SPEC/2026-05/single-active-agent-invariant/01-analysis-r3.md](../SPEC/2026-05/single-active-agent-invariant/01-analysis-r3.md)
- [SPEC/2026-05/single-active-agent-invariant/02-design-r3.md](../SPEC/2026-05/single-active-agent-invariant/02-design-r3.md)
- [SPEC/2026-05/single-active-agent-invariant/03-plan-r3.md](../SPEC/2026-05/single-active-agent-invariant/03-plan-r3.md)

All three are reviewer-approved (see `ANALYSIS-APPROVED.md`, `DESIGN-APPROVED.md`,
`PLAN-APPROVED.md` in the same directory). This proposal is binding on the
harness: implement exactly what the plan specifies, with at most a
delta-proposal mini-cycle for unavoidable deviations.

## Decision

Implement the design selected in
[02-design-r3.md §4](../SPEC/2026-05/single-active-agent-invariant/02-design-r3.md)
(Proposal B: in-place rename + broadened predicates + reconcile
`current_agent_session_id` on sweep) following the executable changelist in
[03-plan-r3.md](../SPEC/2026-05/single-active-agent-invariant/03-plan-r3.md).

Binding workspace rule: **architecture-first, no backward compatibility**. The
old worker-uniqueness surface must be deleted in the same commit that introduces
the new global surface. No aliases, no shims, no parallel systems.

The new on-disk and runtime contract:

- `reconcileOrphanedAgentSessions(saivageDir, reason?)` — startup sweep.
  Iterates `listSessions`; for any session with `role !== 'analyst' && status === 'active'`,
  transitions to `'failed'` via `completeSession` and appends one `model_issue`
  message. Returns the swept array. Does not touch `'waiting'` sessions, does
  not touch `'analyst'` sessions, does not touch terminal sessions.
- `assertNoActiveAgentSession(saivageDir, newRole)` — dispatch precondition.
  Returns immediately when `newRole === 'analyst'`. Otherwise scans
  `listSessions` and throws `ConcurrentAgentSessionError` on the first session
  with `role !== 'analyst' && status === 'active'`. No `cardId` parameter; the
  invariant is global.
- `ConcurrentAgentSessionError(newRole, conflictingSessionId, conflictingRole, conflictingCardId)` —
  thrown by the precondition.
- `Runtime.startup`: the sweep is moved to run **after** `repairStartupActiveCardRun`
  returns (not before, as currently shipped). After the sweep, if
  `current_agent_session_id` (re-read from runtime state) is in the swept set,
  it is cleared to `null` via `updateRuntimeState`. See plan §3 Step 3 for the
  exact sketch and the sequencing rationale.
- `AgentAdapter.dispatchSession` (around [agent-adapter.ts L273](../src/agents/agent-adapter.ts#L273))
  calls `assertNoActiveAgentSession(this.saivageDir, role)` synchronously,
  immediately before `createSession`, with no intervening `await`.

The `startup_session_sweep` event kind, the `_dispatchInFlight` goal-level
re-entrancy guard, and the on-disk `AgentSession` / `SessionStatus` schemas are
**unchanged**.

## Files to change

Source (atomic in one commit):

- `src/agents/session-persistence.ts` — delete `WORKER_ROLES`,
  `NON_TERMINAL_SESSION_STATUSES`, `DuplicateActiveSessionError`,
  `reconcileOrphanedWorkerSessions`, `assertNoActiveWorkerSession`. Add
  `ConcurrentAgentSessionError`, `reconcileOrphanedAgentSessions`,
  `assertNoActiveAgentSession`. Keep `SessionStatus` import (still used by
  `setSessionStatus`).
- `src/agents/agent-adapter.ts` — replace the import and the call site at L273
  with the new symbol; drop the `cardId` argument.
- `src/runtime/runtime.ts` — replace the import; move the sweep block from
  L603–L608 to immediately **after** `repairStartupActiveCardRun(state)` returns;
  add the `current_agent_session_id` singleton reconciliation block; update the
  `_dispatchInFlight` inline comment at L102 (the field itself is preserved).

Tests rewritten in place (same commit):

- `tests/agents/session-persistence.test.ts` — rewrite the two `describe`
  blocks at L111–L162 against the new invariant.
- `tests/agents/agent-adapter-dispatch-precondition.test.ts` — rewrite the three
  `it(…)` cases at L54–L82 with six cases covering the new global invariant.
- `tests/runtime/startup-session-sweep.test.ts` — rewrite the single `it(…)` case
  at L44–L70 to cover the broadened sweep predicate and the singleton-reconcile
  behavior.

See [03-plan-r3.md §3](../SPEC/2026-05/single-active-agent-invariant/03-plan-r3.md)
for the precise sketches.

## Files / tests / docs to DELETE

No file deletions. All deletions are in-file (symbols listed above). The three
existing test files are rewritten in place, not removed.

No on-disk schema changes. No data migration.

## Validation gate

All four gates must pass in order before the change is considered complete.

**G1 — Compile clean.**

```bash
cd /home/salva/g/ml/saivage-v3 && npm run build
```

The `tsc` segment must succeed with zero errors.

**G2 — Grep is clean.**

```bash
cd /home/salva/g/ml/saivage-v3
grep -rn 'WORKER_ROLES\|NON_TERMINAL_SESSION_STATUSES\|reconcileOrphanedWorkerSessions\|assertNoActiveWorkerSession\|DuplicateActiveSessionError' src/ tests/
# Expected: zero matches.
grep -rn 'reconcileOrphanedAgentSessions\|assertNoActiveAgentSession\|ConcurrentAgentSessionError' src/ tests/
# Expected: three declarations in src/agents/session-persistence.ts, one call
# site each in src/agents/agent-adapter.ts and src/runtime/runtime.ts, plus
# assertions in the three rewritten test files.
grep -n '_dispatchInFlight' src/runtime/runtime.ts | wc -l
# Expected: 7 (unchanged).
grep -n 'startup_session_sweep' src/schemas/event-catalog.ts
# Expected: one declaration at L35, unchanged.
```

**G3 — Test suite passes.**

```bash
cd /home/salva/g/ml/saivage-v3 && npm test
```

The three rewritten test files must pass; no other tests must regress.

**G4 — Live E2E on `saivage-v3-getrich-v2` (10.0.3.170).**

Restricted to the `saivage-v3-getrich.service` deployment on container
`saivage-v3-getrich-v2`. **Do not touch** `saivage.service` on container
`saivage-v3` (10.0.3.112).

```bash
# Capture pre-restart orphan count.
ssh root@10.0.3.170 'curl -fsS http://127.0.0.1:8080/api/agents | jq "[.sessions[] | select(.status==\"active\" and .role != \"analyst\")] | length"'

# Restart the deployment service.
ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service && sleep 4 && systemctl is-active saivage-v3-getrich.service && curl -fsS http://127.0.0.1:8080/health'

# Post-restart count, before the next dispatch tick.
ssh root@10.0.3.170 'curl -fsS http://127.0.0.1:8080/api/agents | jq "[.sessions[] | select(.status==\"active\" and .role != \"analyst\")] | length"'
# Expected: 0.

# One sweep event with the pre-restart orphan ids.
ssh root@10.0.3.170 "grep -F '\"startup_session_sweep\"' /work/getrich-v2/.saivage/runtime/events.jsonl | tail -1 | jq ."

# Singleton reconciliation fired. Authoritative path is .saivage/tmp/state/runtime.json.
ssh root@10.0.3.170 "jq '.current_agent_session_id' /work/getrich-v2/.saivage/tmp/state/runtime.json"
# Expected: null (if the pre-restart singleton pointed at a swept session) or an
# id outside the swept set (analyst, or already null).
```

The exact container working-dir prefix (`/work/getrich-v2/...`) follows the
bind-mount layout recorded in `/memories/repo/saivage-v3-getrich-v2-bind-mounts.json`;
verify before running `jq`/`grep` against `.saivage/`.

## Risks / accepted residuals

- **Sweeping an `'active'` planner marks it `'failed'`.** Intended. At process
  restart there is no live JS frame; an `'active'` planner is by definition an
  orphan. Accepted.
- **Singleton reconciliation depends on sweep ordering.** The sweep must run
  **after** `repairStartupActiveCardRun`, because repair writes
  `current_agent_session_id` back to `run.planner_session_id` at
  [runtime.ts L320–L323](../src/runtime/runtime.ts#L320-L323) based on the
  pre-sweep snapshot. The plan's Step 3 sketch enforces this ordering; do not
  invert it. Accepted as the canonical sequencing.
- **`current_agent_session_id` and the manifest store remain two sources of
  truth.** This change only *reconciles* them at the sweep moment; it does not
  unify them. The deeper unification (collapse to a single store) is a future
  change. Accepted residual.
- **The three orphan executors observed on `saivage-v3-getrich-v2` remain
  cleaned** by the broadened sweep. Pre-existing bug must not regress.

## Out of scope

- Refactoring `current_agent_session_id` to be derived from the manifest store.
- Adding assertions on every `current_agent_session_id` write site.
- Compaction-in-flight crash safety.
- Anything in `web/` or analyst code paths.
- Changing `_dispatchInFlight` semantics, scope, or name.
- Reverting the existing deletion of `failActiveWorkerSessions`.
- Touching `saivage.service` on container `saivage-v3` (10.0.3.112). The
  harness must not restart its own service.
