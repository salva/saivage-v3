# F03 — Conversation rounds / diagnostics / pairing — Design (r3)

Writer round 3. Addresses the single remaining required change in
the binding critique [02-design-review-r2.md](02-design-review-r2.md).
Builds on the approved analysis [F03 r2](01-analysis-r2.md) and on
the approved cross-issue designs
[F04 design r2 (APPROVED)](../F04-chat-surface-style/02-design-r2.md) and
[F05 design r2](../F05-tool-detail-rendering/02-design-r2.md).
Previous draft: [02-design-r2.md](02-design-r2.md). Issue:
[F03-conversation-rounds.md](../F03-conversation-rounds.md).

The reviewer in r2 explicitly offered two acceptable resolutions for
the remaining blocker (R1-follow-up):

> Required resolution: either update the binding F04 r3 analysis so
> §4.0/§4.1 include `callContent` / `resultContent`, or change the
> F03/F05 cross-references so they no longer claim F04 r3 is the
> aligned eight-prop source and instead cite the accepted F04
> design document that owns that correction.

r3 takes the second option: F04 **design r2** ([DESIGN-APPROVED.md](../F04-chat-surface-style/DESIGN-APPROVED.md))
is the approved owner of the eight-prop chip contract via
[F04 design r2 §1.10](../F04-chat-surface-style/02-design-r2.md#L1102),
so all of F03's cross-references to the chip-adapter contract now
point there instead of at the stale six-prop §4.0/§4.1 of the F04
analysis. The F04 analysis r3 is left untouched (it is outside
F03's editorial scope; design r2 supersedes it on this surface
anyway, per the F04 design-approval marker).

**Mandatory project rule (binding, unchanged from r2):**
**architecture-first, NO backward compatibility.** Same commit set
lands new types/components and removes the flat `MessageStep` /
`groupIntoSteps()` machinery, `AgentConversationResponse.messages`,
the legacy `appendMessage(...)` arity, the legacy WS
`content.message` key, and the in-line `.tool-chip*` markup in
[web/src/components/chat/AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue)
(§8.2). Nothing is kept "for later", nothing is aliased.

---

## 0. Required-changes coverage map

| # | Reviewer-required item ([02-design-review-r2.md](02-design-review-r2.md)) | Addressed in |
| - | ------------------------------------------------------------------------- | ------------ |
| R1-followup | Reconcile the F04 r3 chip-contract reference with the eight-prop raw-content contract. Reviewer accepted either updating F04 r3 analysis §4.0/§4.1 **or** changing F03/F05 cross-references to cite the accepted F04 design document. F03 r3 takes option B: every cross-reference to the chip-adapter contract in F03 now cites [F04 design r2 §1.10](../F04-chat-surface-style/02-design-r2.md#L1102) (APPROVED), not F04 analysis r3 §4.0/§4.1. | Preamble, [§1](#1-changes-since-r2), [§7.2 bullet list](#72-toolchipvue--prop-bag-and-template-unchanged-cross-refs-rebased-to-f04-design-r2), [§8.2](#82-analystchatpanel-swap-binding-cross-refs-rebased), [§12](#12-recommendation-cross-refs-rebased). |
| R2 | Schema-level digit grammar with `Number.MAX_SAFE_INTEGER` bound. | r2 §4.1 (unchanged; restated by reference). |
| R3 | Leading-zero wording: `r007` and `r7` distinct buckets, only share a sort key. | r2 §3.2 and §11.1 (unchanged). |
| R4 | `ToolChip` contract tests: single `<button>`, F05 `InlinePart` fields, raw expanded body via `<FormattedContent>`. | r2 §11.1 (unchanged). |
| Accepted axes | Producer authority for round stamps; schema canary; v2 timeline algorithm ported as a pure utility; legacy paths deleted; AnalystChatPanel chip swap in F03 batch; backend round counters; activity-status pipeline; canonical `{ session, entries, activity_status }` wire shape; piggyback WS envelopes on `thinking`/`activity`. | r2 §2–§10 (unchanged). |

The r2 review verdict (`CHANGES_REQUESTED`) was driven entirely by
the single F04-r3 cross-reference mismatch. r3 fixes that and
leaves every reviewer-approved piece of r2 verbatim — restated by
reference rather than rewritten, with diffs called out below.

---

## 1. Changes since r2

The only substantive change between r2 and r3 is the chip-contract
cross-reference rebase, plus a small handful of mechanical edits in
the sections that cited F04 analysis r3 by section number. No
algorithm, type, schema, route, WS envelope, store, composable, or
test name has changed.

1. **Chip-contract anchor rebased to F04 design r2 (APPROVED).**
   - Every "F04 r3 §4.0 / §4.1 / §4.2" citation that referred to
     the chip adapter is replaced with "F04 design r2 §1.10".
   - The contract itself is unchanged: eight props
     `{ call, result, callContent, resultContent, status, expanded, detailsId, timestamp? }`,
     headlines/details through `<InlineParts>` (F05 r2 §6), raw
     expanded bodies through `<FormattedContent :content=...>` (F05
     r2 §7.3), non-nested interactive DOM (single `<button>` is the
     toggle; links/anchors are siblings).
   - F04 design r2 §1.10 defines `adaptChatMessageToToolChip` and
     `adaptPendingInvocationToToolChip` returning that exact prop
     bag; F03's `toolChipPropsFor(pair)` helper in [§7.3](#73-roundcardvue-unchanged-from-r2) returns the same shape for
     conversation tool pairs. Both adapters are siblings of the
     same `<ToolChip>` (§7.2).

2. **Preamble cross-issue references rebased.** F04 binding link is
   now F04 design r2 (the design-approved doc) rather than F04
   analysis r3. F04 analysis r3 is referenced only where r3 is
   referencing the F04 analysis surface (folder layout, bridge
   description), never for the chip-prop contract.

3. **§7.2's "Why this contract reconciles three documents" list
   updated.** The third bullet — previously "F04 r3 §4.0 binds the
   prop bag with `v-bind=adaptChatMessageToToolChip(...)`" — now
   reads "F04 design r2 §1.10 (APPROVED) binds the prop bag with
   `v-bind="adaptChatMessageToToolChip(item.call, item.result, expanded)"`,
   and provides both `adaptChatMessageToToolChip` and
   `adaptPendingInvocationToToolChip` returning the same eight-prop
   bag verbatim".

4. **§8.2's adapter citation updated.** "Per F04 r3 §4.1 the analyst
   bridge is the adapter `adaptChatMessageToToolChip…`" is now
   "Per [F04 design r2 §1.10](../F04-chat-surface-style/02-design-r2.md#L1102) the analyst bridge is the adapter
   `adaptChatMessageToToolChip(call, result, expanded)` (with
   `adaptPendingInvocationToToolChip` for synthetic pending
   invocations) returning the exact eight-prop bag, including
   `callContent: call.content` and `resultContent: result?.content ?? null`".

5. **§12's per-axis recommendation updated.** "F04 alignment" bullet
   now cites F04 design r2 §1.10 and notes that F04 design r2 is
   APPROVED and is the authoritative chip-contract sibling for the
   purpose of inter-issue agreement; F04 analysis r3 remains the
   approved functional analysis but is not the contract source.

6. **No other diffs.** §0 coverage map, §1 changes list, §2 shared
   backend/wire surface, §3 pure timeline utility, §4 Proposal A
   (backend types, schema with `superRefine`, `ActiveRuntime`
   counters, `appendMessage` rewrite, route response, WS envelope
   construction), §5 Proposal B rejection, §6 composable, §7.3–§7.7
   conversation components, §9 store, §10 deletions list, §11 test
   plan, §13 out-of-scope are reproduced **by reference** from r2
   and apply unchanged. Where r3 below restates a section in full,
   that is for readability of the chip-contract surface only and
   the body is byte-equivalent to r2 except for the cross-reference
   line(s) called out above.

---

## 2. Shared backend & wire surface

Unchanged from r2. See [02-design-r2.md §2](02-design-r2.md#2-shared-backend--wire-surface-used-by-both-proposals)
in full:

- §2.1 `ActiveRuntime` activity-status additions (`PendingCall`,
  `ActivityStatus`, `SessionActivity`, event-bus wiring for
  `session_started`, `model_selected`, `invocation_succeeded`,
  `invocation_failed`, `retry_attempted`, `session_cancelled`,
  `session_force_cancelled`; `getActivityStatus`, `recordAppend`,
  private transition handlers, `failureClassToReason`, `nowIso`).
- §2.2 `tool_call_id` scalar fix at
  [agent-adapter.ts L376](../../../src/agents/agent-adapter.ts#L376)
  (stamped via `activeRuntime.stampInRound(sessionId)`).
- §2.3 canonical wire shape:
  `AgentConversationResponse = { session, entries, activity_status }`
  with `messages` removed and `AgentMessage` renamed to
  `ConversationEntry` in place.
- §2.4 WS envelope widening: `thinking` and `activity` carry
  `{ sessionId, entry, activity_status }`; no new event type; the
  legacy `message` key is removed.

---

## 3. Pure timeline utility — `web/src/utils/agent-timeline/`

Unchanged from r2. See
[02-design-r2.md §3](02-design-r2.md#3-pure-timeline-utility--websrcutilsagent-timeline)
for §3.1 `types.ts` (`ConversationEntry`, `PendingCall`,
`ActivityStatus`, `ToolPair`, `Round`, `TimelineItem`), §3.2
`round-id.ts` (`parseRoundId`, `roundIdSortKey`, the
leading-zero note), §3.3 `ToolPairStatus`, §3.4 `timeline.ts`
(`entriesToTimeline`, the bucketing-by-raw-string contract, the
fail-loud `tool_call_id` drop with `console.warn`).

---

## 4. Proposal A — Focused fix (recommended)

Unchanged from r2. See
[02-design-r2.md §4](02-design-r2.md#4-proposal-a--focused-fix-recommended-matches-analysis-r2)
for §4.1 schema (`agentMessageSchema` with `roundIdGrammar` regex
plus `superRefine` enforcing the MAX_SAFE_INTEGER bound and the
required `tool_call_id` scalar on tool entries), §4.2
`ActiveRuntime` round counters (`SessionRoundState`, `RoundStamp`,
`openAssistantRound`, `stampInRound`, `stampUserMessage`,
`stampPre`, `stampCompacted`, `stampDiagnosticInCurrentRound`,
`closeRound`, `rebuildSessionRoundState`), §4.3 `appendMessage`
rewrite and callsite table, §4.4 route response, §4.5 WS envelope
construction.

---

## 5. Proposal B — Rejected (documented)

Unchanged from r2. See
[02-design-r2.md §5](02-design-r2.md#5-proposal-b--minimal-backend-view-side-round-derivation-rejected-documented).
Seven-point rejection rationale stands.

---

## 6. Composable `useAgentTimeline`

Unchanged from r2. See
[02-design-r2.md §6](02-design-r2.md#6-composable-useagenttimeline).
`pendingRoundId` derivation, `defaultModelSpec` derivation,
`expanded`/`toggleDetails`/`expandAll`/`collapseAll`, scroll
stickiness (`SCROLL_BOTTOM_TOLERANCE_PX = 24`), reset-on-agent-switch,
and `now` clock all carry over.

---

## 7. Components

### 7.1 Folder layout

Unchanged from r2 §7.1. Six new SFCs under
`web/src/components/conversation/`, pure utility under
`web/src/utils/agent-timeline/`, composable under
`web/src/composables/`. F02 r2 discriminator respected (no store,
no router, no WebSocket inside `conversation/`).

### 7.2 `ToolChip.vue` — prop bag and template (unchanged; cross-refs rebased to F04 design r2)

The contract this section pins is the **single** chip contract used
by both `RoundCard.vue` (§7.3) and the analyst-surface bridge in
[F04 design r2 §1.10](../F04-chat-surface-style/02-design-r2.md#L1102).
It reconciles three documents (R1, R1-followup):

- [F05 r2 §2](../F05-tool-detail-rendering/02-design-r2.md) —
  `ToolCallPresentation` / `ToolResultPresentation` carry
  `headline: InlinePart[]` and `detail: InlinePart[]`.
- [F05 r2 §3](../F05-tool-detail-rendering/02-design-r2.md) —
  `InlinePart` discriminated union with fields `value` (text/code),
  `path` + `root` (file), `url` (url).
- [F05 r2 §6](../F05-tool-detail-rendering/02-design-r2.md) —
  non-button `<div role="group">` with one expand `<button>` and
  sibling `<router-link>` / `<a>` rendered by `<InlineParts>`.
  **No nested interactive elements.**
- **[F04 design r2 §1.10](../F04-chat-surface-style/02-design-r2.md#L1102)
  (APPROVED)** — binds the chip with
  `v-bind="adaptChatMessageToToolChip(item.call, item.result, expanded)"`
  and supplies both `adaptChatMessageToToolChip` and
  `adaptPendingInvocationToToolChip`, each returning the
  eight-prop bag verbatim including `callContent: call.content` and
  `resultContent: result ? result.content : null` (the pending
  variant synthesises `callContent` from
  `{tool, summary, classifiedAs, relatedCardId, startedAt}` and
  sets `resultContent: null`). This is the authoritative chip
  contract for the inter-issue agreement requirement; the F04
  analysis r3 §4.0/§4.1 sketch with six props is superseded by F04
  design r2 in the design layer and is not referenced by F03.
- **F03** — the chip's expanded body shows the **raw** producer
  payload (`content` JSON or prose), passed through F05's
  `<FormattedContent :content=...>` so JSON-vs-prose auto-detection
  ([F05 r2 §7.3](../F05-tool-detail-rendering/02-design-r2.md)) applies.

**Prop bag (eight props, no slots) — unchanged from r2:**

```ts
// web/src/components/conversation/ToolChip.vue
import type { ToolCallPresentation, ToolResultPresentation } from '../../utils/tool-presenters';
import type { ToolPairStatus } from '../../utils/agent-timeline/types';

defineProps<{
  call: ToolCallPresentation;            // F05 r2 §2 — always present (synthesised for orphan results, see F04 design r2 §1.10)
  result: ToolResultPresentation | null; // F05 r2 §2 — null when no result yet (or pending)
  callContent: string;                   // RAW producer payload for the expanded body (call entry .content; or synthetic for pending invocations)
  resultContent: string | null;          // RAW producer payload for the expanded body (result entry .content or null)
  status: ToolPairStatus;                // §3.3
  expanded: boolean;
  detailsId: string;                     // `tool-detail-<toolUseId>` (or `tool-detail-pending-<id>` per F04 design r2 §1.10)
  timestamp?: string;
}>();
defineEmits<{ (e: 'toggle'): void }>();
```

**Template (non-nested interactive DOM, F05 r2 §6 verbatim) —
unchanged from r2 §7.2:**

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
      <InlineParts class="tool-chip-headline" :parts="call.headline" />
      <InlineParts
        v-if="call.detail.length > 0"
        class="tool-chip-tag"
        :parts="call.detail"
      />
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

    <div v-if="expanded" :id="detailsId" class="tool-chip-detail">
      <FormattedContent :content="callContent" />
      <FormattedContent v-if="resultContent !== null" :content="resultContent" />
    </div>
  </Card>
</template>
```

**Status-to-tone mapping** (consumed by both adapters; identical to
r2 §7.2 and to
[F04 design r2 §1.10](../F04-chat-surface-style/02-design-r2.md#L1102)
status-driven adapter logic):

| `status`  | `<Card>` tone | rationale |
| --------- | ------------- | --------- |
| `pending` | `warn`        | in-flight, no result yet |
| `ok`      | `accent`      | successful result |
| `error`   | `danger`      | failed result |
| `orphan`  | `warn`        | result with no call (surfaced as warning, not error) |
| `missing` | `warn`        | call present, no result yet; chip headline gets a muted suffix |

**DOM contract** (test-asserted in §11.1 — unchanged from r2):

- Exactly **one** `<button>` per chip (the toggle).
- File / URL links rendered by `<InlineParts>` are **siblings** of
  the toggle, not descendants.
- The expanded body (`#tool-detail-…`) is a sibling of the
  `tool-chip-head` div, not a child of any `<button>`.
- The `aria-controls` target id (`detailsId`) is the id of the
  expanded body div.

### 7.3 `RoundCard.vue` (unchanged from r2)

The conversation-side adapter `toolChipPropsFor(pair)` (§7.3 in r2)
returns the same eight-prop bag as F04 design r2 §1.10's
`adaptChatMessageToToolChip`. The two adapters are deliberately
parallel: F03 owns the `ToolPair`-shaped input (from
`entriesToTimeline`), F04 owns the `{call, result}`-shaped chat
input. Both produce the eight-prop bag that `<ToolChip>` (§7.2)
consumes; both set `callContent` / `resultContent` to the raw
producer payload.

See [02-design-r2.md §7.3](02-design-r2.md#73-roundcardvue) in full
for the SFC body.

### 7.4 `DiagnosticRow.vue`

Unchanged from [02-design-r2.md §7.4](02-design-r2.md#74-diagnosticrowvue).

### 7.5 `PendingCallFooter.vue`

Unchanged from [02-design-r2.md §7.5](02-design-r2.md#75-pendingcallfootervue).

### 7.6 `CompactedCluster.vue`

Unchanged from [02-design-r2.md §7.6](02-design-r2.md#76-compactedclustervue).

### 7.7 `ContextBlock.vue`

Unchanged from [02-design-r2.md §7.7](02-design-r2.md#77-contextblockvue).

---

## 8. Cross-issue ordering

### 8.1 Dependency edges (PR landing) — unchanged

```
F01 r2 (tokens) ──► F02 r2 (folder layout, primitives)
F02 r2          ──► F03 r3 (this PR)
F03 r3          ──► F04 (analyst surface; ToolChip swap is in F03 PR, see §8.2)
F05 r2 (presenters, InlineParts, FormattedContent, JsonView) ──► F03 r3
```

The F03 PR depends on F05 r2's `tool-presenters.ts`,
`InlineParts.vue`, `FormattedContent.vue`, and `JsonView.vue`. If
F05 lands in a prior commit on the same branch, F03 imports
directly; otherwise F03 is a stacked PR on top of F05. F04 ships
after F03 (the analyst surface re-layout/composable extraction is
F04's scope; the chip swap inside `AnalystChatPanel.vue` is F03's
batch — see §8.2).

### 8.2 AnalystChatPanel swap (binding; cross-refs rebased)

The F03 batch removes the in-line `tool-chip*` markup from
[web/src/components/chat/AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue)
and replaces it with the shared `<ToolChip>` from §7.2. The
analyst-side bridge is the adapter
`adaptChatMessageToToolChip(call, result, expanded)` defined in
**[F04 design r2 §1.10 (APPROVED)](../F04-chat-surface-style/02-design-r2.md#L1102)**
(with a sibling `adaptPendingInvocationToToolChip` for synthetic
pending invocations), returning the exact eight-prop bag, including
`callContent: call.content` and
`resultContent: result ? result.content : null` for resolved
invocations, and `callContent: syntheticCallContent` /
`resultContent: null` for pending ones. This is the only
mechanism that prevents HEAD from carrying two chip renderers at
once (project rule: no backward compatibility).

The analyst surface full re-layout, `MessageList.vue` /
`MessageItem.vue` extraction, `useStickToBottom`, jump-to-latest,
and on-screen-children card are **F04**'s scope. F03 touches only
the chip markup, the local `ChipParts` interface, the scoped
`.tool-chip*` rules, and the imports in `AnalystChatPanel.vue`.
PR sequencing is F03 → F04 in §8.1.

---

## 9. Store

Unchanged from [02-design-r2.md §9](02-design-r2.md#9-store).
`useAgentsStore` exposes `entries`, `activityStatus`,
`appendEntry`, `setActivityStatus`, `refreshConversation`, `bindWs`
piggybacking on `thinking` and `activity` envelopes; dedupe by
`entry.id`; full replace from `refreshConversation` (server is the
source of truth, including compaction rewrites).

---

## 10. Deletions landed in the same change set

Unchanged from [02-design-r2.md §10](02-design-r2.md#10-deletions-landed-in-the-same-change-set).
The list still names: `MessageStep` and `groupIntoSteps` in
`web/src/stores/agents.ts`; `messages`/`steps`/`expandedToolCalls`
refs; the legacy template in
[web/src/components/agents/AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue);
`AgentConversationResponse.messages` and the `AgentMessage` alias
in [web/src/api/types.ts](../../../web/src/api/types.ts); the
flat-step cases in `web/src/__tests__/agents-store.test.ts`; the
legacy `content.message` WS key in `src/server/websocket.ts`; the
old `appendMessage` arity in
[src/agents/session-persistence.ts](../../../src/agents/session-persistence.ts);
the in-line `tool-chip*` markup, local `ChipParts` interface, and
scoped `.tool-chip*` rules in
[web/src/components/chat/AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue).

---

## 11. Test plan

Unchanged from [02-design-r2.md §11](02-design-r2.md#11-test-plan).
The chip-contract cases in
`web/src/__tests__/conversation/ToolChip.test.ts` still gate the
PR; the named cases (single `<button>` per chip, F05 `InlinePart`
field names rendered correctly, expanded body via
`<FormattedContent>`, raw `callContent` / `resultContent` flow,
status-to-tone mapping, no nested interactive controls, sibling
expanded body, `aria-controls` to `detailsId`) collectively
enforce the eight-prop contract on the implementation side, so the
PR cannot regress to the older six-prop shape.

The backend schema-grammar cases in
`src/__tests__/agents/round-id.test.ts` enforcing R2
(`MAX_SAFE_INTEGER` bound and required `tool_call_id` scalar on
`tool_call` / `tool_result` / `tool_error`) likewise carry over.

---

## 12. Recommendation (cross-refs rebased)

**Adopt Proposal A (§4) with the §7.2 ToolChip contract.**
Justification by axis (unchanged from r2 except for the F04
alignment bullet):

- **Clean architecture.** Producer (`ActiveRuntime` +
  `agent-adapter`) stamps `round_id`; schema validates it (§4.1);
  consumer (`entriesToTimeline`) reads it. Each layer's
  responsibility is single and stable.
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
- **F04 alignment (rebased).**
  [F04 design r2 §1.10](../F04-chat-surface-style/02-design-r2.md#L1102)
  is **APPROVED** ([DESIGN-APPROVED.md](../F04-chat-surface-style/DESIGN-APPROVED.md))
  and is the authoritative chip-contract sibling for inter-issue
  agreement: it defines `adaptChatMessageToToolChip` and
  `adaptPendingInvocationToToolChip` returning the same
  eight-prop bag F03 §7.2 consumes, with `callContent` /
  `resultContent` set to the raw producer payload (or a
  synthesised payload for pending invocations). F04 analysis r3
  remains the approved functional analysis for the analyst
  surface but is not the chip-contract source: design r2
  supersedes it on this surface, per the F04 design-approval
  marker. F03 r3 cites F04 design r2 §1.10 for every chip-adapter
  cross-reference (§7.2, §8.2, §10).
- **F05 alignment.** §7.2 uses F05 r2's `<InlineParts>` for
  structured headlines/details and `<FormattedContent>` for raw
  expanded bodies — no v2 field names (`text` / `to` / `href`)
  anywhere. No nested interactive elements.
- **No backward compatibility.** §10 enumerates the deletions;
  the PR landing condition is "old paths gone, new paths in".

Trade-off A accepts (one-time, behind one class boundary): a
strict-regex + `superRefine` schema and the `SessionRoundState` /
round-stamping API on `ActiveRuntime`. Both are bounded; future
surfaces benefit without paying the cost again.

---

## 13. Out of scope

Unchanged from [02-design-r2.md §13](02-design-r2.md#13-out-of-scope-inherited-from-analysis-11).
No port of v2's 692-line `toolFormatters.ts`; no new `InlinePart`
kinds beyond F05 r2's four; no new WS event type; no
streaming/delta protocol; no JSONL migration tool; no analyst-chat
composer/layout changes (F04 scope) — only the chip swap in
`AnalystChatPanel.vue` (§8.2); no virtualization for very long
conversations; no router changes beyond `navigateToLink` consumed
by `FormattedContent`.
