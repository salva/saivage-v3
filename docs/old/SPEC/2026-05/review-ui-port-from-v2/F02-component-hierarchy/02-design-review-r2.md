# F02 Component Hierarchy Design Review - Round 2

Review target: [02-design-r2.md](02-design-r2.md)
Previous critique: [02-design-review-r1.md](02-design-review-r1.md)
Previous draft: [02-design-r1.md](02-design-r1.md)
Approved analysis: [01-analysis-r2.md](01-analysis-r2.md)
Cross-issue references: [F01 r2](../F01-design-tokens/01-analysis-r2.md), [F01 design r2](../F01-design-tokens/02-design-r2.md), [F03 analysis r2](../F03-conversation-rounds/01-analysis-r2.md), [F03 design r2](../F03-conversation-rounds/02-design-r2.md), [F04 r3](../F04-chat-surface-style/01-analysis-r3.md), [F05 design r2](../F05-tool-detail-rendering/02-design-r2.md)

## Blocking Finding

1. The r2 `ToolChip` contract is still stale relative to the latest cross-issue design documents.

   F02 r2 correctly fixes the r1-era `view: ToolPresentationView` API and moves to `call`, `result`, `status`, `expanded`, `detailsId`, and `timestamp?`. That resolves the previous critique against F03 analysis r2 / F04 r3. However, the newer binding designs now extend the shared chip prop bag with the raw producer payloads: [F03 design r2 §7.2](../F03-conversation-rounds/02-design-r2.md#72-toolchipvue--prop-bag-and-template-fixed) and [F05 design r2 §4.1](../F05-tool-detail-rendering/02-design-r2.md#41-toolchip-prop-bag-f03-r2-72-verbatim) both require `callContent: string` and `resultContent: string | null` in addition to the presentation objects.

   F02 r2 currently defines `conversation/ToolChip.vue` without those props in §1.3.14 and §3, but its own markup contract says the expanded body renders `<FormattedContent :content="callContentRaw" />` and `<FormattedContent :content="resultContentRaw" />`. There is no prop, slot, or derived field that supplies those raw strings. As written, the design cannot typecheck against F03 design r2 / F05 design r2 and cannot implement the promised expanded body without reintroducing hidden coupling inside the presenter objects, which F05 explicitly rejects.

   Required change: update every F02-owned statement of the final `ToolChip` API to the eight-prop cross-issue contract:

   ```ts
   defineProps<{
     call: ToolCallPresentation;
     result: ToolResultPresentation | null;
     callContent: string;
     resultContent: string | null;
     status: ToolPairStatus;
     expanded: boolean;
     detailsId: string;
     timestamp?: string;
   }>();
   defineEmits<{ (e: 'toggle'): void }>();
   ```

   Then update the cross-input table, §1.3.14 markup bullets, §3 verbatim interface block, §1.5 tests, §1.6 cross-batch ordering, Proposal B references, and any adapter/test text that currently implies `FormattedContent` can render raw content without `callContent` / `resultContent` props. The design should also use the F05 r2 canonical presenter import path wording (`../../utils/tool-presenters`, backed by the directory barrel), not prose that implies the deleted single file remains authoritative.

## Required Items Coverage

1. **Previous r1 Blocking 1 - old `view` chip API:** partially fixed, but not fully aligned with the latest binding designs because `callContent` / `resultContent` are missing.

2. **Previous r1 Blocking 1 - `FormattedContent` vs inline parts naming:** satisfied. F02 r2 cleanly separates `content/FormattedContent.vue` (`content: string`) from `content/InlineParts.vue` (`parts: InlinePart[]`) and removes the old navigation emits.

3. **Previous r1 Blocking 2 - chip-swap landing boundary:** satisfied. C5 is now the combined shared `ToolChip` + `AnalystChatPanel` swap boundary, with the analyst `.tool-chip*` family deleted in the same commit/PR.

4. **Two real proposals:** satisfied. Proposal A remains the clean three-layer split; Proposal B remains a serious feature-slice alternative and is still correctly rejected.

5. **Per-primitive TypeScript prop interfaces:** mostly satisfied. The remaining blocking exception is the `ToolChip` interface listed above.

6. **Deletion matrix and landing sequence:** satisfied after the C5 rewrite. The no-two-chip-renderers invariant is explicit.

7. **Composition rules / ESLint overrides:** satisfied. The five override blocks are concrete, and the `Spinner.vue` lucide exception is now machine-checkable.

8. **Test reorganization:** mostly satisfied. The `ToolChip.test.ts` lifecycle cases and F04 adapter-test placement are listed, but they need to be extended to assert `callContent` / `resultContent` delivery and expanded-body rendering once the prop bag is corrected.

9. **Cross-issue alignment:** not yet satisfied because F02 lags F03 design r2 and F05 design r2 on the final shared chip prop bag. F01 pattern extensions, F05 `InlinePart` routing, `FormattedContent` naming, and C5 ordering are otherwise aligned.

10. **Open questions:** satisfied. Q3 is closed and Q1/Q2 are legitimate reviewer questions rather than unresolved implementation holes.

## Non-Blocking Notes

- The `JsonView` / `FormattedContent` path correction from F05's older `components/ui/` wording to F02's `components/content/` home is acceptable; F05 design r2 now also treats these as content-owned.
- The composition-rule table still has slightly confusing prose around whether general `content/*` files may import other content files, but the ESLint blocks and explicit examples make the intended rule clear enough for design approval once the chip API is fixed.
- F02 r2 did the important architectural cleanup from r1: no backward-compat shims, no barrels under component primitive folders, and no alias period for bespoke selector families.

VERDICT: CHANGES_REQUESTED