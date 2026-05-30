# F03 — Conversation rounds / diagnostics / pairing — Functional analysis (r1)

Writer pass for issue [F03-conversation-rounds.md](../F03-conversation-rounds.md). Source of truth for v2 is the already-split agents folder under [saivage/web/src/components/agents/](../../../../saivage/web/src/components/agents/); the issue text mentions a monolithic 1500-line `AgentsView.vue` but the v2 repo has since been refactored into typed building blocks (`timeline.ts`, `round-id.ts`, `types.ts`, `AgentRoundCard.vue`, `ToolCallRow.vue`, etc.). Those split files **are** what we port — we do not need to re-invent the algorithm.

## 1. Behavior to reproduce

The v2 agent thread renders a **flat stream of `ConversationEntry` records** into a **structured timeline of rounds + standalone items + a live footer**. Each item below is something v3 currently does **not** do.

### 1.1 Round bucketing
- Entries are grouped by their `roundId` string ([saivage/web/src/components/agents/timeline.ts](../../../../saivage/web/src/components/agents/timeline.ts) lines 14-25). Round IDs have four shapes (see [saivage/web/src/components/agents/round-id.ts](../../../../saivage/web/src/components/agents/round-id.ts)):
  - `r-pre` — synthetic pre-thread cluster (system/setup), tier 0.
  - `r-msg:N` — user-message anchored cluster (tier 1, N = message index).
  - `rK` — assistant turn K (tier 2). Leading zeros tolerated; negatives and non-numeric tails are unknown.
  - `r-compacted-K` — server-emitted compacted cluster (tier 3).
  - Anything else parses as `unknown` and the **entire bucket is dropped** (timeline.ts line 31).
- Rounds are sorted by **earliest entry timestamp**, with ties broken by `(tier, index)` so `r-pre` precedes `r0`, `r1` precedes `r-compacted-3`, etc. (timeline.ts lines 126-132, see also test "sorts pre, round, and compacted buckets by round-id tier for equal timestamps").

### 1.2 Tool-pair matching
- Inside a non-pre / non-compacted round, entries are split into four sub-streams: `reasoning`, `toolPairs`, `context` (user/system text), `diagnostics` (timeline.ts lines 42-95).
- A `ToolPair` is identified by `toolUseId` (timeline.ts lines 52-86):
  - A `tool_call` entry creates / fills `pair.call`.
  - A `tool_result` entry fills `pair.result` and sets `status = 'ok'`.
  - A `tool_error` entry fills `pair.result` and sets `status = 'error'`.
- Status taxonomy is **five-valued** (`saivage/web/src/components/agents/types.ts`):
  - `ok` — call + result both present, success.
  - `error` — call + result, result kind is `tool_error` (or orphan error result).
  - `missing` — call seen, no result yet, round is **not** the pending round.
  - `pending` — call seen, no result yet, round **is** the current pending round (`pendingRoundId` argument); upgraded post-hoc at timeline.ts lines 99-101.
  - `orphan` — result seen with no matching call in this round.
- Entries missing a `toolUseId` are **dropped with a single `console.warn` per drop** (timeline.ts lines 4-8, 58-60). This is intentional fail-loud behavior — the v3 backend must always emit `toolUseId` or the UI silently swallows tool I/O.

### 1.3 Diagnostic kinds
- `model_issue`, `model_repair`, `model_recovered` are first-class entries (not `text`/`activity`). They render with tone-coded labels (timeline.ts lines 43-46; [saivage/web/src/components/agents/AgentRoundCard.vue](../../../../saivage/web/src/components/agents/AgentRoundCard.vue) lines 23-37):
  - `model_recovered` → tone `ok` (green).
  - `model_repair` → tone `warn` (amber).
  - `model_issue` → tone `danger` (red).
- A round with only diagnostics (no reasoning, no context, no tool pairs) is **promoted to standalone `diagnostic` timeline items** — one per entry, sorted in-line (timeline.ts lines 109-117).

### 1.4 Standalone context
- A round that has user/system text but no assistant reasoning becomes a `context` timeline item — renders as a left-bordered block ([saivage/web/src/components/agents/AgentConversationPane.vue](../../../../saivage/web/src/components/agents/AgentConversationPane.vue) lines 150-163, timeline.ts lines 119-121).

### 1.5 Compacted clusters
- `r-pre` and `r-compacted-N` buckets always render as a single `compacted` item ([AgentConversationPane.vue](../../../../saivage/web/src/components/agents/AgentConversationPane.vue) lines 165-186): a collapsible summary row `"- compacted, K diagnostic(s) re-keyed -"` with the full diagnostic list revealed on click. The collapsed/expanded state is tracked by the shared `expanded: Set<string>` keyed by the cluster id.

