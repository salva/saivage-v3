# F04 — Chat / analyst surface style — Functional analysis (r3)

Writer round 3. Binding critique:
[01-analysis-review-r2.md](01-analysis-review-r2.md). Prior draft:
[01-analysis-r2.md](01-analysis-r2.md). Project guideline (binding):
**architecture-first, no backward compatibility**. No fallback
styles, no legacy class aliases, no `.tool-chip-pending` global
pattern, no aliased `.message-bubble`/`.primary-btn`/etc., and no
chat-local chip API parallel to the shared `ToolChip`.

Companion files (binding):
[F04 issue](../F04-chat-surface-style.md),
[00 subsystem map](../00-SUBSYSTEM-MAP.md),
[F01 r2](../F01-design-tokens/01-analysis-r2.md),
[F02 r2](../F02-component-hierarchy/01-analysis-r2.md),
[F03 r2](../F03-conversation-rounds/01-analysis-r2.md),
[F05 r2](../F05-tool-detail-rendering/01-analysis-r2.md).

---

## 0. Required-changes coverage map (r2 → r3)

The single binding required item from
[01-analysis-review-r2.md](01-analysis-review-r2.md) is:

> Align F04 r2 with F03 r2's current shared `ToolChip` API and
> landing-order decision.

It splits into five concrete sub-items A–E (per the writer brief).
This draft addresses them as follows:

| Sub-item | Subject | Addressed in |
| --- | --- | --- |
| **A** | Replace the chip API with F03 r2's canonical contract (`call: ToolCallPresentation`, `result: ToolResultPresentation \| null`, `status: ToolPairStatus`, `expanded`, `detailsId`, `timestamp?`). | §4 (shared chip contract verbatim), §3.3 (`MessageItem.vue` signature), §4.2 (status mapping table). |
| **B** | Update F04 adapters to return that exact shape. Two adapters: one for a persisted analyst tool-role `ChatMessage` (paired with its sibling `tool_result` when present), one for a pending invocation (`result: null`). Concrete TS signatures + worked examples. | §4.1 (signatures), §4.3 (worked example: persisted), §4.4 (worked example: pending), §3.4 (`MessageList.vue` pairing + iteration). |
| **C** | Fix §3.3 inconsistency: do **not** pass an adapter result to `:view`. Bind each prop individually via `v-bind`. Used **consistently** throughout the document. | §3.3 template, §3.4 template, §4.3/§4.4 worked examples — every chip render uses `v-bind="adaptChatMessageToToolChip(...)"` / `v-bind="adaptPendingInvocationToToolChip(...)"`. |
| **D** | Update cross-issue ordering to match F03 r2: the `AnalystChatPanel` chip swap lands **together with F03** in the same PR. F04 owns the rest of the surface (layout, decomposition, composables, styling), but the shared-chip integration in `MessageItem.vue` ships in F03's batch. No "either order after F02/F05". | §11 (cross-issue ordering), §11.2 (analyst chip swap edge), §12 (non-goals). |
| **E** | Cite F03 r2 (not r1) everywhere. | Header companion list, §3, §4, §11. |

Strengths from r2 that are retained (each cross-referenced):

- Correct test inventory: `analyst-chat-panel.test.ts`,
  `analyst-chat-store.test.ts`, `components/AnalystChatPanel.children.test.ts`,
  toaster left to F01/F02, `analyst-chat-error-states.test.ts` dropped (§9).
- `JumpToLatest` narrow-rail positioning: absolute inside the chat
  panel, `--chat-jump-bottom` driven by composer + pending-tool
  footer heights, `max-width: calc(100% - 24px)`, ellipsis-safe label
  (§3.5, §8.3).
- v3-only features preserved: on-screen children (§3.4), pending tool
  invocations (§4.4, §3.4), per-message badges (§3.3), read-only
  tooltip (§3.6), `saivage:focus-chat` shortcut (§5.3),
  `ApiTokenEntry` inline trigger (§6.3), `sessionsLoading` /
  `messagesLoading` / `messagesError(unauthorized)` / `sendError`
  state panels (§3.1, §3.4).
- No parallel WebSocket/auth state machine: stores of truth are
  `useWsStore.connectionState` and `useRuntimeStore.unauthorized`
  (§6).
- Additive `ChatMessage` extension limited to model-label derivation
  (§7).
- No port of v2 `useWebSocket` / `useAuthState`; no port of
  `ChatWindow.vue` (§10, §12).
