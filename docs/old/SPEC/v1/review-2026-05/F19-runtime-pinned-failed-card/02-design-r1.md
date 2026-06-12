# F19 — Design (r1)

Two proposals. Both satisfy contracts C1–C4 from [01-analysis-r1.md](01-analysis-r1.md). Proposal B is recommended.

## Proposal A — Focused fix (surgical)

### Shape

Three localised changes inside the runtime layer, no new abstractions.

1. **Eliminate the `_status` in-memory drift.** Delete the `_status` field on [`Runtime`](../../../src/runtime/runtime.ts). Replace the `status` getter with `return readRuntimeState(this.projectRoot)?.status ?? 'idle'`. All eight existing call sites that write `status: 'idle' | 'running' | 'frozen' | 'paused'` to disk already happen at the moment the runtime transitions — they become the single source of truth. This is purely deletion plus a getter rewrite.

2. **Clear `current_card_id` and `active_card_run` on the executor-failure branch.** In [`dispatchPendingActivations`](../../../src/runtime/runtime.ts) at the `if (execResult.status === 'failed') { ... return }` block (line 744-area), call `updateRuntimeState(this.projectRoot, { current_card_id: parentRun?.card_id ?? null, current_agent_session_id: parentRun?.planner_session_id ?? null, active_card_run: parentRun })` before returning, using the existing `parentPlannerRunFor` helper. Mirrors what the restart-repair branch already does in [`repairStartupActiveCardRun`](../../../src/runtime/runtime.ts) line 282 for terminal-executor cards.

3. **Route auto-recovery through `backlog`.** The orchestrator never calls `setStatus(failedCard, 'active')`. Instead, when the planner returns `created_cards` or `updated_cards` that reference a card currently in a terminal status, [`applyPlannerResult`](../../../src/runtime/runtime.ts) must reject `status` updates that violate `VALID_TRANSITIONS` and instead route a `failed → backlog` (or `done → backlog`) transition first. This is one `if` in `applyPlannerResult`'s `untrackedChanges` branch, plus deleting any planner-loop code that tries to redispatch a terminal card without a backlog hop.

4. **Add `lastTickAt`.** Persist a `last_tick_at` field in `RuntimeState`; stamp it on each `safeTick` entry, each `dispatchGoal` iteration, and each terminal-status write. Expose as `lastTickAt` in `/api/runtime/status`.

### Failure modes

- **Field-by-field clearing is fragile.** Every new exit path added in future must remember to write `current_card_id: null, active_card_run: null`. The bug pattern that produced F19 (a code path that updates one field and forgets the others) is preserved.
- **No invariant enforcement.** The `RuntimeStateInvariantError` in [src/runtime/state.ts](../../../src/runtime/state.ts) line 13 only catches the idle-with-active-run case. The new invariant ("running + currentCardId references a terminal card is forbidden") would have to be hand-wired into every writer.
- **`applyPlannerResult` rewrite is brittle.** The planner JSON can supply `status` on any card; the current code blindly applies it. Filtering only the `failed → active` case leaves the door open for `done → active`, `cancelled → active`, etc. The deny list grows over time.
- **Does not subsume F20.** Executor false-failure ([F20](../F20-executor-false-failed/00-issue.md)) — the case where the artefacts are correct but the executor self-report is `failed` — is orthogonal: the fix here makes the runtime recover, but the card stays incorrectly red.
- **Does not subsume F23.** [F23](../F23-invalid-failed-active/00-issue.md)'s root cause is the orchestrator calling the wrong transition; this proposal removes that path on one route (`applyPlannerResult`) but does not centralise the rule.

### API impact

`/api/runtime/status` gains `lastTickAt: string | null`. No fields removed, no shapes broken.

### Test strategy

- Unit: `dispatchPendingActivations` clears state on executor failure (mock cardStore + state functions, assert `updateRuntimeState` is called with `current_card_id: null` or `parentRun.card_id`).
- Unit: `Runtime.status` getter reads from disk (write a state, set `status: 'idle'` directly, assert getter returns `'idle'`).
- Integration: drive `dispatchGoal` with a fake agent that returns `status: 'failed'` from the executor, then call `getStatus()` — assert `runtime: 'idle'` (or `running` with `currentCardId === null` if the planner has a follow-up) within 30s.
- Regression: existing pause/resume integration suite must still pass since the `_status` deletion changes the `getStatus()` source.

## Proposal B — Runtime state machine (recommended, one conceptual level up)

### Shape

Introduce a single module that owns every runtime+card state transition and enforces the contract on every tick. Concretely:

#### New module: `src/runtime/state-machine.ts`

