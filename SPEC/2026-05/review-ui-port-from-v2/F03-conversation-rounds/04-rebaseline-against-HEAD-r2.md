# F03 — Rebaseline against HEAD `eb98caf` (r2)

Writer round 2. Addresses the reviewer findings on r1
(fabricated schema vocabulary; missing producer audit and §2.3
deletions; incorrect chip-swap ownership; wrong grep target;
mislabelled gate section). This document supersedes
[04-rebaseline-against-HEAD-r1.md](04-rebaseline-against-HEAD-r1.md).

This is a **binding addendum** to the F03 approved artifacts:

- analysis: [01-analysis-r2.md](01-analysis-r2.md)
- design:   [02-design-r3.md](02-design-r3.md)
- plan:     [03-plan-r2.md](03-plan-r2.md)

The approved analysis, design, and plan are unchanged. F03 has
shipped nothing at HEAD `eb98caf`. This rebaseline records (a)
the small precondition the F02 R1 batch leaves in place before
F03 starts, (b) the deliverable-by-deliverable nothing-lost
inventory restated against HEAD, (c) the binding producer audit
of every `AgentMessage` writer, and (d) the deletion roster from
plan §2.3.

A reader who has never seen earlier review rounds can implement
F03 by combining the approved design + plan + this rebaseline.
The implementer MUST NOT silently descope any plan row, MUST NOT
introduce alias re-exports, and MUST follow the nothing-lost
invariant in §6.

---

## 1. HEAD reference

- Commit: `eb98caf` (`master`).
- F03 landing status at HEAD: **nothing landed.** Verified:
  - `git grep -nE 'round_id|roundIdGrammar|SessionRoundState|RoundStamp' src/ web/src/api/ web/src/stores/`
    returns 0 hits.
  - `git grep -nE 'ConversationEntry|activity_status|recordAppend' src/ web/src/`
    returns 0 hits.
  - `test ! -d web/src/utils/agent-timeline` passes.
  - `test ! -e web/src/composables/useAgentTimeline.ts` passes.
  - `test ! -e web/src/components/chat/tool-chip-adapter.ts` passes.
  - `test ! -e src/agents/round-id.ts` passes.
  - `web/src/components/conversation/` contains only `ToolChip.vue`
    (on the F05-legacy four-prop signature; see §4.1).
  - `web/src/stores/agents.ts` still exports
    `MessageStep` / `groupIntoSteps()` / `messages` / `steps` /
    `expandedToolCalls` per plan §2.3.
  - `web/src/components/chat/AnalystChatPanel.vue` is the
    349-line monolith with inline `<button class="tool-chip">`
    markup, local `ChipParts` interface, and scoped `.tool-chip*`
    rules per plan §2.3.
  - `src/agents/analyst-handler.ts` still has its duplicate local
    `function appendMessage(...)` at L81–L90 and
    `function readMessages(...)` at L72–L80 per plan §0 row 1c.

The implementer MUST verify HEAD has not modified any of these
paths before starting. If HEAD has moved, file a delta proposal
naming the moved path before any implementation.

---

## 2. Cross-batch precondition: F02 rebaseline R1 has landed

The F03 plan is independent of F02's primitive-only deliverables;
the F02 R1 batch (per the F02 rebaseline) lands **MessageBubble,
ThinkingDots, the AppShell modal-flag short-circuit, the Overlay
`data-modal-open` flag, the tablist `.pill[aria-pressed]` CSS
rule, the NavRail `.api-token-btn` migration, and the C7–C12 /
C14 surface rewrites that do NOT touch
`AgentConversationView.vue` or `AnalystChatPanel.vue`**.

F02 R1 does **NOT** ship any of the cross-batch C5 components
that F03 plan §2.1 lists (`ToolChip.vue`, `RoundCard.vue`,
`DiagnosticRow.vue`, `PendingCallFooter.vue`, `CompactedCluster.vue`,
`ContextBlock.vue`, `tool-chip-adapter.ts`,
`web/src/utils/agent-timeline/*`, `useAgentTimeline.ts`). Those
files are F03-owned per plan §2.1 and are added in F03
commits 4–5.

