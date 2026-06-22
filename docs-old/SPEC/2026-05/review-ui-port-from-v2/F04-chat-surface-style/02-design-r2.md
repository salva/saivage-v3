# F04 — Chat / analyst surface style — Design (r2)

Writer round 2. Binds to the approved analysis
[01-analysis-r3.md](01-analysis-r3.md). Cross-issue binding:
[F01 r2](../F01-design-tokens/01-analysis-r2.md),
[F02 r2](../F02-component-hierarchy/01-analysis-r2.md),
[F03 r2 (design)](../F03-conversation-rounds/02-design-r2.md),
[F05 r2](../F05-tool-detail-rendering/01-analysis-r2.md).

Project guideline (binding): **architecture-first, no backward
compatibility**. No fallback styles, no `.tool-chip*` survivors, no
adapter shims, no parallel auth/WS state machine, no `:view` /
`:message` chat-local chip API. The `AnalystChatPanel` chip swap
lands inside the F03 PR (per F03 r2 §8.2 and F04 r3 §11.2); F04 owns
the chat-surface decomposition, layout, composables, and styling.

---

## 0. Required-changes coverage map (r1 → r2)

The binding critique
[02-design-review-r1.md](02-design-review-r1.md) issued three
blocking items, one required-correction, and four pass-with-polish
remarks. r2 addresses them as follows:

| # | Reviewer item | Resolution in r2 |
| - | ------------- | ---------------- |
| **B1** | r1's skeleton destructures `thinking` from `useAnalystChat`, but the live store does not expose `thinking`. r1 also imports `PendingToolInvocation` from `api/types`, but the type is private to `stores/analystChat.ts`. | §1.1 (file layout) promotes `PendingToolInvocation` to `web/src/api/types.ts`. §1.2 (container) removes the bogus `thinking` destructure and computes a local `thinking` ref as `sending || pendingToolInvocationsForActiveSession.length > 0`. §1.4 keeps the prop on `MessageList`; §1.13 adds a unit case. No store extension. |
| **B2** | r1's `MessageItem.vue` renders the model `<Pill>` from `shortModelLabel(msg)` alone, bypassing `modelLabel(msg, defaultModelSpec)` — so the chip would show even when spec equals the default. | §1.5 rewrites the bubble's `meta` slot: it computes `const fullLabel = modelLabel(item.message, defaultModelSpec)` and renders the `<Pill>` **only when `fullLabel !== null`**. `shortModelLabel(item.message)` is used only for the visible text. §1.11 updates `model-label.ts` correspondingly; §1.13 adds the matching test cases. |
| **B3** | r1's pending-footer resize does not emit `0` when the section unmounts (i.e. `pendingTools.length` drops to `0`); `--chat-jump-bottom` stays stale. | §1.4 (`MessageList.vue`) rewrites the footer-resize wiring to (a) emit `0` immediately whenever `pendingTools.length === 0` via a `watch`, and (b) emit `0` from the element watcher's cleanup when the previous element disappears. §1.13 adds an explicit unit case. |
| **C1** | r1's children-test inventory missed that `AnalystChatPanel.children.test.ts` carries a raw-source guard for the `useCardStore` import path. r1 was also inconsistent on `.on-screen-children` (`data-testid` vs class). | §1.13 names the raw-source guard test explicitly and rewrites it to target the new container `chat/AnalystChatPanel.vue`. r2 picks the single contract: keep the layout class `.on-screen-children` on the on-screen card element (so the live class selector `.on-screen-children li` continues to work), **and** add a stable `data-testid="on-screen-children"` for new tests. No selector is removed. |
| **P1** | r1's `ChatHeader.unauthorized` prop was passed but never read. | §1.3 removes the prop from `ChatHeader.vue`. The container still conditions the slot content on `unauthorized` (v-if on `<UnauthorizedNotice>`); `ChatHeader` does not need to know about it. |
| **P2** | `useDebouncedConnectionState(source)` should accept a `Readonly<Ref<…>>` to match the live `useWsStore().connectionState` shape. | §1.9 widens the parameter to `Readonly<Ref<WsConnectionState>> \| Ref<WsConnectionState>`. |
| **P3** | F03 r2's `<ToolChip>` prop bag is **eight props**, not six — it now includes `callContent: string` and `resultContent: string \| null` so the expanded body can mount `<FormattedContent :content=…>` without re-parsing JSON. | §1.10 rewrites the adapter contract to produce the full eight-prop bag verbatim. Both `adaptChatMessageToToolChip` and `adaptPendingInvocationToToolChip` now stamp `callContent` and `resultContent`. §1.13 adds adapter unit cases for both fields. |
| **P4** | Proposal B's template used `s.x.value` bindings; reviewer noted this would not behave well with Vue auto-unwrap for nested object refs. | §2.3 reworks Proposal B's container to destructure refs from the composable's return at the `<script setup>` level, then bind plain `x` in the template (auto-unwrap works on top-level setup refs). Proposal B remains rejected on the architectural axes in §3, so this is documentation-only. |

Strengths retained from r1 (each cross-referenced):

- Five chat SFCs under `web/src/components/chat/` + an
  `UnauthorizedNotice.vue`; container becomes layout + store wiring
  only (§1.1, §1.2).
- Two leaf composables (`useDebouncedConnectionState`,
  `useStickToBottom`) (§1.9).
- Pure utilities `analyst-timeline.ts` and `model-label.ts` (§1.11).
- Adapter file `tool-chip-adapter.ts` (introduced by F03's PR;
  re-used here) (§1.10).
- Narrow-rail layout rules: `min-width: 0` everywhere,
  `--chat-jump-bottom` driven by composer + pending-footer
  `ResizeObserver`s, `max-width: calc(100% - 24px)` on the jump
  pill, ellipsis-safe label (§1.12).
- `ChatMessage` additive metadata: four optional model fields, no
  store-shape changes (§1.11).
- F03/F04 chip-swap boundary unchanged: F03's PR ships the
  `AnalystChatPanel.vue` chip swap; F04 only relocates that call
  site into `MessageItem.vue` (§4 ordering).

---

## 0.1 Scope reminder

- **In scope (F04 PR)**: decompose `AnalystChatPanel.vue` into
  `chat/ChatHeader`, `chat/MessageList`, `chat/MessageItem`,
  `chat/JumpToLatest`, `chat/ChatComposer`, plus
  `chat/UnauthorizedNotice`; introduce
  `useDebouncedConnectionState`, `useStickToBottom`; introduce
  `web/src/utils/analyst-timeline.ts` (pairing utility) and
  `web/src/utils/model-label.ts`; narrow-rail layout rules; consume
  F02 r2 `ui/`/`content/`/`conversation/` primitives; consume F03 r2
  shared `<ToolChip>` via the eight-prop adapter shape defined in
  §1.10; export `PendingToolInvocation` from `api/types.ts`.
- **Already landed before F04**: F03 PR has replaced the in-line
  `<button class="tool-chip">` markup inside the monolithic
  `AnalystChatPanel.vue` with `<ToolChip v-bind="…">`, introduced
  `web/src/components/chat/tool-chip-adapter.ts`, introduced
  `web/src/utils/analyst-timeline.ts`, and migrated the
  `analyst-chat-panel.test.ts` chip selectors. F04 inherits that
  HEAD and only relocates the call site into `chat/MessageItem.vue`.
- **Out of scope**: any `useWebSocket` / `useAuthState` port from
  v2; any port of v2's `ChatWindow.vue`; any `ApiTokenEntry`
  redesign; toaster changes (F01/F02 own them);
  `analyst-chat-error-states.test.ts` (does not exist); F03's
  round/timeline structure on the analyst surface;
  `requestedModelSpec` UI rendering.

---

## 1. Proposal A — Focused decomposition (analysis r3 verbatim)

Implement F04 r3 directly: decompose `AnalystChatPanel.vue` into
five surface-local SFCs under `web/src/components/chat/`, two
composables under `web/src/composables/`, and two pure utilities
under `web/src/utils/`. Consume F02 r2 primitives and F03 r2's
shared `<ToolChip>` through the adapter introduced by F03's PR.

