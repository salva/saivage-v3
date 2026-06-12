# F04 — Chat / analyst surface style — Functional analysis (r1)

Writer round 1. Pre-review. Bound by the workspace project guideline:
architecture-first, no backward compatibility, actively remove
legacy structure rather than preserve it.

Companion files:
[F04-chat-surface-style.md](../F04-chat-surface-style.md),
[00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md),
[F01-design-tokens.md](../F01-design-tokens.md),
[F02-component-hierarchy.md](../F02-component-hierarchy.md),
[F03-conversation-rounds.md](../F03-conversation-rounds.md),
[F05-tool-detail-rendering.md](../F05-tool-detail-rendering.md).

Scope: the right-rail analyst surface of v3
([web/src/components/chat/AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue)),
its store
([web/src/stores/analystChat.ts](../../../web/src/stores/analystChat.ts)),
its toaster
([web/src/components/chat/AnalystToaster.vue](../../../web/src/components/chat/AnalystToaster.vue)),
and the connection/auth wiring it depends on
([web/src/stores/ws.ts](../../../web/src/stores/ws.ts),
[web/src/stores/runtime.ts](../../../web/src/stores/runtime.ts)).
The reference is v2's
[saivage/web/src/components/ChatWindow.vue](../../../../saivage/web/src/components/ChatWindow.vue)
together with its composables
[useWebSocket.ts](../../../../saivage/web/src/composables/useWebSocket.ts)
and
[useAuthState.ts](../../../../saivage/web/src/composables/useAuthState.ts).

---

## 1. v2 behavior reference (`ChatWindow.vue`, 675 lines)

The v2 component is a single full-window chat surface; we lift its
behaviors and visual idioms, not the file itself. Inventory:

### 1.1 Header strip