### 1.6 Ambient model spec
- The thread header shows the **first round's `modelSpec`** as the default ([AgentConversationPane.vue](../../../../saivage/web/src/components/agents/AgentConversationPane.vue) lines 45-50). Each individual round emits a tiny "`via <modelSpec>`" annotation **only when its model differs from the default** ([AgentRoundCard.vue](../../../../saivage/web/src/components/agents/AgentRoundCard.vue) lines 40-45). The hover title shows `requestedModelSpec` if it was different (e.g. provider re-route).

### 1.7 Pending-call footer
- When `conversation.activity_status.pending_call` is not null, a `<footer>` row renders at the bottom of the thread body ([AgentConversationPane.vue](../../../../saivage/web/src/components/agents/AgentConversationPane.vue) lines 188-208) with two modes:
  - `status === 'in_flight'`: `"Waiting for model... 12s (attempt 2)"` — uses `durationSince(started_at)`; "(attempt N)" suffix only when `attempt > 1`.
  - `status === 'backoff'`: `"Throttled by provider - retrying in 8s"` or `"Transient model error - retrying in 8s"`; trailing `attempt N` chip; `retry_at` countdown via `durationUntil`.
- The footer has `role="status"` + `aria-live="polite"` so assistive tech announces it without spam.
- The `pendingRoundId` is computed by **scanning all entries and picking the highest tier-2 `rK` index** (AgentConversationPane.vue lines 31-43) — this is what marks one round's open tool calls as `pending` rather than `missing`.

### 1.8 Expand / collapse details
- `expanded: Set<string>` is shared across all timeline items ([useAgentConversation.ts](../../../../saivage/web/src/composables/useAgentConversation.ts) lines 23, 105-110). It is keyed by:
  - `pair.toolUseId` for tool-row open/close.
  - `cluster.id` (which equals `roundId`) for compacted clusters.
- The set is **cleared on agent switch** (useAgentConversation.ts line 80) so state doesn't bleed between agents.
- v3 today already has an `expandedToolCalls: Set<string>` plus `expandAll() / collapseAll()` buttons in [web/src/components/agents/AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue) lines 17-19. That set is reusable but currently keyed by `message.id` (one set per entry, not one per *pair*); needs to be rekeyed to `tool_call_id`.

### 1.9 Scroll-stickiness
- The thread body is bound via `bindThreadBody(() => agentPane.value?.getThreadBodyEl() ?? null)` from `AgentsView.vue`. On every poll, if the user was within `SCROLL_BOTTOM_TOLERANCE_PX` of the bottom, the view auto-scrolls back to the bottom; otherwise it preserves the user's scroll position ([useAgentConversation.ts](../../../../saivage/web/src/composables/useAgentConversation.ts) lines 32-67). v3 has no scroll-stickiness logic.

### 1.10 Polling cadence
- Roster: `ROSTER_POLL_INTERVAL_MS = 5_000`. Conversation: `AGENT_CONVERSATION_POLL_INTERVAL_MS = 3_000`. Clock tick (for `elapsed()` countdowns in the footer/header): `CLOCK_TICK_MS = 1_000` ([saivage/web/src/components/agents/constants.ts](../../../../saivage/web/src/components/agents/constants.ts)).
- v3 today combines a WS push channel with a one-shot REST fetch — no periodic re-poll of the conversation REST endpoint (see [web/src/stores/agents.ts](../../../web/src/stores/agents.ts) lines 172-198 `fetchConversation` + 318-359 WS subscriptions).

## 2. Wire-contract gap

The v3 backend currently exposes `GET /api/agents/:id/conversation` from [src/server/routes/runtime-config-notes.ts](../../../src/server/routes/runtime-config-notes.ts) line 115, returning `{ session, messages }` where each message is the persistence-layer `AgentMessage` (defined in [src/schemas/types.ts](../../../src/schemas/types.ts) line 80 and mirrored on the web side at [web/src/api/types.ts](../../../web/src/api/types.ts) lines 389-397):

```ts
// v3 — current
interface AgentMessage {
  id: string;
  session_id: string;
  role: MessageRole;            // 'user' | 'assistant' | 'system' | 'tool'
  kind: MessageKind;            // includes tool_call|tool_result|tool_error|model_issue|model_repair|model_recovered ✓
  content: string;
  tool?: string;
  tool_call_id?: string;
  timestamp: string;
  links?: EntityLink[];
}
```

Compared against v2 ([saivage/web/src/api/types.ts](../../../../saivage/web/src/api/types.ts) lines 64-108):