### 1.1 File layout (additions / replacements)

```
web/src/components/chat/
  AnalystChatPanel.vue       [REWRITE → container; layout + store wiring only]
  ChatHeader.vue             [NEW]
  MessageList.vue            [NEW]
  MessageItem.vue            [NEW]
  JumpToLatest.vue           [NEW]
  ChatComposer.vue           [NEW]
  UnauthorizedNotice.vue     [NEW]
  tool-chip-adapter.ts       [already introduced by F03 PR; consumed here]

web/src/composables/
  useDebouncedConnectionState.ts   [NEW]
  useStickToBottom.ts              [NEW]

web/src/utils/
  analyst-timeline.ts        [already introduced by F03 PR for the chip swap;
                              re-used by MessageList iteration]
  model-label.ts             [NEW]

web/src/api/types.ts         [EXTEND ChatMessage with 4 optional model fields, §1.11
                              EXPORT PendingToolInvocation, §1.1.1]

web/src/stores/analystChat.ts [import PendingToolInvocation from ../api/types
                              instead of declaring locally; no behavior change]
```

#### 1.1.1 `PendingToolInvocation` promotion (resolves B1)

Today the type is private to `web/src/stores/analystChat.ts`. F04's
adapter needs to import it from a shared module, and `MessageList`
needs to type its `pendingTools` prop. The type moves to
`web/src/api/types.ts`:

```ts
// web/src/api/types.ts (new export)
export interface PendingToolInvocation {
  id: string;
  sessionId: string;
  tool: string;
  summary: string;
  classifiedAs?: string;
  relatedCardId?: string;
  startedAt: string;
}
```

`stores/analystChat.ts` deletes its local copy and imports from
`../api/types`. No runtime change; the type is structurally
identical to what the store already produces.

### 1.2 `AnalystChatPanel.vue` — container after rewrite (resolves B1)

Sole responsibilities:

- Bind Pinia store refs (`useAnalystChat`, `useCardStore`,
  `useWorkspaceRouteStore`, `useWsStore`, `useRuntimeStore`).
- Derive `unauthorized` + `debouncedConnectionState` (§1.9).
- Derive **local** `thinking` from existing store refs (the live
  store does **not** expose a thinking field; F04 does not add one).
- Derive `pairedTimeline`, `defaultModelSpec`,
  `pendingToolInvocationsForActiveSession`, `childrenOnScreen`,
  `composerTitle`, `jumpBottomOffsetPx`.
- Register the `saivage:focus-chat` listener and forward focus to
  the composer ref.
- Lay out four children + the floating jump pill in a single grid.

```vue
<template>
  <aside
    id="analyst-chat-panel"
    class="analyst-chat-panel"
    role="region"
    aria-label="Analyst chat"
    :style="{ '--chat-jump-bottom': `${jumpBottomOffsetPx}px` }"
  >
    <ChatHeader
      :session-id="activeSessionId"
      :connection-state="debouncedConnectionState"
      :sessions-loading="sessionsLoading"
      :sessions-error="sessionsError"
    >
      <template #state>
        <UnauthorizedNotice
          v-if="unauthorized"
          @open-token-entry="openTokenEntry"
        />
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
      @resize="onPendingFooterResize"
    />

    <JumpToLatest
      v-if="!stuckToBottom"
      :unseen="unseenCount"
      :bottom-offset-px="jumpBottomOffsetPx"
      @jump="jumpToLatest"
    />

    <ChatComposer
      ref="composerRef"
      :draft="draft"
      :disabled="!activeSessionWritable"
      :sending="sending"
      :tooltip="composerTitle"
      :send-error="sendError"
      @update:draft="chat.setDraft($event)"
      @submit="submitMessage"
      @resize="onComposerResize"
    />
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRef } from 'vue';
import { storeToRefs } from 'pinia';
import { useAnalystChat } from '../../stores/analystChat';
import { useCardStore } from '../../stores/cards';
import { useWorkspaceRouteStore } from '../../stores/workspaceRoute';
import { useWsStore } from '../../stores/ws';
import { useRuntimeStore } from '../../stores/runtime';
import { pairAnalystMessages } from '../../utils/analyst-timeline';
import { useDebouncedConnectionState } from '../../composables/useDebouncedConnectionState';

import ChatHeader from './ChatHeader.vue';
import MessageList from './MessageList.vue';
import JumpToLatest from './JumpToLatest.vue';
import ChatComposer from './ChatComposer.vue';
import UnauthorizedNotice from './UnauthorizedNotice.vue';

const chat = useAnalystChat();
const cards = useCardStore();
const workspaceRoute = useWorkspaceRouteStore();
const ws = useWsStore();
const runtime = useRuntimeStore();

// Live store fields (verified against web/src/stores/analystChat.ts):
// sessions, activeSessionId, messages, draft,
// sessionsLoading, sessionsError, messagesLoading, messagesError,
// sending, sendError,
// pendingToolInvocations, messageBadges, activeSessionWritable.
// NOTE: there is no `thinking` ref on the live store; F04 derives it locally.
const {
  activeSessionId, messages, draft,
  sessionsLoading, sessionsError,
  messagesLoading, messagesError,
  sending, sendError,
  pendingToolInvocations, messageBadges,
  activeSessionWritable,
} = storeToRefs(chat);

const composerRef = ref<InstanceType<typeof ChatComposer> | null>(null);
const messageListRef = ref<InstanceType<typeof MessageList> | null>(null);
const expandedIds = ref<Set<string>>(new Set());

const composerHeightPx = ref(64);   // initial estimate; ResizeObserver-fed
const pendingFooterPx  = ref(0);
const jumpBottomOffsetPx = computed(() => composerHeightPx.value + pendingFooterPx.value);

const pairedTimeline = computed(() => pairAnalystMessages(messages.value));
const pendingToolInvocationsForActiveSession = computed(() =>
  pendingToolInvocations.value.filter((p) => p.sessionId === activeSessionId.value),
);

// Local `thinking` derivation (resolves B1). The signal is true while
// the user has a turn in flight: either the send call is outstanding,
// or at least one pending tool invocation exists for the active
// session and no terminal assistant text has arrived yet. The latter
// condition is enforced by the store's pending-tool-invocation
// lifecycle (entries are cleared when the matching tool_result
// arrives). No store extension.
const thinking = computed(
  () => sending.value || pendingToolInvocationsForActiveSession.value.length > 0,
);

const childrenOnScreen = computed(() =>
  workspaceRoute.view === 'cards' && workspaceRoute.entityId
    ? cards.childrenOf(workspaceRoute.entityId)
    : [],
);
const defaultModelSpec = computed(() => {
  for (const m of messages.value) {
    if (m.role === 'assistant' && m.modelSpec) return m.modelSpec;
  }
  return null;
});

const unauthorized = computed(() =>
  ws.connectionState === 'unauthorized' ||
  ws.connectionState === 'no-token' ||
  runtime.unauthorized,
);
const { debounced: debouncedConnectionState } =
  useDebouncedConnectionState(toRef(ws, 'connectionState'));

const READ_ONLY_TOOLTIP = 'Read-only — switch to analyst to send messages';
const composerTitle = computed(() =>
  activeSessionWritable.value ? 'Ask the analyst…' : READ_ONLY_TOOLTIP,
);

const stuckToBottom = ref(true);
const unseenCount = ref(0);
function onStickinessChange(payload: { stuck: boolean; unseen: number }) {
  stuckToBottom.value = payload.stuck;
  unseenCount.value  = payload.unseen;
}
function onComposerResize(heightPx: number)      { composerHeightPx.value = heightPx; }
function onPendingFooterResize(heightPx: number) { pendingFooterPx.value  = heightPx; }
function jumpToLatest() { messageListRef.value?.jumpToLatest(); }

function toggleExpanded(id: string) {
  const next = new Set(expandedIds.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  expandedIds.value = next;
}

async function submitMessage() {
  if (!activeSessionWritable.value) return;
  await chat.sendMessage();
  await nextTick();
  composerRef.value?.focus();
}

function openTokenEntry() {
  window.dispatchEvent(new CustomEvent('saivage:open-token-entry'));
}

function handleFocusChat() {
  void nextTick(() => composerRef.value?.focus());
}
onMounted(() => {
  window.addEventListener('saivage:focus-chat', handleFocusChat);
  void chat.fetchSessions().then(() => chat.fetchMessages()).catch(() => {});
  handleFocusChat();
});
onBeforeUnmount(() => {
  window.removeEventListener('saivage:focus-chat', handleFocusChat);
});
</script>

<style scoped>
.analyst-chat-panel {
  position: relative;
  display: grid;
  grid-template-rows: auto 1fr auto;
  width: 100%;
  height: 100%;
  background: var(--surface-1);
  border-left: 1px solid var(--border);
  overflow: hidden;
}
</style>
```

