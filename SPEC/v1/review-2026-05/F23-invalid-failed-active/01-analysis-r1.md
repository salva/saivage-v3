# F23 — Analysis (r1)

## Decision

**F23 is closure-mode: subsumed by [F19 r5](../F19-runtime-pinned-failed-card/02-design-r5.md).** F23 has no residual structural scope; it contributes acceptance tests only. The two runtime callers that can emit the illegal `failed → active` one-step transition are both converted by F19 r5 Step 5, and `RuntimeStateMachine` rejects illegal one-step `planner_set_status` requests with zero card writes.

## Root cause

The error originates in [src/cards/card-store.ts](../../../../src/cards/card-store.ts) L1081-1087:

```ts
validateTransition(from, to) {
  ...
  throw new Error(`Invalid transition: ${from} → ${to}. Valid transitions from ${from} are: ${allowed.join(', ') ?? 'none'}.`);
}
```

with `VALID_TRANSITIONS.failed = ['backlog', 'cancelled']` ([card-store.ts L217-L227](../../../../src/cards/card-store.ts#L217-L227)). Any caller that writes `status: 'active'` on a `failed` card triggers it.

### Runtime caller inventory (from F19 r5 Step 5 checklist)

| Site | Code | Failure mode when source is `failed` |
|---|---|---|
| [src/runtime/runtime.ts L706](../../../../src/runtime/runtime.ts#L706) | `if (card.status === 'backlog') setStatus(card.id, 'active'); setStatus(card.id, 'running')` | When `dispatchPendingActivations` picks a card already in `failed` (e.g., the F19 wedge where `current_card_id` still points at it after a previous failure), the `'backlog'` guard is skipped and `setStatus(card.id, 'running')` throws `failed → running`. The error text in the issue (`failed → active`) does not match this site directly — the symptom from this site is `failed → running`. |
| [src/runtime/runtime.ts L766-L782](../../../../src/runtime/runtime.ts#L766) | `cardStore.update(update.id, { status: update.status })` inside `applyPlannerResult.untrackedChanges` | When the planner emits an untracked `status: 'active'` for a `failed` card (planner tried to recover by re-activating), the runtime forwards it verbatim. The carve-out in `cardStore.update` (terminal-source `status` writes) does NOT bypass `validateTransition` for non-terminal targets, so this throws `Invalid transition: failed → active` — exact match for the issue text. |
| [src/tools/planner-tools.ts L163, L221](../../../../src/tools/planner-tools.ts#L163) | `store.update(cardId, { status: 'active' })` via planner-side `start_card` / `set_status` tools | Out of scope for F19 (planner tools are gated by the permission matrix); the runtime sees the failure only through the L766-L782 untracked-changes forwarder. |

The exact `failed → active` text in `errors.jsonl` is produced by the **L766-L782 path** (planner-supplied status forwarded by the runtime). The L706 path would produce `failed → running`. Both are convergent symptoms of the same root cause: the runtime has no state machine that rejects illegal one-step transitions before they reach `validateTransition`, and the orchestrator's "retry" path neither decomposes `failed → backlog → active → running` nor short-circuits at the planner-result writer.

## Why F19 r5 fully closes F23

[F19 r5 design](../F19-runtime-pinned-failed-card/02-design-r5.md) introduces `RuntimeStateMachine` with two contracts that jointly cover both callers above:

1. **`restart` action with `RESTARTABLE_STATES` decomposition** (F19 r5 design action table). The Step 5 conversion of [L706](../../../../src/runtime/runtime.ts#L706) selects `action = STARTABLE_STATES.includes(card.status) ? 'start' : 'restart'`. For `card.status === 'failed'` (a member of `RESTARTABLE_STATES`), the machine emits the uniform legal decomposition `failed → backlog → active → running` (three legal one-step writes through `validateTransition`). The orchestrator's retry path therefore goes through `backlog`, exactly the recovery shape the F23 issue calls for.

2. **`planner_set_status` rejects illegal one-step transitions** (F19 r5 design action table; r5 test contract). The Step 5 conversion of [L766-L782](../../../../src/runtime/runtime.ts#L766) replaces the direct `cardStore.update(update.id, { status: update.status })` with `await this._stateMachine.transitionCard(update.id, 'planner_set_status', { requestedStatus: update.status })`. The machine consults `cardStore.validateTransition(current, requested)` and, when the planner asked for `failed → active`, **rejects with one `state_machine_planner_status_rejected` log line and no card write**. The pre-r4 throw inside `validateTransition` is no longer reachable from this site because the machine rejects before issuing the underlying store call.

`errors.jsonl` therefore loses every `Invalid transition: failed → ...` line once F19 r5 Step 5 lands: the `restart` action emits only legal one-step writes, and the planner-status rejection bookkeeping is internal to the machine.

## Residual scope check

None of the following would justify a separate F23 design:

- **Planner-tools direct callers** at [src/tools/planner-tools.ts L163, L221](../../../../src/tools/planner-tools.ts#L163) are out of scope per F19 r5 §Out-of-scope card-status writers. They are gated by the planner permission matrix; the runtime never observes them directly. The F23 issue's `errors.jsonl` signature does not point at them.
- **Crash-recovery / `simulateCrash`** at [L614](../../../../src/runtime/runtime.ts#L614) / [L784](../../../../src/runtime/runtime.ts#L784) writes `→ backlog` (legal from any non-terminal source); the only non-legal target was `'failed' → 'backlog'` — wait, that IS legal per `VALID_TRANSITIONS.failed = ['backlog', 'cancelled']`. No F23 contribution from these sites.
- **No new actions** are needed beyond the F19 r5 `RuntimeCardAction` union. `restart` and `planner_set_status` together cover both observed callers.

## F23 contribution

F23 owns the **acceptance signal**: `errors.jsonl` shows zero `Invalid transition: failed → ...` lines after F19 r5 lands, and the orchestrator's retry path is observably routed through `backlog`. Design and plan revisions are kept minimal accordingly ([02-design-r1.md](02-design-r1.md), [03-plan-r1.md](03-plan-r1.md)).
