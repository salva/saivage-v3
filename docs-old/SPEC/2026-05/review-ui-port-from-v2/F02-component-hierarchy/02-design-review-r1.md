# F02 Component Hierarchy Design Review - Round 1

Review target: [02-design-r1.md](02-design-r1.md)
Approved analysis: [01-analysis-r2.md](01-analysis-r2.md)
Cross-issue references: [F01 r2](../F01-design-tokens/01-analysis-r2.md), [F03 r2](../F03-conversation-rounds/01-analysis-r2.md), [F04 r3](../F04-chat-surface-style/01-analysis-r3.md), [F05 r2](../F05-tool-detail-rendering/01-analysis-r2.md)

## Blocking Findings

1. The shared `ToolChip` / presenter contract is stale and conflicts with the approved F03/F04/F05 contract.

   The design repeatedly defines `ToolChip` as `view: ToolPresentationView`, `status: 'call' | 'ok' | 'error' | 'pending'`, plus `navigateFile` / `navigateUrl` emits. That is not the current cross-issue contract. F03 r2 §7.2 and F04 r3 §4 bind the shared chip to `call: ToolCallPresentation`, `result: ToolResultPresentation | null`, `status: ToolPairStatus`, `expanded`, `detailsId`, and optional `timestamp`, with `toggle` as the chip emit. The status union must be the F03 lifecycle union: `pending | ok | error | orphan | missing`. F05 r2 also does not define a `ToolPresentationView`; it defines independent `presentToolCall` / `presentToolResult` outputs plus the exported `InlinePart` type.

   This is genuinely blocking because F04 r3 explicitly corrected away from a `:view` prop and requires `v-bind="adaptChatMessageToToolChip(...)"` against the `call/result/status` prop bag. If F02 ships the `view` API, the approved F03/F04 plans cannot typecheck without either adding an adapter shim or reintroducing the parallel chip API the review process already rejected.

   Required change: rewrite every `ToolChip` signature, test contract, proposal-B overlap statement, C5 coordination note, and cross-input table entry to the F03/F04/F05 `call/result/status` contract. Also reconcile `FormattedContent`: the current `parts: InlinePart[]` component is an inline-parts renderer, while F05 r2's `FormattedContent` parses raw tool content and delegates JSON/prose rendering. Either align the name/props to F05 or explicitly rename the inline renderer so F02 does not claim a conflicting `FormattedContent` API.

2. The landing/deletion sequence leaves the old analyst chip implementation alive after the shared chip is introduced.

   The design's C5 introduces `conversation/ToolChip.vue` with no deletion, while C13 later deletes `AnalystChatPanel.vue`'s `.tool-chip*` family. F03 r2 §8.2 and F04 r3 §11.2 make a stricter binding decision: the F03 PR contains both the new shared `ToolChip.vue` and the swap in `AnalystChatPanel.vue`, specifically to avoid any HEAD state with two chip renderers. The current F02 sequence violates that cross-issue landing decision and the local "old + new do not coexist as aliases" rule for the most important shared composite in the batch.

   Required change: pull the AnalystChatPanel chip swap and `.tool-chip*` deletion into the same commit/PR boundary that introduces the final shared `ToolChip` API, or explicitly model that boundary as the F03-with-F02/F05 combined chip commit. C13 can still own the rest of the analyst panel primitive migration, but it must not be the first place the old chip family disappears.

## Required Items Coverage

1. **Two real proposals:** satisfied. Proposal A is the approved three-layer split, and Proposal B is a serious feature-slice alternative with concrete layout, imports, tests, tradeoffs, and rejection criteria. The recommendation for A is well-supported.

2. **Per-primitive TypeScript prop interfaces:** mostly satisfied for the F02-owned set of 14: `Button`, `Pill`, `Card`, `PanelHeading`, `StatusDot`, `Overlay`, `Spinner`, `CodeBlock`, `MarkdownText`, `JsonView`, `FormattedContent`, `MessageBubble`, `ToolChip`, and `ThinkingDots`. The blocking exception is that `ToolChip` is the wrong contract, and `FormattedContent` / `JsonView` need explicit reconciliation with F05 r2's component contracts.

3. **Deletion matrix:** broadly satisfied. The design gives a per-v3-file matrix and separates deleted visual selectors from layout-only survivors. The blocking gap is the chip row timing above: the deletion exists, but it is paired with the wrong landing boundary.

4. **Landing sequence:** partially satisfied. The 15-commit sequence is useful and mostly atomic by surface, but the shared chip boundary must be corrected. After that, the sequence should explicitly state that no final shared primitive is introduced at HEAD while its replaced bespoke renderer remains active in another surface.

5. **Composition rules:** mostly satisfied. The layer import graph is clear, `no-restricted-imports` is the right enforcement mechanism, and the surviving scoped-style property allowlist is useful. Before implementation, the design should spell out the content/conversation ESLint overrides as concretely as the `ui/` example and make the `Spinner` lucide exception machine-checkable rather than only prose.

6. **Test reorganization:** satisfied in structure. The new `ui/`, `content/`, and `conversation/` test trees are clear, and surface tests move away from bespoke-class assertions. Update `ToolChip.test.ts` to the F03 r2 §10.5 lifecycle cases (`pending`, `ok`, `error`, `orphan`, `missing`, call/result `FormattedContent`) and keep F04 adapter tests in the PR that swaps AnalystChatPanel.

7. **Cross-issue alignment:** not satisfied because of the blocking chip/API and chip-swap timing mismatches. F01 pattern extensions are otherwise aligned, and the F03/F04 folder split is mostly honored. F05 alignment needs the `InlinePart` / `FormattedContent` naming fix described above.

8. **Open questions:** Q1 and Q2 are real, answerable reviewer questions. Q3 is answerable, but it is no longer just open: F05 r2 already answers that raw tool-detail content is parsed by `FormattedContent`, while inline headline/detail parts are rendered separately. Convert Q3 into a required contract alignment item rather than asking the reviewer to choose a fallback.

## Non-Blocking Notes

- The F01 pattern extension list is good, but the prose says "nine" rules while the code block contains five status-dot rules, five card-tone rules, `.pill-purple`, and the tablist selector. Count or word this as "extension rules" without a numeric mismatch.
- `Spinner` as a single `lucide-vue-next` exception is acceptable if the ESLint override names only `Spinner.vue`. A CSS-only spinner would also be fine, but this should not block the design.
- Proposal B's `lib/index.ts` barrel is intentionally rejected, which is consistent with the approved no-barrel rule. Good.

VERDICT: CHANGES_REQUESTED