All hex literals deleted. The four old style families
(`.message-bubble`, `.tool-chip*`, `.primary-btn`, `.chat-composer`,
`.composer-input`, `.pending-tool-*`, `.message-badges`,
`.on-screen-section`, `.state-panel`) are deleted in the same patch:
their content moves into F02 primitives (`<Card>`, `<Button>`,
`<Pill>`) consumed by the new chat composites.

### 1.3 `chat/ChatHeader.vue` (resolves P1)

The `unauthorized` prop is removed (reviewer P1): the container
gates `<UnauthorizedNotice>` via `v-if="unauthorized"` on the
`#state` slot. `ChatHeader` itself does not need to know about
authorization.

```vue
<template>
  <header class="chat-header">
    <PanelHeading :level="3">
      <template #title>Analyst chat</template>
      <template #meta>
        <span class="session-id" :title="sessionId ?? 'new session'">
          {{ sessionId ? sessionId.slice(0, 14) : 'new session' }}
        </span>
      </template>
    </PanelHeading>

    <div class="connection-chip" data-testid="connection-chip" :data-state="connectionState">
      <StatusDot :tone="chipDotTone(connectionState)" />
      <component :is="chipIcon(connectionState)" :class="['chip-icon', spinIfConnecting]" aria-hidden="true" />
      <Pill>{{ chipLabel(connectionState) }}</Pill>
    </div>

    <div v-if="sessionsLoading" class="header-state">
      <Card><Spinner /> <span>Loading sessions…</span></Card>
    </div>
    <div v-else-if="sessionsError" class="header-state">
      <Card tone="danger" role="alert">{{ sessionsError.message }}</Card>
    </div>

    <slot name="state" />
  </header>
</template>

<script setup lang="ts">
import type { Component } from 'vue';
import { computed } from 'vue';
import { Wifi, WifiOff, ShieldAlert, Loader2 } from 'lucide-vue-next';
import type { WsConnectionState, DetailErrorState } from '../../api/types';
import PanelHeading from '../ui/PanelHeading.vue';
import Pill from '../ui/Pill.vue';
import StatusDot from '../ui/StatusDot.vue';
import Card from '../ui/Card.vue';
import Spinner from '../ui/Spinner.vue';

const props = defineProps<{
  sessionId: string | null;
  connectionState: WsConnectionState;
  sessionsLoading: boolean;
  sessionsError: DetailErrorState | null;
}>();

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
const spinIfConnecting = computed(() =>
  props.connectionState === 'connecting' ? 'spin' : null,
);
</script>

<style scoped>
.chat-header {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.connection-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.chip-icon { width: 14px; height: 14px; flex-shrink: 0; color: var(--text-muted); }
.session-id {
  font-family: var(--font-mono);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.header-state { display: contents; }
</style>
```

### 1.4 `chat/MessageList.vue` (resolves B3, contributes to B1 via `thinking` prop)

Owns the scroll body, the on-screen-children block, the thinking
footer, the pending-tool footer (sibling section with its own
`ResizeObserver`), and the state panels. Pairs delegated to
`MessageItem`. The pending-tool block renders the **same** shared
`<ToolChip>` via `adaptPendingInvocationToToolChip`.

**Resize-emit invariant (B3)**: the parent's `--chat-jump-bottom`
must never read a stale pending-footer height. r2 guarantees this
by:

1. A `watch(() => props.pendingTools.length === 0, isEmpty => …)`
   that emits `resize: 0` synchronously whenever the array empties.
   This fires **before** the footer element unmounts, so the parent
   sees `0` immediately.
2. The `pendingFooterEl` element watcher cleans up the observer on
   the previous element and, when the new value is `null`, emits
   `resize: 0` as a defence in depth.
3. The `ResizeObserver` callback is the only path that emits a
   non-zero value, and it only fires while the section is mounted.

```vue
<template>
  <div ref="scrollEl" class="message-list" @scroll="onScroll">
    <section
      v-if="onScreenChildren.length"
      class="on-screen-children"
      aria-labelledby="on-screen-title"
      data-testid="on-screen-children"
    >
      <Card>
        <h3 id="on-screen-title">On screen</h3>
        <ul>
          <li v-for="child in onScreenChildren" :key="child.id">
            {{ child.id }} — {{ child.title }}
          </li>
        </ul>
      </Card>
    </section>

    <Card v-if="messagesLoading" role="status">
      <Spinner /> <span>Loading history…</span>
    </Card>
    <Card
      v-else-if="messagesError && messagesError.kind === 'unauthorized'"
      tone="warn"
      role="alert"
    >
      Unauthorized. Provide a valid Saivage API token and retry.
    </Card>
    <Card v-else-if="messagesError" tone="danger" role="alert">
      {{ messagesError.message }}
    </Card>
    <Card
      v-else-if="items.length === 0 && pendingTools.length === 0"
      role="status"
    >
      No messages yet. Ask the analyst something.
    </Card>

    <template v-else>
      <MessageItem
        v-for="item in items"
        :key="item.id"
        :item="item"
        :badges="badges[item.id]"
        :expanded="expandedIds.has(item.id)"
        :default-model-spec="defaultModelSpec"
        @toggle="$emit('toggle', $event)"
      />

      <ThinkingDots v-if="thinking" data-testid="thinking-dots" />
    </template>

    <section
      v-if="pendingTools.length"
      ref="pendingFooterEl"
      class="pending-tool-list"
      data-testid="pending-tool-list"
    >
      <ToolChip
        v-for="p in pendingTools"
        :key="p.id"
        v-bind="adaptPendingInvocationToToolChip(p, expandedIds.has(p.id))"
        @toggle="$emit('toggle', p.id)"
      />
    </section>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import type {
  ChatMessage, PendingToolInvocation, DetailErrorState, CardRecord,
} from '../../api/types';
import type { AnalystTimelineItem } from '../../utils/analyst-timeline';
import { adaptPendingInvocationToToolChip } from './tool-chip-adapter';
import { useStickToBottom } from '../../composables/useStickToBottom';

import MessageItem from './MessageItem.vue';
import ToolChip from '../conversation/ToolChip.vue';
import ThinkingDots from '../conversation/ThinkingDots.vue';
import Card from '../ui/Card.vue';
import Spinner from '../ui/Spinner.vue';

interface TimelineBadge { label: string; timestamp: string }

const props = defineProps<{
  items: AnalystTimelineItem[];
  pendingTools: PendingToolInvocation[];
  badges: Record<string, TimelineBadge[]>;
  thinking: boolean;
  onScreenChildren: CardRecord[];
  expandedIds: Set<string>;
  messagesLoading: boolean;
  messagesError: DetailErrorState | null;
  defaultModelSpec: string | null;
}>();

const emit = defineEmits<{
  (e: 'toggle', id: string): void;
  (e: 'stickiness-change', payload: { stuck: boolean; unseen: number }): void;
  (e: 'resize', pendingFooterPx: number): void;
}>();

const scrollEl = ref<HTMLElement | null>(null);
const pendingFooterEl = ref<HTMLElement | null>(null);

const stick = useStickToBottom(scrollEl);

function onScroll() {
  stick.onScroll();
  emit('stickiness-change', { stuck: stick.stuck.value, unseen: stick.unseen.value });
}

watch(
  () => props.items.length + props.pendingTools.length,
  (next, prev) => { if (next > prev) stick.markIncoming(); },
);
watch([() => stick.stuck.value, () => stick.unseen.value], () => {
  emit('stickiness-change', { stuck: stick.stuck.value, unseen: stick.unseen.value });
});

// --- Pending-footer resize wiring (B3) ------------------------------------
// Single ResizeObserver is owned by this component and observes whichever
// element is currently the pending-footer. It is created lazily and
// disconnected on unmount.
let observer: ResizeObserver | null = null;
function ensureObserver(): ResizeObserver {
  if (!observer) {
    observer = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height ?? 0;
      emit('resize', Math.round(h));
    });
  }
  return observer;
}

watch(
  pendingFooterEl,
  (el, prev) => {
    if (prev && observer) observer.unobserve(prev);
    if (el) {
      ensureObserver().observe(el);
    } else {
      // Element unmounted (pendingTools became empty). The empty-list
      // watcher below has already emitted `0`, but emit again as a
      // defence in depth so any test that only observes the element
      // watcher still sees a clean reset.
      emit('resize', 0);
    }
  },
);

// Source-of-truth reset: when the list empties, emit 0 synchronously
// without waiting for the (now-unmounted) element observer to fire.
watch(
  () => props.pendingTools.length === 0,
  (isEmpty) => { if (isEmpty) emit('resize', 0); },
  { immediate: true },
);

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});

defineExpose({ jumpToLatest: stick.jumpToLatest });
</script>

<style scoped>
.message-list {
  position: relative;
  overflow: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.on-screen-children :deep(h3) {
  margin: 0 0 6px;
  font-size: 13px;
  color: var(--text);
}
.on-screen-children :deep(ul) {
  margin: 0;
  padding-left: 18px;
  color: var(--text-muted);
  font-size: 12px;
}
.pending-tool-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
```

