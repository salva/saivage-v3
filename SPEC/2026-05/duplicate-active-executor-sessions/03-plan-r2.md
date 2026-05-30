# Plan r1 — Reconcile orphaned worker session manifests at startup

Companion to APPROVED design [02-design-r4.md](02-design-r4.md) and APPROVED analysis [01-analysis-r3.md](01-analysis-r3.md). Governing rule: **architecture-first, no backward compatibility** — no shims, no aliases, no migration helpers, dead code deleted.

## 1. Overview

Replace the dead-code reconciler [`failActiveWorkerSessions`](../../../src/agents/session-persistence.ts) with a wired startup sweep `reconcileOrphanedWorkerSessions` and a synchronous dispatch precondition `assertNoActiveWorkerSession`, called inside [`AgentAdapter.invokeAgent`](../../../src/agents/agent-adapter.ts) for executor/reviewer roles only. This establishes the invariant: **at any instant, for every `(role, card_id)` with `role ∈ {executor, reviewer}`, at most one session manifest is non-terminal.** Add one new event kind `startup_session_sweep` to the event registry. Keep `_dispatchInFlight` (planner-level guard, different layer — design §5.3, open choice #2).

## 2. Preconditions

- Analysis is APPROVED ([ANALYSIS-APPROVED.md](ANALYSIS-APPROVED.md)) and design r4 is APPROVED ([DESIGN-APPROVED.md](DESIGN-APPROVED.md)).
- Working tree on `/home/salva/g/ml/saivage-v3` is clean (`git status` shows no in-progress edits on [src/agents/session-persistence.ts](../../../src/agents/session-persistence.ts), [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts), [src/runtime/runtime.ts](../../../src/runtime/runtime.ts), [src/events/registry.ts](../../../src/events/registry.ts), or the three test files in §5).
- `npm install` has been run; `npm run typecheck` and `npm test` pass on `main` at the starting commit (record the SHA before starting).
- Container `saivage-v3-getrich-v2` (10.0.3.170) is reachable; service `saivage-v3-getrich.service` is the only Saivage service to be touched for E2E. **Do not** restart `saivage.service` on the `saivage-v3` container (10.0.3.112).
- No human operator is mid-session on the GetRich v2 dashboard at the time of E2E restart.

## 3. Sequenced changesets

Each step is independently typecheck-clean. Steps 1–4 land together; step 5 is the wiring; steps 6–8 are tests; step 9 is the deletion sweep.

### Step 1 — Add `WORKER_ROLES`, `DuplicateActiveSessionError`, `reconcileOrphanedWorkerSessions`, `assertNoActiveWorkerSession`

File: [src/agents/session-persistence.ts](../../../src/agents/session-persistence.ts)

Symbols added (immediately after the existing `markSessionWaiting` at line 165, before the soon-to-be-deleted `failActiveWorkerSessions` at line 167):

- `const WORKER_ROLES: ReadonlyArray<AgentRole>`
- `class DuplicateActiveSessionError extends Error`
- `function reconcileOrphanedWorkerSessions(saivageDir, reason?): AgentSession[]`
- `function assertNoActiveWorkerSession(saivageDir, role, cardId): void`

Shape (≈20 lines):

```ts
const WORKER_ROLES: ReadonlyArray<AgentRole> = ['executor', 'reviewer'];

export class DuplicateActiveSessionError extends Error {
  constructor(public readonly role: AgentRole, public readonly cardId: string, public readonly existingSessionId: string) {
    super(`Duplicate ${role} session for card ${cardId}: existing session ${existingSessionId} is still non-terminal.`);
    this.name = 'DuplicateActiveSessionError';
  }
}

export function reconcileOrphanedWorkerSessions(saivageDir: string, reason = 'Session was left active by a previous runtime process; reconciled at startup.'): AgentSession[] {
  const swept: AgentSession[] = [];
  for (const id of listSessions(saivageDir)) {
    const s = getSession(saivageDir, id);
    if (!s || !WORKER_ROLES.includes(s.role) || (s.status !== 'active' && s.status !== 'waiting')) continue;
    const updated = completeSession(saivageDir, s.id, 'failed');
    appendMessage(saivageDir, s.id, { role: 'system', kind: 'model_issue', content: reason });
    swept.push(updated);
  }
  return swept;
}

export function assertNoActiveWorkerSession(saivageDir: string, role: AgentRole, cardId: string): void {
  for (const id of listSessions(saivageDir)) {
    const s = getSession(saivageDir, id);
    if (!s || s.role !== role || s.card_id !== cardId) continue;
    if (s.status === 'active' || s.status === 'waiting') throw new DuplicateActiveSessionError(role, cardId, s.id);
  }
}
```

Verification: `npm run typecheck`.
Rollback: `git checkout -- src/agents/session-persistence.ts`.

### Step 2 — Add `startup_session_sweep` event kind to the registry

File: [src/events/registry.ts](../../../src/events/registry.ts)

Insert one entry inside the `EventRegistry` object (placement: after the `runtime_fatal_error` entry at [src/events/registry.ts](../../../src/events/registry.ts#L34), beside other recovery events). Do not modify any existing entry.

Shape:

```ts
startup_session_sweep: {
  domain: 'runtime',
  schema: payload({ swept_session_ids: z.array(z.string()) }),
  severity: 'warning',
  tracked: true,
  audit: true,
  broadcast: true,
  outbound: 'operator',
},
```

Verification: `npm run typecheck` (registry is a `satisfies`-constrained literal — typo on any key will fail compile).
Rollback: `git checkout -- src/events/registry.ts`.

### Step 3 — Call `assertNoActiveWorkerSession` synchronously inside `invokeAgent`

File: [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts)

Modify the body of `invokeAgent` (declared at [L421](../../../src/agents/agent-adapter.ts#L421)). The precondition call is placed **synchronously** between the no-candidates throw branch (which closes at L446) and `createSession` at [L447](../../../src/agents/agent-adapter.ts#L447). There is **no `await`** between the precondition and `createSession` — the only `await` upstream is `router.resolve` at [L432](../../../src/agents/agent-adapter.ts#L432), which has already resolved by this point.

Also update the top-of-file import at [L7](../../../src/agents/agent-adapter.ts#L7) to add `assertNoActiveWorkerSession`.

Shape (the relevant ≈10 lines after edit):

```ts
const candidates = await this.router.resolve(role, capabilityRequest);                  // L432 (unchanged)
if (candidates.length === 0) {
  // …existing no-candidates throw…                                                     // L433–L446 unchanged
}
if (role === 'executor' || role === 'reviewer') {
  assertNoActiveWorkerSession(this.saivageDir, role, cardId);                           // NEW — synchronous, no await before createSession
}
const session = createSession(this.saivageDir, role, goalId, cardId, undefined, requestedSessionId);  // L447 (unchanged)
```

Constraint check: between the new `assertNoActiveWorkerSession(...)` call and `createSession(...)` there is no `await`, no Promise chaining, no `setImmediate`, no `process.nextTick`. The two statements execute in the same synchronous run-to-completion turn, so two concurrent `invokeAgent` invocations in the same process cannot both pass the precondition before either reaches `createSession`.

Verification: `npm run typecheck`; then `npm test -- tests/agents/agent-adapter-executor-fallback.test.ts` (existing test must still pass — it stubs `router.resolve` and never seeds a duplicate manifest, so the precondition is a no-op for it).
Rollback: `git checkout -- src/agents/agent-adapter.ts`.

### Step 4 — Annotate `_dispatchInFlight` as planner-level guard

File: [src/runtime/runtime.ts](../../../src/runtime/runtime.ts)

The field is currently declared in the dense one-liner at [L101](../../../src/runtime/runtime.ts#L101). Split the declaration of `_dispatchInFlight = new Set<string>()` onto its own line preceded by a docblock; leave every other field on L101 untouched in place and order. **Do not delete the field** (open choice #2).

Shape (the only structural change inside L101 — pull `_dispatchInFlight` onto its own line; everything else stays on the one-liner exactly as today):

```ts
private _resumeHandoffContext: string | null = null;
private _startupRepairPending = false;
/** Planner-level in-process re-entrancy guard for dispatchGoal(goalId).
 *  NOT a worker-session uniqueness guard — that role belongs to the
 *  manifest store via assertNoActiveWorkerSession (design §5.3). */
private _dispatchInFlight = new Set<string>();
private _backgroundDispatches = new Set<Promise<void>>();
```

The shutdown prelude at [L612](../../../src/runtime/runtime.ts#L612) (`if (this._dispatchInFlight.size > 0) …`), the stopProject cancellation at [L578](../../../src/runtime/runtime.ts#L578), and the guard/track sites at [L619–L620](../../../src/runtime/runtime.ts#L619) and [L715](../../../src/runtime/runtime.ts#L715) are **unchanged**.

Verification: `npm run typecheck`.
Rollback: `git checkout -- src/runtime/runtime.ts` (combine with step 5 rollback).

### Step 5 — Wire `reconcileOrphanedWorkerSessions` into `Runtime.startup`

File: [src/runtime/runtime.ts](../../../src/runtime/runtime.ts)

Add the import alongside the existing `reconcileProcessRecords` at [L52](../../../src/runtime/runtime.ts#L52):

```ts
import { reconcileOrphanedWorkerSessions } from '../agents/session-persistence.js';
```
(Adjust the path/grouping to match the file's existing import style — the agent-adapter already imports from `./session-persistence.js`; the runtime currently imports nothing from that module, so add a fresh import line above the runtime imports block. If a `from '../agents/session-persistence.js'` import already gets added by tooling, fold this name into it.)

Modify [`Runtime.startup`](../../../src/runtime/runtime.ts#L596) (body at L596–L611). Insert one block between `performCrashRecovery` at [L601](../../../src/runtime/runtime.ts#L601) and `reconcileProcessRecords` at [L602](../../../src/runtime/runtime.ts#L602):

```ts
acquireLock(this.projectRoot);
await this.performCrashRecovery();                                                   // L601 (unchanged)
const swept = reconcileOrphanedWorkerSessions(join(this.projectRoot, '.saivage'));   // NEW
if (swept.length > 0) {
  this._eventLogger.appendEvent({
    kind: 'startup_session_sweep',
    swept_session_ids: swept.map((s) => s.id),
  });
}
reconcileProcessRecords(this.projectRoot);                                           // L602 (unchanged)
```

`join` is already imported at the top of [src/runtime/runtime.ts](../../../src/runtime/runtime.ts); confirm before adding.

Verification: `npm run typecheck`; `npm test -- tests/runtime/f23-dispatch-goal-acceptance.test.ts` (must still pass — its fixtures contain no pre-seeded active worker manifests, so `swept` is `[]`).
Rollback: `git checkout -- src/runtime/runtime.ts`.

### Step 6 — Replace the dead `failActiveWorkerSessions` unit test with new unit tests

File: [tests/agents/session-persistence.test.ts](../../../tests/agents/session-persistence.test.ts)

Delete the existing `describe('failActiveWorkerSessions', …)` block at [L111–L131](../../../tests/agents/session-persistence.test.ts#L111). Replace it with two new `describe` blocks, in the same location.

Cases for `describe('reconcileOrphanedWorkerSessions', …)`:
- Marks an `active` executor manifest and a `waiting` reviewer manifest as `failed`; appends exactly one `model_issue` system message with the default reason on each.
- Leaves an `active` analyst manifest untouched (status remains `active`, no new message).
- Leaves an `active` planner manifest untouched.
- Leaves already-terminal manifests (`done`, `failed`, `blocked`) untouched.
- Idempotent: a second call returns `[]` and writes no new messages.

Cases for `describe('assertNoActiveWorkerSession', …)`:
- Throws `DuplicateActiveSessionError` when a matching `active` manifest exists; `err.role`, `err.cardId`, `err.existingSessionId` populated.
- Throws when a matching `waiting` manifest exists.
- Returns silently when only terminal manifests exist for that `(role, cardId)`.
- Returns silently when an `active` manifest exists for a *different* `cardId` or a *different* `role`.
- Never matches `analyst` or `planner` even when those manifests are `active`.

Verification: `npm test -- tests/agents/session-persistence.test.ts`.
Rollback: `git checkout -- tests/agents/session-persistence.test.ts`.

### Step 7 — Create [tests/runtime/startup-session-sweep.test.ts](../../../tests/runtime/startup-session-sweep.test.ts)

New file. Mirror the harness in [tests/runtime/f23-dispatch-goal-acceptance.test.ts](../../../tests/runtime/f23-dispatch-goal-acceptance.test.ts) (`mkdtempSync` + `initProjectTree` + `new Runtime({…})` + `StubAgentRuntime`). Pre-seed manifests directly via `createSession` + the existing `setSessionStatus`/`markSessionWaiting`/`completeSession` helpers from `session-persistence.ts` before calling `runtime.startup()`.

Cases:
- Arrange three executor manifests with statuses `active`, `waiting`, `done`. After `startup()`: the two non-terminal manifests have `status: 'failed'` and a populated `completed_at`; each has one new `model_issue` system message; the `done` manifest is byte-identical to before; `runtime/events.jsonl` contains one `startup_session_sweep` event whose `swept_session_ids` equals the two swept ids.
- HTTP projection (reviewer item 6): construct a fastify instance with the existing `/api/agents` route registered following the pattern used by [tests/api/cards-history.test.ts](../../../tests/api/cards-history.test.ts). `GET /api/agents` and assert both swept sessions are reported with `status: 'failed'`. Do **not** import the unexported `buildListedAgentSession`.
- Empty case: no pre-seeded manifests → `startup()` writes **no** `startup_session_sweep` event.

Verification: `npm test -- tests/runtime/startup-session-sweep.test.ts`.
Rollback: `git rm tests/runtime/startup-session-sweep.test.ts`.

### Step 8 — Create [tests/agents/agent-adapter-dispatch-precondition.test.ts](../../../tests/agents/agent-adapter-dispatch-precondition.test.ts)

New file. Mirror the construction pattern of [tests/agents/agent-adapter-executor-fallback.test.ts](../../../tests/agents/agent-adapter-executor-fallback.test.ts) (`createMinimalAdapter`, `jest.spyOn(adapter.router, 'resolve').mockResolvedValue(...)`, `adapter.setLlmCallFn(jest.fn())`). Use the **real** `AgentAdapter`; do **not** substitute `FakeAgentAdapter` ([src/agents/fake-agent.ts](../../../src/agents/fake-agent.ts) is a separate `AgentRuntime` implementation, not accepted by `AgentAdapterConfig`).

Cases:
- **Executor conflict.** Pre-seed an `active` executor manifest for `(executor, 'card-X')` via `createSession`. Call `adapter.invokeExecutor('card-X', 'goal-Y', '')` → rejects with `DuplicateActiveSessionError`; `listSessions` count for `card-X` is still 1 after the call; `llmCallFn` was called zero times (proves precondition fired before model invocation).
- **Reviewer conflict.** Same shape but with `invokeReviewer` and a pre-seeded `active` reviewer manifest.
- **No conflict, executor proceeds.** No pre-seed; `invokeExecutor` runs through to the stubbed `llmCallFn` (which can return a minimal valid executor result); a new executor manifest is created.
- **`waiting` blocks too.** Pre-seeded manifest with status `waiting` → `invokeExecutor` rejects with `DuplicateActiveSessionError`.
- **Analyst not gated.** N/A — `invokeAnalyst` is not in scope of `invokeAgent`'s precondition branch and the adapter exposes no public analyst entry that flows through `invokeAgent` with executor/reviewer roles, so no test case is added (mirrors design §5.2 analyst exclusion).

Verification: `npm test -- tests/agents/agent-adapter-dispatch-precondition.test.ts`.
Rollback: `git rm tests/agents/agent-adapter-dispatch-precondition.test.ts`.

### Step 9 — Delete dead code

File: [src/agents/session-persistence.ts](../../../src/agents/session-persistence.ts)

Delete `failActiveWorkerSessions` at [L167–L187](../../../src/agents/session-persistence.ts#L167) (function declaration through the closing `}`). No callers remain in `src/` (verified by analysis §6.1 grep and re-verified at this step with `grep -rn 'failActiveWorkerSessions' src/`).

The replacement test cases were already swapped in at step 6, so no test file references the deleted symbol after this step.

Verification:
- `grep -rn 'failActiveWorkerSessions' src/ tests/` → empty.
- `npm run typecheck`.
- `npm test` (full suite).

Rollback: `git checkout -- src/agents/session-persistence.ts` (restores the symbol; combine with reverting step 6 if needed).

## 4. Test additions

| Test file | New / modified | Mirrors |
|---|---|---|
| [tests/agents/session-persistence.test.ts](../../../tests/agents/session-persistence.test.ts) | modified — replace `describe('failActiveWorkerSessions', …)` with `describe('reconcileOrphanedWorkerSessions', …)` and `describe('assertNoActiveWorkerSession', …)` | existing `describe('completeSession', …)` block in the same file |
| [tests/runtime/startup-session-sweep.test.ts](../../../tests/runtime/startup-session-sweep.test.ts) | new — startup sweep + `/api/agents` HTTP projection | runtime harness from [tests/runtime/f23-dispatch-goal-acceptance.test.ts](../../../tests/runtime/f23-dispatch-goal-acceptance.test.ts); HTTP harness from [tests/api/cards-history.test.ts](../../../tests/api/cards-history.test.ts) |
| [tests/agents/agent-adapter-dispatch-precondition.test.ts](../../../tests/agents/agent-adapter-dispatch-precondition.test.ts) | new — duplicate manifest blocks dispatch; clean path succeeds; `waiting` also blocks | [tests/agents/agent-adapter-executor-fallback.test.ts](../../../tests/agents/agent-adapter-executor-fallback.test.ts) (real `AgentAdapter`, `router.resolve` mocked) |

All case lists are taken verbatim from design §7; no extra cases invented.

## 5. Deletions

| File | Lines / symbol | Why dead |
|---|---|---|
| [src/agents/session-persistence.ts](../../../src/agents/session-persistence.ts) | L167–L187, `export function failActiveWorkerSessions` (signature + body + closing brace) | Exported but never wired (analysis §6.1); fully replaced by `reconcileOrphanedWorkerSessions` (step 1) + startup wiring (step 5). |
| [tests/agents/session-persistence.test.ts](../../../tests/agents/session-persistence.test.ts) | L111–L131, `describe('failActiveWorkerSessions', …)` | Tests the symbol being deleted. Replaced by new unit tests in step 6. |

No other deletions. `_dispatchInFlight` is **kept** (design open choice #2, reviewer item 1).

## 6. Validation gate

The change is considered correct end-to-end only if **all** of the following pass on the post-step-9 tree.

1. `npm run typecheck` — clean.
2. `npm run lint` — clean (catches forgotten import boundaries; the registry change is in-bounds).
3. `npm test` — full suite green. New tests from steps 6–8 included.
4. `npm run build` — clean (server `tsc` and `web` Vite build both pass).
5. Manual E2E on `saivage-v3-getrich-v2` (10.0.3.170) per design §7 "End-to-end manual check":
   - **Before deploy.** From host: `curl -fsS http://10.0.3.170:8080/api/agents | jq '[.sessions[] | select(.status=="active" and .role=="executor")] | length'` — observe `3` (the three orphans from analysis §1: `executor-1779816409491-4`, `executor-1779818547816-11`, `executor-1779818999226-2`).
   - **Deploy.** Build locally, sync `dist/` and updated source as the deployment normally does for this container, then `ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service'`. Do **not** touch `saivage.service` on 10.0.3.112.
   - **Wait for ready.** `ssh root@10.0.3.170 'systemctl is-active saivage-v3-getrich.service'` returns `active`; `curl -fsS http://10.0.3.170:8080/health` returns 200.
   - **After restart, before any new dispatch.** Same `curl /api/agents` jq filter — expect `0`.
   - **Event log.** `ssh root@10.0.3.170 "tail -n 200 /work/getrich-v2/.saivage/runtime/events.jsonl | jq -c 'select(.kind==\"startup_session_sweep\")'"` — expect one entry whose `swept_session_ids` is a superset of the three orphan ids.
   - **On-disk manifests.** `ssh root@10.0.3.170 'jq -r .status /work/getrich-v2/.saivage/agents/sessions/executor-1779816409491-4.json /work/getrich-v2/.saivage/agents/sessions/executor-1779818547816-11.json /work/getrich-v2/.saivage/agents/sessions/executor-1779818999226-2.json'` — three lines of `failed`.

Only after gates 1–5 all pass is the change complete.

## 7. Risk and rollback

**Worst case.** A bug in `reconcileOrphanedWorkerSessions` marks a manifest the new process legitimately needs (impossible by construction: `acquireLock` is exclusive and `performCrashRecovery` has already run, so no live worker can hold a non-terminal manifest at sweep time — design §6 risk table row 1), or the new dispatch precondition fires on a card where it shouldn't and blocks legitimate progress (would surface as a `DuplicateActiveSessionError` in `dispatchPendingActivations`'s existing `catch` at [runtime.ts:748–749](../../../src/runtime/runtime.ts#L748); card transitions to `failed`, parent unwound — visible immediately in `/api/agents` and `runtime/errors.jsonl`).

**Revert.** `git revert <merge-commit>` restores the prior tree atomically; on-disk manifests already swept to `failed` stay `failed` (no migration is required because `failed` is a valid pre-existing status). Operator action: none. Then ssh to 10.0.3.170 and `systemctl restart saivage-v3-getrich.service` to pick up the reverted binary.

**Forward-fix preference.** If a tight scope bug (e.g. wrong role gate, wrong status set) is found post-deploy, prefer a forward fix in `reconcileOrphanedWorkerSessions` / `assertNoActiveWorkerSession` over a full revert — the new module surface is small and isolated.

## 8. Out of scope (mirrors design §2)

- Refactoring [`AgentAdapter.invokeAgent`](../../../src/agents/agent-adapter.ts#L421) itself.
- Compaction-in-flight crash safety (analysis §7.3).
- The `'claimed'` literal vs. `RuntimeActivationStatus` schema mismatch.
- Changing UI / API rendering of session status.
- Touching analyst sessions.
- Collapsing the manifest store into a `runtime-state.json` projection (Proposal C — long-term direction, not this fix).
- Eliminating `_dispatchInFlight` (kept per design §5.3 and open choice #2).