The chip swap inside `AnalystChatPanel.vue` is F03 commit 6 per
plan §3. The full rewrite of `AgentConversationView.vue` is F03
commit 7 per plan §3. Neither has been done by F02 R1.

Required state of HEAD when F03 begins:

- `web/src/components/conversation/MessageBubble.vue` exists on
  the F02 design §1.3 contract.
- `web/src/components/conversation/ThinkingDots.vue` exists on
  the F02 design §1.3 contract.
- The F02 `ui/` primitives (`Card`, `Button`, `Pill`, `Overlay`,
  `Spinner`, `StatusDot`, `PanelHeading`) exist.
- `web/src/components/content/` exists with `JsonView.vue`,
  `FormattedContent.vue`, `InlineParts.vue`, `CodeBlock.vue`,
  `MarkdownText.vue`.
- `web/src/utils/tool-presenters/` (the F05 registry) exists.

If any of these is missing, the harness MUST file a delta
proposal naming the missing precondition before starting F03.

---

## 3. Remaining deliverables (IN SCOPE)

The plan §2.1 (Added) + §2.2 (Modified) + §2.3 (Deleted)
inventories apply verbatim. Restated as a status matrix:

### 3.1 Added files — plan §2.1

| Path | Owner | Source of contract |
| --- | --- | --- |
| `src/agents/round-id.ts` | F03 | design §3.2 |
| `src/__tests__/agents/round-id.test.ts` | F03 | design §11.1 |
| `src/__tests__/agents/agent-adapter.tool-call-id.test.ts` | F03 | design §11.1 |
| `src/__tests__/agents/session-persistence.round-stamp.test.ts` | F03 | design §11.1 |
| `src/__tests__/agents/agent-adapter.all-callsites.test.ts` | F03 | plan §0 row 1i / §2.5 R-AD-* |
| `src/__tests__/agents/analyst-handler.stamping.test.ts` | F03 | plan §0 row 1c / §2.5 R-AN-* |
| `src/__tests__/agents/analyst-stage6.stamping.test.ts` | F03 | plan §0 row 1d / §2.5 R-S6-1 |
| `src/__tests__/agents/fake-agent.stamping.test.ts` | F03 | plan §0 row 1e / §2.5 R-FK-1 |
| `src/__tests__/agents/session-persistence.stale-failure.test.ts` | F03 | plan §0 row 1f / §2.5 R-SP-1 |
| `src/__tests__/agents/session-persistence.activate-card.test.ts` | F03 | plan §0 row 1g / §2.5 R-SP-2 + R-RT-2 + R-RT-3 |
| `src/__tests__/agents/compaction.stamping.test.ts` | F03 | plan §0 row 1h / §2.5 R-CP-1 + §2.6 |
| `src/__tests__/runtime/runtime.resume-context.test.ts` | F03 | plan §0 row 1b / §2.5 R-RT-1 |
| `src/__tests__/runtime/active-runtime-activity.test.ts` | F03 | design §11.1 |
| `src/__tests__/server/routes/conversation.test.ts` | F03 | design §11.1 |
| `web/src/utils/agent-timeline/types.ts` | F03 | design §3.1 |
| `web/src/utils/agent-timeline/round-id.ts` | F03 | design §3.2 |
| `web/src/utils/agent-timeline/timeline.ts` | F03 | design §3.4 |
| `web/src/utils/agent-timeline/index.ts` | F03 | barrel; design §3 |
| `web/src/composables/useAgentTimeline.ts` | F03 | design §6 |
| `web/src/components/conversation/ToolChip.vue` | F03 | design §7.2 |
| `web/src/components/conversation/RoundCard.vue` | F03 | design §7.3 |
| `web/src/components/conversation/DiagnosticRow.vue` | F03 | design §7.4 |
| `web/src/components/conversation/PendingCallFooter.vue` | F03 | design §7.5 |
| `web/src/components/conversation/CompactedCluster.vue` | F03 | design §7.6 |
| `web/src/components/conversation/ContextBlock.vue` | F03 | design §7.7 |
| `web/src/components/chat/tool-chip-adapter.ts` | F03 (binding of F04 design r2 §1.10) | F04 design r2 §1.10 |
| `web/src/__tests__/utils/agent-timeline/round-id.test.ts` | F03 | design §11.1 |
| `web/src/__tests__/utils/agent-timeline/timeline.test.ts` | F03 | design §11.1 |
| `web/src/__tests__/composables/useAgentTimeline.test.ts` | F03 | design §11.1 |
| `web/src/__tests__/stores/agents-conversation.test.ts` | F03 | design §11.1 (replaces deleted flat-step file in §3.3) |
| `web/src/__tests__/conversation/ToolChip.test.ts` | F03 | design §11.1 R4 gates |
| `web/src/__tests__/conversation/PendingCallFooter.test.ts` | F03 | design §11.1 |
| `web/src/__tests__/chat/tool-chip-adapter.test.ts` | F03 | F04 design r2 §1.13 |

