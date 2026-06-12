# F04 Chat Surface Style Analysis Review r1

Review target: [01-analysis-r1.md](01-analysis-r1.md)
Issue: [../F04-chat-surface-style.md](../F04-chat-surface-style.md)
Subsystem map: [../00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md)
Cross-issue references: [../F01-design-tokens/01-analysis-r2.md](../F01-design-tokens/01-analysis-r2.md), [../F02-component-hierarchy/01-analysis-r2.md](../F02-component-hierarchy/01-analysis-r2.md), [../F03-conversation-rounds/01-analysis-r1.md](../F03-conversation-rounds/01-analysis-r1.md), [../F05-tool-detail-rendering/01-analysis-r2.md](../F05-tool-detail-rendering/01-analysis-r2.md)

## Summary

The draft is strong on the v2 behavior inventory and correctly treats the v3 analyst chat as a right-rail companion rather than a wholesale copy of v2's full-window `ChatWindow`. It explicitly preserves the important v3-only features: on-screen children, pending tool invocations, message badges, read-only tooltip behavior, loading/error panels, and the `saivage:focus-chat` shortcut from `AppShell` / card detail dispatchers.

I am requesting changes because two cross-issue details would mislead implementation if left as-is: the shared `ToolChip` contract is not aligned with F02/F03/F05, and the `analyst-chat-*` test rewrite inventory is incomplete/inaccurate.

## Required Changes

1. Align the `ToolChip` contract with the single shared component used by F03/F04/F05.

   The analysis says `MessageItem.vue` can render `<ToolChip :message="item" />`, says the analyst panel hands the chip a `ChatMessage`, and asks F01/F02 for a `.tool-chip-pending` pattern rule. That conflicts with the cross-issue direction:

   - F02 r2 places `ToolChip.vue` under `components/conversation/`, as a conversation composite, not a chat-local component.
   - F02 r2 explicitly says global `tool-chip*` pattern classes, including `tool-chip-pending`, are not added; status styling comes through `Card`/`Pill` composition and scoped layout.
   - F05 r2 defines the presenter contract around independent call/result presentations and `InlinePart[]` rendering, with shared chip markup used by both analyst and agents surfaces.
   - F03 r1 says its ToolChip is reused by F04, but its current prop sketch accepts a `ToolPair`, not a raw `ChatMessage`.

   F04 needs to pick the common adapter boundary, not introduce a message-shaped chip API on this surface. The clean resolution is to say that F04 maps each `ChatMessage` or pending invocation into the same `ToolChip` view/status/detail props that the shared conversation component accepts. If F03 keeps a `ToolPair`, it should adapt the pair into the same view model before rendering the chip. Do not add a second chip implementation, a chat-specific `:message` prop, or a global `.tool-chip-pending` pattern.

2. Correct and complete the `web/src/__tests__/analyst-chat-*` rewrite scope.

   The draft lists `analyst-chat-panel.test.ts` but then names `analyst-chat-error-states.test.ts`, which does not exist in the live tree, and it omits `analyst-chat-store.test.ts`. The live files matching the requested prefix are:

   - [../../../web/src/__tests__/analyst-chat-panel.test.ts](../../../web/src/__tests__/analyst-chat-panel.test.ts): rewrite selector assertions for send button, tool chips, expanded details, pending tool rendering, focus shortcut, and read-only title expectations to role/text/testid queries plus the shared `ToolChip`/`CodeBlock` contracts.
   - [../../../web/src/__tests__/analyst-chat-store.test.ts](../../../web/src/__tests__/analyst-chat-store.test.ts): mostly store behavior, but fixtures should accept the additive `ChatMessage` model fields and pending-tool dedupe assertions must remain covered after pending invocations are adapted into the shared ToolChip view model.

   Also list adjacent but non-prefix tests separately: [../../../web/src/__tests__/components/AnalystChatPanel.children.test.ts](../../../web/src/__tests__/components/AnalystChatPanel.children.test.ts) for the on-screen children section, and [../../../web/src/__tests__/analyst-toaster.test.ts](../../../web/src/__tests__/analyst-toaster.test.ts) only if F04 actually changes toaster selectors. Do not replace the required `analyst-chat-*` inventory with speculative sibling names.