The `on-screen-children` `<section>` keeps the layout class
**and** carries the new `data-testid` (C1).

### 1.5 `chat/MessageItem.vue` (resolves B2)

Renders a single row. Branches on `item.kind`. The shared
`<ToolChip>` consumes the F03 r2 §7.2 eight-prop bag via `v-bind=`.
No `:view`, no `:message`, no chat-local chip API.

**Model-chip gating (B2)**: the `<Pill>` is gated by
`fullLabel !== null`, not by `shortModelLabel(...)`. `fullLabel`
comes from `modelLabel(msg, defaultModelSpec)`, which returns
`null` when the message's spec equals the default and no
`requestedModelSpec` is set (§1.11). The visible text is
`shortModelLabel(msg)`; the `title` is `fullLabel`. When
`fullLabel` is null, no pill renders at all.

```vue
<template>
  <article class="message-item" :class="`kind-${item.kind}`">
    <template v-if="item.kind === 'tool_pair'">
      <ToolChip
        v-bind="adaptChatMessageToToolChip(item.call, item.result, expanded)"
        @toggle="$emit('toggle', item.id)"
      />
    </template>
    <template v-else>
      <MessageBubble
        :role="item.message.role"
        kind="plain"
        :timestamp="item.message.timestamp"
      >
        <template #default>
          <MarkdownText
            v-if="item.message.role === 'assistant'"
            :source="item.message.content"
          />
          <span v-else class="message-text">{{ item.message.content }}</span>
        </template>
        <template #meta>
          <Pill
            v-if="fullLabel !== null"
            :title="fullLabel"
            data-testid="model-pill"
          >
            {{ shortModelLabel(item.message) }}
          </Pill>
        </template>
      </MessageBubble>
    </template>

    <ul v-if="badges?.length" class="message-badges">
      <li v-for="b in badges" :key="`${item.id}-${b.timestamp}-${b.label}`">
        <Pill tone="accent">{{ b.label }}</Pill>
      </li>
    </ul>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { AnalystTimelineItem } from '../../utils/analyst-timeline';
import { adaptChatMessageToToolChip } from './tool-chip-adapter';
import { modelLabel, shortModelLabel } from '../../utils/model-label';

import ToolChip from '../conversation/ToolChip.vue';
import MessageBubble from '../conversation/MessageBubble.vue';
import MarkdownText from '../content/MarkdownText.vue';
import Pill from '../ui/Pill.vue';

interface TimelineBadge { label: string; timestamp: string }

const props = defineProps<{
  item: AnalystTimelineItem;
  badges: TimelineBadge[] | undefined;
  expanded: boolean;
  defaultModelSpec: string | null;
}>();
defineEmits<{ (e: 'toggle', id: string): void }>();

// B2: `fullLabel` is the visibility gate. When null (spec === default
// AND no requestedModelSpec), no pill renders. When non-null, the pill
// shows the suffix (`shortModelLabel`) and stores the full string in
// `title`.
const fullLabel = computed(() =>
  props.item.kind === 'message'
    ? modelLabel(props.item.message, props.defaultModelSpec)
    : null,
);
</script>

<style scoped>
.message-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.message-text {
  white-space: pre-wrap;
  word-break: break-word;
}
.message-badges {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
</style>
```

### 1.6 `chat/JumpToLatest.vue`

```vue
<template>
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
</template>

<script setup lang="ts">
import { ArrowDown } from 'lucide-vue-next';
defineProps<{ unseen: number; bottomOffsetPx: number }>();
defineEmits<{ (e: 'jump'): void }>();
</script>

<style scoped>
.jump-to-latest {
  position: absolute;
  right: 12px;
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
.jump-to-latest .icon { width: 14px; height: 14px; flex-shrink: 0; }
</style>
```

### 1.7 `chat/ChatComposer.vue`

Owns the textarea, the resize-to-content logic, the keydown matrix,
the Send button, the read-only tooltip, and the inline `sendError`
panel. Exposes `focus()` so the container's `saivage:focus-chat`
handler can call it.

```vue
<template>
  <form class="chat-composer" @submit.prevent="$emit('submit')">
    <textarea
      ref="taRef"
      :value="draft"
      class="composer-input"
      rows="1"
      placeholder="Ask the analyst…"
      aria-label="Analyst chat composer"
      :disabled="disabled"
      :title="tooltip"
      @input="onInput"
      @keydown="onKeydown"
    />
    <div class="composer-footer">
      <span class="text-muted">Enter to send · Shift+Enter for newline</span>
      <Button
        variant="primary"
        type="submit"
        :disabled="disabled || sending || !draft.trim()"
        :title="tooltip"
        data-testid="analyst-send"
      >
        <SendHorizontal class="icon" aria-hidden="true" />
        {{ sending ? 'Sending…' : 'Send' }}
      </Button>
    </div>
    <Card v-if="sendError" tone="danger" role="alert">
      {{ sendError.message }}
    </Card>
  </form>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { SendHorizontal } from 'lucide-vue-next';
import type { DetailErrorState } from '../../api/types';
import Button from '../ui/Button.vue';
import Card from '../ui/Card.vue';

const props = defineProps<{
  draft: string;
  disabled: boolean;
  sending: boolean;
  tooltip: string;
  sendError: DetailErrorState | null;
}>();
const emit = defineEmits<{
  (e: 'update:draft', value: string): void;
  (e: 'submit'): void;
  (e: 'resize', heightPx: number): void;
}>();

const taRef = ref<HTMLTextAreaElement | null>(null);
const COMPOSER_MAX_HEIGHT_PX = 172;     // 8 lines × 20 px + 12 px chrome
const COMPOSER_CHROME_PX     = 64;      // footer + padding + border

function resizeInput() {
  const el = taRef.value;
  if (!el) return;
  el.style.height = 'auto';
  const next = Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX);
  el.style.height = `${next}px`;
  emit('resize', next + COMPOSER_CHROME_PX);
}

function onInput(event: Event) {
  emit('update:draft', (event.target as HTMLTextAreaElement).value);
  void nextTick(resizeInput);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter') return;
  if (event.shiftKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  event.preventDefault();
  emit('submit');
}

let observer: ResizeObserver | null = null;
onMounted(() => {
  resizeInput();
  observer = new ResizeObserver(() => resizeInput());
  if (taRef.value) observer.observe(taRef.value);
});
onBeforeUnmount(() => observer?.disconnect());

defineExpose({ focus: () => taRef.value?.focus() });
</script>

<style scoped>
.chat-composer {
  border-top: 1px solid var(--border);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.composer-input {
  width: 100%;
  min-height: 38px;
  max-height: 172px;
  resize: none;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  padding: 8px 10px;
  font: inherit;
}
.composer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.icon { width: 14px; height: 14px; flex-shrink: 0; }
</style>
```