### 3.2 Modified files — plan §2.2

| Path | Change (anchor) |
| --- | --- |
| `src/schemas/types.ts` | `AgentMessage` widened: required `round_id: string`, `message_index: number`, `block_index: number`; optional `tool_call_id`, `model_spec`, `requested_model_spec`. Plan §2.2 row 1; design §4.1. |
| `src/schemas/validators.ts` | `agentMessageSchema` adds `roundIdGrammar` regex + `superRefine` (MAX_SAFE_INTEGER bound + scalar `tool_call_id` on `tool_call` / `tool_result` / `tool_error`). Plan §2.2 row 2; design §4.1. |
| `src/runtime/active-runtime.ts` | Adds `SessionRoundState`, `RoundStamp`, `PendingCall`, `ActivityStatus`, `SessionActivity`; methods `openAssistantRound`, `stampInRound`, `stampUserMessage`, `stampPre`, `stampCompacted`, `stampDiagnosticInCurrentRound`, `closeRound`, `rebuildSessionRoundState`, `getActivityStatus`, `recordAppend`; event-bus subscriptions for the seven topics listed in plan §2.2 row 3. Design §2.1, §4.2. |
| `src/agents/session-persistence.ts` | `appendMessage` widens to required round-stamp arity (the only arity — no overload, no default); calls `agentMessageSchema.parse` and `activeRuntime.recordAppend`. `failActiveWorkerSessions` (L178) accepts `activeRuntime` and stamps via `stampPre`. `appendActivateCardToolResultOnce` (L388) accepts a `RoundStamp` parameter (no default). Plan §2.2 row 4. |
| `src/agents/agent-adapter.ts` | All 18 enumerated callsites (R-AD-1..R-AD-18; §4 below) migrate to stamped `appendMessage(...)`. The L386 `for (const msg of toolMessages) appendMessage(...)` loop stamps each via `stampInRound`. `closeRound` runs after final assistant text (R-AD-12). Plan §2.2 row 5; design §2.2, §4.3. |
| `src/agents/analyst-handler.ts` | Local `appendMessage(...)` (L81–L90) and `readMessages(...)` (L72–L80) **deleted**. 12 callsites (R-AN-1..R-AN-12) route through `session-persistence.appendMessage(...)`. Constructor widened to accept `activeRuntime: ActiveRuntime` (required, no default). Factory call site in `src/agents/index.ts` updated. Plan §2.2 row 6; §0 row 1c. |
| `src/agents/analyst-stage6.ts` | `injectQueuedSyntheticPlannerNotes(...)` (L108) takes `activeRuntime` argument; stamps via `stampUserMessage(plannerSessionId)`. Caller (`agent-adapter.ts` L270) updated. Plan §2.2 row 7. |
| `src/agents/fake-agent.ts` | Fixture `tool_call` append (L80) stamps via `stampInRound`. Each fixture turn calls `openAssistantRound` at the start and `closeRound` at the end. Fixture emits scalar `tool_call_id` directly. Constructor + factory widened. Plan §2.2 row 8. |
| `src/runtime/runtime.ts` | (a) L401 planner-resume context append stamps via `stampUserMessage(plannerSessionId)`. (b) L205 + L250 `appendActivateCardToolResultOnce` callers forward `stampInRound(plannerSessionId)`. (c) `activeRuntime` threaded end-to-end through the `injectQueuedSyntheticPlannerNotes` chain. Plan §2.2 row 9. |
| `src/agents/compaction.ts` | Manual `summaryMsg` literal (L141–L156) deleted; replaced by `session-persistence.appendMessage(...)` stamped via `stampCompacted(sessionId)` → `r-compacted-${state.count + 1}`. `replaceSessionMessages(...)` parses each line through `agentMessageSchema` before disk write. Kept-entries policy per plan §2.6. `compactSession(...)` widened to accept `activeRuntime`. Plan §2.2 row 10. |
| `src/server/routes/runtime-config-notes.ts` | Conversation handler rewritten: response is `{ session, entries, activity_status }`; helper renamed `readAgentMessages` → `readConversationEntries`; each JSONL line parsed through `agentMessageSchema`. Plan §2.2 row 11; design §4.4. |
| `src/server/websocket.ts` | `thinking` and `activity` envelopes carry `{ sessionId, entry, activity_status }`; legacy `content.message` key removed (no alias). Plan §2.2 row 12; design §2.4, §4.5. |
| `web/src/api/types.ts` | `AgentConversationResponse.messages` removed; `AgentMessage` interface renamed in place to `ConversationEntry`; `ActivityStatus`, `PendingCall` exports added; `AgentConversationResponse` becomes `{ session, entries, activity_status }`. Plan §2.2 row 13. |
| `web/src/stores/agents.ts` | `MessageStep` + `groupIntoSteps()` + `messages` + `steps` + `expandedToolCalls` **deleted** (L30–L76). New state `entries`, `activityStatus`; new actions `appendEntry`, `setActivityStatus`, `refreshConversation`, `bindWs` per design §9. Plan §2.2 row 14. |
| `web/src/components/agents/AgentConversationView.vue` | Flat-step template deleted; rewritten as a thin store container that calls `useAgentTimeline(store.entries, store.activityStatus, () => store.currentSession?.id ?? null)` and renders the timeline. Plan §2.2 row 15. |
| `web/src/components/chat/AnalystChatPanel.vue` | Inline `<button class="tool-chip">` markup deleted; local `ChipParts` interface deleted; scoped `.tool-chip*` rules deleted. Chip rendered as `<ToolChip v-bind="adaptChatMessageToToolChip(...)" @toggle="…" />` for paired messages and `<ToolChip v-bind="adaptPendingInvocationToToolChip(p, ...)" @toggle="…" />` for pending invocations. Plan §2.2 row 16; design §8.2; F04 design r2 §1.10. |
| `src/agents/index.ts` | Factory injection sites for `AnalystHandler`, `FakeAgent`, `AgentAdapter` updated to pass the existing `ActiveRuntime`. Plan §2.2 row 17. |
| `web/src/__tests__/agents-store.test.ts` | File **deleted** (renamed-by-rewrite to `web/src/__tests__/stores/agents-conversation.test.ts` in §3.1). Plan §2.2 row 18; §2.3. |

