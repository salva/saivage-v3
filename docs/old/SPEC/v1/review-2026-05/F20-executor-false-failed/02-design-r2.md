# F20 — Design (r2)

Supersedes [02-design-r1.md](02-design-r1.md). Addresses [02-design-review-r1.md](02-design-review-r1.md) asks D1, D2, D3, D4, D5, D6 and references the analysis in [01-analysis-r2.md](01-analysis-r2.md).

## Proposal (chosen — Proposal A, scoped)

Add a new terminal-adjacent lifecycle slot `needs_verification` and a discriminated `ExecutorResult.fallback_with_evidence` field. The executor terminal write branches by `(registrationFailed, fallback_with_evidence)` and emits exactly one F19 r5 state-machine action; the activation ledger and parent planner envelope receive the truthful outcome. No resume action ships in F20 — see [§D1](#d1-resume-contract--remove-extra-edges-park-state-name-follow-up-f24).

### D1 — resume contract: remove extra edges, park state, name follow-up F24

The review's D1 named two options. F20 picks **Option B: accept the parked state, name a follow-up issue**.

- **F20-owned outgoing edges from `needs_verification`:** `['cancelled']` only. Rationale: operator/runtime needs an escape hatch to dispose of a parked card (e.g., the parent goal is cancelled or rescinded). No `done`, `failed`, `running`, `backlog` edges are introduced in F20. This satisfies D2 ("shrink VALID_TRANSITIONS to the edges F20 actually owns and tests").
- **No `'needs_verification_resume'` / `'needs_verification_reject'` actions in F20.** Resuming a parked card is the responsibility of follow-up **F24 — needs_verification resume contract**. F24's scope (not part of F20): add `needs_verification → running` and `needs_verification → failed` edges via two new state-machine actions, plus operator UI affordances. F24 is referenced by name in [03-plan-r2.md §Validation gate / parked-state acceptance](03-plan-r2.md#step-p1--acceptance-test-resume-or-park-no-50-iter-spin-not-failed-operator-visible-parked-state).
- **Operator visibility while parked:** the card is visible in the existing cards views with the truthful status badge (see [§D4](#d4-web-fanout--every-consumer-touched-and-asserted)). The dashboard surfaces it under the existing "blocked/changed/failed/needs-attention" gutter (no new dashboard widget in F20).
- **Goal-loop termination guarantee:** `dispatchPendingActivations` reads activation status via `getPendingActivationCards`; activations whose status is `'completed' | 'failed' | 'blocked' | 'cancelled' | 'needs_verification'` are not re-dispatched. With the activation ledger receiving the truthful `'needs_verification'` outcome (see [§D3](#d3-truthful-activation-outcome--widen-runtimeactivationstatus--runtimerunrecordresult)), the parent goal exits its dispatch iteration cleanly. The acceptance test in [03-plan-r2.md §P1](03-plan-r2.md#step-p1--acceptance-test-resume-or-park-no-50-iter-spin-not-failed-operator-visible-parked-state) asserts loop termination in ≤ 2 iterations, no spin, no 50-iter cap.

### D2 — `VALID_TRANSITIONS` minimal surface

Concrete diff against the post-F19 r5 `VALID_TRANSITIONS` (see [F19 02-design-r5.md](../F19-runtime-pinned-failed-card/02-design-r5.md) for the F19 r5 baseline). F20 adds exactly two edges and one matrix row.

```ts
export const VALID_TRANSITIONS: Record<CardStatus, CardStatus[]> = {
  drafting: ['backlog', 'cancelled'],
  backlog: ['active', 'running', 'cancelled', 'drafting'],
  active: ['running', 'blocked', 'cancelled', 'changed'],
  running: ['done', 'failed', 'blocked', 'cancelled', 'changed', 'needs_verification'],
  blocked: ['running', 'cancelled', 'changed', 'failed'],
  changed: ['running', 'backlog', 'cancelled', 'failed'],
  done: ['changed', 'failed'],
  failed: ['changed', 'cancelled'],
  cancelled: [],
  needs_verification: ['cancelled'],
};
```

Differences from the F19 r5 baseline:
- Added `'needs_verification'` to `running`'s outgoing list (one new edge: `running → needs_verification`).
- Added `needs_verification: ['cancelled']` row.

No `needs_verification → {done, failed, running, backlog}` edges. No `done → needs_verification` or `failed → needs_verification` edges. Anything beyond the two listed deltas is F24 or out-of-scope.

### D3 — truthful activation outcome — widen `RuntimeActivationStatus` / `RuntimeRunRecord.result`

The review's D3 forbids "map `needs_verification → 'failed'` in the activation ledger or run record." F20 widens the three unions and emits the truthful literal at the single executor-terminal site.

Concrete schema deltas (text only — code lands in [03-plan-r2.md §Step S2](03-plan-r2.md#step-s2--schema--state-machine-widenings)):

- [src/schemas/types.ts L73](../../../src/schemas/types.ts) — `ActivationCompletionOutcome`: add `'needs_verification'`.
- [src/schemas/types.ts L31](../../../src/schemas/types.ts) — `RuntimeActivationStatus`: add `'needs_verification'`.
- [src/schemas/types.ts L33](../../../src/schemas/types.ts) — `RuntimeRunRecord.result`: add `'needs_verification'`.
- [src/schemas/validators.ts L13](../../../src/schemas/validators.ts#L13) — `cardStatusSchema`: add `'needs_verification'` literal.
- [src/schemas/validators.ts L53](../../../src/schemas/validators.ts#L53) — `activationCompletionOutcomeSchema`: add `'needs_verification'` literal.
- [src/schemas/validators.ts L106](../../../src/schemas/validators.ts#L106) — `runtimeActivationStatusSchema`: add `'needs_verification'` literal.

`markActivationComplete` at [src/runtime/runtime.ts L171](../../../src/runtime/runtime.ts#L171) keeps its existing shape `terminalStatus = outcome === 'done' ? 'completed' : outcome` and `runResult = outcome === 'done' ? 'done' : outcome`. With the widened unions, `outcome === 'needs_verification'` flows verbatim into both `runtime_activations.status` and `RuntimeRunRecord.result`. No special case is required at the call site; the truthful value lands in both ledgers.

`appendChildUnwindToolResult` at [src/runtime/runtime.ts L187](../../../src/runtime/runtime.ts#L187) receives `outcome: ActivationCompletionOutcome` and passes it into `createActivationCompletionEnvelope`. The parent planner sees `outcome: 'needs_verification'` in the activation completion envelope. No planner-side branching is added in F20 (the planner already routes unknown completion outcomes through its existing inspection / hold path; F24 will add explicit resume affordances).

`CARD_STATES` (the `Set<CardStatus>` mirror) and `TERMINAL_STATES` / `TERMINAL_STATUSES`:
- `CARD_STATES`: add `'needs_verification'`.
- `TERMINAL_STATES` ([src/schemas/types.ts ~L52](../../../src/schemas/types.ts)) and `TERMINAL_STATUSES` ([src/runtime/runtime.ts L83](../../../src/runtime/runtime.ts#L83)): **do NOT include `'needs_verification'`**. The card is parked but the lifecycle is not done — making it "terminal" would let `getPendingActivationCards` and `cleanupResolvedActivations` treat the parent activation as collectable, defeating D1's park semantic.
- `STARTABLE_STATES`, `RESTARTABLE_STATES`, `PLANNER_MUTABLE_STATES`, `DELETABLE_STATES`, `ANALYST_RESTARTABLE_STATES`: **do NOT include `'needs_verification'`** in F20. F24 will reconsider `RESTARTABLE_STATES` membership when introducing resume.

### D4 — web fanout — every consumer touched and asserted

Every place in `web/src/` that depends on the exhaustive `CardStatus` union (records, ordered arrays, CSS class enumerations, icon maps, fixtures) is enumerated below. Plan §P4 ([03-plan-r2.md §Step P4](03-plan-r2.md#step-p4--frontend-fanout-every-consumer-final-rg-gate)) runs a final `rg` gate against this list.

Consumers touched in F20:

| File | Reason | Concrete edit |
|---|---|---|
| [web/src/api/types.ts L12-L21](../../../web/src/api/types.ts#L12-L21) | `CardStatus` union | Add `'needs_verification'` literal. `childCounts: Record<CardStatus, number>` (L176) becomes exhaustive automatically. |
| [web/src/components/cards/CardDetailView.vue L319-L331](../../../web/src/components/cards/CardDetailView.vue#L319-L331) | `Record<CardStatus, string>` explainer map | Add `needs_verification: 'Executor produced artefacts but its tool-call loop ended before verification finished; operator follow-up is required to accept or reject the work.'`. |
| [web/src/components/cards/CardDetailView.vue L543-L546](../../../web/src/components/cards/CardDetailView.vue#L543-L546) | `.status-*` badge CSS | Add `.status-needs_verification { background:#231f12; color:#d29922; border-color:#9e6a03; }`. |
| [web/src/components/cards/CardsTreeView.vue L206-L213](../../../web/src/components/cards/CardsTreeView.vue#L206-L213) | `.status-*` dot CSS | Add `.status-needs_verification { background: #d29922; }`. |
| [web/src/components/cards/CardsTimelineView.vue L58-L63](../../../web/src/components/cards/CardsTimelineView.vue#L58-L63) | `Record<CardStatus, string>` icon map | Add `needs_verification: '⚠'`. |
| [web/src/components/cards/CardsTimelineView.vue L153-L158](../../../web/src/components/cards/CardsTimelineView.vue#L153-L158) | `.tl-marker.status-*` CSS | Add `.tl-marker.status-needs_verification { border-color: #d29922; background: #231f12; }`. |
| [web/src/components/cards/CardsTimelineView.vue L199-L206](../../../web/src/components/cards/CardsTimelineView.vue#L199-L206) | `.tl-status.status-*` CSS | Add `.tl-status.status-needs_verification { background: #231f12; color: #d29922; }`. |
| [web/src/components/cards/CardsBoardView.vue L71-L73](../../../web/src/components/cards/CardsBoardView.vue#L71-L73) | `STATUS_ORDER: CardStatus[]` | Insert `'needs_verification'` between `'failed'` and `'cancelled'`. |
| [web/src/components/cards/CardsBoardView.vue L150-L158](../../../web/src/components/cards/CardsBoardView.vue#L150-L158) | `.status-*` column-header CSS | Add `.status-needs_verification { background: #d29922; }`. |
| [web/src/stores/cards.ts L158](../../../web/src/stores/cards.ts#L158) | `statuses: CardStatus[]` board column ordering | Insert `'needs_verification'` between `'failed'` and `'cancelled'`. |
| [web/src/views/CardsView.vue L246](../../../web/src/views/CardsView.vue#L246) | `statuses: CardStatus[]` filter dropdown ordering | Insert `'needs_verification'` between `'failed'` and `'cancelled'`. |
| [web/src/\_\_tests\_\_/card-detail-view.test.ts L32](../../../web/src/__tests__/card-detail-view.test.ts#L32) | `childCounts` fixture must list every `CardStatus` key | Add `needs_verification: 0` to the fixture object. |

Consumers verified to NOT need edits (each one was checked via grep):
- [web/src/stores/runtime.ts L97-L99](../../../web/src/stores/runtime.ts#L97-L99) — reads `cardIndex.value.byStatus['done' | 'failed' | 'blocked']` by literal, not by exhaustive enumeration. `needs_verification` is parked and intentionally not folded into `doneGoals` or the "problem" count in F20 (operator follow-up is a distinct surface from "broken" or "stuck").
- [web/src/stores/agents.ts](../../../web/src/stores/agents.ts) — operates on session status, a different union.
- [web/src/components/cards/CardsLeaderboardView.vue L24, L78](../../../web/src/components/cards/CardsLeaderboardView.vue#L24) — explicitly literal-matches `'done' | 'failed'` (leaderboard semantic is "evaluation-eligible"). `needs_verification` is not evaluation-eligible.
- [web/src/stores/debug.ts L270](../../../web/src/stores/debug.ts#L270) — `problemCards` literal-matches `'failed' | 'blocked'`. `needs_verification` is parked, not a "problem"; it requires operator action, which the cards views surface via the explainer above.

### D5 — honest A-vs-B trade-off (Proposal A surface area)

The review's D5 demanded a truthful surface-area accounting. The full F20 surface area for **Proposal A (chosen)** is:

**Schemas and runtime (`src/`):**
1. `src/schemas/types.ts` — `CardStatus` union (+1 literal).
2. `src/schemas/types.ts` — `ActivationCompletionOutcome` union (+1 literal).
3. `src/schemas/types.ts` — `RuntimeActivationStatus` union (+1 literal).
4. `src/schemas/types.ts` — `RuntimeRunRecord.result` union (+1 literal).
5. `src/schemas/types.ts` — `CARD_STATES` Set (+1 entry).
6. `src/schemas/validators.ts` — `cardStatusSchema`, `activationCompletionOutcomeSchema`, `runtimeActivationStatusSchema` (+1 literal each).
7. `src/runtime/state-machine.ts` — new `'executor_partial_finish'` action.
8. `src/runtime/state-machine.ts` — `VALID_TRANSITIONS.running` (+1 edge) and new `needs_verification` matrix row.
9. `src/agents/result-parser.ts` — extend `ExecutorResult` with `fallback_with_evidence: { reason: 'tool_calls_envelope_recovery' | 'self_check_recovery' | 'parse_failure' } | null`; populate in `buildExecutorFallbackResult`; set to `null` everywhere else (canonical-done, canonical-failed, top-level `if (!hadEvidence) return null` exit).
10. `src/agents/result-parser.ts` — extend `ExecutorFallbackContext` with `reason`.
11. `src/agents/agent-adapter.ts` — three call sites at [L531](../../../src/agents/agent-adapter.ts#L531), [L548](../../../src/agents/agent-adapter.ts#L548), [L554](../../../src/agents/agent-adapter.ts#L554) pass distinct typed `reason` values.
12. `src/runtime/runtime.ts` — executor terminal branch (5-step ordering per [01-analysis-r2.md §A3](01-analysis-r2.md#composition-with-f19-r5--concrete-post-f19-branch-ask-a3)): adds `'executor_partial_finish'` action selection by `(registrationFailed, execResult.fallback_with_evidence)`; computes outcome literal for `appendChildUnwindToolResult` / `markActivationComplete`.
13. Fake agent fixtures and tests under `tests/fixtures/` and `tests/agents/` — extend `ExecutorResult` synthetic builders.

**Web (`web/src/`):** 12 touches enumerated in the [§D4 table](#d4-web-fanout--every-consumer-touched-and-asserted) above.

**Test additions (`tests/`):** parser tests (canonical-null / fallback-with-evidence-provenance / fallback-without-evidence-null / adapter-call-site-reason-matches), state-machine tests (legal `running → needs_verification`, legal `needs_verification → cancelled`, rejection of all other outgoing edges), runtime integration tests (parked outcome, no `card_failed`, no spin, registrationFailed precedence, rejection path unchanged), parked-state acceptance test, web component snapshot/coverage for `needs_verification` rendering.

**Honest A-vs-B trade-off:** Proposal A's surface is larger than r1 represented — 13 src/ touches plus 12 web touches plus schema/validator updates plus state-machine action plus test additions. The alternative **Proposal B (overload `'blocked'` with `result.reason = 'needs_verification'`)** has a smaller schema surface (no enum widening, no validator changes, no web changes beyond explainer/badge tweaks if any) but compounds three pre-existing problems: (i) `'blocked'` already means "external dependency or operator-input required"; overloading it with "executor produced artefacts but verification incomplete" destroys the operator's ability to triage by status; (ii) the activation outcome `'blocked'` already routes to a distinct planner/operator path inconsistent with parked-but-evidence-present semantics; (iii) the dashboard `errorOrBlocked` count would inflate with non-error parked cards. Proposal A's larger surface buys truthful lifecycle semantics — every downstream surface tells the operator the same true story.

### D6 — snippets stripped of comments

All code snippets in this document and in [03-plan-r2.md](03-plan-r2.md) are written without `// NEW`, explanatory comments, or CSS comments. Comments that would normally explain F20's intent are kept in document prose, not in snippets.

## ExecutorResult shape change (referenced from §c, §D5 item 9)

```ts
export interface ExecutorResult {
  card_id: string;
  status: 'done' | 'failed';
  status_text: string;
  error?: string;
  summary: string;
  artifacts: string[];
  attachments: string[];
  result: Record<string, unknown> | null;
  fallback_with_evidence: { reason: 'tool_calls_envelope_recovery' | 'self_check_recovery' | 'parse_failure' } | null;
}

export interface ExecutorFallbackContext {
  cardId: string;
  reason: 'tool_calls_envelope_recovery' | 'self_check_recovery' | 'parse_failure';
}
```

`buildExecutorFallbackResult` writes `fallback_with_evidence: { reason: context.reason }` on every non-null return; canonical parser paths (`parseExecutorEnvelope` happy path) write `fallback_with_evidence: null` on their returned object.

## State-machine action shape change

New action `'executor_partial_finish'` in the F19 r5 `RuntimeStateMachine.transitionCard` union:

```ts
type RuntimeStateMachineAction =
  | { kind: 'planner_dispatch'; ... }
  | { kind: 'executor_finish'; goalId: string; finalStatus: 'done' | 'failed' }
  | { kind: 'executor_partial_finish'; goalId: string; reason: 'tool_calls_envelope_recovery' | 'self_check_recovery' | 'parse_failure' }
  | ...;
```

`'executor_partial_finish'` legal source: `running`. Legal target: `needs_verification`. Emits one `cardStatusChanged` event with `from: 'running', to: 'needs_verification', reason`.

## Goal-loop termination (parked-state, ≤ 2 iterations)

After step (5) of the post-F19 branch ([01-analysis-r2.md §A3](01-analysis-r2.md#composition-with-f19-r5--concrete-post-f19-branch-ask-a3)):
1. The card is `needs_verification`.
2. `runtime_activations.status === 'needs_verification'`. `getPendingActivationCards` does not return it.
3. `RuntimeRunRecord.result === 'needs_verification'`. The run is closed.
4. The parent planner activation envelope outcome is `'needs_verification'`. No `card_failed` / no `card_done`.
5. `dispatchPendingActivations` returns `{ failed: false, ... }`. The goal-loop iteration ends. The next iteration finds no pending activations and the planner returns its next decision; the goal is not re-dispatched. The acceptance test in [03-plan-r2.md §P1](03-plan-r2.md#step-p1--acceptance-test-resume-or-park-no-50-iter-spin-not-failed-operator-visible-parked-state) asserts ≤ 2 dispatch iterations and no spin.

## Changes vs r1

- **D1.** Chose Option B (parked state + named follow-up F24-needs-verification-resume); resume action explicitly NOT in F20 scope.
- **D2.** `VALID_TRANSITIONS.needs_verification = ['cancelled']` only; `running → needs_verification` is the sole new ingress. Rejected r1's broader `needs_verification → {done, failed, running, backlog}` edges.
- **D3.** Widened `ActivationCompletionOutcome`, `RuntimeActivationStatus`, `RuntimeRunRecord.result` to carry `'needs_verification'` truthfully. No mapping to `'failed'` in any downstream surface.
- **D4.** Enumerated every web consumer with file path, line range, and concrete edit; included `card-detail-view.test.ts` fixture; documented intentional non-edits with rationale.
- **D5.** Stated full surface area honestly (13 src/ + 12 web/ + schemas + state-machine + tests) and gave a substantive A-vs-B trade-off.
- **D6.** All snippets in r2 documents have no `// NEW`, no runtime comments, no CSS comments.
- F19 r5 composition: `'executor_partial_finish'` is a sibling action to F19 r5's `'executor_finish'`. F20 does not rewrite any F19 r5 file; the runtime change is contained inside the executor-terminal restructure F19 r5 already authorises.