| Field needed by `entriesToTimeline()` and the render | Present in v3? | Notes |
|---|---|---|
| `kind: 'text'\|'activity'\|'tool_call'\|'tool_result'\|'tool_error'\|'model_issue'\|'model_repair'\|'model_recovered'` | YES | Identical enum (types.ts line 364). |
| `role: 'user'\|'assistant'\|'system'` | YES, with extra `'tool'` | Harmless — `'tool'` never appears in the timeline branches; v2 timeline only inspects `'assistant'` and `'user'`/`'system'`. We must remember to treat `role === 'tool'` as ignored at the bucketing layer. |
| `content: string` | YES | Same. |
| `timestamp: string` (ISO) | YES | Same. |
| `roundId: string` | **MISSING** | Critical. The whole grouping algorithm keys on this. Without it, every entry collapses into one synthetic round. |
| `messageIndex`, `blockIndex` (numeric block coordinates) | **MISSING** | Used in v2 to key `:key` attributes and to deterministically order entries inside a round; not strictly required for correctness but needed to avoid the `:key` collisions you get when several entries share a millisecond timestamp. |
| `toolUseId` | **DIFFERENT NAME** | v3 has `tool_call_id` (snake_case). Wire-shape mismatch only — rename at the boundary (see §3). |
| `toolName` | **MISSING (in some form)** | v3 has `tool?: string` on call/result/error messages — close enough; we can pivot `toolName = entry.tool`. |
| `modelSpec`, `requestedModelSpec` | **MISSING** | Used by the ambient-model rule (§1.6) and the `via …` annotation. |
| `provider`, `model` | **MISSING** | Not strictly required for the round layout, but used by chat header tooling — out of scope for F03. |

Top-level response shape ([web/src/api/types.ts](../../../web/src/api/types.ts) line 752):

```ts
// v3 — current
interface AgentConversationResponse { session: AgentSession; messages: AgentMessage[]; }
```

vs v2 ([saivage/web/src/api/types.ts](../../../../saivage/web/src/api/types.ts) lines 88-108):

```ts
// v2
interface AgentConversation {
  agent_id: string;
  role: AgentRole;
  started_at?: string;
  finished_at?: string;
  message_count: number;
  entries: ConversationEntry[];
  activity_status: ActivityStatus | null;   // ← MISSING in v3
}
interface ActivityStatus {
  pending_call: {
    started_at: string;
    status: 'in_flight' | 'backoff';
    attempt: number;
    reason: string | null;
    retry_at: string | null;
  } | null;
  last_activity_at: string;
}
```

`activity_status` / `pending_call` are entirely **absent** from the v3 wire shape and from the persistence layer. Without them, the F03 pending-call footer cannot render. This is a **non-optional backend addition** for F03 to be considered complete; see §7.

The current v3 server handler reads JSONL straight from disk (`readAgentMessages` at runtime-config-notes.ts line 22) and forwards records verbatim — it does **not** synthesize round IDs. So the backend gap is split into two layers:

1. **Persistence layer** ([src/agents/session-persistence.ts](../../../src/agents/session-persistence.ts) and the `AgentMessage` writers): start stamping `round_id` / `message_index` / `block_index` / `model_spec` / `requested_model_spec` onto each appended record at write time.
2. **Live state**: an `activity_status` object stored on the runtime side (presumably already known to the LLM transport / recovery code in [src/agents/recovery.ts](../../../src/agents/recovery.ts) and [src/agents/llm-transport.ts](../../../src/agents/llm-transport.ts)) and merged into the conversation response.

## 3. View model

We port the v2 interfaces verbatim into v3 with **snake_case → camelCase translation only where the v3 wire is snake_case**. New file: [web/src/components/agents/types.ts](../../../web/src/components/agents/types.ts) (does not exist yet — current v3 has no `agents/` types).

```ts
// web/src/components/agents/types.ts (new)
import type { AgentMessage } from '../../api/types';

export type ConversationEntry = AgentMessage & {
  roundId: string;                  // server-stamped; required
  messageIndex: number;             // server-stamped
  blockIndex: number;               // server-stamped
  toolUseId?: string;               // alias of tool_call_id at the boundary
  toolName?: string;                // alias of tool at the boundary
  modelSpec?: string;
  requestedModelSpec?: string;
};

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

export interface ActivityStatus {
  pending_call: {
    started_at: string;
    status: 'in_flight' | 'backoff';
    attempt: number;
    reason: string | null;
    retry_at: string | null;
  } | null;
  last_activity_at: string;
}
```

`AgentConversationResponse` is replaced (no shim, per project guideline) with:

```ts
// web/src/api/types.ts
export interface AgentConversationResponse {
  session: AgentSession;
  entries: ConversationEntry[];               // was: messages: AgentMessage[]
  activity_status: ActivityStatus | null;
}
```

