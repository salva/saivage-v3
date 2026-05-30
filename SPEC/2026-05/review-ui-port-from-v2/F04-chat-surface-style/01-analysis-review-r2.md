# F04 Chat Surface Style Analysis Review r2

Review target: [01-analysis-r2.md](01-analysis-r2.md)
Prior review: [01-analysis-review-r1.md](01-analysis-review-r1.md)
Issue: [../F04-chat-surface-style.md](../F04-chat-surface-style.md)
Cross-issue references checked: [../F01-design-tokens/01-analysis-r2.md](../F01-design-tokens/01-analysis-r2.md), [../F02-component-hierarchy/01-analysis-r2.md](../F02-component-hierarchy/01-analysis-r2.md), [../F03-conversation-rounds/01-analysis-r2.md](../F03-conversation-rounds/01-analysis-r2.md), [../F05-tool-detail-rendering/01-analysis-r2.md](../F05-tool-detail-rendering/01-analysis-r2.md)

## Summary

The r2 draft fixes two of the three r1 required items cleanly: the
test inventory now matches the live tree, and `JumpToLatest` has a
concrete narrow-rail positioning contract. It also removes the
obvious r1 problems around a chat-local `:message` chip prop and a
global `.tool-chip-pending` pattern.

I am still requesting changes because the shared `ToolChip` contract
is not aligned with F03 r2. Since that was the first required change
from r1, and since F03 r2 is now the in-flight alignment document for
the shared chip, the mismatch would still let implementers build two
different chip APIs.

## Required Changes

1. Align F04 r2 with F03 r2's current shared `ToolChip` API and
   landing-order decision.

   F04 r2 still cites F03 r1 in the companion list and in the
   dependency section, then defines the shared chip around a single
   `view: ToolPresentationView` prop plus `status`. Its adapters map
   each persisted chat tool message or pending invocation into that
   single-view shape.

   F03 r2 now makes a different shared-chip decision: the canonical
   `ToolChip` takes `call: ToolCallPresentation`,
   `result: ToolResultPresentation | null`, `status: ToolPairStatus`,
   `expanded`, `detailsId`, and `timestamp`. It also says the
   AnalystChatPanel chip swap lands with F03 to prevent two chip
   renderers at HEAD. F04 r2's section 11 says F03 and F04 can land
   in either order after F02/F05, which directly conflicts with that
   F03 r2 ordering.

   Update F04 to reference F03 r2 and consume the same chip boundary,
   or update F03 r2 in the same review batch so there is one final
   API. The final documents must not simultaneously prescribe
   `ToolChip view/status` for F04 and `ToolChip call/result/status`
   for F03. While doing that, fix the local sketch in F04 section 3.3
   where `adaptChatMessageToToolView(item)` is passed directly to
   `:view` even though section 4.1 defines that adapter as returning
   `{ view, status }`.

## Verified Items

- The corrected test inventory matches the live tree. The real
  prefix files are `web/src/__tests__/analyst-chat-panel.test.ts` and
  `web/src/__tests__/analyst-chat-store.test.ts`; the adjacent
  children test is `web/src/__tests__/components/AnalystChatPanel.children.test.ts`;
  `web/src/__tests__/analyst-toaster.test.ts` exists but is correctly
  kept outside F04 unless F04 changes toaster selectors; and
  `web/src/__tests__/analyst-chat-error-states.test.ts` does not
  exist.
- `JumpToLatest` now has the missing right-rail constraints: absolute
  positioning inside `.analyst-chat-panel`, bottom offset based on
  composer plus pending-tool footer height, `max-width: calc(100% -
  24px)`, and an ellipsis-safe label.
- The draft continues to preserve the important v3-only analyst
  features: on-screen children, pending invocations, message badges,
  read-only composer tooltip, focus-chat shortcut, existing
  `ApiTokenEntry` flow, and loading/error panels.
- The draft keeps the right architectural shape around auth and
  runtime state: no v2 `useWebSocket`/`useAuthState` port and no
  parallel token state machine.

## Axis Review

1. Clean code: blocked only by the unresolved shared chip boundary.
   The component decomposition is otherwise coherent.
2. Clean architecture: changes required. F04 must not diverge from
   F03 r2's shared `ToolChip` contract or landing-order decision.
3. No backward compatibility: satisfied. The draft deletes old
   bespoke classes rather than keeping aliases.
4. No over-engineering: satisfied. The new components and composables
   map to concrete v2 behaviors and v3 preservation points.
5. Dead-code preservation: satisfied. The draft does not port v2's
   WebSocket/auth composables or whole `ChatWindow.vue`.
6. Correctness: changes required because the cross-issue chip API is
   currently contradictory.
7. Completeness: changes required for F03 r2 alignment; otherwise the
   r1 gaps are covered.
8. Testability: satisfied after the inventory correction.

VERDICT: CHANGES_REQUESTED