Exports a `RuntimeStateMachine` class whose responsibilities are:

- **Single writer for `RuntimeState`.** Every mutation to `status`, `current_card_id`, `current_agent_session_id`, `active_card_run`, `paused`, `paused_at`, `last_tick_at` goes through `RuntimeStateMachine.transition(event, payload)`. The free-function `updateRuntimeState` in [src/runtime/state.ts](../../../src/runtime/state.ts) is retained only for the ledger fields (`runtime_commands`, `runtime_runs`, `runtime_activations`, `running_processes`, `queue`, `frozen_reason`, `runtime_intent`) which the state machine does not own.

- **Single writer for `CardStatus`.** Every `cardStore.setStatus`/`cardStore.update({status})` call from the runtime layer is replaced with `RuntimeStateMachine.transitionCard(cardId, action, payload)`. `RuntimeStateMachine` consults the existing [`decide()`](../../../src/permissions/card-permissions.ts) matrix to authorise the action (it does **not** duplicate the matrix), then calls the existing `cardStore.validateTransition` plus `cardStore.update`. Card-mutation surfaces outside the runtime layer (operator routes, planner tools) keep going through `cardStore` directly; the state machine governs only the runtime's own card writes.

- **Single tick loop.** `RuntimeStateMachine.tick()` runs on a fixed interval (`5s`, registered through `RuntimeLifecycleScope.registerTimer`) and on demand after every transition. On each tick it asserts invariants:
  - I1: `status === 'running'` → `active_card_run !== null` (else transition to `'idle'`).
  - I2: `current_card_id` references a card with non-terminal status (else either pop to parent planner run via `parentPlannerRunFor`, or transition to `'idle'` if no parent).
  - I3: `active_card_run.card_id` matches `current_card_id` (else reconcile by clearing both).
  - I4: `last_tick_at` is bumped every tick.
  - Violations are logged via `errorLogger` once per (invariant, card_id) tuple, then auto-corrected.

- **Recovery routing.** When the tick observes a terminal `current_card_id`, it emits a single `cardTerminated` event. The dispatch loop subscribes: on `done` it does nothing (planner will replan on next iteration); on `failed`/`cancelled` it routes via the state machine which auto-transitions the card `failed → backlog` only if a planner replan is desired, otherwise leaves it `failed` and transitions runtime → `'idle'`. The routing decision uses the existing `runtime_intent.status` (already used by `safeTick`): if `'running'`, route via `backlog`; if `'stopped'`, go idle.

#### Files deleted or reduced

