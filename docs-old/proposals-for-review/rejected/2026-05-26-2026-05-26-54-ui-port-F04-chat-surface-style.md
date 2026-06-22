# Design: F04 — analyst chat surface decomposition

Fifth and last of five linked proposals. Requires F01 + F02 + F05 + F03 merged.

The canonical documents live under `SPEC/2026-05/review-ui-port-from-v2/F04-chat-surface-style/`. This file is the mailbox entry.

## Problem

`AnalystChatPanel.vue` is a monolith with hard-coded styling, ad-hoc connection/auth state derivation, and bespoke scroll/IME handling. v2 had clean composables (`useWebSocket`, `useAuthState`) and decomposed components for header / list / item / jump / composer. After F01 (tokens), F02 (primitives), F05 (chip template), and F03 (shared ToolChip), the chat surface can be cleanly decomposed without touching the chip again.

## Decision

Implement [F04 02-design-r2.md](../SPEC/2026-05/review-ui-port-from-v2/F04-chat-surface-style/02-design-r2.md). Read [01-analysis-r3.md](../SPEC/2026-05/review-ui-port-from-v2/F04-chat-surface-style/01-analysis-r3.md) for v3-only preservation requirements and [03-plan-r2.md](../SPEC/2026-05/review-ui-port-from-v2/F04-chat-surface-style/03-plan-r2.md) for the commit sequence.

Binding contract:

- Decompose `AnalystChatPanel.vue` into a thin container that mounts `chat/ChatHeader.vue`, `chat/MessageList.vue`, `chat/MessageItem.vue`, `chat/JumpToLatest.vue`, `chat/ChatComposer.vue`. Each new component uses F02 primitives + F01 tokens.
- New composables: `web/src/composables/useDebouncedConnectionState.ts`, `web/src/composables/useStickToBottom.ts`.
- Connection / auth sources of truth remain the existing `useWsStore.connectionState`, `useRuntimeStore.unauthorized`, and the existing `ApiTokenEntry` flow. No parallel state machine. No port of v2 `useWebSocket` / `useAuthState`.
- `ChatMessage` type extension is additive: `provider?`, `model?`, `modelSpec?`, `requestedModelSpec?`. Consumed only for the local model-label rendering.
- Narrow-rail layout rules: bubble `max-width`, model-chip ellipsis, composer `min-width: 0`, `JumpToLatest` positioned absolutely within the chat-panel viewport with bottom offset = composer + pending-tool-footer heights (CSS vars or flex layout), `max-width: calc(100% - 24px)`, label ellipsis-safe.
- Preserved v3-only features: on-screen children section, pending tool invocations, message badges, read-only composer tooltip, loading/error panels, `saivage:focus-chat` shortcut, inline auth via `ApiTokenEntry`.
- ToolChip swap is NOT in this batch — it shipped with F03. F04 only consumes the shared `ToolChip` via `<ToolChip v-bind="adaptChatMessageToToolChip(item)" />` (or the equivalent destructured form). Adapter returns the canonical 8-prop bag exactly.

## Files to change

Plan is authoritative. High-level: new `web/src/components/chat/{ChatHeader,MessageList,MessageItem,JumpToLatest,ChatComposer}.vue`, new composables, slim `AnalystChatPanel.vue` container, additive `ChatMessage` type, rewritten tests (`web/src/__tests__/analyst-chat-panel.test.ts`, `analyst-chat-store.test.ts`, `components/AnalystChatPanel.children.test.ts`).

## Files / tests / docs to delete

- Bespoke scoped CSS for `.message-bubble`, `.tool-chip*`, `.primary-btn`, `.pending-tool*`, composer, badge, and state-panel inside `AnalystChatPanel.vue` (replaced by F02 primitives + F01 tokens).
- Fictional test file `web/src/__tests__/analyst-chat-error-states.test.ts` was never present — do NOT create it; do NOT search for it.

## Validation gate

1. `pnpm -C web typecheck`
2. `pnpm -C web test`
3. `pnpm -C web build`
4. `! rg -n '\\.tool-chip-pending\\b' web/src/components/chat` (no global pattern class created).
5. Playwright MCP smoke against `http://127.0.0.1:8090`: open analyst chat in the narrow right rail; verify scroll stickiness, jump-to-latest positioning above the composer, IME-safe Enter, on-screen children section, pending tool footer, read-only state, and inline auth panel.

## Risks / accepted residuals

- Narrow-rail (20-30vw) leaves little horizontal room; ellipsis rules are the only safety net for long model names / tool headlines.
- Composables are scoped to chat; do not generalize them speculatively.

## Out of scope

- ToolChip API or markup (owned by F03 + F02 + F05; already shipped).
- Backend changes.
- Toaster selectors (unchanged unless §9 of the plan explicitly modifies them).

## Architecture rule

`ARCHITECTURE-FIRST, NO BACKWARD COMPATIBILITY`. Delete bespoke scoped styles, do not alias them. Do not introduce a chat-local `ToolChip` API.
