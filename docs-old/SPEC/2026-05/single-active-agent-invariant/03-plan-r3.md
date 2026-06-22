# Plan — Executable changelist for single-active-non-analyst-session invariant

Binding workspace rule: **architecture-first, no backward compatibility**. The currently-shipped worker-uniqueness surface is deleted in the same change that introduces the new global surface.

## 1. Overview

This change replaces the misencoded per-`(role, cardId)` worker-uniqueness invariant (currently in [src/agents/session-persistence.ts](../../../src/agents/session-persistence.ts), [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts), and [src/runtime/runtime.ts](../../../src/runtime/runtime.ts)) with the architecturally correct global invariant: **at any instant at most one non-analyst session has `status: 'active'`**, planners included; `'waiting'` is the legitimate suspended-call-frame state and is preserved across restarts. The startup sweep is broadened to all non-analyst sessions in `'active'` (planners + workers, analyst excluded) and narrowed in status (only `'active'`, never `'waiting'`); the dispatch precondition is broadened to a global check (any non-analyst `'active'` blocks any new non-analyst session); the runtime-state singleton `current_agent_session_id` (persisted at [.saivage/tmp/state/runtime.json](../../../src/runtime/state.ts#L28-L29)) is reconciled to `null` when it pointed at a just-swept session. The misnamed module surface (`WORKER_ROLES`, `NON_TERMINAL_SESSION_STATUSES`, `reconcileOrphanedWorkerSessions`, `assertNoActiveWorkerSession`, `DuplicateActiveSessionError`) and the three test files written against it are deleted/rewritten in the same commit.

## 2. Preconditions

- **Code root.** `/home/salva/g/ml/saivage-v3`.
- **No on-disk schema change.** `AgentSession`, `SessionStatus`, `current_agent_session_id` field shape are all preserved.
- **`_dispatchInFlight` is kept and not renamed.** It operates at the goal-level `dispatchGoal(goalId)` re-entrancy layer and is orthogonal to the session-manifest invariant.
- **Sweep event kind `startup_session_sweep` is kept verbatim.** Payload `{ swept_session_ids: string[] }` is invariant-agnostic.
- **`failActiveWorkerSessions` is already removed** from the codebase and stays removed.

## 3. Sequenced changesets

Steps 1–4 must land atomically in a single commit (so the TypeScript compiler sees a coherent rename, and no intermediate state has both name sets simultaneously). Steps 5–7 are tests in the same commit. Step 8 is validation.

### Step 1 — Replace the module surface in [src/agents/session-persistence.ts](../../../src/agents/session-persistence.ts)

**Symbols deleted (verified at exact lines):**

- [`WORKER_ROLES`](../../../src/agents/session-persistence.ts#L17) (L17)
- [`NON_TERMINAL_SESSION_STATUSES`](../../../src/agents/session-persistence.ts#L18) (L18)
- [`DuplicateActiveSessionError`](../../../src/agents/session-persistence.ts#L170) (L170–L175)
- [`reconcileOrphanedWorkerSessions`](../../../src/agents/session-persistence.ts#L177) (L177–L195)
- [`assertNoActiveWorkerSession`](../../../src/agents/session-persistence.ts#L199) (L199–L213)

**Symbols added (in the same positions, replacing the deleted ones):**

- `ConcurrentAgentSessionError` (replaces `DuplicateActiveSessionError`)
- `reconcileOrphanedAgentSessions` (replaces `reconcileOrphanedWorkerSessions`)
- `assertNoActiveAgentSession` (replaces `assertNoActiveWorkerSession`)

Both module-private `WORKER_ROLES`/`NON_TERMINAL_SESSION_STATUSES` constants disappear without replacement; the new functions inline the predicates `role !== 'analyst'` and `status === 'active'`.

**Sketch.** New module section between [`markSessionWaiting`](../../../src/agents/session-persistence.ts#L166) and [`updateSessionModel`](../../../src/agents/session-persistence.ts#L215):

```ts
export class ConcurrentAgentSessionError extends Error {
  constructor(
    public readonly newRole: AgentRole,
    public readonly conflictingSessionId: string,
    public readonly conflictingRole: AgentRole,
    public readonly conflictingCardId: string | null,
  ) {
    super(
      `Cannot start ${newRole} session: a non-analyst session ` +
      `'${conflictingSessionId}' (role=${conflictingRole}, card_id=${conflictingCardId ?? 'null'}) ` +
      `already has status 'active'. At most one non-analyst session may be active at a time.`,
    );
    this.name = 'ConcurrentAgentSessionError';
  }
}

export function reconcileOrphanedAgentSessions(
  saivageDir: string,
  reason = "Session was left active by a previous runtime process and was failed during startup reconciliation. The runtime now enforces a global single-active-non-analyst-session invariant.",
): AgentSession[] {
  const swept: AgentSession[] = [];
  for (const sessionId of listSessions(saivageDir)) {
    const session = getSession(saivageDir, sessionId);
    if (!session || session.role === 'analyst' || session.status !== 'active') continue;
    const updated = completeSession(saivageDir, session.id, 'failed');
    appendMessage(saivageDir, session.id, { role: 'system', kind: 'model_issue', content: reason });
    swept.push(updated);
  }
  return swept;
}

export function assertNoActiveAgentSession(saivageDir: string, newRole: AgentRole): void {
  if (newRole === 'analyst') return;
  for (const sessionId of listSessions(saivageDir)) {
    const session = getSession(saivageDir, sessionId);
    if (!session) continue;
    if (session.role !== 'analyst' && session.status === 'active') {
      throw new ConcurrentAgentSessionError(newRole, session.id, session.role, session.card_id);
    }
  }
}
```

The `SessionStatus` import at [L12](../../../src/agents/session-persistence.ts#L12) remains required by [`setSessionStatus`](../../../src/agents/session-persistence.ts#L141-L160); do **not** drop it.

**Verification:** `cd /home/salva/g/ml/saivage-v3 && grep -n 'WORKER_ROLES\|NON_TERMINAL_SESSION_STATUSES\|DuplicateActiveSessionError\|reconcileOrphanedWorkerSessions\|assertNoActiveWorkerSession' src/agents/session-persistence.ts` — must return zero matches. `grep -n 'ConcurrentAgentSessionError\|reconcileOrphanedAgentSessions\|assertNoActiveAgentSession' src/agents/session-persistence.ts` — must return three declarations.

**Rollback:** `git checkout src/agents/session-persistence.ts`.

### Step 2 — Rewire the dispatch precondition call in [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts)

**Symbols modified (verified):**

- Named import on [L7](../../../src/agents/agent-adapter.ts#L7): `assertNoActiveWorkerSession` → `assertNoActiveAgentSession`.
- Call site on [L273](../../../src/agents/agent-adapter.ts#L273): change to the new signature.

The synchronous-no-await window required by design C3 is preserved by construction: `await this.router.resolve(...)` is at [L258](../../../src/agents/agent-adapter.ts#L258); the call site at L273 is followed by `createSession` at [L274](../../../src/agents/agent-adapter.ts#L274); nothing between L258 and L274 is `await`ed (the `candidates.length === 0` guard at L259–L272 contains `throw` only, no `await`).

**Sketch.** Imports (current L7):

```ts
import { createSession, completeSession, appendMessage, getSession, getSessionMessages, markSessionWaiting, updateSessionModel, assertNoActiveAgentSession } from './session-persistence.js';
```

Call site (current L273, one-line replacement; L274 unchanged):

```ts
    assertNoActiveAgentSession(this.saivageDir, role as import('../schemas/types.js').AgentRole);
    const session = createSession(this.saivageDir, role as import('../schemas/types.js').AgentRole, goalId, cardId, undefined, requestedSessionId);
```

The `cardId` argument is dropped from the precondition call (the new function does not take one). The previous worker-only gate lived inside [`assertNoActiveWorkerSession`](../../../src/agents/session-persistence.ts#L204), not at the call site; the new function self-gates on `newRole === 'analyst'`, so the call site stays a single unconditional line. The precondition now extends to planner invocations — by design (planner deterministic-ID re-entry passes because the previous manifest is in status `'waiting'`, not `'active'`).

**Verification:** `cd /home/salva/g/ml/saivage-v3 && grep -n 'assertNoActiveAgentSession\|assertNoActiveWorkerSession' src/agents/agent-adapter.ts` — must show the new name in the import and at L273, zero matches of the old name. `npx tsc --noEmit` must compile.

**Rollback:** `git checkout src/agents/agent-adapter.ts`.

### Step 3 — Rewire the startup sweep and reconcile the singleton in [src/runtime/runtime.ts](../../../src/runtime/runtime.ts)

**Symbols modified (verified):**

- Named import on [L24](../../../src/runtime/runtime.ts#L24): `reconcileOrphanedWorkerSessions` → `reconcileOrphanedAgentSessions`. `readRuntimeState` (L27) and `updateRuntimeState` (L29) are already imported from `./state.js` (see [runtime.ts:25-35](../../../src/runtime/runtime.ts#L25-L35)); no new imports needed.
- Inline comment on the [`_dispatchInFlight` field declaration at L102](../../../src/runtime/runtime.ts#L102): replace the text only; the field name and type are unchanged (C7).
- [`Runtime.startup`](../../../src/runtime/runtime.ts#L597) sweep block at [L603–L608](../../../src/runtime/runtime.ts#L603-L608): **remove** the sweep from its current position (between `performCrashRecovery` and `reconcileProcessRecords`) and **re-insert** it immediately **after** the [`repairStartupActiveCardRun(state)`](../../../src/runtime/runtime.ts#L612) call. Rationale: `repairStartupActiveCardRun` writes `current_agent_session_id` back to `run.planner_session_id` ([runtime.ts L320–L323](../../../src/runtime/runtime.ts#L320-L323)) based on the pre-sweep snapshot. If the sweep runs first and clears the singleton, repair undoes the clear. Running the sweep last lets it observe the freshly-repaired state, fail any non-analyst session that is still `'active'` (including a planner session that repair just re-pointed the singleton at), and then reconcile the singleton by re-reading the post-repair state.

**Sketch.** Import line (current L24):

```ts
import { reconcileOrphanedAgentSessions } from '../agents/session-persistence.js';
```

Inline comment on the field (current L102):

```ts
    /* Goal-level re-entrancy guard for dispatchGoal(goalId); the global single-active-non-analyst-session invariant is enforced by assertNoActiveAgentSession in session persistence. */
    private _dispatchInFlight = new Set<string>();
```

Startup ordering change (current L600–L614). Delete the existing sweep block at L603–L608 and insert the new sweep block after `repairStartupActiveCardRun` returns. The resulting `startup` body around L600–L614 becomes:

```ts
    await this.performCrashRecovery();
    reconcileProcessRecords(this.projectRoot);
    if (state.running_processes && state.running_processes.length > 0) { this.runningProcesses.clear(); }
    this._startupRepairPending = true;
    const repairedState = await this.repairStartupActiveCardRun(state);
    this._startupRepairPending = false;
    if (!repairedState) state = initRuntimeState(this.projectRoot); else state = repairedState;
    const swept = reconcileOrphanedAgentSessions(join(this.projectRoot, '.saivage'));
    if (swept.length > 0) {
      const sweptSessionIds = swept.map((session) => session.id);
      this.emit('startup_session_sweep', { swept_session_ids: sweptSessionIds });
      this._eventLogger.appendEvent({ kind: 'startup_session_sweep', swept_session_ids: sweptSessionIds });
      const sweptSet = new Set(sweptSessionIds);
      const postRepairState = readRuntimeState(this.projectRoot);
      if (postRepairState && postRepairState.current_agent_session_id && sweptSet.has(postRepairState.current_agent_session_id)) {
        updateRuntimeState(this.projectRoot, { current_agent_session_id: null });
        state = readRuntimeState(this.projectRoot) ?? state;
      }
    }
```

The singleton reconciliation re-reads runtime state **after** the sweep so it observes the post-repair value, not the pre-sweep snapshot. If the sweep cleared the singleton, `state` is refreshed so the rest of `startup` (the `this._paused = state.paused` line and the `'started'` event emission) sees the post-clear value.

The other six `_dispatchInFlight` sites at [L579, L619 (×2), L626, L627, L722](../../../src/runtime/runtime.ts#L579) are not touched (C7). The `startup_session_sweep` event kind at [src/schemas/event-catalog.ts:35](../../../src/schemas/event-catalog.ts#L35) is not touched (design §5.5).

**Verification:**

```bash
cd /home/salva/g/ml/saivage-v3
grep -n 'reconcileOrphanedAgentSessions\|reconcileOrphanedWorkerSessions' src/runtime/runtime.ts   # new name only
grep -n '_dispatchInFlight' src/runtime/runtime.ts | wc -l                                        # still 7 hits
grep -n 'startup_session_sweep' src/schemas/event-catalog.ts                                       # unchanged
npx tsc --noEmit                                                                                   # clean
```

**Rollback:** `git checkout src/runtime/runtime.ts`.

### Step 4 — Cross-tree compile-check

No code change. Confirm the rename produced no orphaned references outside the three production files above.

**Verification:**

```bash
cd /home/salva/g/ml/saivage-v3
grep -rn 'WORKER_ROLES\|NON_TERMINAL_SESSION_STATUSES\|reconcileOrphanedWorkerSessions\|assertNoActiveWorkerSession\|DuplicateActiveSessionError' src/ tests/
# Expected: zero matches.
grep -rn 'reconcileOrphanedAgentSessions\|assertNoActiveAgentSession\|ConcurrentAgentSessionError' src/ tests/
# Expected: declarations in src/agents/session-persistence.ts, one call site each in
# src/agents/agent-adapter.ts and src/runtime/runtime.ts, plus the three test files
# rewritten in steps 5-7.
```

**Rollback:** N/A (read-only verification step).

### Step 5 — Rewrite [tests/agents/session-persistence.test.ts](../../../tests/agents/session-persistence.test.ts) unit blocks (L111–L162)

Replace the two existing `describe` blocks (`reconcileOrphanedWorkerSessions` at [L111](../../../tests/agents/session-persistence.test.ts#L111) and `assertNoActiveWorkerSession` at [L140](../../../tests/agents/session-persistence.test.ts#L140)) with two new blocks, keeping the surrounding test harness (`SAIVAGE_DIR`, `beforeEach`, etc.) unchanged.

**Sketch (block heads only):**

```ts
  describe('reconcileOrphanedAgentSessions', () => {
    it('sweeps active planner', () => { /* planner active → failed + one model_issue */ });
    it('sweeps active executor and reviewer; analyst untouched', () => { /* … */ });
    it('does NOT sweep waiting planner', () => { /* byte-identical file before/after */ });
    it('does NOT sweep terminal manifests (done/failed/blocked)', () => { /* byte-identical */ });
    it('is idempotent', () => { /* second call returns [] */ });
  });

  describe('assertNoActiveAgentSession', () => {
    it('throws when an active planner blocks a new executor', () => { /* ConcurrentAgentSessionError */ });
    it('throws when an active executor blocks a new executor on a different card', () => { /* … */ });
    it('throws when an active executor blocks a new reviewer (cross-role)', () => { /* … */ });
    it('does NOT throw on planner deterministic-ID re-entry from waiting', () => { /* status==='waiting' */ });
    it('does NOT throw when the new role is analyst, even with an active executor present', () => { /* … */ });
    it('does NOT throw when only terminal manifests exist, or when only an active analyst exists', () => { /* … */ });
  });
```

Each case asserts (a) the function's return/throw behavior and (b) on-disk manifest invariants where applicable (manifest unchanged for non-swept, `'failed'` + one `model_issue` for swept). Error payload assertions for `ConcurrentAgentSessionError` check `newRole`, `conflictingSessionId`, `conflictingRole`, `conflictingCardId`.

**Verification:** `cd /home/salva/g/ml/saivage-v3 && npm test -- tests/agents/session-persistence.test.ts`.

**Rollback:** `git checkout tests/agents/session-persistence.test.ts`.

### Step 6 — Rewrite [tests/runtime/startup-session-sweep.test.ts](../../../tests/runtime/startup-session-sweep.test.ts)

Replace the single existing `it('fails orphaned active/waiting workers, …')` block ([L44–L70](../../../tests/runtime/startup-session-sweep.test.ts#L44-L70)) with a single block encoding the new global invariant. Keep `NoopAgentRuntime`, `readEvents`, `initProjectTree`, the `beforeEach`/`afterEach` harness, and the `describe('startup worker session sweep')` outer name. Rename the outer `describe` to `'startup agent session sweep'` for clarity.

**Sketch (single case):**

```ts
  it('sweeps active non-analyst sessions, preserves waiting planner and analyst, logs one sweep event, clears stale current_agent_session_id', async () => {
    const activeExecutor = createSession(saivageDir, 'executor', 'goal-1', 'card-1');
    const activeReviewer = createSession(saivageDir, 'reviewer', 'goal-1', 'goal-1');
    const activePlanner  = createSession(saivageDir, 'planner',  'goal-1', 'goal-1');                  // planner:goal-1
    const waitingPlanner = createSession(saivageDir, 'planner',  'goal-2', 'goal-2');                  // planner:goal-2
    const doneExecutor   = createSession(saivageDir, 'executor', 'goal-1', 'card-3');
    const analyst        = createSession(saivageDir, 'analyst');
    markSessionWaiting(saivageDir, waitingPlanner.id);
    completeSession(saivageDir, doneExecutor.id, 'done');
    const waitingBefore = readFileSync(join(saivageDir, 'agents', 'sessions', `${waitingPlanner.id}.json`), 'utf8');
    const analystBefore = readFileSync(join(saivageDir, 'agents', 'sessions', `${analyst.id}.json`), 'utf8');
    updateRuntimeState(projectRoot, { current_agent_session_id: activePlanner.id });

    const runtime = new Runtime({ projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' } }, new NoopAgentRuntime());
    await runtime.startup();
    await runtime.shutdown();

    // Active non-analyst → failed + one model_issue.
    for (const id of [activeExecutor.id, activeReviewer.id, activePlanner.id]) {
      expect(getSession(saivageDir, id)?.status).toBe('failed');
      expect(getSessionMessages(saivageDir, id)).toEqual([expect.objectContaining({ role: 'system', kind: 'model_issue' })]);
    }
    // Waiting planner and analyst untouched (byte-identical).
    expect(readFileSync(join(saivageDir, 'agents', 'sessions', `${waitingPlanner.id}.json`), 'utf8')).toBe(waitingBefore);
    expect(readFileSync(join(saivageDir, 'agents', 'sessions', `${analyst.id}.json`), 'utf8')).toBe(analystBefore);
    // Sweep event.
    const sweepEvents = readEvents(projectRoot).filter((e) => e.kind === 'startup_session_sweep');
    expect(sweepEvents).toHaveLength(1);
    expect((sweepEvents[0].swept_session_ids as string[]).sort()).toEqual(
      [activeExecutor.id, activeReviewer.id, activePlanner.id].sort(),
    );
    // Proposal B: stale singleton cleared.
    expect(readRuntimeState(projectRoot)?.current_agent_session_id).toBeNull();
  });
```

`updateRuntimeState` and `readRuntimeState` are imported from `../../src/runtime/state.js` (the actual source; `src/persistence/index.ts` does not re-export them). `shutdown()` clears `current_agent_session_id` to `null` as part of normal teardown, so the singleton-cleared assertion is captured by reading state right after `startup()` and before `shutdown()` — the test must read it in that order:

```ts
    await runtime.startup();
    const stateAfterStartup = readRuntimeState(projectRoot);
    await runtime.shutdown();
    expect(stateAfterStartup?.current_agent_session_id).toBeNull();
```

**Verification:** `cd /home/salva/g/ml/saivage-v3 && npm test -- tests/runtime/startup-session-sweep.test.ts`.

**Rollback:** `git checkout tests/runtime/startup-session-sweep.test.ts`.

### Step 7 — Rewrite [tests/agents/agent-adapter-dispatch-precondition.test.ts](../../../tests/agents/agent-adapter-dispatch-precondition.test.ts)

Replace the three existing `it(…)` cases ([L54–L82](../../../tests/agents/agent-adapter-dispatch-precondition.test.ts#L54-L82)) with the seven cases listed below. Keep `createMinimalAdapter` ([L10–L26](../../../tests/agents/agent-adapter-dispatch-precondition.test.ts#L10)), the `beforeEach`/`afterEach` harness, and the `router.resolve` + `llmCallFn` stubs. Rename the outer `describe` from `'AgentAdapter worker dispatch precondition'` to `'AgentAdapter dispatch precondition'`. Update the import on [L8](../../../tests/agents/agent-adapter-dispatch-precondition.test.ts#L8): `DuplicateActiveSessionError` → `ConcurrentAgentSessionError`; add `markSessionWaiting`.

**Sketch (case heads only):**

```ts
  it('rejects new executor when an active executor exists on a different card', async () => {
    createSession(saivageDir, 'executor', 'goal-1', 'card-A');
    const before = listSessions(saivageDir);
    await expect(adapter.invokeExecutor('card-B', 'goal-1', 'prompt')).rejects.toThrow(ConcurrentAgentSessionError);
    expect(llmCallFn).not.toHaveBeenCalled();
    expect(listSessions(saivageDir).sort()).toEqual(before.sort());
  });
  it('rejects new executor when an active planner exists', async () => { /* planner active blocks executor */ });
  it('rejects new reviewer when an active executor exists (cross-role)', async () => { /* … */ });
  it('allows planner deterministic-ID re-entry from waiting', async () => {
    createSession(saivageDir, 'planner', 'goal-1', 'goal-1');
    markSessionWaiting(saivageDir, 'planner:goal-1');
    await adapter.invokePlanner('goal-1', 'systemPrompt', []);
    expect(getSession(saivageDir, 'planner:goal-1')?.status).toBe('active');
    expect(llmCallFn).toHaveBeenCalledTimes(1);
  });
  it('does not block executor dispatch when only an active analyst exists', async () => { /* analyst exempt */ });
  it('allows non-conflicting executor dispatch and creates one session', async () => { /* clean run */ });
```

Per design §11 open choice O1, the "new analyst is not blocked" case is dropped from this integration file (covered by §9.1 case 5 directly against `assertNoActiveAgentSession`). The total is six cases.

The `invokePlanner` case stubs the LLM to return a planner-shaped JSON result; existing `createMinimalAdapter` already wires `setLlmCallFn`. If `invokePlanner`'s router resolution path differs from executor/reviewer, the `jest.spyOn(adapter.router, 'resolve').mockResolvedValue([…])` in `beforeEach` already covers it (the stub is unconditional on role).

**Verification:** `cd /home/salva/g/ml/saivage-v3 && npm test -- tests/agents/agent-adapter-dispatch-precondition.test.ts`.

**Rollback:** `git checkout tests/agents/agent-adapter-dispatch-precondition.test.ts`.

### Step 8 — Full validation (see §6)

No code change.

## 4. Test additions / replacements

No new test files (design §7: "Created. None."). Three existing test files are rewritten in place:

- [tests/agents/session-persistence.test.ts](../../../tests/agents/session-persistence.test.ts) — rewrite the two `describe` blocks at L111–L162:
  - `describe('reconcileOrphanedAgentSessions', …)` — 5 cases (active planner swept; executor+reviewer swept, analyst untouched; waiting planner not swept; terminal manifests untouched; idempotent).
  - `describe('assertNoActiveAgentSession', …)` — 6 cases (active planner blocks new executor; active executor blocks new executor on different card; cross-role; planner waiting → re-entry passes; analyst exempt as new role; analyst as conflicting side is not a conflict + terminal-only is not a conflict).
- [tests/runtime/startup-session-sweep.test.ts](../../../tests/runtime/startup-session-sweep.test.ts) — rewrite the single `it(…)` block:
  - One case: sweeps active executor + active reviewer + active planner → all failed + one `model_issue` each; waiting planner byte-identical; analyst byte-identical; one `startup_session_sweep` event with the three swept ids; `current_agent_session_id` cleared to `null` (Proposal B) when it pointed at the swept active planner.
- [tests/agents/agent-adapter-dispatch-precondition.test.ts](../../../tests/agents/agent-adapter-dispatch-precondition.test.ts) — rewrite the three `it(…)` cases:
  - 6 cases (active executor blocks executor on different card; active planner blocks executor; cross-role active executor blocks reviewer; waiting planner allows planner re-entry; active analyst does not block executor; clean run creates one session).

## 5. Deletions

| File | Lines | Symbol | Why |
|---|---|---|---|
| [src/agents/session-persistence.ts](../../../src/agents/session-persistence.ts#L17) | L17 | `const WORKER_ROLES` | Encodes the wrong role predicate (`'executor'`+`'reviewer'`); the corrected predicate is `role !== 'analyst'` and is inlined in the two new functions. Zero external consumers (verified §6). |
| [src/agents/session-persistence.ts](../../../src/agents/session-persistence.ts#L18) | L18 | `const NON_TERMINAL_SESSION_STATUSES` | Encodes the wrong status predicate (`'active'`+`'waiting'`); the corrected sweep predicate is `status === 'active'` only and the corrected precondition predicate is also `status === 'active'`, inlined in the two new functions. Zero external consumers. |
| [src/agents/session-persistence.ts](../../../src/agents/session-persistence.ts#L170-L175) | L170–L175 | `class DuplicateActiveSessionError` | Replaced by `ConcurrentAgentSessionError` (different name, different payload, different message). No backward-compat alias. |
| [src/agents/session-persistence.ts](../../../src/agents/session-persistence.ts#L177-L195) | L177–L195 | `function reconcileOrphanedWorkerSessions` | Replaced by `reconcileOrphanedAgentSessions`. Different role and status predicates. |
| [src/agents/session-persistence.ts](../../../src/agents/session-persistence.ts#L199-L213) | L199–L213 | `function assertNoActiveWorkerSession` | Replaced by `assertNoActiveAgentSession`. Different signature (drops `cardId`), different predicate (global). |
| [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts#L7) | L7 (import) | `assertNoActiveWorkerSession` (named import) | Replaced by `assertNoActiveAgentSession`. |
| [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts#L273) | L273 | Call: `assertNoActiveWorkerSession(this.saivageDir, role, cardId)` | Replaced by `assertNoActiveAgentSession(this.saivageDir, role)`; the `cardId` argument is gone. |
| [src/runtime/runtime.ts](../../../src/runtime/runtime.ts#L24) | L24 (import) | `reconcileOrphanedWorkerSessions` (named import) | Replaced by `reconcileOrphanedAgentSessions`. |
| [src/runtime/runtime.ts](../../../src/runtime/runtime.ts#L102) | L102 (comment) | Inline comment text on `_dispatchInFlight` declaration | Comment updated per design §5.4; the field itself is preserved (C7). |
| [src/runtime/runtime.ts](../../../src/runtime/runtime.ts#L603) | L603 | Call: `reconcileOrphanedWorkerSessions(join(this.projectRoot, '.saivage'))` | Replaced by `reconcileOrphanedAgentSessions(...)` plus the Proposal B singleton-reconciliation block (§5.2). |
| [tests/agents/session-persistence.test.ts](../../../tests/agents/session-persistence.test.ts#L111) | L111–L162 | `describe('reconcileOrphanedWorkerSessions', …)` and `describe('assertNoActiveWorkerSession', …)` blocks | Rewritten in place against the new invariant — see §3 Step 5. |
| [tests/agents/agent-adapter-dispatch-precondition.test.ts](../../../tests/agents/agent-adapter-dispatch-precondition.test.ts) | whole file | three `it(…)` cases + the `DuplicateActiveSessionError` import | Rewritten in place against the new invariant — see §3 Step 7. |
| [tests/runtime/startup-session-sweep.test.ts](../../../tests/runtime/startup-session-sweep.test.ts) | whole file | the single `it(…)` case + the outer `describe` name | Rewritten in place — see §3 Step 6. |

No file deletions. No source files are added or removed.

## 6. Validation gate

All four gates must pass before the commit is considered complete.

**G1 — Compile clean.**

```bash
cd /home/salva/g/ml/saivage-v3 && npm run build
```

The `build` script per [package.json](../../../package.json) is `tsc && npm run docs:build && cd web && npm run build`. The `tsc` segment must complete with zero errors; the `docs:build` and `web` segments are unchanged and unaffected.

**G2 — Grep is clean.**

```bash
cd /home/salva/g/ml/saivage-v3
grep -rn 'WORKER_ROLES\|NON_TERMINAL_SESSION_STATUSES\|reconcileOrphanedWorkerSessions\|assertNoActiveWorkerSession\|DuplicateActiveSessionError' src/ tests/
# Expected: zero matches.
grep -rn 'reconcileOrphanedAgentSessions\|assertNoActiveAgentSession\|ConcurrentAgentSessionError' src/ tests/ | wc -l
# Expected: a small finite count (three declarations + three call sites + assertions in three test files).
grep -n '_dispatchInFlight' src/runtime/runtime.ts | wc -l
# Expected: 7 (unchanged from before this commit).
grep -n 'startup_session_sweep' src/schemas/event-catalog.ts
# Expected: one declaration at L35, unchanged.
```

**G3 — Test suite passes.**

```bash
cd /home/salva/g/ml/saivage-v3 && npm test
```

The project's test script per [package.json](../../../package.json) is `NODE_OPTIONS=--experimental-vm-modules jest`. The three rewritten test files must pass; no other tests must regress.

**G4 — Live E2E on `saivage-v3-getrich-v2` (10.0.3.170).**

Restricted to the `saivage-v3-getrich.service` deployment on container `saivage-v3-getrich-v2`. **Do not touch** `saivage.service` on container `saivage-v3` (10.0.3.112) per the operator's standing instruction.

```bash
# Capture pre-restart orphan count (sessions with status==='active' and role !== 'analyst').
ssh root@10.0.3.170 'curl -fsS http://127.0.0.1:8080/api/agents | jq "[.sessions[] | select(.status==\"active\" and .role != \"analyst\")] | length"'

# Deploy: copy the rebuilt dist/ into the container's working dir (or pull/build in-container per the deployment skill).
# Restart the service.
ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service && sleep 4 && systemctl is-active saivage-v3-getrich.service && curl -fsS http://127.0.0.1:8080/health'

# Post-restart, before any new dispatch tick fires:
ssh root@10.0.3.170 'curl -fsS http://127.0.0.1:8080/api/agents | jq "[.sessions[] | select(.status==\"active\" and .role != \"analyst\")] | length"'
# Expected: 0.

# Confirm one sweep event was logged with the pre-restart orphan ids:
ssh root@10.0.3.170 "grep -F '\"startup_session_sweep\"' /work/getrich-v2/.saivage/runtime/events.jsonl | tail -1 | jq ."
# Expected: one entry with swept_session_ids covering the orphans observed pre-restart.

# Confirm Proposal B singleton reconciliation fired:
ssh root@10.0.3.170 "jq '.current_agent_session_id' /work/getrich-v2/.saivage/tmp/state/runtime.json"
# Expected: null (if the pre-restart singleton pointed at a swept session) OR an id not in the swept set (if it pointed at an analyst or was already null).
```

The authoritative runtime-state path is `.saivage/tmp/state/runtime.json` per [src/runtime/state.ts](../../../src/runtime/state.ts#L10-L29) (`AUTHORITATIVE_STATE_FILE = 'runtime.json'`, `runtimeStatePath` joins `.saivage/tmp/state/`). The legacy `.saivage/runtime/state.json` path is rejected; do not use it. The exact container working-dir prefix (`/work/getrich-v2/...`) follows the bind-mount layout recorded in `/memories/repo/saivage-v3-getrich-v2-bind-mounts.json`; verify the prefix before running `jq`/`grep` against `.saivage/`.

## 7. Risk and rollback

**Risks (from design §8, condensed and made operational):**

- **Missed call site bypasses the precondition.** Compiler-caught by the rename (the old symbols are deleted in the same commit). Mitigated further by the G2 grep gate.
- **Sweeping `'active'` planners marks a mid-call planner `'failed'`.** Intended (analysis §2.4); at process restart there is no live JS frame for that planner.
- **Sweep skips `'waiting'` planners** — also intended (analysis §2.1); the state machine re-invokes via deterministic ID at the next dispatch tick.
- **Precondition fires on planner re-entry from `'waiting'`** — does not happen (`'waiting' !== 'active'`); test §3 Step 7 case 4 locks this in.
- **Sweep + singleton-reconcile sequencing.** The sweep block runs **after** `repairStartupActiveCardRun` (§3 Step 3 sketch). `repairStartupActiveCardRun` writes `current_agent_session_id` back to `run.planner_session_id` at [runtime.ts L320–L323](../../../src/runtime/runtime.ts#L320-L323) based on the pre-sweep snapshot; with the sweep now downstream, the sweep observes the freshly-repaired state, fails any non-analyst session still `'active'` (including a planner session repair just re-pointed the singleton at), and clears the singleton by re-reading the post-repair state via [`readRuntimeState`](../../../src/runtime/state.ts#L134). All writes go through the atomic [`updateRuntimeState`](../../../src/runtime/state.ts#L142) helper on the same single-threaded startup path under the exclusive `acquireLock`; there is no concurrent writer.

**Rollback.** `git revert <commit>` restores the worker-uniqueness surface. No on-disk schema changed (design C6), so no data migration is needed in either direction. Sessions failed by the new sweep stay `'failed'` after rollback — that is the correct terminal state regardless of which invariant fails them.

## 8. Out of scope

Mirror of design §2 non-goals and analysis §8:

- **No unification of `current_agent_session_id` and the manifest store.** This cycle only reconciles the singleton at the sweep moment (Proposal B); the deeper refactor to derive one from the other (design Proposal C) is a future cycle.
- **No assertions on every `current_agent_session_id` write site.** Only the sweep-time reconciliation is added.
- **No compaction-in-flight crash safety.**
- **No changes in `web/` or analyst code paths.**
- **No on-disk schema migration** (no schema changed).
- **No changes to `_dispatchInFlight` semantics or scope** (C7).
- **No revert of the prior cycle's deletion of `failActiveWorkerSessions`.**
- **No rename of the `startup_session_sweep` event kind** (design §5.5).
- **No new files outside what design §7 names.** All deletions are symbol-level; all additions live in `src/agents/session-persistence.ts` and the three rewritten test files.