- The bespoke `_status` field on `Runtime` and its getter — deleted.
- The eight inline `updateRuntimeState({ status: 'idle', current_card_id: null, current_agent_session_id: null, queue: [], active_card_run: null } as Partial<RuntimeState> as never)` blobs in [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) (lines 555, 583, 609, 635, 644, 645, 660, 800) — replaced with `this._stateMachine.transition('goal_exit', { reason })`. The `as Partial<RuntimeState> as never` cast (a sign these writes bypass the schema's type guard) goes away with them.
- The "stale `active_card_run` self-heal" branch in `safeTick` (lines 793–810) — folded into invariant I1/I3.
- The `_safeTickInFlight` re-entrancy bool — folded into the tick scheduler's own lock.
- `mirrorRuntimeState` in [src/runtime/control.ts](../../../src/runtime/control.ts) — replaced with `this._stateMachine.transition('paused' | 'resumed')`. `RuntimeControl` becomes a thin call-site wrapper that emits operator events; the state mutation is owned by the machine.

#### Files added

- `src/runtime/state-machine.ts` (one file, ~200 lines including the invariant assertions and the test seam).
- `src/runtime/state-machine.test.ts` (unit tests, no I/O, fed a fake `cardStore` and an in-memory `RuntimeState`).

### Coordination with F20 and F23

- **F23 disappears entirely.** The state machine never offers `failed → active` as a transition: `transitionCard(id, 'restart')` looks up the matrix, sees the matrix allows it, and internally routes `failed → backlog → active → running`. Callers ask for the *action* (`'restart'`), not the *state*. The `Invalid transition: failed → active` error becomes architecturally unreachable from the runtime layer. The wrong-recovery-path issue is removed at the source, not patched at the call site.

- **F20 becomes a single decision point.** The state machine's `cardTerminated` event handler is the one place that decides "executor said failed, what status does the card actually land in?" The post-verification check (rerun tests / parse artefacts / inspect status_text) lives there. Today that decision is implicit in `dispatchPendingActivations`'s `outcome = execResult.status === 'done' ? 'done' : 'failed'` (line 743). After the state machine lands, F20 is a one-method change inside `state-machine.ts` instead of a cross-cutting investigation.

- **Strong recommendation: bundle F19+F20+F23 into a single PR series**, with F19 introducing the machine, F23 deleting the broken caller, F20 adding the verification hook inside the machine. The three issues are not three bugs; they are three symptoms of the missing abstraction. The F20 and F23 design docs should reference this one and not duplicate the machine design.

### Integration with existing `permissions/` matrix

The state machine does **not** copy [`VALID_TRANSITIONS`](../../../src/cards/card-store.ts) line 217 or the `decide()` matrix from [src/permissions/card-permissions.ts](../../../src/permissions/card-permissions.ts). It imports both and composes:

- For runtime-side card writes: `decide({ role: 'planner' | 'operator', action, targetState: card.status })` first (matrix says is the action permitted?), then `cardStore.validateTransition(card.status, intendedStatus)` (store says is the literal transition legal?). The state machine fails closed if either rejects.
- New routings (e.g. `failed → backlog → active`) are expressed as ordered sequences of single-step transitions; each step still goes through `cardStore.setStatus`, which still uses `VALID_TRANSITIONS`. No transition rules duplicate.

### Unit-testability

`RuntimeStateMachine` is constructed with explicit dependencies: `(stateReader, stateWriter, cardStore, errorLogger, clock, scheduler)`. The constructor takes no `projectRoot`, performs no I/O. Unit tests inject a `Map`-backed state, a fake card store, and a manual clock. Each invariant has one test that violates it and asserts the auto-correction. The full `dispatchGoal` keeps its existing test surface; the new module is testable in isolation.

### Failure modes

- **Bigger surface change.** ~10 call sites in `runtime.ts` rewritten, plus `control.ts` and `safeTick` consolidated. Higher review cost than Proposal A. Mitigation: PR-per-step plan in [03-plan-r1.md](03-plan-r1.md).
- **Tick interval picks a wall-clock dependency.** 5s polling adds load (negligible — a state read + a few `cardStore.read`); but makes test determinism require an injectable clock. Mitigation: clock is already a constructor dep.
- **Wider blast radius if invariant logic is wrong.** A buggy invariant could auto-correct healthy runtime state into garbage. Mitigation: invariants are tested individually, and each correction also writes an `errors.jsonl` line so regressions are observable in the same e2e harness that produced F19.

### API impact

Identical to Proposal A: add `lastTickAt` to `/api/runtime/status`. No removals, no breaking shape changes. The dashboard can later add a `lastTickAt` freshness indicator (out of scope).

### Test strategy

- Pure unit tests for each invariant (I1–I4) under all card-status × runtime-status combinations.
- Pure unit tests for each transition (`start_project`, `goal_exit`, `card_terminated`, `paused`, `resumed`, `freeze`, `unfreeze`).
- Integration test against the real `Runtime` with a fake `AgentRuntime`: drive a failing executor, observe `/api/runtime/status` transitions to `runtime: 'idle'` (or to a different `currentCardId`) within 30s.
- E2E test in the checkers harness (see [03-plan-r1.md](03-plan-r1.md) §LXC probe): full provider-wired loop, induce a failure, assert the status route auto-recovers.
- The `pause`/`resume` integration suite is rewritten to call into the state machine but the externally observable behaviour is unchanged.

## Recommendation

**Proposal B.** Reasons grounded in the project guidelines:

1. **Architecture-first, no backward compatibility.** The `_status` field, the eight inline state-clearing blobs, the `as Partial<RuntimeState> as never` casts, and the `mirrorRuntimeState` helper are exactly the kind of accumulated patchwork the guideline says to remove. Proposal A patches them; Proposal B deletes them.
2. **Clean code, proper architecture.** Two stores with no enforced relationship is the structural defect. A single writer is the canonical fix.
3. **No migration shims.** The new module replaces the old code paths directly; there is no parallel `_status` / disk state cohabitation period.
4. **Aggressive dead-code removal.** Proposal B removes more lines than it adds (`_status` field + getter + 8 inline blobs + `safeTick` self-heal + `_safeTickInFlight` + `mirrorRuntimeState`) and centralises the remaining logic in one tested place.
5. **No over-engineering.** The new module is one file with one class and one interval timer. The "abstraction" is exactly the abstraction that already implicitly exists — a runtime+card state machine — made explicit so it can be tested and trusted.
6. **Subsumes F20 and F23.** Three issues, one fix. The alternative is three independent fixes that re-introduce the coupling problem each time.

The cost is a larger diff and a more careful PR sequence, accounted for in [03-plan-r1.md](03-plan-r1.md).