The boundary translator (`messages` → `entries`) lives in the API client so the store layer never sees the wire-level naming; this is described in §5.

## 4. Algorithm to port (`entriesToTimeline`)

Direct port of [saivage/web/src/components/agents/timeline.ts](../../../../saivage/web/src/components/agents/timeline.ts) to `web/src/components/agents/timeline.ts`. The function is **pure** and **fully testable**; we port the v2 test file [timeline.test.ts](../../../../saivage/web/src/components/agents/timeline.test.ts) as-is (171 lines, already covers the corner cases).

In plain English:

1. **Bucket** entries by `roundId` into a `Map<string, ConversationEntry[]>` preserving insertion order. `Map` insertion order matches first-seen order, which equals server emit order.
2. For each bucket, compute the **earliest timestamp** (string `localeCompare` works for ISO-8601). This is the timeline-sort key.
3. **Parse the round id** (`parseRoundId`). Branch:
   - `kind === 'pre'` or `kind === 'compacted'` → emit `{ kind: 'compacted', ..., compacted: bucket }` and `continue`.
   - `kind === 'unknown'` → **drop the bucket** (silently — bug bucket; corresponds to malformed server data and we want it loud at the server side, not chatty in the UI).
   - `kind === 'msg'` or `kind === 'round'` → fall through to the four-stream split.
4. **Four-stream split** (single pass over the bucket):
   - `model_*` → `diagnostics`.
   - `tool_call` → `callMap.set(toolUseId, …)`; if no `toolUseId`, `console.warn` and drop. If a call appears twice with the same `toolUseId`, the second one overwrites (this is what v2 does at timeline.ts lines 62-69 — `existing.call = entry`).
   - `tool_result` / `tool_error` → fill `pair.result`; if no matching call in this round, push to `orphanPairs[]` with status `error` (for `tool_error`) or `orphan` (for `tool_result`).
   - `kind === 'activity'`, or `kind === 'text' && role === 'assistant'` → `reasoning`.
   - `kind === 'text' && (role === 'user' || role === 'system')` → `context` ("`userText`" in v2's variable name).
   - Everything else (including `role === 'tool'` which v3 has but v2 does not) is dropped.
5. **Pending upgrade**: combine `callMap.values()` with `orphanPairs[]` into `toolPairs`; if `pendingRoundId === id`, **upgrade any pair with `call && !result`** from `missing` to `pending`.
6. **Model-spec lift**: `modelEntry = reasoning.find(modelSpec) ?? bucket.find(modelSpec)` — i.e. first reasoning entry with a model annotation wins; fall back to any entry in the bucket. Copy `modelSpec` and `requestedModelSpec` onto the `Round`.
7. **Emit the item** for this round:
   - `reasoning.length > 0` → `{ kind: 'round' }`.
   - else if **only** diagnostics → emit **one `{ kind: 'diagnostic' }` per diagnostic**, each with `id = `${ts}:${kind}:${roundId}``. This is the corner case where a model failure happened with no preceding assistant turn (e.g. immediate transport error).
   - else → `{ kind: 'context' }` (the round becomes a left-bordered context block).
8. **Sort**: primarily by `timestamp` (string `localeCompare`); ties broken by `roundIdSortKey(id)` returning `[tier, index]` so `r-pre`(0,0) < `rK`(2,K) < `r-compacted-N`(3,N). `r-msg:M`(1,M) sits between `r-pre` and `rK`.

The `pendingRoundId` argument is derived in the **calling component**, not the algorithm. v2 computes it as "highest tier-2 index among all entries" ([AgentConversationPane.vue](../../../../saivage/web/src/components/agents/AgentConversationPane.vue) lines 31-43). v3 will mirror this in the composable so the algorithm stays pure.

Corner cases (all already covered by [timeline.test.ts](../../../../saivage/web/src/components/agents/timeline.test.ts)):

- `r-pre` always sorts before any `rK` even if they share the same earliest timestamp (test "sorts r-pre before r1 when timestamps match").
- A `tool_call` and `tool_result` paired but with no assistant reasoning in the round still produce a `context` item, with the tool pair present on `context.toolPairs`. The pane template **does not** render `toolPairs` for `context` items today — verify if we want to keep that behavior or render the pair anyway. **Recommendation: keep v2's behavior** (don't surface bare tool calls without reasoning; they look orphaned in the UI).
- A single missing-toolUseId entry produces exactly one `console.warn` (test "drops tool entries missing toolUseId and warns once per dropped entry").
- A bucket whose `roundId` is malformed (`r-compacted-3x`, `r+1`, `R1`, …) drops **everything in that bucket** with no warning. Server-side malformations are silently invisible; we accept that and ensure the server tests forbid producing them.
- An `activity_status.pending_call` referencing a round id that doesn't appear in any entry produces `pendingRoundId === null` (no upgrade). That's acceptable — the footer still renders; only the per-pair `pending` mark is missing.