- Two-line title block: panel title (`Command Stream`) + monospaced
  short session id (`sessionId.slice(0, 14)` or `new session`).
  Reference: [ChatWindow.vue lines 56–67](../../../../saivage/web/src/components/ChatWindow.vue#L56-L67).
- Right side connection chip: one of four lucide icons —
  `Wifi` (connected), `WifiOff` (offline), `ShieldAlert`
  (unauthorized), `Loader2` with `.spin` (connecting).
  Reference: [ChatWindow.vue lines 240–248](../../../../saivage/web/src/components/ChatWindow.vue#L240-L248).
- The chip's text label is also state-driven
  (`connected` / `connecting…` / `offline` / `unauthorized`).

### 1.2 Debounced visible connection status

- `displayStatus` mirrors `status` from `useWebSocket`, but
  transitions **away from `open`** are delayed 400 ms via a single
  `setTimeout`; transitions **to `open`** are immediate. This
  suppresses strobing during reconnect storms.
  Reference: [ChatWindow.vue lines 45–60](../../../../saivage/web/src/components/ChatWindow.vue#L45-L60).
- The timer is cleared on `onUnmounted`.

### 1.3 Role-tinted bubbles

- Each `<article class="msg" :class="msg.role">` carries one of three
  tones via patterns in v2's CSS layer (`entry-user`, default,
  `entry-warn` for `system`). Tones are token-driven
  (`--entry-{user,warn,danger}-{bg,border}`).
  Reference: [ChatWindow.vue lines 459–488](../../../../saivage/web/src/components/ChatWindow.vue#L459-L488).
- User bubbles right-align (`margin-left: auto`); system bubbles
  centre-align with wider max-width.

### 1.4 Assistant model chip

- Only assistant messages render a chip. Two derivations:
  - `modelLabel(msg)` returns `modelSpec` if present, else
    `provider/model`, else empty.
  - `shortModelLabel(msg)` strips everything before the last `/` so
    the chip stays short; the full string lives in the `title`
    attribute for hover discovery.
  Reference: [ChatWindow.vue lines 219–230](../../../../saivage/web/src/components/ChatWindow.vue#L219-L230).
- `requestedModelSpec` exists on the v2 type and feeds the v2
  "ambient" suppression elsewhere — when an assistant reply was
  served via a fallback model, that delta is surfaced. v3 has no
  equivalent today.

### 1.5 Thinking dots

- A trailing `compact` assistant article rendered while
  `thinking === true`, containing three dots animating via
  `dot-pulse`. The flag flips on a `thinking` WS event and clears on
  the next `message`/`system`/`event`.
  Reference: [ChatWindow.vue lines 89–93, 481–485](../../../../saivage/web/src/components/ChatWindow.vue#L89-L93).

### 1.6 Jump-to-latest float with unseen counter

- `stickToBottom` is true while the user is within 60 px of the
  bottom; on scroll it flips false. Every incoming message that
  arrives while `stickToBottom === false` bumps `unseenCount`. A
  floating button appears when not stuck; clicking it forces scroll
  and resets the counter.
  Reference: [ChatWindow.vue lines 175–202, 494–504](../../../../saivage/web/src/components/ChatWindow.vue#L175-L202).
- Two visual states: plain pill, and `.unseen` pill (accent border
  + `N new` label).

### 1.7 Inline auth panel

- When `unauthorized.value` is true, an inline warn-tinted card
  appears **above** the message list with a `KeyRound` icon, a
  short explanation, and a password input + Connect button to set
  the token.
  Reference: [ChatWindow.vue lines 254–276](../../../../saivage/web/src/components/ChatWindow.vue#L254-L276).
- This is *additional* to any global banner: it gives the operator
  an affordance right where they are typing.

### 1.8 Resize-to-content composer

- The textarea starts at `rows="1"` and resizes via `resizeInput()`:
  set `height: auto`, read `scrollHeight`, cap at `8 * 20 + 12` px.
  Triggered on every `input` event and on mount.
  Reference: [ChatWindow.vue lines 161–172](../../../../saivage/web/src/components/ChatWindow.vue#L161-L172).

### 1.9 Enter / Shift+Enter discipline

- `Enter` sends. `Shift+Enter`, `Ctrl+Enter`, `Meta+Enter`, and
  `isComposing` inputs (IME) insert a newline instead. Send button
  shows `<SendHorizontal>` + the word `Send`.
  Reference: [ChatWindow.vue lines 150–158](../../../../saivage/web/src/components/ChatWindow.vue#L150-L158).

### 1.10 Markdown rendering

- Assistant bubbles render through `renderMarkdown(msg.content)`
  with `v-html`. User and system bubbles render as plain text with
  `white-space: pre-wrap`. v3 already has `MarkdownText` (and F02
  relocates it to `ui/`).

### 1.11 History fetch on session change

- The first WS `session` event triggers
  `GET /api/chats/${sid}` and seeds `messages` if empty; subsequent
  reconnect-session events do **not** clobber existing on-screen
  messages.
  Reference: [ChatWindow.vue lines 72–87, 117–138](../../../../saivage/web/src/components/ChatWindow.vue#L72-L138).

---

## 2. v3 baseline (`AnalystChatPanel.vue`)

What v3 already does, taken from
[AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue)
and [stores/analystChat.ts](../../../web/src/stores/analystChat.ts):

### 2.1 Implemented

- **Composer**: `<textarea rows="3">`, Enter-to-send /
  Shift+Enter-newline already in
  `handleComposerKeydown`. Disable state derives from
  `activeSessionWritable`.
- **Send pipeline**: `chat.sendMessage()` posts the draft and
  refocuses the composer afterwards.
- **Timeline rendering**: a flat `timelineItems` array sorted by
  timestamp, with three `kind`s — plain `message`, `tool_call`,
  `tool_result`. Tool entries collapse/expand a `CodeBlock`.
- **Tool chip presenter**: already routes through
  `presentToolCall`/`presentToolResult` from
  [utils/tool-presenters.ts](../../../web/src/utils/tool-presenters.ts);
  this is the F05 surface and must continue to work after the port.
- **Pending tool invocations** for the active session: rendered as
  their own `article.message-row.pending-tool` rows. Mechanism is
  v3-only and **must be preserved**.
- **Message badges**: per-message badge list keyed off
  `messageBadges` from the store. **Must be preserved**.
- **On-screen children section**: renders
  `cards.childrenOf(workspaceRoute.entityId)` while the user is on
  the cards view. v3-only context-awareness; **must be preserved**.
- **Focus-chat global shortcut**:
  `window.addEventListener('saivage:focus-chat', …)` already in
  `onMounted`, dispatched from
  [AppShell.vue line 131](../../../web/src/components/layout/AppShell.vue#L131)
  and from
  [cards/CardDetailView.vue lines 491, 497](../../../web/src/components/cards/CardDetailView.vue#L491).
- **Error / loading panels**: `sessionsLoading`, `messagesLoading`,
  `messagesError` (with `kind === 'unauthorized'` branch),
  `sendError`. **Must be preserved**.
- **Read-only tooltip** when `activeSessionWritable` is false.
  **Must be preserved**.

### 2.2 Hard-coded styling

- Hex literals (`#0d1117`, `#161b22`, `#30363d`, `#1f2937`, `#58a6ff`,
  `#7ee787`, `#d2a8ff`, `#f85149`, `#ffa198`, `#79c0ff`, `#c9d1d9`,
  `#f0f6fc`, `#8b949e`, `#ff7b72`) appear throughout the scoped
  style block; every one is removed under F01/F02.
- Duplicate `.primary-btn` and `.tool-chip-*` rules — the second
  occurrence of `.primary-btn` overrides the first
  ([AnalystChatPanel.vue line 252 vs near the bottom](../../../web/src/components/chat/AnalystChatPanel.vue#L252)).

### 2.3 Features absent in v3

See §3. Net effect: v3's right-rail today is a functional list with
no header strip, no role tinting, no thinking indicator, no
jump-to-latest, no model chip, no inline auth affordance.

---

## 3. Differences / regressions (v2 → v3)

| Feature | v2 | v3 today | Severity | Where it should live |
|---|---|---|---|---|
| Header strip with session id | yes | no | medium | `chat/ChatHeader.vue` |
| Connection chip (Wifi/WifiOff/ShieldAlert/Loader2) | yes | no | medium | `chat/ChatHeader.vue` + F02 `<StatusDot>`/`<Pill>` |
| Debounced visible status (400 ms) | yes | n/a (no chip) | medium | `composables/useDebouncedConnectionState.ts` |
| Role-tinted bubbles (`entry-user`, `entry-warn`, `entry-danger`) | yes | only `role-user` background | medium | F02 `<MessageBubble role tone>` + patterns.css |
| Assistant model chip (short label + title-long) | yes | absent | medium | `chat/MessageItem.vue` + F02 `<Pill>`; needs contract change (§6) |
| Thinking dots | yes | absent | medium | F02 `<ThinkingDots>` used by `MessageList` footer |
| Jump-to-latest float + unseen counter | yes | absent | medium | `chat/JumpToLatest.vue` + scroll composable |
| Inline unauthorized panel | yes | absent (relies on global banner) | low/medium | `chat/ChatHeader.vue` slot for state panel |
| Resize-to-content composer | yes | no — `rows="3"` static + `resize: vertical` | low | `chat/ChatComposer.vue` |
| Enter / Shift+Enter discipline | yes | yes | n/a | (preserve) |
| IME (`isComposing`) guard | yes | no | low | `chat/ChatComposer.vue` |
| Send button labelled with icon + text | yes | text only | low | `chat/ChatComposer.vue` + F02 `<Button>` |
| Empty-state copy block | yes | only "No messages yet." | low | `chat/MessageList.vue` |
| History fetch on first session id | yes | `chat.fetchMessages()` on mount + reactive refetch | n/a | (preserve, no port) |
| Auto-scroll stickiness | yes | absent | medium | `chat/MessageList.vue` + `composables/useStickToBottom.ts` |
| Markdown rendering in assistant bubbles | yes | partial (only via custom path) | low | F02 relocated `<MarkdownText>` used inside `<MessageBubble>` for assistant role |
| Pending-tool footer (v3-only) | n/a | yes | n/a | **preserve** — rendered by `MessageList.vue` after timeline |
| On-screen children section (v3-only) | n/a | yes | n/a | **preserve** — separate composite, see §4.7 |
| Per-message badges (v3-only) | n/a | yes | n/a | **preserve** — `MessageItem.vue` |

"Half-implemented" status from the issue file is consistent with
this table: every line marked `medium` is feature loss vs v2; every
`preserve` line is feature gain v3 must not lose.

---

## 4. Target component decomposition

The current panel is one ~440-line SFC that owns layout, state
plumbing, chip rendering, and styling. After the port the container
becomes pure layout (no styling, no presenter logic) and delegates
to per-surface composites under `web/src/components/chat/`. These
composites consume F02 primitives — they do **not** redefine any of
the visual idioms F02 owns.

```
chat/AnalystChatPanel.vue           ← container; pure layout, store wiring
├── chat/ChatHeader.vue             ← session label, connection chip, inline auth slot
├── chat/MessageList.vue            ← scroll body; renders timeline + pending + thinking
│   └── chat/MessageItem.vue        ← single timeline row (bubble OR tool chip)
│       ├── ui/MessageBubble.vue    ← F02 primitive (role + tone)
│       ├── ui/ToolChip.vue         ← F02 primitive (shared with AgentConversationView)
│       └── ui/Pill.vue             ← model chip
├── chat/JumpToLatest.vue           ← floating pill, unseen counter
└── chat/ChatComposer.vue           ← textarea, send button, read-only tooltip
```

### 4.1 `AnalystChatPanel.vue` (after)

Sole job: bind store refs, register the `saivage:focus-chat`
listener, render the four composites in order, hand each composite
the slice of state it owns. No `<style scoped>` beyond grid layout.

Sketch:

```vue
<template>
  <aside id="analyst-chat-panel" class="analyst-chat-panel" role="region" aria-label="Analyst chat">
    <ChatHeader
      :session-id="activeSessionId"
      :connection-state="debouncedConnectionState"
      :unauthorized="unauthorized"
    >
      <template #state>
        <UnauthorizedNotice v-if="unauthorized" />
        <ChatErrorPanel v-else-if="messagesError" :error="messagesError" />
      </template>
    </ChatHeader>

    <MessageList
      :items="timelineItems"
      :pending-tools="pendingToolInvocationsForActiveSession"
      :badges="messageBadges"
      :thinking="thinking"
      :on-screen-children="childrenOnScreen"
      @stickiness-change="onStickinessChange"
    />

    <JumpToLatest
      v-if="!stuckToBottom"
      :unseen="unseenCount"
      @jump="jumpToLatest"
    />

    <ChatComposer
      ref="composerRef"
      v-model:draft="draft"
      :disabled="!activeSessionWritable"
      :sending="sending"
      :tooltip="composerTitle"
      @submit="submitMessage"
    />
  </aside>
</template>
```

### 4.2 `chat/ChatHeader.vue`

- Props: `{ sessionId: string | null; connectionState:
  WsConnectionState; unauthorized: boolean }`.
- Slots: `state` — for inline auth / error panels rendered below
  the header strip but inside its visual container.
- Internally uses F02 `<PanelHeading>` for the strip, F02
  `<StatusDot tone>` and `<Pill tone>` for the chip. Icon choice is
  derived from `connectionState`:

  ```ts
  function chipIcon(s: WsConnectionState, u: boolean) {
    if (u || s === 'unauthorized' || s === 'no-token') return 'ShieldAlert';
    if (s === 'connecting') return 'Loader2';   // spinning
    if (s === 'connected')  return 'Wifi';
    return 'WifiOff';
  }
  ```

- The chip's tone maps `connected → ok`, `connecting → muted`,
  `unauthorized/no-token → warn`, anything else → `danger`.
- Session label: `sessionId ? sessionId.slice(0, 14) : 'new session'`.
- No bespoke styles. The pill, dot, and panel heading are F02
  primitives.

### 4.3 `chat/MessageList.vue`

- Props: `{ items: ChatMessage[]; pendingTools:
  PendingToolInvocation[]; badges: Record<string, MessageBadge[]>;
  thinking: boolean; onScreenChildren: CardRecord[] }`.
- Emits: `stickiness-change(stuck: boolean, unseenDelta: number)`.
- Owns: the scroll container, the `useStickToBottom` composable,
  the on-screen-children section (v3-only, placed at the top of
  the scroll body so it scrolls with history), the thinking footer
  (one `<ThinkingDots>` when `thinking === true`), and the
  pending-tool block (placed after the timeline, before the bottom
  edge).
- Iterates `items` and delegates each row to `MessageItem`.

### 4.4 `chat/MessageItem.vue`

- Props: `{ item: ChatMessage; badges: MessageBadge[] | undefined }`.
- Branches on `item.kind`:
  - `tool_call` / `tool_result` → renders F02
    `<ToolChip :message="item" />` (one component for both
    surfaces; presenter wiring stays in `tool-presenters`).
  - default → renders F02 `<MessageBubble :role="item.role"
    :tone="bubbleTone(item)">` containing either `<MarkdownText
    :source="item.content" />` (assistant) or `{{ item.content }}`
    inside `<pre>` style (user/system). When
    `item.role === 'assistant'` and `item.modelSpec` is non-empty
    (see §6) the bubble's `meta` slot renders a `<Pill>` with the
    short label and the long string in `title`.
- Emits `toggle(id)` to the parent so the parent owns the
  `expandedIds` set (kept across re-renders, no per-item state).
- Renders the badges block below the bubble using F02 `<Pill
  tone="accent">` per badge.

### 4.5 `chat/JumpToLatest.vue`

- Props: `{ unseen: number }`. Emits: `jump()`.
- Renders a single absolutely-positioned `<button>` with an
  `ArrowDown` icon and a label that switches between `Jump to
  latest` and `${unseen} new`. Visual states are two patterns in
  F01/F02 (`pill` + `pill-accent` when `unseen > 0`); no scoped
  hex.

### 4.6 `chat/ChatComposer.vue`

- Props: `{ draft: string; disabled: boolean; sending: boolean;
  tooltip: string }`. Two-way binds `draft` via `v-model:draft`.
  Emits: `submit()`.
- Owns: the `<textarea>` with resize-to-content (port v2's
  `resizeInput` — set height auto, read scrollHeight, cap), the
  `keydown` handler with the Enter/Shift+Enter/Ctrl+Enter/IME
  matrix from v2, and the Send F02 `<Button variant="primary">`
  with `SendHorizontal` icon + `Send` label.
- Exposes `focus()` via `defineExpose` so the container can wire
  the `saivage:focus-chat` shortcut.

### 4.7 On-screen children — keep, do not extract

The v3-only on-screen-children section is currently inlined in the
panel template. Move it **into** `MessageList.vue` as the first
child of the scroll body (`<aside class="on-screen-section">`).
Rendered only when `onScreenChildren.length > 0`. It uses the
existing list markup but consumes F02 tokens (no `#0d1117`
literal). This intentionally avoids a separate file: it is a tiny
sticky context block, not a reusable composite.

---

## 5. Connection / auth status wiring

### 5.1 Source of truth

- v3 already has `useWsStore` with a typed `connectionState:
  WsConnectionState` (`'connected' | 'connecting' | 'offline' |
  'unauthorized' | 'no-token'`,
  [api/types.ts](../../../web/src/api/types.ts) and
  [stores/ws.ts](../../../web/src/stores/ws.ts)).
- v3 also exposes `unauthorized: ref(false)` on
  [stores/runtime.ts](../../../web/src/stores/runtime.ts) and a
  composed `liveUpdateState` that already merges
  `getAuthToken() === null` with WS state.
- v2's `useAuthState().unauthorized` has no direct counterpart, but
  the combination `ws.connectionState === 'unauthorized' ||
  ws.connectionState === 'no-token' || runtime.unauthorized` is
  semantically equivalent.

**Decision**: do **not** add a new auth composable. Derive a single
boolean `unauthorized = ws.connectionState === 'unauthorized' ||
ws.connectionState === 'no-token' || runtime.unauthorized` directly
in `AnalystChatPanel.vue` and pass it to `ChatHeader`. `runtime.unauthorized`
becomes the source of truth for any "API rejected our token" signal
the rest of the app already raises; the chip only needs to read the
WS state.

### 5.2 Debounce

- v2 debounces only on transitions *away from* `open`. This is
  asymmetric and intentional — recovery should feel immediate,
  flapping should be hidden.
- Add a single composable
  `web/src/composables/useDebouncedConnectionState.ts` returning
  `{ debounced: Ref<WsConnectionState> }`. Implementation: watch
  the source, on `connected` set immediately, otherwise schedule a
  `setTimeout(400)` and replace any pending timer.
- The unit of debounce is the `WsConnectionState`, not the v2
  `WsStatus` string — there is no `open`/`closed` distinction in
  v3, so the composable maps `connected ⇒ immediate`, everything
  else ⇒ delayed.

### 5.3 Inline auth panel

- When `unauthorized === true`, `ChatHeader.vue` renders an inline
  warn-tinted card via its `state` slot, populated by
  `UnauthorizedNotice.vue` (small new sibling — three lines of
  text + an Open token entry button that dispatches an event the
  existing `ApiTokenEntry` modal already listens to).
- The existing global banner is *not* removed; both can be visible
  simultaneously and v2 does the same.

---

## 6. Model chip — contract gap

### 6.1 What v3 carries today

[api/types.ts ChatMessage](../../../web/src/api/types.ts#L694-L704):

```ts
export interface ChatMessage {
  id: string;
  session_id: string;
  role: MessageRole;
  kind: MessageKind;
  content: string;
  tool?: string;
  tool_call_id?: string;
  timestamp: string;
  links?: EntityLink[];
}
```

No `provider`, no `model`, no `modelSpec`, no `requestedModelSpec`.
v2's `Message` carries all four. The chip cannot be rendered.

### 6.2 Where the data lives on the server

The analyst chat REST endpoint is `GET /api/chats/:sessionId`,
served by Saivage's chat router; the persisted messages already
record provider/model in the analyst session log. The router
projects them out today.

### 6.3 Proposed contract change

Add four optional fields to `ChatMessage` in
[api/types.ts](../../../web/src/api/types.ts):

```ts
export interface ChatMessage {
  // …existing…
  provider?: string;
  model?: string;
  modelSpec?: string;
  requestedModelSpec?: string;
}
```

…and surface them in `GET /api/chats/:sessionId` and the WS
`message` envelope. The store's `fetchMessages()`
([stores/analystChat.ts line 195](../../../web/src/stores/analystChat.ts#L195))
already shapes the response into typed `ChatMessage` records; the
addition is purely additive on both wire and store.

If the server already emits these fields the change is type-only.
If not, the back-end stub is one line per field in the response
mapper. Either way the chip falls back to **not rendering** when
`modelSpec`/`provider`/`model` are absent — no broken UI.

### 6.4 `shortModelLabel` placement

`shortModelLabel(message: ChatMessage)` is a pure function — moves
to `web/src/utils/model-label.ts` and is consumed by
`MessageItem.vue`. v2's logic ports verbatim (slash split).

`requestedModelSpec` enables an "ambient suppression" affordance
v3 does not need yet; mark as future work (see §10).

---

## 7. Auto-scroll behaviour

### 7.1 Stickiness composable

New: `web/src/composables/useStickToBottom.ts`.

- Input: a ref to the scroll container (`HTMLElement | null`) and
  a sentinel threshold (default 60 px, matching v2).
- State: `stuck: Ref<boolean>`, `unseen: Ref<number>`.
- API:

  ```ts
  const { stuck, unseen, onScroll, markIncoming, jumpToLatest } =
    useStickToBottom(elRef);
  ```

  - `onScroll()` reads `scrollHeight - scrollTop - clientHeight`
    and updates `stuck`. If `stuck` flips true, resets `unseen` to
    0.
  - `markIncoming()` is called by the parent when a new timeline
    item lands; bumps `unseen` if not stuck, scrolls if stuck.
  - `jumpToLatest()` forces `stuck = true`, scrolls to bottom on
    `nextTick`, resets `unseen`.

This composable also powers (eventually) the agents surface; here
we only wire it into the chat. It must call `nextTick` before
mutating `scrollTop` because new DOM rows have not yet flushed
when the watcher fires.

### 7.2 Focus-chat shortcut — already wired

[AnalystChatPanel.vue lines 222–232](../../../web/src/components/chat/AnalystChatPanel.vue#L222-L232)
registers `saivage:focus-chat`. After the port the listener moves
to the new container and forwards `focus()` to the
`ChatComposer.vue` ref. The dispatchers at
[AppShell.vue line 131](../../../web/src/components/layout/AppShell.vue#L131)
and
[CardDetailView.vue line 491](../../../web/src/components/cards/CardDetailView.vue#L491)
keep working unchanged.

---

## 8. Tool chip integration

- `MessageItem.vue` delegates `tool_call` / `tool_result` rendering
  to F02's `<ToolChip>` (defined in
  [F05](../F05-tool-detail-rendering.md) but exposed via the F02
  primitive layer). The chip is one component used by both the
  analyst panel and the agents view — see
  [F02 §1.3](../F02-component-hierarchy/01-analysis-r1.md).
- The unified view model is the one F03 defines: the panel hands
  the chip a `ChatMessage` (whose `kind` and `tool` already match
  F05's input). The chip's `expanded` state is owned by the panel
  via the existing `expandedIds: Set<string>` (kept).
- The pending-tool block (v3-only) consumes the same
  `<ToolChip>` in a `status="pending"` mode. Patterns.css under
  F01 needs a `.tool-chip-pending` rule; today's bespoke
  `.pending-tool-{main,meta,tag}` classes are deleted.

---

## 9. Risks

### 9.1 Narrow right rail vs v2's full window

- The analyst chat panel is the right rail of
  [AppShell.vue](../../../web/src/components/layout/AppShell.vue)
  — a column ~20–30 vw wide depending on viewport. v2's
  `ChatWindow.vue` is centred in a full-window dashboard
  (`width: min(780px, 92%)` for bubbles, `min(360px, 55vw)` for
  the model chip).
- The port must scale every horizontal constraint to the rail:
  - Bubbles: `width: 100%`; remove v2's `min(780px, 92%)`.
  - Model chip: `max-width: 100%; text-overflow: ellipsis`. Already
    handled by F02 `<Pill>` but worth pinning the test.
  - Tool chip headlines: stay single-line ellipsis. Today's
    `tool-chip-headline { white-space: nowrap; text-overflow:
    ellipsis }` rule moves to patterns.css.
  - Composer textarea: `min-width: 0` on the grid cell so
    `scrollHeight` reads do not jump.

### 9.2 Resize-to-content vs `resize: vertical`

- v3's composer currently has `resize: vertical` (CSS handle).
  Replacing with v2's `scrollHeight`-driven height means the user
  loses the handle. Acceptable — auto-resize is the v2 behavior
  the issue explicitly asks for. Cap at 172 px so the rail does
  not collapse the message list.

### 9.3 Test rewrites

- [web/src/__tests__/analyst-chat-panel.test.ts](../../../web/src/__tests__/analyst-chat-panel.test.ts)
  contains selectors like `.tool-chip`, `.message-bubble`,
  `.primary-btn`, `.pending-tool` and a test for
  `saivage:focus-chat`. After the port:
  - `.tool-chip` continues to exist (now from F02 patterns.css).
  - `.message-bubble` becomes a class on F02 `<MessageBubble>`.
  - `.primary-btn` becomes `.btn.btn-primary`.
  - `.pending-tool` becomes `.tool-chip.tool-chip-pending`.
  - `saivage:focus-chat` test continues to pass; the listener
    lives on the container, the focus call hits the
    `ChatComposer` ref.
- Sibling tests likely affected (grep selectors):
  `analyst-chat-error-states.test.ts`,
  `analyst-toaster.test.ts` (probably untouched if the toaster
  itself is left alone in this issue).
- These rewrites are part of the F04 implementation work, not a
  separate ticket.

### 9.4 Removal scope

- Per the workspace guideline, **delete** every existing
  `.message-bubble`, `.tool-chip*`, `.primary-btn`, `.subtle`,
  `.on-screen-section`, `.composer-*`, `.pending-tool*`,
  `.message-badges`, `.state-panel` rule from
  [AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue).
  Do not leave an aliased legacy block. Components reach 100 %
  through F02 primitives + patterns.css.

### 9.5 AnalystToaster

- [chat/AnalystToaster.vue](../../../web/src/components/chat/AnalystToaster.vue)
  also has bespoke hex literals but is **out of scope here** —
  it has no role-tinted-bubble equivalent and is folded into the
  cross-cutting F01 cleanup. F04 touches it only if a shared
  class moves; otherwise it is renamed/restyled under F01 in the
  same pass.

---

## 10. Non-goals

- No replay-protocol redesign of the analyst WebSocket. The
  existing `useWsStore` + `useAnalystChat` plumbing is reused
  as-is; F04 consumes their refs, it does not refactor them.
- No migration of v2's `ChatWindow.vue` into v3 — we extract the
  behaviors (debounce, jump-to-latest, model chip, thinking dots,
  inline auth) and re-apply them through F02 primitives. The v2
  file stays in the v2 repo.
- No "ambient model" / `requestedModelSpec` divergence affordance.
  The field is reserved in the contract addition (§6.3) for a
  future round; v3 carries no operator workflow that needs it yet.
- No reuse of v2's `useWebSocket` / `useAuthState` composables.
  v3 has its own equivalents and `runtime.unauthorized`; bringing
  the v2 modules across is forbidden by the no-backward-compat
  rule.
- No change to `analystChat` store data shapes beyond consuming
  the four added `ChatMessage` fields (§6).
- No change to F03's round/timeline structure for this surface —
  the analyst panel renders a flat timeline by design. F03 owns
  the agents-view round grouping; F04 stays flat.

---

## Open questions for reviewer

1. Should the inline `UnauthorizedNotice` re-use the existing
   `ApiTokenEntry` modal trigger, or render its own minimal input
   inline as v2 does? v2 chose inline; v3 has a richer modal —
   pick one.
2. Is the on-screen-children section visible while
   `messagesLoading === true`, or only when the timeline has
   loaded? Today it is always rendered; v2 has no equivalent so
   no precedent.
3. Should `requestedModelSpec` be part of this round's contract
   change, or deferred to a follow-up? Adding it now is one extra
   string field on the wire.
4. Confirm that `MessageBubble` is the right F02 primitive name
   (vs `<Bubble>`, `<MessageRow>`) — F02's analysis names it
   `MessageBubble` but a final check is owed before this surface
   commits to that import path.