### 1.8 `chat/UnauthorizedNotice.vue`

```vue
<template>
  <Card tone="warn" role="alert" data-testid="analyst-unauth-notice" class="unauth-notice">
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
<script setup lang="ts">
import { KeyRound } from 'lucide-vue-next';
import Card from '../ui/Card.vue';
import Button from '../ui/Button.vue';
defineEmits<{ (e: 'openTokenEntry'): void }>();
</script>
<style scoped>
.unauth-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.copy { display: flex; flex-direction: column; min-width: 0; }
.icon { width: 16px; height: 16px; flex-shrink: 0; }
</style>
```

### 1.9 Composables (resolves P2)

`useDebouncedConnectionState.ts` — parameter widened to accept a
read-only ref (the live `useWsStore().connectionState` is exposed
as a `Readonly<Ref<…>>`):

```ts
import { ref, watch, onUnmounted, type Ref } from 'vue';
import type { WsConnectionState } from '../api/types';

const TO_OPEN_IMMEDIATE: readonly WsConnectionState[] = ['connected'];
const DEBOUNCE_MS = 400;

export function useDebouncedConnectionState(
  source: Readonly<Ref<WsConnectionState>> | Ref<WsConnectionState>,
): { debounced: Ref<WsConnectionState> } {
  const debounced = ref<WsConnectionState>(source.value);
  let timer: ReturnType<typeof setTimeout> | null = null;
  function clear() { if (timer) { clearTimeout(timer); timer = null; } }

  watch(source, (next) => {
    if (TO_OPEN_IMMEDIATE.includes(next)) {
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

`useStickToBottom.ts`:

```ts
import { nextTick, ref, type Ref } from 'vue';

export function useStickToBottom(elRef: Ref<HTMLElement | null>, thresholdPx = 60) {
  const stuck  = ref(true);
  const unseen = ref(0);

  function distanceFromBottom(el: HTMLElement) {
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }

  function onScroll(): void {
    const el = elRef.value; if (!el) return;
    const next = distanceFromBottom(el) <= thresholdPx;
    if (next && !stuck.value) unseen.value = 0;
    stuck.value = next;
  }

  function markIncoming(): void {
    const el = elRef.value; if (!el) return;
    if (stuck.value) {
      void nextTick(() => { el.scrollTop = el.scrollHeight; });
    } else {
      unseen.value += 1;
    }
  }

  async function jumpToLatest(): Promise<void> {
    const el = elRef.value; if (!el) return;
    stuck.value  = true;
    unseen.value = 0;
    await nextTick();
    el.scrollTop = el.scrollHeight;
  }

  return { stuck, unseen, onScroll, markIncoming, jumpToLatest };
}
```

### 1.10 Adapter contract — eight-prop bag (resolves P3)

F03 r2 §7.2 settled the chip's external prop bag at **eight props**:

```ts
{
  call: ToolCallPresentation;          // F05 r2 §2 — always present (synthesised for orphan results)
  result: ToolResultPresentation | null;
  callContent: string;                 // RAW call entry .content (drives <FormattedContent> in the expanded body)
  resultContent: string | null;        // RAW result entry .content or null
  status: ToolPairStatus;              // F03 r2 §3.3: 'pending' | 'ok' | 'error' | 'orphan' | 'missing'
  expanded: boolean;
  detailsId: string;                   // 'tool-detail-<toolUseId>' or 'tool-detail-pending-<id>'
  timestamp?: string;
}
```

F04 r1's adapter only stamped six props. r2 fixes both adapter
functions to produce the full eight-prop bag verbatim.

`tool-chip-adapter.ts` (introduced by F03 PR; F04 consumes
unchanged after the F03 PR's update). For binding clarity, the
exact contract:

```ts
import {
  presentToolCall,
  presentToolResult,
  type ToolCallPresentation,
  type ToolResultPresentation,
  type InlinePart,
} from '../../utils/tool-presenters';
import type { ChatMessage, PendingToolInvocation } from '../../api/types';
import type { ToolPairStatus } from '../../utils/agent-timeline/types';

export interface ToolChipProps {
  call: ToolCallPresentation;
  result: ToolResultPresentation | null;
  callContent: string;
  resultContent: string | null;
  status: ToolPairStatus;
  expanded: boolean;
  detailsId: string;
  timestamp?: string;
}

export function adaptChatMessageToToolChip(
  call: ChatMessage,                    // kind === 'tool_call' (or synthetic for orphan)
  result: ChatMessage | null,
  expanded: boolean,
): ToolChipProps {
  const callView   = presentToolCall(call.content, call.tool);
  const resultView = result
    ? presentToolResult(result.content, {
        tool: result.tool,
        kind: result.kind as 'tool_result' | 'tool_error',
      })
    : null;

  const status: ToolPairStatus =
    !resultView                    ? 'missing' :
    isSynthesisedCall(call)        ? 'orphan'  :
    resultView.status;             // 'ok' | 'error'

  return {
    call:          callView,
    result:        resultView,
    callContent:   call.content,                 // P3 — raw payload for expanded body
    resultContent: result ? result.content : null,
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
  const detail:   InlinePart[] = [];
  if (pending.classifiedAs)  detail.push({ kind: 'text', value: pending.classifiedAs, tone: 'muted' });
  if (pending.relatedCardId) detail.push({ kind: 'text', value: `card ${pending.relatedCardId}`, tone: 'muted' });

  const callView: ToolCallPresentation = {
    icon: '🔧',
    name: pending.tool || 'tool',
    headline,
    detail,
    status: 'call',
  };

  // Synthesise a JSON payload that <FormattedContent> can render in
  // the expanded body. The pending invocation has no persisted call
  // message, so we present the structured fields we have. F05 r2's
  // JSON-vs-prose auto-detect (§7.3) routes this through <JsonView>.
  const syntheticCallContent = JSON.stringify({
    tool: pending.tool,
    summary: pending.summary,
    classifiedAs: pending.classifiedAs ?? null,
    relatedCardId: pending.relatedCardId ?? null,
    startedAt: pending.startedAt,
  }, null, 2);

  return {
    call:          callView,
    result:        null,
    callContent:   syntheticCallContent,         // P3 — synthetic raw payload
    resultContent: null,
    status:        'pending',
    expanded,
    detailsId: `tool-detail-pending-${pending.id}`,
    timestamp: pending.startedAt,
  };
}

export function synthesizeCallFromResult(result: ChatMessage): ChatMessage;
export function isSynthesisedCall(call: ChatMessage): boolean;
```

Render sites in F04:

- `chat/MessageItem.vue` (paired pair):
  `<ToolChip v-bind="adaptChatMessageToToolChip(item.call, item.result, expanded)" @toggle="$emit('toggle', item.id)" />`
- `chat/MessageList.vue` (pending footer):
  `<ToolChip v-bind="adaptPendingInvocationToToolChip(p, expandedIds.has(p.id))" @toggle="$emit('toggle', p.id)" />`

No `:view`. No `:message`. No chat-local chip API.

### 1.11 `ChatMessage` type extension + `model-label.ts` (refines B2)

```ts
// web/src/api/types.ts
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

  // F04 r3 §7.2 additive metadata (server-stamped, optional until backend lands):
  provider?: string;
  model?: string;
  modelSpec?: string;
  requestedModelSpec?: string;
}
```

Consumer: `web/src/utils/model-label.ts` (new).

```ts
import type { ChatMessage } from '../api/types';