3. Pin the narrow-rail positioning rules for `JumpToLatest`.

   Section 9.1 covers bubble width, model-chip ellipsis, tool-chip headline ellipsis, and composer `min-width: 0`, which is good. It does not yet state how the floating jump button is anchored inside the 20-30vw rail so it does not overlap the composer, pending-tool footer, or scrollbar. Add a concrete constraint: position it relative to the chat panel or message-list viewport, reserve a bottom offset tied to the composer height, keep `max-width: calc(100% - 24px)` or equivalent, and keep the unseen label ellipsized/wrapping-safe.

## Axis Review

1. Clean code: mostly satisfied. The decomposition into `ChatHeader`, `MessageList`, `MessageItem`, `JumpToLatest`, and `ChatComposer` is understandable and removes the current monolithic scoped-style pile. The shared ToolChip boundary must be corrected so clean code does not become duplicate adapter logic hidden in two surfaces.

2. Clean architecture: mostly satisfied. The analysis correctly keeps Pinia stores and WebSocket/auth stores as data sources, while moving display behaviors into small composables and components. The only architectural blocker is the divergent ToolChip API; F04 should consume the cross-issue conversation composite instead of shaping its own.

3. No backward compatibility: satisfied. The draft deletes old `.message-bubble`, `.tool-chip*`, `.primary-btn`, `.pending-tool*`, composer, badge, and state-panel styling rather than keeping aliases. The query-route compatibility note is not part of F04.

4. No over-engineering: satisfied. The proposed composables (`useDebouncedConnectionState`, `useStickToBottom`) map directly to v2 behavior and are modest. Keeping on-screen children inside `MessageList.vue` rather than splitting a tiny one-off component is the right call.

5. Dead-code preservation: satisfied. The analysis explicitly says not to port v2 `useWebSocket` / `useAuthState`, not to migrate `ChatWindow.vue`, and not to keep the current bespoke CSS rules.

6. Correctness: changes required. v2 behavior inventory is accurate: debounced visible status, inline auth affordance, model chip, thinking dots, auto-scroll stickiness, IME-safe Enter handling, and markdown/plain-text role behavior are all captured. v3 source checks also match the preserved features. Correctness is blocked only by the ToolChip contract drift and the missing jump-button rail positioning detail.

7. Completeness: changes required. v3-only preservation is explicitly covered, connection/auth source of truth is covered, and `ChatMessage` metadata extension is scoped as optional/additive. Completeness is short on the actual `analyst-chat-*` test inventory and on the final shared ToolChip view-model boundary.

8. Testability: changes required. The draft identifies `analyst-chat-panel.test.ts` rewrite points and keeps the focus-chat test in scope, but the requested prefix inventory is incomplete. Add `analyst-chat-store.test.ts`, remove the nonexistent error-state file, and separate adjacent children/toaster tests with their real scope.

## Additional Notes

- The `provider` / `model` / `modelSpec` / `requestedModelSpec` `ChatMessage` extension is properly additive on the wire. Consumption should remain limited to model-label derivation in the analyst message UI unless F03 separately uses model specs for agent rounds.
- Connection/auth status correctly comes from `useWsStore.connectionState`, `useRuntimeStore.unauthorized`, and token presence. There is no parallel auth state machine in the proposal.
- The inline auth panel should trigger the existing `ApiTokenEntry` flow rather than reintroducing v2's local token input, unless a later design explicitly justifies duplicating that form. This is not blocking at analysis level, but the implementation plan should settle it.
- The draft's `patterns.css needs .tool-chip-pending` sentence should be removed or rewritten because F02 r2 approved the opposite boundary.

VERDICT: CHANGES_REQUESTED