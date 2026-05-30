# F03 — Conversation rounds / diagnostics / pairing — Design (r2)

Writer round 2. Addresses every item in the binding critique
[02-design-review-r1.md](02-design-review-r1.md). Builds on the
approved analyses: [F03 r2](01-analysis-r2.md),
[F01 r2](../F01-design-tokens/01-analysis-r2.md),
[F02 r2](../F02-component-hierarchy/01-analysis-r2.md),
[F04 r3](../F04-chat-surface-style/01-analysis-r3.md),
[F05 r2](../F05-tool-detail-rendering/01-analysis-r2.md). Issue:
[F03-conversation-rounds.md](../F03-conversation-rounds.md).
Backend spot-checks: [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts#L376),
[src/agents/session-persistence.ts](../../../src/agents/session-persistence.ts#L209),
[src/schemas/types.ts](../../../src/schemas/types.ts#L77),
[src/schemas/validators.ts](../../../src/schemas/validators.ts#L44),
[src/server/routes/runtime-config-notes.ts](../../../src/server/routes/runtime-config-notes.ts#L115),
[web/src/stores/agents.ts](../../../web/src/stores/agents.ts#L30),
[web/src/api/types.ts](../../../web/src/api/types.ts#L752).

**Mandatory project rule (binding):**
**architecture-first, NO backward compatibility.** The same commit
set that lands new types/components also **removes** the flat
`MessageStep` / `groupIntoSteps()` machinery, the `messages` field
on `AgentConversationResponse`, the legacy `appendMessage(...)` arity
without round-stamp fields, the legacy WS `content.message` key,
and the `.tool-call`/`.tool-result` selectors. Nothing is kept "for
later"; nothing is aliased; the analyst-chat in-line `tool-chip*`
markup in
[web/src/components/chat/AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue)
is replaced with the new shared `<ToolChip>` in the **same** PR
(§8.2).

---

## 0. Required-changes coverage map

| # | Reviewer-required item ([02-design-review-r1.md](02-design-review-r1.md)) | Addressed in |
| - | ------------------------------------------------------------------------- | ------------ |
| R1 | Reconcile shared `<ToolChip>` template/prop contract with F05 r2 and F04 r3: (a) use F05 `InlinePart` fields (`value` / `path,root` / `url` / `value`), not v2's `text`/`to`/`href`; (b) non-button `<div role="group">` with one dedicated expand `<button>` and sibling links/anchors (no nested interactive elements); (c) pick one of "extend props with raw `callContent`/`resultContent` and render `<FormattedContent :content=...>`" vs "no raw body, only `InlineParts`" and make F03/F04/F05 agree. | [§7.2](#72-toolchipvue--prop-bag-and-template-fixed) — extends the prop bag with `callContent` / `resultContent`, uses `<InlineParts>` for headline/detail, uses `<FormattedContent :content=...>` for the expanded body, non-nested DOM. [§3.3](#33-toolpairstatus-and-timeline-types) — `ToolPairStatus`. [§8.2](#82-analystchatpanel-swap-binding) — AnalystChatPanel swap is in the F03 PR. |
| R2 | Schema-level enforcement of "decimal digits only, ≤ `Number.MAX_SAFE_INTEGER`" grammar, not only the parser. | [§4.1](#41-backend-types--schema) — `agentMessageSchema` `superRefine` rejects unknown `round_id` shapes; the regex itself is the canary, parser-side `unknown` is the defence in depth. |
| R3 | Clarify leading-zero wording in tests so `r007` and `r7` are **not** bucketed together; they only share a sort key. | [§3.2](#32-round-idts) (note after `parseRoundId`) and [§11.1](#111-test-files-and-named-cases) (`round-id.test.ts` cases). |
| R4 | Add chip contract tests: (a) no nested interactive controls; (b) F05 `InlinePart` fields render correctly; (c) expanded body follows the chosen raw-content contract. | [§11.1](#111-test-files-and-named-cases) — `ToolChip.test.ts` named cases. |
| — (axis review, accepted) | Producer authority for round stamps; schema canary; v2 timeline algorithm ported as a pure utility; delete legacy paths; AnalystChatPanel chip swap in F03 batch; backend round counters; activity-status pipeline; canonical wire shape; piggyback WS envelopes on `thinking`/`activity`. | §2, §3, §4, §5, §6, §8, §9, §10. |

The verdict (`CHANGES_REQUESTED`) was driven entirely by R1; R2–R4
are smaller follow-ups. r2 does not re-derive proposals or
algorithms the reviewer already approved.

---

## 1. Changes since r1

1. **ToolChip contract reconciled** ([§7.2](#72-toolchipvue--prop-bag-and-template-fixed))
   with F05 r2's `InlinePart` shape and F04 r3's `v-bind=adapter(...)`
   call sites. The prop bag is now eight props:
   `{ call, result, callContent, resultContent, status, expanded, detailsId, timestamp? }`.
   `call: ToolCallPresentation` and `result: ToolResultPresentation | null`
   are imported verbatim from F05 r2 §2 (they already use
   `InlinePart[]` for `headline` / `detail`). `callContent: string`
   and `resultContent: string | null` carry the **raw** producer
   payloads so the expanded body can render through
   `<FormattedContent :content=...>` (F05 r2 §7.3 — JSON vs prose
   auto-detect). Headlines and inline details render through
   `<InlineParts>` (F05 r2 §6).
2. **Non-nested interactive DOM.** The chip is a `<div role="group">`
   with a **single** `<button>` (the expand toggle) and sibling
   `<router-link>` / `<a>` elements rendered by `<InlineParts>` —
   matches F05 r2 §6 verbatim. No `<button>` wraps the whole row.
3. **RoundCard adapter** ([§7.3](#73-roundcardvue))
   now passes `callContent` / `resultContent` alongside the
   presentations so the chip can mount `<FormattedContent>` on
   expand without re-parsing JSON.
4. **Schema digit grammar** ([§4.1](#41-backend-types--schema))
   moved into a `superRefine` that parses the candidate index
   through the same algorithm as `parseRoundId`, rejecting values
   `> Number.MAX_SAFE_INTEGER` at write time.
5. **`round-id.test.ts` leading-zero wording**
   ([§11.1](#111-test-files-and-named-cases))
   now reads "share a sort key" rather than "bucketed together".
   Bucketing is by **raw** string; leading zeros stay distinct.
6. **`ToolChip.test.ts` chip-contract cases added**
   ([§11.1](#111-test-files-and-named-cases)) — three new named
   cases for DOM/contract assertions.
7. **Section numbering** aligned with F04 r3's cross-references:
   `ToolPairStatus` is §3.3, the shared `<ToolChip>` lives in §7
   with the prop bag in §7.2, the AnalystChatPanel swap is §8.2.
   Reviewer-approved content from r1 is otherwise preserved.

---

## 2. Shared backend & wire surface (used by both proposals)

The activity-status pipeline (analysis §6) and the `tool_call_id`
scalar fix (analysis §5.5) are required by **both** proposals
described in §4 and §5; they are not the axis of disagreement.

### 2.1 `ActiveRuntime` activity-status additions

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
    eventBus.on('session_started',       (e) => this.touchSession(e.session_id, null));
    eventBus.on('model_selected',        (e) => this.onModelSelected(e));
    eventBus.on('invocation_succeeded',  (e) => this.onInvocationDone(e));
    eventBus.on('invocation_failed',     (e) => this.onInvocationFailed(e));
    eventBus.on('retry_attempted',       (e) => this.onRetryAttempted(e));
    eventBus.on('session_cancelled',     (e) => this.clearPending(e.session_id));
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

### 2.2 `tool_call_id` scalar fix

[agent-adapter.ts L376](../../../src/agents/agent-adapter.ts#L376)
(assistant `tool_call` persistence) is changed to stamp the scalar
(analysis §5.5). The schema validator adds a `superRefine` that
rejects any `tool_call`/`tool_result`/`tool_error` record without
`tool_call_id`.

```ts
// agent-adapter.ts (replaces existing L376 body)
for (const tc of toolCalls) {
  appendMessage(this.saivageDir, sessionId, {
    role: 'assistant',
    kind: 'tool_call',
    content: JSON.stringify({ toolCalls: [tc] }),
    tool: tc.function.name,
    tool_call_id: tc.id,                  // NEW — scalar, required at producer
    ...activeRuntime.stampInRound(sessionId),
  });
}
```

### 2.3 Wire shape

```ts
// web/src/api/types.ts (replaces existing AgentConversationResponse + AgentMessage)
export interface AgentConversationResponse {
  session: AgentSession;
  entries: ConversationEntry[];
  activity_status: ActivityStatus;
}
```

`messages` is **removed**; `AgentMessage` is **renamed** to
`ConversationEntry` in place — no alias, no parallel export.

### 2.4 WS envelope widening

Both `thinking` and `activity` envelopes carry
`{ sessionId, entry, activity_status }`. No new event type. The
legacy `message` key is removed from the envelope. Justification:
analysis §6.4.

---

## 3. Pure timeline utility — `web/src/utils/agent-timeline/`

Per F02 r2 §1, non-Vue logic lives under `web/src/utils/`. F03's
pure module has no Vue imports and is testable as fast TS units.

### 3.1 `types.ts`

```ts
export type ConversationEntryRole = 'user' | 'assistant' | 'system' | 'tool';
export type ConversationEntryKind =
  | 'text' | 'activity'
  | 'tool_call' | 'tool_result' | 'tool_error'
  | 'model_issue' | 'model_repair' | 'model_recovered';

export interface ConversationEntry {
  id: string;
  session_id: string;
  role: ConversationEntryRole;
  kind: ConversationEntryKind;
  content: string;
  timestamp: string;             // ISO 8601
  round_id: string;              // server-stamped; required
  message_index: number;         // server-stamped; required
  block_index: number;           // server-stamped; required
  tool?: string;
  tool_call_id?: string;         // required on tool_call / tool_result / tool_error (§4.1 superRefine)
  model_spec?: string;
  requested_model_spec?: string;
  links?: EntityLink[];
}

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
```

### 3.2 `round-id.ts`

Byte-equivalent port of [v2 round-id.ts](../../../../saivage/web/src/components/agents/round-id.ts):

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

Note on leading zeros (review item R3): bucketing in §3.4 is by
**raw `round_id` string**, so `r007` and `r7` are **distinct
buckets**. `roundIdSortKey` returns the same numeric tier/index for
both, so two adjacent buckets `r007` and `r7` would sort with the
same key — the secondary sort falls back to earliest timestamp.
This is acceptable because a well-behaved producer never emits both
forms for the same session; both are accepted in case a manual
JSONL edit happens.

### 3.3 `ToolPairStatus` and timeline types

```ts
export type ToolPairStatus =
  | 'pending'    // call present, no result yet, AND this round is the active round (pendingRoundId)
  | 'ok'         // call + tool_result
  | 'error'      // call + tool_error
  | 'orphan'     // tool_result/tool_error with no matching call
  | 'missing';   // call present, no result yet, AND this round is not active
```

`ToolPairStatus` is the single source of truth for the chip's
lifecycle classification — F04 r3 §4.0 and §4.2 import it verbatim
and the chip's `<Card>` tone derivation in §7.2 maps from it.

### 3.4 `timeline.ts`

Byte-equivalent port of [v2 timeline.ts](../../../../saivage/web/src/components/agents/timeline.ts):

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
    const list = buckets.get(entry.round_id);          // bucketing is by raw string (see §3.2 note)
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
    if (shape.kind === 'unknown') continue;            // fail-loud bucket drop (schema canary in §4.1)

    const reasoning:   ConversationEntry[] = [];
    const userText:    ConversationEntry[] = [];
    const diagnostics: ConversationEntry[] = [];
    const callMap   = new Map<string, ToolPair>();
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

The barrel `web/src/utils/agent-timeline/index.ts` re-exports the
parser, sort key, `entriesToTimeline`, and the type aliases (F02 r2
allows barrels under `utils/`).

---

## 4. Proposal A — Focused fix (recommended; matches analysis r2)

Backend stamps `round_id` / `message_index` / `block_index` per
analysis §5; web layer ports v2's pure `entriesToTimeline()` and
renders through F02-mandated `conversation/` components.

### 4.1 Backend: types & schema

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
  round_id: string;              // NEW; required
  message_index: number;         // NEW; required; monotone per session
  block_index: number;           // NEW; required; monotone within round
  tool?: string;
  tool_call_id?: string;         // required at producer for tool_* (superRefine below)
  model_spec?: string;           // NEW; assistant entries
  requested_model_spec?: string; // NEW
  links?: EntityLink[];
}
```

`src/schemas/validators.ts` (review item R2 — schema-level digit
grammar):

```ts
const roundIdGrammar = /^(?:r-pre|r-msg:\d+|r\d+|r-compacted-\d+)$/;

export const agentMessageSchema = z.object({
  // ... existing fields
  round_id: z.string().regex(roundIdGrammar, 'round_id must match r-pre | r-msg:N | rK | r-compacted-N'),
  message_index: z.number().int().nonnegative(),
  block_index: z.number().int().nonnegative(),
  tool_call_id: z.string().optional(),
  model_spec: z.string().optional(),
  requested_model_spec: z.string().optional(),
}).superRefine((m, ctx) => {
  // R2: digit-only numeric tail, and tail value <= Number.MAX_SAFE_INTEGER.
  // The regex already rejects non-digit tails; this refinement enforces the bound.
  const tail =
    m.round_id.startsWith('r-msg:')       ? m.round_id.slice(6)  :
    m.round_id.startsWith('r-compacted-') ? m.round_id.slice(12) :
    m.round_id.startsWith('r') && m.round_id !== 'r-pre' ? m.round_id.slice(1) : null;
  if (tail !== null) {
    // Use Number.parseInt only after the regex confirmed digit-only;
    // reject values that would lose precision.
    const n = Number(tail);
    if (!Number.isFinite(n) || n > Number.MAX_SAFE_INTEGER) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['round_id'], message: 'round_id numeric tail exceeds MAX_SAFE_INTEGER' });
    }
  }
  // tool_call_id scalar required on tool_*.
  if ((m.kind === 'tool_call' || m.kind === 'tool_result' || m.kind === 'tool_error') && !m.tool_call_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tool_call_id'], message: `${m.kind} requires tool_call_id scalar` });
  }
});
```

The parser-side `unknown` bucket drop in §3.4 is the **defence in
depth**; the schema is the **canary**. Either layer alone would
catch producer drift; both are present.

### 4.2 `ActiveRuntime` round-stamping counters

```ts
// src/runtime/active-runtime.ts (additions; in the same class as §2.1)

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
  // ... activity map from §2.1
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
parser/formatter; the **only** allowed producer of `round_id`
strings.

### 4.3 `appendMessage` rewrite & callsite table

`src/agents/session-persistence.ts` — `appendMessage` signature
widens (analysis §5.2). Every callsite in
[agent-adapter.ts](../../../src/agents/agent-adapter.ts) pulls a
`RoundStamp` from `ActiveRuntime` before calling. Per-site mapping
is analysis §5.2 verbatim:

| Producer site | Stamp source |
| ------------- | ------------ |
| User message ingest | `activeRuntime.stampUserMessage(sessionId)` |
| Assistant first text/activity in turn | `activeRuntime.openAssistantRound(sessionId)` |
| Assistant subsequent text/activity/tool_call/tool_result/tool_error | `activeRuntime.stampInRound(sessionId)` |
| `model_issue` / `model_repair` / `model_recovered` | `activeRuntime.stampDiagnosticInCurrentRound(sessionId)` |
| Pre-thread system | `activeRuntime.stampPre(sessionId)` |
| Compaction summary | `activeRuntime.stampCompacted(sessionId)` |

Append-side hook for activity-status:

```ts
export function appendMessage(saivageDir: string, sessionId: string, msg: AppendMessageInput): AgentMessage {
  const record = /* assemble; assert round-stamp fields present; agentMessageSchema.parse(record) */;
  writeJsonLine(saivageDir, sessionId, record);
  activeRuntime.recordAppend(sessionId, record.timestamp, record.kind === 'text' && record.role === 'assistant');
  return record;
}
```

The old arity (without round stamps) is **removed** in the same
commit — no overload, no default value (project rule).

### 4.4 Route response

`src/server/routes/runtime-config-notes.ts` conversation handler is
rewritten to the canonical shape (analysis §6.3). `readAgentMessages`
is renamed `readConversationEntries`; it parses each JSONL line
through `agentMessageSchema.parse` and returns
`ConversationEntry[]`. Response body:

```ts
{
  session: AgentSession,
  entries: ConversationEntry[],
  activity_status: activeRuntime.getActivityStatus(session.id),
}
```

### 4.5 WS envelope construction

`src/server/websocket.ts` constructs every `thinking` / `activity`
envelope as `{ sessionId, entry, activity_status }` per §2.4.

---

## 5. Proposal B — Minimal backend, view-side round derivation (rejected, documented)

The reviewer accepted r1's developed Proposal B and its rejection
rationale verbatim. r2 reproduces the rejection summary; the full
algorithm and tests live in r1 §3 and need no changes.

**B keeps the backend at today's append shape** except for the
shared `tool_call_id` scalar fix and activity-status pipeline; it
adds `message_index` and `compacted_cluster_index?` but not
`round_id`. The pure utility gains `inferRounds(entries)` which
walks the stream and synthesises `r-pre` / `r-msg:N` / `rK` /
`r-compacted-N` from role/kind transitions. `entriesToTimeline()`
is wrapped to stamp the inferred ids before bucketing.

**Why not adopted (architecture-first):**

1. **Loss of producer authority.** Two clients on the same session
   can disagree if inference drifts across a deploy. The canonical
   ordering of a multi-process system belongs at the producer.
2. **Loss of schema canary.** The `superRefine` in §4.1 rejects
   malformed `round_id` at write time. Without a producer, the
   parser's `unknown` drop never fires — the bucketing-drift canary
   v2 relies on disappears.
3. **Compaction is awkward.** B requires a new field
   `compacted_cluster_index` on every entry that gets rewritten by
   compaction; A keeps `round_id` as the only mutation target
   (already supported by `replaceSessionMessages`).
4. **Operator/CLI replay.** Log readers (CLI, debug tools,
   analytics) want a stable on-disk round id; A gives them one for
   free, B forces re-derivation.
5. **No code saved.** B removes ≈80 backend lines and adds ≈80
   client lines plus 8 inference test cases; net code does not
   shrink and the cost moves to the less authoritative side.
6. **Re-coupling to UI ordering.** A new agent role (e.g.
   `critic`, `verifier`) would force lockstep inference updates on
   the client.
7. **Streaming instability.** Late-arriving `compacted_cluster_index`
   mutates a previous entry's synthesised round_id and forces DOM
   re-keying; A handles this through explicit producer rewrites via
   `replaceSessionMessages`.

**Chosen proposal: A.**

---

## 6. Composable `useAgentTimeline`

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

---

## 7. Components

All six new SFCs live under `web/src/components/conversation/`. By
F02 r2's discriminator (no store / no router / no WebSocket inside
`conversation/`), the components consume only props + emits +
imported pure utilities. The store-aware surface container stays at
its current path
[web/src/components/agents/AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue).

### 7.1 Folder layout

```
web/src/components/
  ui/             (F02-owned; Card, Spinner, Pill, ...)
  content/        (F05-owned; FormattedContent, MarkdownText, JsonView, CodeBlock, InlineParts)
  conversation/   (F02 API; F03 implementation)
    RoundCard.vue           ← F03 (§7.3)
    ToolChip.vue            ← F03 (§7.2)  — shared by agent + analyst surfaces
    DiagnosticRow.vue       ← F03 (§7.4)
    PendingCallFooter.vue   ← F03 (§7.5)
    CompactedCluster.vue    ← F03 (§7.6)
    ContextBlock.vue        ← F03 (§7.7)
    MessageBubble.vue       (F02-owned; F03 does not modify)
    ThinkingDots.vue        (F02-owned; F03 does not modify)

web/src/composables/  useAgentTimeline.ts  (§6)
web/src/utils/agent-timeline/  types.ts, round-id.ts, timeline.ts, index.ts  (§3)
```

### 7.2 `ToolChip.vue` — prop bag and template (FIXED)

This is the shared chip consumed by both `RoundCard.vue` (§7.3) and
the analyst-surface `MessageList.vue` (F04 r3 §3.3/§3.4). The
contract reconciles three documents (review item R1):

- F05 r2 §2 — `ToolCallPresentation` / `ToolResultPresentation`
  carry `headline: InlinePart[]` and `detail: InlinePart[]`.
- F05 r2 §3 — `InlinePart` discriminated union with fields
  `value` (text/code), `path` + `root` (file), `url` (url).
- F05 r2 §6 — non-button `<div role="group">` with one expand
  `<button>` and sibling `<router-link>` / `<a>` rendered by
  `<InlineParts>`. **No nested interactive elements.**
- F04 r3 §4.0 — F04 binds the prop bag with
  `v-bind="adaptChatMessageToToolChip(call, result, expanded)"`.
- F03 — the chip's expanded body shows the **raw** producer payload
  (`content` JSON or prose), passed through F05's
  `<FormattedContent :content=...>` so JSON-vs-prose auto-detection
  (F05 r2 §7.3) applies.

**Prop bag (eight props, no slots):**

```ts
// web/src/components/conversation/ToolChip.vue
import type { ToolCallPresentation, ToolResultPresentation } from '../../utils/tool-presenters';
import type { ToolPairStatus } from '../../utils/agent-timeline/types';

defineProps<{
  call: ToolCallPresentation;          // F05 r2 §2 — always present (synthesised for orphan results, see F04 r3 §4.1)
  result: ToolResultPresentation | null; // F05 r2 §2 — null when no result yet (or pending)
  callContent: string;                 // RAW producer payload for the expanded body (call entry .content)
  resultContent: string | null;        // RAW producer payload for the expanded body (result entry .content or null)
  status: ToolPairStatus;              // §3.3
  expanded: boolean;
  detailsId: string;                   // `tool-detail-<toolUseId>` (or `tool-detail-pending-<id>` per F04 r3 §4.1)
  timestamp?: string;
}>();
defineEmits<{ (e: 'toggle'): void }>();
```

**Template (non-nested interactive DOM, F05 r2 §6 verbatim):**

```vue
<script setup lang="ts">
import { computed } from 'vue';
import type { ToolCallPresentation, ToolResultPresentation } from '../../utils/tool-presenters';
import type { ToolPairStatus } from '../../utils/agent-timeline/types';
import Card from '../ui/Card.vue';
import InlineParts from '../content/InlineParts.vue';
import FormattedContent from '../content/FormattedContent.vue';

const props = defineProps<{
  call: ToolCallPresentation;
  result: ToolResultPresentation | null;
  callContent: string;
  resultContent: string | null;
  status: ToolPairStatus;
  expanded: boolean;
  detailsId: string;
  timestamp?: string;
}>();
defineEmits<{ (e: 'toggle'): void }>();

const tone = computed<'accent' | 'warn' | 'danger'>(() => {
  switch (props.status) {
    case 'ok':      return 'accent';
    case 'error':   return 'danger';
    case 'pending': return 'warn';
    case 'orphan':  return 'warn';
    case 'missing': return 'warn';
  }
});

const ariaLabel = computed(() => {
  const r = props.result ? `→ ${props.result.status}` : props.status;
  return `${props.call.name} ${r}`;
});
</script>

<template>
  <Card
    :tone="tone"
    role="group"
    :aria-label="ariaLabel"
    data-testid="tool-chip"
    :data-status="status"
  >
    <!-- Header row: ONE button (the toggle) + sibling links inside <InlineParts>. No nesting. -->
    <div class="tool-chip-head">
      <button
        type="button"
        class="tool-chip-toggle"
        :aria-expanded="expanded"
        :aria-controls="detailsId"
        :aria-label="expanded ? 'Collapse details' : 'Expand details'"
        @click="$emit('toggle')"
      >
        <span class="tool-chip-caret" aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
      </button>
      <span class="tool-chip-icon" aria-hidden="true">{{ call.icon }}</span>
      <span class="tool-chip-name">{{ call.name }}</span>
      <!-- F05 InlinePart renderer; emits <router-link>/<a>/<code>/<span> SIBLINGS of the toggle. -->
      <InlineParts class="tool-chip-headline" :parts="call.headline" />
      <InlineParts
        v-if="call.detail.length > 0"
        class="tool-chip-tag"
        :parts="call.detail"
      />
      <!-- Result-side headline if a result is present. -->
      <InlineParts
        v-if="result"
        class="tool-chip-result"
        :parts="result.headline"
      />
      <InlineParts
        v-if="result && result.detail.length > 0"
        class="tool-chip-result-tag"
        :parts="result.detail"
      />
      <span v-if="status === 'missing'" class="tool-chip-suffix tone-muted">(no result yet)</span>
      <span v-if="status === 'orphan'" class="tool-chip-suffix tone-muted">(orphan — no matching call)</span>
    </div>

    <!-- Expanded body: raw producer payloads through F05 FormattedContent (JSON vs prose auto-detect). -->
    <div v-if="expanded" :id="detailsId" class="tool-chip-detail">
      <FormattedContent :content="callContent" />
      <FormattedContent v-if="resultContent !== null" :content="resultContent" />
    </div>
  </Card>
</template>
```

**Why two presenter rows (`call.headline`, `result.headline`) plus
two raw-content blocks?** F05 r2 §2 keeps the call and result
presenters independent (no `FormattedToolPair`). The chip renders
both summaries in the header strip (single-line, structured) and
both raw payloads in the expanded body (whole document, with JSON
highlighting). This matches v2's per-pair chip behaviour and is the
contract F04 r3 §4.1 produces via `adaptChatMessageToToolChip` /
`adaptPendingInvocationToToolChip`.

**Status-to-tone mapping (referenced by F04 r3 §4.2):**

| `status`  | `<Card>` tone | rationale |
| --------- | ------------- | --------- |
| `pending` | `warn`        | in-flight, no result yet |
| `ok`      | `accent`      | successful result |
| `error`   | `danger`      | failed result |
| `orphan`  | `warn`        | result with no call (surfaced as warning, not error) |
| `missing` | `warn`        | call present, no result yet; chip headline gets a muted suffix |

**DOM contract (test-asserted in §11.1):**

- Exactly **one** `<button>` per chip (the toggle).
- File / URL links rendered by `<InlineParts>` are **siblings** of
  the toggle, not descendants.
- The expanded body (`#tool-detail-…`) is a sibling of the
  `tool-chip-head` div, not a child of any `<button>`.
- The `aria-controls` target id (`detailsId`) is the id of the
  expanded body div.

### 7.3 `RoundCard.vue`

```vue
<script setup lang="ts">
import { computed } from 'vue';
import type { ConversationEntry, Round, ToolPair } from '../../utils/agent-timeline/types';
import FormattedContent from '../content/FormattedContent.vue';
import ToolChip from './ToolChip.vue';
import DiagnosticRow from './DiagnosticRow.vue';
import {
  presentToolCall,
  presentToolResult,
  type ToolCallPresentation,
  type ToolResultPresentation,
} from '../../utils/tool-presenters';

const props = defineProps<{
  round: Round;
  defaultModelSpec: string | null;
  expanded: ReadonlySet<string>;
}>();
defineEmits<{ (e: 'toggle-details', id: string): void }>();

const showVia = computed(() => props.round.modelSpec && props.round.modelSpec !== props.defaultModelSpec);

/** Build the eight-prop bag for a paired ToolChip from a ToolPair. */
function toolChipPropsFor(pair: ToolPair) {
  const call = pair.call;
  const result = pair.result;

  const callView: ToolCallPresentation = call
    ? presentToolCall(call.content, call.tool ?? pair.toolName)
    : {
        // synthesised call for an orphan result — see F04 r3 §4.1 synthesizeCallFromResult
        icon: '?',
        name: pair.toolName,
        headline: [],
        detail: [],
        status: 'call',
      };

  const resultView: ToolResultPresentation | null = result
    ? presentToolResult(result.content, {
        tool: result.tool ?? pair.toolName,
        kind: result.kind as 'tool_result' | 'tool_error',
      })
    : null;

  return {
    call: callView,
    result: resultView,
    callContent: call?.content ?? '',
    resultContent: result?.content ?? null,
    status: pair.status,
    expanded: props.expanded.has(pair.toolUseId),
    detailsId: `tool-detail-${pair.toolUseId}`,
    timestamp: call?.timestamp ?? result?.timestamp,
  };
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
      v-bind="toolChipPropsFor(pair)"
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

`presentToolCall` / `presentToolResult` come from F05 r2 §2;
`InlinePart`-based `headline`/`detail` flow through `<InlineParts>`
inside `<ToolChip>` (§7.2).

### 7.4 `DiagnosticRow.vue`

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
  model_issue:     'Model Issue',
  model_repair:    'Model Repair',
  model_recovered: 'Model Recovered',
} as const)[props.entry.kind as 'model_issue' | 'model_repair' | 'model_recovered']);
</script>

<template>
  <div
    class="diagnostic-row"
    :data-tone="tone"
    :data-standalone="standalone ? 'true' : 'false'"
    :title="new Date(entry.timestamp).toLocaleString()"
  >
    <span class="diagnostic-label">{{ label }}</span>
    <FormattedContent :content="entry.content" />
  </div>
</template>
```

### 7.5 `PendingCallFooter.vue`

```vue
<script setup lang="ts">
import { computed } from 'vue';
import type { PendingCall } from '../../utils/agent-timeline/types';

const props = defineProps<{ pending: PendingCall; now: number }>();

function durationSince(ts: string): string {
  const secs = Math.max(0, Math.floor((props.now - new Date(ts).getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  return m < 60 ? `${m}m ${secs % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
function durationUntil(ts: string): string {
  const secs = Math.ceil(Math.max(0, new Date(ts).getTime() - props.now) / 1000);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  return `${m}m ${secs % 60}s`;
}
const inFlightTail = computed(() => (props.pending.attempt > 1 ? ` (attempt ${props.pending.attempt})` : ''));
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

### 7.6 `CompactedCluster.vue`

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

### 7.7 `ContextBlock.vue`

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

---

## 8. Cross-issue ordering

### 8.1 Dependency edges (PR landing)

```
F01 r2 (tokens) ──► F02 r2 (folder layout, primitives)
F02 r2          ──► F03 r2 (this PR)
F03 r2          ──► F04 r3 (analyst surface; ToolChip swap is in F03 PR, see §8.2)
F05 r2 (presenters, InlineParts, FormattedContent, JsonView) ──► F03 r2
```

The F03 PR depends on F05 r2's `tool-presenters.ts`,
`InlineParts.vue`, `FormattedContent.vue`, and `JsonView.vue`. If
F05 lands in a prior commit on the same branch, F03 imports
directly; otherwise F03 is a stacked PR on top of F05.

### 8.2 AnalystChatPanel swap (binding)

The F03 batch **also** removes the in-line `tool-chip*` markup from
[web/src/components/chat/AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue)
and replaces it with the shared `<ToolChip>` from §7.2. Per F04 r3
§4.1, the analyst-side bridge is the adapter
`adaptChatMessageToToolChip(call, result, expanded)` returning the
exact eight-prop bag, including `callContent: call.content` and
`resultContent: result?.content ?? null`. This is the only way to
prevent HEAD from carrying two chip renderers at once (project
rule: no backward compatibility).

The analyst surface refactor (full re-layout, `MessageList.vue` /
`MessageItem.vue` extraction, `useStickToBottom`, jump-to-latest,
on-screen-children card) is **F04**'s scope. F03 only touches the
chip markup and imports in `AnalystChatPanel.vue`. The two PRs are
sequenced as F03 → F04 in §8.1.

---

## 9. Store

```ts
// web/src/stores/agents.ts (post-F03 shape; pre-F03 MessageStep / groupIntoSteps deleted in the same commit)
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { AgentSession, AgentConversationResponse } from '../api/types';
import type { ConversationEntry, ActivityStatus } from '../utils/agent-timeline/types';
import { getAgentConversation } from '../api/client';
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
    ws.onType('thinking', (env) => {
      const c = env.content ?? {};
      if (c.entry) appendEntry(c.entry);
      if (c.activity_status) setActivityStatus(c.activity_status);
    });
    ws.onType('activity', (env) => {
      const c = env.content ?? {};
      if (c.entry) appendEntry(c.entry);
      if (c.activity_status) setActivityStatus(c.activity_status);
    });
  }

  return {
    sessions, currentSession, entries, activityStatus, conversationWarning, loading, error,
    appendEntry, setActivityStatus, refreshConversation, bindWs,
  };
});
```

---

## 10. Deletions landed in the same change set

- [web/src/stores/agents.ts L30-L76](../../../web/src/stores/agents.ts#L30-L76) —
  `MessageStep` interface and `groupIntoSteps()` deleted.
- `web/src/stores/agents.ts` — `messages`, `steps` (computed),
  `expandedToolCalls` deleted; replaced by `entries`,
  `useAgentTimeline().timeline`, `useAgentTimeline().expanded`.
- [web/src/components/agents/AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue) —
  legacy flat-step template deleted; rewritten as a thin store
  container.
- [web/src/api/types.ts L752](../../../web/src/api/types.ts#L752) —
  `AgentConversationResponse.messages` deleted; `AgentMessage`
  renamed to `ConversationEntry`.
- `web/src/__tests__/agents-store.test.ts` flat-step cases deleted
  (per analysis §10.8); replaced by
  `agents-conversation.test.ts`.
- `src/server/websocket.ts` legacy `content.message` key removed in
  favour of `content.entry`.
- [src/agents/session-persistence.ts L209-L246](../../../src/agents/session-persistence.ts#L209-L246) —
  legacy `appendMessage` arity removed; the new arity is the only one.
- [web/src/components/chat/AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue) —
  in-line `<button class="tool-chip">` markup and local `ChipParts`
  interface deleted; replaced with `<ToolChip>` + adapter (§8.2).
  Scoped `.tool-chip*` rules deleted (F04 r3 line 108).

---

## 11. Test plan

### 11.1 Test files and named cases

The pure-utility, composable, and store cases come from analysis §10
unchanged. The chip cases are tightened per review items R3 and R4.

**`web/src/__tests__/utils/agent-timeline/round-id.test.ts`** — pure parser

- `parseRoundId > recognises r-pre at tier 0`
- `parseRoundId > recognises r-msg:N at tier 1 with numeric index`
- `parseRoundId > recognises rK at tier 2 with numeric index`
- `parseRoundId > recognises r-compacted-N at tier 3 with numeric index`
- `parseRoundId > rejects malformed tails as tier 4 unknown` (e.g. `r-msg:abc`, `r12x`, `rK-trailing`)
- `parseRoundId > rejects numeric tails above Number.MAX_SAFE_INTEGER as tier 4 unknown`
- `parseRoundId > parses r007 to tier 2 round index 7` (note: bucketing in §3.4 is by **raw string**, so `r007` and `r7` remain distinct buckets; this case asserts they only share a sort key)
- `roundIdSortKey > r-pre sorts before r0`
- `roundIdSortKey > r0 sorts before r1`
- `roundIdSortKey > r1 sorts before r-compacted-3`
- `roundIdSortKey > r007 and r7 yield the same numeric key`

**`web/src/__tests__/utils/agent-timeline/timeline.test.ts`** — pure bucketing

- (analysis §10.2 list verbatim; no changes for r2)

**`web/src/__tests__/composables/useAgentTimeline.test.ts`**

- (analysis §10.3 list verbatim)

**`web/src/__tests__/stores/agents-conversation.test.ts`**

- (analysis §10.4 list verbatim)

**`web/src/__tests__/conversation/ToolChip.test.ts`** — chip contract (R4)

- `ToolChip > renders exactly one <button> per chip (the toggle)` — query `chip.findAll('button')`, expect length 1.
- `ToolChip > emits F05 file InlineParts as <router-link> siblings of the toggle, not as descendants` — assert link's parent is the head row, **not** the toggle button.
- `ToolChip > emits F05 url InlineParts as <a target="_blank" rel="noopener noreferrer">`
- `ToolChip > emits F05 code InlineParts as <code> inline siblings`
- `ToolChip > emits F05 text InlineParts with tone class (tone-ok|warn|danger|muted)`
- `ToolChip > reads InlinePart fields (value / path,root / url / value) — never .text / .to / .href` — render with each kind and assert the rendered text comes from the F05 field name, not a v2 alias.
- `ToolChip > does NOT wrap the row in a <button>` — `chip.findAll('button').length === 1` AND the chip root is `<div role="group">`, not `<button>`.
- `ToolChip > sets aria-controls on the toggle to detailsId`
- `ToolChip > toggles aria-expanded on the toggle when expanded prop changes`
- `ToolChip > renders the expanded body as a sibling of the head row, with id === detailsId`
- `ToolChip > expanded body renders <FormattedContent :content="callContent"/>`
- `ToolChip > expanded body renders <FormattedContent :content="resultContent"/> only when resultContent !== null`
- `ToolChip > expanded body never re-parses JSON outside FormattedContent`
- `ToolChip > status=missing appends a muted "(no result yet)" suffix to the head`
- `ToolChip > status=orphan appends a muted "(orphan …)" suffix to the head`
- `ToolChip > status -> <Card> tone: pending→warn, ok→accent, error→danger, orphan→warn, missing→warn`
- `ToolChip > pending status with no result renders no result-side InlineParts and no resultContent body`
- `ToolChip > aria-label of the group describes "<call.name> <result.status | status>"`
- `ToolChip > absence of nested interactive controls (no <button> inside <button>, no <a> inside <button>)` — JSDOM walk asserting `closest('button, a')` from any link element returns the link itself, not the toggle.

**`web/src/__tests__/conversation/PendingCallFooter.test.ts`**

- (analysis §10.6 list verbatim)

**Backend test files** (analysis §10.7 verbatim):

- `src/__tests__/agents/round-id.test.ts`
- `src/__tests__/agents/agent-adapter.tool-call-id.test.ts`
- `src/__tests__/agents/session-persistence.round-stamp.test.ts`
- `src/__tests__/runtime/active-runtime-activity.test.ts`
- `src/__tests__/server/routes/conversation.test.ts`

Schema-grammar cases added in `src/__tests__/agents/round-id.test.ts`
to cover review item R2:

- `agentMessageSchema > rejects round_id with non-digit numeric tail (regex)`
- `agentMessageSchema > rejects round_id numeric tail above Number.MAX_SAFE_INTEGER (superRefine)`
- `agentMessageSchema > rejects tool_call without tool_call_id scalar (superRefine)`
- `agentMessageSchema > rejects tool_result without tool_call_id scalar (superRefine)`
- `agentMessageSchema > rejects tool_error without tool_call_id scalar (superRefine)`
- `agentMessageSchema > accepts r-pre, r-msg:0, r12, r-compacted-3`

### 11.2 Coverage rule

The chip-contract tests in `ToolChip.test.ts` are gates: the PR
does not merge until all DOM-contract cases pass. The reviewer's
core concern (R1) was that the r1 skeleton would not typecheck or
render against F05 r2 — these tests are the durable enforcement of
the resolution.

---

## 12. Recommendation

**Adopt Proposal A (§4) with the §7.2 ToolChip contract.**
Justification by axis (unchanged from r1, restated for r2):

- **Clean architecture.** The producer (`ActiveRuntime` +
  `agent-adapter`) stamps `round_id`, the schema validates it
  (§4.1), the consumer (`entriesToTimeline`) reads it. Each
  layer's responsibility is single and stable.
- **Testability.** `web/src/utils/agent-timeline/` has zero Vue
  imports; cases in §11.1 run as fast TS units.
- **Wire-contract neutrality.** `{ session, entries,
  activity_status }` carries a small presentation-neutral metadata
  vocabulary; future consumers (CLI replay, debug tools,
  analytics) read rounds without re-implementing inference.
- **F02 layering.** All six new SFCs land in `conversation/`;
  none import a store or router. The pure utility lives in
  `utils/agent-timeline/`. The composable lives in `composables/`.
  `AnalystChatPanel` consumes the same `<ToolChip>` (§8.2).
- **F04 alignment.** F04 r3 §4.0/§4.2 cite §3.3, §7.2, and §8.2
  by section number; this r2 lays out those sections at the cited
  numbers and provides the exact prop bag F04 r3's
  `adaptChatMessageToToolChip` / `adaptPendingInvocationToToolChip`
  return.
- **F05 alignment.** §7.2 uses F05 r2's `<InlineParts>` for
  structured headlines/details and `<FormattedContent>` for raw
  expanded bodies — no v2 field names (`text` / `to` / `href`)
  anywhere. No nested interactive elements.
- **No backward compatibility.** §10 enumerates the deletions; the
  PR landing condition is "old paths gone, new paths in".

Trade-off A accepts (one-time, behind one class boundary): a
strict-regex + `superRefine` schema and the
`SessionRoundState` / round-stamping API on `ActiveRuntime`. Both
are bounded; future surfaces benefit without paying the cost
again.

---

## 13. Out of scope (inherited from analysis §11)

- No port of v2's 692-line `toolFormatters.ts` (F05 r2 supersedes).
- No new `InlinePart` kinds beyond F05 r2's four.
- No new WS event type (piggybacked on `thinking`/`activity`).
- No streaming/delta protocol; entries arrive whole.
- No JSONL migration tool — test projects are reset (project rule).
- No analyst-chat composer or layout changes (F04 owns); F03 only
  swaps the in-line `tool-chip*` markup in `AnalystChatPanel.vue`
  to the shared `<ToolChip>` (§8.2).
- No virtualization / windowing for very long conversations.
- No router changes beyond `navigateToLink` consumed by
  `FormattedContent` (F05).