## 5. Store-layer changes

Current v3 store at [web/src/stores/agents.ts](../../../web/src/stores/agents.ts) (lines 27-77) defines a *local* `groupIntoSteps()` that produces a flat `MessageStep[]` (`{ reasoning?, toolCall?, toolResult? }`). It is the **only consumer** of that grouping and is consumed by [AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue) lines 30-104. After the port:

**Remove (per project guideline — no `legacySteps` shim):**

- `interface MessageStep` (lines 32-37).
- `function groupIntoSteps(messages)` (lines 39-76).
- `const steps = computed(() => groupIntoSteps(messages.value))` (line 111).
- `expandedToolCalls` keyed by `msg.id` semantics — replaced by an `expandedDetails: Set<string>` keyed by `toolUseId` for tool pairs **and** by `roundId` for compacted clusters.
- The `MessageStep` consumer block in `AgentConversationView.vue` lines 30-104.

**Add:**

- `messages: AgentMessage[]` is replaced by `entries: ConversationEntry[]`. The API client adapter ([web/src/api/client.ts](../../../web/src/api/client.ts) — already imports `getAgentConversation`) is the boundary that translates wire `messages` → `entries` (rename `tool_call_id` → `toolUseId`, `tool` → `toolName`, copy `round_id` → `roundId`, `model_spec` → `modelSpec`, etc.). Once the backend ships canonical camelCase + `entries`, this adapter becomes a pass-through and can be deleted in a follow-up. We **do not** keep the old `messages` field in the store at all.
- `activityStatus: ActivityStatus | null` on the store, updated on each refresh.
- `toggleDetails(id: string)` (id = `toolUseId` *or* `roundId`).
- `expandAll()` / `collapseAll()` rewritten to operate over the *timeline*, not raw messages: for each timeline item, add `pair.toolUseId` for every pair and add `compacted.id` for each compacted cluster.

**Where the timeline lives:**

Recommendation: extract the timeline computation into a **new composable**, `web/src/composables/useAgentTimeline.ts`, that takes the `entries` ref + a `pendingRoundId` ref and returns `{ timeline, defaultModelSpec }`. Reasons:

1. Pure-function `entriesToTimeline()` is already trivially unit-testable, but the **derivation of `pendingRoundId`** and the **selection of `defaultModelSpec`** are two more small bits of logic that we want covered by tests without involving Pinia.
2. Keeping `timeline` out of the Pinia store keeps the store small and avoids cache-invalidation headaches when entries are appended via WS (Pinia computeds re-run anyway, but conceptually the timeline is a *view-model*, not *state*).
3. The composable can also own the **scroll-stickiness** logic (currently in the v2 `useAgentConversation` composable) so the `AgentConversationView` component stays purely declarative.

So the final v3 split is:

- [web/src/components/agents/timeline.ts](../../../web/src/components/agents/timeline.ts) — pure `entriesToTimeline`.
- [web/src/components/agents/round-id.ts](../../../web/src/components/agents/round-id.ts) — pure `parseRoundId`, `roundIdSortKey`.
- [web/src/components/agents/types.ts](../../../web/src/components/agents/types.ts) — `Round`, `ToolPair`, `TimelineItem`, etc.
- [web/src/components/agents/timeline.test.ts](../../../web/src/components/agents/timeline.test.ts) — port of v2 tests.
- [web/src/components/agents/round-id.test.ts](../../../web/src/components/agents/round-id.test.ts) — port of v2 tests.
- [web/src/composables/useAgentTimeline.ts](../../../web/src/composables/useAgentTimeline.ts) — derives timeline + pendingRoundId + defaultModelSpec from store refs; also owns `expanded: Ref<Set<string>>`, `toggleDetails`, scroll-stickiness, polling.
- [web/src/stores/agents.ts](../../../web/src/stores/agents.ts) — owns `entries`, `currentSession`, `activityStatus`, REST + WS sync. No grouping logic.

## 6. Component decomposition

Current state ([web/src/components/agents/AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue)) is a 236-line monolith mixing header, toolbar, raw-LLM toggle, warning banner, message loop, scoped CSS with hex hard-codes. After the port it becomes a thin shell that maps `timeline.value` to typed primitives. Primitives needed (F02 covers the visual primitives, this issue introduces the agent-thread primitives):

