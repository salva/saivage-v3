# F02 Component Hierarchy Design Review - Round 3

Review target: [02-design-r3.md](02-design-r3.md)
Previous critique: [02-design-review-r2.md](02-design-review-r2.md)
Previous draft: [02-design-r2.md](02-design-r2.md)
Approved analysis: [01-analysis-r2.md](01-analysis-r2.md)
Cross-issue references checked: [F03 design r2](../F03-conversation-rounds/02-design-r2.md), [F05 design r2](../F05-tool-detail-rendering/02-design-r2.md)

## Findings

No blocking findings.

The r3 draft addresses the r2 blocker and carries the correction through the design, rather than only patching the overview. The shared `ToolChip` contract is now the F03/F05 eight-prop bag everywhere it is specified: `call`, `result`, `callContent`, `resultContent`, `status`, `expanded`, `detailsId`, and `timestamp?`. The stale `callContentRaw` / `resultContentRaw` references are withdrawn and replaced with direct bindings to the raw-content props.

## Required Items Coverage

1. **r2 Blocking 1 - stale `ToolChip` prop bag:** satisfied. The cross-input table, §1.3.14, §3, §1.5, §1.6, Proposal B, and the risk section all use the eight-prop contract required by F03 design r2 §7.2 and F05 design r2 §4.1.

2. **r2 Blocking 1(b) - canonical F05 presenter import path:** satisfied. r3 consistently describes `../../utils/tool-presenters` as the directory barrel backed by `web/src/utils/tool-presenters/index.ts`, and C4 explicitly deletes `web/src/utils/tool-presenters.ts` with no shim.

3. **Required 1 - chip API alignment with latest binding designs:** satisfied. The final API includes `callContent: string` and `resultContent: string | null`; `ToolPairStatus` remains the F03 union; the chip still emits only `toggle`.

4. **Required 2 - `FormattedContent` vs `InlineParts` separation:** satisfied. `FormattedContent` remains the raw string parser/delegator; `InlineParts` remains the headline/detail renderer for `InlinePart[]` with router-link/anchor routing.

5. **Required 3 - chip-swap landing boundary:** satisfied. C5 is still the single shared-chip + `AnalystChatPanel` swap boundary, and r3 strengthens it by requiring the eight-prop bag at that boundary.

6. **Required 4 - two real proposals:** satisfied. Proposal A remains the selected three-layer split; Proposal B remains a substantive feature-slice alternative and now propagates the same chip/API corrections.

7. **Required 5 - per-primitive TypeScript prop interfaces:** satisfied. §3 repeats the primitive interfaces verbatim, including the corrected `ToolChip` block.

8. **Required 6 - deletion matrix and landing sequence:** satisfied. The matrix now includes the F05 presenter-directory C4 change and the C5 shared-chip boundary, with no alias/shim period.

9. **Required 7 - composition rules / ESLint overrides:** satisfied. r3 preserves the concrete override blocks and clarifies the allowed intra-content import directions in prose.

10. **Required 8 - test reorganization:** satisfied. `ToolChip.test.ts` and `tool-chip-adapter.test.ts` now include explicit `callContent` / `resultContent` forwarding and expanded-body cases, including the null-result path.

11. **Required 9 - cross-issue alignment:** satisfied. The F03/F04/F05 rows now agree on the eight-prop adapter seam, the F05 directory barrel, `InlineParts`, and `FormattedContent` ownership.

12. **Required 10 - open questions:** satisfied. Q1/Q2 remain legitimate implementation coordination questions; Q3 is closed with the corrected raw-content flow.

## Non-Blocking Notes

- There is a minor bookkeeping inconsistency: §1.4/§1.6 place `MessageBubble.vue` and `ThinkingDots.vue` in C5, while the risk table says C1-C2 ships them early. This does not reopen the r2 critique because the `ToolChip` landing boundary and no-two-chip-renderers invariant remain explicit, but the implementation plan should normalize that ordering.
- r3 keeps the architecture-first/no-backward-compatibility rule intact: no component-folder barrels, no deprecated re-exports, no legacy selector aliases, and no single-file presenter shim.

VERDICT: APPROVED