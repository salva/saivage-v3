# F20 — Analysis (r3, no analytical changes; design/plan adjustments only)

Supersedes [01-analysis-r2.md](01-analysis-r2.md). No analytical changes — the symptom, the four composed defects (§a–§d), the three-outcome rationale, the post-F19 r5 branch ordering (§A3), and the out-of-scope list are all unchanged from r2.

r3 exists to keep document numbering in lockstep with [02-design-r3.md](02-design-r3.md) and [03-plan-r3.md](03-plan-r3.md), which address the two design issues and the two plan issues raised in [01-analysis-review-r2.md](01-analysis-review-r2.md):

- **Design Issue 1** — `markActivationComplete` mapper must propagate `'needs_verification'` into `RuntimeRunRecord.result`; r2 left the mapper unchanged and would have written `'failed'`. Fixed in [02-design-r3.md §D3](02-design-r3.md#d3-truthful-activation-outcome--widen-runtimeactivationstatus--runtimerunrecordresult).
- **Design Issue 2** — `VALID_TRANSITIONS` table in r2 rewrote unrelated edges. Fixed in [02-design-r3.md §D2](02-design-r3.md#d2-valid_transitions-minimal-surface) with the verbatim post-F19 baseline from [src/cards/card-store.ts#L217-L227](../../../src/cards/card-store.ts#L217-L227) plus only the two named deltas.
- **Plan Issue S3** — r2 double-completed the activation path and referenced a non-existent `activationId` parameter. Fixed in [03-plan-r3.md §Step S3](03-plan-r3.md#step-s3--runtime-executor-terminal-branch-the-f19-r5-site) by relying on the existing single `appendChildUnwindToolResult(card.id, outcome, summary)` call after fixing the mapper.
- **Plan Issue P6** — r2 contained `rsync -a --delete ... :/opt/saivage-v3-getrich/...` against the bind-mounted container. Fixed in [03-plan-r3.md §Step P6](03-plan-r3.md#step-p6--live-lxc-probe-informational-gate) by deleting the rsync step.

## Changes vs r2

- None analytical.
