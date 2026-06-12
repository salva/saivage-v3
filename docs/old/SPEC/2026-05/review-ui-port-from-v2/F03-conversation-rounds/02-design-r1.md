# F03 — Conversation rounds / diagnostics / pairing — Design (r1)

Writer round 1. Builds on the approved analyses:
[F03 r2](01-analysis-r2.md), [F01 r2](../F01-design-tokens/01-analysis-r2.md),
[F02 r2](../F02-component-hierarchy/01-analysis-r2.md),
[F04 r3](../F04-analyst-surface/01-analysis-r3.md),
[F05 r2](../F05-tool-detail-rendering/01-analysis-r2.md). Issue:
[F03-conversation-rounds.md](../F03-conversation-rounds.md).

**Mandatory project rules (binding for this design):**

- **Architecture-first.** Layering wins over short-term diff size.
  The wire contract is one canonical shape; the pure timeline
  algorithm is a non-Vue utility; the Vue surface owns no
  algorithmic state.
- **No backward compatibility.** The same change set that lands the
  new types/components also deletes the flat `MessageStep` /
  `groupIntoSteps()` machinery
  ([web/src/stores/agents.ts L30-L76](../../../web/src/stores/agents.ts#L30-L76)),
  the `messages` field on `AgentConversationResponse`
  ([web/src/api/types.ts](../../../web/src/api/types.ts)),
  the legacy `appendMessage(...)` signature without round-stamp
  fields
  ([src/agents/session-persistence.ts L209-L246](../../../src/agents/session-persistence.ts#L209-L246)),
  the legacy WS `content.message` payload key, and the
  `.tool-call`/`.tool-result` test selectors. Nothing is kept "for
  later"; nothing is aliased; the analyst-chat in-line `tool-chip*`
  markup in
  [web/src/components/chat/AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue)
  is replaced with the new shared `ToolChip` in the same PR.

---

## 0. Overview

Two proposals are developed. Both implement the same observable
behaviour (v2 parity per analysis §1). They differ in **where the
round-bucketing algorithm lives** and **what the backend is
responsible for stamping**:

| Aspect                       | Proposal A — *Focused fix* (analysis-r2 plan) | Proposal B — *Minimal backend, view-side derivation* |
| ---------------------------- | --------------------------------------------- | --------------------------------------------------- |
| Backend stamps `round_id`?   | Yes — required field, schema-enforced         | No — backend stays at today's shape                 |
| Backend stamps `message_index`/`block_index`? | Yes — required          | Yes — `message_index` only (already monotone)       |
| Round derivation lives in    | Pure web util `entriesToTimeline()`           | Pure web util `entriesToTimeline()` **+** a sibling `inferRoundId()` that walks the entry stream |
| Wire contract                | `{ session, entries, activity_status }`       | `{ session, entries, activity_status }`             |
| Server-side `ActiveRuntime` counters | Required (round/block counters)         | Activity-status only; no round counters             |
| `tool_call_id` scalar fix    | Required                                      | Required                                            |
| Compaction surface           | Backend stamps `r-compacted-N`                | Backend marks compacted entries with `compacted: true`; client derives ids |
| F04 alignment                | Shared `ToolChip` — F03 PR contains the swap  | Shared `ToolChip` — F03 PR contains the swap        |

The recommendation in §4 picks one.

---

## 1. Shared backend & wire surface (used by both proposals)

The activity-status pipeline (analysis §6) and the `tool_call_id`
scalar fix (analysis §5.5) are required by **both** proposals; they
are not the axis of disagreement. They are specified once here.

### 1.1 `ActiveRuntime` activity-status additions

```ts
// src/runtime/active-runtime.ts (additions; the existing class at L30 is widened)

export interface PendingCall {
  started_at: string;
  status: 'in_flight' | 'backoff';
  attempt: number;
  reason: 'throttled' | 'transient' | null;
  retry_at: string | null;
}

export interface ActivityStatus {
  pending_call: PendingCall | null;
  last_activity_at: string;
}

interface SessionActivity {
  last_activity_at: string;
  pending_call: PendingCall | null;
}

export class ActiveRuntime {
  // ... existing fields
  private activity = new Map<string, SessionActivity>();

  constructor(/* existing args */, eventBus: EventBus) {
    // existing wiring +
    eventBus.on('session_started',  (e) => this.touchSession(e.session_id, null));
    eventBus.on('model_selected',   (e) => this.onModelSelected(e));
    eventBus.on('invocation_succeeded', (e) => this.onInvocationDone(e));
    eventBus.on('invocation_failed', (e) => this.onInvocationFailed(e));
    eventBus.on('retry_attempted',  (e) => this.onRetryAttempted(e));
    eventBus.on('session_cancelled', (e) => this.clearPending(e.session_id));
    eventBus.on('session_force_cancelled', (e) => this.clearPending(e.session_id));
  }

  getActivityStatus(sessionId: string): ActivityStatus {
    const a = this.activity.get(sessionId);
    if (!a) return { pending_call: null, last_activity_at: new Date(0).toISOString() };
    return { pending_call: a.pending_call, last_activity_at: a.last_activity_at };
  }

  /** Called from session-persistence.appendMessage after every successful append. */
  recordAppend(sessionId: string, timestamp: string, finalText: boolean): void {
    const a = this.ensure(sessionId);
    a.last_activity_at = timestamp;
    if (finalText) a.pending_call = null;
  }

  // private transition handlers — see analysis §6.2 table for the exact rules.
  private onModelSelected(e: { session_id: string; provider: string; model: string }): void {
    const a = this.ensure(e.session_id);
    a.pending_call = { started_at: nowIso(), status: 'in_flight', attempt: 1, reason: null, retry_at: null };
    a.last_activity_at = nowIso();
  }
  private onInvocationDone(e: { session_id: string }): void {
    const a = this.ensure(e.session_id);
    a.pending_call = null;
    a.last_activity_at = nowIso();
  }
  private onInvocationFailed(e: { session_id: string; attempt: number; failureClass: string; recoveryAction: string; retryDelayMs?: number }): void {
    const a = this.ensure(e.session_id);
    if (e.recoveryAction === 'retry') {
      a.pending_call = {
        started_at: a.pending_call?.started_at ?? nowIso(),
        status: 'backoff',
        attempt: e.attempt,
        reason: failureClassToReason(e.failureClass),
        retry_at: e.retryDelayMs != null ? new Date(Date.now() + e.retryDelayMs).toISOString() : null,
      };
    } else {
      a.pending_call = null;
    }
    a.last_activity_at = nowIso();
  }
  private onRetryAttempted(e: { session_id: string; attempt: number; retryDelayMs?: number; failureClass?: string }): void {
    const a = this.ensure(e.session_id);
    if (a.pending_call) {
      a.pending_call.attempt = e.attempt;
      if (e.retryDelayMs != null) {
        a.pending_call.status = 'backoff';
        a.pending_call.retry_at = new Date(Date.now() + e.retryDelayMs).toISOString();
        if (e.failureClass) a.pending_call.reason = failureClassToReason(e.failureClass);
      }
    }
    a.last_activity_at = nowIso();
  }
  private clearPending(sessionId: string): void {
    const a = this.ensure(sessionId);
    a.pending_call = null;
    a.last_activity_at = nowIso();
  }
  private ensure(sessionId: string): SessionActivity {
    let a = this.activity.get(sessionId);
    if (!a) { a = { last_activity_at: nowIso(), pending_call: null }; this.activity.set(sessionId, a); }
    return a;
  }
}

function failureClassToReason(cls: string): 'throttled' | 'transient' {
  return /rate|throttl/i.test(cls) ? 'throttled' : 'transient';
}
function nowIso(): string { return new Date().toISOString(); }
```

### 1.2 `tool_call_id` scalar fix

`agent-adapter.ts` L376 (assistant `tool_call` persistence) is
changed to stamp the scalar (analysis §5.5). The schema validator
adds a `superRefine` that rejects any `tool_call`/`tool_result`/
`tool_error` record without `tool_call_id`. Both proposals carry
this change unmodified.

### 1.3 Wire shape

```ts
// web/src/api/types.ts (replaces existing AgentConversationResponse + AgentMessage)

export interface AgentConversationResponse {
  session: AgentSession;
  entries: ConversationEntry[];
  activity_status: ActivityStatus;
}
```

`messages` is **removed**; `AgentMessage` is **replaced** by
`ConversationEntry` (renamed in place; no alias).

### 1.4 WS envelope widening

Both `thinking` and `activity` envelopes carry
`{ sessionId, entry, activity_status }`. No new event type.
The legacy `message` key is removed from the envelope. See
analysis §6.4 for justification.

---

## 2. Proposal A — Focused fix (analysis-r2 plan)

Backend stamps `round_id`/`message_index`/`block_index` per
analysis §5; web layer ports v2's pure `entriesToTimeline()` and
renders through F02-mandated `conversation/` components.

### 2.1 Backend: types & schema

`src/schemas/types.ts` — replaces existing `AgentMessage`:

```ts
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type MessageKind =
  | 'text' | 'activity'
  | 'tool_call' | 'tool_result' | 'tool_error'
  | 'model_issue' | 'model_repair' | 'model_recovered';

export interface AgentMessage {
  id: string;
  session_id: string;
  role: MessageRole;
  kind: MessageKind;
  content: string;
  timestamp: string;
  round_id: string;          // NEW; required; grammar: r-pre | r-msg:N | rK | r-compacted-N
  message_index: number;     // NEW; required; monotone per session
  block_index: number;       // NEW; required; monotone within round
  tool?: string;
  tool_call_id?: string;     // required at producer for tool_call/tool_result/tool_error (superRefine)
  model_spec?: string;       // NEW; assistant entries
  requested_model_spec?: string; // NEW
  links?: EntityLink[];
}
```

`src/schemas/validators.ts` mirrors the additions with a strict
regex on `round_id` and the `superRefine` on `tool_call_id` per
analysis §5.5.

### 2.2 `ActiveRuntime` round-stamping counters

```ts
// src/runtime/active-runtime.ts (additions; in the same class as §1.1)

interface SessionRoundState {
  nextRoundIndex: number;
  currentRoundId: string | null;
  nextMessageIndex: number;
  nextBlockIndex: number;
  nextCompactedIndex: number;
  lastUserMsgIndex: number | null;
}

export interface RoundStamp {
  round_id: string;
  message_index: number;
  block_index: number;
}

export class ActiveRuntime {
  // ... activity map from §1.1
  private rounds = new Map<string, SessionRoundState>();

  /** Rebuild counters from JSONL on resume. */
  rebuildSessionRoundState(sessionId: string, entries: AgentMessage[]): void {
    let maxRound = -1, maxCompacted = -1, lastMsg: number | null = null, maxMsgIdx = -1;
    for (const e of entries) {
      maxMsgIdx = Math.max(maxMsgIdx, e.message_index);
      const r = parseRoundIdServer(e.round_id);
      if (r.kind === 'round') maxRound = Math.max(maxRound, r.index);
      else if (r.kind === 'compacted') maxCompacted = Math.max(maxCompacted, r.index);
      else if (r.kind === 'msg') lastMsg = lastMsg === null ? r.index : Math.max(lastMsg, r.index);
    }
    this.rounds.set(sessionId, {
      nextRoundIndex: maxRound + 1,
      currentRoundId: null,                       // closed on rebuild; the next assistant turn opens a new round
      nextMessageIndex: maxMsgIdx + 1,
      nextBlockIndex: 0,
      nextCompactedIndex: maxCompacted + 1,
      lastUserMsgIndex: lastMsg,
    });
  }

  openAssistantRound(sessionId: string): RoundStamp {
    const s = this.ensureRounds(sessionId);
    const id = `r${s.nextRoundIndex++}`;
    s.currentRoundId = id;
    s.nextBlockIndex = 0;
    return { round_id: id, message_index: s.nextMessageIndex++, block_index: s.nextBlockIndex++ };
  }
  stampInRound(sessionId: string): RoundStamp {
    const s = this.ensureRounds(sessionId);
    if (!s.currentRoundId) throw new Error(`stampInRound: no open round for ${sessionId}`);
    return { round_id: s.currentRoundId, message_index: s.nextMessageIndex++, block_index: s.nextBlockIndex++ };
  }
  stampUserMessage(sessionId: string): RoundStamp {
    const s = this.ensureRounds(sessionId);
    s.lastUserMsgIndex = (s.lastUserMsgIndex ?? -1) + 1;
    const id = `r-msg:${s.lastUserMsgIndex}`;
    s.currentRoundId = null;
    s.nextBlockIndex = 0;
    return { round_id: id, message_index: s.nextMessageIndex++, block_index: 0 };
  }
  stampPre(sessionId: string): RoundStamp {
    const s = this.ensureRounds(sessionId);
    return { round_id: 'r-pre', message_index: s.nextMessageIndex++, block_index: 0 };
  }
  stampCompacted(sessionId: string): RoundStamp {
    const s = this.ensureRounds(sessionId);
    const id = `r-compacted-${s.nextCompactedIndex++}`;
    return { round_id: id, message_index: s.nextMessageIndex++, block_index: 0 };
  }
  stampDiagnosticInCurrentRound(sessionId: string): RoundStamp {
    const s = this.ensureRounds(sessionId);
    if (s.currentRoundId) return this.stampInRound(sessionId);
    if (s.lastUserMsgIndex !== null) {
      // attach to most recent r-msg:N
      return { round_id: `r-msg:${s.lastUserMsgIndex}`, message_index: s.nextMessageIndex++, block_index: s.nextBlockIndex++ };
    }
    return this.stampPre(sessionId);
  }
  closeRound(sessionId: string): void {
    const s = this.ensureRounds(sessionId);
    s.currentRoundId = null;
    s.nextBlockIndex = 0;
  }
  private ensureRounds(sessionId: string): SessionRoundState {
    let s = this.rounds.get(sessionId);
    if (!s) { s = { nextRoundIndex: 0, currentRoundId: null, nextMessageIndex: 0, nextBlockIndex: 0, nextCompactedIndex: 0, lastUserMsgIndex: null }; this.rounds.set(sessionId, s); }
    return s;
  }
}
```

`src/agents/round-id.ts` (new) — server-side mirror of the web
parser/formatter; the only allowed producer of `round_id` strings.

### 2.3 `appendMessage` rewrite & callsite table

`src/agents/session-persistence.ts` `appendMessage` signature
widens (analysis §5.2). Every callsite in
[agent-adapter.ts](../../../src/agents/agent-adapter.ts) is updated
in the same commit to pull a `RoundStamp` from `ActiveRuntime`
before calling. Per-site mapping is analysis §5.2's table; this
design adopts it verbatim.

Append-side hook for activity-status:

```ts
export function appendMessage(saivageDir: string, sessionId: string, msg: AppendMessageInput): AgentMessage {
  const record = /* assemble; assert round-stamp fields present */;
  writeJsonLine(saivageDir, sessionId, record);
  activeRuntime.recordAppend(sessionId, record.timestamp, record.kind === 'text' && record.role === 'assistant');
  return record;
}
```

### 2.4 Route response

`src/server/routes/runtime-config-notes.ts` conversation handler is
rewritten to the canonical shape (analysis §6.3). `readAgentMessages`
is renamed `readConversationEntries`; it parses each JSONL line
through `agentMessageSchema.parse` and returns `ConversationEntry[]`.

### 2.5 WS envelope

`src/server/websocket.ts` constructs every `thinking`/`activity`
envelope as `{ sessionId, entry, activity_status }` per §1.4.

### 2.6 Web: pure utility `web/src/utils/agent-timeline/`

`web/src/utils/agent-timeline/types.ts`:

```ts
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
  timestamp: string;
  round_id: string;
  message_index: number;
  block_index: number;
  tool?: string;
  tool_call_id?: string;
  model_spec?: string;
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
  pending_call: PendingCall | null;
  last_activity_at: string;
}
```

`web/src/utils/agent-timeline/round-id.ts` (byte-equivalent port of
[v2 round-id.ts](../../../../saivage/web/src/components/agents/round-id.ts)):

```ts
export type RoundIdShape =
  | { tier: 0; kind: 'pre' }
  | { tier: 1; kind: 'msg';       index: number }
  | { tier: 2; kind: 'round';     index: number }
  | { tier: 3; kind: 'compacted'; index: number }
  | { tier: 4; kind: 'unknown' };

function parseDecimalAll(s: string): number | null {
  if (s.length === 0) return null;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return null;
    n = n * 10 + (c - 48);
    if (n > Number.MAX_SAFE_INTEGER) return null;
  }
  return n;
}

export function parseRoundId(id: string): RoundIdShape {
  if (id === 'r-pre') return { tier: 0, kind: 'pre' };
  if (id.startsWith('r-msg:')) {
    const n = parseDecimalAll(id.slice(6));
    return n === null ? { tier: 4, kind: 'unknown' } : { tier: 1, kind: 'msg', index: n };
  }
  if (id.startsWith('r-compacted-')) {
    const n = parseDecimalAll(id.slice(12));
    return n === null ? { tier: 4, kind: 'unknown' } : { tier: 3, kind: 'compacted', index: n };
  }
  if (id.length >= 2 && id.charCodeAt(0) === 114 /* 'r' */ && id.charCodeAt(1) !== 45 /* '-' */) {
    const n = parseDecimalAll(id.slice(1));
    if (n !== null) return { tier: 2, kind: 'round', index: n };
  }
  return { tier: 4, kind: 'unknown' };
}

export function roundIdSortKey(id: string): [number, number] {
  const p = parseRoundId(id);
  if (p.kind === 'pre' || p.kind === 'unknown') return [p.tier, 0];
  return [p.tier, p.index];
}
```

`web/src/utils/agent-timeline/timeline.ts` (byte-equivalent port of
[v2 timeline.ts](../../../../saivage/web/src/components/agents/timeline.ts)
— the v3 field is `round_id`/`tool_call_id` snake_case on the
wire and is **read** as snake_case here; the view-model output
keeps the v2 camelCase names internally):

```ts
import { parseRoundId, roundIdSortKey } from './round-id';
import type { ConversationEntry, Round, TimelineItem, ToolPair } from './types';

function warnDroppedToolEntry(entry: ConversationEntry): void {
  console.warn(`[agent-timeline] tool entry without tool_call_id; dropping. kind=${entry.kind} round=${entry.round_id}`);
}

export function entriesToTimeline(
  entries: ConversationEntry[],
  pendingRoundId: string | null,
): TimelineItem[] {
  const buckets = new Map<string, ConversationEntry[]>();
  for (const entry of entries) {
    const list = buckets.get(entry.round_id);
    if (list) list.push(entry); else buckets.set(entry.round_id, [entry]);
  }
  const items: TimelineItem[] = [];
  for (const [id, bucket] of buckets) {
    const earliest = bucket.reduce((acc, e) => (acc === '' || e.timestamp < acc ? e.timestamp : acc), '');
    const shape = parseRoundId(id);

    if (shape.kind === 'pre' || shape.kind === 'compacted') {
      items.push({ kind: 'compacted', id, timestamp: earliest, compacted: bucket });
      continue;
    }
    if (shape.kind === 'unknown') continue;       // fail-loud bucket drop

    const reasoning: ConversationEntry[] = [];
    const userText:  ConversationEntry[] = [];
    const diagnostics: ConversationEntry[] = [];
    const callMap = new Map<string, ToolPair>();
    const orphanPairs: ToolPair[] = [];

    for (const e of bucket) {
      if (e.kind === 'model_issue' || e.kind === 'model_repair' || e.kind === 'model_recovered') {
        diagnostics.push(e);
      } else if (e.kind === 'tool_call') {
        if (!e.tool_call_id) { warnDroppedToolEntry(e); continue; }
        const key = e.tool_call_id;
        const existing = callMap.get(key);
        if (existing) { existing.call = e; existing.toolName = e.tool ?? existing.toolName; }
        else callMap.set(key, { toolUseId: key, toolName: e.tool ?? 'unknown', call: e, status: 'missing' });
      } else if (e.kind === 'tool_result' || e.kind === 'tool_error') {
        if (!e.tool_call_id) { warnDroppedToolEntry(e); continue; }
        const key = e.tool_call_id;
        const status: ToolPair['status'] = e.kind === 'tool_error' ? 'error' : 'ok';
        const existing = callMap.get(key);
        if (existing) { existing.result = e; existing.toolName ??= e.tool ?? 'unknown'; existing.status = status; }
        else orphanPairs.push({ toolUseId: key, toolName: e.tool ?? 'unknown', result: e, status: e.kind === 'tool_error' ? 'error' : 'orphan' });
      } else if (e.kind === 'activity' || (e.kind === 'text' && e.role === 'assistant')) {
        reasoning.push(e);
      } else if (e.kind === 'text' && (e.role === 'user' || e.role === 'system')) {
        userText.push(e);
      }
    }

    const toolPairs: ToolPair[] = [...callMap.values(), ...orphanPairs];
    const isCurrent = pendingRoundId !== null && pendingRoundId === id;
    for (const p of toolPairs) if (!p.result && p.call && isCurrent) p.status = 'pending';

    const modelEntry = reasoning.find((e) => e.model_spec) ?? bucket.find((e) => e.model_spec);
    const round: Round = {
      id, startedAt: earliest, hasAssistant: reasoning.length > 0,
      reasoning, toolPairs, context: userText, diagnostics,
      modelSpec: modelEntry?.model_spec,
      requestedModelSpec: modelEntry?.requested_model_spec,
    };

    if (reasoning.length > 0) {
      items.push({ kind: 'round', id, timestamp: earliest, round });
    } else if (diagnostics.length > 0 && userText.length === 0 && toolPairs.length === 0) {
      for (const d of diagnostics) {
        items.push({ kind: 'diagnostic', id: `${d.timestamp}:${d.kind}:${id}`, timestamp: d.timestamp, diagnostic: d });
      }
    } else {
      items.push({ kind: 'context', id, timestamp: earliest, context: round });
    }
  }

  items.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp.localeCompare(b.timestamp);
    const [at, av] = roundIdSortKey(a.id);
    const [bt, bv] = roundIdSortKey(b.id);
    return at !== bt ? at - bt : av - bv;
  });
  return items;
}
```

`web/src/utils/agent-timeline/index.ts` re-exports `parseRoundId`,
`roundIdSortKey`, `entriesToTimeline`, and the type aliases. This
barrel is allowed by F02 r2 (barrels live in `utils/`, never in
`components/`).

### 2.7 Composable `useAgentTimeline`

```ts
// web/src/composables/useAgentTimeline.ts
import { computed, nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { entriesToTimeline, parseRoundId } from '../utils/agent-timeline';
import type { ActivityStatus, ConversationEntry, TimelineItem } from '../utils/agent-timeline/types';

const SCROLL_BOTTOM_TOLERANCE_PX = 24;

export function useAgentTimeline(
  entries: Ref<ConversationEntry[]>,
  activityStatus: Ref<ActivityStatus>,
  sessionIdGetter: () => string | null,
) {
  const expanded = ref<Set<string>>(new Set());
  const threadBody = ref<HTMLElement | null>(null);
  const now = ref<number>(Date.now());

  const pendingRoundId = computed<string | null>(() => {
    if (!activityStatus.value.pending_call) return null;
    let bestK = -1; let id: string | null = null;
    for (const e of entries.value) {
      const p = parseRoundId(e.round_id);
      if (p.kind === 'round' && p.index > bestK) { bestK = p.index; id = e.round_id; }
    }
    return id;
  });

  const timeline = computed<TimelineItem[]>(() => entriesToTimeline(entries.value, pendingRoundId.value));
  const defaultModelSpec = computed<string | null>(() => {
    for (const item of timeline.value) if (item.kind === 'round' && item.round.modelSpec) return item.round.modelSpec;
    return null;
  });

  function toggleDetails(id: string): void {
    const s = new Set(expanded.value);
    if (s.has(id)) s.delete(id); else s.add(id);
    expanded.value = s;
  }
  function expandAll(): void {
    const s = new Set<string>();
    for (const item of timeline.value) {
      if (item.kind === 'round') for (const p of item.round.toolPairs) s.add(p.toolUseId);
      else if (item.kind === 'compacted') s.add(item.id);
    }
    expanded.value = s;
  }
  function collapseAll(): void { expanded.value = new Set(); }

  // Scroll stickiness: record before length change; re-anchor after nextTick.
  let stickToBottom = false;
  watch(() => entries.value.length, () => {
    const el = threadBody.value;
    if (!el) return;
    stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_BOTTOM_TOLERANCE_PX;
    nextTick(() => { if (stickToBottom && threadBody.value) threadBody.value.scrollTop = threadBody.value.scrollHeight; });
  }, { flush: 'pre' });

  // Reset on agent switch.
  watch(sessionIdGetter, () => {
    expanded.value = new Set();
    nextTick(() => { if (threadBody.value) threadBody.value.scrollTop = 0; });
  });

  const clock = window.setInterval(() => { now.value = Date.now(); }, 1000);
  onBeforeUnmount(() => clearInterval(clock));

  return { timeline, defaultModelSpec, pendingRoundId, expanded, toggleDetails, expandAll, collapseAll, threadBody, now };
}
```

### 2.8 Component templates (skeletons)

All five live under `web/src/components/conversation/` per F02 r2
§1. The skeletons fix prop shape, ARIA, and tone wiring; they do
not duplicate the v2 CSS — F01 tokens drive colour.

**`RoundCard.vue`** — assistant round body (reasoning + tool pairs +
in-round diagnostics):

```vue
<script setup lang="ts">
import { computed } from 'vue';
import type { Round } from '../../utils/agent-timeline/types';
import FormattedContent from '../content/FormattedContent.vue';
import ToolChip from './ToolChip.vue';
import DiagnosticRow from './DiagnosticRow.vue';
import { presentToolCall, presentToolResult } from '../../utils/tool-presenters';

const props = defineProps<{ round: Round; defaultModelSpec: string | null; expanded: ReadonlySet<string> }>();
defineEmits<{ (e: 'toggle-details', id: string): void }>();

const showVia = computed(() => props.round.modelSpec && props.round.modelSpec !== props.defaultModelSpec);

function callPresentation(call?: import('../../utils/agent-timeline/types').ConversationEntry, fallbackName?: string) {
  if (!call) return { icon: '?', name: fallbackName ?? 'unknown', headline: [], detail: [], status: 'call' as const };
  return presentToolCall(call.content, call.tool ?? fallbackName);
}
function resultPresentation(result?: import('../../utils/agent-timeline/types').ConversationEntry, fallbackName?: string) {
  if (!result) return null;
  return presentToolResult(result.content, { tool: result.tool ?? fallbackName, kind: result.kind });
}
</script>

<template>
  <section class="round-card" :data-round-id="round.id">
    <header class="round-card-header">
      <span class="round-id">{{ round.id }}</span>
      <em v-if="showVia" class="round-via" :title="round.requestedModelSpec ?? ''">via {{ round.modelSpec }}</em>
    </header>

    <FormattedContent
      v-for="r in round.reasoning"
      :key="`${round.id}-r-${r.message_index}-${r.block_index}`"
      :content="r.content"
    />

    <ToolChip
      v-for="pair in round.toolPairs"
      :key="`${round.id}-tp-${pair.toolUseId}`"
      :call="callPresentation(pair.call, pair.toolName)"
      :result="resultPresentation(pair.result, pair.toolName)"
      :status="pair.status"
      :expanded="expanded.has(pair.toolUseId)"
      :details-id="`tool-detail-${pair.toolUseId}`"
      :timestamp="pair.call?.timestamp ?? pair.result?.timestamp"
      @toggle="$emit('toggle-details', pair.toolUseId)"
    />

    <DiagnosticRow
      v-for="d in round.diagnostics"
      :key="`${round.id}-d-${d.message_index}-${d.block_index}`"
      :entry="d"
    />
  </section>
</template>
```

**`ToolChip.vue`** — shared chip (consumed by RoundCard AND
AnalystChatPanel, per analysis §8.2):

```vue
<script setup lang="ts">
import { computed } from 'vue';
import type { ToolPairStatus } from '../../utils/agent-timeline/types';
import type { ToolCallPresentation, ToolResultPresentation } from '../../utils/tool-presenters';
import FormattedContent from '../content/FormattedContent.vue';
import Card from '../ui/Card.vue';

const props = defineProps<{
  call: ToolCallPresentation;
  result: ToolResultPresentation | null;
  status: ToolPairStatus;
  expanded: boolean;
  detailsId: string;
  timestamp?: string;
}>();
defineEmits<{ (e: 'toggle'): void }>();

const tone = computed(() => {
  switch (props.status) {
    case 'ok':       return 'accent';
    case 'error':    return 'danger';
    case 'pending':  return 'warn';
    case 'orphan':   return 'warn';
    case 'missing':  return 'warn';
  }
});
</script>

<template>
  <Card :tone="tone" role="group" data-testid="tool-chip" :data-status="status">
    <button
      class="tool-chip-toggle"
      type="button"
      :aria-expanded="expanded"
      :aria-controls="detailsId"
      @click="$emit('toggle')"
    >
      <span class="tool-icon" aria-hidden="true">{{ call.icon }}</span>
      <span class="tool-name">{{ call.name }}</span>
      <span class="tool-headline">
        <template v-for="(part, i) in call.headline" :key="`hl-${i}`"><!-- F05 InlinePart render -->
          <span v-if="part.kind === 'text'" :data-tone="part.tone">{{ part.text }}</span>
          <router-link v-else-if="part.kind === 'file'"  :to="part.to">{{ part.text }}</router-link>
          <a v-else-if="part.kind === 'url'" :href="part.href" target="_blank" rel="noopener">{{ part.text }}</a>
          <code v-else>{{ part.text }}</code>
        </template>
      </span>
      <span v-if="status === 'missing'" class="tool-suffix muted">(no result yet)</span>
    </button>

    <div v-if="expanded" :id="detailsId" class="tool-chip-detail">
      <FormattedContent v-if="call.detail.length > 0" :parts="call.detail" />
      <FormattedContent v-if="result" :parts="result.detail" />
    </div>
  </Card>
</template>
```

**`DiagnosticRow.vue`**:

```vue
<script setup lang="ts">
import { computed } from 'vue';
import type { ConversationEntry } from '../../utils/agent-timeline/types';
import FormattedContent from '../content/FormattedContent.vue';

const props = defineProps<{ entry: ConversationEntry; standalone?: boolean }>();

const tone = computed<'ok' | 'warn' | 'danger'>(() => {
  if (props.entry.kind === 'model_recovered') return 'ok';
  if (props.entry.kind === 'model_repair')    return 'warn';
  return 'danger';
});
const label = computed(() => ({
  model_issue: 'Model Issue', model_repair: 'Model Repair', model_recovered: 'Model Recovered',
} as const)[props.entry.kind as 'model_issue' | 'model_repair' | 'model_recovered']);
</script>

<template>
  <div class="diagnostic-row" :data-tone="tone" :data-standalone="standalone ? 'true' : 'false'"
       :title="new Date(entry.timestamp).toLocaleString()">
    <span class="diagnostic-label">{{ label }}</span>
    <FormattedContent :content="entry.content" />
  </div>
</template>
```

**`PendingCallFooter.vue`**:

```vue
<script setup lang="ts">
import { computed } from 'vue';
import type { PendingCall } from '../../utils/agent-timeline/types';

const props = defineProps<{ pending: PendingCall; now: number }>();

function durationSince(ts: string): string {
  const secs = Math.max(0, Math.floor((props.now - new Date(ts).getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60); return m < 60 ? `${m}m ${secs % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
function durationUntil(ts: string): string {
  const secs = Math.ceil(Math.max(0, new Date(ts).getTime() - props.now) / 1000);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60); return `${m}m ${secs % 60}s`;
}
const inFlightTail = computed(() => props.pending.attempt > 1 ? ` (attempt ${props.pending.attempt})` : '');
</script>

<template>
  <footer class="pending-call-footer" :data-state="pending.status" role="status" aria-live="polite">
    <span class="dot" aria-hidden="true" />
    <template v-if="pending.status === 'in_flight'">
      <span>Waiting for model... {{ durationSince(pending.started_at) }}{{ inFlightTail }}</span>
    </template>
    <template v-else>
      <span>
        <template v-if="pending.reason === 'throttled'">Throttled by provider</template>
        <template v-else>Transient model error</template>
        <template v-if="pending.retry_at"> - retrying in {{ durationUntil(pending.retry_at) }}</template>
      </span>
      <span class="detail">attempt {{ pending.attempt }}</span>
    </template>
  </footer>
</template>
```

**`CompactedCluster.vue`**:

```vue
<script setup lang="ts">
import type { ConversationEntry } from '../../utils/agent-timeline/types';
import DiagnosticRow from './DiagnosticRow.vue';

defineProps<{ id: string; entries: ConversationEntry[]; expanded: boolean }>();
defineEmits<{ (e: 'toggle'): void }>();
</script>

<template>
  <section class="compacted-cluster" :data-id="id">
    <button
      class="compacted-summary"
      type="button"
      :aria-expanded="expanded"
      :aria-controls="`compacted-body-${id}`"
      @click="$emit('toggle')"
    >
      <span class="chevron" aria-hidden="true">&rsaquo;</span>
      <span>- compacted, {{ entries.length }} diagnostic{{ entries.length === 1 ? '' : 's' }} re-keyed -</span>
    </button>
    <div v-if="expanded" :id="`compacted-body-${id}`" class="compacted-body">
      <DiagnosticRow v-for="(c, i) in entries" :key="`${id}-${i}`" :entry="c" />
    </div>
  </section>
</template>
```

**`ContextBlock.vue`** — left-bordered user/system text block:

```vue
<script setup lang="ts">
import type { Round } from '../../utils/agent-timeline/types';
import FormattedContent from '../content/FormattedContent.vue';
defineProps<{ round: Round }>();
</script>

<template>
  <section class="context-block" :data-round-id="round.id">
    <div
      v-for="c in round.context"
      :key="`${round.id}-ctx-${c.message_index}-${c.block_index}`"
      class="context-entry"
      :title="new Date(c.timestamp).toLocaleString()"
    >
      <FormattedContent :content="c.content" />
    </div>
  </section>
</template>
```

### 2.9 Store skeleton

```ts
// web/src/stores/agents.ts (the post-F03 shape; pre-F03 MessageStep / groupIntoSteps are deleted in the same commit)

import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { AgentSession, AgentConversationResponse, FreshnessState } from '../api/types';
import type { ConversationEntry, ActivityStatus } from '../utils/agent-timeline/types';
import { listAgentSessions, getAgentConversation } from '../api/client';
import { useWsStore } from './ws';

export const useAgentsStore = defineStore('agents', () => {
  const sessions = ref<AgentSession[]>([]);
  const currentSession = ref<AgentSession | null>(null);
  const entries = ref<ConversationEntry[]>([]);
  const activityStatus = ref<ActivityStatus>({ pending_call: null, last_activity_at: new Date(0).toISOString() });
  const conversationWarning = ref<string | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  function appendEntry(entry: ConversationEntry): void {
    if (!currentSession.value || entry.session_id !== currentSession.value.id) return;
    if (entries.value.some((e) => e.id === entry.id)) return;
    entries.value = [...entries.value, entry];
    if (entry.kind === 'tool_error' || entry.kind === 'model_issue') {
      conversationWarning.value = 'Conversation includes tool/model failures or repairs; inspect linked evidence carefully.';
    }
  }
  function setActivityStatus(next: ActivityStatus): void { activityStatus.value = next; }

  async function refreshConversation(): Promise<void> {
    if (!currentSession.value) return;
    const r: AgentConversationResponse = await getAgentConversation(currentSession.value.id);
    currentSession.value = r.session;
    entries.value = r.entries;                          // full replace; server is source of truth (incl. compaction)
    activityStatus.value = r.activity_status;
  }

  function bindWs() {
    const ws = useWsStore();
    ws.onType('thinking', (env) => { const c = env.content ?? {}; if (c.entry) appendEntry(c.entry); if (c.activity_status) setActivityStatus(c.activity_status); });
    ws.onType('activity', (env) => { const c = env.content ?? {}; if (c.entry) appendEntry(c.entry); if (c.activity_status) setActivityStatus(c.activity_status); });
  }

  return { sessions, currentSession, entries, activityStatus, conversationWarning, loading, error, appendEntry, setActivityStatus, refreshConversation, bindWs };
});
```

### 2.10 Deletions landed in the same change set

- `web/src/stores/agents.ts` L30-L76: `MessageStep` interface and
  `groupIntoSteps()` — deleted.
- `web/src/stores/agents.ts` `messages`, `steps` (computed),
  `expandedToolCalls` — deleted; replaced by `entries`,
  `useAgentTimeline().timeline`, `useAgentTimeline().expanded`.
- `web/src/components/agents/AgentConversationView.vue` legacy
  flat-step template — deleted; rewritten per §2.8.
- `web/src/api/types.ts` `AgentConversationResponse.messages` and
  `AgentMessage` — deleted/renamed to `ConversationEntry`.
- `web/src/__tests__/agents-store.test.ts` flat-step cases —
  deleted (per analysis §10.8); replaced by `agents-conversation.test.ts`.
- `src/server/websocket.ts` legacy `content.message` key — removed
  in favour of `content.entry`.
- `src/agents/session-persistence.ts` legacy `appendMessage` arity
  — removed; the new arity is the only one.

### 2.11 Test cases (named, exhaustive — mirrors analysis §10)

The complete named-case list lives in
[01-analysis-r2.md §10](01-analysis-r2.md#10-test-plan) and is
adopted verbatim by this design. The five test files added are:

- `web/src/__tests__/utils/agent-timeline/round-id.test.ts`
- `web/src/__tests__/utils/agent-timeline/timeline.test.ts`
- `web/src/__tests__/composables/useAgentTimeline.test.ts`
- `web/src/__tests__/stores/agents-conversation.test.ts`
- `web/src/__tests__/conversation/ToolChip.test.ts`
- `web/src/__tests__/conversation/PendingCallFooter.test.ts`

Backend test files added:

- `src/__tests__/agents/round-id.test.ts`
- `src/__tests__/agents/agent-adapter.tool-call-id.test.ts`
- `src/__tests__/agents/session-persistence.round-stamp.test.ts`
- `src/__tests__/runtime/active-runtime-activity.test.ts`
- `src/__tests__/server/routes/conversation.test.ts`

Each file's case list is exactly as enumerated in analysis §10.1
through §10.7 — no additions, no omissions.

---

## 3. Proposal B — Minimal backend, view-side round derivation

The backend stays at today's append shape **except** for the
shared `tool_call_id` scalar fix (§1.2) and the shared
activity-status pipeline (§1.1). It does **not** stamp `round_id`,
does **not** maintain a `SessionRoundState`, and does **not**
introduce `ActiveRuntime.openAssistantRound()`/`stampInRound()`.

The web layer infers rounds from the entry stream using
`message_index` deltas, role/kind transitions, and a compaction
marker.

### 3.1 Backend deltas (relative to today)

- `AgentMessage` gains exactly two fields:

  ```ts
  message_index: number;     // monotone per session (cheap, single counter)
  compacted_cluster_index?: number;  // present ONLY on entries inside a compacted cluster
  ```

- `model_spec` is added on assistant entries (same as Proposal A).
- `tool_call_id` scalar fix (same as Proposal A).
- `appendMessage` widens by exactly these fields; round_id is
  **not** stamped server-side.
- Compaction emits a single synthetic summary entry with
  `compacted_cluster_index: N` and rewrites the replaced records'
  `compacted_cluster_index` to the same `N`. The synthetic summary
  carries `kind: 'activity'` with content describing the cluster.

### 3.2 Wire & store

Same shape as §1.3 (`{ session, entries, activity_status }`). The
entry objects have no `round_id`, `block_index`, or
`requested_model_spec`. Store stays as in §2.9 except that the
store's `entries.value` is fed straight into `useAgentTimeline`
without a `round_id` precondition.

### 3.3 Pure utility — round inference

`web/src/utils/agent-timeline/round-id.ts` keeps the same parser
**for** the synthesised ids; the producer is now client-side:

```ts
// web/src/utils/agent-timeline/infer-rounds.ts
import type { ConversationEntry } from './types';

export interface InferredRound { round_id: string; block_index: number; }

/**
 * Pure, deterministic. Given the flat entry stream (already monotone in
 * message_index), assign each entry a synthetic round_id + block_index.
 *
 * Algorithm:
 *   1. compacted_cluster_index N present → r-compacted-N, block_index = 0.
 *   2. Before the first user/assistant text/activity entry → r-pre.
 *   3. role=user (kind=text) → opens r-msg:M with M = nextUserMsgIndex++.
 *      The user entry itself is the only entry of that round, unless the next
 *      entry is also role=user|system text (then it stays in r-msg:M).
 *   4. role=assistant entry (text|activity|tool_call) → opens rK with
 *      K = nextRoundIndex++ on the FIRST assistant entry after the last
 *      r-msg:M / r-pre. Subsequent assistant + role=tool entries continue rK
 *      until the next role=user entry.
 *   5. role=system inside an open rK → attached to rK.
 *   6. Diagnostics (model_*) attach to the currently open rK / r-msg:M / r-pre,
 *      preferring rK if open.
 *   7. block_index resets to 0 on every round open and increments per entry
 *      in that round.
 */
export function inferRounds(entries: ConversationEntry[]): Map<string, InferredRound> {
  const out = new Map<string, InferredRound>();
  let kNext = 0, mNext = 0;
  let currentRoundId: string | null = null;
  let blockIdx = 0;
  let anyTurnSeen = false;

  function open(id: string): void { currentRoundId = id; blockIdx = 0; }

  for (const e of entries) {
    if (typeof e.compacted_cluster_index === 'number') {
      out.set(e.id, { round_id: `r-compacted-${e.compacted_cluster_index}`, block_index: 0 });
      continue;
    }
    if (!anyTurnSeen && (e.role === 'system' || (e.role === 'user' && e.kind !== 'text'))) {
      out.set(e.id, { round_id: 'r-pre', block_index: 0 });
      continue;
    }
    if (e.role === 'user' && e.kind === 'text') {
      open(`r-msg:${mNext++}`); anyTurnSeen = true;
      out.set(e.id, { round_id: currentRoundId!, block_index: blockIdx++ }); continue;
    }
    if (e.role === 'assistant') {
      if (currentRoundId === null || currentRoundId.startsWith('r-msg:') || currentRoundId === 'r-pre') {
        open(`r${kNext++}`); anyTurnSeen = true;
      }
      out.set(e.id, { round_id: currentRoundId!, block_index: blockIdx++ }); continue;
    }
    if (e.role === 'tool') {
      const target = currentRoundId ?? `r${kNext++}`;
      if (currentRoundId === null) open(target);
      out.set(e.id, { round_id: target, block_index: blockIdx++ }); continue;
    }
    // diagnostics / leftover system in an open round
    const target = currentRoundId ?? 'r-pre';
    if (currentRoundId === null) open(target);
    out.set(e.id, { round_id: target, block_index: blockIdx++ });
  }
  return out;
}
```

`entriesToTimeline()` is wrapped:

```ts
export function entriesToTimeline(entries: ConversationEntry[], pendingRoundId: string | null): TimelineItem[] {
  const inferred = inferRounds(entries);
  const stamped = entries.map((e) => ({ ...e, round_id: inferred.get(e.id)!.round_id, block_index: inferred.get(e.id)!.block_index }));
  return /* same body as Proposal A, reading round_id/block_index off the stamped entry */;
}
```

### 3.4 Component skeletons

Identical to Proposal A §2.8. The components consume the same
`Round`, `TimelineItem`, and `ToolPair` types; they do not see the
inference. The composable in §2.7 is unchanged.

### 3.5 Store skeleton

Identical to Proposal A §2.9. The store carries `entries`; the
composable's `entriesToTimeline()` does the inference.

### 3.6 Test cases for Proposal B

In addition to the analysis-§10 cases (still applicable, just
re-keyed off `inferRounds`'s synthetic ids), B adds:

- `inferRounds > consecutive user text entries share one r-msg:N round`
- `inferRounds > assistant text after r-msg:0 opens r0`
- `inferRounds > role=tool entry after assistant joins the same rK`
- `inferRounds > system entries before any user/assistant land in r-pre`
- `inferRounds > diagnostic between r-msg:N and the first assistant text attaches to r-msg:N` (i.e. open round is the user-anchored bucket)
- `inferRounds > compacted_cluster_index N maps to r-compacted-N regardless of role/kind`
- `inferRounds > determinism: running inferRounds twice on the same input produces the same output`
- `inferRounds > stability under append: inferRounds(entries) ⊆ inferRounds([...entries, newEntry]) for ids in the prefix`

### 3.7 Why Proposal B was not picked (developed seriously, then rejected)

Reasons:

1. **Loss of producer-side authority.** With backend stamping the
   server is the canonical source of `round_id`; with client
   inference, two clients on the same session can disagree if the
   inference rules ever drift (e.g. across a deploy where the web
   bundle is stale). The architecture-first guideline says the
   authoritative ordering of a multi-process system belongs at the
   producer, not at the consumer.
2. **Loss of fail-loud schema check.** Proposal A's
   `agentMessageSchema` strict regex on `round_id` rejects malformed
   producer output at write time. Proposal B has no producer; it
   re-synthesises strings deterministically, so the parser-side
   `unknown` drop never fires. That removes the canary v2 relied on
   to detect bucketing drift.
3. **Compaction is awkward.** Proposal B requires a new field
   `compacted_cluster_index` on every entry that gets rewritten by
   compaction; Proposal A keeps `round_id` as the only mutation
   target (already supported by `replaceSessionMessages`).
4. **Round-stamping is needed by analyst chat anyway.** Per F04 r3,
   the analyst surface uses the same `useAgentTimeline` composable.
   The composable must operate on an entry stream whose round
   ordering is consistent with what the v2-on-v3 harness already
   logs. Proposal B forces inference to be re-implemented on the
   server when log readers (CLI, debug tools, analytics) want a
   stable round id — Proposal A already has it on disk.
5. **Marginal save.** Proposal B saves
   `SessionRoundState`/`openAssistantRound`/`stampInRound` on the
   server (≈80 lines) and a `round_id` column on the JSONL record;
   it adds `inferRounds` + tests on the client (≈80 lines + 8
   cases). Net code does not shrink; the cost is paid in a different
   place that is less authoritative.
6. **Re-coupling to UI ordering.** The pure utility now embeds
   the assistant-turn-boundary policy. Today's bound is
   "next role=user opens a new r-msg:N"; if the agent stack ever
   adds a new role (e.g. `critic`, `verifier`) the inference rule
   must change in lockstep on the client — exactly the
   wire-vs-UI coupling §9.1 rejected for option (a).
7. **Stability under streaming.** Inference is stable under append
   for the prefix only if the next entry never reclassifies a
   previous entry's round. A late-arriving `compacted_cluster_index`
   on a previously-seen entry mutates its round_id, which means the
   composable must re-key the DOM. Proposal A avoids this because
   the server emits the rewrite explicitly via `replaceSessionMessages`.

Conclusion: B is internally coherent and would work, but it puts
producer authority on the consumer side and removes the schema
canary. Both violate the architecture-first guideline.

---

## 4. Recommendation

**Adopt Proposal A.** Justification by axis:

- **Clean architecture.** The producer (`ActiveRuntime` +
  `agent-adapter`) stamps `round_id`, the schema validates it, the
  consumer (`entriesToTimeline`) reads it. Each layer's
  responsibility is single and stable: producer = stamping,
  schema = grammar contract, consumer = grouping & rendering.
  Proposal B fuses producer + consumer on the client.
- **Testability of the pure utility.**
  `web/src/utils/agent-timeline/` has zero Vue imports and zero
  data sources; it takes plain arrays and returns plain arrays. The
  case list in analysis §10.2 is testable as fast TS units. Same
  for the round-id parser. Proposal B's `inferRounds` is also pure,
  but it adds a second pure module to test and a coupling between
  the two: a change to assistant-turn boundaries breaks inference
  tests, timeline tests, AND component tests. Proposal A keeps
  those domains decoupled.
- **Wire-contract neutrality.** The wire shape
  `{ session, entries, activity_status }` carries entries with a
  small, presentation-neutral metadata vocabulary (`round_id`,
  `message_index`, `block_index`, `model_spec`, `tool_call_id`).
  Future consumers (CLI replay, debug tools, analytics) can read
  rounds without re-implementing inference. This is what
  analysis §9.2 means by "presentation-neutral".
- **F02 layering.** All five new SFCs land in `conversation/`;
  none import a store or router (per F02 r2 §1 discriminator). The
  pure utility lives in `utils/agent-timeline/`. The composable
  lives in `composables/`. AnalystChatPanel consumes the same
  `ToolChip` (§8.2). Same outcome for B, but A's pure utility has
  one entry point (`entriesToTimeline`) rather than two
  (`entriesToTimeline` + `inferRounds`).
- **F04 alignment.** F04 r3 expects `useAgentTimeline` to be the
  one composable used by both agent and analyst surfaces. Both
  proposals satisfy this. F04 also expects on-disk round-id
  stability across deploys (operator traces, exchange replay). Only
  A guarantees that.
- **No backward compat.** Both proposals execute the same set of
  deletions (§2.10). The branch landing condition is identical.

Trade-off A accepts: more backend code in this PR
(`SessionRoundState`, `openAssistantRound`, `stampInRound`,
`stampUserMessage`, `stampPre`, `stampCompacted`,
`stampDiagnosticInCurrentRound`, `closeRound`,
`rebuildSessionRoundState`) and a strict-regex schema. This cost is
one-time and lives behind a single class boundary; future surfaces
benefit from it without paying the cost again.

**Chosen proposal: A.**

---

## 5. Out of scope (inherited from analysis §11)

- No port of v2's 692-line `toolFormatters.ts` (F05 r2 supersedes).
- No new `InlinePart` kinds beyond F05 r2's four.
- No new WS event type (piggybacked on `thinking`/`activity`).
- No streaming/delta protocol; entries arrive whole.
- No JSONL migration tool — test projects are reset (project rule).
- No analyst-chat composer changes (F04 owns); F03 only swaps the
  in-line `tool-chip*` markup in `AnalystChatPanel.vue` to the
  shared `ToolChip` (analysis §8.2).
- No virtualization / windowing for very long conversations.
- No router changes beyond `navigateToLink` consumed by
  `FormattedContent`.