```
AgentConversationView.vue   (≈80 lines, layout + header only)
 ├─ ConversationHeader        (role / agent_id / defaultModelSpec / elapsed / status)
 ├─ ConversationToolbar       (Expand all / Collapse all / Raw LLM exchange toggle)
 ├─ RawLlmExchangePanel       (existing, unchanged)
 ├─ ConversationWarning       (existing)
 ├─ AgentThreadBody           (scrollable; binds scroll ref; loops timeline)
 │    ├─ <AgentRoundCard>     for kind === 'round'
 │    │    ├─ <ToolChip>      one per pair (F04 also consumes this)
 │    │    └─ <DiagnosticRow> one per round-attached diagnostic
 │    ├─ <DiagnosticRow>      for kind === 'diagnostic' (standalone)
 │    ├─ <ContextBlock>       for kind === 'context'
 │    └─ <CompactedCluster>   for kind === 'compacted'
 └─ <PendingCallFooter>       when activity_status.pending_call !== null
```

Template sketches (Vue 3 SFC, `<script setup lang="ts">`):

**`AgentConversationView.vue`** (post-port skeleton):

```vue
<template>
  <div class="agent-conversation">
    <ConversationHeader :session="currentSession" :default-model-spec="defaultModelSpec" :now="now" />
    <ConversationToolbar @expand="expandAll" @collapse="collapseAll" @toggle-raw="rawOpen = !rawOpen" :raw-open="rawOpen" />
    <RawLlmExchangePanel v-if="rawOpen" :session-id="sessionId" />
    <ConversationWarning v-if="conversationWarning" :message="conversationWarning" />
    <div class="thread-body" ref="threadBody">
      <template v-for="item in timeline" :key="item.id">
        <AgentRoundCard
          v-if="item.kind === 'round'"
          :round="item.round" :default-model-spec="defaultModelSpec"
          :expanded="expanded" @toggle-details="toggleDetails" @open-file="onOpenFile" />
        <DiagnosticRow v-else-if="item.kind === 'diagnostic'" standalone :entry="item.diagnostic" />
        <ContextBlock v-else-if="item.kind === 'context'" :round="item.context" />
        <CompactedCluster v-else
          :id="item.id" :entries="item.compacted"
          :expanded="expanded.has(item.id)" @toggle="toggleDetails(item.id)" />
      </template>
      <PendingCallFooter v-if="activityStatus?.pending_call" :pending="activityStatus.pending_call" :now="now" />
    </div>
  </div>
</template>
```

**`AgentRoundCard.vue`** — port of [saivage/web/src/components/agents/AgentRoundCard.vue](../../../../saivage/web/src/components/agents/AgentRoundCard.vue) verbatim, replacing hex literals with the F01 semantic tokens (`var(--text)`, `var(--accent)`, `var(--warn)`, `var(--danger)`, `var(--border-subtle)`).

**`ToolChip.vue`** — port of [saivage/web/src/components/agents/ToolCallRow.vue](../../../../saivage/web/src/components/agents/ToolCallRow.vue). Renamed because the same primitive is reused by F04 (analyst chat) per the subsystem map. It accepts a `ToolPair` plus an `open: boolean` flag and emits `toggle(toolUseId)` and `open-file({path, root})`. Inside it calls `formatToolPair(name, callContent, resultContent, isError)` from a v3-side `web/src/utils/toolFormatters.ts` (port of [saivage/web/src/utils/toolFormatters.ts](../../../../saivage/web/src/utils/toolFormatters.ts), 692 lines). The existing v3 `web/src/utils/tool-presenters.ts` provides a similar but smaller surface (`presentToolCall` / `presentToolResult`) — we **replace** it, not extend (project guideline; the v2 `InlinePart` model is the supported one and the v3 `presentToolCall` API gets removed).

**`DiagnosticRow.vue`** — single component shared by the in-round diagnostics and the standalone item. Props: `entry: ConversationEntry`, `standalone?: boolean`. Internally maps `kind → tone` and `kind → label` exactly as v2 does.

**`CompactedCluster.vue`** — button + expandable list. Props: `id`, `entries: ConversationEntry[]`, `expanded: boolean`. Emits `toggle()`. Reuses `DiagnosticRow` for each child.

**`PendingCallFooter.vue`** — `role="status"` aria-live region. Props: `pending: ActivityStatus['pending_call']`, `now: number`. Internally computes `durationSince` / `durationUntil`. No emits.

**`ContextBlock.vue`** — small wrapper rendering `round.context[]` as left-bordered `FormattedContent` blocks.

