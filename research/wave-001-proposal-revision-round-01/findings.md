# Wave 001 proposal revision after review round 01

Task: `t2b-revise-proposals-round-01`  
Stage: `cycle-001-runtime-core-ports-state-machine`  
Date: 2026-05-26

## Summary

Round-01 review blocked Wave 001 proposal approval because both proposals under-specified the mandatory validation matrix, `proposal-direct.md` did not define the invariant/redispatch/port split precisely enough, and `proposal-restructure.md` was too large for a bounded Wave 001 cycle.

This task revised:

- `architecture-audit/cycle-001-runtime-core-ports-and-state-machine-extraction/proposals/proposal-direct.md`
- `architecture-audit/cycle-001-runtime-core-ports-and-state-machine-extraction/proposals/proposal-restructure.md`

No source code was modified.

## Review blockers addressed

### 1. Mandatory validation matrix

Both proposals now explicitly list the full required cadence:

- `npm run lint`
- `npm run typecheck`
- `npm run web:typecheck`
- focused backend Jest for touched runtime modules
- focused Vitest handling for touched web modules, with an expected skip if no `web/` files are touched
- `npm run web:test:sweep` handling, with an expected skip unless control-room code is touched
- full `npm test`
- `npm run build`
- `npm run docs:verify`
- `npm run web:test:e2e:smoke` expectations for runtime/server-observable changes
- live health probe and e2e target status logging

### 2. Direct proposal responsibility split

`proposal-direct.md` now defines the split among:

- pure card transition policy;
- narrow card state port;
- runtime lifecycle patch reducer;
- narrow runtime state port;
- invariant observation/correction planner;
- project-root redispatch planner;
- error, scheduler, clock, and redispatch ports.

The revised text explicitly prevents broad `CardStore` semantics from being reintroduced behind a generic port.

### 3. Restructure proposal narrowing

`proposal-restructure.md` was narrowed from a broad `RuntimeEngine` extraction into a bounded state-machine facade alternative. It now explicitly leaves these in `Runtime` for this wave:

- `startProject` / `stopProject` command-ledger orchestration;
- crash recovery;
- runtime run/intent persistence ownership outside current state-machine lifecycle patch calls;
- planner/manager/executor/reviewer/analyst dispatch;
- LLM/MCP/transport, server, web, and persistence-format concerns.

The revised proposal says any need to move those responsibilities requires a mini-cycle/delta proposal before implementation.

## Recommendation for next review

The direct proposal remains the better Wave 001 implementation candidate because it satisfies the state-machine port extraction objective with less churn. The restructure proposal is now a bounded alternative only if reviewers believe a named facade materially improves the boundary.

## Sources

- `architecture-audit/cycle-001-runtime-core-ports-and-state-machine-extraction/reviews/round-01-review.md`
- `architecture-audit/cycle-001-runtime-core-ports-and-state-machine-extraction/proposals/proposal-direct.md`
- `architecture-audit/cycle-001-runtime-core-ports-and-state-machine-extraction/proposals/proposal-restructure.md`
