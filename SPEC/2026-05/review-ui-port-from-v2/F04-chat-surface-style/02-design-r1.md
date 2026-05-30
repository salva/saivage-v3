# F04 — Chat / analyst surface style — Design (r1)

Writer round 1 design. Binds to the approved analysis:
[01-analysis-r3.md](01-analysis-r3.md). Cross-issue binding analyses:
[F01 r2](../F01-design-tokens/01-analysis-r2.md),
[F02 r2](../F02-component-hierarchy/01-analysis-r2.md),
[F03 r2](../F03-conversation-rounds/01-analysis-r2.md),
[F05 r2](../F05-tool-detail-rendering/01-analysis-r2.md).

Project guideline (binding): **architecture-first, no backward
compatibility**. No fallback styles, no `.tool-chip*` survivors, no
adapter shims, no parallel auth/WS state machine, no `:view` /
`:message` chat-local chip API. The `AnalystChatPanel` chip swap
lands inside the F03 PR (per F03 r2 §8.2 and F04 r3 §11.2); F04 owns
the chat-surface **decomposition, layout, composables, and
styling** only.

This design enumerates two proposals (A and B) with complete file
layouts, Vue SFC skeletons, composable signatures, adapter contracts
that match F03 r2 §7.2 verbatim, narrow-rail layout rules, the
`ChatMessage` type extension, and a per-file test inventory. The
recommendation at §3 selects one.

---

## 0. Scope reminder

- **In scope** (F04 PR): decompose `AnalystChatPanel.vue` into
  `chat/ChatHeader`, `chat/MessageList`, `chat/MessageItem`,
  `chat/JumpToLatest`, `chat/ChatComposer`; introduce
  `useDebouncedConnectionState`, `useStickToBottom`; introduce
  `web/src/utils/analyst-timeline.ts` (pairing utility) and
  `web/src/utils/model-label.ts`; narrow-rail layout rules; consume
  F02 r2 `ui/`/`content/`/`conversation/` primitives; consume F03 r2
  shared `<ToolChip>` via the adapter shape defined in F04 r3 §4.1.
- **Already-landed before F04 starts**: F03 PR has replaced the
  in-line `<button class="tool-chip">` markup inside the monolithic
  `AnalystChatPanel.vue` with `<ToolChip v-bind="…">`, introduced
  `web/src/components/chat/tool-chip-adapter.ts`, and migrated the
  `analyst-chat-panel.test.ts` chip selectors. F04 inherits that
  HEAD and only relocates the call site into `chat/MessageItem.vue`.
- **Out of scope**: any `useWebSocket`/`useAuthState` port from v2,
  any port of v2's `ChatWindow.vue`, any `ApiTokenEntry` redesign,
  toaster changes (F01/F02 own them), `analyst-chat-error-states.test.ts`
  (does not exist), F03's round/timeline structure on the analyst
  surface, `requestedModelSpec` UI rendering.

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

