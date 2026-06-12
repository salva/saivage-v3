# F23 — Orchestrator attempts illegal `failed → active` transition

## Summary

`errors.jsonl` recorded two consecutive `Invalid transition: failed → active. Valid transitions from failed are: backlog, cancelled.` errors (2026-05-23 13:45:42 and 13:48:11) on the wedged card. The orchestrator is calling the wrong recovery path: instead of routing through the allowed `backlog` (re-enqueue for replan) or `cancelled` (give up) transitions, it tries to flip the failed card directly back to `active` twice and then gives up — leaving the runtime in the F19 wedge. The fix is either to re-route the orchestrator's "retry" code path through `backlog` (preserving the state machine), or to make `failed → backlog` an explicit auto-recovery action on a clock.

## Evidence

- Phase-2 G5/T45: [tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G5-report.md](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G5-report.md) §T45; `errors.jsonl` lines 2 and 3.
- Owner code: [src/permissions/](../../../src/permissions/) (state-matrix validator that rejects the transition), [src/runtime/control.ts](../../../src/runtime/control.ts) and [src/runtime/lifecycle.ts](../../../src/runtime/lifecycle.ts) (caller doing the wrong thing), [src/cards/card-store.ts](../../../src/cards/card-store.ts) (mutation entry).

## Category

bad design (wrong recovery path) / inconsistency (orchestrator vs state machine)

## Severity

P2 — root cause of the F19 wedge; once `failed→backlog` is wired, F19's symptoms should largely disappear.

## Transversality

Cross-cutting: state-machine matrix, runtime control, card store. Touches the same files as [F19](../F19-runtime-pinned-failed-card/00-issue.md) and [F20](../F20-executor-false-failed/00-issue.md); the three should be sequenced together.
