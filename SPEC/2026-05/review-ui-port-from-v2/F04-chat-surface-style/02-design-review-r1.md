# F04 - Chat / analyst surface style - Design review (r1)

Reviewer round 1 for [02-design-r1.md](02-design-r1.md).

Inputs reviewed:

- New design: [02-design-r1.md](02-design-r1.md)
- Approved F04 analysis: [01-analysis-r3.md](01-analysis-r3.md)
- Cross-issue analyses: [F01 r2](../F01-design-tokens/01-analysis-r2.md), [F02 r2](../F02-component-hierarchy/01-analysis-r2.md), [F03 r2](../F03-conversation-rounds/01-analysis-r2.md), [F05 r2](../F05-tool-detail-rendering/01-analysis-r2.md)
- Live source: [AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue), [analystChat.ts](../../../web/src/stores/analystChat.ts), [api/types.ts](../../../web/src/api/types.ts)
- Live tests: [analyst-chat-panel.test.ts](../../../web/src/__tests__/analyst-chat-panel.test.ts), [analyst-chat-store.test.ts](../../../web/src/__tests__/analyst-chat-store.test.ts), [AnalystChatPanel.children.test.ts](../../../web/src/__tests__/components/AnalystChatPanel.children.test.ts)

## Findings

### 1. Blocking: the selected skeleton reads store/API symbols that do not exist in live v3

The selected Proposal A skeleton destructures `thinking` from `storeToRefs(chat)` and passes it through `MessageList`, but the live analyst-chat store does not expose a `thinking` ref. The store currently returns `sessions`, `activeSessionId`, `messages`, `draft`, loading/error flags, `pendingToolInvocations`, `messageBadges`, `activeSessionWritable`, and actions; there is no `thinking` state.

The same selected skeleton imports `PendingToolInvocation` from `../../api/types`, but live [api/types.ts](../../../web/src/api/types.ts) does not export that interface. The type is currently private inside [analystChat.ts](../../../web/src/stores/analystChat.ts).

This is not just an implementation nit: applying the design literally will fail TypeScript before any UI behavior can be evaluated. The design must choose one clean path and update its file layout/test inventory accordingly:

- Promote `PendingToolInvocation` into an exported API/shared chat type and list that type move as part of F04 or the preceding F03 chip-swap PR.
- Either add a real `thinking` source to `useAnalystChat` with explicit ingest semantics, or remove the prop from the F04 skeletons and define thinking dots in terms of an existing source. Do not leave it as an implied store field.
- Remove the contradictory statement that the analyst-chat store is read-only except for `ChatMessage` metadata if F04 is expected to add store state.

### 2. Blocking: model-chip rendering contradicts the additive metadata contract

The `model-label.ts` contract says the chip is hidden when the message spec equals `defaultModelSpec` and there is no `requestedModelSpec`. But `MessageItem.vue` renders the pill with:

```vue
<Pill v-if="shortModelLabel(item.message)" ...>
  {{ shortModelLabel(item.message) }}
</Pill>
```

`shortModelLabel` ignores `defaultModelSpec`, so the skeleton renders a model pill even when `modelLabel(message, defaultModelSpec)` returns `null`. That violates the design's own `ChatMessage` additive metadata scope and will make the proposed model-chip tests too weak.

Required fix: compute the full label first and use that as the visibility gate. Either make `shortModelLabel` accept the same `defaultModelSpec` inputs, or derive the displayed suffix from `modelLabel(...)` after null filtering.

### 3. Blocking: pending-footer resize skeleton does not actually emit `0` on unmount

The narrow-rail rules correctly require `JumpToLatest` to sit above `composerHeightPx + pendingFooterPx`, and the prose says `MessageList` emits `0` when the pending footer is absent. The skeleton does not do that. Its `watch(pendingFooterEl, ...)` observes a new element and unobserves the old one via cleanup, but when `pendingTools.length` drops to zero and the section unmounts, no `emit('resize', 0)` happens.

That leaves `jumpBottomOffsetPx` stale after pending tools clear. The visible symptom is a jump button positioned as if a non-existent pending footer still occupied rail height. This is exactly the kind of narrow-rail geometry bug F04 is meant to eliminate.

Required fix: in the `pendingFooterEl` watcher, emit `0` when `el === null`, or watch `pendingTools.length` and emit `0` on the empty transition. Keep the explicit test.

### 4. Required correction: test inventory is close, but not fully live-file exact

The design correctly names the live files and drops the non-existent `analyst-chat-error-states.test.ts`. It also correctly leaves toaster work out of F04.

Two test-inventory details need tightening:

- [AnalystChatPanel.children.test.ts](../../../web/src/__tests__/components/AnalystChatPanel.children.test.ts) has three live tests, but one is a raw-source guard asserting `useCardStore` is imported from `../../stores/cards`. The design only describes the behavior tests. If F04 decomposes the panel and the `useCardStore` import moves, this test must be intentionally rewritten or removed as part of the F04 test update. Do not accidentally strand it against the old monolith.
- The design is inconsistent on `.on-screen-children`: one section says to replace the class lookup with `data-testid`, another says the class lookup continues to work. Pick one contract. Given the live file currently queries `.on-screen-children li`, either keep that class on the element containing the `li` descendants or explicitly rewrite the test to `[data-testid="on-screen-children"] li`.

## Checklist Review

### Two proposals

Pass. Proposal A is a real focused fix and Proposal B is a genuine one-level-up alternative (`useChatSurface`) rather than a strawman. The recommendation for A is justified: B is single-use today, hard-wires `useAnalystChat`, and adds a wrapper layer above Pinia without a second consumer.

One caveat: Proposal B's template examples use many `s.someRef.value` bindings. If B is retained for future reference, the writer should verify Vue template ref unwrapping for nested object refs or simplify by destructuring the composable return. This does not affect the selected design.

### Vue SFC skeletons

Mostly pass. The skeletons are appropriately decomposed into `ChatHeader`, `MessageList`, `MessageItem`, `JumpToLatest`, and `ChatComposer`, and they consume the F02/F01 vocabulary instead of preserving legacy classes.

The skeletons need the blocking fixes above before approval: remove or define `thinking`, fix model-chip gating, and make the pending-footer resize path emit zero. Also make the `ChatHeader.unauthorized` prop meaningful or remove it; it is currently passed but unused.

### Composable signatures

Pass with one small improvement. `useDebouncedConnectionState(source)` captures the approved asymmetric 400 ms behavior. `useStickToBottom(elRef, thresholdPx = 60)` captures the right state and methods.

Suggested type polish: accept a read-only ref for `useDebouncedConnectionState`, since `useWsStore().connectionState` is exposed as a readonly ref in the live store. This is not blocking, but it will avoid fighting the type system after the Pinia refs are wired.

### ToolChip adapter

Pass on the external prop bag. The design now matches F03 r2 exactly:

```ts
{
  call,
  result,
  status,
  expanded,
  detailsId,
  timestamp,
}
```

It does not use `:view` or `:message`, and it correctly keeps F05 presenter status separate from F03 pair lifecycle status.

Required type correction is the same as finding 1: the pending adapter cannot import `PendingToolInvocation` from `api/types` unless the design explicitly exports it there.

### Narrow-rail layout

Pass on intent, changes requested on the pending-footer edge. The design correctly rejects v2's wide bubble clamp, requires `min-width: 0`, anchors `JumpToLatest` inside the rail, caps its max width, and calls out composer min/max sizing and model-chip ellipsis.

The implementation skeleton must be updated so the pending-footer offset is reset to zero when the footer unmounts.

### `ChatMessage` additive metadata

Pass on scope. The four optional fields are additive and consumed only for local model-label rendering. The design does not smuggle in broader store or backend shape changes.

The model-chip visibility bug in finding 2 must be fixed so this scope remains true in the rendered surface.

### Test inventory

Mostly pass, with required correction in finding 4. The design uses the real live test files: `analyst-chat-panel.test.ts`, `analyst-chat-store.test.ts`, and `components/AnalystChatPanel.children.test.ts`; it correctly does not invent `analyst-chat-error-states.test.ts`.

The new test inventory is otherwise appropriate: jump-to-latest, the two composables, `analyst-timeline`, `model-label`, and adapter cases cover the risky behavior.

### F03/F04 chip-swap boundary

Pass. The design explicitly defers the `AnalystChatPanel` chip swap to the F03 PR and states that F04 only relocates the inherited shared `<ToolChip>` call site into `MessageItem.vue`. That matches F03 r2's ordering decision and avoids a two-chip HEAD state.

### Recommendation

Pass. Proposal A is the right recommendation. It implements the approved F04 analysis directly and avoids a speculative `useChatSurface` layer.

### No backward compatibility

Pass. The design removes legacy selectors and local chip APIs rather than aliasing them. The requested corrections should preserve that stance: promote or remove missing types/states cleanly, do not add shims.

## Recommendation

Do not approve this r1 as-is. The design is structurally strong and close, but the selected skeleton is not implementable against the live analyst store/API types, and two of the narrow-surface details contradict the design's own contracts.

I would expect r2 to be small: define the pending invocation type boundary, resolve or remove `thinking`, gate the model chip through `modelLabel`, emit `0` for the pending-footer resize path, and make the children test inventory exact.

VERDICT: CHANGES_REQUESTED