/**
 * Returns the full model spec to display, or null when the chip
 * should be hidden. The chip is hidden when:
 *   - the message is not an assistant message, OR
 *   - no spec is available, OR
 *   - the spec equals the default AND no requestedModelSpec is set.
 *
 * Use this function (NOT shortModelLabel) as the visibility gate.
 */
export function modelLabel(
  msg: ChatMessage,
  defaultModelSpec: string | null,
): string | null {
  if (msg.role !== 'assistant') return null;
  const spec = msg.modelSpec ?? (msg.provider && msg.model ? `${msg.provider}/${msg.model}` : null);
  if (!spec) return null;
  if (spec === defaultModelSpec && !msg.requestedModelSpec) return null;
  return spec;
}

/**
 * Suffix portion of the spec (substring after the last '/'), used
 * for the visible pill text. Does NOT decide visibility — callers
 * MUST gate on `modelLabel(...)` first.
 */
export function shortModelLabel(msg: ChatMessage): string | null {
  if (msg.role !== 'assistant') return null;
  const spec = msg.modelSpec ?? (msg.provider && msg.model ? `${msg.provider}/${msg.model}` : null);
  if (!spec) return null;
  const i = spec.lastIndexOf('/');
  return i >= 0 ? spec.slice(i + 1) : spec;
}
```

`MessageItem.vue` uses `modelLabel(...)` to gate the pill (§1.5)
and `shortModelLabel(...)` for the visible suffix only. When
`modelLabel` returns `null`, no pill renders. The contract is
asserted by the `model-label.test.ts` cases in §1.13.

### 1.12 Narrow-rail layout rules (F04 r3 §8 binding)

- `.analyst-chat-panel`: `position: relative; display: grid;
  grid-template-rows: auto 1fr auto;`. CSS variable
  `--chat-jump-bottom` set on the panel inline-style.
- Every flex/grid child that wraps potentially wide content carries
  `min-width: 0`. `MessageBubble`, `MessageItem`, `MessageList`,
  `ChatHeader`, `ChatComposer`, `JumpToLatest`, `ConnectionChip`,
  `SessionId span`, `Pill` already satisfy this.
- `JumpToLatest`: `position: absolute; right: 12px; bottom:
  calc(var(--chat-jump-bottom) + 8px)`. Also accepts
  `bottomOffsetPx` prop and binds inline `bottom` as a resilience
  fallback. `max-width: calc(100% - 24px)`. Label is ellipsis-safe.
- `ChatComposer` `.composer-input`: `min-height: 38px; max-height:
  172px; resize: none`. Emits `@resize(heightPx)` from a
  `ResizeObserver`.
- `MessageList` `.pending-tool-list`: observed by a `ResizeObserver`;
  height is emitted via `@resize`. **When `pendingTools.length === 0`,
  the section is absent AND `@resize(0)` is emitted synchronously**
  (B3, §1.4).
- v2's `min(780px, 92%)` bubble clamp is **not** ported. Bubbles fill
  the rail width.

### 1.13 Test inventory (per file, resolves B1/B2/B3/C1/P3)

`web/src/__tests__/analyst-chat-panel.test.ts` — **rewrite**:

- Send button selector: `wrapper.get('[data-testid="analyst-send"]')`.
- Chip selectors: `wrapper.findAll('[data-testid="tool-chip"]')`,
  status via `chip.attributes('data-status')`.
- Pending chip: `'[data-testid="tool-chip"][data-status="pending"]'`.
- Expansion reveals `[data-testid="formatted-content"]` (F05 r2
  `<FormattedContent>` inside the chip body), and the rendered
  content matches `callContent`/`resultContent` from the adapter
  (P3 contract check).
- `saivage:focus-chat` dispatch → composer textarea is active element.
- Read-only tooltip: send button `title` equals
  `'Read-only — switch to analyst to send messages'` when
  `activeSessionWritable === false`.
- Empty / loading / unauthorized / error state assertions via text
  queries against the F02 `<Card>` outputs.
- Header connection chip — `[data-testid="connection-chip"]`
  `data-state` reflects the debounced state.
- **Model-pill gating (B2)**: a fixture where the last assistant
  message has `modelSpec === defaultModelSpec` AND no
  `requestedModelSpec` produces **no** `[data-testid="model-pill"]`
  in the DOM. A fixture where the spec differs produces a pill with
  visible text equal to the short form and `title` equal to the
  full string.
- **Thinking dots (B1)**: a fixture where `sending === true` and
  `pendingToolInvocations === []` renders
  `[data-testid="thinking-dots"]`. A fixture where `sending === false`
  and `pendingToolInvocations` contains an active-session entry also
  renders `[data-testid="thinking-dots"]`. A fixture where both are
  empty/false does NOT render the element.

`web/src/__tests__/analyst-chat-store.test.ts` — **fixtures +
assertions**:

- Fixtures accept `provider?`, `model?`, `modelSpec?`,
  `requestedModelSpec?` on `ChatMessage` (no test asserts they are
  required).
- Pending-tool dedupe assertions stay as-is.
- New assertion: the locally re-imported `PendingToolInvocation`
  from `api/types.ts` is structurally equivalent to the previous
  in-store private type — the existing pending-tool fixtures
  continue to type-check unchanged.

`web/src/__tests__/components/AnalystChatPanel.children.test.ts` —
**rewrite, three live tests preserved (C1)**:

- The three existing behavior tests are rewritten to target the new
  decomposed container: they mount `AnalystChatPanel.vue` (which now
  renders `<MessageList>`) and locate the on-screen-children block
  via `wrapper.find('[data-testid="on-screen-children"]')`. The
  legacy `.on-screen-children li` selector continues to work because
  the layout class is preserved (§1.4).
- `aria-labelledby="on-screen-title"` unchanged.
- The raw-source guard test (`useCardStore` is imported from
  `../../stores/cards`) is rewritten to assert on the new container
  source: it inspects the new `chat/AnalystChatPanel.vue` (the
  rewritten container) and asserts the `useCardStore` import path
  is still `../../stores/cards`. Justification: the decomposition
  moves no store imports across paths; `useCardStore` is still
  consumed by the container in §1.2.

`web/src/__tests__/analyst-toaster.test.ts` — **NOT touched by F04**.
F01/F02 own toaster cleanup.

`web/src/__tests__/jump-to-latest.test.ts` — **new**:

- `bottomOffsetPx === 48` → inline `style.bottom` equals
  `calc(48px + 8px)`.
- `unseen === 0` → label `'Jump to latest'`; `unseen === 3` →
  `'3 new'`; `.unseen` class applied.
- Click emits `jump`.
- `aria-label` reflects unseen count.
- Narrow-width: `max-width: calc(100% - 24px)` style present;
  `text-overflow: ellipsis` on `.label`.

`web/src/__tests__/components/chat/MessageList.resize.test.ts` —
**new (B3)**:

- Mounting with `pendingTools: []` emits `resize: 0` immediately
  (from the `immediate: true` watcher).
- Going from `pendingTools: [a, b]` to `pendingTools: []` emits
  `resize: 0` synchronously on the empty transition.
- Going from `pendingTools: []` back to `pendingTools: [a]` does
  NOT emit a spurious zero; the next `resize` event carries a
  non-zero footer height once the observer fires.
- The element watcher cleanup emits `resize: 0` when the
  `pendingFooterEl` ref transitions to `null` (defence in depth).

`web/src/__tests__/composables/useStickToBottom.test.ts` — **new**:

- `stuck` false when scroll distance exceeds threshold.
- `stuck` true when within threshold.
- `markIncoming` bumps `unseen` only when not stuck.
- `jumpToLatest` resets `unseen=0`, sets `stuck=true`.

`web/src/__tests__/composables/useDebouncedConnectionState.test.ts` —
**new**:

- `offline → connected` is immediate (no 400 ms wait).
- `connected → connecting` takes 400 ms.
- Re-flap (`connected → offline → connected` within 400 ms) emits
  only the final `connected`.
- Accepts a `Readonly<Ref<WsConnectionState>>` source (P2): the
  composable is invoked with `readonly(ref('connected'))` and
  produces the expected debounced output. This case asserts the
  widened parameter type at runtime.

`web/src/__tests__/utils/analyst-timeline.test.ts` — **new**:

- Pairs `tool_call` + `tool_result` by `tool_call_id`.
- Emits `result: null` when only a call exists.
- Emits an orphan pair (`call = synthesized`, `result = real`) when
  only a result exists.

`web/src/__tests__/utils/model-label.test.ts` — **new (B2)**:

- `modelLabel`: returns null for non-assistant messages.
- `modelLabel`: returns null when no spec is available.
- `modelLabel`: returns null when `spec === defaultModelSpec` and
  no `requestedModelSpec`.
- `modelLabel`: returns the full spec when `requestedModelSpec` is
  set, even if `spec === defaultModelSpec`.
- `modelLabel`: returns the full spec when `spec !== defaultModelSpec`.
- `shortModelLabel`: returns suffix after last `/`; returns the
  whole spec when no `/` is present; returns null for non-assistant.
- **Gate contract (B2)**: `modelLabel` returning null while
  `shortModelLabel` returns a non-null suffix is the documented
  case — callers MUST gate on `modelLabel` first. The test makes
  this explicit with a comment and a case that demonstrates the
  divergence.

`web/src/__tests__/components/chat/tool-chip-adapter.test.ts` —
**adds two new cases for the eight-prop bag (P3)**:

- `adaptChatMessageToToolChip` returns `callContent === call.content`
  and `resultContent === result?.content ?? null`.
- `adaptPendingInvocationToToolChip` returns
  `callContent === JSON.stringify({tool, summary, classifiedAs,
  relatedCardId, startedAt}, null, 2)` and `resultContent === null`.

`web/src/__tests__/analyst-chat-error-states.test.ts` — **does not
exist; do not create**.

`web/src/__tests__/components/conversation/ToolChip.test.ts` —
**owned by F03; F04 does not duplicate**. F03 r2 §11.1 covers the
chip DOM contract.

---

## 2. Proposal B — One level up: `useChatSurface` composable

**Premise**: instead of letting `AnalystChatPanel.vue` keep its own
ad-hoc derivation of `pairedTimeline`, `defaultModelSpec`,
`debouncedConnectionState`, `unauthorized`, `expandedIds`,
`stuckToBottom`, `unseenCount`, `jumpBottomOffsetPx`, `thinking`,
and the `saivage:focus-chat` handler, extract the **entire chat
state machine** into a single composable `useChatSurface(...)`. The
five child SFCs become pure render shells driven by the composable's
return value. Any future chat surface (card-comments, goal
discussion, retro thread) reuses the composable without redoing the
plumbing.

The decomposition into ChatHeader / MessageList / MessageItem /
JumpToLatest / ChatComposer still happens — Proposal B does **not**
replace Proposal A's component split. It replaces the **container's
script body**: the container shrinks to ~30 lines of `useChatSurface`
+ template, and the cross-surface logic becomes testable in
isolation.

### 2.1 File layout (additions / replacements)

```
web/src/components/chat/
  AnalystChatPanel.vue       [REWRITE → thin shell, ~30 LOC script]
  ChatHeader.vue             [NEW; identical to Proposal A §1.3]
  MessageList.vue            [NEW; identical to Proposal A §1.4]
  MessageItem.vue            [NEW; identical to Proposal A §1.5]
  JumpToLatest.vue           [NEW; identical to Proposal A §1.6]
  ChatComposer.vue           [NEW; identical to Proposal A §1.7]
  UnauthorizedNotice.vue     [NEW; identical to Proposal A §1.8]
  tool-chip-adapter.ts       [already introduced by F03 PR]