- v3 stays a right-rail surface, not a copy of v2's full-window chat
  (§8, §10).

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
| 1.8 | Inline unauthorized panel above the message list: `KeyRound` icon + token-entry input. | [ChatWindow.vue#L254-L276](../../../../saivage/web/src/components/ChatWindow.vue#L254-L276) |
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
- **Tool-call/result presenters** routed through `presentToolCall` / `presentToolResult` ([utils/tool-presenters.ts](../../../web/src/utils/tool-presenters.ts)). F05 r2 redefines the shape (§4).
- **Pending tool invocations** scoped to the active session — [`pendingToolInvocationsForActiveSession`](../../../web/src/components/chat/AnalystChatPanel.vue#L64-L77).
- **Per-message badges** — [`messageBadges`](../../../web/src/components/chat/AnalystChatPanel.vue#L78-L82).
- **On-screen children section** — driven by `cards.childrenOf(workspaceRoute.entityId)` while `workspaceRoute.view === 'cards'`. Covered by [`components/AnalystChatPanel.children.test.ts`](../../../web/src/__tests__/components/AnalystChatPanel.children.test.ts).
- **`saivage:focus-chat` global shortcut** — listener registered `onMounted`; dispatched from [AppShell.vue#L131](../../../web/src/components/layout/AppShell.vue#L131) and [cards/CardDetailView.vue#L491](../../../web/src/components/cards/CardDetailView.vue#L491).
- **State panels**: `sessionsLoading`, `messagesLoading`, `messagesError.kind === 'unauthorized'`, `sendError`.
- **Read-only tooltip** when `activeSessionWritable === false` (driven by store `isWritableSession`).
- **API token entry** as a real, existing modal: [`components/auth/ApiTokenEntry.vue`](../../../web/src/components/auth/ApiTokenEntry.vue). F04 wires the inline panel to its trigger; F04 does **not** add a parallel inline token input.

### 2.2 Hard-coded styling to remove

Every hex literal in the SFC's scoped style block — `#0d1117`, `#161b22`, `#30363d`, `#1f2937`, `#58a6ff`, `#7ee787`, `#d2a8ff`, `#f85149`, `#ffa198`, `#79c0ff`, `#c9d1d9`, `#f0f6fc`, `#8b949e`, `#ff7b72` — is **deleted** (per F01 r2 §3.4 and the project guideline). The duplicate `.primary-btn` rule and the entire `.tool-chip*` family are deleted in the same commit that swaps in the shared `<ToolChip>` (per F03 r2 §8.2). **No aliasing.**

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

The current ~440-line SFC becomes pure layout. Surface composites live under `web/src/components/chat/` and **consume** the F02 r2 primitives in `ui/`, `content/`, and the conversation composites in `conversation/` (notably `<ToolChip>` per F03 r2 §7).

```
chat/AnalystChatPanel.vue        ← container; layout + store wiring only
├── chat/ChatHeader.vue          ← session label, connection chip, state slot (auth/error)
├── chat/MessageList.vue         ← scroll body; timeline + pending + thinking + on-screen children
│   └── chat/MessageItem.vue     ← single timeline row (bubble OR shared ToolChip)
├── chat/JumpToLatest.vue        ← floating pill, unseen counter, narrow-rail anchored
└── chat/ChatComposer.vue        ← textarea, send button, read-only tooltip

Imports from F02 r2:
  ui/            : Button, Pill, StatusDot, PanelHeading, Card, Spinner
  content/       : MarkdownText (relocated from web/src/components/code/),
                   FormattedContent (used in the chip's details slot)
  conversation/  : MessageBubble, ToolChip, ThinkingDots
```

### 3.1 `AnalystChatPanel.vue` (container, after)

Sole responsibilities:

- Bind Pinia store refs (`useAnalystChat`, `useCardStore`, `useWorkspaceRouteStore`, `useWsStore`, `useRuntimeStore`).
- Derive `unauthorized` and the debounced connection state (§6).
- Register the `saivage:focus-chat` listener and forward focus to the composer ref.
- Lay out four children in a single column grid.
- Compute `pairedTimeline` — the input to `MessageList` — by pairing `tool_call`/`tool_result` siblings by `tool_call_id` (see §3.4 / §4.1).

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
      :items="pairedTimeline"
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
- Connection chip = adjacent `<StatusDot>` + `<Pill>` (F02 r2 §6.2 convention; no `StatusChip` composite). Icon glyph for the chip is rendered next to the pill via a `lucide-vue-next` import (`Wifi` / `WifiOff` / `ShieldAlert` / `Loader2`):

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
- The `state` slot renders below the header strip. The container uses it for `UnauthorizedNotice` and for `sessionsError` panels.
- `sessionsLoading` shows a one-row `state-panel` (F02 r2 §6.4 composition: `<Card> + <Spinner>`) inside the header so the panel never collapses to zero height while sessions load.

No bespoke styles. Layout-only scoped class `chat-header` (flex row + gap, no colour).

### 3.3 `chat/MessageItem.vue`

The shared `<ToolChip>` API is **F03 r2 §7.2's `call/result/status` contract**, not a `view` prop. Props are bound individually via `v-bind` (an object produced by the adapter in §4.1). No `:view`, no `:message`, no chat-local chip API.

Component contract:

```ts
import type { AnalystTimelineItem } from '../../utils/analyst-timeline';
defineProps<{
  item: AnalystTimelineItem;        // { kind: 'message' | 'tool_pair', ... } — see §3.4
  badges: TimelineBadge[] | undefined;
  expanded: boolean;
  defaultModelSpec: string | null;
}>();
defineEmits<{ (e: 'toggle', id: string): void }>();
```

Branching:

- `item.kind === 'tool_pair'` (a `tool_call` ChatMessage optionally paired with its sibling `tool_result`):

  ```vue
  <ToolChip
    v-bind="adaptChatMessageToToolChip(item.call, item.result, expanded)"
    @toggle="$emit('toggle', toolChipId(item))"
  />
  ```

  `adaptChatMessageToToolChip` is defined in §4.1 and returns the exact F03 r2 prop bag
  `{ call, result, status, expanded, detailsId, timestamp }`. The chip's `details` slot
  is owned by `ToolChip.vue` (per F03 r2 §7.2 the body renders `<FormattedContent>` for
  call and, when present, result content). F04 does **not** override the slot.

- `item.kind === 'message'` (plain `message` ChatMessage):

  ```vue
  <MessageBubble
    :role="item.message.role"
    :kind="'plain'"
    :timestamp="item.message.timestamp"
    :model-label="modelLabel(item.message, defaultModelSpec)"
  >
    <template v-if="item.message.role === 'assistant'" #default>
      <MarkdownText :source="item.message.content" />
    </template>
    <template v-else #default>
      <span class="message-text">{{ item.message.content }}</span>
    </template>
    <template #meta>
      <Pill v-if="shortLabel(item.message)" :title="modelLabel(item.message, defaultModelSpec) ?? undefined">
        {{ shortLabel(item.message) }}
      </Pill>
    </template>
  </MessageBubble>
  ```

- After the bubble (or chip), badges render as a `<ul>` of `<Pill tone="accent">` rows (preserved v3-only feature). The badge `<ul>` is owned by `MessageItem`; styling is layout-only (column flex, gap).

The component **does not own** the `expandedIds` set; the container owns it and passes `expanded` + listens to `@toggle`. Same lifecycle pattern v3 has today; the only diff is that the chip now consumes the shared F03 r2 prop bag.

`toolChipId(item)` returns `item.call.tool_call_id ?? item.call.id` so each chip in the timeline has a stable expand-key.

### 3.4 `chat/MessageList.vue`

Props:

```ts
import type { AnalystTimelineItem } from '../../utils/analyst-timeline';

defineProps<{
  items: AnalystTimelineItem[];     // pre-paired by the container
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

`AnalystTimelineItem` is the analyst-side equivalent of F03 r2's
`TimelineItem`, but **flat** (no rounds — analyst chat does not group
by round). It is produced by `pairAnalystMessages(messages)` in
[`web/src/utils/analyst-timeline.ts`](../../../web/src/utils/analyst-timeline.ts) (new):

```ts
// web/src/utils/analyst-timeline.ts
import type { ChatMessage } from '../api/types';

export type AnalystTimelineItem =
  | { kind: 'message';   id: string; timestamp: string; message: ChatMessage }
  | {
      kind: 'tool_pair';
      id: string;                            // tool_call_id (fallback: call.id)
      timestamp: string;                     // call.timestamp
      call: ChatMessage;                     // kind === 'tool_call'
      result: ChatMessage | null;            // kind === 'tool_result' | null
    };

export function pairAnalystMessages(messages: ChatMessage[]): AnalystTimelineItem[] {
  const sorted = [...messages].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const results = new Map<string, ChatMessage>();
  for (const m of sorted) {
    if (m.kind === 'tool_result' && m.tool_call_id) results.set(m.tool_call_id, m);
  }
  const out: AnalystTimelineItem[] = [];
  for (const m of sorted) {
    if (m.kind === 'tool_call') {
      const id = m.tool_call_id ?? m.id;
      out.push({
        kind: 'tool_pair',
        id,
        timestamp: m.timestamp,
        call: m,
        result: m.tool_call_id ? (results.get(m.tool_call_id) ?? null) : null,
      });
    } else if (m.kind === 'tool_result') {
      // already consumed by its pair; skip.
      if (m.tool_call_id && results.has(m.tool_call_id)) continue;
      // orphan result: render as its own pair with a synthesised call
      // (path documented in §4.1, status = 'orphan').
      out.push({
        kind: 'tool_pair',
        id: m.tool_call_id ?? m.id,
        timestamp: m.timestamp,
        call: synthesizeCallFromResult(m),    // §4.1
        result: m,
      });
    } else {
      out.push({ kind: 'message', id: m.id, timestamp: m.timestamp, message: m });
    }
  }
  return out;
}
```

The container does:

```ts
const pairedTimeline = computed(() => pairAnalystMessages(messages.value));
```

Pairing in the analyst surface is the analogue of F03 r2 §3's
`entriesToTimeline()` but with `kind` reduced to two (no rounds, no
diagnostics, no compacted blocks — those are agent-surface concerns).

`MessageList` owns:

1. The scroll container (`<div ref="scrollEl" class="message-list">`).
2. The `useStickToBottom(scrollEl)` composable (§5.2). Watches `items.length + pendingTools.length` and calls `markIncoming()` on growth.
3. The on-screen-children block — rendered at the **top** of the scroll body inside a `<Card>` so it scrolls with history. v3-only; **does not** become its own SFC.
4. The thinking footer — exactly one `<ThinkingDots />` (F02 conversation composite) rendered when `thinking === true`.
5. The pending-tool block — rendered **after** the timeline, **before** the bottom. Each `PendingToolInvocation` is rendered through the **same** shared `<ToolChip>`:

   ```vue
   <section class="pending-tool-list">
     <ToolChip
       v-for="p in pendingTools"
       :key="p.id"
       v-bind="adaptPendingInvocationToToolChip(p, expandedIds.has(p.id))"
       @toggle="$emit('toggle', p.id)"
     />
   </section>
   ```

   The pending block has a surface-local layout class (`pending-tool-list`) so a `ResizeObserver` can read its height and feed `--chat-pending-h` (§8.3).
6. The `state-panel` cases:
   - `messagesLoading` → `<Card><Spinner /><span>Loading history…</span></Card>` (F02 r2 §6.4).
   - `messagesError.kind === 'unauthorized'` → `<Card tone="warn" role="alert">Unauthorized. Provide a valid Saivage API token and retry.</Card>`.
   - other `messagesError` → `<Card tone="danger" role="alert">{{ messagesError.message }}</Card>`.
   - empty state → `<Card>No messages yet. Ask the analyst something.</Card>`.

Iterates `items` and delegates each row to `<MessageItem>`. Emits `resize` whenever its observed pending-footer height changes, so the container can update the `--chat-jump-bottom` CSS var.

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
  data-testid="jump-to-latest"
  :class="{ unseen: unseen > 0 }"
  :style="{ bottom: `calc(${bottomOffsetPx}px + 8px)` }"
  :aria-label="unseen > 0 ? `${unseen} new messages, jump to latest` : 'Jump to latest'"
  @click="$emit('jump')"
>
  <ArrowDown class="icon" aria-hidden="true" />
  <span class="label">{{ unseen > 0 ? `${unseen} new` : 'Jump to latest' }}</span>
</button>
```

Scoped layout style (no colours; tokens-only):

```css
.jump-to-latest {
  position: absolute;
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
.jump-to-latest .icon { flex-shrink: 0; }
```

This SFC is the **only** place in F04 that owns a `position: absolute` floating element; everywhere else flows through F02 primitives.

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

  Triggered on `input` and on mount.
- Keydown handler matching v2's matrix: `Enter` submits; `Shift+Enter`, `Ctrl+Enter`, `Meta+Enter`, and `event.isComposing` insert a newline (default browser behavior).
- Send button: `<Button variant="primary" :disabled="!canSend" :title="tooltip" data-testid="analyst-send"><SendHorizontal /> Send</Button>` (F02 r2 §3.1).
- Read-only tooltip wiring: the `tooltip` prop is the result of `composerTitle` in the container.
- `sendError` panel renders below the send row as `<Card tone="danger" role="alert">{{ sendError.message }}</Card>`.

`defineExpose({ focus })` so the container's `saivage:focus-chat` handler can call it.

---

## 4. Shared ToolChip integration — F03 r2 §7.2 contract verbatim

### 4.0 The chip API F04 consumes (DO NOT redefine)

F04 imports the shared `<ToolChip>` from
[`web/src/components/conversation/ToolChip.vue`](../../../web/src/components/conversation/ToolChip.vue),
shipped by F03 r2 (per F03 r2 §7.2 and §8.2). F04 reproduces the
contract here **for reference only** — the type definitions live in
F03 r2 and F05 r2, not in F04.

```ts
// from F03 r2 §7.2 (verbatim)
defineProps<{
  call: ToolCallPresentation;          // F05 r2 §2 — always present
  result: ToolResultPresentation | null; // F05 r2 §2 — null when no result yet
  status: ToolPairStatus;              // F03 r2 §3.3
  expanded: boolean;
  detailsId: string;                   // `tool-detail-${toolUseId}`
  timestamp?: string;
}>();
defineEmits<{ (e: 'toggle'): void }>();
```

Imported types:

```ts
// F05 r2 §2
export interface ToolCallPresentation {
  icon: string; name: string;
  headline: InlinePart[]; detail: InlinePart[];
  status: 'call';
}
export interface ToolResultPresentation {
  icon: string; name: string;
  headline: InlinePart[]; detail: InlinePart[];
  status: 'ok' | 'error';
}

// F03 r2 §3.3
export type ToolPairStatus = 'pending' | 'ok' | 'error' | 'orphan' | 'missing';
```

### 4.1 Adapter signatures

Two pure functions in `web/src/components/chat/tool-chip-adapter.ts` (new):

```ts
import {
  presentToolCall,
  presentToolResult,
  type ToolCallPresentation,
  type ToolResultPresentation,
  type InlinePart,
} from '../../utils/tool-presenters';
import type { ChatMessage, PendingToolInvocation } from '../../api/types';
import type { ToolPairStatus } from '../../types/conversation'; // re-exported from F03 r2 types module

export interface ToolChipProps {
  call: ToolCallPresentation;
  result: ToolResultPresentation | null;
  status: ToolPairStatus;
  expanded: boolean;
  detailsId: string;
  timestamp?: string;
}

/**
 * Adapt a persisted analyst tool-role ChatMessage (the `tool_call` row)
 * plus its sibling `tool_result` (or null when not yet present) into
 * the shared <ToolChip> prop bag.
 *
 * Caller (MessageList) is responsible for pairing via tool_call_id
 * (see pairAnalystMessages in §3.4).
 */
export function adaptChatMessageToToolChip(
  call: ChatMessage,                    // kind === 'tool_call' (or a synthetic call for an orphan)
  result: ChatMessage | null,           // kind === 'tool_result' | null
  expanded: boolean,
): ToolChipProps;

/**
 * Adapt a live PendingToolInvocation (no persisted message yet) into the
 * shared <ToolChip> prop bag. `result` is always null; `status` is always
 * `'pending'`.
 */
export function adaptPendingInvocationToToolChip(
  pending: PendingToolInvocation,
  expanded: boolean,
): ToolChipProps;

// Helper used by pairAnalystMessages (§3.4) when only a tool_result exists
// (no matching tool_call). Architecture-first: we don't render two
// half-rows; we render one chip with an `orphan` status.
export function synthesizeCallFromResult(result: ChatMessage): ChatMessage;
```

Implementation outline:

```ts
export function adaptChatMessageToToolChip(
  call: ChatMessage,
  result: ChatMessage | null,
  expanded: boolean,
): ToolChipProps {
  const callView = presentToolCall(call.content, call.tool);
  const resultView = result
    ? presentToolResult(result.content, { tool: result.tool, kind: result.kind as 'tool_result' | 'tool_error' })
    : null;

  const status: ToolPairStatus = (() => {
    if (!resultView) return 'missing';                         // call present, no result yet
    if (isSynthesisedCall(call)) return 'orphan';              // result with no real call
    return resultView.status;                                  // 'ok' | 'error'
  })();

  return {
    call: callView,
    result: resultView,
    status,
    expanded,
    detailsId: `tool-detail-${call.tool_call_id ?? call.id}`,
    timestamp: call.timestamp,
  };
}

export function adaptPendingInvocationToToolChip(
  pending: PendingToolInvocation,
  expanded: boolean,
): ToolChipProps {
  const headline: InlinePart[] = [{ kind: 'text', value: pending.summary }];
  const detail: InlinePart[] = [];
  if (pending.classifiedAs) detail.push({ kind: 'text', value: pending.classifiedAs, tone: 'muted' });
  if (pending.relatedCardId) detail.push({ kind: 'text', value: `card ${pending.relatedCardId}`, tone: 'muted' });

  const callView: ToolCallPresentation = {
    icon: '🔧',
    name: pending.tool || 'tool',
    headline,
    detail,
    status: 'call',
  };

  return {
    call: callView,
    result: null,
    status: 'pending',
    expanded,
    detailsId: `tool-detail-pending-${pending.id}`,
    timestamp: pending.startedAt,
  };
}
```

Notes:

- The F05 r2 presenter `status` ('call' | 'ok' | 'error') and the F03 r2 chip `status` (`ToolPairStatus`) are **separate concepts**. The presenter `status` describes the payload (a call, a successful result, an error result); the chip `status` describes the **pair lifecycle** (pending, ok, error, orphan, missing). The adapter is the single place where the two are reconciled. F04 does not invent a new union; it consumes both as defined by F05 r2 and F03 r2.
- For the pending path, no presenter is invoked on the result side (`result: null`); the chip's `<Card>` tone comes from `status === 'pending'` per F03 r2 §7.2's tone mapping.
- F04 does **not** override the chip's `details` slot. The chip body renders `<FormattedContent>` for the call payload and, when `result !== null`, for the result payload — exactly as defined in F03 r2 §7.2. F05 r2 owns `FormattedContent`.
- No new pattern class. No `.tool-chip-pending` (per F02 r2 §2.3, restated here).

### 4.2 Status → `<Card>` tone (already F03 r2 §7.2)

For reference; the mapping lives inside `ToolChip.vue`, **not** in F04:

| `status`  | `<Card>` tone | rationale |
| --- | --- | --- |
| `'pending'` | `warn`   | in-flight, no result yet |
| `'ok'`      | `accent` | successful result |
| `'error'`   | `danger` | failed result |
| `'orphan'`  | `warn`   | result with no call (surfaced as warning, not error) |
| `'missing'` | `warn`   | call present, no result yet; chip headline gets a muted "(no result yet)" tail |

### 4.3 Worked example — persisted `tool_call` + sibling `tool_result`

Input ChatMessages (abbreviated):

```jsonc
[
  {
    "id": "m-101", "session_id": "s-1", "role": "tool", "kind": "tool_call",
    "content": "{\"path\": \".saivage/cards/c-42.json\"}",
    "tool": "read_file", "tool_call_id": "tu-9",
    "timestamp": "2026-05-25T08:30:01Z"
  },
  {
    "id": "m-102", "session_id": "s-1", "role": "tool", "kind": "tool_result",
    "content": "{ … contents … }",
    "tool": "read_file", "tool_call_id": "tu-9",
    "timestamp": "2026-05-25T08:30:02Z"
  }
]
```

`pairAnalystMessages` (§3.4) yields one `tool_pair`:

```ts
{
  kind: 'tool_pair',
  id: 'tu-9',
  timestamp: '2026-05-25T08:30:01Z',
  call: <m-101>,
  result: <m-102>,
}
```

Adapter call:

```ts
const props = adaptChatMessageToToolChip(item.call, item.result, expanded);
// props === {
//   call:   { icon: '📄', name: 'read_file', headline: [{kind:'file', path:'.saivage/cards/c-42.json', root:'meta'}], detail: [], status: 'call' },
//   result: { icon: '✅', name: 'read_file', headline: [{kind:'text', value:'120 lines'}],            detail: [], status: 'ok' },
//   status: 'ok',
//   expanded: false,
//   detailsId: 'tool-detail-tu-9',
//   timestamp: '2026-05-25T08:30:01Z',
// }
```

Render site (inside `MessageItem.vue`):

```vue
<ToolChip
  v-bind="adaptChatMessageToToolChip(item.call, item.result, expanded)"
  @toggle="$emit('toggle', item.id)"
/>
```

The chip itself, per F03 r2 §7.2, expands to a `<Card tone="accent">` (because `status === 'ok'`), shows the headline and detail via `<InlineParts>`, and renders **two** `<FormattedContent>` blocks in the body when expanded (one for `call.content`, one for `result!.content`). No `details` slot override is needed.

### 4.4 Worked example — pending invocation

Input `PendingToolInvocation`:

```ts
{
  id: 'p-77',
  sessionId: 's-1',
  tool: 'create_card',
  summary: 'Create child card "Renew passport"',
  classifiedAs: 'todo',
  relatedCardId: 'c-42',
  startedAt: '2026-05-25T08:31:10Z',
}
```

Adapter call:

```ts
const props = adaptPendingInvocationToToolChip(pending, expanded);
// props === {
//   call: {
//     icon: '🔧', name: 'create_card',
//     headline: [{ kind: 'text', value: 'Create child card "Renew passport"' }],
//     detail:   [
//       { kind: 'text', value: 'todo',        tone: 'muted' },
//       { kind: 'text', value: 'card c-42',   tone: 'muted' },
//     ],
//     status: 'call',
//   },
//   result: null,
//   status: 'pending',
//   expanded: false,
//   detailsId: 'tool-detail-pending-p-77',
//   timestamp: '2026-05-25T08:31:10Z',
// }
```

Render site (inside `MessageList.vue`'s pending section):

```vue
<ToolChip
  v-bind="adaptPendingInvocationToToolChip(p, expandedIds.has(p.id))"
  @toggle="$emit('toggle', p.id)"
/>
```

The chip renders as `<Card tone="warn">` per F03 r2 §7.2 because
`status === 'pending'`, and its body, when expanded, renders one
`<FormattedContent>` for the (synthetic) call payload — there is no
result block since `result === null`. No `details` slot override.

---

## 5. Composables

Two new files; each owns one v2 behavior; both consumed by `AnalystChatPanel.vue` and (later) by other surfaces if needed.

### 5.1 `web/src/composables/useDebouncedConnectionState.ts`

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

```ts
import { ref, nextTick, type Ref } from 'vue';

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
      void nextTick(() => { el.scrollTop = el.scrollHeight; });
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

The `bottomOffsetPx` value passed to `JumpToLatest` is **not** owned by this composable; the container computes it from `--chat-composer-h` + `--chat-pending-h` (see §8.3).

### 5.3 Focus-chat shortcut — already wired, only the path moves

[AnalystChatPanel.vue lines 222–232 (current)](../../../web/src/components/chat/AnalystChatPanel.vue#L222-L232) install the `saivage:focus-chat` window listener. After the port the listener stays in the **container**; the focus call becomes `composerRef.value?.focus()` against `ChatComposer`'s exposed `focus()`. Dispatchers in [AppShell.vue#L131](../../../web/src/components/layout/AppShell.vue#L131) and [cards/CardDetailView.vue#L491](../../../web/src/components/cards/CardDetailView.vue#L491) keep working unchanged.

---

## 6. Connection / auth: stores of truth, no parallel state machine

### 6.1 Sources of truth (already exist in v3)

- `useWsStore().connectionState: WsConnectionState` ([api/types.ts#L722](../../../web/src/api/types.ts#L722)).
- `useRuntimeStore().unauthorized: Ref<boolean>`.

`unauthorized` boolean exposed to `ChatHeader`:

```ts
const unauthorized = computed(() =>
  ws.connectionState === 'unauthorized' ||
  ws.connectionState === 'no-token' ||
  runtime.unauthorized,
);
```

**No new auth composable.** F04 does not add a parallel `useAuthState()`; it only reads what already exists.

### 6.2 Debounce

`useDebouncedConnectionState(toRef(ws, 'connectionState'))` produces the value the chip reads. The debounce is applied **only to the chip**; the `unauthorized` boolean used for the inline panel is **not** debounced.

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

The `Enter token` button dispatches the existing app-level event used by [`ApiTokenEntry.vue`](../../../web/src/components/auth/ApiTokenEntry.vue). F04 does **not** introduce a local token input; it does **not** duplicate v2's inline password field.

### 6.4 What the chip does NOT own

- It does **not** mutate `ws.connectionState`.
- It does **not** call `ws.reconnect()`.
- It does **not** read or write tokens.

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

All four are **optional**. Wire-additive on both REST (`GET /api/chats/:sessionId`) and WS.

### 7.3 Consumption (scoped)

- `web/src/utils/model-label.ts` (new): `modelLabel(msg, defaultModelSpec)` and `shortModelLabel(msg)`. Ports v2 logic.
- Consumed by `MessageItem.vue` only — for the assistant model `<Pill>` in the bubble's `meta` slot. Long string goes into `title`.
- `requestedModelSpec` is captured in the type but renders no UI in F04.

### 7.4 `defaultModelSpec`

The container computes `defaultModelSpec = computed(() => firstAssistantMessage(messages.value)?.modelSpec ?? null)` and passes it to `MessageList` → `MessageItem`. The model chip is hidden when `msg.modelSpec === defaultModelSpec` and `requestedModelSpec === undefined`.

---

## 8. Narrow-rail layout rules

### 8.1 Bubble width and overflow

- `MessageBubble` outer width: `100%`. v2's `min(780px, 92%)` clamp is **not** ported.
- `min-width: 0` on every flex/grid child that contains potentially wide text or code.
- `role="user"` retains right-alignment (margin-left: auto) but inside `max-width: 100%`.
- `role="system"` (mapped to `Card tone="purple"` per F02 r2 §3.8) is centred and does not widen past `100%` of the rail.

### 8.2 Model chip ellipsis

- F02 r2 `<Pill>` truncates internally. If F02 r2's `.pill` rule lacks the ellipsis, F02 owns adding it; F04 documents the requirement as the test contract.
- The chip's `title` attribute holds the full string.

### 8.3 `JumpToLatest` positioning rules

**Anchor**: `JumpToLatest` is `position: absolute`, anchored to `.analyst-chat-panel` (`position: relative`). `right: 12px`; `bottom: calc(var(--chat-jump-bottom) + 8px)`.

**Bottom offset**: `--chat-jump-bottom` = `composer-height` + `pending-tool-footer-height`. Both heights are read via `ResizeObserver`:

- `ChatComposer.vue` emits `@resize(heightPx)` from a `ResizeObserver`. Container stores `composerHeightPx`.
- `MessageList.vue` emits `@resize(pendingFooterPx)` from a `ResizeObserver` on the pending-tool list element. When empty, value is `0`.
- `jumpBottomOffsetPx = composerHeightPx + pendingFooterPx`. Bound on the panel as `:style="{ '--chat-jump-bottom': jumpBottomOffsetPx + 'px' }"`. `JumpToLatest` reads via its `bottomOffsetPx` prop (drives inline `bottom` for resilience) and the var (canonical for siblings).

**Max width**: `max-width: calc(100% - 24px)`.

**Label ellipsis**: `min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap`.

**Z-index**: `z-index: 1`.

**Test contract**: `[data-testid="jump-to-latest"]`, `style.bottom` reflects the resize-observer-fed value, unseen label assertion via `getByText('3 new')`.

### 8.4 Composer min-width

- `.chat-composer` cell has `min-width: 0`.
- `textarea` `min-height: 38px`, `max-height: 172px`, `resize: none`.

### 8.5 Tool chip ellipsis

Owned by `ToolChip.vue` (per F03 r2 §7.2), not by F04.

---

## 9. Test plan (corrected file inventory)

Real files (verified by reading the live tree under [`web/src/__tests__/`](../../../web/src/__tests__/)).

### 9.1 [`web/src/__tests__/analyst-chat-panel.test.ts`](../../../web/src/__tests__/analyst-chat-panel.test.ts) — rewrite

Selectors to migrate:

- `button.primary-btn` → `wrapper.get('[data-testid="analyst-send"]')`.
- `.tool-chip` → `wrapper.findAll('[data-testid="tool-chip"]')` against the shared `ToolChip`. Status assertions move from `chips[i].classes().toContain('tool-chip-ok')` to `chips[i].attributes('data-status')` (the shared chip exposes `data-status="pending|ok|error|orphan|missing"` per F03 r2 §7.2).
- Pending-tool chip rendering → `wrapper.findAll('[data-testid="tool-chip"][data-status="pending"]')`.
- Tool-result expansion → toggling the chip's header reveals a `[data-testid="formatted-content"]` block (from F05 r2 `<FormattedContent>` inside the chip body), not a raw `<CodeBlock>`.
- `saivage:focus-chat` dispatch test → unchanged: dispatch `window.dispatchEvent(new CustomEvent('saivage:focus-chat'))`, assert composer textarea is the active element.
- Read-only tooltip → `wrapper.get('[data-testid="analyst-send"]').attributes('title')` equals the read-only string when `activeSessionWritable === false`.
- Empty-state assertion → unchanged text query.
- Loading-history assertion → `getByText(/Loading history/)`.

New: a model-pill ellipsis test (long `modelSpec` produces a `<Pill>` whose visible text is ellipsised and whose `title` is the full string).

### 9.2 [`web/src/__tests__/analyst-chat-store.test.ts`](../../../web/src/__tests__/analyst-chat-store.test.ts) — fixtures + assertions

- Fixtures accept the additive `ChatMessage` fields (`provider`, `model`, `modelSpec`, `requestedModelSpec`).
- Pending-tool dedupe assertions remain covered as today.
- New unit test (or co-located `tool-chip-adapter.test.ts`): **`adaptPendingInvocationToToolChip emits status="pending" and result=null`** — calls the adapter with a fixture and asserts the resulting `ToolChipProps` matches the expected shape.
- New unit test: **`adaptChatMessageToToolChip emits status="missing" when result is null`** — asserts the pair lifecycle wiring.

### 9.3 [`web/src/__tests__/components/AnalystChatPanel.children.test.ts`](../../../web/src/__tests__/components/AnalystChatPanel.children.test.ts) — non-prefix sibling, separate

- `wrapper.find('.on-screen-children')` continues to work (layout-only class kept per F02 r2 §4.13). Optionally add `data-testid="on-screen-children"`.
- The three existing tests survive as-is.
- `aria-labelledby` semantics on `<h3 id="on-screen-title">` are unchanged.

### 9.4 [`web/src/__tests__/analyst-toaster.test.ts`](../../../web/src/__tests__/analyst-toaster.test.ts) — NOT touched by F04

F04 does **not** change toaster selectors; F01/F02 own the toaster cleanup.

### 9.5 Removed file

[`web/src/__tests__/analyst-chat-error-states.test.ts`](../../../web/src/__tests__/analyst-chat-error-states.test.ts) — does not exist. Error-state coverage stays in `analyst-chat-panel.test.ts`.

### 9.6 New tests added by F04

- `web/src/__tests__/jump-to-latest.test.ts`:
  - renders `bottom: calc(48px + 8px)` style when `bottomOffsetPx === 48`.
  - shows `${unseen} new` when `unseen > 0`, otherwise `Jump to latest`.
  - emits `jump` on click; applies `unseen` class when unseen > 0; carries `data-testid="jump-to-latest"`.
  - label remains ellipsis-safe under narrow widths.
- `web/src/__tests__/composables/useStickToBottom.test.ts`:
  - `stuck` flips false on scroll above threshold, true within threshold.
  - `markIncoming` bumps `unseen` only when not stuck; scrolls to bottom on `nextTick` when stuck.
  - `jumpToLatest` resets `unseen` to 0 and forces `stuck=true`.
- `web/src/__tests__/composables/useDebouncedConnectionState.test.ts`:
  - `offline → connected` is immediate.
  - `connected → connecting` is delayed 400 ms.
  - rapid re-flap cancellation behaves correctly.
- `web/src/__tests__/utils/analyst-timeline.test.ts`:
  - `pairAnalystMessages` matches `tool_call`/`tool_result` by `tool_call_id`.
  - emits `kind: 'tool_pair'` with `result: null` when only `tool_call` exists.
  - emits a synthesised pair with `status === 'orphan'` semantics when only a `tool_result` exists.
- F02 r2 already plans `conversation/ToolChip.test.ts` (status mapping). F04 does not duplicate it.

---

## 10. Alternative considered

### Alt A — Full ChatWindow port

Lift v2's `ChatWindow.vue` (≈675 lines) into v3 as the analyst panel.

Pros: byte-for-byte v2 visual parity; header, role tinting, chip, dots, jump-to-latest, inline auth in one file.

Cons (decisive):

- The v2 file owns its own WebSocket + auth composables. Duplicates `useWsStore`/`useRuntimeStore` state — a "parallel auth state machine".
- v2's full-window layout assumptions (`min(780px, 92%)`, `min(360px, 55vw)` chip) do not fit a 20–30 vw right rail.
- v3-only features (on-screen children, pending invocations, badges, read-only tooltip, focus-chat shortcut) would need splicing.
- Violates the project guideline (preserves v2 class structure rather than expressing through F02 primitives).

### Alt B — Decomposed right-rail (SELECTED)

Extract v2's behaviors and re-apply through F02 primitives + F03/F05 shared composites. v3-only features stay; v2 file is **not** imported.

Pros (decisive):

- One source of truth per behavior — `useWsStore`, `useRuntimeStore`, F02 primitives, F03/F05 `ToolChip`. No duplicate state, no bespoke chip.
- Small files per responsibility (`ChatHeader` ≈ 60 lines, `MessageList` ≈ 120 lines, `MessageItem` ≈ 80 lines, `JumpToLatest` ≈ 40 lines, `ChatComposer` ≈ 80 lines, two composables ≈ 30 lines each).
- Narrow-rail layout rules in §8 are easy to express against decomposed surfaces.

Cons: more files to land in one commit. Mitigated by the absence of intermediate states.

**Selected**: Alt B.

---

## 11. Cross-issue ordering & dependencies

### 11.1 Strict landing order

Per F03 r2 §8.2's binding decision:

1. **F01 r2 lands first** — tokens, semantic vars, base, patterns.
2. **F02 r2 lands second** — `ui/` primitives, `content/` renderers, and the conversation composites (`MessageBubble`, `ToolChip`, `ThinkingDots`).
3. **F05 r2 lands third** — unified `ToolPresentationView` types, `presentToolCall` / `presentToolResult`, `InlinePart`, `FormattedContent`, `JsonView`. F05 r2 lands before F03 r2 so F03's renderer code can import these directly (per F03 r2 §8.2: "F05 first is strictly better").
4. **F03 r2 lands fourth** — agent-surface timeline/rounds, AND the `AnalystChatPanel.vue` chip swap (see §11.2).
5. **F04 lands fifth (this issue)** — the analyst-surface decomposition (ChatHeader / MessageList / MessageItem / JumpToLatest / ChatComposer), composables, model-label utility, and the pairing utility `analyst-timeline.ts`.

### 11.2 The AnalystChatPanel chip swap lands WITH F03, not in F04 (binding decision)

F03 r2 §8.2 makes this decision binding and F04 r3 adopts it
without reservation:

> **F03's PR contains both (a) the new `ToolChip.vue` under
> `conversation/` and (b) the swap in `AnalystChatPanel.vue` from
> its in-line markup to that component.**

Concretely, **inside the F03 PR**:

- The current `<button class="tool-chip">…</button>` block in
  [AnalystChatPanel.vue#L36-L75](../../../web/src/components/chat/AnalystChatPanel.vue#L36-L75)
  is replaced by `<ToolChip v-bind="adaptChatMessageToToolChip(...)" />`.
- The scoped `.tool-chip*` block in
  [AnalystChatPanel.vue#L298-L347](../../../web/src/components/chat/AnalystChatPanel.vue#L298-L347)
  is deleted.
- The adapter file `tool-chip-adapter.ts` (§4.1) and the pairing
  utility `analyst-timeline.ts` (§3.4) are introduced in the same PR
  because the swap consumes them at the call site.
- The existing `analyst-chat-panel.test.ts` selectors are migrated
  to `[data-testid="tool-chip"]` + `data-status` in the same PR
  (per F03 r2 §8.2's note about migrating `.tool-chip` queries).

**Inside the F04 PR (this issue)**:

- Everything in §3 except the chip swap itself, which has already
  happened in the F03 PR. The `MessageItem.vue` produced by F04 wraps
  the same `<ToolChip v-bind="…">` call site that F03 introduced into
  the monolithic `AnalystChatPanel.vue`, just relocated into the
  decomposed component.
- Composer / header / jump-to-latest / message-list extraction.
- Composables (§5).
- Narrow-rail layout rules (§8).
- `ChatMessage` additive metadata (§7) and the model-label utility.
- Toaster left to F01/F02.

**Why with-F03 instead of "in F04" or "either order after F02/F05"**:

- The project guideline forbids two chip renderers at HEAD. If F03 lands and F04 lags, the agent surface uses `ToolChip.vue` while the analyst surface still uses local `tool-chip*` markup — two chip implementations exist for an indeterminate window. r2's "F03 r1 and F04 r2 can land in any order" is **withdrawn**.
- The swap is mechanically tiny (replace one markup block; delete one scoped CSS block; introduce two small modules). It does **not** require F04's larger changes (composer, badges, header, jump-to-latest), so it is correctly attached to the F03 PR.
- The chip is a shared API surface across F03 and F04. Sharing means one renderer is added in the same PR that defines the API, not a follow-on PR.

### 11.3 Dependency graph (terse)

```
F01 r2 ─► F02 r2 ─► F05 r2 ─► F03 r2 ─► F04 (this issue)
                                       │
                                       └── F03 r2's PR also ships the
                                           AnalystChatPanel chip swap
                                           (§11.2) so HEAD never has
                                           two chip renderers.
```

### 11.4 `ChatMessage` additive metadata timing

The `ChatMessage` contract addition (§7.2) is a server-side commit that can ship in the F04 PR or one ahead. Until it ships, the model chip degrades to "not rendered" — no broken UI. The reviewer's clean-architecture axis is satisfied because the absence of the field is the expected steady state until the server stamps it.

---

## 12. Non-goals

- **No replay-protocol redesign** of the analyst WebSocket. `useWsStore` + `useAnalystChat` plumbing is reused; F04 only reads their refs.
- **No `ChatWindow.vue` migration** from v2.
- **No `useWebSocket` / `useAuthState` port** from v2.
- **No new auth composable.**
- **No `requestedModelSpec` UI** in this round.
- **No `.tool-chip-pending` global pattern class.**
- **No chat-local chip API.** F04 consumes F03 r2 §7.2's shared `ToolChip` (`call: ToolCallPresentation`, `result: ToolResultPresentation | null`, `status: ToolPairStatus`, `expanded`, `detailsId`, `timestamp?`) verbatim. Adapters in §4.1 produce that exact prop bag; the render sites use `v-bind="…"`.
- **No chat-local `:view` prop, no chat-local `:message` prop.** The prior r2 `:view` formulation is dropped — F03 r2's contract is authoritative.
- **No inline v2-style token input.** Inline auth uses `<UnauthorizedNotice>` triggering the existing [`ApiTokenEntry.vue`](../../../web/src/components/auth/ApiTokenEntry.vue) modal.
- **No `analyst-chat-error-states.test.ts`.**
- **No toaster changes.**
- **No store data-shape changes** beyond consuming the four optional `ChatMessage` fields.
- **No F03 round/timeline structure on the analyst surface.** The analyst panel uses a flat `AnalystTimelineItem` model (`message` or `tool_pair`); round grouping is F03's agents-view concern only.
- **No AnalystChatPanel chip swap in the F04 PR.** Per §11.2, the swap ships inside the F03 PR. F04 inherits a HEAD that already renders the shared `<ToolChip>` and only relocates the call site into `MessageItem.vue`.
- **No "either order after F02/F05" for F03/F04.** Strict order is F01 → F02 → F05 → F03 (with chip swap) → F04 (per §11.1).
