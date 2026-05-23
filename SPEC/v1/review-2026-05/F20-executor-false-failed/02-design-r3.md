# F20 — Design (r3)

Supersedes [02-design-r2.md](02-design-r2.md). Addresses [01-analysis-review-r2.md](01-analysis-review-r2.md) Design Issues 1 and 2. Every other section of r2 (§D1, §D4, §D5, §D6, the `ExecutorResult` shape change, the state-machine action shape, the goal-loop termination guarantee) is unchanged and inherited verbatim from r2.

## D2 — `VALID_TRANSITIONS` minimal surface (corrected)

Source of truth: [src/cards/card-store.ts#L217-L227](../../../src/cards/card-store.ts#L217-L227) (the F19 r5 hard-pin per [F19 02-design-r5.md §Source-of-truth constants](../F19-runtime-pinned-failed-card/02-design-r5.md#machine-surface)). F20 does NOT relocate this constant.

### Baseline — post-F19 r5, verbatim from `src/cards/card-store.ts:217-227`

```ts
const VALID_TRANSITIONS: Record<CardStatus, CardStatus[]> = {
  drafting: ['backlog', 'cancelled'],
  backlog: ['active', 'cancelled'],
  active: ['running', 'cancelled', 'backlog'],
  running: ['done', 'failed', 'blocked', 'changed', 'cancelled', 'backlog'],
  blocked: ['backlog', 'running', 'changed', 'cancelled'],
  changed: ['backlog', 'active', 'cancelled'],
  done: ['backlog', 'cancelled'],
  failed: ['backlog', 'cancelled'],
  cancelled: ['drafting'],
};
```

### F20 deltas — TWO and only TWO

1. Append `'needs_verification'` to the `running` row's targets.
2. Add new row `needs_verification: ['cancelled']`.

```ts
const VALID_TRANSITIONS: Record<CardStatus, CardStatus[]> = {
  drafting: ['backlog', 'cancelled'],
  backlog: ['active', 'cancelled'],
  active: ['running', 'cancelled', 'backlog'],
  running: ['done', 'failed', 'blocked', 'changed', 'cancelled', 'backlog', 'needs_verification'],
  blocked: ['backlog', 'running', 'changed', 'cancelled'],
  changed: ['backlog', 'active', 'cancelled'],
  done: ['backlog', 'cancelled'],
  failed: ['backlog', 'cancelled'],
  cancelled: ['drafting'],
  needs_verification: ['cancelled'],
};
```

No other rows are rewritten. F20 explicitly does NOT touch `cancelled → drafting`, `done → backlog|cancelled`, `failed → backlog|cancelled`, `running → backlog`, `blocked → backlog|running|changed|cancelled`, or `changed → backlog|active|cancelled`. Anything beyond the two listed deltas is F24 or out-of-scope (D1's parked-state contract: only `cancelled` is a legal outgoing edge from `needs_verification` in F20).

## D3 — truthful activation outcome — `markActivationComplete` mapper fix

The r2 design claimed the existing mapper at [src/runtime/runtime.ts#L171-L183](../../../src/runtime/runtime.ts#L171-L183) would propagate `'needs_verification'` verbatim once the unions were widened. That is wrong for `RuntimeRunRecord.result`: the current mapper hard-codes a four-way ternary that collapses every non-`done`/`blocked`/`cancelled` outcome to `'failed'`.

Current code at [src/runtime/runtime.ts#L172-L173](../../../src/runtime/runtime.ts#L172-L173):

```ts
const terminalStatus = outcome === 'done' ? 'completed' : outcome;
const runResult: RuntimeRunRecord['result'] =
  outcome === 'done' ? 'done'
  : outcome === 'blocked' ? 'blocked'
  : outcome === 'cancelled' ? 'cancelled'
  : 'failed';
```

For `outcome === 'needs_verification'`:
- `terminalStatus` already evaluates to `'needs_verification'` (good — passes verbatim into `runtime_activations.status` once `RuntimeActivationStatus` is widened in §D3 r2).
- `runResult` falls through to the `'failed'` literal — the exact false-failed leak D3 was meant to close.

### Corrected mapper

F20 changes the `runResult` line to propagate `'needs_verification'` truthfully. The minimum-surface edit replaces the four-way ternary with a fall-through to `outcome` for the truthful terminal values, mirroring the shape of `terminalStatus`:

```ts
const terminalStatus = outcome === 'done' ? 'completed' : outcome;
const runResult: RuntimeRunRecord['result'] =
  outcome === 'done' ? 'done'
  : outcome === 'blocked' ? 'blocked'
  : outcome === 'cancelled' ? 'cancelled'
  : outcome === 'needs_verification' ? 'needs_verification'
  : 'failed';
```

Adding the `outcome === 'needs_verification' ? 'needs_verification'` branch (and only that branch) is the minimum-surface fix. The trailing `'failed'` literal is preserved as the fallthrough for any future `ActivationCompletionOutcome` literal that does not yet have an explicit branch (today: `'timed_out'`); F20 does not change that semantic.

### Test that fails without this fix

Plan [§Step P2 Test 1](03-plan-r3.md#step-p2--runtime-integration-tests-for-needs_verification-and-rejection-path-regression) (happy parked) asserts `RuntimeRunRecord.result === 'needs_verification'`. Without the mapper edit, the run record would carry `'failed'` and the test would fail — guarding against future regression of this exact issue.

Every other surface in §D3 r2 (the union widenings on `ActivationCompletionOutcome`, `RuntimeActivationStatus`, `RuntimeRunRecord.result`, and the validator literals; the `appendChildUnwindToolResult` truthful propagation; the planner envelope; `CARD_STATES` / `TERMINAL_STATES` / `TERMINAL_STATUSES` membership decisions) is unchanged from r2.

## Sections inherited unchanged from r2

- [§D1 — resume contract: remove extra edges, park state, name follow-up F24](02-design-r2.md#d1-resume-contract--remove-extra-edges-park-state-name-follow-up-f24).
- [§D4 — web fanout — every consumer touched and asserted](02-design-r2.md#d4-web-fanout--every-consumer-touched-and-asserted).
- [§D5 — honest A-vs-B trade-off](02-design-r2.md#d5--honest-a-vs-b-trade-off-proposal-a-surface-area).
- [§D6 — snippets stripped of comments](02-design-r2.md#d6--snippets-stripped-of-comments).
- `ExecutorResult` shape change (`fallback_with_evidence: { reason } | null`).
- State-machine action shape change (`'executor_partial_finish'`).
- Goal-loop termination guarantee (≤ 2 iterations).

## Changes vs r2

- **D2.** Replaced the r2 matrix (which silently rewrote `backlog`, `active`, `blocked`, `changed`, `done`, `failed`, `cancelled` rows) with the verbatim post-F19 baseline from `src/cards/card-store.ts:217-227` plus the two named deltas (`running` row += `'needs_verification'`; new row `needs_verification: ['cancelled']`). No unrelated edges are touched.
- **D3.** Added explicit `markActivationComplete` mapper fix: `runResult` must include an `outcome === 'needs_verification' ? 'needs_verification'` branch. r2 missed this and the ledger would have written `'failed'`.
- Every other r2 section unchanged.
