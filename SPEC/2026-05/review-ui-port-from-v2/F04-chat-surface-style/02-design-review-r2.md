# F04 - Chat / analyst surface style - Design review (r2)

Reviewer round 2 for [02-design-r2.md](02-design-r2.md).

Inputs reviewed:

- New design: [02-design-r2.md](02-design-r2.md)
- Previous critique: [02-design-review-r1.md](02-design-review-r1.md)
- Previous draft: [02-design-r1.md](02-design-r1.md)
- Approved analysis: [01-analysis-r3.md](01-analysis-r3.md)
- Cross-issue designs: [F03 r2](../F03-conversation-rounds/02-design-r2.md), [F02 r2](../F02-component-hierarchy/02-design-r2.md), [F05 r2](../F05-tool-detail-rendering/02-design-r2.md)

## Findings

No blocking findings. The r2 design addresses the r1 critique and is implementable against the intended F03/F05 shared chip contract.

## Required-changes check

### B1 - live store/API symbols

Pass. r2 removes the bogus `thinking` destructure from `useAnalystChat` and derives `thinking` locally from `sending || pendingToolInvocationsForActiveSession.length > 0`. It also explicitly promotes `PendingToolInvocation` into `web/src/api/types.ts` and rewires `stores/analystChat.ts` to import it, which resolves the r1 private-type problem without adding store state.

### B2 - model-chip visibility

Pass. r2 gates the model pill on `modelLabel(item.message, defaultModelSpec)` returning a non-null `fullLabel`; `shortModelLabel(...)` is used only for visible suffix text. The `model-label.ts` contract and tests now cover the divergence case where `shortModelLabel` is non-null but `modelLabel` is null.

### B3 - pending-footer resize reset

Pass. `MessageList.vue` now emits `resize: 0` via an immediate empty-list watcher and again when the pending footer ref transitions to `null`. The test inventory includes both the empty-on-mount and non-empty-to-empty transitions, so the stale `--chat-jump-bottom` failure mode is covered.

### C1 - children-test inventory

Pass. r2 explicitly preserves the `.on-screen-children` class for the live selector, adds `data-testid="on-screen-children"` for stable future tests, and updates the raw-source guard to inspect the new decomposed container import of `useCardStore` from `../../stores/cards`.

### P1-P4 polish items

Pass.

- `ChatHeader.unauthorized` is removed; the container gates `UnauthorizedNotice` through the slot.
- `useDebouncedConnectionState` accepts `Readonly<Ref<WsConnectionState>> | Ref<WsConnectionState>`.
- Proposal B's template sketch destructures composable refs at top level instead of using `s.x.value` bindings.
- The adapter contract has been updated from six props to the full F03 r2 eight-prop bag.

## Chip prop alignment

Pass. F03 r2 defines the shared `<ToolChip>` prop bag as exactly:

```ts
{
  call: ToolCallPresentation;
  result: ToolResultPresentation | null;
  callContent: string;
  resultContent: string | null;
  status: ToolPairStatus;
  expanded: boolean;
  detailsId: string;
  timestamp?: string;
}
```

F04 r2 §1.10 reproduces that shape exactly in `ToolChipProps`. `adaptChatMessageToToolChip` returns `callContent: call.content` and `resultContent: result ? result.content : null`. `adaptPendingInvocationToToolChip` returns a synthetic JSON `callContent`, `resultContent: null`, and `status: 'pending'`. Both render sites bind through `v-bind="adapt...(...)"` with no `:view`, no `:message`, and no chat-local chip API.

F05 r2 agrees with this raw-content ownership model: presentations remain structured summaries, while the raw payload strings travel through the chip props and feed `<FormattedContent>`. F02 r2 still contains an older-looking six-prop signature snippet for `ToolChip`, but F03 r2 §7.2 and F05 r2 §4.1 are the resolved chip contract; F04 correctly follows those eight props.

## Approved-analysis and scope check

Pass. The selected Proposal A remains the approved F04 analysis path: decomposition into `ChatHeader`, `MessageList`, `MessageItem`, `JumpToLatest`, `ChatComposer`, and `UnauthorizedNotice`; two leaf composables; `analyst-timeline` reuse; `model-label`; narrow-rail layout rules; and preservation of v3-only features including on-screen children, pending invocations, message badges, read-only tooltip, focus-chat, and existing token-entry flow.

The design keeps the no-backward-compatibility stance: no `.tool-chip*` survivors, no chip API shims, no parallel WebSocket/auth state machine, no v2 `ChatWindow` port, and no toaster work hidden inside F04.

## Residual risk

The only residual risk is cross-batch discipline: implementation must continue to follow F03 r2's eight-prop chip contract rather than the stale F02 snippet. F04 r2's own design and tests are now pointed at the correct contract, so no F04 design changes are requested.

VERDICT: APPROVED