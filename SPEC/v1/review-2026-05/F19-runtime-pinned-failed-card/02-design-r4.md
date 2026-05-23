# F19 — Design (r4)

Supersedes [02-design-r3.md](02-design-r3.md). This revision addresses the r3 review (`01-analysis-review-r3.md`). Proposal B is still recommended. Proposal A is unchanged from r3 and is referenced by name rather than copied; only Proposal B is revised below.

## Proposal B — Runtime state machine (recommended; revised)

### New module: `src/runtime/state-machine.ts`

`RuntimeStateMachine` owns every runtime-layer transition. Boundaries (owned fields, owned card-status writes, out-of-scope analyst/operator/CardStore/freeze-fallback surfaces) are unchanged from r3.

### `transitionCard` is async — binding contract

Per the orchestrator decision, `RuntimeStateMachine.transitionCard` is **`async`** and every runtime call site `await`s it. This composes with F13 r4's awaited `cardStore.setStatus` / `cardStore.update` because each decomposed one-step inside `transitionCard` issues an awaited store call.

```ts
async transitionCard(
  cardId: string,
  action: RuntimeCardAction,
  payload: Record<string, unknown>,
): Promise<boolean>;   // true = transition emitted; false = rejected (matrix or validateTransition)
```

`transition(event, payload)` for runtime-state events stays `async` for the same reason (it writes through the awaited `writeState` dep). The Step 5 conversion table in [03-plan-r4.md](03-plan-r4.md) marks every call site `await`ed; the Step 7 gate fails if any unawaited call survives.

### Actions

```ts
type RuntimeCardAction =
  | 'start'                        // begin execution from a startable status
  | 'restart'                      // recover from a terminal/blocked/changed status back to running
  | 'cancel'
  | 'planner_set_status'           // planner-supplied status from applyPlannerResult
  | 'block'                        // goal → blocked (planner declared blocked)
  | 'complete'                     // goal → done (reviewer passed)
  | 'fail'                         // any non-terminal → failed (executor error, planner error, registration error, startup repair)
  | 'executor_finish'              // running → done | running → failed (executor terminal outcome incl. evidence-reg downgrade)
  | 'reviewer_repair_resume'       // active|running goal card → running (startup reviewer-phase repair)
  | 'crash_recovery_drop_to_backlog'; // active|running → backlog
```

Two new actions vs r3:

- `'executor_finish'` — the L725-733 missing-site action. Takes `{ goalId, finalStatus: 'done' | 'failed' }`. The runtime computes `finalStatus` after the evidence-registration step (see §Executor terminal restructure) and the machine emits exactly one legal step from `running`.
- `'reviewer_repair_resume'` — the L266 corrected action. Precondition: `card.status ∈ {'active', 'running'}`. Decomposes to `active → running` (1 step) or no-op when already `running`. Fails closed for any other source state.

### Permission-matrix + `validateTransition` rules per action

