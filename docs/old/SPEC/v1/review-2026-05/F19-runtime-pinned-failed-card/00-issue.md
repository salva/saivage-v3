# F19 — Runtime status pinned to a `failed` current card; no auto-replan

## Summary

`/api/runtime/status` reports `runtime=running paused=false currentCardId=<X> goalCount=0` while card `<X>` is `status=failed` with `allowedActions=[card.delete, card.restart]`. The dashboard's runtime badge remains green/running indefinitely after a card failure. The runtime never auto-advances to a follow-up card and never replans, even though planner replanning is otherwise wired (see G5/T34). This is the most operator-visible wedge in Phase-2 and is closely related to [F20](../F20-executor-false-failed/00-issue.md) (executor reported false failure) and [F23](../F23-invalid-failed-active/00-issue.md) (orchestrator tried illegal `failed→active` transition twice and gave up).

## Evidence

- Phase-2 G5/T38: [tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G5-report.md](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G5-report.md) §T38; raw [t38-runtime-status.json](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t38-runtime-status.json), [t38-card-final.json](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/t38-card-final.json).
- Owner code: [src/runtime/active-runtime.ts](../../../src/runtime/active-runtime.ts) (`getStatus` and current-card tracking); [src/runtime/control.ts](../../../src/runtime/control.ts) (lifecycle decisions); [src/server/server.ts](../../../src/server/server.ts) line 64 (inline status route).

## Category

half-implemented (lifecycle terminator) / bad design (no liveness contract on `runtime=running`)

## Severity

P1 — runtime appears alive when it has wedged; operator must manually intervene.

## Transversality

Cross-cutting: runtime, cards (status-machine awareness), API surface, UI. Resolution requires a contract: "`runtime=running` ⇒ either `currentCardId` is non-terminal or a replan tick is scheduled within N seconds."