web/src/composables/
  useChatSurface.ts          [NEW — the full state machine]
  useDebouncedConnectionState.ts   [NEW; used by useChatSurface internally]
  useStickToBottom.ts              [NEW; used by useChatSurface internally]

web/src/utils/
  analyst-timeline.ts        [already introduced by F03 PR]
  model-label.ts             [NEW; identical to Proposal A §1.11]

web/src/api/types.ts         [EXTEND ChatMessage with 4 optional fields;
                              EXPORT PendingToolInvocation]
```

### 2.2 `useChatSurface.ts` — full signature

```ts
export interface UseChatSurfaceReturn {
  composerRef: Ref<ChatSurfaceComposerRef | null>;
  messageListRef: Ref<ChatSurfaceListRef | null>;

  activeSessionId: Ref<string | null>;
  pairedTimeline: Ref<AnalystTimelineItem[]>;
  pendingTools: Ref<PendingToolInvocation[]>;
  badges: Ref<Record<string, { label: string; timestamp: string }[]>>;
  thinking: Ref<boolean>;                          // derived from sending + pendingTools
  onScreenChildren: Ref<CardRecord[]>;
  defaultModelSpec: Ref<string | null>;

  sessionsLoading: Ref<boolean>;
  sessionsError: Ref<DetailErrorState | null>;
  messagesLoading: Ref<boolean>;
  messagesError: Ref<DetailErrorState | null>;
  sending: Ref<boolean>;
  sendError: Ref<DetailErrorState | null>;

  draft: Ref<string>;
  setDraft(value: string): void;
  activeSessionWritable: Ref<boolean>;
  composerTitle: Ref<string>;

  connectionState: Readonly<Ref<WsConnectionState>>;
  debouncedConnectionState: Ref<WsConnectionState>;
  unauthorized: Ref<boolean>;

  expandedIds: Ref<Set<string>>;
  toggleExpanded(id: string): void;

  stuckToBottom: Ref<boolean>;
  unseenCount: Ref<number>;
  onStickinessChange(p: { stuck: boolean; unseen: number }): void;

  composerHeightPx: Ref<number>;
  pendingFooterPx: Ref<number>;
  jumpBottomOffsetPx: Ref<number>;
  onComposerResize(h: number): void;
  onPendingFooterResize(h: number): void;
  jumpToLatest(): void;

  submitMessage(): Promise<void>;
  openTokenEntry(): void;
}

export function useChatSurface(options?: {
  focusEventName?: string;
  readOnlyTooltip?: string;
}): UseChatSurfaceReturn;
```

Implementation is the union of the container script in §1.2 with
the leaf composables imported internally. `thinking` is derived
the same way as in Proposal A (B1): `sending.value ||
pendingTools.value.length > 0`. The `PendingToolInvocation` import
follows §1.1.1 (now an `api/types` export).

### 2.3 `AnalystChatPanel.vue` after Proposal B (resolves P4)

P4 fix: destructure the composable's return at `<script setup>` so
the template can bind plain identifiers (Vue auto-unwraps top-level
refs declared in `setup`). No `s.x.value` clutter.

```vue
<template>
  <aside
    id="analyst-chat-panel"
    class="analyst-chat-panel"
    role="region"
    aria-label="Analyst chat"
    :style="{ '--chat-jump-bottom': `${jumpBottomOffsetPx}px` }"
  >
    <ChatHeader
      :session-id="activeSessionId"
      :connection-state="debouncedConnectionState"
      :sessions-loading="sessionsLoading"
      :sessions-error="sessionsError"
    >
      <template #state>
        <UnauthorizedNotice v-if="unauthorized" @open-token-entry="openTokenEntry" />
      </template>
    </ChatHeader>

    <MessageList
      :ref="(el) => (messageListRef = el as any)"
      :items="pairedTimeline"
      :pending-tools="pendingTools"
      :badges="badges"
      :thinking="thinking"
      :on-screen-children="onScreenChildren"
      :expanded-ids="expandedIds"
      :messages-loading="messagesLoading"
      :messages-error="messagesError"
      :default-model-spec="defaultModelSpec"
      @toggle="toggleExpanded"
      @stickiness-change="onStickinessChange"
      @resize="onPendingFooterResize"
    />

    <JumpToLatest
      v-if="!stuckToBottom"
      :unseen="unseenCount"
      :bottom-offset-px="jumpBottomOffsetPx"
      @jump="jumpToLatest"
    />

    <ChatComposer
      :ref="(el) => (composerRef = el as any)"
      :draft="draft"
      :disabled="!activeSessionWritable"
      :sending="sending"
      :tooltip="composerTitle"
      :send-error="sendError"
      @update:draft="setDraft($event)"
      @submit="submitMessage"
      @resize="onComposerResize"
    />
  </aside>
