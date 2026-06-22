# F03 — Conversation rounds / diagnostics / pairing — Implementation plan (r2)

Writer round 2. Addresses the single blocking finding in the
binding critique
[03-plan-review-r1.md](03-plan-review-r1.md) (backend stamp
coverage is not complete across all current `AgentMessage`
producers). Built on the approved design
[02-design-r3.md](02-design-r3.md) and the approved analysis
[01-analysis-r2.md](01-analysis-r2.md). Cross-issue:
[F02 r2](../F02-component-hierarchy/01-analysis-r2.md),
[F04 design r2 (APPROVED)](../F04-chat-surface-style/02-design-r2.md),
[F05 design r3 (APPROVED)](../F05-tool-detail-rendering/02-design-r3.md).
Issue: [F03-conversation-rounds.md](../F03-conversation-rounds.md).
Previous draft: [03-plan-r1.md](03-plan-r1.md).

**Mandatory project rule (binding, unchanged from r1):**
**architecture-first, NO backward compatibility.** The same branch
lands the new types, components, and store API and **removes**
the flat `MessageStep` / `groupIntoSteps()` machinery,
`AgentConversationResponse.messages`, the legacy `AgentMessage`
alias, the legacy `appendMessage(...)` arity without round-stamp
fields, the duplicate local `appendMessage` helper in
[src/agents/analyst-handler.ts](../../../src/agents/analyst-handler.ts)
(see [§0 row 1c](#0-required-changes-coverage-map) and
[§3 commit 2b step 1](#commit-2b--producer-stamping-coverage-across-every-agentmessage-writer)),
the legacy WS `content.message` key, the in-line `tool-chip*`
markup in
[web/src/components/chat/AnalystChatPanel.vue](../../../web/src/components/chat/AnalystChatPanel.vue),
and the legacy `AgentConversationView.vue` template. Nothing is
kept "for later", nothing is aliased, no migration shim is left
behind.

---

## 0. Required-changes coverage map

| # | Required change ([03-plan-review-r1.md](03-plan-review-r1.md))                                                                                                                                                                                  | Addressed in                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| - | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a | Add an explicit producer-audit step at the end of the stamping commit (`rg "appendMessage\\(|AgentMessage =|agentMessageSchema.parse" src`) and require zero unstamped producers.                                                              | [§2.5](#25-producer-audit-binding-list), [§3 commit 2b step 10](#commit-2b--producer-stamping-coverage-across-every-agentmessage-writer), [§5.1](#51-per-commit-validation-root--web-where-applicable).                                                                                                                                                                                                                                                |
| 1b | Cover [src/runtime/runtime.ts L401](../../../src/runtime/runtime.ts#L401) (planner resume context via shared `appendMessage`).                                                                                                                  | [§2.5 row R-RT-1](#25-producer-audit-binding-list), [§3 commit 2b step 2](#commit-2b--producer-stamping-coverage-across-every-agentmessage-writer).                                                                                                                                                                                                                                                                                                |
| 1c | Cover the analyst path. Reviewer accepted either routing the analyst writer through the shared persistence/round-stamping API **or** giving `AnalystHandler` an `ActiveRuntime`-backed `SessionRoundState` contract per analysis §5.2. Plan r2 picks **option A**: delete the duplicate `appendMessage(...)` helper at [src/agents/analyst-handler.ts L81](../../../src/agents/analyst-handler.ts#L81) and route every callsite through `session-persistence.appendMessage(...)`. | [§2.5 rows R-AN-1..R-AN-12](#25-producer-audit-binding-list), [§3 commit 2b step 1](#commit-2b--producer-stamping-coverage-across-every-agentmessage-writer).                                                                                                                                                                                                                                                                                       |
| 1d | Cover synthetic planner notes in [src/agents/analyst-stage6.ts L108](../../../src/agents/analyst-stage6.ts#L108).                                                                                                                               | [§2.5 row R-S6-1](#25-producer-audit-binding-list), [§3 commit 2b step 3](#commit-2b--producer-stamping-coverage-across-every-agentmessage-writer).                                                                                                                                                                                                                                                                                                |
| 1e | Cover fake-agent fixture `tool_call` appends in [src/agents/fake-agent.ts L80](../../../src/agents/fake-agent.ts#L80).                                                                                                                          | [§2.5 row R-FK-1](#25-producer-audit-binding-list), [§3 commit 2b step 4](#commit-2b--producer-stamping-coverage-across-every-agentmessage-writer).                                                                                                                                                                                                                                                                                                |
| 1f | Cover stale-session failure diagnostic at [src/agents/session-persistence.ts L178](../../../src/agents/session-persistence.ts#L178) (`failActiveWorkerSessions`).                                                                                | [§2.5 row R-SP-1](#25-producer-audit-binding-list), [§3 commit 2b step 5](#commit-2b--producer-stamping-coverage-across-every-agentmessage-writer).                                                                                                                                                                                                                                                                                                |
| 1g | Cover [appendActivateCardToolResultOnce(...)](../../../src/agents/session-persistence.ts#L388) (helper-created tool results) and the two existing callsites in `runtime.ts` L205 / L250.                                                        | [§2.5 rows R-SP-2 and R-RT-2 / R-RT-3](#25-producer-audit-binding-list), [§3 commit 2b step 6](#commit-2b--producer-stamping-coverage-across-every-agentmessage-writer).                                                                                                                                                                                                                                                                            |
| 1h | Cover manual `AgentMessage` records and `replaceSessionMessages(...)` in [src/agents/compaction.ts L141-L194](../../../src/agents/compaction.ts#L141-L194); make the manual records use `stampCompacted(...)` / `r-compacted-N` consistently; define whether rewritten kept messages are restamped or preserved. | [§2.5 row R-CP-1](#25-producer-audit-binding-list), [§3 commit 2b step 7](#commit-2b--producer-stamping-coverage-across-every-agentmessage-writer), [§2.6 (kept-entries policy)](#26-compaction-stamping-policy).                                                                                                                                                                                                                                       |
| 1i | Cover every remaining `agent-adapter.ts` `appendMessage(...)` callsite beyond L376 (the recovery / force-final-answer / synthesised-planner-envelope / model_recovered / etc. paths at L346, L347, L353, L365, L386, L407, L412, L453, L454, L473, L488, L499, L505, L510, L515, L522, L527, and the in-flight `for (const msg of toolMessages) appendMessage(...)` loop at L386). | [§2.5 rows R-AD-1..R-AD-N](#25-producer-audit-binding-list), [§3 commit 2b step 8](#commit-2b--producer-stamping-coverage-across-every-agentmessage-writer).                                                                                                                                                                                                                                                                                        |
| 2  | Backend tests that fail if analyst messages, compaction records, runtime resume context, fake-agent appends, or helper-created tool results are missing the required stamp fields.                                                              | [§2.1](#21-added) (added test files), [§3 commit 2b step 9](#commit-2b--producer-stamping-coverage-across-every-agentmessage-writer), [§5.1](#51-per-commit-validation-root--web-where-applicable) (schema-canary fixture round-trip).                                                                                                                                                                                                              |
| 3  | The five accepted axes (wire migration, frontend order, store-machinery deletion, AnalystChatPanel chip swap, mostly-comprehensive tests, realistic rollback) are unchanged from r1; the `grep | wc -l` test-count check in commit 8 is downgraded to a reviewer aid only, not a CI gate.                                                                                                              | [§3 commits 3–8](#3-step-by-step-commits) restated verbatim from r1 except for the test-count language in [§3 commit 8](#commit-8--remaining-tests).                                                                                                                                                                                                                                                                                                |

Everything not listed above is reproduced **by reference** from r1
and applies unchanged. Sections marked "unchanged from r1" below
are byte-equivalent; sections marked "modified" call out the diff.

---

## 1. Preconditions

Unchanged from [r1 §1](03-plan-r1.md#1-preconditions). Same seven
gates (F02 r2 landed; F05 r3 landed; F01 r2 tokens; clean tree;
backend HEAD green; `saivage-v3` container at `10.0.3.112:8080`
healthy; no in-flight session on disk).

---

## 2. Files

### 2.1 Added

Reproduces the r1 §2.1 list verbatim, then adds the test files
required by the binding critique (§0 row 2 — one new test file
per uncovered producer / call path). The "Source of contract"
column for the new rows points at design §4.3 (callsite table) and
analysis §5.2 (round-stamping contract).

| Path                                                                  | Owner | Source of contract                                                          |
| --------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------- |
| `src/agents/round-id.ts`                                              | F03   | design §3.2 (server-side mirror of the web parser; the **only** allowed producer of `round_id` strings) |
| `src/__tests__/agents/round-id.test.ts`                               | F03   | design §11.1 (parser + grammar)                                             |
| `src/__tests__/agents/agent-adapter.tool-call-id.test.ts`             | F03   | design §11.1                                                                |
| `src/__tests__/agents/session-persistence.round-stamp.test.ts`        | F03   | design §11.1; covers `appendMessage` arity + `recordAppend` + helper paths   |
| `src/__tests__/agents/agent-adapter.all-callsites.test.ts`            | F03   | **new in r2** — asserts every `agent-adapter.ts` callsite catalogued in §2.5 rows R-AD-* writes records that pass `agentMessageSchema.parse`, with the expected stamp source per design §4.3 |
| `src/__tests__/agents/analyst-handler.stamping.test.ts`               | F03   | **new in r2** — analyst path stamps user / assistant / tool_call / tool_result correctly through shared `appendMessage` (§0 row 1c) |
| `src/__tests__/agents/analyst-stage6.stamping.test.ts`                | F03   | **new in r2** — synthetic planner-note appends carry the planner-side round stamp (§0 row 1d) |
| `src/__tests__/agents/fake-agent.stamping.test.ts`                    | F03   | **new in r2** — fixture `tool_call` writer stamps via `stampInRound` and persists `tool_call_id` (§0 row 1e) |
| `src/__tests__/agents/session-persistence.stale-failure.test.ts`      | F03   | **new in r2** — `failActiveWorkerSessions` writes a `model_issue` carrying a `stampPre` round stamp (§0 row 1f) |
| `src/__tests__/agents/session-persistence.activate-card.test.ts`      | F03   | **new in r2** — `appendActivateCardToolResultOnce` and its two `runtime.ts` callers stamp the planner round correctly (§0 row 1g) |
| `src/__tests__/agents/compaction.stamping.test.ts`                    | F03   | **new in r2** — compaction summary carries `r-compacted-N`; kept-entries preserve original stamps; rewritten file passes `agentMessageSchema.parse` end-to-end (§0 row 1h, §2.6) |
| `src/__tests__/runtime/runtime.resume-context.test.ts`                | F03   | **new in r2** — `runtime.ts` planner-resume context append carries a round stamp produced by `stampUserMessage` (§0 row 1b) |
| `src/__tests__/runtime/active-runtime-activity.test.ts`               | F03   | design §11.1                                                                |
| `src/__tests__/server/routes/conversation.test.ts`                    | F03   | design §11.1                                                                |
| `web/src/utils/agent-timeline/types.ts`                               | F03   | design §3.1                                                                 |
| `web/src/utils/agent-timeline/round-id.ts`                            | F03   | design §3.2                                                                 |
| `web/src/utils/agent-timeline/timeline.ts`                            | F03   | design §3.4                                                                 |
| `web/src/utils/agent-timeline/index.ts`                               | F03   | barrel; design §3                                                           |
| `web/src/composables/useAgentTimeline.ts`                             | F03   | design §6                                                                   |
| `web/src/components/conversation/ToolChip.vue`                        | F03   | design §7.2                                                                 |
| `web/src/components/conversation/RoundCard.vue`                       | F03   | design §7.3                                                                 |
| `web/src/components/conversation/DiagnosticRow.vue`                   | F03   | design §7.4                                                                 |
| `web/src/components/conversation/PendingCallFooter.vue`               | F03   | design §7.5                                                                 |
| `web/src/components/conversation/CompactedCluster.vue`                | F03   | design §7.6                                                                 |
| `web/src/components/conversation/ContextBlock.vue`                    | F03   | design §7.7                                                                 |
| `web/src/components/chat/tool-chip-adapter.ts`                        | F03 (binding of F04 design r2 §1.10) | F04 design r2 §1.10                                  |
| `web/src/__tests__/utils/agent-timeline/round-id.test.ts`             | F03   | design §11.1                                                                |
| `web/src/__tests__/utils/agent-timeline/timeline.test.ts`             | F03   | design §11.1                                                                |
| `web/src/__tests__/composables/useAgentTimeline.test.ts`              | F03   | design §11.1                                                                |
| `web/src/__tests__/stores/agents-conversation.test.ts`                | F03   | design §11.1                                                                |
| `web/src/__tests__/conversation/ToolChip.test.ts`                     | F03   | design §11.1 (R4 gates)                                                     |
| `web/src/__tests__/conversation/PendingCallFooter.test.ts`            | F03   | design §11.1                                                                |
| `web/src/__tests__/chat/tool-chip-adapter.test.ts`                    | F03   | F04 design r2 §1.13                                                         |

### 2.2 Modified

Reproduces r1 §2.2 with the additions from §0 rows 1b–1i.

| Path                                                       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Source                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `src/schemas/types.ts`                                     | `AgentMessage` widened with required `round_id: string`, `message_index: number`, `block_index: number`, optional `tool_call_id`, `model_spec`, `requested_model_spec`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | design §4.1                          |
| `src/schemas/validators.ts`                                | `agentMessageSchema` adds `roundIdGrammar` regex and `superRefine` for `MAX_SAFE_INTEGER` bound and `tool_call_id` scalar on `tool_call` / `tool_result` / `tool_error`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | design §4.1                          |
| `src/runtime/active-runtime.ts`                            | Adds `SessionRoundState`, `RoundStamp`, `PendingCall`, `ActivityStatus`, `SessionActivity`; methods `openAssistantRound`, `stampInRound`, `stampUserMessage`, `stampPre`, `stampCompacted`, `stampDiagnosticInCurrentRound`, `closeRound`, `rebuildSessionRoundState`, `getActivityStatus`, `recordAppend`; event-bus subscriptions for `session_started`, `model_selected`, `invocation_succeeded`, `invocation_failed`, `retry_attempted`, `session_cancelled`, `session_force_cancelled`                                                                                                                                                                                                  | design §2.1, §4.2                    |
| `src/agents/session-persistence.ts`                        | `appendMessage` signature widens to require round-stamp fields; assembles record, asserts stamp present, calls `agentMessageSchema.parse`, writes JSONL, calls `activeRuntime.recordAppend`; old arity is the only one — no overload, no default value. `failActiveWorkerSessions` (L178) is rewritten per §0 row 1f to pull a `stampPre(sessionId)` stamp from `activeRuntime` before the diagnostic append. `appendActivateCardToolResultOnce` (L388) accepts an explicit `RoundStamp` argument and forwards it; the two existing callers in `runtime.ts` L205 and L250 are updated.                                                                                                          | design §4.3; §0 rows 1f / 1g         |
| `src/agents/agent-adapter.ts`                              | **Every** `appendMessage(...)` callsite (L346, L347, L353, L365, L376, L386 loop, L407, L412, L453, L454 closure, L473, L488, L499, L505, L510, L515, L522, L527 — full catalogue in §2.5 rows R-AD-*) pulls a `RoundStamp` from `activeRuntime` per the design §4.3 table; the assistant `tool_call` persistence at L376 stamps the scalar `tool_call_id: tc.id`; the `for (const msg of toolMessages) appendMessage(...)` loop at L386 stamps each line via `stampInRound` (because tool results belong to the current assistant turn); the `persistFailure` closure at L454 calls `stampDiagnosticInCurrentRound`. Round close happens at the end of the turn via `activeRuntime.closeRound(sessionId)`. | design §2.2, §4.3; §0 row 1i         |
| `src/agents/analyst-handler.ts`                            | **Per §0 row 1c (option A)**: the local `function appendMessage(...)` at L81–L90 and the local `function readMessages(...)` at L72–L80 are **deleted**. Every callsite at L245, L251, L260, L273, L280, L290, L357, L363, L371, L375, L410, L414 is rewritten to call `session-persistence.appendMessage(this.saivageDir, sessionId, { ..., ...activeRuntime.<stampSource>(sessionId) })`. The stamp source per row is documented in §2.5 rows R-AN-1..R-AN-12. `AnalystHandler` receives the `ActiveRuntime` instance via its constructor (the constructor signature is widened in this commit — no default-instance fallback, no `?` parameter). The injection update is mechanical at the one call site in `src/agents/index.ts` (factory). | design §2.1, §4.3; §0 row 1c         |
| `src/agents/analyst-stage6.ts`                             | `injectQueuedSyntheticPlannerNotes` (L108) takes an `ActiveRuntime` argument and stamps the append via `activeRuntime.stampUserMessage(plannerSessionId)`. The single caller (`agent-adapter.ts` L270) passes the existing `this.activeRuntime`.                                                                                                                                                                                                                                                                                                                                                                                                                                            | design §4.3; §0 row 1d               |
| `src/agents/fake-agent.ts`                                 | The fixture `tool_call` append at L80 stamps via `activeRuntime.stampInRound(persistedSessionId)`; the existing `tool: 'activate_card'` and `tool_call_id` (added if missing; the fixture currently relies on `parseToolCalls` to recover the id from content — that is now disallowed by the schema canary) are persisted as scalars on each per-call append, mirroring the agent-adapter rewrite. The fake agent receives `activeRuntime` via its constructor.                                                                                                                                                                                                                              | design §2.2, §4.3; §0 row 1e         |
| `src/runtime/runtime.ts`                                   | Three changes: (a) the planner-resume context append at L401 takes a `stampUserMessage(plannerSessionId)` stamp (§0 row 1b); (b) the two `appendActivateCardToolResultOnce(...)` callers at L205 and L250 forward a `stampInRound(plannerSessionId)` stamp; (c) the call to `injectQueuedSyntheticPlannerNotes` chain is unchanged but it now travels `activeRuntime` end-to-end (§0 row 1d wiring).                                                                                                                                                                                                                                                                                          | design §4.3; §0 rows 1b / 1g / 1d    |
| `src/agents/compaction.ts`                                 | The manual `summaryMsg` `AgentMessage` literal at L141–L156 is replaced with a `session-persistence.appendMessage(...)`-equivalent record whose round stamp comes from `activeRuntime.stampCompacted(sessionId)` (yielding `round_id = r-compacted-${state.count + 1}`). `replaceSessionMessages(...)` is the only writer of compacted history; it now rewrites the file from the **kept-stamp** policy in §2.6 (kept slice preserves original stamps; new summary at the head carries `r-compacted-N`). `agentMessageSchema.parse` runs on every line before disk write (this is added as a guard inside `replaceSessionMessages` because architecture-first deletes the implicit-trust assumption). The `compactSession(...)` signature widens to accept `activeRuntime`. | design §4.3; §0 row 1h; §2.6         |
| `src/server/routes/runtime-config-notes.ts`                | Conversation handler at L115 rewritten: response is `{ session, entries, activity_status }`; helper renamed `readAgentMessages` → `readConversationEntries`; each JSONL line parsed through `agentMessageSchema.parse`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | design §4.4                          |
| `src/server/websocket.ts`                                  | `thinking` and `activity` envelopes carry `{ sessionId, entry, activity_status }`; legacy `content.message` key removed (no alias)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | design §2.4, §4.5                    |
| `web/src/api/types.ts`                                     | `AgentConversationResponse.messages` removed; `AgentMessage` interface renamed to `ConversationEntry` in place; `ActivityStatus`, `PendingCall` exports added; `AgentConversationResponse` becomes `{ session, entries, activity_status }`                                                                                                                                                                                                                                                                                                                                                                                                                                                    | design §2.3, §10                     |
| `web/src/stores/agents.ts`                                 | `MessageStep` interface and `groupIntoSteps()` function deleted (L30-L76); `messages`, `steps` (computed), `expandedToolCalls` refs deleted; new state `entries`, `activityStatus`; new actions `appendEntry`, `setActivityStatus`, `refreshConversation`, `bindWs` per design §9; WS handlers piggyback on `thinking` and `activity` envelopes only                                                                                                                                                                                                                                                                                                                                          | design §9, §10                       |
| `web/src/components/agents/AgentConversationView.vue`      | Legacy flat-step template deleted; rewritten as a thin store container that calls `useAgentTimeline(store.entries, store.activityStatus, () => store.currentSession?.id ?? null)` and renders the timeline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | design §7, §10                       |
| `web/src/components/chat/AnalystChatPanel.vue`             | In-line `<button class="tool-chip">` markup deleted; local `ChipParts` interface deleted; scoped `.tool-chip*` rules deleted; chip rendered as `<ToolChip v-bind="adaptChatMessageToToolChip(...)" @toggle="…" />` for paired chat messages and `<ToolChip v-bind="adaptPendingInvocationToToolChip(p, ...)" @toggle="…" />` for pending invocations                                                                                                                                                                                                                                                                                                                                          | design §8.2; F04 design r2 §1.10     |
| `src/agents/index.ts`                                      | Factory injection sites for `AnalystHandler`, `FakeAgent`, and `AgentAdapter` updated to pass the existing `ActiveRuntime` instance (the constructor parameter is required, not optional, per §0 row 1c). No call sites outside `src/agents/index.ts` construct these classes; the injection update is mechanical.                                                                                                                                                                                                                                                                                                                                                                          | §0 rows 1c, 1d, 1e                   |
| `web/src/__tests__/agents-store.test.ts`                   | Flat-step cases removed; the file is renamed to `agents-conversation.test.ts` (added in §2.1). The original file is **deleted**, not edited; see §2.3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | design §11.1                         |

### 2.3 Deleted

Unchanged from r1 §2.3, plus two new rows for the analyst-handler
duplicate-helper deletion (§0 row 1c) and the fake-agent / compaction
manual literals.

| Path                                                                                                                                                          | Reason                                                                                                                                                                                                       | Source                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `web/src/__tests__/agents-store.test.ts` (flat-step shape)                                                                                                    | Replaced wholesale by `web/src/__tests__/stores/agents-conversation.test.ts` (added in §2.1); no overlap of test names                                                                                       | design §10, §11.1                  |
| In-line `<button class="tool-chip*">`, local `ChipParts` interface, and scoped `.tool-chip*` rules inside `web/src/components/chat/AnalystChatPanel.vue`      | Replaced by `<ToolChip>` + `tool-chip-adapter.ts` (§2.1)                                                                                                                                                      | design §8.2, §10                   |
| `MessageStep`, `groupIntoSteps()`, `messages`, `steps`, `expandedToolCalls` from `web/src/stores/agents.ts`                                                   | Replaced by `entries` + `useAgentTimeline`                                                                                                                                                                    | design §9, §10                     |
| Legacy template body of `web/src/components/agents/AgentConversationView.vue`                                                                                 | Replaced by RoundCard-driven template                                                                                                                                                                         | design §10                         |
| Legacy `appendMessage` arity (without round-stamp fields) in `src/agents/session-persistence.ts`                                                              | Replaced by the new arity — the only one (no overload, no default)                                                                                                                                            | design §4.3, §10                   |
| Legacy WS envelope key `content.message` in `src/server/websocket.ts`                                                                                         | Replaced by `content.entry`                                                                                                                                                                                   | design §2.4, §10                   |
| `AgentConversationResponse.messages` field and the `AgentMessage` alias in `web/src/api/types.ts`                                                             | Replaced by `entries: ConversationEntry[]` and the renamed `ConversationEntry` interface                                                                                                                      | design §2.3, §10                   |
| **NEW in r2:** the local `function appendMessage(...)` at [src/agents/analyst-handler.ts L81–L90](../../../src/agents/analyst-handler.ts#L81) and the local `function readMessages(...)` at L72–L80 | Replaced by direct calls to `session-persistence.appendMessage(...)` / `getSessionMessages(...)`. The duplicate writer is the architectural defect the binding critique calls out (§0 row 1c).                | §0 row 1c                          |
| **NEW in r2:** the manual `AgentMessage` literal at [src/agents/compaction.ts L141–L156](../../../src/agents/compaction.ts#L141) (`summaryMsg` constructed inline) | Replaced by a record built through the shared `session-persistence.appendMessage(...)` writer with a `stampCompacted(sessionId)` stamp — only one writer, only one canary. `replaceSessionMessages(...)` is unchanged in arity but now parses every line through `agentMessageSchema` before disk write (§2.2). | §0 row 1h                          |

### 2.4 Renamed

Unchanged from r1 (none beyond the wire-types in-place rename
called out in §2.2).

### 2.5 Producer audit (binding list)

This list is the binding inventory the reviewer required (§0 row
1a). Every entry must (a) write through the shared
`session-persistence.appendMessage(...)` arity and (b) supply a
`RoundStamp` from `activeRuntime.<stampSource>(...)`. Commit 2b
must reach zero unstamped producers; the per-commit
verification grep in §3 commit 2b step 10 enforces this.

Discovery command (must be re-run at the end of commit 2b and
return zero hits outside the inventory):

```sh
rg -n "appendMessage\(|AgentMessage =|agentMessageSchema.parse|replaceSessionMessages\(|appendActivateCardToolResultOnce" src/
```

| ID    | File: Line                                       | Producer                                                              | Stamp source on rewrite                                       | Notes                                                                                                                                                                                              |
| ----- | ------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-SP-1 | [session-persistence.ts L178](../../../src/agents/session-persistence.ts#L178)   | `failActiveWorkerSessions` — `model_issue` diagnostic on stale active session | `activeRuntime.stampPre(sessionId)`                            | Stale-session diagnostic is a pre-thread system event (the session is being failed; no current round). Test: `session-persistence.stale-failure.test.ts`.                                          |
| R-SP-2 | [session-persistence.ts L388–L401](../../../src/agents/session-persistence.ts#L388) | `appendActivateCardToolResultOnce` — `tool_result` for `activate_card` reconciliation | parameter (caller supplies)                                    | The helper itself is content-free; the **caller** in `runtime.ts` chooses the stamp (`stampInRound` because the result belongs to the current planner turn). Test: `session-persistence.activate-card.test.ts`. |
| R-RT-1 | [runtime.ts L401](../../../src/runtime/runtime.ts#L401)                          | Planner-resume goal-context block on goal pickup                       | `activeRuntime.stampUserMessage(plannerSessionId)`             | Resume context is delivered as a user-role message that opens a new tier-1 round; see analysis §5.2. Test: `runtime.resume-context.test.ts`.                                                       |
| R-RT-2 | [runtime.ts L205](../../../src/runtime/runtime.ts#L205)                          | `appendActivateCardToolResultOnce` call site for normal card activation | `activeRuntime.stampInRound(plannerSessionId)`                 | Result of an in-flight `activate_card` tool call; the round is the assistant turn that emitted the call. Covered by `session-persistence.activate-card.test.ts`.                                   |
| R-RT-3 | [runtime.ts L250](../../../src/runtime/runtime.ts#L250)                          | `appendActivateCardToolResultOnce` call site for restart-repair card activation | `activeRuntime.stampInRound(plannerSessionId)`                 | Same shape as R-RT-2; the synthesised repair result is logically inside the planner's last assistant round. Covered by `session-persistence.activate-card.test.ts`.                                  |
| R-S6-1 | [analyst-stage6.ts L108](../../../src/agents/analyst-stage6.ts#L108)             | Synthetic planner note from analyst → planner channel                  | `activeRuntime.stampUserMessage(plannerSessionId)`             | Opens (or extends) a tier-1 user round in the planner session. Test: `analyst-stage6.stamping.test.ts`.                                                                                            |
| R-FK-1 | [fake-agent.ts L80](../../../src/agents/fake-agent.ts#L80)                       | Fixture-driven `tool_call` append for `activate_card`                  | `activeRuntime.stampInRound(persistedSessionId)`               | The fake agent appends `tool_call` records during its simulated turn; round id must match the simulated assistant round (each fixture turn is opened via `openAssistantRound` at the top of the fake agent's `runOnce` body — explicitly added in commit 2b step 4). Test: `fake-agent.stamping.test.ts`. |
| R-CP-1 | [compaction.ts L141–L194](../../../src/agents/compaction.ts#L141)                | Manual `summaryMsg` literal + `replaceSessionMessages(...)` rewrite     | `activeRuntime.stampCompacted(sessionId)` for the summary head; **kept entries preserve original stamps** (see §2.6) | Test: `compaction.stamping.test.ts`.                                                                                                                                                                |
| R-AD-1 | [agent-adapter.ts L346](../../../src/agents/agent-adapter.ts#L346)               | `model_issue` "Forcing final-answer turn without tools"                | `activeRuntime.stampDiagnosticInCurrentRound(sessionId)`        | Diagnostic stays inside the active assistant round. Test: `agent-adapter.all-callsites.test.ts`.                                                                                                   |
| R-AD-2 | [agent-adapter.ts L347](../../../src/agents/agent-adapter.ts#L347)               | `user` text "force final answer" prompt                                 | `activeRuntime.stampUserMessage(sessionId)`                     | Synthetic user prompt opens a new tier-1 round. Same test file.                                                                                                                                    |
| R-AD-3 | [agent-adapter.ts L353](../../../src/agents/agent-adapter.ts#L353)               | `model_issue` "forceFinalAnswer LLM call failed"                       | `activeRuntime.stampDiagnosticInCurrentRound(sessionId)`        |                                                                                                                                                                                                     |
| R-AD-4 | [agent-adapter.ts L365](../../../src/agents/agent-adapter.ts#L365)               | `model_issue` "Repeated tool-call fingerprint"                          | `activeRuntime.stampDiagnosticInCurrentRound(sessionId)`        |                                                                                                                                                                                                     |
| R-AD-5 | [agent-adapter.ts L376](../../../src/agents/agent-adapter.ts#L376)               | `tool_call` loop                                                        | `activeRuntime.stampInRound(sessionId)` + `tool_call_id: tc.id` | Already covered by r1 design §2.2; restated here for completeness.                                                                                                                                  |
| R-AD-6 | [agent-adapter.ts L386 loop](../../../src/agents/agent-adapter.ts#L386)           | `for (const msg of toolMessages) appendMessage(...)` — tool results / errors | `activeRuntime.stampInRound(sessionId)`                         | Tool results belong to the same assistant round that emitted the call.                                                                                                                              |
| R-AD-7 | [agent-adapter.ts L407](../../../src/agents/agent-adapter.ts#L407)               | `model_issue` "Synthesised planner BLOCKED envelope"                   | `activeRuntime.stampDiagnosticInCurrentRound(sessionId)`        |                                                                                                                                                                                                     |
| R-AD-8 | [agent-adapter.ts L412](../../../src/agents/agent-adapter.ts#L412)               | `model_issue` "Synthesised planner continuation envelope"               | `activeRuntime.stampDiagnosticInCurrentRound(sessionId)`        |                                                                                                                                                                                                     |
| R-AD-9 | [agent-adapter.ts L453](../../../src/agents/agent-adapter.ts#L453)               | Context-message ingest loop (system/user) at session bootstrap          | `activeRuntime.stampPre(sessionId)` (the first time) then `activeRuntime.stampUserMessage(sessionId)` (subsequent user-message anchors) | The loop already differentiates message origin; the dispatcher in commit 2b step 8 picks the stamp per entry kind. Test: `agent-adapter.all-callsites.test.ts`.                                     |
| R-AD-10 | [agent-adapter.ts L454 closure](../../../src/agents/agent-adapter.ts#L454)        | `persistFailure` closure inside the recovery-options builder            | `activeRuntime.stampDiagnosticInCurrentRound(sessionId)`        | Closure captures `session.id` and the active runtime; the stamp is read at append time so the round in flight at the moment of failure is used.                                                     |
| R-AD-11 | [agent-adapter.ts L473](../../../src/agents/agent-adapter.ts#L473)                | `model_recovered` directive write                                       | `activeRuntime.stampDiagnosticInCurrentRound(sessionId)`        |                                                                                                                                                                                                     |
| R-AD-12 | [agent-adapter.ts L488](../../../src/agents/agent-adapter.ts#L488)                | Final assistant text (success path)                                     | `activeRuntime.stampInRound(sessionId)` then `activeRuntime.closeRound(sessionId)` | Closes the assistant round after the final text is persisted.                                                                                                                                       |
| R-AD-13 | [agent-adapter.ts L499](../../../src/agents/agent-adapter.ts#L499)                | `model_issue` "bare {toolCalls} content" diagnostic                     | `activeRuntime.stampDiagnosticInCurrentRound(sessionId)`        |                                                                                                                                                                                                     |
| R-AD-14 | [agent-adapter.ts L505](../../../src/agents/agent-adapter.ts#L505)                | Final assistant text after toolCalls-envelope recovery                  | `activeRuntime.stampInRound(sessionId)`                         |                                                                                                                                                                                                     |
| R-AD-15 | [agent-adapter.ts L510](../../../src/agents/agent-adapter.ts#L510)                | Executor fallback `model_issue` after recovery parse failure            | `activeRuntime.stampDiagnosticInCurrentRound(sessionId)`        |                                                                                                                                                                                                     |
| R-AD-16 | [agent-adapter.ts L515](../../../src/agents/agent-adapter.ts#L515)                | `model_issue` "Self-check acknowledged…"                                | `activeRuntime.stampDiagnosticInCurrentRound(sessionId)`        |                                                                                                                                                                                                     |
| R-AD-17 | [agent-adapter.ts L522](../../../src/agents/agent-adapter.ts#L522)                | Final assistant text after self-check recovery                          | `activeRuntime.stampInRound(sessionId)`                         |                                                                                                                                                                                                     |
| R-AD-18 | [agent-adapter.ts L527](../../../src/agents/agent-adapter.ts#L527)                | Executor fallback `model_issue` after self-check parse failure          | `activeRuntime.stampDiagnosticInCurrentRound(sessionId)`        |                                                                                                                                                                                                     |
| R-AN-1..R-AN-12 | [analyst-handler.ts L245, L251, L260, L273, L280, L290, L357, L363, L371, L375, L410, L414](../../../src/agents/analyst-handler.ts) | Twelve analyst writers (user / assistant text / tool_call / tool_result / contract / offline / no-progress / final-text)         | `stampUserMessage` for the user append (L245); `openAssistantRound` for the first assistant text per turn (the earliest of L251/L260/L273/L280/L290/L357/L363/L371/L375); `stampInRound` for subsequent assistant entries within the same turn; `stampInRound` + `tool_call_id` for the L375 tool_call append; `stampInRound` + `tool_call_id` for L410 tool_result append; `closeRound` after L363/L371/L414 (the three terminal assistant paths). | The exact stamp selector is implemented by a small `stampForKind(kind, position)` helper inside `analyst-handler.ts` so the twelve callsites stay readable. Test: `analyst-handler.stamping.test.ts`. |

### 2.6 Compaction stamping policy

**Kept entries:** when compaction rewrites the JSONL file via
`replaceSessionMessages(...)`, every entry inherited from the
pre-compaction window **preserves its original stamp** (`round_id`,
`message_index`, `block_index`, `tool_call_id`, `model_spec`,
`requested_model_spec`). Rationale: those entries are still the
authoritative producer-stamped history of the prior rounds; rewriting
their stamps would (a) re-key tier-1 / tier-2 rounds against the
new (post-compaction) session length and (b) break the
client-side bucket boundary the user already sees in the timeline.

**Summary head:** the synthesised summary entry written by
`compactSession(...)` carries
`round_id = r-compacted-${state.count + 1}` from
`activeRuntime.stampCompacted(sessionId)`,
`message_index = 0` (a compacted summary is always at position 0 of
the rewritten file), `block_index = 0`,
`tool_call_id = undefined`, `model_spec = undefined` (the summary
is system-authored, not model-authored).

**Tier 3 bucketing on the client:** the
`web/src/utils/agent-timeline/round-id.ts` parser maps
`r-compacted-N` to tier 3, which the timeline reducer renders as a
`CompactedCluster` item (analysis §1.5). No client change is
needed because the policy emits exactly the wire shape the
existing utility expects.

**Schema canary:** `replaceSessionMessages(...)` runs
`agentMessageSchema.parse(...)` on every line before writing the
file. This is the new architecture-first guard: a producer that
forgets to stamp the summary head, or that drops a stamp field
during compaction reconstruction, fails the write rather than
poisoning the on-disk JSONL silently.

---

## 3. Step-by-step commits

Same eight-commit shape as r1 except commit 2 splits into **2a**
(types / schema / `ActiveRuntime` extension and the producer
contract surface) and **2b** (the producer-by-producer stamping
rewrite). The split keeps each commit's review surface tractable
and lets CI run the schema canary against partially-stamped
producers in 2b before merge.

Per-commit shape (modified rows from §0 row 3):

| #  | Title                                                                    | Compiles (root)        | Compiles (web)         | Tests added                                                                                                                                                                                              |
| -- | ------------------------------------------------------------------------ | ---------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | ActiveRuntime round counters + activity status                            | ✔                      | ✔                      | runtime/active-runtime-activity                                                                                                                                                                          |
| 2a | AgentMessage widen + schema canary + persistence-only rewrite             | ✔ (additive; producers still type-compile because the schema is widened only at write time via `superRefine`; see step list) | ✔                      | agents/round-id, agents/session-persistence.round-stamp                                                                                                                                                  |
| 2b | Producer stamping coverage across every `AgentMessage` writer             | ✔                      | ✔                      | agents/agent-adapter.tool-call-id, agents/agent-adapter.all-callsites, agents/analyst-handler.stamping, agents/analyst-stage6.stamping, agents/fake-agent.stamping, agents/session-persistence.stale-failure, agents/session-persistence.activate-card, agents/compaction.stamping, runtime/runtime.resume-context |
| 3  | Server route + WS envelope + wire-types rename                            | ✔                      | ✖ (intentional)        | server/routes/conversation                                                                                                                                                                                |
| 4  | agent-timeline + useAgentTimeline                                         | ✔                      | ✖ (intentional)        | utils/agent-timeline/round-id, utils/agent-timeline/timeline, composables/useAgentTimeline                                                                                                                |
| 5  | Conversation components                                                   | ✔                      | ✖ (intentional)        | conversation/ToolChip, conversation/PendingCallFooter                                                                                                                                                     |
| 6  | AnalystChatPanel chip swap                                                | ✔                      | ✖ (intentional)        | chat/tool-chip-adapter                                                                                                                                                                                    |
| 7  | Delete legacy + rewrite view                                              | ✔                      | ✔                      | —                                                                                                                                                                                                         |
| 8  | Remaining tests                                                           | ✔                      | ✔                      | stores/agents-conversation + stragglers                                                                                                                                                                   |

### Commit 1 — Backend round-stamping infrastructure

Unchanged from [r1 §3 commit 1](03-plan-r1.md#commit-1--backend-round-stamping-infrastructure).
Same scope (`ActiveRuntime` types and methods, `src/agents/round-id.ts`,
`runtime/active-runtime-activity.test.ts`), same verification
greps. The constructor wiring for the seven event-bus topics is
identical; no producer is using the new methods at this point.

### Commit 2a — Types, schema, persistence shell

Scope: introduces the widened `AgentMessage` type, the
`agentMessageSchema` `superRefine` canary, the new
`session-persistence.appendMessage(...)` arity, the
`appendActivateCardToolResultOnce(...)` widened signature
(parameter-supplied `RoundStamp`), and the
`replaceSessionMessages(...)` per-line schema-parse guard. **No**
producer is rewritten in this commit — the producer rewrite is
2b. The schema canary is therefore active at write time but the
existing producer callsites have not yet been updated; **2a does
not run the full test suite** (only the schema / persistence unit
tests added in this commit). Root typecheck still passes because
the new persistence arity is required on call but producers in
their pre-rewrite state still satisfy the **TypeScript** signature
(the `RoundStamp` fields are required object fields, not optional
— so any producer left unchanged fails to compile, which is the
exact point of the split: commit 2b becomes the smallest atomic
slice that restores root typecheck).

> **Architecture-first note.** Commits 2a and 2b are intended to
> land together as a single PR; they are split only so the review
> diff is reviewable. Per the project rule there is no "compat"
> period — root CI is required green at the tip of the PR (i.e.
> after 2b lands), not at the tip of 2a. The per-commit table
> above marks 2a as compiling for the **schema-and-persistence**
> subtree only; the **producer** subtree (`src/agents/agent-adapter.ts`,
> `src/agents/analyst-handler.ts`, `src/agents/analyst-stage6.ts`,
> `src/agents/fake-agent.ts`, `src/agents/compaction.ts`,
> `src/runtime/runtime.ts`) is allowed to fail typecheck only
> during the 2a → 2b interval and only on local feature branches;
> it is **not** acceptable on `main`.

Steps:

1. Edit `src/schemas/types.ts` per design §4.1.
2. Edit `src/schemas/validators.ts` per design §4.1 (regex +
   `superRefine`).
3. Rewrite `src/agents/session-persistence.ts` `appendMessage(...)`
   to the new arity (the only one); rewrite
   `replaceSessionMessages(...)` to parse each entry through
   `agentMessageSchema` before write; widen
   `appendActivateCardToolResultOnce(...)` to accept and forward a
   `RoundStamp` parameter (no default).
4. Add `src/__tests__/agents/round-id.test.ts`.
5. Add `src/__tests__/agents/session-persistence.round-stamp.test.ts`.

Verification:

- `npx tsc -p . --noEmit -- --files src/schemas src/agents/session-persistence.ts`
  succeeds (focused typecheck for the schema/persistence subtree).
- `npm test -- src/__tests__/agents/round-id.test.ts src/__tests__/agents/session-persistence.round-stamp.test.ts`
  passes.
- `grep -c 'appendMessage(' src/agents/session-persistence.ts`
  returns exactly 1 export (the new arity).

Commit message: `F03(backend): widen AgentMessage schema +
session-persistence stamp arity; canary on replaceSessionMessages`.

### Commit 2b — Producer stamping coverage across every `AgentMessage` writer

Scope: every callsite in §2.5 rows R-* migrates to the shared
persistence writer + per-row stamp source. The duplicate analyst
helper is deleted. Root typecheck and all backend tests are green
at the tip of this commit.

Steps:

1. **Delete the duplicate analyst writer (§0 row 1c).**
   - Delete the local `function readMessages(...)` at
     [src/agents/analyst-handler.ts L72–L80](../../../src/agents/analyst-handler.ts#L72)
     and the local `function appendMessage(...)` at L81–L90.
   - Add `import { appendMessage, getSessionMessages } from
     './session-persistence.js';`.
   - Update every callsite (L245, L251, L260, L273, L280, L290,
     L357, L363, L371, L375, L410, L414) per §2.5 rows R-AN-1..R-AN-12.
     A small inline helper `stampForKind(kind, position)` (5–10
     lines, inside `analyst-handler.ts`) selects between
     `stampUserMessage`, `openAssistantRound`, `stampInRound`, and
     `closeRound` based on the position within the turn loop.
   - Widen `AnalystHandler`'s constructor to take `activeRuntime:
     ActiveRuntime` (required; no default). Update the single
     factory site in `src/agents/index.ts` to pass the existing
     `ActiveRuntime` instance.
2. **Stamp planner-resume context (§0 row 1b).** Edit
   [src/runtime/runtime.ts L401](../../../src/runtime/runtime.ts#L401)
   to include `...this.activeRuntime.stampUserMessage(plannerSessionId)`
   in the `appendMessage(...)` call.
3. **Stamp synthetic planner notes (§0 row 1d).** Edit
   [src/agents/analyst-stage6.ts L108](../../../src/agents/analyst-stage6.ts#L108).
   `injectQueuedSyntheticPlannerNotes(...)` takes `activeRuntime:
   ActiveRuntime` as a required argument; stamp the append with
   `activeRuntime.stampUserMessage(plannerSessionId)`. Update the
   one caller in `src/agents/agent-adapter.ts` L270 to pass
   `this.activeRuntime`.
4. **Stamp fake-agent fixture appends (§0 row 1e).** Edit
   [src/agents/fake-agent.ts L80](../../../src/agents/fake-agent.ts#L80).
   At the top of the fixture turn loop, call
   `this.activeRuntime.openAssistantRound(persistedSessionId)`
   to open the simulated assistant round; stamp each per-call
   `appendMessage(...)` invocation with
   `this.activeRuntime.stampInRound(persistedSessionId)`; close
   the round with `this.activeRuntime.closeRound(persistedSessionId)`
   at the end of the loop. Widen `FakeAgent`'s constructor /
   factory in `src/agents/fake-agent.ts` and `src/agents/index.ts`
   to take `activeRuntime`. The fixture-emitted `tool_call`
   records carry the scalar `tool_call_id` directly (no longer
   relying on `parseToolCalls(content)` for the id).
5. **Stamp stale-session failure (§0 row 1f).** Edit
   [src/agents/session-persistence.ts L178](../../../src/agents/session-persistence.ts#L178)
   inside `failActiveWorkerSessions(...)`. Widen the function
   signature to accept `activeRuntime: ActiveRuntime`. Stamp the
   diagnostic append with `activeRuntime.stampPre(session.id)`.
   Update the caller (the runtime bootstrap path, which already
   holds `activeRuntime`) accordingly.
6. **Stamp `appendActivateCardToolResultOnce` callers (§0 row
   1g).** Edit `runtime.ts` L205 and L250 to compute
   `const stamp = this.activeRuntime.stampInRound(plannerSessionId);`
   and pass `stamp` as the new parameter introduced by 2a.
7. **Stamp compaction summary head and rewrite kept entries per
   §2.6 (§0 row 1h).** Edit
   [src/agents/compaction.ts L141–L194](../../../src/agents/compaction.ts#L141)
   to remove the manual `summaryMsg` literal; replace with
   construction through `session-persistence.appendMessage(...)`
   stamped by `activeRuntime.stampCompacted(sessionId)`. Widen
   `compactSession(...)` to accept `activeRuntime: ActiveRuntime`.
   The kept slice flowing into `replaceSessionMessages(...)`
   preserves original stamps (no rewrite); the new summary entry
   is prepended after stamping. The
   `replaceSessionMessages(...)` schema-parse guard added in 2a is
   the canary if any line drops a stamp.
8. **Stamp every `agent-adapter.ts` callsite (§0 row 1i).** Edit
   `agent-adapter.ts` to pass the per-row stamp from §2.5 rows
   R-AD-1..R-AD-18 at each callsite. Add the `closeRound` call at
   the end of every assistant-turn final-text path (R-AD-12 and
   the recovery branches R-AD-14, R-AD-17). The context-message
   ingest loop at L453 uses the per-entry dispatcher described in
   R-AD-9.
9. **Add the producer-stamping test suite (§0 row 2).** Add the
   nine test files listed in §2.1 ("**new in r2**" rows): one per
   producer / call path, each asserting (a) the stamp source the
   producer uses for each kind, (b) the resulting record passes
   `agentMessageSchema.parse`, and (c) the on-disk JSONL reads
   back through `getSessionMessages(...)` without throwing.
10. **Run the producer audit (§0 row 1a) and require zero unstamped
    producers.**
    - `rg -n "appendMessage\(|AgentMessage =|agentMessageSchema.parse|replaceSessionMessages\(|appendActivateCardToolResultOnce" src/`
      — every hit must be inside the §2.5 inventory or inside
      `src/__tests__/`. Reviewer aid: copy the list into the PR
      description, mark each hit against the inventory ID.
    - `rg -nP "appendMessage\([^)]*\)" src/ | rg -v "round_id|stampUserMessage|stampInRound|openAssistantRound|stampPre|stampCompacted|stampDiagnosticInCurrentRound|RoundStamp"`
      returns zero hits (every callsite supplies a stamp).
    - `rg -n "function appendMessage" src/agents/` returns
      exactly one match (the shared writer in
      `session-persistence.ts`). The previous duplicate in
      `analyst-handler.ts` is gone.

Verification:

- `npx tsc -p . --noEmit` (root, full tree) succeeds.
- `npm test -- src/__tests__/agents src/__tests__/runtime` passes
  (every new test file in step 9 + the activity-status test from
  commit 1 + the schema/persistence tests from 2a).
- The two `rg` greps in step 10 return the expected counts.
- `grep -c '<script' src/agents/*.ts src/runtime/*.ts` is not
  applicable (TS files, not SFC); the Vue-SFC guard kicks in for
  later commits.

Commit message: `F03(backend): every AgentMessage producer routes
through ActiveRuntime stamping; analyst duplicate writer deleted`.

### Commit 3 — Server route + WS envelope widening + wire-types rename

Unchanged from [r1 §3 commit 3](03-plan-r1.md#commit-3--server-route--ws-envelope-widening--wire-types-rename).
Mid-stack typecheck gap on `web/src/stores/agents.ts` is unchanged
and closes at commit 7. No producer change in this commit
(commit 2b already left every backend producer green).

### Commit 4 — UI shared utility + composable

Unchanged from [r1 §3 commit 4](03-plan-r1.md#commit-4--ui-shared-utility--composable).

### Commit 5 — Conversation components

Unchanged from [r1 §3 commit 5](03-plan-r1.md#commit-5--conversation-components).

### Commit 6 — AnalystChatPanel chip swap

Unchanged from [r1 §3 commit 6](03-plan-r1.md#commit-6--analystchatpanel-chip-swap).

### Commit 7 — Delete old store machinery + rewrite AgentConversationView

Unchanged from [r1 §3 commit 7](03-plan-r1.md#commit-7--delete-old-store-machinery--rewrite-agentconversationview).

### Commit 8 — Remaining tests

Unchanged from [r1 §3 commit 8](03-plan-r1.md#commit-8--remaining-tests)
**except** for the test-count `grep | wc -l` check, which is
explicitly downgraded to a reviewer aid (§0 row 3): named cases
from design §11.1 are enumerated against the merge gates in
commits 5 (ToolChip) and 2b (every producer stamping case); the
overall `wc -l` only flags the commit author's missing-test risk,
it does not assert per-case coverage.

---

## 4. Commit boundaries

```
[1]  backend stamping infra            (additive; ActiveRuntime + src/agents/round-id.ts)
       │
       ▼
[2a] types + schema + persistence shell (AgentMessage widened; schema canary; appendMessage rewrite; replaceSessionMessages canary; appendActivateCardToolResultOnce widened — producer compile-failures intentional during 2a→2b interval)
       │
       ▼
[2b] producer stamping coverage         (every §2.5 row R-* rewritten; analyst duplicate writer deleted; nine new producer tests; producer audit greps green)
       │
       ▼
[3]  route + WS + wire-types rename     (server returns {session, entries, activity_status}; WS envelopes carry entry; web/api/types renamed in place)
       │  ── mid-stack typecheck gap on web/src/stores/agents.ts opens here ──
       ▼
[4]  UI shared utility + composable
       │
       ▼
[5]  conversation components
       │
       ▼
[6]  AnalystChatPanel chip swap
       │
       ▼
[7]  delete legacy machinery            (mid-stack typecheck gap CLOSES)
       │
       ▼
[8]  remaining tests
```

Branch shape: a single PR with these nine commits stacked, OR a
stack of two PRs split at commit 4 (server vs web). Either way the
branch tip is the only required green CI point; the
`npm --prefix web exec tsc -- --noEmit` failure documented at
commits 3–6 is an accepted mid-stack consequence of the
architecture-first rule and is closed at commit 7. CI for the
**root** workspace (`npm test`, `npx tsc -p . --noEmit`) is
required green at every commit from **2b** onwards (2a is the
single intentional intra-PR root-typecheck gap, scoped to the
producer subtree only and closed by 2b in the same PR).

---

## 5. Validation

### 5.1 Per-commit validation (root + web where applicable)

- `npx tsc -p . --noEmit` (root) — required green at every commit
  except 2a (where it is scoped to the schema/persistence subtree;
  closed by 2b).
- `npm --prefix web exec tsc -- --noEmit` — required green at
  commits 1, 2a, 2b, 7, 8 (intentional gap commits 3–6).
- `npm test -- <new-or-modified-tests>` for the commit's gate
  cases. At commit 2b this includes the **nine new producer test
  files** added in step 9.
- The §2.5 producer-audit `rg` greps (step 10 of commit 2b) are
  re-run at the end of every commit from 2b onwards and must
  continue to return zero unstamped hits. Treat any new hit as a
  blocker.
- `grep -c '<script' <modified-vue-files>` returns 1 per file
  (Vue-SFC corruption guard from user memory).
- `git diff --stat HEAD~1..HEAD` reviewed for stray edits outside
  the §2 inventory.

### 5.2 Branch-tip validation (before merge)

Unchanged from r1 §5.2 plus the producer-audit grep listed in
§5.1.

### 5.3 Deployment validation (saivage-v3 container)

Unchanged from r1 §5.3.

---

## 6. Rollback

Unchanged from [r1 §6](03-plan-r1.md#6-rollback). The split between
2a and 2b does not change the rollback story: the single PR's
merge revert plus container redeploy is still the canonical move,
and the §2.5 producer rewrite is fully reverted by the same revert
(the analyst duplicate writer is restored on revert; no on-disk
state needs migration).

---

## 7. Risks and mitigations

Unchanged from r1 plus two new entries:

12. **Producer audit misses a future writer.** A future PR adds
    a new caller of `appendMessage` without a stamp.
    **Mitigation:** the `agentMessageSchema.superRefine` rejects
    the write at runtime; CI's `npm test` catches the failure
    via the existing schema-canary fixture; the audit `rg` in
    §5.1 is required green per-commit on `main`-bound PRs.
13. **Analyst-handler `stampForKind` helper drifts from the §2.5
    table.** The 5–10 line helper inside `analyst-handler.ts`
    encodes the per-position stamp selection (open vs in-round vs
    close); a future edit could break it silently.
    **Mitigation:** `analyst-handler.stamping.test.ts` asserts the
    exact stamp source for each of the twelve callsites; the test
    is a per-commit gate.

---

## 8. Out of scope

Unchanged from r1 §8.

---

Absolute path of this plan: `/home/salva/g/ml/saivage-v3/SPEC/2026-05/review-ui-port-from-v2/F03-conversation-rounds/03-plan-r2.md`.