### 3.3 Deletions — plan §2.3

The following must be removed in the same PR as their
replacements; no alias period, no `@deprecated` re-export.

- `web/src/__tests__/agents-store.test.ts` — flat-step shape; replaced by `web/src/__tests__/stores/agents-conversation.test.ts`.
- Inline `<button class="tool-chip*">`, local `ChipParts`, scoped `.tool-chip*` rules in `web/src/components/chat/AnalystChatPanel.vue`.
- `MessageStep`, `groupIntoSteps()`, `messages`, `steps`, `expandedToolCalls` in `web/src/stores/agents.ts` (L30–L76).
- Legacy template body of `web/src/components/agents/AgentConversationView.vue`.
- Legacy `appendMessage` arity (without round-stamp fields) in `src/agents/session-persistence.ts`.
- Legacy WS envelope key `content.message` in `src/server/websocket.ts`.
- `AgentConversationResponse.messages` field and the `AgentMessage` alias in `web/src/api/types.ts`.
- Local `function appendMessage(...)` at `src/agents/analyst-handler.ts` L81–L90 and local `function readMessages(...)` at L72–L80.
- Manual `AgentMessage` literal at `src/agents/compaction.ts` L141–L156 (`summaryMsg` inline).

### 3.4 Compaction policy — plan §2.6

