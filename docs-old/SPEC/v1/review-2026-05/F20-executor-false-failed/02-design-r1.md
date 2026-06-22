# F20 — Design (r1)

Implements the analysis in [01-analysis-r1.md](01-analysis-r1.md). Two alternatives are evaluated; **Proposal A is recommended**. Both compose on top of [F19 02-design-r5.md](../F19-runtime-pinned-failed-card/02-design-r5.md) (state machine) and [F19 03-plan-r5.md](../F19-runtime-pinned-failed-card/03-plan-r5.md) (per-site conversions); F19 lands first, F20 rebases.

## Proposal A — Introduce `CardStatus = 'needs_verification'` (RECOMMENDED)

A new lifecycle status slotted between `running` and the terminal verdicts. The executor early-termination path (fallback-with-evidence) lands the card in `needs_verification` instead of `failed`, preserving the produced artefacts and signalling to downstream consumers (operator, analyst, reviewer) that verification is owed.

### Schema

`CardStatus` gains `'needs_verification'`:

```ts
// src/schemas/types.ts (post-F20)
export type CardStatus =
  | 'drafting' | 'backlog' | 'active' | 'running'
  | 'needs_verification'                                  // NEW
  | 'blocked' | 'changed' | 'done' | 'failed' | 'cancelled';
```