**`FormattedContent.vue`** — port of [saivage/web/src/components/FormattedContent.vue](../../../../saivage/web/src/components/FormattedContent.vue) (auto-detect JSON vs markdown, max-height clamp). v3 currently uses `MarkdownText` + `CodeBlock` directly; we add `FormattedContent` as the unified renderer for everything inside the thread. This is technically an F05 dependency (markdown/json primitives) but F03 must declare it because the round card cannot render without it.

## 7. Backend additions needed

These are real backend changes; the project guideline forbids "minimal change" so we do them in the same change set as F03 rather than carrying a UI-side fake.

### 7.1 Persistence-layer fields on `AgentMessage`

[src/schemas/types.ts](../../../src/schemas/types.ts) line 80 — extend the interface and update [src/agents/session-persistence.ts](../../../src/agents/session-persistence.ts) (currently builds the record at lines 217-232) to stamp:

```ts
export interface AgentMessage {
  id: string;
  session_id: string;
  role: MessageRole;
  kind: MessageKind;
  content: string;
  tool?: string;
  tool_call_id?: string;
  timestamp: string;
  links?: EntityLink[];
  // NEW (server-stamped at append time, never null after this change):
  round_id: string;
  message_index: number;
  block_index: number;
  // NEW (optional; only present on assistant rounds where the model was resolved):
  model_spec?: string;
  requested_model_spec?: string;
}
```

The agent runtime ([src/agents/agent-runtime.ts](../../../src/agents/agent-runtime.ts), [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts)) is responsible for choosing the round id (`r{k}` per assistant turn; `r-msg:N` for user-anchored clusters; `r-pre` for pre-thread system seeding; `r-compacted-N` for entries produced by [src/agents/compaction.ts](../../../src/agents/compaction.ts)). The exact derivation lives there and is out of scope for F03 to specify — F03 only requires that `round_id` is present and obeys [round-id.ts](../../../../saivage/web/src/components/agents/round-id.ts)'s grammar.

### 7.2 Live `activity_status` on the conversation response

Required new type alongside `AgentSession` in [src/schemas/types.ts](../../../src/schemas/types.ts):

```ts
export interface ActivityStatus {
  pending_call: {
    started_at: string;
    status: 'in_flight' | 'backoff';
    attempt: number;
    reason: string | null;
    retry_at: string | null;
  } | null;
  last_activity_at: string;
}
```

Source of truth: the LLM transport / recovery code ([src/agents/llm-transport.ts](../../../src/agents/llm-transport.ts), [src/agents/recovery.ts](../../../src/agents/recovery.ts), [src/agents/invocation-recovery-policy.ts](../../../src/agents/invocation-recovery-policy.ts)) already tracks attempt count, throttle reason, and `retry_at` internally. The conversation route needs to read this from an in-memory store keyed by `session_id`. Concretely:

- Add `getAgentActivityStatus(sessionId: string): ActivityStatus | null` to the agent runtime module.
- In [src/server/routes/runtime-config-notes.ts](../../../src/server/routes/runtime-config-notes.ts) line 115, change the response from `reply.send({ session, messages })` to `reply.send({ session, entries: messages, activity_status: getAgentActivityStatus(sessionId) })`.

Whether `entries` is the JSON field name or the API client renames `messages → entries` is a small style choice; **recommendation: rename on the wire** because v2 already uses `entries` and our docs reference the v2 shape. Once both sides agree, the web-side adapter (§3) becomes trivial.

### 7.3 WS pushes that carry round-id

The WS `thinking` and `activity` events ([web/src/stores/agents.ts](../../../web/src/stores/agents.ts) lines 339-358) deliver an `AgentMessage`. With the new fields, every pushed message carries `round_id`/`message_index`/`block_index`, so the timeline recomputes correctly on append without a full refetch. **No new event types needed**; only the payload type widens.

A small adjacent concern: `activity_status` changes (model goes from `in_flight` to `backoff`, attempt increments, etc.) must reach the UI without a 3-second poll lag for the footer to feel live. Options, in priority order:

1. **Piggyback on `activity` events**: include the updated `activity_status` in every `activity` envelope's content. Cheap; no new event type.
2. New WS event `agent-activity-status` carrying `{ sessionId, activity_status }`. Cleaner; more code.

Recommendation: option 1. The footer animation can also poll the conversation endpoint at the v2 cadence (3 s) as a fallback; the `now` ref ticking at 1 s already keeps the displayed countdown smooth between fetches.

### 7.4 Backend follow-up may be deferred

If the F03 surface area is large enough to risk schedule slippage, **`activity_status` (§7.2) can be deferred to a follow-up** — the UI gracefully omits the footer when the field is missing or null. **`round_id` / per-entry metadata (§7.1) cannot be deferred** because without it the timeline degenerates to one mega-round. Recommendation: ship §7.1 and §7.3 in the same change set as the UI port; §7.2 is allowed to land one PR later if it lets §7.1 ship sooner.