Kept entries preserve their original stamps; the synthesised
summary head carries `round_id = r-compacted-${state.count + 1}`,
`message_index = 0`, `block_index = 0`, `tool_call_id = undefined`,
`model_spec = undefined`. `replaceSessionMessages(...)` runs
`agentMessageSchema.parse(...)` on every line before disk write.
The client-side `agent-timeline/round-id.ts` parser maps
`r-compacted-N` to tier 3 (`CompactedCluster`).

---

## 4. Producer audit (binding inventory)

This is plan §2.5 restated. Every entry must (a) write through
the shared `session-persistence.appendMessage(...)` arity and (b)
supply a `RoundStamp` from `activeRuntime.<stampSource>(...)`.
The audit grep (plan §3 commit 2b step 10):

```sh
rg -n "appendMessage\(|AgentMessage =|agentMessageSchema.parse|replaceSessionMessages\(|appendActivateCardToolResultOnce" src/
```

must return zero hits outside this inventory at the tip of
commit 2b.

| ID | File:Line | Stamp source | Test |
| --- | --- | --- | --- |
| R-SP-1 | `session-persistence.ts:L178` (`failActiveWorkerSessions`) | `stampPre(sessionId)` | `session-persistence.stale-failure.test.ts` |
| R-SP-2 | `session-persistence.ts:L388` (`appendActivateCardToolResultOnce`) | parameter (caller supplies) | `session-persistence.activate-card.test.ts` |
| R-RT-1 | `runtime.ts:L401` (planner-resume context) | `stampUserMessage(plannerSessionId)` | `runtime.resume-context.test.ts` |
| R-RT-2 | `runtime.ts:L205` (normal activate_card) | `stampInRound(plannerSessionId)` | `session-persistence.activate-card.test.ts` |
| R-RT-3 | `runtime.ts:L250` (restart-repair activate_card) | `stampInRound(plannerSessionId)` | `session-persistence.activate-card.test.ts` |
| R-S6-1 | `analyst-stage6.ts:L108` (synthetic planner note) | `stampUserMessage(plannerSessionId)` | `analyst-stage6.stamping.test.ts` |
| R-FK-1 | `fake-agent.ts:L80` (fixture tool_call) | `stampInRound(persistedSessionId)` + scalar `tool_call_id` | `fake-agent.stamping.test.ts` |
| R-CP-1 | `compaction.ts:L141–L194` (summary head + `replaceSessionMessages`) | `stampCompacted(sessionId)` for head; kept entries preserve original stamps (§3.4) | `compaction.stamping.test.ts` |
| R-AD-1 | `agent-adapter.ts:L346` (`model_issue` "Forcing final-answer turn") | `stampDiagnosticInCurrentRound(sessionId)` | `agent-adapter.all-callsites.test.ts` |
| R-AD-2 | `agent-adapter.ts:L347` (force-final-answer user prompt) | `stampUserMessage(sessionId)` | same |
| R-AD-3 | `agent-adapter.ts:L353` (`model_issue` "forceFinalAnswer LLM call failed") | `stampDiagnosticInCurrentRound(sessionId)` | same |
| R-AD-4 | `agent-adapter.ts:L365` (`model_issue` "Repeated tool-call fingerprint") | `stampDiagnosticInCurrentRound(sessionId)` | same |
| R-AD-5 | `agent-adapter.ts:L376` (tool_call loop) | `stampInRound(sessionId)` + `tool_call_id: tc.id` | `agent-adapter.tool-call-id.test.ts` |
| R-AD-6 | `agent-adapter.ts:L386 loop` (tool results) | `stampInRound(sessionId)` | `agent-adapter.all-callsites.test.ts` |
| R-AD-7 | `agent-adapter.ts:L407` (`model_issue` BLOCKED envelope) | `stampDiagnosticInCurrentRound(sessionId)` | same |
| R-AD-8 | `agent-adapter.ts:L412` (`model_issue` synthesised continuation) | `stampDiagnosticInCurrentRound(sessionId)` | same |
| R-AD-9 | `agent-adapter.ts:L453` (context-message ingest loop) | `stampPre(sessionId)` then `stampUserMessage(sessionId)` per dispatch in commit 2b step 8 | same |
| R-AD-10 | `agent-adapter.ts:L454 closure` (`persistFailure`) | `stampDiagnosticInCurrentRound(sessionId)` | same |
| R-AD-11 | `agent-adapter.ts:L473` (`model_recovered` directive) | `stampDiagnosticInCurrentRound(sessionId)` | same |
| R-AD-12 | `agent-adapter.ts:L488` (final assistant text, success) | `stampInRound(sessionId)` then `closeRound(sessionId)` | same |
| R-AD-13 | `agent-adapter.ts:L499` (`model_issue` bare toolCalls content) | `stampDiagnosticInCurrentRound(sessionId)` | same |
| R-AD-14 | `agent-adapter.ts:L505` (final assistant after toolCalls recovery) | `stampInRound(sessionId)` | same |
| R-AD-15 | `agent-adapter.ts:L510` (executor fallback `model_issue`) | `stampDiagnosticInCurrentRound(sessionId)` | same |
| R-AD-16 | `agent-adapter.ts:L515` (`model_issue` self-check ack) | `stampDiagnosticInCurrentRound(sessionId)` | same |
| R-AD-17 | `agent-adapter.ts:L522` (final assistant after self-check recovery) | `stampInRound(sessionId)` | same |
| R-AD-18 | `agent-adapter.ts:L527` (executor fallback after self-check parse failure) | `stampDiagnosticInCurrentRound(sessionId)` | same |
| R-AN-1..R-AN-12 | `analyst-handler.ts` L245, L251, L260, L273, L280, L290, L357, L363, L371, L375, L410, L414 (12 writers) | per-row mix (`stampUserMessage` for L245 user; `openAssistantRound` for the first assistant of a turn; `stampInRound` for subsequent; scalar `tool_call_id` on L375; `closeRound` after the three terminal assistant paths L363/L371/L414). Helper: inline `stampForKind(kind, position)`. | `analyst-handler.stamping.test.ts` |

