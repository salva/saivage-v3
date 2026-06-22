# F03 — Conversation rounds / diagnostics / pairing — Functional analysis (r2)

Writer round 2. Addresses every required item in
[01-analysis-review-r1.md](01-analysis-review-r1.md). Previous draft:
[01-analysis-r1.md](01-analysis-r1.md). Issue:
[F03-conversation-rounds.md](../F03-conversation-rounds.md). Map:
[00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md). Approved cross-issue
analyses this document is binding-aligned with:
[F02 r2](../F02-component-hierarchy/01-analysis-r2.md),
[F05 r2](../F05-tool-detail-rendering/01-analysis-r2.md).

Project guideline (binding): **architecture-first, no backward
compatibility**. Every replaced surface, type, route field, schema
field, persistence shape, and test is removed in the same change set
as its replacement. No aliasing, no `messages`→`entries` adapter,
no `legacySteps` getter, no `groupIntoSteps()` survivor, no
schema-level optional fields kept "until later".

---

## 0. Required-changes coverage map

| # | Required change (from review)                                                            | Addressed in                                            |
| - | ---------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1 | Align components with F02 layering (`ui/`, `content/`, `conversation/`, pure non-SFC dir) | [§3](#3-proposed-f03-surface)                           |
| 2 | Replace v2 `formatToolPair`/`InlinePart project|saivage` with F05 r2 contract             | [§7](#7-tool-pair-composition-over-f05-presenters)      |
| 3 | One canonical wire shape `{ session, entries, activity_status }`; delete `messages`/`steps` | [§4](#4-wire-contract)                                |
| 4 | Backend `tool_call_id` scalar must be persisted on `tool_call` records too                | [§5.5](#55-tool_call_id-scalar-gap)                     |
| 5 | Full backend round-stamping contract (counters, append paths, schemas, persistence)       | [§5](#5-backend-round-stamping-contract)                |
| 6 | `activity_status` non-optional in F03 response; authoritative source defined              | [§6](#6-activity-status-pipeline)                       |
| 7 | WS vs polling: piggyback on `thinking`/`activity`; explicitly reject new event            | [§6.4](#64-ws-and-rest-polling-protocol)                |
| 8 | Explicit test plan with named cases                                                       | [§10](#10-test-plan)                                    |
| 9 | Resolve AnalystChatPanel contradiction — shared `ToolChip`, dependency edge               | [§8](#8-cross-issue-ordering)                           |
| 10| Alternative: backend-driven rounds vs view-side bucketing                                 | [§9](#9-alternative-considered)                         |
| 11| Tighten scope: depend on F05's `FormattedContent`/`JsonView`/presenters, don't port 692-line formatter | [§7](#7-tool-pair-composition-over-f05-presenters), [§11](#11-out-of-scope) |

---

## 1. v2 behavior inventory

Source of truth: the already-split agents folder under
[saivage/web/src/components/agents/](../../../../saivage/web/src/components/agents/).
v3 ports those files — it does not re-derive the algorithm.

### 1.1 Round bucketing

Entries are grouped by `roundId` string
([timeline.ts](../../../../saivage/web/src/components/agents/timeline.ts#L14-L25)).
Round IDs have four shapes
([round-id.ts](../../../../saivage/web/src/components/agents/round-id.ts#L20-L48)):

- `r-pre` — synthetic pre-thread cluster (tier 0).
- `r-msg:N` — user-message-anchored cluster (tier 1, `N` = message index).
- `rK` — assistant turn `K` (tier 2). Leading zeros tolerated; negatives and non-numeric tails are `unknown`.
- `r-compacted-K` — server-emitted compacted cluster (tier 3).
- Anything else → `unknown`; the **entire bucket is dropped**
  ([timeline.ts L31](../../../../saivage/web/src/components/agents/timeline.ts#L31)).

Sort: earliest entry timestamp, ties broken by `(tier, index)` so
`r-pre` precedes `r0`, `r1` precedes `r-compacted-3`, etc.
([timeline.ts L126-L132](../../../../saivage/web/src/components/agents/timeline.ts#L126-L132)).

### 1.2 Tool-pair matching

Inside a non-pre / non-compacted bucket, entries are split into four
sub-streams: `reasoning`, `toolPairs`, `context`, `diagnostics`
([timeline.ts L42-L95](../../../../saivage/web/src/components/agents/timeline.ts#L42-L95)).
A `ToolPair` is identified by `toolUseId`:

- `tool_call` → `pair.call`. Duplicate `toolUseId` overwrites
  ([L62-L69](../../../../saivage/web/src/components/agents/timeline.ts#L62-L69), `existing.call = entry`).
- `tool_result` → `pair.result`, status `ok`.
- `tool_error` → `pair.result`, status `error`.

Five-valued status taxonomy
([types.ts L7](../../../../saivage/web/src/components/agents/types.ts#L7)):
`pending | ok | error | orphan | missing`. `pending` is set
post-hoc by upgrade
([timeline.ts L99-L101](../../../../saivage/web/src/components/agents/timeline.ts#L99-L101))
on any pair with `call && !result` whose round equals the argument
`pendingRoundId`. `orphan` is what a `tool_result` with no matching
call collapses to.

Entries missing `toolUseId` are dropped with `console.warn` once per
drop ([timeline.ts L4-L8, L58-L60](../../../../saivage/web/src/components/agents/timeline.ts#L4-L8)).
This is fail-loud at the boundary: the v3 backend MUST always emit
`tool_call_id` or the UI silently swallows tool I/O.

### 1.3 Diagnostic kinds

`model_issue`, `model_repair`, `model_recovered` are first-class
entries (not `text`/`activity`). Tone mapping
([AgentRoundCard.vue L23-L37](../../../../saivage/web/src/components/agents/AgentRoundCard.vue#L23-L37)):
`model_recovered → ok`, `model_repair → warn`, `model_issue → danger`.
A bucket whose ONLY content is diagnostics (no reasoning, no
context, no tool pairs) is promoted to **standalone** `diagnostic`
timeline items, one per entry
([timeline.ts L109-L117](../../../../saivage/web/src/components/agents/timeline.ts#L109-L117)).

### 1.4 Standalone context

A bucket with user/system text but no assistant reasoning emits a
`context` timeline item (left-bordered block)
([AgentConversationPane.vue L150-L163](../../../../saivage/web/src/components/agents/AgentConversationPane.vue#L150-L163),
[timeline.ts L119-L121](../../../../saivage/web/src/components/agents/timeline.ts#L119-L121)).

### 1.5 Compacted clusters

`r-pre` and `r-compacted-N` always render as one `compacted` item: a
collapsible summary `"- compacted, K diagnostic(s) re-keyed -"` with
the full list revealed on click
([AgentConversationPane.vue L165-L186](../../../../saivage/web/src/components/agents/AgentConversationPane.vue#L165-L186)).
Expanded state is keyed by `cluster.id` (= `roundId`).

### 1.6 Ambient model spec

The thread header shows the first round's `modelSpec` as default
([AgentConversationPane.vue L45-L50](../../../../saivage/web/src/components/agents/AgentConversationPane.vue#L45-L50)).
Each round prints `via <modelSpec>` only when its model differs from
default
([AgentRoundCard.vue L40-L45](../../../../saivage/web/src/components/agents/AgentRoundCard.vue#L40-L45)).
Hover title shows `requestedModelSpec` when set (provider re-route).

### 1.7 Pending-call footer

When `conversation.activity_status.pending_call` is non-null, a
`<footer role="status" aria-live="polite">` row renders at the
bottom of the thread
([AgentConversationPane.vue L188-L208](../../../../saivage/web/src/components/agents/AgentConversationPane.vue#L188-L208)),
in two modes:

- `in_flight`: `"Waiting for model... 12s (attempt N)"` — `(attempt N)` only when `attempt > 1`.
- `backoff`: `"Throttled by provider - retrying in 8s"` or `"Transient model error - retrying in 8s"`; trailing `attempt N` chip; `retry_at` countdown via `durationUntil`.

`pendingRoundId` is derived by scanning entries for the highest
tier-2 `rK` index
([AgentConversationPane.vue L31-L43](../../../../saivage/web/src/components/agents/AgentConversationPane.vue#L31-L43)).

### 1.8 Expand / collapse details

`expanded: Set<string>` is shared across all timeline items, keyed by
`pair.toolUseId` and `cluster.id` (= `roundId`). The set is cleared
on agent switch.

### 1.9 Scroll-stickiness

Thread body's scroll position is preserved when the user has
scrolled away; auto-scrolls to bottom when they were within
`SCROLL_BOTTOM_TOLERANCE_PX` of the bottom. Implemented in the v2
`useAgentConversation` composable; v3 has nothing equivalent.

### 1.10 Polling cadence

v2 constants (`saivage/web/src/components/agents/constants.ts`):
roster 5 s, conversation 3 s, clock tick 1 s.

---

## 2. v3 gap analysis

### 2.1 Wire / route gap

[src/server/routes/runtime-config-notes.ts L115](../../../src/server/routes/runtime-config-notes.ts#L115)
reads JSONL records via `readAgentMessages` and replies
`{ session, messages }`. No `activity_status`, no `entries`, no
canonical-shape rename. `messages` are persistence records, forwarded
verbatim.

### 2.2 Schema gap

[src/schemas/types.ts L77-L80](../../../src/schemas/types.ts#L77-L80):

```ts
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type MessageKind = 'text' | 'activity' | 'tool_call' | 'tool_result' | 'tool_error' | 'model_issue' | 'model_repair' | 'model_recovered';
export interface AgentMessage { id; session_id; role; kind; content; tool?; tool_call_id?; timestamp; links?; }
```

Missing (must be added in the same commit set as F03's UI port):
`round_id`, `message_index`, `block_index`, `model_spec`,
`requested_model_spec`, plus a sibling `ActivityStatus` type. The
zod validator [src/schemas/validators.ts L44](../../../src/schemas/validators.ts#L44)
is one-line and must mirror the additions.

### 2.3 Persistence gap

[src/agents/session-persistence.ts L209-L246](../../../src/agents/session-persistence.ts#L209-L246):
`appendMessage()` accepts `{ role, kind, content, tool?, tool_call_id?, links? }`
and stamps `id`, `session_id`, `timestamp`. Round-id, message-index,
block-index, and model-spec are not even in the writer signature.
This is the only persistence writer for agent messages.

### 2.4 `tool_call_id` scalar gap (binding)

[agent-adapter.ts L376](../../../src/agents/agent-adapter.ts#L376):

```ts
appendMessage(this.saivageDir, sessionId, { role: 'assistant', kind: 'tool_call', content: JSON.stringify({ toolCalls: [tc] }), tool: tc.function.name });
```

The `tool_call` record has **no** `tool_call_id` scalar — the only
copy of the id is `tc.id` buried inside `content`. Result/error
records on the other hand DO carry the scalar
([L386](../../../src/agents/agent-adapter.ts#L386):
`appendMessage(..., { role: msg.role, kind: msg.kind, content: msg.content, tool: msg.tool, tool_call_id: msg.tool_call_id })`).
This means v2's `entriesToTimeline()` can match v3 results against
v3 calls only by parsing JSON out of `content`, which the algorithm
must never do. Required: stamp the scalar on the call too.

### 2.5 Activity-status gap

There is no `activity_status` anywhere in v3 today. The pieces
needed to derive it exist:

- `agent-adapter` emits `eventBus.emit('retry_attempted', { session_id, role, attempt, directive, failureClass?, recoveryAction?, retryDelayMs? })`
  at [L454](../../../src/agents/agent-adapter.ts#L454) (initial recovery callback) and
  [L559](../../../src/agents/agent-adapter.ts#L559) (in-loop retry decision).
- `agent-adapter` emits `eventBus.emit('invocation_failed', { ..., failureClass, recoveryAction, cooldownMs, retryDelayMs, ... })` at
  [L551](../../../src/agents/agent-adapter.ts#L551) and
  `invocation_succeeded` at [L540](../../../src/agents/agent-adapter.ts#L540).
- `invocation-recovery-policy.ts` is the producer of `retryDelayMs`
  and `cooldownMs`.

Nothing aggregates these into a per-session live status object.
There is no `ActiveRuntime` API to read pending-call state either
(see [src/runtime/active-runtime.ts](../../../src/runtime/active-runtime.ts)
— no retry/attempt/backoff fields).

### 2.6 v3 store and component gaps

[web/src/stores/agents.ts L30-L76](../../../web/src/stores/agents.ts#L30-L76)
implements `MessageStep` + `groupIntoSteps()` flat grouping. Single
consumer:
[web/src/components/agents/AgentConversationView.vue L30-L104](../../../web/src/components/agents/AgentConversationView.vue#L30-L104).
Both are deleted by F03.

Store-level details to note for §6:
[stores/agents.ts L180-L205](../../../web/src/stores/agents.ts#L180-L205)
already does `getAgentConversation(sessionId)` and assigns
`messages.value = response.messages`. The WS path at
[L346-L364](../../../web/src/stores/agents.ts#L346-L364)
appends individual `AgentMessage` items received on `thinking` and
`activity` envelopes. Both REST and WS paths must move to `entries`
+ dedupe-by-`entry.id` (see §6.4).

### 2.7 API types gap

[web/src/api/types.ts](../../../web/src/api/types.ts) has
`AgentConversationResponse = { session: AgentSession; messages: AgentMessage[] }`
and an `AgentMessage` type that mirrors the persistence shape. Both
must be replaced in the same commit (no parallel shim).

---

## 3. Proposed F03 surface

### 3.1 Folder layout (binding to F02 r2)

Per [F02 r2 §1](../F02-component-hierarchy/01-analysis-r2.md#1-shared-layer-split-into-three-sublayers),
shared composites live in `web/src/components/conversation/`, content
renderers in `web/src/components/content/`, base primitives in
`web/src/components/ui/`. F03 introduces no new locations; it
**consumes** the F02-approved tree:

```
web/src/components/
  ui/             (F02-owned)
  content/        (F02 + F05-owned: CodeBlock, MarkdownText, JsonView, FormattedContent)
  conversation/   (F02-owned API; F03 fills in the round bodies)
    RoundCard.vue           ← F03 (round wrapper; assistant body)
    ToolChip.vue            ← F02 API, F03 + F05 fill it in (shared chip consumed by AnalystChatPanel too)
    DiagnosticRow.vue       ← F03 (model_issue / repair / recovered)
    PendingCallFooter.vue   ← F03 (live in_flight / backoff footer)
    CompactedCluster.vue    ← F03 (r-pre / r-compacted-N)
    ContextBlock.vue        ← F03 (user/system text without assistant reply)
    MessageBubble.vue       (F02-owned; F03 does not modify)
    ThinkingDots.vue        (F02-owned; F03 does not modify)

web/src/views/
  AgentConversationView.vue ← surface container (thin shell, store + router only)

web/src/composables/
  useAgentTimeline.ts       ← derived view-model (timeline, pendingRoundId, defaultModelSpec, expansion, scroll-stickiness)

web/src/utils/agent-timeline/   ← pure non-SFC logic (testable without Vue runtime)
  timeline.ts               ← entriesToTimeline()
  round-id.ts               ← parseRoundId(), roundIdSortKey()
  types.ts                  ← ConversationEntry, Round, ToolPair, TimelineItem, ToolPairStatus, ActivityStatus
  index.ts                  ← barrel for the agent-timeline utility ONLY (allowed; this is utils, not components)

web/src/stores/
  agents.ts                 ← owns entries + activityStatus; no MessageStep, no groupIntoSteps
```

`AgentConversationView.vue` is the **only** new piece in `views/`
under the F03 batch; it is a thin store/surface container that wires
`useAgentTimeline` into the conversation composites. Per F02 r2
discriminator: anything that imports a Pinia store, router, or
WebSocket client cannot live in `conversation/`, so the container
stays in `views/` or `components/agents/` (existing surface folder).
F03 keeps the existing surface path
[web/src/components/agents/AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue)
to avoid churn outside its scope.

### 3.2 Composable / utility split

The pure algorithm and the Vue-facing derivation are split:

- `web/src/utils/agent-timeline/timeline.ts` exports
  `entriesToTimeline(entries, pendingRoundId)` — byte-equivalent port
  of v2's pure function. Zero Vue imports. Testable as a TS unit.
- `web/src/utils/agent-timeline/round-id.ts` exports
  `parseRoundId(id)` and `roundIdSortKey(id)` — byte-equivalent port.
- `web/src/utils/agent-timeline/types.ts` exports the typed
  view-model (see §3.3).
- `web/src/composables/useAgentTimeline.ts` wraps the utility with
  refs/computeds and adds:
  - `pendingRoundId` derivation: scan entries for highest tier-2
    `rK` index, **only if** `activity_status.pending_call != null`;
    return `null` otherwise.
  - `defaultModelSpec` derivation: first timeline `round` item with
    a `modelSpec`.
  - `expanded: Ref<Set<string>>` plus `toggleDetails(id)`,
    `expandAll()`, `collapseAll()` operating over the **timeline**,
    not over raw entries.
  - Reset hook: when the active agent id changes, `expanded.value`
    is cleared and the scroll position is reset on the next tick.
  - Scroll stickiness: `bindThreadBody(elGetter)` + a watcher on
    `entries.length` that, before swap, records
    `isScrolledToBottom(SCROLL_BOTTOM_TOLERANCE_PX)`, and after
    `nextTick` either restores scroll-to-bottom or leaves the user's
    scrollTop alone.

### 3.3 Type contracts (final)

```ts
// web/src/utils/agent-timeline/types.ts

export type ConversationEntryKind =
  | 'text' | 'activity'
  | 'tool_call' | 'tool_result' | 'tool_error'
  | 'model_issue' | 'model_repair' | 'model_recovered';

export type ConversationEntryRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ConversationEntry {
  id: string;
  session_id: string;
  role: ConversationEntryRole;
  kind: ConversationEntryKind;
  content: string;
  timestamp: string;          // ISO 8601
  round_id: string;           // server-stamped; required
  message_index: number;      // server-stamped; required
  block_index: number;        // server-stamped; required
  tool?: string;              // tool name (call/result/error only)
  tool_call_id?: string;      // scalar tool-use id (REQUIRED on tool_call/tool_result/tool_error after §5.5)
  model_spec?: string;        // assistant rounds only
  requested_model_spec?: string;
  links?: EntityLink[];
}

export type ToolPairStatus = 'pending' | 'ok' | 'error' | 'orphan' | 'missing';

export interface ToolPair {
  toolUseId: string;
  toolName: string;
  call?: ConversationEntry;
  result?: ConversationEntry;
  status: ToolPairStatus;
}

export interface Round {
  id: string;
  startedAt: string;
  hasAssistant: boolean;
  reasoning: ConversationEntry[];
  toolPairs: ToolPair[];
  context: ConversationEntry[];
  diagnostics: ConversationEntry[];
  modelSpec?: string;
  requestedModelSpec?: string;
}

export type TimelineItem =
  | { kind: 'round';      id: string; timestamp: string; round: Round }
  | { kind: 'diagnostic'; id: string; timestamp: string; diagnostic: ConversationEntry }
  | { kind: 'context';    id: string; timestamp: string; context: Round }
  | { kind: 'compacted';  id: string; timestamp: string; compacted: ConversationEntry[] };

export interface PendingCall {
  started_at: string;
  status: 'in_flight' | 'backoff';
  attempt: number;
  reason: 'throttled' | 'transient' | null;
  retry_at: string | null;
}

export interface ActivityStatus {
  pending_call: PendingCall | null;     // null when no call is in flight
  last_activity_at: string;             // ISO timestamp, always present
}
```

Naming notes:

- Wire fields are snake_case end-to-end (`round_id`, `tool_call_id`,
  `model_spec`, `message_index`, `block_index`, `activity_status`,
  `pending_call`, `started_at`, `retry_at`, `last_activity_at`).
  v3 already uses snake_case in [api/types.ts](../../../web/src/api/types.ts);
  v2's camelCase aliases (`toolUseId`, `roundId`, `modelSpec`) live
  ONLY inside the `ToolPair`/`Round` view-model objects produced by
  `entriesToTimeline()`. The wire-shape rename `toolUseId ↔ tool_call_id`
  proposed in r1 §3 is dropped — there is no boundary translator;
  `entriesToTimeline()` simply reads `entry.tool_call_id` and
  populates `ToolPair.toolUseId` from it once, internally. The
  TypeScript field name on the view-model is `toolUseId` purely for
  readability; it carries the same value.

### 3.4 Component sketch

```vue
<!-- web/src/components/agents/AgentConversationView.vue (post-port) -->
<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { useAgentsStore } from '../../stores/agents';
import { useAgentTimeline } from '../../composables/useAgentTimeline';
import RoundCard from '../conversation/RoundCard.vue';
import DiagnosticRow from '../conversation/DiagnosticRow.vue';
import ContextBlock from '../conversation/ContextBlock.vue';
import CompactedCluster from '../conversation/CompactedCluster.vue';
import PendingCallFooter from '../conversation/PendingCallFooter.vue';
import RawLlmExchangePanel from './RawLlmExchangePanel.vue';
import ConversationWarning from './ConversationWarning.vue';

const store = useAgentsStore();
const { currentSession, entries, activityStatus, conversationWarning } = storeToRefs(store);
const { timeline, defaultModelSpec, expanded, toggleDetails, expandAll, collapseAll, threadBody, now }
  = useAgentTimeline(entries, activityStatus, () => currentSession.value?.id ?? null);
</script>

<template>
  <article class="agent-conversation">
    <ConversationHeader :session="currentSession" :default-model-spec="defaultModelSpec" :now="now" />
    <ConversationToolbar @expand="expandAll" @collapse="collapseAll" />
    <RawLlmExchangePanel v-if="rawOpen" :session-id="currentSession?.id ?? null" />
    <ConversationWarning v-if="conversationWarning" :message="conversationWarning" />
    <div class="thread-body" ref="threadBody">
      <template v-for="item in timeline" :key="item.id">
        <RoundCard          v-if="item.kind === 'round'"      :round="item.round" :default-model-spec="defaultModelSpec" :expanded="expanded" @toggle-details="toggleDetails" />
        <DiagnosticRow      v-else-if="item.kind === 'diagnostic'" standalone :entry="item.diagnostic" />
        <ContextBlock       v-else-if="item.kind === 'context'"    :round="item.context" />
        <CompactedCluster   v-else
                            :id="item.id" :entries="item.compacted"
                            :expanded="expanded.has(item.id)" @toggle="toggleDetails(item.id)" />
      </template>
      <PendingCallFooter v-if="activityStatus.pending_call" :pending="activityStatus.pending_call" :now="now" />
    </div>
  </article>
</template>
```

Inside `RoundCard.vue` the assistant body uses `FormattedContent`
(content/) for reasoning text and renders each `ToolPair` via the
shared `<ToolChip>` (conversation/) — see §7.

---

## 4. Wire contract

### 4.1 Canonical response shape (one shape, no shim)

The same change set that introduces the UI port replaces the route
payload outright.

```ts
// web/src/api/types.ts (replaces the existing AgentConversationResponse + AgentMessage)

export interface AgentConversationResponse {
  session: AgentSession;
  entries: ConversationEntry[];
  activity_status: ActivityStatus;   // REQUIRED; the inner pending_call may be null
}
```

Server: `GET /api/agents/:id/conversation` returns the same JSON
shape. There is no `messages` field anywhere in the API after this
change. The previous `messages: AgentMessage[]` field is deleted from
[web/src/api/types.ts](../../../web/src/api/types.ts), and the only
remaining `AgentMessage` consumer (the store) is rewritten to
`entries: ConversationEntry[]` in the same commit.

### 4.2 JSON example (informational)

```json
{
  "session": { "id": "planner:goal-42:01", "role": "planner", "status": "active", "started_at": "2026-05-20T12:00:00.000Z", "model": "openai/gpt-4o", "completed_at": null, "message_count": 12 },
  "entries": [
    { "id": "planner:goal-42:01:0001", "session_id": "planner:goal-42:01", "role": "system", "kind": "text",
      "content": "...", "timestamp": "2026-05-20T12:00:00.100Z",
      "round_id": "r-pre", "message_index": 0, "block_index": 0 },
    { "id": "planner:goal-42:01:0002", "session_id": "planner:goal-42:01", "role": "user", "kind": "text",
      "content": "...", "timestamp": "2026-05-20T12:00:01.000Z",
      "round_id": "r-msg:0", "message_index": 1, "block_index": 0 },
    { "id": "planner:goal-42:01:0003", "session_id": "planner:goal-42:01", "role": "assistant", "kind": "text",
      "content": "reasoning ...", "timestamp": "2026-05-20T12:00:02.000Z",
      "round_id": "r0", "message_index": 2, "block_index": 0,
      "model_spec": "openai/gpt-4o", "requested_model_spec": "openai/gpt-4o" },
    { "id": "planner:goal-42:01:0004", "session_id": "planner:goal-42:01", "role": "assistant", "kind": "tool_call",
      "content": "{\"toolCalls\":[{\"id\":\"call_abc\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]}",
      "timestamp": "2026-05-20T12:00:02.100Z",
      "round_id": "r0", "message_index": 2, "block_index": 1,
      "tool": "read_file", "tool_call_id": "call_abc" },
    { "id": "planner:goal-42:01:0005", "session_id": "planner:goal-42:01", "role": "tool", "kind": "tool_result",
      "content": "{\"ok\":true,\"path\":\"README.md\",\"bytes\":1234}",
      "timestamp": "2026-05-20T12:00:02.500Z",
      "round_id": "r0", "message_index": 3, "block_index": 0,
      "tool": "read_file", "tool_call_id": "call_abc" }
  ],
  "activity_status": {
    "pending_call": { "started_at": "2026-05-20T12:00:03.000Z", "status": "in_flight", "attempt": 1, "reason": null, "retry_at": null },
    "last_activity_at": "2026-05-20T12:00:03.000Z"
  }
}
```

### 4.3 What the store stores

After F03 the agents store carries `entries: Ref<ConversationEntry[]>`
and `activityStatus: Ref<ActivityStatus>`. It does NOT carry
`messages`, `steps`, or `MessageStep`. The store's `appendMessage()`
becomes `appendEntry(entry: ConversationEntry)` with dedupe-by-`id`
(see §6.4).

---

## 5. Backend round-stamping contract

### 5.1 Counters and where they live

Per-session counters live in `ActiveRuntime` ([src/runtime/active-runtime.ts](../../../src/runtime/active-runtime.ts))
as a new per-session map. Concretely a new type is added:

```ts
// src/runtime/active-runtime.ts (additions)
interface SessionRoundState {
  /** Next assistant turn index (rK). Starts at 0. */
  nextRoundIndex: number;
  /** Active round id, set when an assistant turn is opened. null between turns. */
  currentRoundId: string | null;
  /** Per-session message_index counter. Monotone over the session. */
  nextMessageIndex: number;
  /** Per-round block_index counter; reset on round open. */
  nextBlockIndex: number;
  /** Compacted cluster counter; bumped each time compaction.ts emits a cluster. */
  nextCompactedIndex: number;
  /** Last user-message anchor (r-msg:N) created. null before any user message. */
  lastUserMsgIndex: number | null;
}

// Map keyed by sessionId, owned by ActiveRuntime; ZERO persistence (rebuildable from JSONL on boot).
```

Rebuild on startup: when `ActiveRuntime` resumes a session it reads
the existing JSONL via `getSessionMessages` and replays the highest
indices (`max(round_id rK)` → `nextRoundIndex`; `max(message_index)+1`;
last `r-msg:N` → `lastUserMsgIndex`; `max(r-compacted-N)+1` →
`nextCompactedIndex`). This makes the counters stateless from the
operator's perspective — pure derivable from disk.

### 5.2 Append paths and which one stamps what

Today every append goes through
[session-persistence.ts L209](../../../src/agents/session-persistence.ts#L209)
`appendMessage()`. F03 reshapes this to require round-stamping
metadata up-front (no defaults, no `?` on the new fields):

```ts
export function appendMessage(
  saivageDir: string,
  sessionId: string,
  message: {
    role: MessageRole;
    kind: MessageKind;
    content: string;
    round_id: string;           // NEW; required
    message_index: number;      // NEW; required
    block_index: number;        // NEW; required
    tool?: string;
    tool_call_id?: string;
    model_spec?: string;        // NEW; optional, assistant tool_call/text only
    requested_model_spec?: string; // NEW; optional
    links?: EntityLink[];
  },
): AgentMessage;
```

There is **no overload**, **no defaulting**, and **no shim**. Every
caller of `appendMessage` is updated in the same commit. All
counters are obtained from `ActiveRuntime` via a new helper:

```ts
// src/runtime/active-runtime.ts (additions)
export interface RoundStamp {
  round_id: string;
  message_index: number;
  block_index: number;
}

class ActiveRuntime {
  openAssistantRound(sessionId: string, modelSpec?: string): RoundStamp;       // produces r{k}, bumps nextRoundIndex
  stampInRound(sessionId: string, opts?: { incrementBlock?: boolean }): RoundStamp; // returns currentRoundId with next block_index
  stampUserMessage(sessionId: string): RoundStamp;                              // produces r-msg:N, sets lastUserMsgIndex
  stampPre(sessionId: string): RoundStamp;                                      // produces r-pre (only valid before first user/assistant)
  stampCompacted(sessionId: string): RoundStamp;                                // produces r-compacted-N
  stampDiagnosticInCurrentRound(sessionId: string): RoundStamp;                 // attaches to currentRoundId if open, else opens a synthetic r-pre/r-msg per §5.4
  closeRound(sessionId: string): void;                                          // sets currentRoundId = null
}
```

The append paths in [agent-adapter.ts](../../../src/agents/agent-adapter.ts)
that today omit round metadata are rewritten as follows. Each row is
"append site → stamping rule":

| Append site (agent-adapter.ts) | Round-stamping call | Notes |
| ------------------------------ | ------------------- | ----- |
| L346 `model_issue` ("Forcing final-answer")      | `stampDiagnosticInCurrentRound` | attaches to live `rK` if open, else synthesises an `r-pre` bucket |
| L347 `text` ("Forcing final-answer prompt")      | `stampUserMessage` | new `r-msg:N` |
| L353 `model_issue` ("forceFinalAnswer LLM failed") | `stampDiagnosticInCurrentRound` |  |
| L365 `model_issue` ("Repeated tool-call fingerprint")  | `stampDiagnosticInCurrentRound` | inside the active assistant round |
| L376 `tool_call` (planner/executor/reviewer)     | `stampInRound` + sets `tool_call_id` scalar from `tc.id` | `model_spec` filled from `candidate.model` chosen by `model-router` |
| L386 `tool_result`/`tool_error` (`processToolCall` output)  | `stampInRound` | `tool_call_id` already present (`msg.tool_call_id`) |
| L407, L412 `model_issue` (synthesised continuation envelopes) | `stampDiagnosticInCurrentRound` | |
| L453 `contextMessages` (initial seeding)         | `stampPre` OR `stampUserMessage` (per `role`) | system/init→`r-pre`; user→`r-msg:N` |
| L454 `model_issue` (recovery `persistFailure`)   | `stampDiagnosticInCurrentRound` | |
| L473 `model_recovered`                           | `stampDiagnosticInCurrentRound` | |
| L488/L505/L522 `text` (assistant final response) | `openAssistantRound` (if not already open) then `stampInRound` | first call of the turn opens the round; `model_spec` set from `candidate.model`; `closeRound` is called once the parser finishes the envelope |
| L499/L515/L527 `model_issue` (recovery self-check, etc.) | `stampDiagnosticInCurrentRound` | |
| L510/L527/L533 `model_issue` (fallback parse failures)   | `stampDiagnosticInCurrentRound` | |

Compaction
([src/agents/compaction.ts](../../../src/agents/compaction.ts))
emits a special replacement record set: when compaction collapses
older messages into a synthetic cluster it uses `stampCompacted`
once per cluster and emits the synthetic record with the canonical
`r-compacted-N` `round_id`. The replaced messages are removed via
`replaceSessionMessages` (already in `session-persistence.ts`).

The analyst chat append path
([analyst-handler.ts](../../../src/agents/analyst-handler.ts) and
adjacent `analyst-*` files) shares the same `AgentMessage` type;
**it must also stamp** `round_id`/`message_index`/`block_index`
through the same `ActiveRuntime` API. Justification: every
downstream consumer (the new conversation route, the timeline
renderer, the analyst chat UI per F04) reads the shared shape; not
stamping in one place would force a "default to r0" fallback in the
parser, which the project guideline forbids. The analyst session
maintains its own `SessionRoundState` keyed by the canonical
`analyst` session id — assistant rounds become `rK`, operator
messages become `r-msg:N`, and the panel renders through the same
`useAgentTimeline` composable.

### 5.3 Round-id grammar (enforced)

Producer-side grammar (mirror of the parser in
[v2 round-id.ts](../../../../saivage/web/src/components/agents/round-id.ts#L20-L48)):

- `r-pre` literal.
- `r-msg:N` where `N` is a base-10 non-negative integer ≤ `Number.MAX_SAFE_INTEGER`, no leading zeros required, no negative.
- `rK` where `K` is the same shape, and the first character after `r` is NOT `-`.
- `r-compacted-N` where `N` is the same shape.

A new pure function `formatRoundId({ kind, index })` lives in
`src/agents/round-id.ts` (server-side mirror of the web util) and is
the only allowed producer. A vitest in
[src/agents/__tests__/round-id.test.ts](../../../src/agents/__tests__/) (new)
runs every producer call against the parser to guarantee grammar
parity.

### 5.4 Bucketing rules

- **Context messages (user/system at session boot or after a user turn).**
  - Before any assistant turn has opened: `r-pre`.
  - User input: opens a new `r-msg:N` where `N = lastUserMsgIndex + 1`.
  - System messages **inside** an open assistant round (e.g. forced
    recovery directives appended mid-turn): attached to the current
    `rK` via `stampInRound`. This matches v2: `userText` carries
    `user`/`system` text only when no `reasoning` exists in the same
    bucket; if reasoning already exists the entry still belongs to
    that same `rK` and is sorted with the other entries of the
    round.
- **Assistant turn.**
  - The first stamp of an assistant turn calls `openAssistantRound`
    (produces a new `rK`). Subsequent stamps in the same turn call
    `stampInRound`. The turn closes (`closeRound`) when the
    invocation result is parsed and finalised (the
    `appendMessage(..., 'text', finalResponse)` site).
- **Diagnostics (model_issue/model_repair/model_recovered).**
  - Attach to `currentRoundId` if open. Otherwise: if the most
    recent open bucket on disk is an `r-msg:N`, attach to that
    `r-msg:N` (the diagnostic logically belongs to the user-anchored
    pre-assistant phase). Otherwise attach to `r-pre`. This ensures
    standalone-diagnostic promotion (§1.3) still happens: a
    diagnostic bucket with no other content stays solo, and the
    timeline algorithm promotes it to a `diagnostic` item.
- **Compaction summaries.** Each compaction emission stamps
  `r-compacted-N` (one cluster per compaction). All
  pre-compaction messages targeted by the same compaction become
  members of that cluster — i.e. they get their `round_id`
  overwritten by `replaceSessionMessages` to the new
  `r-compacted-N`. The cluster body is the new synthetic summary
  record plus the rewritten originals; the timeline renders it as a
  single `compacted` item.

### 5.5 `tool_call_id` scalar gap (fix)

Required edits in [agent-adapter.ts](../../../src/agents/agent-adapter.ts):

```ts
// line 376 (planner/executor/reviewer tool-call path)
appendMessage(this.saivageDir, sessionId, {
  role: 'assistant',
  kind: 'tool_call',
  content: JSON.stringify({ toolCalls: [tc] }),
  tool: tc.function.name,
  tool_call_id: tc.id,                              // NEW; scalar mirror of tc.id
  ...activeRuntime.stampInRound(sessionId),         // round_id/message_index/block_index/model_spec
});
```

Tool result/error sites at L386 already carry `tool_call_id`; they
add only the round-stamp fields. The `mcp_tool_call` and
`policyDeniedToolMessage` paths (L225-L227, L313) already emit the
scalar — they need round-stamp fields added when their results are
persisted (the result loop at L386 stamps them, so no per-site
change is needed beyond §5.2's table).

Schema additions:

```ts
// src/schemas/types.ts (replaces existing AgentMessage)
export interface AgentMessage {
  id: string;
  session_id: string;
  role: MessageRole;
  kind: MessageKind;
  content: string;
  timestamp: string;
  round_id: string;
  message_index: number;
  block_index: number;
  tool?: string;
  tool_call_id?: string;          // required at producer-side for tool_call/tool_result/tool_error; optional only because non-tool kinds don't carry it
  model_spec?: string;
  requested_model_spec?: string;
  links?: EntityLink[];
}
```

```ts
// src/schemas/validators.ts (replaces existing agentMessageSchema)
export const agentMessageSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  role: messageRoleSchema,
  kind: messageKindSchema,
  content: z.string(),
  timestamp: z.string().datetime(),
  round_id: z.string().regex(/^(r-pre|r-msg:\d+|r\d+|r-compacted-\d+)$/),
  message_index: z.number().int().nonnegative(),
  block_index: z.number().int().nonnegative(),
  tool: z.string().optional(),
  tool_call_id: z.string().optional(),
  model_spec: z.string().optional(),
  requested_model_spec: z.string().optional(),
  links: z.array(entityLinkSchema).optional(),
}).superRefine((m, ctx) => {
  if ((m.kind === 'tool_call' || m.kind === 'tool_result' || m.kind === 'tool_error') && !m.tool_call_id) {
    ctx.addIssue({ code: 'custom', path: ['tool_call_id'], message: 'tool_call_id is required for tool_call/tool_result/tool_error records' });
  }
});
```

The strict-regex `round_id` and the `superRefine` on `tool_call_id`
are the producer-side enforcement; the parser-side check at
[v2 round-id.ts](../../../../saivage/web/src/components/agents/round-id.ts) still
exists in the web util but should now never see an `unknown` id in
practice (the schema rejects on write).

### 5.6 Persistence changes summary

[src/agents/session-persistence.ts](../../../src/agents/session-persistence.ts):

- `appendMessage` signature widened (§5.2); caller list updated in
  the same commit (§5.2 table).
- `getSessionMessages` returns the wider `AgentMessage` type;
  validation throws on a record that lacks `round_id`/
  `message_index`/`block_index` (no defaulting).
- `replaceSessionMessages` (used by compaction) unchanged in
  signature; its inputs now carry the new fields.
- No migration tool. Pre-existing JSONL files written before this
  change set are not readable post-change — per project guideline
  test projects get reset.

---

## 6. Activity-status pipeline

### 6.1 Where state lives

`ActiveRuntime` gains a per-session activity store:

```ts
// src/runtime/active-runtime.ts (additions)

interface SessionActivity {
  /** Last time anything was appended to the JSONL or any retry/invocation event fired. */
  last_activity_at: string;
  /** Live pending call, if any. */
  pending_call: PendingCall | null;
}

interface PendingCall {
  started_at: string;
  status: 'in_flight' | 'backoff';
  attempt: number;                       // 1-based; matches recovery.ts InvocationAttempt.attempt
  reason: 'throttled' | 'transient' | null;
  retry_at: string | null;               // null in_flight; ISO when in backoff with a known delay
}

class ActiveRuntime {
  getActivityStatus(sessionId: string): ActivityStatus;  // returns { pending_call, last_activity_at } — last_activity_at always present
}
```

There is no event-bus subscription new to F03; `ActiveRuntime`
subscribes (in its constructor, alongside the existing event
plumbing) to the events `agent-adapter` already emits.

### 6.2 Event → state transitions

Source emissions are in [agent-adapter.ts](../../../src/agents/agent-adapter.ts);
listed with line refs above (§2.5). Transition table:

| Event                  | Payload                                                          | Effect on `SessionActivity`                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_started`      | `{ session_id, role, goal_id, card_id }`                         | `last_activity_at = now()`; `pending_call = null`                                                                                                                          |
| `model_selected`       | `{ session_id, provider, model, role }` (L472)                   | Marks the start of an in-flight call: `pending_call = { started_at: now(), status: 'in_flight', attempt: 1, reason: null, retry_at: null }`; `last_activity_at = now()`     |
| `invocation_succeeded` | `{ session_id, attempt, duration_ms, recoveryAction }` (L540)    | `pending_call = null`; `last_activity_at = now()`                                                                                                                          |
| `invocation_failed`    | `{ session_id, attempt, failureClass, recoveryAction, retryDelayMs, cooldownMs, ... }` (L551) | If `recoveryAction === 'retry'`: `pending_call = { started_at: existing.started_at, status: 'backoff', attempt, reason: failureClassToReason(failureClass), retry_at: now() + retryDelayMs }`. Else (terminal): `pending_call = null`. |
| `retry_attempted`      | `{ session_id, attempt, directive, failureClass?, retryDelayMs? }` (L454, L559) | If `pending_call` is non-null: bumps `attempt`. If `retryDelayMs` provided: sets `status='backoff'`, `retry_at = now() + retryDelayMs`. Otherwise leaves `pending_call`. This is the canonical "now retrying" signal — `attempt > 1` after this event. |
| `session_cancelled`/`session_force_cancelled` | `{ session_id }` (L263, L264)                     | `pending_call = null`                                                                                                                                                      |
| (any append)           | (via `appendMessage` hook)                                       | `last_activity_at = msg.timestamp`. When the appended record is the `text` final response, `pending_call = null` (defensive — `invocation_succeeded` already cleared it).  |

`failureClassToReason(cls)` maps the recovery-policy classes to the
two operator-visible reasons:

- `'rate_limited' | 'rate_limit' | 'throttle*'` → `'throttled'`
- everything else (`'parse_failure'`, `'tool_validation'`,
  `'transport_error'`, `'unknown'`) → `'transient'`

### 6.3 Route surface

`registerRuntimeConfigNotesRoutes` already receives `activeRuntime?:
ActiveRuntime` (the optional parameter exists today at
[runtime-config-notes.ts L98](../../../src/server/routes/runtime-config-notes.ts#L98)).
F03 makes it non-optional for this route (a startup invariant: the
HTTP server is registered with an `ActiveRuntime` instance) and
updates the conversation handler:

```ts
fastify.get('/api/agents/:id/conversation', async (request, reply) => {
  try {
    const { id: sessionId } = request.params as { id: string };
    if (!SAFE_AGENT_ID_RE.test(sessionId)) return reply.status(400).send({ error: 'Invalid agent session ID' });

    const manifest = readAgentSession(projectRoot, sessionId);
    if (isNonCanonicalAnalystSession(sessionId, manifest)) return reply.status(404).send({ error: 'Agent session not found', sessionId });
    const entries = readAgentMessages(projectRoot, sessionId);                  // returns ConversationEntry[] post-schema-widen
    const session = buildListedAgentSession(projectRoot, sessionId, readRuntimeState(projectRoot));
    if (!session || (entries.length === 0 && !manifest)) return reply.status(404).send({ error: 'Agent session not found', sessionId });

    const activity_status = activeRuntime.getActivityStatus(sessionId);
    return reply.send({ session, entries, activity_status });
  } catch (err) {
    return reply.status(500).send({ error: 'Failed to read agent conversation', message: err instanceof Error ? err.message : String(err) });
  }
});
```

`readAgentMessages` is renamed `readConversationEntries` in the same
commit and now returns the typed `ConversationEntry[]` (each line is
already `agentMessageSchema.parse`d; with §5.5 the validator
guarantees the round-stamp fields).

### 6.4 WS and REST polling protocol

**Decision: widen the existing `thinking` and `activity` envelopes
to include `activity_status`. Do NOT introduce a new
`agent-activity-status` event.**

Reasons for piggybacking:

- The frequency of `activity_status` changes is bounded by the same
  events that already drive `thinking`/`activity` envelopes; a
  separate event would duplicate every emission point in
  `agent-adapter`. Cheaper to widen one payload.
- One event type per session-related stream means the store's
  listener registration stays a 2-event setup; new event types
  multiply selector code in [stores/agents.ts](../../../web/src/stores/agents.ts).
- A standalone `agent-activity-status` event would either fire only
  on transitions (UI lag, no countdown smoothness without timers) or
  fire continuously (effectively a polling channel inside a push
  channel). Neither beats payload widening + a 1-Hz clock ref in the
  composable.

Reasons NOT to introduce `agent-activity-status`:

- It violates the F03 non-goal "no new transports / protocol
  changes" and the issue's intent to keep the backend touch minimal.
- It would double-encode the same state already implied by
  `thinking`/`activity` plus REST polling.
- A new envelope shape forces a schema bump on both the server and
  the WS-store, with three test suites to update; the piggybacked
  widening only edits two payloads' types.

#### 6.4.1 WS envelope shape after F03

Today [stores/agents.ts L346-L364](../../../web/src/stores/agents.ts#L346-L364)
expects `content: { sessionId, message }`. After F03 both
`thinking` and `activity` envelopes carry:

```ts
// server-side: src/server/websocket.ts (envelope construction)
{
  type: 'thinking' | 'activity',
  content: {
    sessionId: string,
    entry: ConversationEntry,            // renamed from `message`
    activity_status: ActivityStatus,     // snapshot at emission time
  }
}
```

Server emits these on the same code paths it does today; the WS
server reads `activeRuntime.getActivityStatus(sessionId)` once per
emission. The shape rename `message → entry` is intentional and not
reversible (no alias).

#### 6.4.2 Pinia store update flow

```ts
// web/src/stores/agents.ts (after F03)

const entries = ref<ConversationEntry[]>([]);
const activityStatus = ref<ActivityStatus>({ pending_call: null, last_activity_at: new Date(0).toISOString() });

function appendEntry(entry: ConversationEntry): void {
  if (!currentSession.value || entry.session_id !== currentSession.value.id) return;
  if (entries.value.some((e) => e.id === entry.id)) return;        // dedupe by id
  entries.value = [...entries.value, entry];
  markWsSync();
  if (entry.kind === 'tool_error' || entry.kind === 'model_issue') {
    conversationWarning.value = 'Conversation includes tool/model failures or repairs; inspect linked evidence carefully.';
  }
}

function setActivityStatus(next: ActivityStatus): void {
  activityStatus.value = next;
}

// WS subscriptions
ws.onType('thinking', (envelope) => {
  const c = envelope.content || {};
  if (typeof c.sessionId === 'string' && c.entry) appendEntry(c.entry as ConversationEntry);
  if (c.activity_status) setActivityStatus(c.activity_status as ActivityStatus);
});
ws.onType('activity', (envelope) => {
  const c = envelope.content || {};
  if (typeof c.sessionId === 'string' && c.entry) appendEntry(c.entry as ConversationEntry);
  if (c.activity_status) setActivityStatus(c.activity_status as ActivityStatus);
});

// REST polling (every AGENT_CONVERSATION_POLL_INTERVAL_MS = 3000 ms)
async function refreshConversation(): Promise<void> {
  if (!currentSession.value) return;
  const response = await getAgentConversation(currentSession.value.id);
  // Replace session manifest verbatim; merge entries by id.
  currentSession.value = response.session;
  const known = new Set(entries.value.map((e) => e.id));
  const additions = response.entries.filter((e) => !known.has(e.id));
  if (additions.length > 0) entries.value = [...entries.value, ...additions];
  activityStatus.value = response.activity_status;
  markRestSync();
}
```

Dedupe rule: REST and WS both go through the same `id`-based set
check before adding to `entries.value`. The only entry-mutating
operation that is NOT a pure append is a compaction emission, which
replaces the `round_id` of multiple existing entries; the REST poll
will detect this because the entries' bodies change but their `id`s
remain — the store mirrors the entry's new `round_id`/`content`
fields by overwriting in place (`entries.value = response.entries`
on full refetch is acceptable here; the WS append path never
mutates existing entries).

Refinement: the simpler implementation does a full `entries.value =
response.entries` on each REST poll. This is correct (server is
source of truth) and avoids the per-id merge subtlety. Compaction
events then naturally show up. The append-only WS path remains a
fast path between polls. Reassignment cost is dominated by Vue's
re-diff, which is O(n) over short conversations; for very long
conversations we still pay the cost once every 3 s, which is
acceptable for the agent surface.

Decision: REST poll = full replace; WS append = O(1) dedupe append.
Scroll stickiness in `useAgentTimeline` measures
`isScrolledToBottom()` BEFORE the swap and uses `nextTick` to
re-anchor. To preserve scroll across REST replace, the composable
holds a Map from `entry.id` → DOM `<RoundCard>` element via Vue's
`vue:updated` hook; the same Vue key on `<RoundCard :key="round.id">`
keeps round DOM stable.

---

## 7. Tool-pair composition over F05 presenters

### 7.1 No `formatToolPair`, no v2 formatter port

Per the review and F05 r2 §0/§2:

- F03 does NOT port [saivage/web/src/utils/toolFormatters.ts](../../../../saivage/web/src/utils/toolFormatters.ts)
  (the 692-line formatter). F05 r2 supersedes it with two
  independent presenters: `presentToolCall(content, tool?)` and
  `presentToolResult(content, { tool?, kind? })` in
  [web/src/utils/tool-presenters.ts](../../../web/src/utils/tool-presenters.ts).
- F03 does NOT define `FormattedToolPair`, `InlinePart.root: 'project' | 'saivage'`,
  or any of v2's coupled-pair concepts. F05 r2 §3 defines `InlinePart`
  exhaustively with `text|file|url|code` and `file.root: 'meta' | 'output'`.
  Text tones use `danger` (not `error`). F03 imports these unchanged.

### 7.2 Pair composition (view-level only)

The five-status `ToolPair` is a F03 view-model concern. The renderer
takes it apart and feeds each half to its own F05 presenter:

```ts
// web/src/components/conversation/RoundCard.vue or a sibling tool-pair helper

import { presentToolCall, presentToolResult, type ToolCallPresentation, type ToolResultPresentation } from '../../utils/tool-presenters';
import type { ToolPair } from '../../utils/agent-timeline/types';

interface ToolPairView {
  pair: ToolPair;
  call: ToolCallPresentation;                         // always present when pair.call exists
  result: ToolResultPresentation | null;              // null when pair.result is absent
  // chip-level status drives the wrapper card tone:
  chipStatus: 'pending' | 'ok' | 'error' | 'orphan' | 'missing';
}

function toolPairView(pair: ToolPair): ToolPairView {
  const call = pair.call
    ? presentToolCall(pair.call.content, pair.call.tool ?? pair.toolName)
    : { icon: '?', name: pair.toolName, headline: [], detail: [], status: 'call' as const };
  const result = pair.result
    ? presentToolResult(pair.result.content, { tool: pair.result.tool ?? pair.toolName, kind: pair.result.kind })
    : null;
  return { pair, call, result, chipStatus: pair.status };
}
```

`ToolChip.vue` (conversation/, F02 r2 §3.9 API) renders both halves
stacked when expanded, and only the call header when collapsed. The
chip remains a non-button `<div role="group">` per F05 r2 §6 with
one dedicated expand `<button>` and sibling `<router-link>`/`<a>`
links for file/url parts. Status mapping for the chip card tone (per
F02 r2 §2.2 / F05 r2 §6):

- `chipStatus === 'pending'` → wrapper `<Card tone="warn">`
- `chipStatus === 'ok'` → wrapper `<Card tone="accent">`
- `chipStatus === 'error'` → wrapper `<Card tone="danger">`
- `chipStatus === 'orphan'` → wrapper `<Card tone="warn">`
  (orphan result with no call: surface as warning, not error;
  consistent with v2's neutral-leaning treatment of orphans)
- `chipStatus === 'missing'` → wrapper `<Card tone="warn">` with a
  small "(no result yet)" muted text part appended to the headline

`ToolChip`'s prop API (matching F02 r2):

```ts
defineProps<{
  call: ToolCallPresentation;
  result: ToolResultPresentation | null;
  status: ToolPairStatus;
  expanded: boolean;
  detailsId: string;          // `tool-detail-${pair.toolUseId}`
  timestamp?: string;
}>();
defineEmits<{ (e: 'toggle'): void }>();
```

The chip's body, when expanded, renders:

```vue
<div :id="detailsId" class="tool-chip-detail">
  <FormattedContent :content="callContentRaw" />
  <FormattedContent v-if="result" :content="resultContentRaw" />
</div>
```

`FormattedContent` and `JsonView` are F05-owned (`content/`); F03
consumes them without modifying.

### 7.3 What F03 does NOT contain

- No re-implementation of JSON tokenisation.
- No `MarkdownText` changes.
- No new tool-presenter logic. F03 only adds the small
  `toolPairView(pair)` helper next to `ToolChip.vue`.
- No `InlinePart` redefinition. F03 imports it from `tool-presenters.ts`.

---

## 8. Cross-issue ordering

### 8.1 Hard dependencies F03 must consume

| Dep                                                            | Direction                                 | Resolution         |
| -------------------------------------------------------------- | ----------------------------------------- | ------------------ |
| F01 r2 tokens (`--accent`, `--warn`, `--danger`, `--accent-2`) | F03 uses them via `Card`/`Pill`/diagnostic rows | F01 must land first |
| F02 r2 component split (`ui/`, `content/`, `conversation/`)    | F03 places `RoundCard`/`ToolChip`/etc. in `conversation/` | F02 r2 lands first |
| F05 r2 presenters + `InlinePart` + `FormattedContent`/`JsonView` | F03 imports presenters and `FormattedContent`/`JsonView` | F05 r2 lands first or co-lands |

### 8.2 AnalystChatPanel ToolChip swap (resolution to r1 contradiction)

Reviewer requirement: F03 must not result in two divergent chip
implementations after the batch lands.

[AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue)
today owns its own `tool-chip*` markup (L36-L75) + scoped CSS
(L298-L347). After F03/F05/F04 land, the canonical chip is
`web/src/components/conversation/ToolChip.vue`, and AnalystChatPanel
consumes it.

**Decision: strict landing order — F05 r2 → F03 r2 → F04 ToolChip
swap, with the F04 swap committed in the same PR as F03 to prevent
two-chip drift.** Equivalent statement: F03's PR contains both (a)
the new `ToolChip.vue` under `conversation/` and (b) the swap in
`AnalystChatPanel.vue` from its in-line markup to that component.
F04's broader analyst-surface work depends on this swap landing in
the F03 PR, but does not extend F03's scope beyond the swap itself.

Justification for landing-with-F03 instead of "in F04":

- The shared `ToolChip` is a F02 r2-owned API and must have exactly
  one renderer at HEAD at any point. If F03 lands and F04 lags, the
  agent surface uses `ToolChip.vue` and the analyst surface still
  uses local `tool-chip*` markup — two chip implementations exist
  for an indeterminate window. The project guideline forbids this.
- The AnalystChatPanel swap is mechanically tiny: replace the
  `<button class="tool-chip">…</button>` block with
  `<ToolChip :call=… :result=… :status=… :expanded=… :details-id=… @toggle=… />`
  and delete the scoped `.tool-chip*` block. It does not require any
  of F04's larger changes (composer, badges, toaster).
- A test in [analyst-chat-panel.test.ts](../../../web/src/__tests__/analyst-chat-panel.test.ts)
  already exercises tool chips via `.tool-chip` selectors; per F02 r2
  §5.2 those become `data-testid="tool-chip"` after the swap and are
  updated in the same PR.

Justification for ordering F05 → F03 instead of F03 → F05:

- F05 r2 introduces `presentToolCall`/`presentToolResult` (independent),
  `InlinePart` (exported), `FormattedContent`, `JsonView`, and
  `ToolChip` markup contract. F03 imports all of these. Landing F05
  first lets F03 be a near-mechanical port. Landing F03 first would
  either (a) duplicate `JsonView`/`FormattedContent` and then delete
  them in F05 (violates guideline) or (b) postpone F03 until F05 is
  done anyway. F05 first is strictly better.

### 8.3 F03 does NOT depend on F02 r2 landing first if both ship together

F02 r2 + F03 r2 + F05 r2 in one combined batch is acceptable;
F03 r2 only requires that the components in `conversation/` exist
at HEAD by the time F03's renderer code runs. Sequencing inside a
single PR is fine; sequencing across PRs requires F02 r2 to land
first.

---

## 9. Alternative considered

### 9.1 (a) Backend-driven structured timeline

Server returns a pre-bucketed structure
(`Round[]`, `TimelineItem[]`) directly. The web layer renders
whatever the server emits.

Strengths: simpler client; client tests reduce to template snapshots.

Weaknesses (binding rejection reasons):

1. **Couples wire shape to UI concerns.** The wire would need to
   know about `context`/`diagnostic`/`compacted`/`round` discrimination
   and the four sub-streams (`reasoning`/`toolPairs`/`context`/
   `diagnostics`). If the UI ever changes (e.g. flatten `context` into
   its parent round), the wire changes too — and so does every
   consumer.
2. **Pending-round upgrade is a client concern.** Pending-vs-missing
   depends on `activity_status.pending_call`, which is freshly
   sampled at request time. Server-bucketing forces the server to
   re-sort/re-classify pairs on every request, duplicating work that
   the client does in a pure function.
3. **Defeats fail-loud parser.** v2's `parseRoundId` `unknown` drop
   is the canary that catches server-side grammar drift. If the
   server already produced rounds, the parser cannot fire.
4. **Throws away v2's tested algorithm.** [v2 timeline.test.ts](../../../../saivage/web/src/components/agents/timeline.test.ts)
   (171 lines) ports as-is to v3; with server-bucketing those tests
   become e2e fixtures with much larger blast radius on change.
5. **Forces analyst-surface duplication.** Analyst chat consumes the
   same shared `ToolChip` and benefits from the same client-side
   bucketing. A server-bucketed shape would need a parallel endpoint
   for analyst chat or a polymorphism the server doesn't currently
   have.

### 9.2 (b) Canonical flat `entries[]` + view-side `entriesToTimeline()` — SELECTED

The server returns a flat array of `ConversationEntry` records
stamped with `round_id`/`message_index`/`block_index`/`model_spec`;
the client groups them via the same pure function as v2.

Strengths:

- Preserves v2's tested algorithm exactly (port byte-equivalent).
- Wire contract is presentation-neutral — the same `entries[]` can
  back the agent thread, the analyst chat, the raw-LLM panel, and
  future debug surfaces.
- The pending-vs-missing computation lives where its source-of-truth
  lives (`pendingRoundId` is computed from `entries` + `activity_status`
  in one place).
- Backend changes are constrained to (i) round-stamp metadata and
  (ii) the new activity-status surface. No view-tree logic on the
  server.
- Compaction stays a backend concern; its only product is a stable
  `r-compacted-N` round id plus the rewritten records.

Selected.

### 9.3 Other alternatives considered briefly

- **Hybrid:** server returns `entries` plus a hint structure
  (`round_ids: string[]` in order). Rejected: the hint duplicates
  information already in `entry.round_id` plus the sort key the
  client computes; adds no value.
- **Streaming-only state-machine on the client (no REST refetch).**
  Rejected: WS reconnects miss messages; F03 keeps the REST poll
  fallback at v2's cadence.

---

## 10. Test plan

### 10.1 `web/src/__tests__/utils/agent-timeline/round-id.test.ts` (new; port of v2)

- `parseRoundId > "r-pre" returns { tier: 0, kind: "pre" }`
- `parseRoundId > "r-msg:0" returns { tier: 1, kind: "msg", index: 0 }`
- `parseRoundId > "r-msg:42" returns { tier: 1, kind: "msg", index: 42 }`
- `parseRoundId > "r-msg:" returns unknown`
- `parseRoundId > "r-msg:abc" returns unknown`
- `parseRoundId > "r0" returns { tier: 2, kind: "round", index: 0 }`
- `parseRoundId > "r12" returns { tier: 2, kind: "round", index: 12 }`
- `parseRoundId > "r007" (leading zeros) returns { tier: 2, kind: "round", index: 7 }`
- `parseRoundId > "r-1" returns unknown (negative)`
- `parseRoundId > "rfoo" returns unknown`
- `parseRoundId > "R1" returns unknown (case-sensitive)`
- `parseRoundId > "r-compacted-3" returns { tier: 3, kind: "compacted", index: 3 }`
- `parseRoundId > "r-compacted-3x" returns unknown`
- `parseRoundId > "" returns unknown`
- `roundIdSortKey > orders r-pre(0,0) < r-msg:5(1,5) < r5(2,5) < r-compacted-5(3,5)`

### 10.2 `web/src/__tests__/utils/agent-timeline/timeline.test.ts` (new; port of v2)

Explicit case list:

- `entriesToTimeline > empty input produces empty timeline`
- `entriesToTimeline > builds a single round from one assistant text entry`
- `entriesToTimeline > sorts r-pre before r1 when timestamps match`
- `entriesToTimeline > sorts r1 before r-compacted-3 when timestamps match`
- `entriesToTimeline > sorts r-msg:2 before r3 when timestamps match`
- `entriesToTimeline > treats r007 and r7 as the same round (leading zero)` — derived from sort-key equality
- `entriesToTimeline > drops every entry in a malformed bucket (e.g. "rfoo") silently`
- `entriesToTimeline > pairs tool_call and tool_result by tool_call_id (status ok)`
- `entriesToTimeline > pairs tool_call and tool_error by tool_call_id (status error)`
- `entriesToTimeline > overwrites first tool_call with second when same tool_call_id appears twice (last wins)`
- `entriesToTimeline > emits orphan pair for a tool_result with no matching call`
- `entriesToTimeline > emits missing-status pair for a tool_call with no result (not the pending round)`
- `entriesToTimeline > upgrades missing to pending when round is the pending round`
- `entriesToTimeline > drops tool_call missing tool_call_id and warns once per dropped entry`
- `entriesToTimeline > drops tool_result missing tool_call_id and warns once per dropped entry`
- `entriesToTimeline > emits a standalone context item for r-msg:N with no assistant reasoning`
- `entriesToTimeline > promotes a diagnostic-only bucket to standalone diagnostic items (one per diagnostic)`
- `entriesToTimeline > emits a compacted item for r-pre`
- `entriesToTimeline > emits a compacted item for r-compacted-N`
- `entriesToTimeline > lifts modelSpec onto the round from the first reasoning entry that has one`
- `entriesToTimeline > falls back to first bucket entry with modelSpec when no reasoning has one`
- `entriesToTimeline > produces stable timeline item ids across calls (round.id === entry.round_id)`
- `entriesToTimeline > role 'tool' entries with no recognised kind are dropped from sub-streams`
- `entriesToTimeline > stable :key candidates: a round and its diagnostics share round.id; standalone diagnostic ids include timestamp+kind+round`

### 10.3 `web/src/__tests__/composables/useAgentTimeline.test.ts` (new)

- `useAgentTimeline > pendingRoundId is null when activity_status.pending_call is null`
- `useAgentTimeline > pendingRoundId is the highest tier-2 round id among entries`
- `useAgentTimeline > defaultModelSpec is the first round's modelSpec`
- `useAgentTimeline > defaultModelSpec is null when no round has a modelSpec`
- `useAgentTimeline > expanded is cleared when sessionId getter changes`
- `useAgentTimeline > toggleDetails adds an id if absent, removes if present`
- `useAgentTimeline > expandAll adds every toolPair.toolUseId and every compacted cluster id from timeline`
- `useAgentTimeline > collapseAll empties the set`
- `useAgentTimeline > scroll stickiness: when scrolled to bottom, post-append the body scrolls to bottom on next tick`
- `useAgentTimeline > scroll stickiness: when scrolled away, post-append scrollTop is preserved`
- `useAgentTimeline > on agent switch (sessionId getter result changes), scroll resets to top on next tick`

### 10.4 `web/src/__tests__/stores/agents-conversation.test.ts` (rewritten from existing agents-store tests)

- `agents store > appendEntry dedupes by entry.id`
- `agents store > REST refresh replaces entries from response.entries`
- `agents store > REST refresh updates activity_status verbatim`
- `agents store > WS thinking envelope updates entries and activity_status`
- `agents store > WS activity envelope updates entries and activity_status`
- `agents store > WS envelope for a different sessionId does not mutate the active session entries`
- `agents store > conversation warning is set when an appended entry is tool_error/model_issue`
- `agents store > setActivityStatus replaces the whole object atomically`

### 10.5 `web/src/__tests__/conversation/ToolChip.test.ts` (new under F02-mandated conversation/ test root)

Covered partially by F02 r2 §5.4 contract; F03 adds specifically:

- `ToolChip > maps chipStatus pending → wrapper card tone warn`
- `ToolChip > maps chipStatus ok → tone accent`
- `ToolChip > maps chipStatus error → tone danger`
- `ToolChip > maps chipStatus orphan → tone warn`
- `ToolChip > maps chipStatus missing → tone warn with "(no result yet)" muted suffix`
- `ToolChip > renders call FormattedContent only when expanded and call exists`
- `ToolChip > renders result FormattedContent when expanded and result is non-null`
- `ToolChip > does not render result FormattedContent when result is null`

### 10.6 `web/src/__tests__/conversation/PendingCallFooter.test.ts` (new)

- `PendingCallFooter > in_flight without attempt > 1 omits "(attempt N)"`
- `PendingCallFooter > in_flight with attempt 2 renders "(attempt 2)"`
- `PendingCallFooter > backoff throttled prefix uses "Throttled by provider"`
- `PendingCallFooter > backoff transient prefix uses "Transient model error"`
- `PendingCallFooter > backoff with retry_at appends "- retrying in Xs"`
- `PendingCallFooter > backoff without retry_at omits the "retrying in" tail`
- `PendingCallFooter > root element has role=status and aria-live=polite`

### 10.7 Backend tests

- `src/__tests__/agents/round-id.test.ts > formatRoundId round-trips through web parseRoundId for every emission shape`
- `src/__tests__/agents/agent-adapter.tool-call-id.test.ts > tool_call records persist tool_call_id scalar equal to tc.id`
- `src/__tests__/agents/session-persistence.round-stamp.test.ts > appendMessage rejects records without round_id/message_index/block_index`
- `src/__tests__/agents/session-persistence.round-stamp.test.ts > agentMessageSchema rejects round_id "r-foo"`
- `src/__tests__/runtime/active-runtime-activity.test.ts > getActivityStatus returns null pending_call after invocation_succeeded`
- `src/__tests__/runtime/active-runtime-activity.test.ts > invocation_failed with recoveryAction=retry sets status=backoff and retry_at = now+retryDelayMs`
- `src/__tests__/runtime/active-runtime-activity.test.ts > retry_attempted with retryDelayMs bumps attempt and updates retry_at`
- `src/__tests__/runtime/active-runtime-activity.test.ts > model_selected after retry sets status=in_flight (clears retry_at)`
- `src/__tests__/server/routes/conversation.test.ts > /api/agents/:id/conversation returns { session, entries, activity_status }`
- `src/__tests__/server/routes/conversation.test.ts > activity_status always present (pending_call may be null)`

### 10.8 Tests deleted (no aliasing)

- The flat-steps tests in [web/src/__tests__/agents-store.test.ts](../../../web/src/__tests__/agents-store.test.ts) that exercise `groupIntoSteps()` / `MessageStep` are deleted, not rewritten.
- Any `.tool-call` / `.tool-result` selector assertions on
  `AgentConversationView` are deleted in favour of
  `data-testid="tool-chip"` assertions per F02 r2 §5.2.

---

## 11. Out of scope

- No port of v2's 692-line [toolFormatters.ts](../../../../saivage/web/src/utils/toolFormatters.ts). F05 r2 supersedes it.
- No new `InlinePart` kinds beyond F05 r2's four. No `InlinePart.root: 'project'`.
- No `MarkdownText` capability changes.
- No new WS event type (`agent-activity-status` rejected, §6.4).
- No streaming/delta protocol; entries arrive whole.
- No SSE, GraphQL subscriptions, long-poll.
- No virtualization / windowing for very long conversations.
- No JSONL migration tool. Pre-F03 `.saivage/agents/messages/*.jsonl` are unreadable post-change; test projects get reset (project guideline).
- No analyst-chat composer changes (F04); F03 only swaps the in-line `tool-chip*` markup in `AnalystChatPanel.vue` to the shared `ToolChip` (§8.2).
- No sidebar / roster changes; F03 stops at the thread-panel boundary plus the AnalystChatPanel chip swap.
- No router changes beyond the existing `navigateToLink` wiring used by `FormattedContent`/markdown links.
- No replacement of highlight.js (`CodeBlock` unchanged).
- No project-root file linking; tool-call paths under the project working tree render as plain text per F05 r2 §4.3.
