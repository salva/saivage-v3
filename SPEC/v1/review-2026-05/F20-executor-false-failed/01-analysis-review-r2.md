## Analysis

The r2 analysis addresses the three r1 analysis asks. It separates fallback provenance from parser mechanics with `fallback_with_evidence.reason`, extends the root-cause inventory through the activation/unwind surfaces, and pins the post-F19 ordering as registration first, then one state-machine action, then one awaited non-status card update. The `registrationFailed` precedence over `fallback_with_evidence` is explicit and test-backed in the plan.

No blocking analysis-only findings.

## Design

1. `RuntimeRunRecord.result` would still be written as `failed` for `needs_verification`. The design says [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) `markActivationComplete` can keep the shape `runResult = outcome === 'done' ? 'done' : outcome`, so widening the unions is enough. That does not match current code, and F19 r5 leaves this helper out of scope: the actual mapper is `outcome === 'done' ? 'done' : outcome === 'blocked' ? 'blocked' : outcome === 'cancelled' ? 'cancelled' : 'failed'`. With r2's instructions, `outcome === 'needs_verification'` still lands in the run ledger as `failed`, preserving the exact false-failed leak D3 was meant to close. The design/plan need an explicit `markActivationComplete` mapper change for `needs_verification` and a test that fails without it.

2. The `VALID_TRANSITIONS` matrix shown in D2 is not the F19 r5 baseline plus two deltas. F19 r5 pins the transition source of truth to [src/cards/card-store.ts](../../../src/cards/card-store.ts) / `validateTransition`; the current baseline has edges such as `cancelled -> drafting`, `done -> backlog|cancelled`, `failed -> backlog|cancelled`, and `running -> backlog`. The r2 matrix removes or rewrites several of those unrelated edges while claiming only `running -> needs_verification` and `needs_verification: ['cancelled']` are added. That violates the F19 hard-pin/P8 contract and risks turning F20 into a broad lifecycle rewrite. The docs should show the true post-F19 baseline and add only the one ingress plus the new row, or explicitly state where F19 created a different source of truth.

## Plan

1. Step S3 double-completes the activation path as written. The snippet calls `markActivationComplete(...)` and then `appendChildUnwindToolResult(...)`, but the current helper already calls `markActivationComplete` internally, and F19 r5 does not change that contract. It also references an `activationId` parameter that is not available at the executor-terminal seam. This needs to be rewritten as either a deliberate helper refactor with its own tests, or the existing single `appendChildUnwindToolResult(card.id, outcome, summary)` call after fixing the run-result mapper.

2. Step P6 still contains an unsafe/incorrect deploy copy for the GetRich-v2 LXC target. The deployment is bind-mounted from host [saivage-v3](../../../../) to the container; the validation skill says build on the host, restart `saivage-v3-getrich.service`, and probe `/health`. The `rsync -a --delete ... root@10.0.3.170:/opt/saivage-v3-getrich/...` commands target the wrong deployment path and could validate or mutate stale files instead of the bind-mounted service. Keep the correct service/health probe, but remove the rsync step.

VERDICT: CHANGES_REQUESTED