---

## 5. Reconciliation (replace shipped-with-wrong-shape; no alias period)

### 5.1 `ToolChip.vue` prop bag — eight-prop contract

`web/src/components/conversation/ToolChip.vue` ships at HEAD on
the F05-legacy `presentation` four-prop signature. F03 plan
§2.1 owns the rewrite to the eight-prop bag (design §7.2 +
F04 design r2 §1.10 + plan row "ToolChip"):

```
{
  call:           ToolCallPresentation;
  result:         ToolResultPresentation | null;
  callContent:    string;
  resultContent:  string | null;
  status:         'pending' | 'ok' | 'error';
  expanded:       boolean;
  detailsId:      string;
  timestamp?:     string;
}
```

The rewrite lands in F03 commit 5 (Conversation components). The
chip-swap inside `AnalystChatPanel.vue` (commit 6) and the full
rewrite of `AgentConversationView.vue` (commit 7) are the only
consumers; both migrate to the eight-prop bag in the same PR.
Per-tool presenter modules under `web/src/utils/tool-presenters/`
continue to return `ToolCallPresentation` / `ToolResultPresentation`
(legitimate per-tool return types); the chip consumes them via
the `call` / `result` props.

### 5.2 No `formatToolPair` re-introduction

Design §1.6 + F05 r3 §4 forbid a shared `formatToolPair`. The
audit grep (added to F03 plan §3 commit 8 gates):