Source-of-truth constants: [`STARTABLE_STATES = {drafting, backlog, changed}`](../../../../src/permissions/card-permissions.ts#L29), [`RESTARTABLE_STATES = {blocked, changed, done, failed, cancelled}`](../../../../src/permissions/card-permissions.ts#L28), [`VALID_TRANSITIONS`](../../../../src/cards/card-store.ts#L217-L227).

| Action | From-state requirement | Matrix call | Emitted one-step sequence per legal source state |
|---|---|---|---|
| `start` | `card.status ∈ STARTABLE_STATES` | `decide({ role: 'planner', action: 'card.start', targetState: card.status })` must allow | `drafting`: `drafting → backlog → active → running` (3 steps); `backlog`: `backlog → active → running` (2 steps); `changed`: `changed → active → running` (2 steps, `changed → active` is in `VALID_TRANSITIONS.changed`). |
| `restart` | `card.status ∈ RESTARTABLE_STATES` | `decide({ role: 'planner', action: 'card.restart', targetState: card.status })` must allow | `failed`: `failed → backlog → active → running` (3 steps); `done`: `done → backlog → active → running` (3); `cancelled`: `cancelled → drafting → backlog → active → running` (4 steps — `cancelled` only allows `drafting` per `VALID_TRANSITIONS.cancelled`); `blocked`: `blocked → backlog → active → running` (3 steps; uniform with the others — `blocked → running` is also legal in one step but the machine picks the uniform `→ backlog → active → running` decomposition so audit traces are identical across recovery sources); `changed`: `changed → active → running` (2 steps; `changed → backlog → active → running` is also legal but uniform with `start` from `changed`). |
| `cancel` | matrix-allowed | `decide({ role, action: 'card.cancel', targetState })` | one step `<from> → cancelled` for each `<from>` that has `cancelled` in `VALID_TRANSITIONS[<from>]`; reject otherwise. |
| `planner_set_status` | any (planner-supplied) | already gated upstream by planner-permission matrix | exactly one step; `cardStore.validateTransition(current, requested)` must accept, else **reject** with one `state_machine_planner_status_rejected` log line and **no card write**. Never decomposed (the planner asked for a specific one-step move; the machine does not silently expand it). |
| `block` | `card.status ∈ {'active', 'running'}` | none (runtime-owned) | `active`: `active → running → blocked` (2 steps); `running`: `running → blocked` (1 step). Source state `≠ {'active', 'running'}` is rejected with `state_machine_invalid_source_state` log; no write. |
| `complete` | `card.status ∈ {'active', 'running'}` | none | `active`: `active → running → done` (2 steps); `running`: `running → done` (1 step). Same rejection shape as `block` for other source states. |
| `fail` | `card.status ∉ TERMINAL_STATUSES` | none | `running`: `running → failed` (1 step); `active`: `active → running → failed` (2 steps); `backlog`: `backlog → active → running → failed` (3 steps); `drafting`: `drafting → backlog → active → running → failed` (4 steps); `blocked`: `blocked → running → failed` (2 steps; `blocked → running` is legal per `VALID_TRANSITIONS.blocked`); `changed`: `changed → active → running → failed` (3 steps). Source state ∈ `{done, failed, cancelled}` is rejected — the machine never emits `done → failed` (closes the L725-733 → L740 hazard). |
| `executor_finish` | `card.status === 'running'` | none (runtime-owned executor outcome) | `finalStatus = 'done'`: `running → done` (1 step); `finalStatus = 'failed'`: `running → failed` (1 step). Source state `≠ 'running'` is rejected — the L706 `start`/`restart` always leaves the card in `running`, so this is an invariant assertion. |
| `reviewer_repair_resume` | `card.status ∈ {'active', 'running'}` | none (startup repair) | `active`: `active → running` (1 step); `running`: no-op (no write). Source state otherwise is rejected with `state_machine_invalid_source_state`; the repair branch then leaves the card untouched and logs once. |
| `crash_recovery_drop_to_backlog` | `card.status ∈ {'active', 'running'}` | none (recovery, not user action) | `active`: `active → backlog` (1 step); `running`: `running → backlog` (1 step). |

### Executor terminal restructure (the L725-733 → L740 fix)

The current physical structure of `dispatchPendingActivations` writes the executor result status before the evidence-registration check decides whether to downgrade. With the machine intercepting both sites, the two transitions (`running → done` then `done → failed`) cannot both be emitted — the second is not in `VALID_TRANSITIONS`. The design moves the registration check **before** the single status transition:

```ts
// post-Step-5 shape (pseudo-diff; exact rewrite lives in 03-plan-r4.md Step 5)

// 1. Executor returned. Card is in 'running' (from the L706 transitionCard('start'|'restart')).
//    Do NOT write status yet.

// 2. Registration: unchanged loop bodies from existing L735-736 (collect errors).
const artifactRegistrationErrors: string[] = []; ...
const attachmentRegistrationErrors: string[] = []; ...

// 3. Optional: write ignored registrations (non-status payload; unchanged from L737).
if (ignoredArtifactRegistrations.length > 0 || ignoredAttachmentRegistrations.length > 0)
  this.cardStore.update(card.id, { result: { ..., evidence_registration_ignored: ... } });

// 4. Decide one final status.
const registrationFailed =
  execResult.status === 'done' &&
  (artifactRegistrationErrors.length > 0 || attachmentRegistrationErrors.length > 0);
const finalStatus: 'done' | 'failed' = registrationFailed ? 'failed' : execResult.status;
const registrationError = registrationFailed
  ? `Completion blocked by evidence registration failure. Artifacts: ${...}. Attachments: ${...}.`
  : null;

// 5. Single legal status transition through the machine.
const transitioned = await this._stateMachine.transitionCard(card.id, 'executor_finish', {
  goalId,
  finalStatus,
  reason: registrationFailed ? 'evidence_registration_failed' : undefined,
});
if (!transitioned) { /* machine refused; one log line already written; bail out */ ... }

// 6. Non-status payload (combines existing L725-733 non-status fields + L740 registration_failures).
this.cardStore.update(card.id, {
  result: {
    ...(execResult.result ?? {}),
    executor: execResult.result ?? null,
    latest_self_report: latestSelfReport,
    ...(registrationFailed
      ? { evidence_registration_failures: { artifacts: artifactRegistrationErrors,
                                            attachments: attachmentRegistrationErrors } }
      : {}),
  },
  error: registrationError ?? execResult.error ?? null,
  status_text: execResult.status_text,
  status_text_updated_at: acceptedAt,
  status_text_author_session_id: lastSessionId,
  latest_self_report: latestSelfReport,
});

// 7. Existing tail (unchanged): unwind tool result, card_failed event, return.
```

Net effect: exactly **one** legal status step is emitted per executor turn (`running → done` or `running → failed`). The L725-733 site and the L740 site collapse into the single `'executor_finish'` transition in step 5 above, plus one non-status `cardStore.update` in step 6.

### Construction, `enforceInvariants` staging (aligned with the plan)

The staging-flag lifecycle is **identical** in the design and the plan to remove the r3 drift the reviewer called out. Pinned wording:

- **Step 3** — constructor receives `enforceInvariants: false`. `tick()` does I4 only (monotonic `last_tick_at`). I1–I3 violations are detected and logged once per `(invariant, key)` tuple via `errorLogger` but **not** auto-corrected, because `_status` is still authoritative and a corrective `status` write would re-diverge. The corrective bodies for I1–I3 are not yet present in the source — only the observation/logging branch exists.
- **Step 4** — `_status` deleted, `Runtime.status` becomes a disk read, constructor flipped to `enforceInvariants: true`, **AND the corrective bodies for I1–I3 land in the same PR**. From the merge of Step 4 onward, both the test suite and the live deployment exercise the full auto-correcting machine. (This is the change vs r3: the corrective bodies move from Step 6 forward into Step 4. Step 6 retains only the dead-code sweep for `safeTick`, the eight clear-state blobs, and the runtime-state writers consolidation; it no longer carries net-new invariant logic.)
- **Step 7** — `enforceInvariants` parameter removed from the constructor, the gated `if (enforceInvariants)` branches in `tick()` collapsed to always-enforce, `rg -n "enforceInvariants" src/ tests/` must return zero matches.

The design and plan now agree end-to-end: **Step 3 false (observe-only) → Step 4 true + corrective bodies land → Step 7 flag removed**.

### Construction and F13 coordination

Unchanged from r3. F13 r4 lands first; F19 rebases Step 3 wiring into `Runtime.open(config)` / `ActiveRuntime.open(projectRoot, config, mcpManager)`. `RuntimeStateMachine` itself is sync-constructible (constructor body does no I/O), so the seam composes with either construction style.

### Files deleted or reduced

Unchanged from r3 (`_status` field/getter; the eight inline `updateRuntimeState({ status, current_card_id: null, … } as Partial<RuntimeState> as never)` blobs and their casts; `safeTick` self-heal; `_safeTickInFlight`; `_autoDispatchFirstBacklogGoal`; `mirrorRuntimeState`; the `enforceInvariants` flag itself in Step 7).

### Files added

- `src/runtime/state-machine.ts` (~250 lines).
- `tests/runtime/state-machine.test.ts` — table-driven `it.each` tests assert **the emitted one-step sequences**, not just accept/reject booleans, for every action × every `CardStatus` source state. Spec text below.

### Test contract — assert emitted sequences, not booleans

Reviewer §D2 requires tests to assert the actual one-step sequence each action emits, because two implementations can both "accept" a `restart` from `failed` but only one emits a `VALID_TRANSITIONS`-legal decomposition.

The unit test fixture passes a spy `cardStore` whose `setStatus(id, status)` and `update(id, patch)` calls are recorded as `(id, kind, status)` tuples in order. Each test case asserts the exact ordered list. Examples (full matrix lives in [03-plan-r4.md](03-plan-r4.md) Step 5 test additions):

```ts
// 'restart' from each RESTARTABLE_STATES source emits the uniform decomposition.
it.each([
  ['failed',    ['failed → backlog', 'backlog → active', 'active → running']],
  ['done',      ['done → backlog',   'backlog → active', 'active → running']],
  ['cancelled', ['cancelled → drafting', 'drafting → backlog', 'backlog → active', 'active → running']],
  ['blocked',   ['blocked → backlog', 'backlog → active', 'active → running']],
  ['changed',   ['changed → active', 'active → running']],
])('restart from %s emits %p', async (from, expected) => {
  const card = makeCard({ status: from as CardStatus });
  const spy = makeSpyCardStore([card]);
  await machine(spy).transitionCard(card.id, 'restart', { goalId: 'g1' });
  expect(spy.steps).toEqual(expected);
});

// 'fail' from 'done'/'failed'/'cancelled' is rejected with no writes.
it.each(['done', 'failed', 'cancelled'])('fail from %s rejects with no writes', async (from) => {
  const card = makeCard({ status: from as CardStatus });
  const spy = makeSpyCardStore([card]);
  const ok = await machine(spy).transitionCard(card.id, 'fail', { reason: 'x' });
  expect(ok).toBe(false);
  expect(spy.steps).toEqual([]);
});

// Illegal one-step planner_set_status sequences are rejected.
it('planner_set_status cancelled → backlog is rejected (one-step illegal)', async () => {
  const card = makeCard({ status: 'cancelled' });
  const spy = makeSpyCardStore([card]);
  const ok = await machine(spy).transitionCard(card.id, 'planner_set_status',
                                                { requestedStatus: 'backlog' });
  expect(ok).toBe(false);
  expect(spy.steps).toEqual([]);
});

it('planner_set_status active → failed is rejected (one-step illegal)', async () => {
  const card = makeCard({ status: 'active' });
  const spy = makeSpyCardStore([card]);
  const ok = await machine(spy).transitionCard(card.id, 'planner_set_status',
                                                { requestedStatus: 'failed' });
  expect(ok).toBe(false);
  expect(spy.steps).toEqual([]);
});

// reviewer_repair_resume from 'active' emits a single legal step; from 'running' is a no-op.
it('reviewer_repair_resume from active emits active → running', async () => {
  const card = makeCard({ status: 'active' });
  const spy = makeSpyCardStore([card]);
  await machine(spy).transitionCard(card.id, 'reviewer_repair_resume', {});
  expect(spy.steps).toEqual(['active → running']);
});

it('reviewer_repair_resume from running is a no-op', async () => {
  const card = makeCard({ status: 'running' });
  const spy = makeSpyCardStore([card]);
  await machine(spy).transitionCard(card.id, 'reviewer_repair_resume', {});
  expect(spy.steps).toEqual([]);
});
```

The full action × source-state matrix is encoded in [03-plan-r4.md](03-plan-r4.md) Step 5 test additions; every cell asserts either an exact emitted sequence or a no-write rejection.

### Failure modes

Unchanged from r3 (bigger surface change, tick interval = wall-clock dep, wider blast radius if invariants are wrong, cross-process operator/runtime write race). The `enforceInvariants: false` observe-only window in Step 3 still bounds the auto-correction blast radius; Step 4 lands the corrective bodies and the flip together so design and plan agree on what is live when.

### API impact

Unchanged: `/api/runtime/status` gains `lastTickAt: string | null`. No removals.

### Test strategy

Unit/integration/E2E summary unchanged from r3, with these additions:

- **Unit (machine)**: the executor-finish action with `finalStatus ∈ {'done', 'failed'}` from `running` source state (1-step legal each); rejection from any other source state.
- **Unit (machine)**: the `reviewer_repair_resume` precondition table (`active`, `running`, every other status).
- **Unit (machine)**: emitted-sequence assertions for every action × every source state (see §Test contract).
- **Unit (machine)**: illegal-sequence rejection for `planner_set_status` with `cancelled → backlog` and `active → failed`.
- **Integration**: executor `done` happy path → `running → done`; executor `failed` → `running → failed`; executor `done` with evidence-registration failure → `running → failed` (one transition, no `done → failed` step ever emitted; verified by inspecting the spy step trace).
- **Integration**: full `RESTARTABLE_STATES` recovery from each source state (`failed`, `done`, `cancelled`, `blocked`, `changed`), driving `dispatchPendingActivations` with a card pre-seeded in each state.

## Recommendation

Proposal B. Reasoning unchanged from r3.

## Changes vs r3

- **`transitionCard` is `async`.** Signature pinned at the top of the section; every snippet uses `await`. (Orchestrator decision.)
- **New `'executor_finish'` action** for the L725-733 site; emits exactly one legal step `running → done` or `running → failed`. (Reviewer §A1.)
- **New `'reviewer_repair_resume'` action** for the L266 startup repair; precondition `card.status ∈ {'active', 'running'}` with construction proof in [01-analysis-r4.md](01-analysis-r4.md). (Reviewer §A2.)
- **Action → emitted-sequence table** now spells out the one-step decomposition for every action × source state, including `cancelled` (`restart` decomposes through `drafting`), `blocked` (uniform `→ backlog → active → running`), and `changed` (2-step via `active`). `fail` rejects from terminal states — the machine **never** emits `done → failed`. (Reviewer §D2.)
- **Executor terminal restructure**: registration check moves before the status transition so one `transitionCard('executor_finish', { finalStatus })` call covers both L725-733 and L740. (Reviewer §A1, §P1.)
- **`enforceInvariants` staging**: corrective bodies for I1–I3 land in **Step 4**, not Step 6. Design and plan now agree on the lifecycle: Step 3 false (observe-only) → Step 4 true + corrective bodies → Step 7 flag removed. (Reviewer §D3.)
- **Test contract**: spy-cardStore tests assert the **exact emitted one-step sequences**, not just accept/reject booleans. Illegal one-step sequences (`cancelled → backlog`, `active → failed`) are exercised as rejection cases. (Reviewer §D2, §P3.)