[src/schemas/validators.ts L13](../../../src/schemas/validators.ts#L13) `cardStatusSchema` adds the same literal. `CARD_STATES` at [src/permissions/card-permissions.ts L10](../../../src/permissions/card-permissions.ts#L10) is extended in matching order. The `web/` mirror at [web/src/api/types.ts L12-L21](../../../web/src/api/types.ts#L12-L21) and the per-status lists at [web/src/components/cards/CardsBoardView.vue L72](../../../web/src/components/cards/CardsBoardView.vue#L72), [web/src/stores/cards.ts L158](../../../web/src/stores/cards.ts#L158), [web/src/views/CardsView.vue L246](../../../web/src/views/CardsView.vue#L246) extend in lockstep. Board badge mapping at [web/src/components/cards/CardsBoardView.vue L150-L158](../../../web/src/components/cards/CardsBoardView.vue#L150-L158) gains one row:

```css
.status-needs_verification { background: #f0b429; }       /* amber — verification owed */
```

### State-machine slot — `VALID_TRANSITIONS`

The intermediate state is unconditionally entered from `running` and resolved to one of the terminal verdicts, the running state (re-dispatch verification), or `cancelled`/`backlog` (operator escape hatch). The plan §Step 1 mutates [src/cards/card-store.ts L217-L227](../../../src/cards/card-store.ts#L217-L227):

```ts
// src/cards/card-store.ts (post-F20)
const VALID_TRANSITIONS: Record<CardStatus, CardStatus[]> = {
  drafting: ['backlog', 'cancelled'],
  backlog: ['active', 'cancelled'],
  active: ['running', 'cancelled', 'backlog'],
  running: ['done', 'failed', 'needs_verification', 'blocked', 'changed', 'cancelled', 'backlog'], // +needs_verification
  needs_verification: ['done', 'failed', 'running', 'cancelled', 'backlog'],                       // NEW row
  blocked: ['backlog', 'running', 'changed', 'cancelled'],
  changed: ['backlog', 'active', 'cancelled'],
  done: ['backlog', 'cancelled'],
  failed: ['backlog', 'cancelled'],
  cancelled: ['drafting'],
};
```

The `needs_verification → running` edge is the verification re-dispatch path (a fresh executor turn or a verification-only step resumes work). `needs_verification → done | failed` is the verification-resolved path (the next turn or the reviewer concludes). `needs_verification → backlog | cancelled` are operator escapes.

### Permission classification

`needs_verification` is **not** terminal, **not** startable, **not** planner-mutable, **not** restartable, **not** deletable. It is observed-only by analyst/reviewer in the F20 PR; operator cancel/restart paths are not widened (see "Out of scope" below).

Mutations to the named sets at [src/permissions/card-permissions.ts L26-L30](../../../src/permissions/card-permissions.ts#L26-L30):

| Set | Pre-F20 | Post-F20 | Reason |
|---|---|---|---|
| `PLANNER_MUTABLE_STATES` | `{backlog, active, changed}` | unchanged | The planner does not produce a `needs_verification` card; only the runtime/executor seam does. |
| `DELETABLE_STATES` | `{backlog, blocked, done, failed, cancelled}` | unchanged | Verification-pending artefacts are not deletable until verification resolves. |
| `RESTARTABLE_STATES` | `{blocked, changed, done, failed, cancelled}` | unchanged | The verification re-dispatch path uses `needs_verification → running` directly (not the operator restart action). |
| `STARTABLE_STATES` | `{drafting, backlog, changed}` | unchanged | `needs_verification` is mid-execution, not a starting point. |
| `ANALYST_RESTARTABLE_STATES` | `{done, failed, cancelled}` | unchanged | Analyst restart is a terminal-recovery surface; verification-pending is not terminal. |
| `TERMINAL_STATES` ([src/cards/card-store.ts L189-L193](../../../src/cards/card-store.ts#L189-L193)) | `{done, failed, cancelled}` | unchanged | `needs_verification` is not a terminal verdict. |
| `TERMINAL_STATUSES` ([src/runtime/runtime.ts L83](../../../src/runtime/runtime.ts#L83)) | `{done, failed, cancelled}` | unchanged | Same. |

[src/cards/card-store.ts L572, L709, L969](../../../src/cards/card-store.ts) sites that test `TERMINAL_STATES.has(...)` are unaffected (the new status is correctly *not* terminal).

`FULL_EDIT_STATES` at [src/cards/card-store.ts L215](../../../src/cards/card-store.ts#L215) (`{drafting, backlog}`) is unchanged: a `needs_verification` card is not in scope for full re-edit.

### Composition with F19 r5's `RuntimeStateMachine`

A new sibling action is added to [F19 02-design-r5.md §Actions](../F19-runtime-pinned-failed-card/02-design-r5.md#actions). The choice is between widening the existing `executor_finish` action's `finalStatus` union and adding a sibling action; we add a sibling action because the row in [F19 02-design-r5.md §Permission-matrix + `validateTransition` rules per action](../F19-runtime-pinned-failed-card/02-design-r5.md#permission-matrix--validatetransition-rules-per-action) becomes hard to read otherwise (the row "from `running`, emits one step" only stays interpretable per row if each action has one outcome shape).

```ts
// src/runtime/state-machine.ts (post-F19 r5 + F20)
type RuntimeCardAction =
  | 'start' | 'restart' | 'cancel' | 'planner_set_status'
  | 'block' | 'complete' | 'fail'
  | 'executor_finish'                                     // F19 r5: running → done | running → failed
  | 'executor_partial_finish'                             // NEW (F20): running → needs_verification
  | 'reviewer_repair_resume'
  | 'crash_recovery_drop_to_backlog';
```

Action specification, in the same shape as the F19 r5 table:

| Action | From-state requirement | Matrix call | Emitted one-step sequence per legal source state |
|---|---|---|---|
| `executor_partial_finish` | `card.status === 'running'` | none (runtime-owned executor outcome) | `running`: `running → needs_verification` (1 step). Any other source state is rejected — invariant assertion mirroring `executor_finish`. |

The state machine's `executor_finish` action is **unchanged** — it still emits `running → done` or `running → failed`. `needs_verification → done | failed` is reached either by a follow-up `executor_finish` (when verification re-dispatch produces a canonical terminal result from `running`, after a prior `needs_verification → running` step driven by a hypothetical `executor_verification_resume` action) or by an analyst/reviewer-driven path that is **out of scope** for F20.

To keep F20 minimal, the only new edges driven by `RuntimeStateMachine` are `running → needs_verification`. The `needs_verification → running` re-dispatch path is **left to the operator/analyst surface in a follow-up PR**; the F20 PR ships the "produce-and-preserve" half and explicitly documents that a `needs_verification` card is parked until human or analyst action moves it. This bounds the F20 blast radius while still removing the false-`failed` defect today.

### Provenance detection at the runtime seam

The runtime must distinguish a "fallback-produced executor result" from a "model-declared executor verdict". The fallback at [src/agents/result-parser.ts L231-L269](../../../src/agents/result-parser.ts#L231-L269) already constructs a `result.parse_failure` envelope. We promote that signal to a typed flag on `ExecutorResult`:

```ts
// src/agents/result-parser.ts — ExecutorResult schema (post-F20)
export interface ExecutorResult {
  card_id: string;
  status: 'done' | 'failed';                              // UNCHANGED — keep schema binary
  status_text: string;
  error?: string;
  result?: Record<string, unknown>;
  artifacts: ExecutorArtifactDef[];
  attachments: ExecutorAttachmentDef[];
  summary?: string;
  fallback_kind?: 'tool_loop_terminated' | null;          // NEW — provenance flag
}
```

`buildExecutorFallbackResult` populates `fallback_kind: 'tool_loop_terminated'`. `parseExecutorResult` returns `fallback_kind: null` (or omits the field) for canonical envelopes. The runtime branches on this flag at the executor terminal write to choose between `executor_finish` and `executor_partial_finish` (see plan §Step 5).

The reason for keeping `ExecutorResult.status` binary rather than widening it to a tri-state is twofold: (i) the LLM-facing contract at [src/agents/agent-adapter.ts L334](../../../src/agents/agent-adapter.ts#L334) stays `'done' | 'failed'` — we don't want the model to pick `needs_verification` itself (that would be a different, broader change to the executor system prompt); (ii) the new state is a *runtime-derived* verdict from observable evidence (fallback-with-evidence), not a model-declared verdict.

### Files added

None. Every change is a single-line or two-line addition to existing files.

### Files reduced or deleted

None at the F20 PR boundary. A follow-up PR can collapse the L740 evidence-registration-downgrade post-F19-r5 — out of scope.

### Test contract

Three layers, mirroring F19 r5's structure ([F19 02-design-r5.md §Test contract](../F19-runtime-pinned-failed-card/02-design-r5.md#test-contract--assert-emitted-sequences-not-booleans)):

- **Unit (state machine)** — `tests/runtime/state-machine.test.ts` gains rows asserting the emitted one-step sequence for `executor_partial_finish`: from `running` emits `['running → needs_verification']`; from every other source state rejects with `steps == []` and one `state_machine_invalid_source_state` log line.
- **Unit (validators)** — `tests/schemas/validators.test.ts` (or the nearest existing card-record validation test) gains a parse case for a `CardRecord` with `status: 'needs_verification'`.
- **Integration (executor terminal write)** — new file `tests/runtime/executor-partial-finish.test.ts` drives `dispatchPendingActivations` with a `FakeExecutorResult` carrying `fallback_kind: 'tool_loop_terminated'` and `status: 'failed'`; asserts the emitted spy trace is `[L706 start/restart sequence] + ['running → needs_verification']`; asserts the on-disk `CardRecord.status === 'needs_verification'`; asserts `latest_self_report.status === 'failed'` (the fallback's claimed status is preserved); asserts `result.parse_failure` is present; asserts no `card_failed` event is emitted; asserts the new card-history entry kind is `card_mutation` (not a terminal failure entry).

### Failure modes

- **Stuck `needs_verification` cards**: with the F20 PR alone, a card in `needs_verification` is parked until a follow-up PR adds the verification-resume path. The operator dashboard makes this visible via the new badge, but no automatic recovery exists. **Mitigation**: the badge is amber (distinct from green `done` / red `failed`); the documented follow-up is an analyst-surface action that calls a future `executor_verification_resume` machine action.
- **`fallback_kind` provenance gap**: if a third call site for the fallback is added later without populating the flag, the runtime falls back to treating the result as a model-declared `failed`. **Mitigation**: the flag is a required field on `buildExecutorFallbackResult`'s return type post-F20 (`fallback_kind: 'tool_loop_terminated'` literal in the return object), not optional; any new fallback-construction site is structurally forced to set it.
- **Permission-matrix completeness**: every `(role, action, state)` triple must still resolve to a decision. `matrixCompletenessTriples()` at [src/permissions/card-permissions.ts L98-L107](../../../src/permissions/card-permissions.ts#L98-L107) walks `PERMISSION_ROLES × CARD_ACTIONS × CARD_STATES`. Adding `needs_verification` to `CARD_STATES` requires the matrix entries to cover that state for every role/action combination. The plan handles this by extending the `NOT_*` exception sets, which are computed from the affirmative sets — `needs_verification` falls into all `NOT_*` sets by construction (it is not in `STARTABLE`, `DELETABLE`, `PLANNER_MUTABLE`, `RESTARTABLE`, or `ANALYST_RESTARTABLE`), so the existing `wrong_state`-deny rows cover it automatically.

### API impact

`/api/cards/:id` and the `/api/state` payload surface `CardStatus`; both relay the new literal verbatim, no schema-version bump is needed because the v1 surface is in flux per project guideline. No `/api/runtime/*` endpoint changes.

## Proposal B — Re-enter `backlog` on executor early-termination (NOT RECOMMENDED)

When `buildExecutorFallbackResult` produces a result, the runtime transitions `running → backlog` (the F19 r5 machine emits this via a new `executor_partial_finish` action whose one-step is `running → backlog` instead of `running → needs_verification`) and treats the card as eligible for re-dispatch on the next runtime tick. No new `CardStatus` member; no schema/permission/web fanout.

### Why it is not recommended

- **Lost semantic.** A `backlog` card is by definition "not yet started"; the operator dashboard, dispatch logic, and badge mapping treat `backlog` as "pristine work waiting to begin". A card that already wrote 13 vitest cases and a passing build to disk is not pristine. Operator review and analyst inspection cannot distinguish "card we never touched" from "card whose executor was interrupted mid-flight". Both states render identically as grey-`backlog`.
- **Duplicate-work risk.** Re-dispatching a card with an in-progress diff already on disk causes the next executor turn to start from the partial state without explicit signalling. The system has no other mechanism to mark "resume from these artefacts" — the `result.parse_failure` envelope is buried in the card record. The next executor turn is likely to either redo the work, conflict with the on-disk diff, or rewrite the partial artefacts.
- **Audit gap.** `card_failed` is not emitted (correct), but no positive "verification owed" signal is emitted either. The operator dashboard shows the card moved silently from `running` back to `backlog`; the only on-disk trace is the `latest_self_report` payload.
- **Asymmetry with F19 r5's design.** F19 r5 explicitly closes the `running → backlog` channel for crash-recovery via a dedicated `crash_recovery_drop_to_backlog` action with semantics "the runtime crashed mid-flight, throw away in-flight state". Reusing the same target state for "executor produced something and got cut off" overloads the `backlog` semantic with two distinct meanings.

The only argument in favour of Proposal B is that it's smaller — but project guidelines explicitly prefer architecture-first over minimal-change. The "smaller" win is also illusory once you account for the operator-confusion follow-ups it forces.

## Recommendation

**Proposal A.** It names a real lifecycle state that the system already encounters but currently fudges. The fanout (one enum member, one validator schema, one transition-matrix row, one permission `CARD_STATES` row, one web badge entry, one new state-machine action with a single legal one-step) is the minimum set required for the new semantic to be honest end-to-end. The blast radius is bounded by ordering F20 after F19 r5 (so the state machine is already in place) and by deferring the `needs_verification → running` re-dispatch path to a follow-up PR (so F20 ships the producer side without committing to the verification-resume protocol).

## Sequencing

1. **F19 r5** lands first ([F19 03-plan-r5.md](../F19-runtime-pinned-failed-card/03-plan-r5.md)).
2. **F20 r1** rebases onto the state machine: adds `needs_verification` + `executor_partial_finish`. The conversion at [F19 03-plan-r5.md §Step 5 — L725-733](../F19-runtime-pinned-failed-card/03-plan-r5.md#step-5--route-runtime-originating-cardstore-status-writes-through-await-transitioncard-await-every-follow-up-cardstoreupdate) is extended to branch on `execResult.fallback_kind`.
3. A future PR (not F20) adds the `needs_verification → running` verification-resume path and the analyst/operator-facing tools that drive it.

## Changes vs prior revisions

This is r1 — no prior revisions.