```sh
git grep -n 'formatToolPair\|FormattedToolPair' web/src/ | wc -l   # MUST be 0
```

---

## 6. Nothing-lost invariant (binding)

The harness MUST:

1. Read this rebaseline plus [02-design-r3.md](02-design-r3.md)
   and [03-plan-r2.md](03-plan-r2.md).
2. Produce a stage-plan whose stages, taken together, cover
   every row in §3.1 (Added), §3.2 (Modified), §3.3 (Deleted),
   §3.4 (Compaction policy), §4 (Producer audit), and §5
   (Reconciliation). No row may be silently dropped or narrowed.
3. Treat §2 (precondition) as a hard check: if the F02 R1 batch
   has not landed the primitives + AppShell modal flag + Overlay
   modal flag + tablist rule, file a delta proposal or reject.
4. Honour the architecture-first rule: every legacy item in
   §3.3 is removed in the same PR as its replacement.
5. Run the producer audit grep at the tip of commit 2b and at PR
   tip; zero hits outside §4.
6. Cite plan §5 + design §11.1 for the full-suite acceptance
   gates (schema-stamp canary, the §4 audit grep, per-callsite
   tests, no-flat-renderer assertion on
   `AgentConversationView.vue`, exhaustiveness on the
   `ConversationEntry` discriminated union).

---

## 7. Stage-mapping suggestion (non-binding shape)

A reasonable decomposition is the F03 plan §3 commit sequence
verbatim:

- Stage F3-S1 = plan commit 1 (`ActiveRuntime` round counters +
  activity status; tests `active-runtime-activity.test.ts`).
- Stage F3-S2 = plan commit 2a (widen `AgentMessage` schema +
  `session-persistence` stamp arity + canary; tests
  `round-id.test.ts`, `session-persistence.round-stamp.test.ts`).
- Stage F3-S3 = plan commit 2b (every producer in §4 migrated;
  duplicate analyst helper deleted; tests for each row in §4).
  The audit grep gate runs at the tip.
- Stage F3-S4 = plan commit 3 (server route + WS envelope +
  wire-types rename; `conversation.test.ts`).
- Stage F3-S5 = plan commit 4 (`agent-timeline/*` +
  `useAgentTimeline.ts`; web tests).
- Stage F3-S6 = plan commit 5 (Conversation components — `ToolChip`
  eight-prop rewrite, `RoundCard`, `DiagnosticRow`,
  `PendingCallFooter`, `CompactedCluster`, `ContextBlock`; web
  tests).
- Stage F3-S7 = plan commit 6 (`AnalystChatPanel.vue` chip swap;
  `tool-chip-adapter.test.ts`).
- Stage F3-S8 = plan commit 7 (delete legacy + rewrite
  `AgentConversationView.vue`).
- Stage F3-S9 = plan commit 8 (remaining tests:
  `agents-conversation.test.ts`, stragglers; full-suite gates).

After Stage F3-S9: full-suite gates per plan §5. Open PR.

If the harness chooses a different decomposition, every row in
§3 + §4 + §5 must still be honoured, and the audit grep in §4
must return zero hits outside the inventory at the tip of the
producer-migration stage.
