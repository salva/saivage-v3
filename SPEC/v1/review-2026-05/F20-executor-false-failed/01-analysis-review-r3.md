# F20 r3 Review

## RuntimeRunRecord result mapper

Approved. r3 directly fixes the r2 leak where `needs_verification` would still collapse into `failed` in the run ledger. The live code currently maps any outcome other than `done`, `blocked`, and `cancelled` to `failed` in [src/runtime/runtime.ts](../../../src/runtime/runtime.ts#L171-L183), with the specific `runResult` ternary at [src/runtime/runtime.ts](../../../src/runtime/runtime.ts#L175-L176). [SPEC/v1/review-2026-05/F20-executor-false-failed/02-design-r3.md](02-design-r3.md#L47-L84) calls out that exact mapper and adds the explicit `outcome === 'needs_verification' ? 'needs_verification'` branch, while [SPEC/v1/review-2026-05/F20-executor-false-failed/03-plan-r3.md](03-plan-r3.md#L18-L30) makes the mapper edit a concrete implementation step. The inherited P2 test still asserts `RuntimeRunRecord.result === 'needs_verification'`, so this is test-covered rather than prose-only.

## VALID_TRANSITIONS baseline and deltas

Approved. r3 now shows the true post-F19 baseline from the actual source of truth in [src/cards/card-store.ts](../../../src/cards/card-store.ts#L217-L226), including `running -> backlog`, `done -> backlog|cancelled`, `failed -> backlog|cancelled`, and `cancelled -> drafting`. [SPEC/v1/review-2026-05/F20-executor-false-failed/02-design-r3.md](02-design-r3.md#L5-L45) and [SPEC/v1/review-2026-05/F20-executor-false-failed/03-plan-r3.md](03-plan-r3.md#L7-L12) add only the two F20-owned changes: `running -> needs_verification` and `needs_verification -> cancelled`. This composes with the F19 hard pin to `VALID_TRANSITIONS` in [SPEC/v1/review-2026-05/F19-runtime-pinned-failed-card/02-design-r5.md](../F19-runtime-pinned-failed-card/02-design-r5.md#L68-L80) and does not reopen unrelated lifecycle edges.

## Activation completion path

Approved. r3 removes the r2 double-completion shape. The current helper in [src/runtime/runtime.ts](../../../src/runtime/runtime.ts#L187-L196) calls `markActivationComplete` internally, and r3's plan uses that existing `appendChildUnwindToolResult(card.id, outcome, summary)` surface exactly once after the mapper fix. [SPEC/v1/review-2026-05/F20-executor-false-failed/03-plan-r3.md](03-plan-r3.md#L14-L83) also removes the nonexistent `activationId` parameter and keeps the helper synchronous, matching the code. The executor-terminal branch remains an additive F20 branch on top of F19's executor terminal restructure rather than a second activation-completion mechanism.

## Deployment and validation

Approved. r3 no longer proposes an rsync deployment. [SPEC/v1/review-2026-05/F20-executor-false-failed/03-plan-r3.md](03-plan-r3.md#L98-L112) now uses the validation-skill shape: build on the host, restart `saivage-v3-getrich.service` over SSH on `10.0.3.170`, and probe `/health`. That matches [.github/skills/saivage-development-validation/SKILL.md](../../../../../.github/skills/saivage-development-validation/SKILL.md#L38-L44). The remaining rsync text is historical removal rationale, not an executable deploy step.

## Comments and untouched code

Approved. r3 keeps explanatory material in the review documents and does not ask for docstrings or new inline comments in untouched code. Its code snippets in [SPEC/v1/review-2026-05/F20-executor-false-failed/02-design-r3.md](02-design-r3.md#L69-L78) and [SPEC/v1/review-2026-05/F20-executor-false-failed/03-plan-r3.md](03-plan-r3.md#L20-L80) are comment-free, preserving the project guideline from the prior rounds.

## F19 composition boundary

Approved. r3 remains unbundled from F19. It inherits the hard precondition that F19 r5 lands first, corrects `VALID_TRANSITIONS` to the F19-pinned card-store source, and limits the runtime change to the executor-terminal F20 branch plus the mapper fix. The F19 executor terminal restructure, awaited follow-up updates, and source-state contracts remain the approved baseline from [SPEC/v1/review-2026-05/F19-runtime-pinned-failed-card/03-plan-r5.md](../F19-runtime-pinned-failed-card/03-plan-r5.md#L115-L153); F20 adds `executor_partial_finish` and the parked outcome without broadening the F19 state-machine rewrite.

## Verdict rationale

The four r2 blockers are resolved: the ledger mapper is fixed, the transition matrix is now the actual baseline plus two deltas, activation completion is single-path through `appendChildUnwindToolResult`, and deployment follows host build plus SSH restart plus health probe. I found no substantive remaining defect that should block this round.

VERDICT: APPROVED