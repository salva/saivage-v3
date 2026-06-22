# F04 — Chat / analyst surface style — Functional analysis (r2)

Writer round 2. Binding critique:
[01-analysis-review-r1.md](01-analysis-review-r1.md). Prior draft:
[01-analysis-r1.md](01-analysis-r1.md). Project guideline (binding):
**architecture-first, no backward compatibility**. No fallback
styles, no legacy class aliases, no `.tool-chip-pending` global
pattern, no aliased `.message-bubble`/`.primary-btn`/etc.

Companion files (binding):
[F04 issue](../F04-chat-surface-style.md),
[00 subsystem map](../00-SUBSYSTEM-MAP.md),
[F01 r2](../F01-design-tokens/01-analysis-r2.md),
[F02 r2](../F02-component-hierarchy/01-analysis-r2.md),
[F05 r2](../F05-tool-detail-rendering/01-analysis-r2.md),
[F03 r1](../F03-conversation-rounds/01-analysis-r1.md).

---

## 0. Required-changes coverage map

The three required changes from
[01-analysis-review-r1.md](01-analysis-review-r1.md) are addressed
as follows:

| Required change | Addressed in | Net effect |
| --- | --- | --- |
| **1. Align with the shared `ToolChip` contract from F02/F03/F05.** No chat-local `:message` prop, no `.tool-chip-pending` global pattern, no second chip implementation. | §4 (view-model adapter), §3.3 (`MessageItem.vue` signature), §3.4 (`MessageList.vue` pending wiring), §2.4 (drops the "patterns.css needs .tool-chip-pending" sentence from r1) | F04 consumes the cross-issue `<ToolChip>` from `components/conversation/` and maps both persisted tool-role `ChatMessage`s and live `PendingToolInvocation`s into the same `ToolPresentationView` + `status` props the chip accepts. No new chip API, no new pattern class. |
| **2. Fix the `analyst-chat-*` test inventory.** Add `analyst-chat-store.test.ts`; remove the fictitious `analyst-chat-error-states.test.ts`; list `components/AnalystChatPanel.children.test.ts` separately; only list `analyst-toaster.test.ts` if F04 changes its selectors. | §9 (test plan) | r2 enumerates four real files with concrete rewrite scopes, drops the speculative file, separates the children test as a non-prefix sibling, and excludes the toaster test from F04 work (F04 does not change toaster selectors). |
| **3. Pin `JumpToLatest` narrow-rail positioning.** Anchor inside the chat-panel viewport, bottom offset = composer + pending-tool footer height, `max-width: calc(100% - 24px)`, label ellipsis-safe. | §3.5 (component contract), §8.3 (layout rules), §5.2 (`useStickToBottom` exposes `bottomOffsetPx`) | The float is `position: absolute` inside `.analyst-chat-panel`, bottom offset is computed by a `ResizeObserver`-fed CSS var `--chat-jump-bottom`, max-width is capped, and the unseen label wraps via single-line ellipsis. |

Strengths from r1 that are retained (each cross-referenced):

- v3-only features preserved: on-screen children (§3.4 / §4.4), pending tool invocations (§4 adapter, §3.4), per-message badges (§3.3), read-only tooltip (§3.6), `saivage:focus-chat` shortcut (§5.3), `ApiTokenEntry` inline trigger (§6.3), `sessionsLoading` / `messagesLoading` / `messagesError`(`unauthorized` branch) / `sendError` state panels (§3.1, §3.4).
- No duplicate connection/auth state machine (§6.1).
- Additive `ChatMessage` extension limited to model-label derivation (§7).
- No port of v2 `useWebSocket` / `useAuthState` (§12).
- v3 stays a right-rail surface, not a copy of v2's full-window chat (§10).

---

## 1. v2 behavior reference (`ChatWindow.vue`)

Concise, link-rich inventory of the behaviors F04 lifts.