</template>

<script setup lang="ts">
import ChatHeader from './ChatHeader.vue';
import MessageList from './MessageList.vue';
import JumpToLatest from './JumpToLatest.vue';
import ChatComposer from './ChatComposer.vue';
import UnauthorizedNotice from './UnauthorizedNotice.vue';
import { useChatSurface } from '../../composables/useChatSurface';

const {
  composerRef, messageListRef,
  activeSessionId, pairedTimeline, pendingTools, badges, thinking,
  onScreenChildren, expandedIds, defaultModelSpec,
  sessionsLoading, sessionsError, messagesLoading, messagesError,
  sending, sendError,
  draft, setDraft, activeSessionWritable, composerTitle,
  debouncedConnectionState, unauthorized,
  stuckToBottom, unseenCount, onStickinessChange,
  composerHeightPx, pendingFooterPx, jumpBottomOffsetPx,
  onComposerResize, onPendingFooterResize, jumpToLatest,
  submitMessage, openTokenEntry, toggleExpanded,
} = useChatSurface();
</script>
```

### 2.4 Adapter / layout / type-extension under Proposal B

Identical to Proposal A §1.10 / §1.12 / §1.11. The composable does
not own chip adapters, CSS, or type extensions.

### 2.5 Test inventory under Proposal B

Identical to Proposal A's, plus a new
`web/src/__tests__/composables/useChatSurface.test.ts` that
re-asserts every derived ref against stubbed Pinia stores, plus the
`thinking` derivation case from §1.13.

---

## 3. Recommendation — **Proposal A**

F04 r3's analysis is approved and binding. Proposal A implements
that analysis verbatim. Proposal B is a genuine alternative
(composable extraction), and r2 has fixed its template-binding
issue (P4). The recommendation across four axes is unchanged from
r1:

**Clean architecture.** Both proposals decompose the same way. The
difference is where the glue lives. v3's Pinia stores already
expose what a composable would expose; the analyst-chat store
already holds `messages`, `draft`, `sending`, `sendError`,
`pendingToolInvocations`, `messageBadges`, `activeSessionWritable`,
plus actions. Wrapping that store in `useChatSurface` adds a layer
that exists only to hold ~20 derived refs and three event handlers.
Proposal A keeps the dependency arrow straight (store → container →
composites); Proposal B inserts a parallel composable that
re-exports the store.

**F03 chip alignment.** Both proposals consume the same eight-prop
adapter (§1.10). Neither preferred.

**Preservation of v3-only features.** Both proposals preserve
on-screen children, pending invocations, badges, read-only tooltip,
focus-chat shortcut, `ApiTokenEntry`, the state panels, and the
locally derived `thinking` signal. Neither preferred.

**Narrow-rail constraints.** Concrete CSS rules land in the same
files in both proposals. Neither preferred.

**Reusability.** Proposal B's headline claim is reuse for a future
chat surface that does not exist today. The analyst-chat store is
hard-wired into `useChatSurface`; making it parametric would mean
accepting `chatStore` and `wsStore` factories as options — a more
invasive change than F04 should adopt speculatively. The project
guideline "architecture-first, no backward compatibility" prizes
removing layers, not adding them; B adds a wrapper layer to support
a single consumer.

**Test cost.** Proposal A keeps the existing
`analyst-chat-panel.test.ts` as the integration surface, plus six
small new test files (composables × 2, utils × 2,
`jump-to-latest.test.ts`, `MessageList.resize.test.ts`). Proposal B
adds a seventh (`useChatSurface.test.ts`) that re-asserts what the
store tests already assert, only one wrapper layer down.

**Verdict.** **Proposal A is selected.** Proposal B is recorded
here so it can be reconsidered if a second chat surface
materialises — at that point the refactor from container-owned
state to `useChatSurface` is mechanical and self-contained, since
Proposal A already pre-factored the leaf composables
(`useDebouncedConnectionState`, `useStickToBottom`) that
`useChatSurface` would consume.

---

## 4. Selected design — implementation summary

For clarity, the selected (Proposal A) deliverables:

| File | Status | Owner |
| --- | --- | --- |
| `web/src/components/chat/AnalystChatPanel.vue` | REWRITE (container, §1.2) | F04 PR |
| `web/src/components/chat/ChatHeader.vue` | NEW (§1.3) | F04 PR |
| `web/src/components/chat/MessageList.vue` | NEW (§1.4) | F04 PR |
| `web/src/components/chat/MessageItem.vue` | NEW (§1.5) | F04 PR |
| `web/src/components/chat/JumpToLatest.vue` | NEW (§1.6) | F04 PR |
| `web/src/components/chat/ChatComposer.vue` | NEW (§1.7) | F04 PR |
| `web/src/components/chat/UnauthorizedNotice.vue` | NEW (§1.8) | F04 PR |
| `web/src/components/chat/tool-chip-adapter.ts` | consumed; introduced by F03 PR (now eight-prop bag, §1.10) | F03 PR |
| `web/src/composables/useDebouncedConnectionState.ts` | NEW (§1.9, Readonly-ref param) | F04 PR |
| `web/src/composables/useStickToBottom.ts` | NEW (§1.9) | F04 PR |
| `web/src/utils/analyst-timeline.ts` | consumed; introduced by F03 PR | F03 PR |
| `web/src/utils/model-label.ts` | NEW (§1.11) | F04 PR |
| `web/src/api/types.ts` | EXTEND `ChatMessage` with 4 optional fields; EXPORT `PendingToolInvocation` (§1.1.1) | F04 PR |
| `web/src/stores/analystChat.ts` | import `PendingToolInvocation` from `../api/types` (delete local copy) | F04 PR |

Tests (§1.13):

| Test file | Status |
| --- | --- |
| `web/src/__tests__/analyst-chat-panel.test.ts` | REWRITE selectors + new model-pill gating, connection-chip, thinking-dots cases |
| `web/src/__tests__/analyst-chat-store.test.ts` | fixtures extended; `PendingToolInvocation` import path |
| `web/src/__tests__/components/AnalystChatPanel.children.test.ts` | rewrite three behavior tests + raw-source guard targets the new container |
| `web/src/__tests__/jump-to-latest.test.ts` | NEW |
| `web/src/__tests__/components/chat/MessageList.resize.test.ts` | NEW (B3) |
| `web/src/__tests__/components/chat/tool-chip-adapter.test.ts` | adds eight-prop bag cases (P3) |
| `web/src/__tests__/composables/useStickToBottom.test.ts` | NEW |
| `web/src/__tests__/composables/useDebouncedConnectionState.test.ts` | NEW + Readonly-ref case (P2) |
| `web/src/__tests__/utils/analyst-timeline.test.ts` | NEW |
| `web/src/__tests__/utils/model-label.test.ts` | NEW (B2 gate contract) |
| `web/src/__tests__/analyst-toaster.test.ts` | NOT TOUCHED |
| `web/src/__tests__/analyst-chat-error-states.test.ts` | does not exist; do not create |

Cross-issue ordering (F04 r3 §11 binding, mirrored by F03 r2 §8):
F01 r2 → F02 r2 → F05 r2 → F03 r2 (chip swap inside the F03 PR) →
F04 (this issue, no chip swap, only decomposition + composables +
layout + styling).