web/src/api/types.ts         [EXTEND ChatMessage with 4 optional model fields, §1.7]
```

No new files outside `chat/`, `composables/`, `utils/`. Every other
F02 r2 surface is consumed unchanged. The toaster, `ApiTokenEntry`,
the WS store, the runtime store, the analyst-chat Pinia store, and
the workspace-route store are read-only dependencies.

### 1.2 `AnalystChatPanel.vue` — container after rewrite

Sole responsibilities: bind stores, derive `unauthorized` +
`debouncedConnectionState`, register the `saivage:focus-chat`
listener, lay out four children, compute `pairedTimeline`, compute
`jumpBottomOffsetPx` from `composerHeightPx + pendingFooterPx`.

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
      :unauthorized="unauthorized"
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

const {
  activeSessionId, messages, draft,
  sessionsLoading, sessionsError,
  messagesLoading, messagesError,
  sending, sendError,
  pendingToolInvocations, messageBadges,
  activeSessionWritable, thinking,
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
function onComposerResize(heightPx: number)  { composerHeightPx.value = heightPx; }
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

### 1.3 `chat/ChatHeader.vue`

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
  unauthorized: boolean;
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

### 1.4 `chat/MessageList.vue`

Owns the scroll body, the on-screen-children block, the thinking
footer, the pending-tool footer (sibling section with its own
`ResizeObserver`), and the state panels. Pairs delegated to
`MessageItem`. The pending-tool block renders the **same** shared
`<ToolChip>` via `adaptPendingInvocationToToolChip`.

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

      <ThinkingDots v-if="thinking" />
    </template>

    <section
      ref="pendingFooterEl"
      v-if="pendingTools.length"
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
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ChatMessage, PendingToolInvocation, DetailErrorState, CardRecord } from '../../api/types';
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

let observer: ResizeObserver | null = null;
onMounted(() => {
  observer = new ResizeObserver((entries) => {
    const h = entries[0]?.contentRect.height ?? 0;
    emit('resize', Math.round(h));
  });
  if (pendingFooterEl.value) observer.observe(pendingFooterEl.value);
});
watch(pendingFooterEl, (el, _prev, onCleanup) => {
  if (observer && el) observer.observe(el);
  onCleanup(() => { if (observer && el) observer.unobserve(el); });
});
onBeforeUnmount(() => observer?.disconnect());

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

### 1.5 `chat/MessageItem.vue`

Renders a single row. Branches on `item.kind`. The shared
`<ToolChip>` consumes the F03 r2 §7.2 prop bag via `v-bind=`. No
`:view`, no `:message`.

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
            v-if="shortModelLabel(item.message)"
            :title="modelLabel(item.message, defaultModelSpec) ?? undefined"
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
import type { AnalystTimelineItem } from '../../utils/analyst-timeline';
import { adaptChatMessageToToolChip } from './tool-chip-adapter';
import { modelLabel, shortModelLabel } from '../../utils/model-label';

import ToolChip from '../conversation/ToolChip.vue';
import MessageBubble from '../conversation/MessageBubble.vue';
import MarkdownText from '../content/MarkdownText.vue';
import Pill from '../ui/Pill.vue';

interface TimelineBadge { label: string; timestamp: string }

defineProps<{
  item: AnalystTimelineItem;
  badges: TimelineBadge[] | undefined;
  expanded: boolean;
  defaultModelSpec: string | null;
}>();
defineEmits<{ (e: 'toggle', id: string): void }>();
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

### 1.9 Composables

`useDebouncedConnectionState.ts`:

```ts
import { ref, watch, onUnmounted, type Ref } from 'vue';
import type { WsConnectionState } from '../api/types';

const TO_OPEN_IMMEDIATE: readonly WsConnectionState[] = ['connected'];
const DEBOUNCE_MS = 400;