## 8. Risks

- **Polling vs WS race**: v3 today only refetches on WS reconnect. After porting, we additionally REST-poll every 3 s (matching v2). If WS appends a message at t and the REST poll lands at t + 100 ms with the same message, dedup must be by `entry.id`. The store's `appendMessage` (lines 244-253) appends unconditionally — needs a `if (!entries.some(e => e.id === msg.id))` guard.
- **Scroll preservation across refetch**: the v2 `useAgentConversation` measures `isScrolledToBottom()` *before* swapping the entries array and re-scrolls in `nextTick` if so. v3 will mirror this in `useAgentTimeline.ts`. Risk: replacing the underlying `entries.value` with a brand-new array makes Vue throw away DOM nodes and the scroll position can jump to 0 before our `nextTick` rescues it. Mitigation: prefer mutation (`splice`/`push`) over reassignment for WS-driven appends; only reassign on `load(newAgentId)`.
- **Stale tool-pair state during re-fetch**: a `tool_call` with no result has status `pending` only when its round matches `pendingRoundId`. If the LLM call is still in flight when the user switches to another agent and back, the rebuild must recompute `pendingRoundId` from the fresh entries. The composable already does this each tick because `pendingRoundId = computed(…)` depends on `entries`.
- **Very long conversations**: a 5000-entry session creates 5000-entry buckets; the `Map` walk is O(n) and the per-bucket re-pass is O(bucket size), so total is O(n). The Vue render cost is dominated by `FormattedContent` (markdown + highlight.js). Mitigation: leave the v2 `max-height` clamps in [constants.ts](../../../../saivage/web/src/components/agents/constants.ts) (reasoning 460px, tool detail 320px, diagnostic 200px, context 320px). If perf becomes a problem later, we add virtualization, but not in F03 scope.
- **Accessibility of expand/collapse**: the v2 `<button>` rows already set `aria-expanded`. Port the attribute. The compacted cluster also exposes `aria-expanded`. The pending footer uses `role="status" aria-live="polite"`. **Risk**: shifting focus to a newly expanded tool detail can be disorienting; v2 doesn't move focus, just renders the panel — we do the same.
- **Route navigation from links**: v3 currently does `router.push({ name: 'card-detail', ... })` from `EntityLink` clicks. After the port, links inside reasoning markdown still work (they go through `MarkdownText`/`FormattedContent`), but links **inside tool chips** (`tool-link tool-file`) emit `open-file` which the parent maps to a route. We need to wire `@open-file` up to the same router push the existing `navigateToLink` does — easy, but easy to miss.
- **`role: 'tool'` entries**: v3's `MessageRole` type includes `'tool'`, which v2 does not. The timeline branches at v2 timeline.ts lines 80-92 never accept `role: 'tool'`, so those entries fall through and are dropped. This is **correct** (tool entries are surfaced through `toolPairs`, not as freestanding rows) but worth a one-line comment in the v3 port.
- **Round-id grammar drift**: if the backend ever invents a new shape (`r-foo:bar`), every entry of that round gets dropped silently. Mitigation: backend type tests should pin the grammar; v3 web tests should fail on any seen-in-production round id that `parseRoundId` returns `unknown` for.

## 9. Non-goals

- **No streaming protocol redesign.** Server still emits per-message WS events; we do not introduce server-sent delta streams or partial-message reconstruction.
- **No new transports.** No SSE, no GraphQL subscriptions, no long-poll.
- **No AI-summarization of rounds.** The "compacted cluster" already exists server-side (produced by [src/agents/compaction.ts](../../../src/agents/compaction.ts)); the UI never invokes an LLM to summarize entries.
- **No persistence-format migration tooling.** Per project guideline, we change the JSONL schema on disk and drop any reader that expected the old shape. Existing `.saivage/agents/messages/*.jsonl` files written before the change are allowed to be lost / unreadable; resetting test projects is cheaper than carrying a shim.
- **No analyst-chat or external-chat changes.** F04 owns the analyst chat surface; F03 only ensures the `ToolChip` primitive is reusable.
- **No raw-LLM-exchange-panel changes.** That surface ([web/src/components/agents/RawLlmExchangePanel.vue](../../../web/src/components/agents/RawLlmExchangePanel.vue)) is unaffected by F03.
- **No sidebar / roster changes.** Active vs History tabs and the conversation sidebar are part of the broader port but live under a sibling component; F03 stops at the thread-panel boundary.
- **No virtualization or windowing.** Out of scope; revisit only if profiling shows a real problem.