| # | Behavior | v2 reference |
| --- | --- | --- |
| 1.1 | Two-line header strip: panel title (`Command Stream`) + short session id (`sessionId.slice(0, 14)` or `new session`). | [ChatWindow.vue#L56-L67](../../../../saivage/web/src/components/ChatWindow.vue#L56-L67) |
| 1.2 | Connection chip: `Wifi` / `WifiOff` / `ShieldAlert` / spinning `Loader2` plus state label. | [ChatWindow.vue#L240-L248](../../../../saivage/web/src/components/ChatWindow.vue#L240-L248) |
| 1.3 | Debounced visible status: transitions **away from `open`** delayed 400 ms; transitions **to `open`** immediate; timer cleared on unmount. | [ChatWindow.vue#L45-L60](../../../../saivage/web/src/components/ChatWindow.vue#L45-L60) |
| 1.4 | Role-tinted bubbles via `entry-user` (right-align user) / default (assistant) / `entry-warn` (system, centred wider max-width). | [ChatWindow.vue#L459-L488](../../../../saivage/web/src/components/ChatWindow.vue#L459-L488) |
| 1.5 | Assistant model chip: `modelLabel` = `modelSpec ?? "provider/model"`; `shortModelLabel` = suffix after last `/`; full string in `title`. `requestedModelSpec` reserved for "via" ambient annotation. | [ChatWindow.vue#L219-L230](../../../../saivage/web/src/components/ChatWindow.vue#L219-L230) |
| 1.6 | Thinking dots: trailing `compact` assistant article with three `dot-pulse` spans while `thinking === true`. | [ChatWindow.vue#L89-L93,L481-L485](../../../../saivage/web/src/components/ChatWindow.vue#L89-L93) |
| 1.7 | Auto-scroll stickiness with unseen counter: `stickToBottom` flips when within 60 px of bottom; off-bottom incoming messages bump `unseenCount`; floating button forces scroll. | [ChatWindow.vue#L175-L202,L494-L504](../../../../saivage/web/src/components/ChatWindow.vue#L175-L202) |
| 1.8 | Inline unauthorized panel above the message list: `KeyRound` icon + token-entry input, in addition to any global banner. | [ChatWindow.vue#L254-L276](../../../../saivage/web/src/components/ChatWindow.vue#L254-L276) |
| 1.9 | Resize-to-content composer: `rows=1` start; on `input` set `height: auto`, read `scrollHeight`, cap `8 * 20 + 12 px`. | [ChatWindow.vue#L161-L172](../../../../saivage/web/src/components/ChatWindow.vue#L161-L172) |
| 1.10 | Composer keymap: Enter sends; Shift/Ctrl/Meta+Enter or `isComposing` inserts newline; Send button shows `<SendHorizontal>` + `Send`. | [ChatWindow.vue#L150-L158](../../../../saivage/web/src/components/ChatWindow.vue#L150-L158) |
| 1.11 | Assistant content via `renderMarkdown` + `v-html`; user / system as plain text. v3 already has `MarkdownText` (F02 r2 relocates to `content/`). | [ChatWindow.vue#L459-L488](../../../../saivage/web/src/components/ChatWindow.vue#L459-L488) |
| 1.12 | First WS `session` event triggers `GET /api/chats/${sid}`; subsequent `session` events do not clobber on-screen messages. | [ChatWindow.vue#L72-L138](../../../../saivage/web/src/components/ChatWindow.vue#L72-L138) |
| 1.13 | v2 owns its own WebSocket + auth composables ([useWebSocket.ts](../../../../saivage/web/src/composables/useWebSocket.ts), [useAuthState.ts](../../../../saivage/web/src/composables/useAuthState.ts)). v3 already has equivalents — not ported. | n/a |

---

## 2. v3 gap analysis

v3 source: [AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue), [analystChat.ts](../../../web/src/stores/analystChat.ts), [AnalystToaster.vue](../../../web/src/components/chat/AnalystToaster.vue), [api/types.ts](../../../web/src/api/types.ts) (`WsConnectionState` at line 722).

### 2.1 Preserved v3-only features (must survive the port)

- **Composer** (`textarea rows=3`, Enter / Shift+Enter discipline already implemented in `handleComposerKeydown`).
- **Timeline rendering** — flat `timelineItems = [...messages].sort(by timestamp)`; three `kind`s (`message`, `tool_call`, `tool_result`).
- **Tool-call/result presenters** routed through `presentToolCall` / `presentToolResult` ([utils/tool-presenters.ts](../../../web/src/utils/tool-presenters.ts)). F05 r2 redefines the shape (§4 below).
- **Pending tool invocations** scoped to the active session — [`pendingToolInvocationsForActiveSession`](../../../web/src/components/chat/AnalystChatPanel.vue#L64-L77).
- **Per-message badges** — [`messageBadges`](../../../web/src/components/chat/AnalystChatPanel.vue#L78-L82).
- **On-screen children section** — driven by `cards.childrenOf(workspaceRoute.entityId)` while `workspaceRoute.view === 'cards'`. Covered by [`components/AnalystChatPanel.children.test.ts`](../../../web/src/__tests__/components/AnalystChatPanel.children.test.ts).
- **`saivage:focus-chat` global shortcut** — listener registered `onMounted`; dispatched from [AppShell.vue#L131](../../../web/src/components/layout/AppShell.vue#L131) and [cards/CardDetailView.vue#L491](../../../web/src/components/cards/CardDetailView.vue#L491).
- **State panels**: `sessionsLoading`, `messagesLoading`, `messagesError.kind === 'unauthorized'`, `sendError`.
- **Read-only tooltip** when `activeSessionWritable === false` (driven by store `isWritableSession`).
- **API token entry** as a real, existing modal: [`components/auth/ApiTokenEntry.vue`](../../../web/src/components/auth/ApiTokenEntry.vue). F04 wires the inline panel to its trigger; F04 does **not** add a parallel inline token input.

### 2.2 Hard-coded styling to remove

Every hex literal in the SFC's scoped style block — `#0d1117`, `#161b22`, `#30363d`, `#1f2937`, `#58a6ff`, `#7ee787`, `#d2a8ff`, `#f85149`, `#ffa198`, `#79c0ff`, `#c9d1d9`, `#f0f6fc`, `#8b949e`, `#ff7b72` — is **deleted** (per F01 r2 §3.4 and the project guideline). Duplicate `.primary-btn` rule (one near line 252, one near the bottom) and the entire `.tool-chip*` family are deleted in the same commit that introduces the F02 primitives. **No aliasing.**

### 2.3 v2 features absent in v3 today

| Feature | v2 | v3 today | Where it should live |
| --- | --- | --- | --- |
| Header strip + session id | yes | no | `chat/ChatHeader.vue` |
| Connection chip + label | yes | no | `chat/ChatHeader.vue` composing `StatusDot`+`Pill` |
| Debounced visible status (asymmetric, 400 ms) | yes | n/a | `composables/useDebouncedConnectionState.ts` |
| Role-tinted bubbles | yes | only `role-user` flat background | `MessageBubble` via F02 `<Card tone="user\|accent\|purple">` |
| Assistant model chip (short + title) | yes | absent | `chat/MessageItem.vue` + F02 `<Pill>` |
| Thinking dots | yes | absent | F02 `<ThinkingDots>` rendered by `MessageList` |
| Jump-to-latest + unseen counter | yes | absent | `chat/JumpToLatest.vue` + `useStickToBottom` |
| Inline unauthorized notice | yes | absent | `chat/ChatHeader.vue` `state` slot |
| Resize-to-content composer | yes | static `rows="3"` + `resize: vertical` | `chat/ChatComposer.vue` |
| IME (`isComposing`) guard | yes | no | `chat/ChatComposer.vue` |
| Send button with icon + label | yes | text-only | `chat/ChatComposer.vue` + F02 `<Button variant="primary">` |
| Auto-scroll stickiness | yes | absent | `useStickToBottom.ts` |
| Per-message badges | n/a | yes | **preserve** in `MessageItem.vue` |
| On-screen children section | n/a | yes | **preserve** inside `MessageList.vue` |
| Pending tool invocation rows | n/a | yes | **preserve**, adapted to shared `<ToolChip>` (§4) |

---

## 3. Proposed decomposition

The current ~440-line SFC becomes pure layout. Surface composites live under `web/src/components/chat/` and **consume** the F02 r2 primitives in `ui/`, `content/`, and the conversation composites in `conversation/` (notably `<ToolChip>`).

```
chat/AnalystChatPanel.vue        ← container; layout + store wiring only
├── chat/ChatHeader.vue          ← session label, connection chip, state slot (auth/error)
├── chat/MessageList.vue         ← scroll body; timeline + pending + thinking + on-screen children
│   └── chat/MessageItem.vue     ← single timeline row (bubble OR shared ToolChip)
├── chat/JumpToLatest.vue        ← floating pill, unseen counter, narrow-rail anchored
└── chat/ChatComposer.vue        ← textarea, send button, read-only tooltip

Imports from F02 r2:
  ui/            : Button, Pill, StatusDot, PanelHeading, Card, Spinner
  content/       : MarkdownText (relocated from web/src/components/code/)
  conversation/  : MessageBubble, ToolChip, ThinkingDots
```

### 3.1 `AnalystChatPanel.vue` (container, after)

Sole responsibilities:

- Bind Pinia store refs (`useAnalystChat`, `useCardStore`, `useWorkspaceRouteStore`, `useWsStore`, `useRuntimeStore`).
- Derive `unauthorized` and the debounced connection state (§6).
- Register the `saivage:focus-chat` listener and forward focus to the composer ref.
- Lay out four children in a single column grid.

No `<style scoped>` beyond the grid (`display: grid; grid-template-rows: auto 1fr auto;`) and the `position: relative` that anchors `JumpToLatest` (see §8.3).

Template sketch:

```vue
<template>
  <aside
    id="analyst-chat-panel"
    class="analyst-chat-panel"
    role="region"
    aria-label="Analyst chat"
  >
    <ChatHeader
      :session-id="activeSessionId"
      :connection-state="debouncedConnectionState"
      :unauthorized="unauthorized"
      :sessions-loading="sessionsLoading"
      :sessions-error="sessionsError"
    >
      <template #state>
        <UnauthorizedNotice v-if="unauthorized" @open-token-entry="openTokenEntry" />
      </template>
    </ChatHeader>

    <MessageList
      ref="messageListRef"
      :items="timelineItems"
      :pending-tools="pendingToolInvocationsForActiveSession"
      :badges="messageBadges"
      :thinking="thinking"
      :on-screen-children="childrenOnScreen"
      :expanded-ids="expandedIds"
      :messages-loading="messagesLoading"
      :messages-error="messagesError"
      :default-model-spec="defaultModelSpec"
      @toggle="toggleExpanded"
      @stickiness-change="onStickinessChange"
    />

    <JumpToLatest
      v-if="!stuckToBottom"
      :unseen="unseenCount"
      :bottom-offset-px="jumpBottomOffsetPx"
      @jump="jumpToLatest"
    />

    <ChatComposer
      ref="composerRef"
      v-model:draft="draft"
      :disabled="!activeSessionWritable"
      :sending="sending"
      :tooltip="composerTitle"
      :send-error="sendError"
      @submit="submitMessage"
      @resize="onComposerResize"
    />
  </aside>
</template>
```

### 3.2 `chat/ChatHeader.vue`

Props (typed):

```ts
defineProps<{
  sessionId: string | null;
  connectionState: WsConnectionState; // from api/types.ts:722
  unauthorized: boolean;
  sessionsLoading: boolean;
  sessionsError: DetailErrorState | null;
}>();
```

Internals:

- Renders `<PanelHeading level="3">` (F02 r2 §3.4) with `title` slot = `"Analyst chat"` and `meta` slot = the session label (`sessionId ? sessionId.slice(0, 14) : 'new session'`, formatted in `--font-mono`).
- Connection chip = adjacent `<StatusDot>` + `<Pill>` (F02 r2 §6.2 convention; no `StatusChip` composite). Icon glyph for the chip lives **next to** the pill (because `Pill` slots its own content) via a `lucide-vue-next` import (`Wifi` / `WifiOff` / `ShieldAlert` / `Loader2`):

  ```ts
  function chipIcon(s: WsConnectionState): Component {
    if (s === 'unauthorized' || s === 'no-token') return ShieldAlert;
    if (s === 'connecting') return Loader2;
    if (s === 'connected')  return Wifi;
    return WifiOff;
  }
  function chipDotTone(s: WsConnectionState): 'ok' | 'warn' | 'danger' | 'muted' {
    if (s === 'connected') return 'ok';
    if (s === 'unauthorized' || s === 'no-token') return 'warn';
    if (s === 'connecting') return 'muted';
    return 'danger';
  }
  function chipLabel(s: WsConnectionState): string {
    if (s === 'connected') return 'connected';
    if (s === 'connecting') return 'connecting…';
    if (s === 'unauthorized') return 'unauthorized';
    if (s === 'no-token') return 'no token';
    return 'offline';
  }
  ```

- `Loader2` consumes the global `.spin` pattern (already in F01 r2 §2.1).
- The `state` slot renders below the header strip. The container uses it for `UnauthorizedNotice` and for `sessionsError` / `messagesError` panels (the latter still owned by `MessageList`; the slot only carries the unauthorized inline notice).
- `sessionsLoading` shows a one-row `state-panel` (F02 r2 §6.4 composition: `<Card> + <Spinner>`) inside the header so the panel never collapses to zero height while sessions load.

No bespoke styles. Layout-only scoped class `chat-header` (flex row + gap, no colour).

### 3.3 `chat/MessageItem.vue`

**No `:message` prop on `ToolChip`.** This is the binding-critique change. The component contract is:

```ts
defineProps<{
  item: ChatMessage;
  badges: TimelineBadge[] | undefined;
  expanded: boolean;
  defaultModelSpec: string | null;
}>();
defineEmits<{ (e: 'toggle', id: string): void }>();
```

Branching:

- `item.kind === 'tool_call'` or `'tool_result'`:
  ```vue
  <ToolChip
    :view="adaptChatMessageToToolView(item)"
    :status="toolStatus(item)"
    :expanded="expanded"
    :details-id="`tool-detail-${item.id}`"
    :timestamp="item.timestamp"
    @toggle="$emit('toggle', item.id)"
  >
    <template #details>
      <FormattedContent :content="item.content" />
    </template>
  </ToolChip>
  ```
  The `view` value is a `ToolPresentationView` (F05 r2 §2 / §3) emitted by `adaptChatMessageToToolView` defined in §4. `status` is `'call' | 'ok' | 'error'`. No new prop, no chat-local chip API.
- otherwise (plain `message`):
  ```vue
  <MessageBubble
    :role="item.role"
    :kind="'plain'"
    :timestamp="item.timestamp"
    :model-label="modelLabel(item, defaultModelSpec)"
  >
    <template v-if="item.role === 'assistant'" #default>
      <MarkdownText :source="item.content" />
    </template>
    <template v-else #default>
      <span class="message-text">{{ item.content }}</span>
    </template>
    <template #meta>
      <Pill v-if="shortLabel(item)" :title="modelLabel(item, defaultModelSpec) ?? undefined">
        {{ shortLabel(item) }}
      </Pill>
    </template>
  </MessageBubble>
  ```
- After the bubble (or chip), badges render as a `<ul>` of `<Pill tone="accent">` rows (preserved v3-only feature). The badge `<ul>` is owned by `MessageItem`; styling is layout-only (column flex, gap).

The component **does not own** the `expandedIds` set; the container owns it and passes `expanded` + listens to `@toggle`. Same pattern v3 has today, only the chip props change.

### 3.4 `chat/MessageList.vue`

Props:

```ts
defineProps<{
  items: ChatMessage[];
  pendingTools: PendingToolInvocation[];
  badges: Record<string, TimelineBadge[]>;
  thinking: boolean;
  onScreenChildren: CardRecord[];
  expandedIds: Set<string>;
  messagesLoading: boolean;
  messagesError: DetailErrorState | null;
  defaultModelSpec: string | null;
}>();
defineEmits<{
  (e: 'toggle', id: string): void;
  (e: 'stickiness-change', payload: { stuck: boolean; unseen: number }): void;
  (e: 'resize', pendingFooterPx: number): void;
}>();
```

Owns:

1. The scroll container (`<div ref="scrollEl" class="message-list">`).
2. The `useStickToBottom(scrollEl)` composable (§5.2). Watches `items.length + pendingTools.length` and calls `markIncoming()` on growth.
3. The on-screen-children block — rendered at the **top** of the scroll body inside a `<Card>` so it scrolls with history. v3-only; **does not** become its own SFC (per r1's correct call, repeated by the reviewer).
4. The thinking footer — exactly one `<ThinkingDots />` (F02 conversation composite) rendered when `thinking === true`.
5. The pending-tool block — rendered **after** the timeline, **before** the bottom. Each `PendingToolInvocation` is adapted via `adaptPendingInvocationToToolView` (§4) and rendered through the **same** `<ToolChip>` with `status="pending"`. The pending block has its own surface-local layout class (`pending-tool-list`) so a `ResizeObserver` can read its height and feed `--chat-pending-h` (§8.3).
6. The `state-panel` cases:
   - `messagesLoading` → `<Card><Spinner /><span>Loading history…</span></Card>` (F02 r2 §6.4 composition).
   - `messagesError` with `kind === 'unauthorized'` → `<Card tone="warn" role="alert"><span>Unauthorized. Provide a valid Saivage API token and retry.</span></Card>` (the inline `UnauthorizedNotice` in `ChatHeader` already handles the trigger; this panel reports the state of the *last fetch*).
   - other `messagesError` → `<Card tone="danger" role="alert">{{ messagesError.message }}</Card>`.
   - empty state (no items, no pending tools, no on-screen children) → `<Card>No messages yet. Ask the analyst something.</Card>`.

Iterates `items` and delegates each row to `MessageItem`. Iterates `pendingTools` and renders the shared `<ToolChip>` with `status="pending"`. Emits `resize` whenever its observed pending-footer height changes, so the container can update the `--chat-jump-bottom` CSS var.

### 3.5 `chat/JumpToLatest.vue`

Props:

```ts
defineProps<{
  unseen: number;
  /**
   * Combined height (px) of composer + pending-tool footer.
   * Drives the absolute bottom offset inside the chat-panel viewport.
   */
  bottomOffsetPx: number;
}>();
defineEmits<{ (e: 'jump'): void }>();
```

Markup:

```vue
<button
  type="button"
  class="jump-to-latest"
  :class="{ unseen: unseen > 0 }"
  :style="{ bottom: `calc(${bottomOffsetPx}px + 8px)` }"
  :aria-label="unseen > 0 ? `${unseen} new messages, jump to latest` : 'Jump to latest'"
  @click="$emit('jump')"
>
  <ArrowDown class="icon" aria-hidden="true" />
  <span class="label">{{ unseen > 0 ? `${unseen} new` : 'Jump to latest' }}</span>
</button>
```

Scoped layout style (no colours; visual idiom comes from `Pill` tokens applied as `.pill .pill-accent` if we let the button **be** a pill; in this draft we keep the button bespoke because it needs `position: absolute`):

```css
.jump-to-latest {
  position: absolute;
  /* anchored INSIDE .analyst-chat-panel — see §8.3 */
  right: 12px;
  /* bottom is set by inline style from bottomOffsetPx */
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: calc(100% - 24px);
  padding: 6px 10px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text);
  cursor: pointer;
}
.jump-to-latest.unseen {
  border-color: var(--accent);
  color: var(--accent);
}
.jump-to-latest .label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.jump-to-latest .icon {
  flex-shrink: 0;
}
```

This SFC is the **only** place in F04 that owns an `position: absolute` floating element; everywhere else flows through F02 primitives.

### 3.6 `chat/ChatComposer.vue`

Props:

```ts
defineProps<{
  draft: string;
  disabled: boolean;
  sending: boolean;
  tooltip: string;
  sendError: DetailErrorState | null;
}>();
defineEmits<{
  (e: 'update:draft', value: string): void;
  (e: 'submit'): void;
  (e: 'resize', heightPx: number): void;
}>();
```

Owns:

- `<textarea>` with **resize-to-content** (port v2's `resizeInput()`):

  ```ts
  function resizeInput(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX);
    el.style.height = `${next}px`;
    emit('resize', next + COMPOSER_CHROME_PX);
  }
  const COMPOSER_MAX_HEIGHT_PX = 172; // 8 lines × 20 px + 12 px chrome
  ```

  Triggered on `input` and on mount. The composer's outer height (textarea + send row + optional error row) is reported via `@resize` so the container can update `--chat-composer-h` (§8.3).
- Keydown handler matching v2's matrix: `Enter` submits; `Shift+Enter`, `Ctrl+Enter`, `Meta+Enter`, and `event.isComposing` insert a newline (default browser behavior).
- Send button: `<Button variant="primary" :disabled="!canSend" :title="tooltip"><SendHorizontal /> Send</Button>` (F02 `Button` API from F02 r2 §3.1; `iconOnly: false`; icon comes through the default slot).
- Read-only tooltip wiring: the `tooltip` prop is the result of `composerTitle` in the container (preserved logic from v3 today).
- `sendError` panel renders directly below the send row as `<Card tone="danger" role="alert">{{ sendError.message }}</Card>`.

`defineExpose({ focus })` so the container's `saivage:focus-chat` handler can call it. The textarea ref is unchanged from v3 today.

---

## 4. Shared ToolChip integration (view-model adapter, no chat-local API)

Binding direction:

- `<ToolChip>` lives in [`web/src/components/conversation/ToolChip.vue`](../../../web/src/components/conversation/ToolChip.vue) per F02 r2 §3.9 and is shared with F03's agent conversation timeline.
- Its props are exactly **F02 r2 §3.9** (matching F05 r2 §6 markup and F03's chip expectations after F03 adopts the same view model — F03 r1's `ToolPair` is mapped to a `ToolPresentationView` before rendering, per the reviewer's required resolution):

  ```ts
  import type { ToolPresentationView } from '../../utils/tool-presenters';
  defineProps<{
    view: ToolPresentationView;
    status: 'call' | 'ok' | 'error' | 'pending';
    expanded: boolean;
    detailsId?: string;
    timestamp?: string;
  }>();
  defineEmits<{ (e: 'toggle'): void }>();
  ```

  The `ToolPresentationView` shape is the F05 r2 output:

  ```ts
  // F05 r2 §2, §3
  type ToolStatus = 'call' | 'ok' | 'error';
  interface ToolPresentationView {
    icon: string;
    name: string;
    headline: InlinePart[];
    detail: InlinePart[];
    status: ToolStatus;
  }
  type InlinePart =
    | { kind: 'text'; value: string; tone?: 'ok' | 'warn' | 'danger' | 'muted' }
    | { kind: 'file'; path: string; root: 'meta' | 'output' }
    | { kind: 'url';  url: string }
    | { kind: 'code'; value: string };
  ```

  F04 consumes this verbatim; F04 does **not** redefine `ToolPresentationView` and does **not** introduce a chat-local chip API.

### 4.1 Adapters

Two pure functions in a new `web/src/components/chat/tool-view-adapter.ts`:

```ts
import { presentToolCall, presentToolResult } from '../../utils/tool-presenters';
import type { ToolPresentationView, InlinePart } from '../../utils/tool-presenters';
import type { ChatMessage } from '../../api/types';

export type ChipStatus = 'call' | 'ok' | 'error' | 'pending';

export function adaptChatMessageToToolView(
  msg: ChatMessage,
): { view: ToolPresentationView; status: 'call' | 'ok' | 'error' } {
  if (msg.kind === 'tool_call') {
    const view = presentToolCall(msg.content, msg.tool);
    return { view, status: 'call' };
  }
  // 'tool_result'
  const view = presentToolResult(msg.content, { tool: msg.tool, kind: msg.kind });
  return { view, status: view.status };
}

export function adaptPendingInvocationToToolView(
  pending: PendingToolInvocation,
): { view: ToolPresentationView; status: 'pending' } {
  const headline: InlinePart[] = [{ kind: 'text', value: pending.summary }];
  const detail: InlinePart[] = [];
  if (pending.classifiedAs) {
    detail.push({ kind: 'text', value: pending.classifiedAs, tone: 'muted' });
  }
  if (pending.relatedCardId) {
    detail.push({ kind: 'text', value: `card ${pending.relatedCardId}`, tone: 'muted' });
  }
  return {
    view: {
      icon: '🔧',
      name: pending.tool || 'tool',
      headline,
      detail,
      status: 'call', // ToolPresentationView.status doesn't carry 'pending';
                     // the *chip's* status prop is 'pending' (set by caller).
    },
    status: 'pending',
  };
}
```

Notes:

- `ToolPresentationView.status` is `'call' | 'ok' | 'error'` (F05 r2 §2). The chip's own `status` prop is the union with `'pending'` (F02 r2 §3.9). The two are separate fields, on purpose: the presenter shape is symmetric with what F05 emits for non-pending tool messages; the pending state is an analyst-only chip lifecycle that F04 layers on top.
- No new pattern class. The chip composes `Card` (tone derived from `status`), a header `Button`, inline glyph + name, `<InlineParts>` (F05 r2 §6) for `view.headline` and `view.detail`, and a `details` slot for the expand body. **All status styling comes through `Card` + `Pill` composition and the chip's scoped layout** (F02 r2 §2.3, repeated by F04 reviewer).
- F04 ships `<FormattedContent :content="item.content" />` in the `details` slot for the analyst-side tool detail (per F05 r2 §7.3 — the same renderer F03 will use). No `<CodeBlock language="json">` short-circuit in `MessageItem` (today's behavior is replaced).
- The previous r1 sentence "Patterns.css under F01 needs a `.tool-chip-pending` rule" is **removed**. F01 r2 does not own it; F02 r2 §2.3 explicitly drops it.

### 4.2 Status → `Card` tone mapping (already F02 r2 §3.9)

The mapping lives inside `ToolChip.vue`, **not** in F04. Listed here only to make the F04 visual expectation explicit:

| `status` | `Card` tone | rationale |
| --- | --- | --- |
| `'call'`    | `accent` (mild)  | initiated, awaiting result |
| `'ok'`      | `accent`         | successful result |
| `'error'`   | `danger`         | failed result |
| `'pending'` | `warn`           | live in-flight (no result yet) |

---

## 5. Composables

Two new files; each owns one v2 behavior; both consumed by `AnalystChatPanel.vue` and (later) by other surfaces if needed.

### 5.1 `web/src/composables/useDebouncedConnectionState.ts`

API:

```ts
import { ref, watch, onUnmounted, type Ref } from 'vue';
import type { WsConnectionState } from '../api/types';

const TO_OPEN_IMMEDIATE = ['connected'] as const;
const DEBOUNCE_MS = 400;

export function useDebouncedConnectionState(
  source: Ref<WsConnectionState>,
): { debounced: Ref<WsConnectionState> } {
  const debounced = ref<WsConnectionState>(source.value);
  let timer: ReturnType<typeof setTimeout> | null = null;
  function clear() { if (timer) { clearTimeout(timer); timer = null; } }
  watch(source, (next) => {
    if ((TO_OPEN_IMMEDIATE as readonly string[]).includes(next)) {
      clear();
      debounced.value = next;
      return;
    }
    clear();
    timer = setTimeout(() => { debounced.value = next; timer = null; }, DEBOUNCE_MS);
  }, { immediate: false });
  onUnmounted(clear);
  return { debounced };
}
```

Asymmetry matches v2 §1.3 — recovery (`→ connected`) is immediate, flapping is hidden by 400 ms.

### 5.2 `web/src/composables/useStickToBottom.ts`

API:

```ts
import { ref, computed, nextTick, type Ref } from 'vue';

export function useStickToBottom(elRef: Ref<HTMLElement | null>, thresholdPx = 60) {
  const stuck = ref(true);
  const unseen = ref(0);

  function distanceFromBottom(el: HTMLElement): number {
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }

  function onScroll(): void {
    const el = elRef.value; if (!el) return;
    const next = distanceFromBottom(el) <= thresholdPx;
    if (next && !stuck.value) unseen.value = 0;
    stuck.value = next;
  }

  function markIncoming(): void {
    const el = elRef.value;
    if (!el) return;
    if (stuck.value) {
      void nextTick(() => {
        el.scrollTop = el.scrollHeight;
      });
    } else {
      unseen.value += 1;
    }
  }

  async function jumpToLatest(): Promise<void> {
    const el = elRef.value; if (!el) return;
    stuck.value = true;
    unseen.value = 0;
    await nextTick();
    el.scrollTop = el.scrollHeight;
  }

  return { stuck, unseen, onScroll, markIncoming, jumpToLatest };
}
```

- `nextTick` is essential because new timeline rows may not have flushed when the watcher fires.
- The `bottomOffsetPx` value passed to `JumpToLatest` is **not** owned by this composable; the container computes it from `--chat-composer-h` + `--chat-pending-h` (see §8.3). Keeping the composable narrow makes it reusable for the agents view.

### 5.3 Focus-chat shortcut — already wired, only the path moves

[AnalystChatPanel.vue lines 222–232 (current)](../../../web/src/components/chat/AnalystChatPanel.vue#L222-L232) install the `saivage:focus-chat` window listener. After the port the listener stays in the **container**; the focus call becomes `composerRef.value?.focus()` against `ChatComposer`'s exposed `focus()`. Dispatchers in [AppShell.vue#L131](../../../web/src/components/layout/AppShell.vue#L131) and [cards/CardDetailView.vue#L491](../../../web/src/components/cards/CardDetailView.vue#L491) keep working unchanged.

---

## 6. Connection / auth: stores of truth, no parallel state machine

### 6.1 Sources of truth (already exist in v3)

- `useWsStore().connectionState: WsConnectionState` ([api/types.ts#L722](../../../web/src/api/types.ts#L722)).
- `useRuntimeStore().unauthorized: Ref<boolean>` (composed elsewhere from `getAuthToken() === null` and HTTP 401 responses).

`unauthorized` boolean exposed to `ChatHeader`:

```ts
const unauthorized = computed(() =>
  ws.connectionState === 'unauthorized' ||
  ws.connectionState === 'no-token' ||
  runtime.unauthorized,
);
```

**No new auth composable.** Reviewer R1 confirmed this in the axis review (clean architecture: satisfied except for chip drift). F04 does not add a parallel `useAuthState()`; it only reads what already exists.

### 6.2 Debounce

`useDebouncedConnectionState(toRef(ws, 'connectionState'))` produces the value the chip reads. The debounce is applied **only to the chip**; the `unauthorized` boolean used for the inline panel is **not** debounced (auth state should flip instantly so the operator can react).

### 6.3 Inline auth via existing `ApiTokenEntry`

`UnauthorizedNotice.vue` (new, ~30 lines):

```vue
<template>
  <Card tone="warn" role="alert" data-testid="analyst-unauth-notice">
    <KeyRound class="icon" aria-hidden="true" />
    <div class="copy">
      <strong>API token required.</strong>
      <span>Provide a valid Saivage API token to send messages.</span>
    </div>
    <Button data-testid="open-token-entry" @click="$emit('openTokenEntry')">
      Enter token
    </Button>
  </Card>
</template>
```

The `Enter token` button dispatches the existing app-level event used by [`ApiTokenEntry.vue`](../../../web/src/components/auth/ApiTokenEntry.vue) (the modal already listens for the open trigger from the nav rail's `api-token-btn` per F02 r2 §4.2). F04 does **not** introduce a local token input; it does **not** duplicate v2's inline password field. Reviewer's "Additional Notes" guidance: use the existing flow, not v2's inline form.

If `runtime.unauthorized` flips false while the notice is mounted, it is unmounted by the parent's `v-if="unauthorized"`. No internal state.

### 6.4 What the chip does NOT own

- It does **not** mutate `ws.connectionState`.
- It does **not** call `ws.reconnect()`. The reconnect path lives where it already lives (`useWsStore`).
- It does **not** read or write tokens.

This is the second pillar of the reviewer's "no parallel auth state machine" requirement.

---

## 7. `ChatMessage` additive metadata (wire-additive, consumed locally)

### 7.1 Today

[api/types.ts](../../../web/src/api/types.ts) `ChatMessage` carries `id`, `session_id`, `role`, `kind`, `content`, `tool?`, `tool_call_id?`, `timestamp`, `links?`. No `provider`, no `model`, no `modelSpec`, no `requestedModelSpec`. The model chip cannot be rendered.

### 7.2 Additive extension

```ts
// web/src/api/types.ts
export interface ChatMessage {
  // …existing…
  provider?: string;
  model?: string;
  modelSpec?: string;
  requestedModelSpec?: string;
}
```

- All four are **optional**. Adding them is wire-additive on both REST (`GET /api/chats/:sessionId`) and WS (`message` envelope). The store's `fetchMessages()` ([stores/analystChat.ts](../../../web/src/stores/analystChat.ts), the `getChatMessages` call site) is pass-through; no shaping change.
- Server-side responsibility: surface them in the `message` projection. If the server already records them in the analyst session log, the change is type-only.

### 7.3 Consumption (scoped)

Per reviewer's "Additional Notes": consumption stays **local to the analyst message UI**, limited to model-label derivation:

- `web/src/utils/model-label.ts` (new): `modelLabel(msg, defaultModelSpec)` and `shortModelLabel(msg)`. Ports v2 logic (`modelSpec ?? "provider/model"`; short = suffix after last `/`).
- Consumed by `MessageItem.vue` only — for the assistant model `<Pill>` in the bubble's `meta` slot. Long string goes into `title` for hover discovery.
- `requestedModelSpec` is captured in the type but renders no UI in F04. It is reserved for a future ambient/divergence affordance, called out in §12.

F03 may consume the same fields if its round model annotation needs them; that consumption is F03's call, not F04's. F04 does not impose a cross-issue dependency on F03 here.

### 7.4 `defaultModelSpec`

The container computes `defaultModelSpec = computed(() => firstAssistantMessage(messages.value)?.modelSpec ?? null)` and passes it to `MessageList` → `MessageItem`. The model chip is hidden when `msg.modelSpec === defaultModelSpec` and `requestedModelSpec === undefined` (matches v2's "ambient" rule from §1.5 / §1.6). This collapses the chip noise on long single-model conversations without removing the affordance when models differ.

---

## 8. Narrow-rail layout rules

The analyst panel is the right rail of [AppShell.vue](../../../web/src/components/layout/AppShell.vue) — a ~20–30 vw column. Every horizontal constraint is scaled to the rail.

### 8.1 Bubble width and overflow

- `MessageBubble` outer width: `100%`. v2's `min(780px, 92%)` clamp is **not** ported (it is correct only for the full-window chat).
- `min-width: 0` on every flex/grid child that contains potentially wide text or code, so `text-overflow: ellipsis` and `pre` overflow work without column blow-out. Concretely: `MessageBubble`'s content area, the chip headline span, the composer textarea container.
- `MessageBubble` for `role="user"` retains right-alignment (margin-left: auto) but inside a `max-width: 100%` band.
- `MessageBubble` for `role="system"` (mapped to `Card tone="purple"` per F02 r2 §3.8) is centred and **does not** widen past `100%` of the rail — v2's wider centred max-width is dropped.

### 8.2 Model chip ellipsis

- F02 r2 `<Pill>` truncates internally at `max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap` (this is a pattern requirement that F02 r2 §3.2 already implies through `.pill`'s layout style — F04 does **not** add a new pattern). If F02 r2's `.pill` rule turns out to lack the ellipsis, F02 owns adding it; F04 documents the requirement as the test contract (§9.1, "the model pill ellipses long modelSpecs").
- The chip's `title` attribute holds the full string, so hover discovery is preserved (v2 §1.5).

### 8.3 `JumpToLatest` positioning rules (binding-critique fix)

The float must not overlap the composer, the pending-tool footer, or the scrollbar, and must stay legible at narrow widths.

**Anchor**:

- `JumpToLatest` is `position: absolute`, anchored to `.analyst-chat-panel` (the panel sets `position: relative`). It is **not** anchored to `document.body` and **not** anchored to `MessageList` — the panel is the natural viewport, and using it keeps the float inside the rail's bounding box regardless of `MessageList`'s overflow scroll.
- `right: 12px` (constant gutter); `bottom: calc(var(--chat-jump-bottom) + 8px)` where `--chat-jump-bottom` is set inline on `.analyst-chat-panel`.

**Bottom offset**:

- `--chat-jump-bottom` = `composer-height` + `pending-tool-footer-height`. Both heights are read via `ResizeObserver`:
  - `ChatComposer.vue` emits `@resize(heightPx)` from a `ResizeObserver` watching the composer root. The container stores `composerHeightPx`.
  - `MessageList.vue` emits `@resize(pendingFooterPx)` from a `ResizeObserver` watching the pending-tool list element. When the list is empty the value is `0`. The container stores `pendingFooterPx`.
- `jumpBottomOffsetPx = composerHeightPx + pendingFooterPx`. Bound on the panel element as `:style="{ '--chat-jump-bottom': jumpBottomOffsetPx + 'px' }"`. `JumpToLatest` reads the value via its `bottomOffsetPx` prop **and** the var (the prop drives both the inline `bottom` style for resilience against missing CSS vars, and the var is the canonical source for any sibling element that needs the same offset).
- Alternative considered: use plain flex layout (composer + pending block as siblings, jump button in a separate row that pushes them up). Rejected because v2's behavior anchors the float **inside** the scroll viewport so it overlays the composer slightly — the `position: absolute` formulation matches the intended look and keeps `MessageList` from reflowing on hide/show.

**Max width**:

- `max-width: calc(100% - 24px)` — leaves 12 px on each side (matching the `right: 12px` gutter). Prevents the unseen-count pill from running off the rail.
- Label span has `min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap` — guarantees ellipsis on `${unseen} new` even when `unseen` reaches 1000+. The container `inline-flex` plus `flex-shrink: 0` on the icon keeps the icon visible.

**Z-index**: `z-index: 1` over the scroll body; below any Overlay (which sets a higher stacking context).

**Test contract** (§9): the jump button is queryable by `[data-testid="jump-to-latest"]`, its `style.bottom` reflects the resize-observer-fed value when probed, and the unseen label asserts on `getByText('3 new')` rather than on class.

### 8.4 Composer min-width

- `.chat-composer` cell has `min-width: 0` so `scrollHeight` reads do not jump when the rail narrows.
- `textarea` `min-height: 38px` (v2 parity), `max-height: 172px`, `resize: none` (resize-to-content takes over from the CSS handle — v2 parity).

### 8.5 Tool chip ellipsis

The chip's headline single-line ellipsis is **owned by `ToolChip.vue`** (F02 conversation composite), not by F04. F04 only documents the visual expectation for the narrow rail: the headline span has `min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap`. F02 r2 §3.9 / F05 r2 §6 already imply this; F04 does not redefine.

---

## 9. Test plan (corrected file inventory)

**Real files** (verified by reading the live tree under [`web/src/__tests__/`](../../../web/src/__tests__/)):

### 9.1 [`web/src/__tests__/analyst-chat-panel.test.ts`](../../../web/src/__tests__/analyst-chat-panel.test.ts) — rewrite

Current selectors to migrate:

- `button.primary-btn` → `wrapper.get('[data-testid="analyst-send"]')` (Send button from F02 `<Button variant="primary">`).
- `.tool-chip` (analyst chip) → `wrapper.findAll('[data-testid="tool-chip"]')` against the shared `ToolChip` composite. Status assertions move from `chips[i].classes().toContain('tool-chip-ok')` to `chips[i].attributes('data-status')` (the composite exposes `data-status="ok|call|error|pending"` as a stable test hook — F02 r2 §3.9 chip contract).
- Title `Ask the analyst…` assertion → `wrapper.get('[data-testid="analyst-send"]').attributes('title')` (unchanged semantics).
- `saivage:focus-chat` dispatch test → unchanged: dispatch `window.dispatchEvent(new CustomEvent('saivage:focus-chat'))`, assert the composer textarea is the active element. The container forwards focus to `ChatComposer`'s exposed `focus()`.
- Pending-tool chip rendering test → assert via `wrapper.findAll('[data-testid="tool-chip"][data-status="pending"]')` (shared chip with `status="pending"`). Pending dedupe coverage remains via the new pending block + the store-level dedupe (see §9.2).
- Tool result expansion test → toggling the chip's header button now reveals a `[data-testid="formatted-content"]` block (from `<FormattedContent>` in the chip's `details` slot), not a raw `<CodeBlock>`. The assertion looks for the content presence, not the exact wrapper.
- Empty-state assertion → unchanged text query.
- Loading-history assertion → query the `state-panel` text via role/text (`getByText(/Loading history/)`).
- Read-only tooltip → `wrapper.get('[data-testid="analyst-send"]').attributes('title')` equals the read-only string when `activeSessionWritable === false`.

The model-pill ellipsis test is **new** (assert that a long `modelSpec` produces a `<Pill>` whose visible text is ellipsised and whose `title` is the full string).

### 9.2 [`web/src/__tests__/analyst-chat-store.test.ts`](../../../web/src/__tests__/analyst-chat-store.test.ts) — fixtures + assertions

The store-level tests are mostly behavior-of-store; the rewrite scope is:

- **Fixtures accept the additive `ChatMessage` fields** (`provider`, `model`, `modelSpec`, `requestedModelSpec`). The store does not interpret them, but tests must construct fixtures that pass the type-checked `ChatMessage` shape after §7.2 lands.
- **Pending-tool dedupe assertions remain covered.** `pendingToolInvocations` and `dedupePendingToolInvocations` keep their existing tests:
  - `keeps pending analyst tool chips visible until fetched tool messages exist`
  - `bounds pending attribution state and keeps the newest invocations`
  - `deduplicates repeated websocket analyst tool events for the same session and summary`
  - `normalizes snake_case session ids, bounded summaries, and empty tool names from sanitized payloads`
  - `falls back to a safe default summary when the payload summary is empty or missing`
  - `collapses stale analyst session ids when deduping otherwise identical events`
- After the chip adapter lands (§4), one new test in this file: **`pending invocations adapt to ToolPresentationView with status pending`** — calls `adaptPendingInvocationToToolView` with a fixture and asserts the resulting `view.headline[0].kind === 'text'`, `view.detail` length matches expected metadata, and the returned `status === 'pending'`. (This is a unit test of the adapter, but it lives in the store-test file because the adapter consumes `PendingToolInvocation` defined in the store module; alternatively a dedicated `tool-view-adapter.test.ts` may be created — equivalent coverage.)

### 9.3 [`web/src/__tests__/components/AnalystChatPanel.children.test.ts`](../../../web/src/__tests__/components/AnalystChatPanel.children.test.ts) — non-prefix sibling, separate

Listed separately per the reviewer because it lives under `__tests__/components/`, not under the `analyst-chat-*` prefix. Rewrite scope:

- `wrapper.find('.on-screen-children')` (current selector) → continues to work because the on-screen list keeps its layout-only class (per F02 r2 §4.13 — surface-local layout classes survive). Optionally add `data-testid="on-screen-children"` for explicitness; assertion semantics unchanged.
- The three existing tests (`imports the singular useCardStore symbol from ../../stores/cards`, `renders children in card position order returned by childrenOf`, `does not render the list outside the cards view`) survive as-is. The import-source assertion is a static import test and is unaffected by the port.
- Selector for the section header `<h3 id="on-screen-title">` keeps `aria-labelledby` semantics.

### 9.4 [`web/src/__tests__/analyst-toaster.test.ts`](../../../web/src/__tests__/analyst-toaster.test.ts) — NOT touched by F04

F04 does **not** change toaster selectors. The toaster file ([AnalystToaster.vue](../../../web/src/components/chat/AnalystToaster.vue)) is restyled by F01 r2's mechanical hex sweep, and F02 r2 §4.10 lists its `.analyst-toaster`/`.toast`/`.analyst-chip` selectors with their testid migrations. Those migrations belong to F01/F02; F04 only ensures it does not add a regression. The file is listed here for completeness so the reviewer can verify F04 has not silently changed toaster behavior.

### 9.5 Removed file

[`web/src/__tests__/analyst-chat-error-states.test.ts`](../../../web/src/__tests__/analyst-chat-error-states.test.ts) — **does not exist** in the tree. r1 invented it. r2 drops the reference. Error-state coverage (`messagesError.kind === 'unauthorized'`, `sendError`, `sessionsError`) lives inside `analyst-chat-panel.test.ts` (and new assertions added there in §9.1).

### 9.6 New tests added by F04

- `web/src/__tests__/jump-to-latest.test.ts` (component unit test):
  - renders `bottom: calc(48px + 8px)` style when `bottomOffsetPx === 48`.
  - shows `${unseen} new` when `unseen > 0`, otherwise `Jump to latest`.
  - emits `jump` on click.
  - applies `unseen` class when unseen > 0; carries `data-testid="jump-to-latest"`.
  - label remains ellipsis-safe under narrow widths (presence of `.label` with `overflow: hidden` + `white-space: nowrap` asserted via computed style).
- `web/src/__tests__/composables/useStickToBottom.test.ts`:
  - `stuck` flips false on scroll above threshold, true when scrolled within threshold.
  - `markIncoming` bumps `unseen` only when not stuck; scrolls to bottom on `nextTick` when stuck.
  - `jumpToLatest` resets `unseen` to 0 and forces `stuck=true`.
- `web/src/__tests__/composables/useDebouncedConnectionState.test.ts`:
  - transition `offline → connected` is immediate.
  - transition `connected → connecting` is delayed 400 ms.
  - cancelling timer on rapid re-flap leaves `debounced` on `connected`.
- F02 r2 already plans `conversation/ToolChip.test.ts` (status mapping). F04 does not duplicate it.

---

## 10. Alternative considered

### Alt A — Full ChatWindow port

Lift v2's `ChatWindow.vue` (≈675 lines) into v3 as the analyst panel.

Pros:

- Byte-for-byte v2 visual parity.
- Header strip, role tinting, chip, dots, jump-to-latest, inline auth all already in one file.

Cons (decisive):

- The v2 file owns its own WebSocket + auth composables. Importing them duplicates state that `useWsStore` and `useRuntimeStore` already own — exactly the "parallel auth state machine" the reviewer flags as a blocker.
- v2's layout assumes a full-window centred chat (`width: min(780px, 92%)`, `min(360px, 55vw)` chip). The right rail is 20–30 vw; the file would need a wholesale layout pass anyway.
- The v3-only features (on-screen children, pending tool invocations, badges, read-only tooltip, focus-chat shortcut) have no v2 hook points; we would need to splice them in, fighting v2's structure.
- Violates the project guideline: porting the whole file preserves backward-compat with v2's class structure (`entry-user`, `dot-pulse`, `keyround-panel`, `unseen-counter`) rather than expressing them through F02 primitives.

### Alt B — Decomposed right-rail (SELECTED)

Extract v2's behaviors (debounce, jump-to-latest, model chip, thinking dots, inline auth, resize-to-content composer) and re-apply them through F02 primitives + F03/F05 shared composites. v3-only features stay; the v2 file is **not** imported.

Pros (decisive):

- One source of truth per behavior — `useWsStore`, `useRuntimeStore`, F02 primitives, F03/F05 `ToolChip`. No duplicate state, no bespoke chip implementation.
- Each new file is small (`ChatHeader` ≈ 60 lines, `MessageList` ≈ 120 lines, `MessageItem` ≈ 80 lines, `JumpToLatest` ≈ 40 lines, `ChatComposer` ≈ 80 lines, two composables ≈ 30 lines each). Total roughly equal line count to today's monolith, organised by responsibility.
- The narrow-rail layout rules in §8 are easy to express against decomposed surfaces (each composite owns the constraints relevant to its slot).

Cons:

- More files to land in one commit. Mitigated by the absence of intermediate states — the decomposition lands in the same change as the F02 primitives' first analyst-side consumer.

**Selected**: Alt B. Reasoning matches the reviewer's clean-architecture and no-backward-compat axes.

---

## 11. Cross-issue ordering & dependencies

F04 cannot land before its prerequisites. The shipping order is:

1. **F01 r2 lands first** — tokens, semantic vars, base, patterns. Until `--accent`, `--surface-1`, `--entry-{user,warn,danger,purple}-{bg,border}`, `--btn-primary-*`, `--code-block-bg`, etc. exist, F04's composites have nothing to bind to.
2. **F02 r2 lands second** — `ui/` primitives (`Button`, `Pill`, `Card`, `PanelHeading`, `StatusDot`, `Spinner`), `content/` renderers (`MarkdownText`, `FormattedContent`), and the conversation composites (`MessageBubble`, `ToolChip`, `ThinkingDots`). The deletion matrix (F02 r2 §4.10) removes the analyst panel's bespoke styles in the same commit.
3. **F05 r2 lands third** — the unified `ToolPresentationView` + `InlinePart` types and the new `presentToolCall` / `presentToolResult` shapes (`headline: InlinePart[]`, `detail: InlinePart[]`, `status`). F04's adapter in §4.1 imports those types. The chip swap on the analyst side **must coincide with F05 landing** because the chip's `view` prop type changes from the old string-headline shape to the new `InlinePart[]` shape; there is no intermediate state.
4. **F03 r1 and F04 r2 can land in any order** after F02 r2 and F05 r2. They share `<ToolChip>` but their containers are independent (agents view vs analyst panel). F03 r1's `ToolPair` is adapted into `ToolPresentationView` inside the agent composable — F04 is not blocked by F03's adapter and vice versa.
5. **`ChatMessage` contract addition (§7.2)** is a server-side commit that can ship in the F04 PR or one ahead. Until it ships, the model chip degrades to "not rendered" — no broken UI. The reviewer's clean-architecture axis is satisfied because the absence of the field is the expected steady state until the server stamps it.

Dependency graph (terse):

```
F01 r2 ─┬─► F02 r2 ─┬─► F03 (timeline composites use Card/ToolChip)
        │           └─► F04 (analyst panel uses ChatHeader/MessageList/etc.)
        └─► (independent)
F05 r2 ──► F02 r2 (ToolChip view-model)
         ──► F03  (toolFormatters + chip)
         ──► F04  (chip adapter + InlineParts in details)
```

---

## 12. Non-goals

- **No replay-protocol redesign** of the analyst WebSocket. `useWsStore` + `useAnalystChat` plumbing is reused; F04 only reads their refs.
- **No `ChatWindow.vue` migration** from v2. The file stays in the v2 repo; F04 extracts behaviors and re-applies them through F02 primitives.
- **No `useWebSocket` / `useAuthState` port** from v2. v3 has its own equivalents.
- **No new auth composable.** Sources of truth are `useWsStore.connectionState` + `useRuntimeStore.unauthorized`.
- **No `requestedModelSpec` UI** in this round. The field is captured in the `ChatMessage` contract (§7.2) and reserved for a future ambient/divergence annotation. The reviewer's "Additional Notes" guidance — consumption limited to model-label derivation — is respected.
- **No `.tool-chip-pending` global pattern class.** Per F02 r2 §2.3 and the binding critique, status styling comes through `Card` tone composition inside `ToolChip`.
- **No chat-local `:message` chip prop.** Per the binding critique, the shared `<ToolChip>` accepts a `view: ToolPresentationView` + `status` + `expanded` + `detailsId` + `timestamp`. F04 adapts both `ChatMessage` (tool-role) and `PendingToolInvocation` into that view-model before rendering.
- **No inline v2-style token input.** Inline auth uses `<UnauthorizedNotice>` whose action button triggers the existing [`ApiTokenEntry.vue`](../../../web/src/components/auth/ApiTokenEntry.vue) modal flow.
- **No `analyst-chat-error-states.test.ts`** — the file does not exist. Error coverage stays inside `analyst-chat-panel.test.ts`.
- **No toaster changes**. F04 does not touch [`AnalystToaster.vue`](../../../web/src/components/chat/AnalystToaster.vue) selectors; F01/F02 own the toaster cleanup.
- **No store data-shape changes** beyond consuming the four optional `ChatMessage` fields.
- **No F03 round/timeline structure on the analyst surface.** The analyst panel renders a flat timeline by design; round grouping is F03's agents-view concern only.