export function useDebouncedConnectionState(
  source: Ref<WsConnectionState>,
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

### 1.10 Adapter contract (already in HEAD via F03's PR)

F04 r3 §4.1 fixes the contract; the F03 PR ships the file. F04
re-uses it unchanged. Restated here for binding clarity — both
adapters MUST produce the F03 r2 §7.2 prop bag verbatim:

```ts
export interface ToolChipProps {
  call: ToolCallPresentation;          // F05 r2 §2
  result: ToolResultPresentation | null;
  status: ToolPairStatus;              // F03 r2 §3.3: pending | ok | error | orphan | missing
  expanded: boolean;
  detailsId: string;                   // `tool-detail-${toolUseId}` or `tool-detail-pending-${pendingId}`
  timestamp?: string;
}

export function adaptChatMessageToToolChip(
  call: ChatMessage,                   // kind === 'tool_call' (or synthetic for orphan)
  result: ChatMessage | null,
  expanded: boolean,
): ToolChipProps;

export function adaptPendingInvocationToToolChip(
  pending: PendingToolInvocation,
  expanded: boolean,
): ToolChipProps;

export function synthesizeCallFromResult(result: ChatMessage): ChatMessage;
```

Render sites in F04:

- `chat/MessageItem.vue`: `<ToolChip v-bind="adaptChatMessageToToolChip(item.call, item.result, expanded)" @toggle="$emit('toggle', item.id)" />`
- `chat/MessageList.vue` (pending footer): `<ToolChip v-bind="adaptPendingInvocationToToolChip(p, expandedIds.has(p.id))" @toggle="$emit('toggle', p.id)" />`

No `:view`. No `:message`. No chat-local chip API.

### 1.11 `ChatMessage` type extension (additive, optional)

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

export function shortModelLabel(msg: ChatMessage): string | null {
  if (msg.role !== 'assistant') return null;
  const spec = msg.modelSpec ?? (msg.provider && msg.model ? `${msg.provider}/${msg.model}` : null);
  if (!spec) return null;
  const i = spec.lastIndexOf('/');
  return i >= 0 ? spec.slice(i + 1) : spec;
}
```

The `MessageItem` uses `shortModelLabel(msg)` for visible text and
`modelLabel(msg, defaultModelSpec)` for `title`. Chip is hidden when
`modelLabel` returns `null` (i.e. spec matches the default and no
`requestedModelSpec` is set).

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
  height is emitted via `@resize`. When empty (no children), the
  section is absent and the emitted value is `0`.
- v2's `min(780px, 92%)` bubble clamp is **not** ported. Bubbles fill
  the rail width.

### 1.13 Test inventory (per file)

`web/src/__tests__/analyst-chat-panel.test.ts` — **rewrite**:

- Send button selector: `wrapper.get('[data-testid="analyst-send"]')`.
- Chip selectors: `wrapper.findAll('[data-testid="tool-chip"]')`,
  status via `chip.attributes('data-status')`.
- Pending chip: `'[data-testid="tool-chip"][data-status="pending"]'`.
- Expansion reveals `[data-testid="formatted-content"]` (F05 r2
  `<FormattedContent>` inside the chip body).
- `saivage:focus-chat` dispatch → composer textarea is active element.
- Read-only tooltip: send button `title` equals
  `'Read-only — switch to analyst to send messages'` when
  `activeSessionWritable === false`.
- Empty / loading / unauthorized / error state assertions via text
  queries against the F02 `<Card>` outputs.
- New: model-pill ellipsis — long `modelSpec` produces a
  `[data-testid="model-pill"]` whose visible text is the short form
  and whose `title` is the full string.
- New: header connection chip — `[data-testid="connection-chip"]`
  `data-state` reflects the debounced state.

`web/src/__tests__/analyst-chat-store.test.ts` — **fixtures +
assertions**:

- Fixtures accept `provider?`, `model?`, `modelSpec?`,
  `requestedModelSpec?` on `ChatMessage` (no test asserts they are
  required).
- Pending-tool dedupe assertions stay as-is.

`web/src/__tests__/components/AnalystChatPanel.children.test.ts` —
**non-prefix sibling, separate**:

- `wrapper.find('[data-testid="on-screen-children"]')` (replaces
  `.on-screen-children` class lookup; the class is preserved as a
  layout class but the test moves to a stable data-testid).
- `aria-labelledby="on-screen-title"` unchanged.
- The three existing tests survive as-is.

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

`web/src/__tests__/utils/analyst-timeline.test.ts` — **new**:

- Pairs `tool_call` + `tool_result` by `tool_call_id`.
- Emits `result: null` when only a call exists.
- Emits an orphan pair (`call = synthesized`, `result = real`) when
  only a result exists.

`web/src/__tests__/utils/model-label.test.ts` — **new**:

- Returns null for non-assistant messages.
- Returns null when `spec === defaultModelSpec` and no
  `requestedModelSpec`.
- Returns full spec otherwise; `shortModelLabel` returns the suffix.

`web/src/__tests__/analyst-chat-error-states.test.ts` — **does not
exist; do not create**.

`web/src/__tests__/components/conversation/ToolChip.test.ts` —
**owned by F02/F03; F04 does not duplicate**. F04 only adds adapter
unit tests under `__tests__/components/chat/tool-chip-adapter.test.ts`
(introduced by F03 PR; F04 may add cases for the pending path if
F03's coverage didn't include them).

---

## 2. Proposal B — One level up: `useChatSurface` composable

**Premise**: instead of letting `AnalystChatPanel.vue` keep its own
ad-hoc derivation of `pairedTimeline`, `defaultModelSpec`,
`debouncedConnectionState`, `unauthorized`, `expandedIds`,
`stuckToBottom`, `unseenCount`, `jumpBottomOffsetPx`, and the
`saivage:focus-chat` handler, extract the **entire chat state
machine** into a single composable `useChatSurface(...)`. The five
child SFCs become pure render shells driven by the composable's
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

web/src/api/types.ts         [EXTEND ChatMessage with 4 optional fields]
```

The two leaf composables (`useDebouncedConnectionState`,
`useStickToBottom`) remain — they are mechanically independent and
the surface composable consumes them. Only the **container's
glue logic** is centralised.

### 2.2 `useChatSurface.ts` — full signature

```ts
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRef, type Ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useAnalystChat } from '../stores/analystChat';
import { useCardStore } from '../stores/cards';
import { useWorkspaceRouteStore } from '../stores/workspaceRoute';
import { useWsStore } from '../stores/ws';
import { useRuntimeStore } from '../stores/runtime';
import { pairAnalystMessages, type AnalystTimelineItem } from '../utils/analyst-timeline';
import type { CardRecord, ChatMessage, DetailErrorState, PendingToolInvocation, WsConnectionState } from '../api/types';
import { useDebouncedConnectionState } from './useDebouncedConnectionState';

export interface ChatSurfaceComposerRef { focus(): void }
export interface ChatSurfaceListRef     { jumpToLatest(): void }

export interface UseChatSurfaceOptions {
  /** Window CustomEvent name to focus the composer (default: 'saivage:focus-chat'). */
  focusEventName?: string;
  /** Read-only tooltip used when activeSessionWritable === false. */
  readOnlyTooltip?: string;
}

export interface UseChatSurfaceReturn {
  // refs to inject onto the rendered children
  composerRef: Ref<ChatSurfaceComposerRef | null>;
  messageListRef: Ref<ChatSurfaceListRef | null>;

  // derived state passed straight to props
  activeSessionId: Ref<string | null>;
  pairedTimeline: Ref<AnalystTimelineItem[]>;
  pendingTools: Ref<PendingToolInvocation[]>;
  badges: Ref<Record<string, { label: string; timestamp: string }[]>>;
  thinking: Ref<boolean>;
  onScreenChildren: Ref<CardRecord[]>;
  defaultModelSpec: Ref<string | null>;

  // session/messages lifecycle
  sessionsLoading: Ref<boolean>;
  sessionsError: Ref<DetailErrorState | null>;
  messagesLoading: Ref<boolean>;
  messagesError: Ref<DetailErrorState | null>;
  sending: Ref<boolean>;
  sendError: Ref<DetailErrorState | null>;

  // composer state
  draft: Ref<string>;
  setDraft(value: string): void;
  activeSessionWritable: Ref<boolean>;
  composerTitle: Ref<string>;

  // connection state
  connectionState: Ref<WsConnectionState>;        // raw (NOT debounced); for unauthorized derivation
  debouncedConnectionState: Ref<WsConnectionState>;
  unauthorized: Ref<boolean>;

  // expand/collapse
  expandedIds: Ref<Set<string>>;
  toggleExpanded(id: string): void;

  // stickiness — owned by the MessageList; the composable mirrors the values
  stuckToBottom: Ref<boolean>;
  unseenCount: Ref<number>;
  onStickinessChange(payload: { stuck: boolean; unseen: number }): void;

  // jump-to-latest geometry
  composerHeightPx: Ref<number>;
  pendingFooterPx: Ref<number>;
  jumpBottomOffsetPx: Ref<number>;
  onComposerResize(heightPx: number): void;
  onPendingFooterResize(heightPx: number): void;
  jumpToLatest(): void;

  // actions
  submitMessage(): Promise<void>;
  openTokenEntry(): void;
}

export function useChatSurface(options?: UseChatSurfaceOptions): UseChatSurfaceReturn;
```

Implementation (abridged — the body is the union of `AnalystChatPanel`'s
current script and Proposal A §1.2's script, minus the template
plumbing):

```ts
export function useChatSurface(options: UseChatSurfaceOptions = {}): UseChatSurfaceReturn {
  const focusEventName  = options.focusEventName  ?? 'saivage:focus-chat';
  const readOnlyTooltip = options.readOnlyTooltip ?? 'Read-only — switch to analyst to send messages';

  const chat = useAnalystChat();
  const cards = useCardStore();
  const workspaceRoute = useWorkspaceRouteStore();
  const ws = useWsStore();
  const runtime = useRuntimeStore();

  const {
    activeSessionId, messages, draft,
    sessionsLoading, sessionsError,
    messagesLoading, messagesError,
    sending, sendError,
    pendingToolInvocations, messageBadges,
    activeSessionWritable, thinking,
  } = storeToRefs(chat);

  const composerRef    = ref<ChatSurfaceComposerRef | null>(null);
  const messageListRef = ref<ChatSurfaceListRef     | null>(null);
  const expandedIds    = ref<Set<string>>(new Set());

  const pairedTimeline = computed(() => pairAnalystMessages(messages.value));
  const pendingTools   = computed(() =>
    pendingToolInvocations.value.filter((p) => p.sessionId === activeSessionId.value),
  );
  const onScreenChildren = computed(() =>
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

  const connectionState = toRef(ws, 'connectionState');
  const { debounced: debouncedConnectionState } = useDebouncedConnectionState(connectionState);
  const unauthorized = computed(() =>
    ws.connectionState === 'unauthorized' ||
    ws.connectionState === 'no-token' ||
    runtime.unauthorized,
  );

  const composerTitle = computed(() =>
    activeSessionWritable.value ? 'Ask the analyst…' : readOnlyTooltip,
  );

  const stuckToBottom = ref(true);
  const unseenCount   = ref(0);
  function onStickinessChange(p: { stuck: boolean; unseen: number }) {
    stuckToBottom.value = p.stuck;
    unseenCount.value   = p.unseen;
  }

  const composerHeightPx = ref(64);
  const pendingFooterPx  = ref(0);
  const jumpBottomOffsetPx = computed(() => composerHeightPx.value + pendingFooterPx.value);
  function onComposerResize(h: number)      { composerHeightPx.value = h; }
  function onPendingFooterResize(h: number) { pendingFooterPx.value  = h; }
  function jumpToLatest()                   { messageListRef.value?.jumpToLatest(); }

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
    window.addEventListener(focusEventName, handleFocusChat);
    void chat.fetchSessions().then(() => chat.fetchMessages()).catch(() => {});
    handleFocusChat();
  });
  onBeforeUnmount(() => window.removeEventListener(focusEventName, handleFocusChat));

  return {
    composerRef, messageListRef,
    activeSessionId, pairedTimeline, pendingTools,
    badges: messageBadges, thinking, onScreenChildren, defaultModelSpec,
    sessionsLoading, sessionsError, messagesLoading, messagesError, sending, sendError,
    draft, setDraft: chat.setDraft, activeSessionWritable, composerTitle,
    connectionState, debouncedConnectionState, unauthorized,
    expandedIds, toggleExpanded,
    stuckToBottom, unseenCount, onStickinessChange,
    composerHeightPx, pendingFooterPx, jumpBottomOffsetPx,
    onComposerResize, onPendingFooterResize, jumpToLatest,
    submitMessage, openTokenEntry,
  };
}
```

### 2.3 `AnalystChatPanel.vue` after Proposal B

```vue
<template>
  <aside
    id="analyst-chat-panel"
    class="analyst-chat-panel"
    role="region"
    aria-label="Analyst chat"
    :style="{ '--chat-jump-bottom': `${s.jumpBottomOffsetPx.value}px` }"
  >
    <ChatHeader
      :session-id="s.activeSessionId.value"
      :connection-state="s.debouncedConnectionState.value"
      :unauthorized="s.unauthorized.value"
      :sessions-loading="s.sessionsLoading.value"
      :sessions-error="s.sessionsError.value"
    >
      <template #state>
        <UnauthorizedNotice
          v-if="s.unauthorized.value"
          @open-token-entry="s.openTokenEntry()"
        />
      </template>
    </ChatHeader>

    <MessageList
      :ref="(el) => (s.messageListRef.value = el as any)"
      :items="s.pairedTimeline.value"
      :pending-tools="s.pendingTools.value"
      :badges="s.badges.value"
      :thinking="s.thinking.value"
      :on-screen-children="s.onScreenChildren.value"
      :expanded-ids="s.expandedIds.value"
      :messages-loading="s.messagesLoading.value"
      :messages-error="s.messagesError.value"
      :default-model-spec="s.defaultModelSpec.value"
      @toggle="s.toggleExpanded($event)"
      @stickiness-change="s.onStickinessChange($event)"
      @resize="s.onPendingFooterResize($event)"
    />

    <JumpToLatest
      v-if="!s.stuckToBottom.value"
      :unseen="s.unseenCount.value"
      :bottom-offset-px="s.jumpBottomOffsetPx.value"
      @jump="s.jumpToLatest()"
    />

    <ChatComposer
      :ref="(el) => (s.composerRef.value = el as any)"
      :draft="s.draft.value"
      :disabled="!s.activeSessionWritable.value"
      :sending="s.sending.value"
      :tooltip="s.composerTitle.value"
      :send-error="s.sendError.value"
      @update:draft="s.setDraft($event)"
      @submit="s.submitMessage()"
      @resize="s.onComposerResize($event)"
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

const s = useChatSurface();
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

The container shrinks from ~440 lines today to ~35 lines (template
plus `const s = useChatSurface()`).

### 2.4 Where the v3-only features live in Proposal B

- **On-screen children** — derived inside `useChatSurface` from
  `cards.childrenOf(workspaceRoute.entityId)`; rendered inside
  `MessageList.vue` (identical to Proposal A).
- **Pending tool invocations** — already filtered by
  `useChatSurface` (`pendingTools`); rendered inside `MessageList`'s
  pending footer (identical to Proposal A).
- **Per-message badges** — flowed through `MessageList → MessageItem`
  (identical).
- **Read-only tooltip** — `composerTitle` computed inside
  `useChatSurface`; consumed by `ChatComposer`.
- **`saivage:focus-chat` shortcut** — handler installed inside
  `useChatSurface` (`onMounted` / `onBeforeUnmount`).
- **`ApiTokenEntry` modal** — `useChatSurface.openTokenEntry()`
  dispatches `saivage:open-token-entry`; `ApiTokenEntry`'s mount
  listens for that event today (unchanged).
- **State panels** (sessionsLoading / messagesLoading /
  messagesError.unauthorized / sendError) — refs forwarded by
  `useChatSurface` to `ChatHeader` / `MessageList` / `ChatComposer`.

Every v3-only feature is preserved. The only structural change vs
Proposal A is that the container no longer owns the derivation.

### 2.5 Adapter contract under Proposal B

Identical to Proposal A §1.10 — the adapter is a per-message
function, not surface state, so it does **not** live inside
`useChatSurface`. F03 PR ships `tool-chip-adapter.ts`; F04 (under
either proposal) imports the two exported adapter functions at the
two render sites.

### 2.6 Narrow-rail layout rules under Proposal B

Identical to Proposal A §1.12. The composable does not touch CSS;
geometry refs (`composerHeightPx`, `pendingFooterPx`,
`jumpBottomOffsetPx`) drive the `--chat-jump-bottom` variable on the
container exactly as in Proposal A.

### 2.7 `ChatMessage` extension under Proposal B

Identical to Proposal A §1.11.

### 2.8 Test inventory under Proposal B

The per-component tests are identical to Proposal A's (§1.13).
The differences are:

- `web/src/__tests__/analyst-chat-panel.test.ts` — **same test
  cases, but a substantial fraction become trivial** because the
  container has almost no logic. Tests that exercised
  `pairedTimeline`, `defaultModelSpec`, `unauthorized`, etc. against
  the panel move to a new file (next bullet).
- `web/src/__tests__/composables/useChatSurface.test.ts` — **new**:
  - mounts a stub component, calls `useChatSurface()`, asserts every
    derived ref against the underlying Pinia stores.
  - `submitMessage` invokes `chat.sendMessage` and refocuses the
    composer ref.
  - `saivage:focus-chat` dispatch invokes `composerRef.focus()`.
  - `openTokenEntry` dispatches `saivage:open-token-entry`.
  - `toggleExpanded` adds/removes from the set immutably.
  - `onStickinessChange` mirrors stuck + unseen.
  - `jumpBottomOffsetPx` recomputes when composer or pending
    resizes.
  - asymmetric debounce delegated to
    `useDebouncedConnectionState.test.ts`.
- `web/src/__tests__/composables/useStickToBottom.test.ts` and
  `web/src/__tests__/composables/useDebouncedConnectionState.test.ts`
  — identical to Proposal A.

Test surface area is **larger**, but each test is smaller and more
focused. Proposal A's biggest test file (`analyst-chat-panel.test.ts`)
shrinks; the new `useChatSurface.test.ts` absorbs the logic
assertions.

### 2.9 Architectural payoff (claimed)

1. The chat state machine becomes reusable. A future
   `CardCommentsPanel`, `GoalDiscussionPanel`, or `RetroThreadPanel`
   could call `useChatSurface(options)` with a different
   `focusEventName` and a different store wired in.
2. The `AnalystChatPanel.vue` SFC stops being a god-container — it
   collapses to a layout shell. The 440 → 35 LOC reduction is
   architecturally clean.
3. Logic tests live next to logic. The panel test stops asserting
   over derived refs; the composable test does.

### 2.10 Architectural cost

1. The composable is **single-use today**. The `useAnalystChat`
   store is hard-wired inside `useChatSurface`. To reuse for a
   second surface, `useChatSurface` would need to accept the store
   factory as a parameter — i.e. the composable doesn't actually
   become generic until a second consumer arrives. Designing for
   a hypothetical future surface is YAGNI.
2. The Pinia store layer **is already the composable layer**. v3
   stores are not REST clients; they expose refs and actions.
   Extracting another layer between the store and the SFC adds
   indirection without changing the dependency direction.
3. Auto-unwrapped refs work in Proposal A's templates
   (`{{ activeSessionId }}` from `storeToRefs`). Proposal B's
   container reads `s.activeSessionId.value` because the composable
   returns a record of refs. Either reactivity surface works, but
   B's adds a `.value` per binding in the template.
4. The cross-issue review surface area grows: every reviewer of F04
   r2 (and beyond) has to read both `AnalystChatPanel.vue` AND
   `useChatSurface.ts`, where Proposal A keeps the entire surface
   logic in one short container file.

---

## 3. Recommendation — **Proposal A**

F04 r3's analysis is approved and binding (§0 coverage map, §3.1
container responsibilities, §4 adapter shape, §5 composables, §8
narrow-rail rules, §11.2 chip swap timing). Proposal A is a
verbatim implementation of that analysis. The brief asks the design
to genuinely develop an alternative; Proposal B above does that.
The recommendation must now choose, with reasoning across four
axes.

**Clean architecture.** Both proposals decompose the same way. The
difference is where the glue lives — inside the container (A) or
inside a composable (B). v3's Pinia stores already expose the
shape a composable would expose; the analyst-chat store already
holds `messages`, `draft`, `sending`, `sendError`, `pendingToolInvocations`,
`messageBadges`, `activeSessionWritable`, `thinking`, plus actions
`fetchSessions` / `fetchMessages` / `setDraft` / `sendMessage`.
Wrapping that store in `useChatSurface` adds a layer that exists
only to hold ~20 derived refs and three event handlers. The result
is more code, not less. Proposal A keeps the dependency arrow
straight (store → container → composites); Proposal B inserts a
parallel composable that re-exports the store.

**F03 chip alignment.** Both proposals consume the same
`tool-chip-adapter.ts` introduced by F03's PR. The render sites
(MessageItem for paired, MessageList for pending) are identical.
Neither proposal is preferred on this axis.

**Preservation of v3-only features.** Both proposals preserve
on-screen children, pending invocations, badges, read-only tooltip,
focus-chat shortcut, `ApiTokenEntry`, and the state panels.
Proposal B routes them through `useChatSurface`; Proposal A keeps
them in the container. The features survive equally; the routing
choice is stylistic.

**Narrow-rail constraints.** The narrow-rail rules (F04 r3 §8) are
expressed as concrete `min-width: 0`, `max-width: calc(100% - 24px)`,
and `position: absolute` rules inside the new SFCs. Both proposals
land them in the same files. The composable in B has no effect on
the rail constraints.

**Reusability.** Proposal B's headline claim is that a future chat
surface (card-comments, goal discussion) will reuse
`useChatSurface`. Today, that surface does not exist. The
analyst-chat store is hard-wired into `useChatSurface`; making it
parametric would mean accepting `chatStore` and `wsStore` factories
as options, which is a more invasive change than F04 should adopt
speculatively. The project guideline "architecture-first, no
backward compatibility" prizes removing layers, not adding them.
Adding `useChatSurface` to support a single consumer is the
opposite move.

**Test cost.** Proposal A keeps the existing
`analyst-chat-panel.test.ts` as the integration surface, plus four
small new test files (composables × 2, utils × 2,
`jump-to-latest.test.ts`). Proposal B adds a fifth new file
(`useChatSurface.test.ts`) that re-asserts what the store tests
already assert, only one wrapper layer down.

**Verdict.** **Proposal A is selected.** It implements the approved
F04 r3 analysis verbatim, keeps the dependency arrow simple, and
does not introduce a speculative abstraction. Proposal B is
recorded here so it can be reconsidered if a second chat surface
materialises — at that point the refactor from container-owned
state to `useChatSurface` is mechanical and self-contained, since
Proposal A already pre-factored the leaf composables
(`useDebouncedConnectionState`, `useStickToBottom`) that
`useChatSurface` would consume.

---

## 4. Selected design — implementation summary

For clarity, the selected (Proposal A) deliverables are:

| File | Status | Owner |
| --- | --- | --- |
| `web/src/components/chat/AnalystChatPanel.vue` | REWRITE (container, §1.2) | F04 PR |
| `web/src/components/chat/ChatHeader.vue` | NEW (§1.3) | F04 PR |
| `web/src/components/chat/MessageList.vue` | NEW (§1.4) | F04 PR |
| `web/src/components/chat/MessageItem.vue` | NEW (§1.5) | F04 PR |
| `web/src/components/chat/JumpToLatest.vue` | NEW (§1.6) | F04 PR |
| `web/src/components/chat/ChatComposer.vue` | NEW (§1.7) | F04 PR |
| `web/src/components/chat/UnauthorizedNotice.vue` | NEW (§1.8) | F04 PR |
| `web/src/components/chat/tool-chip-adapter.ts` | consumed; introduced by F03 PR | F03 PR |
| `web/src/composables/useDebouncedConnectionState.ts` | NEW (§1.9) | F04 PR |
| `web/src/composables/useStickToBottom.ts` | NEW (§1.9) | F04 PR |
| `web/src/utils/analyst-timeline.ts` | consumed; introduced by F03 PR | F03 PR |
| `web/src/utils/model-label.ts` | NEW (§1.11) | F04 PR |
| `web/src/api/types.ts` | EXTEND `ChatMessage` with 4 optional fields | F04 PR |

Tests (§1.13):

| Test file | Status |
| --- | --- |
| `web/src/__tests__/analyst-chat-panel.test.ts` | REWRITE selectors + new model-pill / connection-chip cases |
| `web/src/__tests__/analyst-chat-store.test.ts` | fixtures extended |
| `web/src/__tests__/components/AnalystChatPanel.children.test.ts` | data-testid migration |
| `web/src/__tests__/jump-to-latest.test.ts` | NEW |
| `web/src/__tests__/composables/useStickToBottom.test.ts` | NEW |
| `web/src/__tests__/composables/useDebouncedConnectionState.test.ts` | NEW |
| `web/src/__tests__/utils/analyst-timeline.test.ts` | NEW |
| `web/src/__tests__/utils/model-label.test.ts` | NEW |
| `web/src/__tests__/analyst-toaster.test.ts` | NOT TOUCHED |
| `web/src/__tests__/analyst-chat-error-states.test.ts` | does not exist; do not create |

Cross-issue ordering (F04 r3 §11 binding): F01 r2 → F02 r2 → F05 r2
→ F03 r2 (chip swap inside the F03 PR) → F04 (this issue, no chip
swap, only decomposition + composables + layout + styling).
