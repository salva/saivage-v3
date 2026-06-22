# F03 — Conversation rounds / diagnostics / pairing — Implementation plan (r1)

Writer r1 for the F03 implementation plan, derived from the approved
design [02-design-r3.md](02-design-r3.md) (which is r2 verbatim with
the F04 chip-contract cross-references rebased onto F04 design r2;
[DESIGN-APPROVED.md](DESIGN-APPROVED.md)) and the approved analysis
[01-analysis-r2.md](01-analysis-r2.md). Cross-issue binding
designs: [F01 r2](../F01-design-tokens/01-analysis-r2.md),
[F02 r2](../F02-component-hierarchy/01-analysis-r2.md),
[F04 design r2 (APPROVED)](../F04-chat-surface-style/02-design-r2.md),
[F05 design r3 (APPROVED)](../F05-tool-detail-rendering/02-design-r3.md).
Issue: [F03-conversation-rounds.md](../F03-conversation-rounds.md).

**Mandatory project rule (binding):** **architecture-first, NO
backward compatibility.** The same branch lands the new types,
components, and store API and **removes** the flat `MessageStep` /
`groupIntoSteps()` machinery, `AgentConversationResponse.messages`,
the legacy `AgentMessage` alias, the legacy `appendMessage(...)`
arity without round-stamp fields, the legacy WS `content.message`
key, the in-line `tool-chip*` markup in `AnalystChatPanel.vue`,
and the legacy `AgentConversationView.vue` template. Nothing is
kept "for later", nothing is aliased, no migration shim is left
behind.

---

## 1. Preconditions

Before the first commit on this branch:

1. **F02 r2 has landed** on the integration branch — folder layout
   `web/src/components/{ui,content,conversation}/`, the
   `MessageBubble.vue` and `ThinkingDots.vue` placeholders, and the
   F02 component-layer discriminator (no store, router, or
   WebSocket import inside `conversation/`). Verify with
   `ls web/src/components/conversation/` showing both `.vue`
   placeholders.
2. **F05 design r3 (APPROVED) has landed** ahead of this branch (or
   is the immediate parent of this branch as a stacked PR). The
   F03 implementation imports the F05 barrel:
   - `web/src/utils/tool-presenters/` — `presentToolCall`,
     `presentToolResult`, `ToolCallPresentation`,
     `ToolResultPresentation`, `InlinePart`.
   - `web/src/components/content/InlineParts.vue`.
   - `web/src/components/content/FormattedContent.vue`.
   - `web/src/components/content/JsonView.vue`.
   Verify with `node -e "require('./web/src/utils/tool-presenters')"`
   (after build) or `grep -l 'tool-presenters' web/src/utils/tool-presenters/index.ts`.
3. **F01 r2 tokens have landed** — `var(--tone-accent)`,
   `var(--tone-warn)`, `var(--tone-danger)`, `var(--tone-muted)`
   are resolvable from the loaded stylesheet. Verify with `grep -r
   '--tone-' web/src/styles/` returning the four tokens.
4. **Working tree is clean.** `git status --porcelain` empty.
   Branch is created from the current `main` after F02 + F05 land.
5. **Backend test harness green at HEAD.** `npm test` (root) passes
   on a clean clone; `npm --prefix web test` (web) passes on a
   clean clone. The plan's added cases are net-new, so HEAD must
   be green before they are introduced.
6. **Container baseline.** The `saivage-v3` LXC container at
   `10.0.3.112:8080` is healthy and running the pre-F03 build
   (`curl -fsS http://10.0.3.112:8080/health` returns 200). The
   final validation step in §6 redeploys to this container.
7. **No in-flight session on disk.** Smoke validation runs against
   a fresh session; existing JSONL files under the test fixtures
   directory `tests/fixtures/sessions/` are pristine (committed
   state).

If any precondition fails, do **not** start the branch.

---

## 2. Files

### 2.1 Added

| Path | Owner | Source of contract |
| ---- | ----- | ------------------ |
| `src/agents/round-id.ts` | F03 | design §3.2 (server-side mirror of the web parser; the **only** allowed producer of `round_id` strings) |
| `src/__tests__/agents/round-id.test.ts` | F03 | design §11.1 (parser + grammar) |
| `src/__tests__/agents/agent-adapter.tool-call-id.test.ts` | F03 | design §11.1 |
| `src/__tests__/agents/session-persistence.round-stamp.test.ts` | F03 | design §11.1 |
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
| `web/src/components/chat/tool-chip-adapter.ts` | F03 (binding of F04 design r2 §1.10) | F04 design r2 §1.10 — `adaptChatMessageToToolChip`, `adaptPendingInvocationToToolChip`; consumed by `AnalystChatPanel.vue` (§8.2) |
| `web/src/__tests__/utils/agent-timeline/round-id.test.ts` | F03 | design §11.1 |
| `web/src/__tests__/utils/agent-timeline/timeline.test.ts` | F03 | design §11.1 |
| `web/src/__tests__/composables/useAgentTimeline.test.ts` | F03 | design §11.1 |
| `web/src/__tests__/stores/agents-conversation.test.ts` | F03 | design §11.1 |
| `web/src/__tests__/conversation/ToolChip.test.ts` | F03 | design §11.1 (R4 gates) |
| `web/src/__tests__/conversation/PendingCallFooter.test.ts` | F03 | design §11.1 |
| `web/src/__tests__/chat/tool-chip-adapter.test.ts` | F03 | F04 design r2 §1.13 cases; landed in this PR because the adapter ships here |

### 2.2 Modified

| Path | Change | Source |
| ---- | ------ | ------ |
| `src/schemas/types.ts` | `AgentMessage` widened with required `round_id: string`, `message_index: number`, `block_index: number`, optional `tool_call_id`, `model_spec`, `requested_model_spec` | design §4.1 |
| `src/schemas/validators.ts` | `agentMessageSchema` adds `roundIdGrammar` regex and `superRefine` for `MAX_SAFE_INTEGER` bound and `tool_call_id` scalar on `tool_call` / `tool_result` / `tool_error` | design §4.1 |
| `src/runtime/active-runtime.ts` | Adds `SessionRoundState`, `RoundStamp`, `PendingCall`, `ActivityStatus`, `SessionActivity`; methods `openAssistantRound`, `stampInRound`, `stampUserMessage`, `stampPre`, `stampCompacted`, `stampDiagnosticInCurrentRound`, `closeRound`, `rebuildSessionRoundState`, `getActivityStatus`, `recordAppend`; event-bus subscriptions for `session_started`, `model_selected`, `invocation_succeeded`, `invocation_failed`, `retry_attempted`, `session_cancelled`, `session_force_cancelled` | design §2.1, §4.2 |
| `src/agents/session-persistence.ts` | `appendMessage` signature widens to require round-stamp fields; assembles record, asserts stamp present, calls `agentMessageSchema.parse`, writes JSONL, calls `activeRuntime.recordAppend`; old arity is the only one — no overload, no default value | design §4.3 |
| `src/agents/agent-adapter.ts` | Every `appendMessage` callsite (L376 and the surrounding turn loop) pulls a `RoundStamp` from `activeRuntime` per the §4.3 table; the assistant `tool_call` persistence at L376 stamps the scalar `tool_call_id: tc.id` | design §2.2, §4.3 |
| `src/server/routes/runtime-config-notes.ts` | Conversation handler at L115 rewritten: response is `{ session, entries, activity_status }`; helper renamed `readAgentMessages` → `readConversationEntries`; each JSONL line parsed through `agentMessageSchema.parse` | design §4.4 |
| `src/server/websocket.ts` | `thinking` and `activity` envelopes carry `{ sessionId, entry, activity_status }`; legacy `content.message` key removed (no alias) | design §2.4, §4.5 |
| `web/src/api/types.ts` | `AgentConversationResponse.messages` removed; `AgentMessage` interface renamed to `ConversationEntry` in place; `ActivityStatus`, `PendingCall` exports added; `AgentConversationResponse` becomes `{ session, entries, activity_status }` | design §2.3, §10 |
| `web/src/stores/agents.ts` | `MessageStep` interface and `groupIntoSteps()` function deleted (L30-L76); `messages`, `steps` (computed), `expandedToolCalls` refs deleted; new state `entries`, `activityStatus`; new actions `appendEntry`, `setActivityStatus`, `refreshConversation`, `bindWs` per design §9; WS handlers piggyback on `thinking` and `activity` envelopes only | design §9, §10 |
| `web/src/components/agents/AgentConversationView.vue` | Legacy flat-step template deleted; rewritten as a thin store container that calls `useAgentTimeline(store.entries, store.activityStatus, () => store.currentSession?.id ?? null)` and renders the timeline via `RoundCard`, `DiagnosticRow`, `ContextBlock`, `CompactedCluster`, and `PendingCallFooter` | design §7, §10 |
| `web/src/components/chat/AnalystChatPanel.vue` | In-line `<button class="tool-chip">` markup deleted; local `ChipParts` interface deleted; scoped `.tool-chip*` rules deleted; chip rendered as `<ToolChip v-bind="adaptChatMessageToToolChip(item.call, item.result, expanded)" @toggle="…" />` for paired chat messages, and `<ToolChip v-bind="adaptPendingInvocationToToolChip(p, expandedIds.has(p.id))" @toggle="…" />` for synthetic pending invocations | design §8.2; F04 design r2 §1.10 |
| `web/src/__tests__/agents-store.test.ts` | Flat-step cases removed (per analysis §10.8); the file is renamed to `agents-conversation.test.ts` (added in §2.1). The original file is **deleted**, not edited; see §2.3. | design §11.1 |

### 2.3 Deleted

| Path | Reason | Source |
| ---- | ------ | ------ |
| `web/src/__tests__/agents-store.test.ts` (flat-step shape) | Replaced wholesale by `web/src/__tests__/stores/agents-conversation.test.ts` (added in §2.1); no overlap of test names | design §10, §11.1 |
| In-line `<button class="tool-chip*">`, local `ChipParts` interface, and scoped `.tool-chip*` rules inside `web/src/components/chat/AnalystChatPanel.vue` | Replaced by `<ToolChip>` + `tool-chip-adapter.ts` (§2.1) | design §8.2, §10 |
| `MessageStep`, `groupIntoSteps()`, `messages`, `steps`, `expandedToolCalls` from `web/src/stores/agents.ts` | Replaced by `entries` + `useAgentTimeline` | design §9, §10 |
| Legacy template body of `web/src/components/agents/AgentConversationView.vue` | Replaced by RoundCard-driven template | design §10 |
| Legacy `appendMessage` arity (without round-stamp fields) in `src/agents/session-persistence.ts` | Replaced by the new arity — the only one (no overload, no default) | design §4.3, §10 |
| Legacy WS envelope key `content.message` in `src/server/websocket.ts` | Replaced by `content.entry` | design §2.4, §10 |
| `AgentConversationResponse.messages` field and the `AgentMessage` alias in `web/src/api/types.ts` | Replaced by `entries: ConversationEntry[]` and the renamed `ConversationEntry` interface | design §2.3, §10 |

---

## 3. Step-by-step commits

Each commit below ends with the exact verification commands that
must succeed before the next commit begins. Intermediate commits
**may** not typecheck in isolation (architecture-first / no
backward compatibility) because deletions and renames are
distributed across commits 2–7; CI is required green at the tip of
the branch and per-commit checks call out which checks are
permitted to fail mid-stack (§5, §7).

### Commit 1 — Backend round-stamping infrastructure

Scope: pure additions to `ActiveRuntime` and a new
`src/agents/round-id.ts` server parser. No callsite changes; no
schema change yet; no producer is using the new methods at this
point.

Steps:

1. Create `src/agents/round-id.ts` — byte-equivalent of design
   §3.2: `RoundIdShape`, `parseDecimalAll` (rejects on overflow
   `Number.MAX_SAFE_INTEGER`), `parseRoundId`, `roundIdSortKey`,
   plus a `formatRoundId(shape)` helper used by `ActiveRuntime` to
   format strings (`r-pre`, `r-msg:N`, `rK`, `r-compacted-N`). No
   imports from web/.
2. Edit `src/runtime/active-runtime.ts` — add the
   `SessionRoundState`, `RoundStamp`, `PendingCall`,
   `ActivityStatus`, `SessionActivity` types verbatim from design
   §2.1 and §4.2; add the private `activity: Map<string,
   SessionActivity>` and `rounds: Map<string, SessionRoundState>`
   fields; add the constructor `eventBus.on(...)` wiring for
   `session_started`, `model_selected`, `invocation_succeeded`,
   `invocation_failed`, `retry_attempted`, `session_cancelled`,
   `session_force_cancelled`; add public methods
   `getActivityStatus`, `recordAppend`, `openAssistantRound`,
   `stampInRound`, `stampUserMessage`, `stampPre`,
   `stampCompacted`, `stampDiagnosticInCurrentRound`, `closeRound`,
   `rebuildSessionRoundState`; private helpers `ensure`,
   `ensureRounds`, `failureClassToReason`, `nowIso`.
3. Wire the event-bus into the existing constructor signature
   (extend the constructor to accept the existing `eventBus` slot
   — read the current constructor; if it already receives an
   `EventBus`, only add the `.on` lines, no signature change).
4. Add `src/__tests__/runtime/active-runtime-activity.test.ts`
   covering the activity-status transition table (analysis §6.2):
   `model_selected → in_flight`, `invocation_succeeded → null`,
   `invocation_failed{recoveryAction=retry} → backoff`,
   `invocation_failed{recoveryAction!=retry} → null`,
   `retry_attempted` updates attempt/retry_at,
   `session_cancelled` clears pending, `recordAppend` updates
   `last_activity_at`.

Verification:

- `npx tsc -p . --noEmit` (root) succeeds (additions only; no
  existing types change).
- `npm test -- src/__tests__/runtime/active-runtime-activity.test.ts`
  passes.
- `grep -c 'openAssistantRound\|stampInRound\|stampUserMessage\|stampPre\|stampCompacted\|stampDiagnosticInCurrentRound\|closeRound\|rebuildSessionRoundState'
  src/runtime/active-runtime.ts` returns `≥ 8`.

Commit message (short form): `F03(backend): ActiveRuntime round
counters + activity status pipeline`.

### Commit 2 — Schema + persistence widening + producer callsites

Scope: every producer of `AgentMessage` now stamps round fields;
the schema enforces the grammar; the only `appendMessage` arity is
the new one; assistant `tool_call` entries get the scalar
`tool_call_id`.

Steps:

1. Edit `src/schemas/types.ts` — widen `AgentMessage` per design
   §4.1: required `round_id: string`, `message_index: number`,
   `block_index: number`, optional `tool_call_id`, `model_spec`,
   `requested_model_spec`.
2. Edit `src/schemas/validators.ts` — add the
   `roundIdGrammar = /^(?:r-pre|r-msg:\d+|r\d+|r-compacted-\d+)$/`
   regex; replace `agentMessageSchema` with the design §4.1
   block (regex + `superRefine` for `MAX_SAFE_INTEGER` bound and
   `tool_call_id` scalar on `tool_call` / `tool_result` /
   `tool_error`).
3. Rewrite `src/agents/session-persistence.ts` `appendMessage` per
   design §4.3: the new arity is the **only** arity. The function
   asserts (`if (!msg.round_id) throw …`) that the round-stamp
   fields are present, assembles the record, calls
   `agentMessageSchema.parse(record)`, writes the JSONL line, and
   calls `activeRuntime.recordAppend(sessionId, record.timestamp,
   record.kind === 'text' && record.role === 'assistant')`. The
   legacy arity at L209–L246 is deleted in this commit (no
   overload).
4. Edit `src/agents/agent-adapter.ts` — update every
   `appendMessage(...)` callsite per the design §4.3 callsite
   table. The four canonical stamp sources are
   `activeRuntime.openAssistantRound(sessionId)` (first assistant
   text/activity in a turn), `activeRuntime.stampInRound(sessionId)`
   (subsequent assistant entries within the same turn, including
   the `tool_call` loop at L376),
   `activeRuntime.stampUserMessage(sessionId)` (user-message
   ingest), `activeRuntime.stampDiagnosticInCurrentRound(sessionId)`
   (`model_issue` / `model_repair` / `model_recovered`),
   `activeRuntime.stampPre(sessionId)` (pre-thread system),
   `activeRuntime.stampCompacted(sessionId)` (compaction summary,
   used by `replaceSessionMessages`). Close the round with
   `activeRuntime.closeRound(sessionId)` at the end of each
   assistant turn (the place where the previous code emitted the
   final assistant text).
5. The `tool_call` loop at L376 is rewritten verbatim from design
   §2.2:

   ```ts
   for (const tc of toolCalls) {
     appendMessage(this.saivageDir, sessionId, {
       role: 'assistant',
       kind: 'tool_call',
       content: JSON.stringify({ toolCalls: [tc] }),
       tool: tc.function.name,
       tool_call_id: tc.id,
       ...activeRuntime.stampInRound(sessionId),
     });
   }
   ```

6. On resume, call `activeRuntime.rebuildSessionRoundState(sessionId,
   entries)` from the existing session-load path (whatever
   currently reads the JSONL on agent startup; design §4.2).
7. Add `src/__tests__/agents/round-id.test.ts` (server parser + the
   six schema-grammar cases from design §11.1: rejects non-digit
   tail, rejects `> MAX_SAFE_INTEGER`, rejects `tool_call` /
   `tool_result` / `tool_error` without `tool_call_id`, accepts
   `r-pre, r-msg:0, r12, r-compacted-3`).
8. Add `src/__tests__/agents/agent-adapter.tool-call-id.test.ts`
   (asserts every `tool_call` written by the adapter carries the
   scalar `tool_call_id`).
9. Add `src/__tests__/agents/session-persistence.round-stamp.test.ts`
   (asserts the new arity throws on missing stamp fields and that
   `recordAppend` is called with the correct args).

Verification:

- `npx tsc -p . --noEmit` succeeds.
- `npm test -- src/__tests__/agents` passes.
- `grep -c 'appendMessage(' src/agents/session-persistence.ts`
  returns exactly 1 export (the new arity).
- `grep -n 'tool_call_id: tc.id' src/agents/agent-adapter.ts`
  returns 1 hit at the tool_call loop.
- `grep -c 'round_id:' src/agents/agent-adapter.ts` returns `≥ 5`
  (one per stamp callsite).

Commit message: `F03(backend): widen AgentMessage with round
stamps; producer stamps every entry; schema canary`.

### Commit 3 — Server route + WS envelope widening + wire-types rename

Scope: server returns the canonical `{ session, entries,
activity_status }` shape; WS envelopes carry `entry` + activity;
client API types are renamed in lock-step so types compile against
the new wire shape. Store/view still consume the renamed types via
their existing import names (renamed in place); the store-internal
`messages` / `steps` / `groupIntoSteps` machinery is **still
present** at this point and is the only remaining consumer of the
old shape — it is rewritten in commit 7 (which is why per-commit
typecheck for `web/src/stores/agents.ts` is allowed to fail at
commits 3–6, per §5 and §7).

Steps:

1. Edit `src/server/routes/runtime-config-notes.ts` L115 (the
   conversation route handler) per design §4.4: rename
   `readAgentMessages` to `readConversationEntries`; the helper
   parses each JSONL line through `agentMessageSchema.parse`; the
   response body becomes `{ session, entries: ConversationEntry[],
   activity_status: activeRuntime.getActivityStatus(session.id) }`.
2. Edit `src/server/websocket.ts` — construct every `thinking` and
   `activity` envelope as `{ type, content: { sessionId, entry,
   activity_status } }` per design §2.4 / §4.5; **delete** the
   legacy `content.message` key (no alias).
3. Add `src/__tests__/server/routes/conversation.test.ts` — fixture
   JSONL with mixed entries; assert response shape
   `{ session, entries, activity_status }`, entry round-stamp
   presence, and `pending_call` reflection of an in-flight model
   call.
4. Edit `web/src/api/types.ts` L752 area: **remove**
   `AgentConversationResponse.messages`; **rename** the
   `AgentMessage` interface to `ConversationEntry` in place (no
   `export type AgentMessage = ConversationEntry` alias); add
   `ActivityStatus`, `PendingCall` exports; `AgentConversationResponse`
   becomes `{ session: AgentSession; entries: ConversationEntry[];
   activity_status: ActivityStatus }`.
5. Update any direct consumer of `AgentConversationResponse.messages`
   in API client wrappers under `web/src/api/` to read
   `r.entries` (the only consumer that survives this commit is
   the store, which is rewritten in commit 7; flag the temporary
   broken consumer with a `// rewritten in F03 commit 7` comment
   so reviewers know the breakage is intentional).

Verification:

- `npx tsc -p . --noEmit` (root) succeeds.
- `npm test -- src/__tests__/server/routes/conversation.test.ts`
  passes.
- `grep -c 'AgentConversationResponse' web/src/api/types.ts`
  returns ≥ 1 with the new shape.
- `grep -n 'content\.message\b' src/server/websocket.ts` returns
  zero hits (legacy key gone).
- `npm --prefix web exec tsc -- --noEmit` is **expected to fail**
  on `web/src/stores/agents.ts` and dependents — this is the
  documented mid-stack typecheck gap (resolved by commit 7); CI is
  not required green at this commit.

Commit message: `F03(wire): canonical {session, entries,
activity_status}; WS envelopes carry entry + activity`.

### Commit 4 — UI shared utility + composable

Scope: pure, Vue-free agent-timeline utility and the
`useAgentTimeline` composable. No component consumes them yet; this
commit is additive on the web side.

Steps:

1. Create `web/src/utils/agent-timeline/types.ts` per design §3.1
   (`ConversationEntryRole`, `ConversationEntryKind`,
   `ConversationEntry`, `PendingCall`, `ActivityStatus`, `ToolPair`,
   `Round`, `TimelineItem`, `ToolPairStatus`).
2. Create `web/src/utils/agent-timeline/round-id.ts` per design
   §3.2 (`RoundIdShape`, `parseDecimalAll`, `parseRoundId`,
   `roundIdSortKey`; leading-zero note as a code comment).
3. Create `web/src/utils/agent-timeline/timeline.ts` per design
   §3.4 (`entriesToTimeline(entries, pendingRoundId)`; bucketing
   by raw `round_id` string; fail-loud
   `warnDroppedToolEntry` `console.warn` for tool entries missing
   the scalar; sort by timestamp then `roundIdSortKey`).
4. Create `web/src/utils/agent-timeline/index.ts` — barrel
   re-exporting `parseRoundId`, `roundIdSortKey`,
   `entriesToTimeline`, all types.
5. Create `web/src/composables/useAgentTimeline.ts` per design §6
   (`pendingRoundId`, `timeline`, `defaultModelSpec`, `expanded`,
   `toggleDetails`, `expandAll`, `collapseAll`, scroll stickiness
   with `SCROLL_BOTTOM_TOLERANCE_PX = 24`, reset-on-agent-switch,
   1-second `now` clock).
6. Add `web/src/__tests__/utils/agent-timeline/round-id.test.ts`
   per design §11.1 (`r-pre`, `r-msg:N`, `rK`, `r-compacted-N`
   tiers; malformed tails as tier 4; `> MAX_SAFE_INTEGER` as tier
   4; `r007` parses to tier-2 round index 7; sort-key relations).
7. Add `web/src/__tests__/utils/agent-timeline/timeline.test.ts`
   per analysis §10.2 (bucketing by raw string keeps `r007` and
   `r7` distinct; tool entries without `tool_call_id` are dropped
   with `console.warn`; pending status set only for the active
   round; orphan / missing / ok / error / pending status
   assignment; sort ordering across tiers).
8. Add `web/src/__tests__/composables/useAgentTimeline.test.ts`
   per analysis §10.3 (`pendingRoundId` follows the highest
   `rK` index when a pending_call exists; `expandAll` covers
   every tool pair across the timeline; reset on agent switch
   clears `expanded`; scroll-stickiness recomputes on length
   change; `now` ticks each second).

Verification:

- `npm --prefix web exec tsc -- --noEmit` for the
  `web/src/utils/agent-timeline/` and `web/src/composables/`
  files passes (still expected to fail elsewhere in `web/src/`
  per commit 3 mid-stack note).
- `npm --prefix web test -- web/src/__tests__/utils/agent-timeline`
  passes.
- `npm --prefix web test -- web/src/__tests__/composables/useAgentTimeline.test.ts`
  passes.
- `grep -n 'import .*vue' web/src/utils/agent-timeline/*.ts`
  returns zero hits (Vue-free utility — F02 r2 layering rule).

Commit message: `F03(web): agent-timeline pure utility +
useAgentTimeline composable`.

### Commit 5 — Conversation components

Scope: the six new SFCs under `web/src/components/conversation/`,
each consuming only props + emits + imported pure utilities (F02 r2
discriminator).

Steps:

1. Create `web/src/components/conversation/ToolChip.vue` per design
   §7.2 — eight-prop bag `{ call, result, callContent,
   resultContent, status, expanded, detailsId, timestamp? }`,
   single `<button>` (the toggle) inside `<Card role="group">`,
   `<InlineParts>` for headline/detail rows (siblings of the
   toggle, never descendants), `<FormattedContent :content>` for
   the expanded body, status-to-tone map per the table in §7.2,
   `ariaLabel` from `${call.name} ${result.status | status}`.
2. Create `web/src/components/conversation/RoundCard.vue` per
   design §7.3 — `toolChipPropsFor(pair)` builds the same
   eight-prop bag the F04 adapter returns, including synthesised
   `ToolCallPresentation` for orphan results (icon `?`, empty
   headline / detail, `status: 'call'`); renders
   `<FormattedContent>` rows for reasoning, `<ToolChip>` rows for
   pairs, `<DiagnosticRow>` rows for diagnostics.
3. Create `web/src/components/conversation/DiagnosticRow.vue` per
   design §7.4 — tone derived from `entry.kind`
   (`model_recovered` → `ok`, `model_repair` → `warn`,
   `model_issue` → `danger`); label from the `kind`; body via
   `<FormattedContent>`.
4. Create `web/src/components/conversation/PendingCallFooter.vue`
   per design §7.5 — `durationSince` / `durationUntil`,
   `in_flight` vs `backoff` branches, `attempt` suffix; `<footer
   role="status" aria-live="polite">` with `data-state` and the
   shared `.dot` indicator.
5. Create `web/src/components/conversation/CompactedCluster.vue`
   per design §7.6 — collapsible cluster with one `<button>`
   summary and a `<DiagnosticRow>` per entry in the expanded body.
6. Create `web/src/components/conversation/ContextBlock.vue` per
   design §7.7 — read-only rendering of `round.context` entries
   via `<FormattedContent>`.
7. Add `web/src/__tests__/conversation/ToolChip.test.ts` per
   design §11.1 — every chip-contract case is a merge gate
   (single `<button>`, F05 `InlinePart` fields (`value` / `path`
   + `root` / `url`), no `text` / `to` / `href` aliases,
   non-nested interactive DOM, sibling expanded body,
   `aria-controls === detailsId`, status-to-tone mapping, raw
   `callContent` / `resultContent` flow through
   `<FormattedContent>`, missing / orphan suffixes).
8. Add `web/src/__tests__/conversation/PendingCallFooter.test.ts`
   per analysis §10.6 (in_flight / backoff rendering, attempt
   counter, throttled vs transient labels, retry countdown).

Verification:

- `npm --prefix web exec tsc -- --noEmit` for the
  `web/src/components/conversation/` files passes.
- `npm --prefix web test -- web/src/__tests__/conversation/ToolChip.test.ts`
  passes — **every** named case from design §11.1 is green
  (merge gate).
- `npm --prefix web test -- web/src/__tests__/conversation/PendingCallFooter.test.ts`
  passes.
- `grep -c '<script' web/src/components/conversation/*.vue` returns
  exactly 1 per file (no duplicate `<script setup>` blocks; see
  user-memory Vue-SFC corruption note).
- `grep -E 'from .*store|from .*router|WebSocket' web/src/components/conversation/*.vue`
  returns zero hits (F02 r2 component-layer discriminator).

Commit message: `F03(web): conversation components — RoundCard,
ToolChip, DiagnosticRow, PendingCallFooter, CompactedCluster,
ContextBlock`.

### Commit 6 — AnalystChatPanel chip swap

Scope: introduce the analyst-side adapter (per F04 design r2 §1.10)
and replace the in-line chip markup in `AnalystChatPanel.vue` with
the shared `<ToolChip>`. Per design §8.2 this lands in the F03
batch (not in F04) so HEAD never carries two chip renderers.

Steps:

1. Create `web/src/components/chat/tool-chip-adapter.ts` per F04
   design r2 §1.10:
   - `adaptChatMessageToToolChip(call: ChatMessage | null,
     result: ChatMessage | null, expanded: boolean)` — returns the
     eight-prop bag `{ call, result, callContent, resultContent,
     status, expanded, detailsId, timestamp? }` with
     `callContent: call?.content ?? syntheticCallContent(...)`
     and `resultContent: result?.content ?? null`; status derived
     from presence of call/result and `result.kind`; `detailsId`
     `tool-detail-${call?.tool_call_id ?? result?.tool_call_id}`.
   - `adaptPendingInvocationToToolChip(p: PendingToolInvocation,
     expanded: boolean)` — returns the same eight-prop bag with
     `callContent` synthesised from `{ tool, summary,
     classifiedAs, relatedCardId, startedAt }`, `resultContent:
     null`, `status: 'pending'`, `detailsId:
     tool-detail-pending-${p.id}`.
2. Edit `web/src/components/chat/AnalystChatPanel.vue`:
   - Delete the in-line `<button class="tool-chip">` markup block
     (the chip-rendering loop near the chat messages list).
   - Delete the local `interface ChipParts { ... }` declaration.
   - Delete the scoped `<style scoped>` `.tool-chip*` rules (the
     `.tool-chip`, `.tool-chip-head`, `.tool-chip-detail`,
     `.tool-chip-result*`, `.tool-chip-tag`, etc. selectors).
   - Add `import ToolChip from '../conversation/ToolChip.vue';`
     and `import { adaptChatMessageToToolChip,
     adaptPendingInvocationToToolChip } from
     './tool-chip-adapter';`.
   - Replace the deleted markup with two `<ToolChip>` callsites
     per F04 design r2 §1.10:

     ```vue
     <ToolChip
       v-for="item in pairedToolChats"
       :key="item.id"
       v-bind="adaptChatMessageToToolChip(item.call, item.result, expandedIds.has(item.id))"
       @toggle="onToggleChip(item.id)"
     />
     <ToolChip
       v-for="p in pendingInvocations"
       :key="`pending-${p.id}`"
       v-bind="adaptPendingInvocationToToolChip(p, expandedIds.has(p.id))"
       @toggle="onToggleChip(p.id)"
     />
     ```

   - The existing `expandedIds`, `onToggleChip`, `pairedToolChats`,
     and `pendingInvocations` consumers stay; only the chip
     rendering markup and its local interface/styles are removed.
3. Add `web/src/__tests__/chat/tool-chip-adapter.test.ts` covering
   the cases from F04 design r2 §1.13:
   `adaptChatMessageToToolChip` returns `callContent ===
   call.content` and `resultContent === result.content` for
   resolved pairs, `resultContent === null` when result is null;
   `adaptPendingInvocationToToolChip` returns
   `resultContent === null` and `status === 'pending'`,
   `detailsId` matches `tool-detail-pending-${p.id}`; orphan
   result (no call) yields a synthesised
   `ToolCallPresentation` with `icon: '?'` and empty
   `headline` / `detail`.
4. Manual smoke (do not commit code for this step): open the
   analyst panel in a dev preview, click the chip toggle, confirm
   the expanded body shows the raw call / result content through
   `<FormattedContent>`, and confirm there is exactly one
   `<button>` per chip (browser devtools: `$0.querySelectorAll('button').length`).

Verification:

- `npm --prefix web exec tsc -- --noEmit` (still expected to fail
  on `web/src/stores/agents.ts` / `AgentConversationView.vue` —
  resolved in commit 7).
- `npm --prefix web test -- web/src/__tests__/chat/tool-chip-adapter.test.ts`
  passes.
- `grep -c 'tool-chip-head\|tool-chip-detail\|class="tool-chip"'
  web/src/components/chat/AnalystChatPanel.vue` returns 0.
- `grep -c '<script' web/src/components/chat/AnalystChatPanel.vue`
  returns exactly 1 (Vue-SFC corruption guard).
- `grep -n 'ChipParts' web/src/components/chat/AnalystChatPanel.vue`
  returns 0.
- `grep -c '<ToolChip' web/src/components/chat/AnalystChatPanel.vue`
  returns ≥ 2 (paired + pending callsites).

Commit message: `F03(web): swap in-line analyst tool-chip for
shared ToolChip + tool-chip-adapter`.

### Commit 7 — Delete old store machinery + rewrite AgentConversationView

Scope: this is the deletion-and-rewire commit. After this commit
the entire web typecheck is green again.

Steps:

1. Rewrite `web/src/stores/agents.ts` per design §9:
   - **Delete** the `MessageStep` interface (L30 area) and
     `groupIntoSteps()` function (L30-L76 range).
   - **Delete** the `messages`, `steps` (computed),
     `expandedToolCalls` refs.
   - **Add** `entries: Ref<ConversationEntry[]>`,
     `activityStatus: Ref<ActivityStatus>` initialised to
     `{ pending_call: null, last_activity_at: new
     Date(0).toISOString() }`, `conversationWarning`, plus
     unchanged `loading` / `error`.
   - **Add** `appendEntry(entry)` (dedupe by `entry.id`; set
     `conversationWarning` on `tool_error` / `model_issue`),
     `setActivityStatus(next)`, `refreshConversation()` (calls
     `getAgentConversation`, full-replaces `entries` from
     `r.entries`, sets `activity_status` and `session`).
   - **Add** `bindWs()` subscribing to `thinking` and `activity`
     envelope types; on each, `appendEntry(c.entry)` if present
     and `setActivityStatus(c.activity_status)` if present. No
     other event subscriptions.
2. Rewrite `web/src/components/agents/AgentConversationView.vue`:
   - Delete the legacy flat-step template (the entire `<template>`
     body that mapped `steps` to flat rows).
   - Replace with a thin store container that calls
     `useAgentTimeline(toRef(store, 'entries'), toRef(store,
     'activityStatus'), () => store.currentSession?.id ?? null)`
     and renders, for each `item` in `timeline`:
     - `item.kind === 'round'`: `<RoundCard
       :round="item.round" :default-model-spec="defaultModelSpec"
       :expanded="expanded" @toggle-details="toggleDetails" />`.
     - `item.kind === 'diagnostic'`: `<DiagnosticRow
       :entry="item.diagnostic" standalone />`.
     - `item.kind === 'context'`: `<ContextBlock
       :round="item.context" />`.
     - `item.kind === 'compacted'`: `<CompactedCluster
       :id="item.id" :entries="item.compacted"
       :expanded="expanded.has(item.id)" @toggle="toggleDetails(item.id)"
       />`.
   - Append `<PendingCallFooter v-if="store.activityStatus.pending_call"
     :pending="store.activityStatus.pending_call" :now="now" />`
     beneath the timeline list.
   - The `threadBody` ref returned by `useAgentTimeline` is bound
     to the scroll container.
   - On `onMounted`, `store.bindWs()` + `store.refreshConversation()`.
3. Delete `web/src/__tests__/agents-store.test.ts` (the
   flat-step file). The replacement
   `web/src/__tests__/stores/agents-conversation.test.ts` is added
   in commit 8 (with the rest of the tests). If CI requires green
   tests at this commit, move the new file's introduction into
   this commit instead — the §2.1 file boundary is unaffected.
4. Update any other consumer in `web/src/` of the now-removed
   `useAgentsStore().messages` / `.steps` / `.expandedToolCalls` —
   the only known consumers are `AgentConversationView.vue`
   (rewritten in this commit) and any cross-store reader the audit
   in step 5 surfaces.
5. Run `grep -rn "store.messages\|store.steps\|expandedToolCalls\|MessageStep\|groupIntoSteps" web/src/`
   — must return zero hits.

Verification:

- `npm --prefix web exec tsc -- --noEmit` succeeds end-to-end
  (mid-stack typecheck gap closed).
- `grep -n "MessageStep\|groupIntoSteps\|expandedToolCalls"
  web/src/stores/agents.ts` returns 0.
- `grep -n "store\.messages\b\|store\.steps\b" web/src/` returns
  0.
- `npm --prefix web build` succeeds (Vite build is green at the
  tip).
- `grep -c '<script' web/src/stores/agents.ts
  web/src/components/agents/AgentConversationView.vue` returns 1
  per file (Vue-SFC corruption guard).

Commit message: `F03(web): delete legacy MessageStep machinery;
AgentConversationView consumes useAgentTimeline + RoundCard`.

### Commit 8 — Remaining tests

Scope: any test file from §2.1 not yet introduced (the rule of
thumb is that each prior commit added the tests that directly gate
its own changes; this commit catches everything else).

Steps:

1. Add `web/src/__tests__/stores/agents-conversation.test.ts` per
   design §11.1 / analysis §10.4 (`appendEntry` dedupe by `id`,
   `setActivityStatus` updates the ref, `refreshConversation`
   full-replaces, `bindWs` consumes `thinking` and `activity`
   envelopes, `conversationWarning` set on `tool_error` /
   `model_issue`).
2. Backfill any case from design §11.1 that did not land alongside
   its commit (cross-reference the §2.1 table; the typical
   straggler is the schema-grammar block at the end of
   `round-id.test.ts` — verify it is present from commit 2 and
   nothing else is missing).
3. Confirm every named case in design §11.1 has a corresponding
   `it(...)` / `test(...)` block by running
   `grep -rE "it\(|test\(" $(find web/src/__tests__/{conversation,utils/agent-timeline,composables,stores,chat} src/__tests__/{agents,runtime,server} -type f) | wc -l`
   and cross-checking the count against §11.1 (this is a
   reviewer-aid check, not a CI gate).

Verification:

- `npm test` (root) — all backend cases green, including the
  schema-grammar superRefine block.
- `npm --prefix web test` — all web cases green, including every
  named case in `ToolChip.test.ts` (R4 merge gate).
- `npm --prefix web test -- --coverage` — `web/src/utils/agent-timeline/`
  and `web/src/composables/useAgentTimeline.ts` show ≥ 95 % line
  coverage (pure modules; the analysis §10 cases cover every
  branch).

Commit message: `F03(test): conversation store + remaining gate
cases for chip / timeline / activity-status`.

---

## 4. Commit boundaries

```
[1] backend stamping infra            (additive; ActiveRuntime + src/agents/round-id.ts)
       │
       ▼
[2] types + schema + persistence      (AgentMessage widened; schema canary; appendMessage rewrite; producer callsites)
       │
       ▼
[3] route + WS + wire-types rename    (server returns {session, entries, activity_status}; WS envelopes carry entry; web/api/types renamed in place)
       │  ── mid-stack typecheck gap on web/src/stores/agents.ts opens here ──
       ▼
[4] UI shared utility + composable    (agent-timeline + useAgentTimeline; Vue-free utility)
       │
       ▼
[5] conversation components           (RoundCard, ToolChip, DiagnosticRow, PendingCallFooter, CompactedCluster, ContextBlock)
       │
       ▼
[6] AnalystChatPanel chip swap        (tool-chip-adapter.ts + analyst panel markup replaced)
       │
       ▼
[7] delete legacy machinery           (MessageStep, groupIntoSteps, messages/steps/expandedToolCalls deleted; AgentConversationView rewritten; mid-stack typecheck gap CLOSES)
       │
       ▼
[8] remaining tests                   (agents-conversation.test.ts + any straggler)
```

Branch shape: a single PR with these eight commits stacked, OR a
stack of two PRs split at commit 4 (server vs web). Either way the
branch tip is the only required green CI point; the
`npm --prefix web exec tsc -- --noEmit` failure documented at
commits 3–6 is an accepted mid-stack consequence of the
architecture-first rule and is closed at commit 7. CI for the
**root** workspace (`npm test`, `npx tsc -p . --noEmit`) is
required green at every commit because the backend has no
mid-stack gap.

Per-commit summary:

| # | Title | Compiles (root) | Compiles (web) | Tests added |
| - | ----- | --------------- | -------------- | ----------- |
| 1 | ActiveRuntime round counters + activity status | ✔ | ✔ | runtime/active-runtime-activity |
| 2 | AgentMessage widen + schema canary + producer callsites | ✔ | ✔ | agents/round-id, agents/agent-adapter.tool-call-id, agents/session-persistence.round-stamp |
| 3 | Server route + WS envelope + wire-types rename | ✔ | ✖ (intentional) | server/routes/conversation |
| 4 | agent-timeline + useAgentTimeline | ✔ | ✖ (intentional) | utils/agent-timeline/round-id, utils/agent-timeline/timeline, composables/useAgentTimeline |
| 5 | Conversation components | ✔ | ✖ (intentional) | conversation/ToolChip, conversation/PendingCallFooter |
| 6 | AnalystChatPanel chip swap | ✔ | ✖ (intentional) | chat/tool-chip-adapter |
| 7 | Delete legacy + rewrite view | ✔ | ✔ | — |
| 8 | Remaining tests | ✔ | ✔ | stores/agents-conversation + stragglers |

---

## 5. Validation

Two layers run on every commit (where compilation is required, per
the table above); the third layer runs at branch tip before merge.

### 5.1 Per-commit validation (root + web where applicable)

- `npx tsc -p . --noEmit` (root, every commit).
- `npm --prefix web exec tsc -- --noEmit` (web, commits 1–2 and 7–8).
- `npm test -- <new-or-modified-tests>` for the commit's gate
  cases.
- `grep -c '<script' <modified-vue-files>` returns 1 per file
  (Vue-SFC corruption guard from user memory).
- `git diff --stat HEAD~1..HEAD` reviewed for stray edits outside
  the §2 inventory.

### 5.2 Branch-tip validation (before merge)

- `npm test` (root, all backend cases green).
- `npm --prefix web test` (web, all web cases green; every named
  `ToolChip.test.ts` case from design §11.1 passes — the R4 merge
  gate).
- `npm --prefix web build` (Vite build succeeds; no Vue SFC
  parse errors; no duplicate `<script setup>` blocks).
- `npx eslint web/src` and `npx eslint src` (linters clean).
- `grep -rn "MessageStep\|groupIntoSteps\|expandedToolCalls\|content\.message\b\|AgentConversationResponse\.messages" src/ web/src/` returns 0 (no backward compatibility residue).
- `grep -rn "from '../utils/tool-presenters'" web/src/components/conversation/` returns the expected imports in `RoundCard.vue` only.
- Schema canary: hand-craft a malformed JSONL line with
  `round_id: "rxabc"` and one with `tool_call` lacking
  `tool_call_id`; the conversation route returns 500 with the
  zod error from `agentMessageSchema` (this is the design §4.1
  canary, validated via the conversation.test.ts fixture).

### 5.3 Deployment validation (saivage-v3 container)

Per the **saivage-development-validation** workspace skill:

1. Build root + web; sync `dist/` and `web/dist/` to the
   `saivage-v3` container at `10.0.3.112` (path `/work/saivage-v3`)
   via the existing deploy path.
2. `ssh root@10.0.3.112 'systemctl restart saivage.service && sleep 4 && systemctl is-active saivage.service && curl -fsS http://127.0.0.1:8080/health'` returns `active` + 200.
3. Open `http://10.0.3.112:8080/` in the integrated browser
   (`open_browser_page`). Navigate to the agents view. Drive a
   simple session (one user message → one assistant turn that
   issues one tool call):
   - Confirm rounds render as `RoundCard` blocks with the
     `data-round-id` matching the producer's stamp (devtools:
     inspect `<section.round-card>` element).
   - Confirm the tool chip has exactly one `<button>` (devtools
     console: `document.querySelector('[data-testid="tool-chip"]
     button:nth-of-type(2)')` returns `null`).
   - Confirm the chip's `aria-controls` value equals the
     expanded-body div id.
   - Toggle the chip; confirm the expanded body shows the raw
     producer payload through `FormattedContent` (JSON pretty
     for a JSON `content` field; prose for a plain-string
     `content` field).
   - Confirm the analyst-chat panel chip (same SFC, different
     adapter) behaves identically.
   - Confirm the `PendingCallFooter` appears while the model
     call is in flight (force a slow provider model to expose
     the in-flight state); confirm it disappears on
     `invocation_succeeded`.
4. Inspect the WS frames via devtools Network → WS. Confirm every
   `thinking` / `activity` frame's `content` includes
   `{ sessionId, entry, activity_status }` and no `message` key.
5. Inspect the conversation REST response in devtools Network.
   Confirm the body matches `{ session, entries, activity_status }`
   and no `messages` field is present.

---

## 6. Rollback

The branch lands as a single PR (or stacked PR at commit 4); the
rollback procedure is therefore a single `git revert -m 1 <merge-sha>`
on the integration branch and a redeploy to the `saivage-v3`
container. There is no on-disk migration: producer-stamped JSONL
lines written by this branch carry the new `round_id` /
`message_index` / `block_index` / `tool_call_id` fields, which the
pre-F03 reader silently ignores (extra JSON keys are not rejected
by the pre-F03 zod schema). Rolled-back deployments therefore
still load old sessions; only the new fields stop being read.

**Caveat.** After this branch lands, any new compaction summary
written carries `r-compacted-N` `round_id`. If the rollback runs
the pre-F03 reader against such a session, the summary is rendered
as an ordinary entry rather than a compaction cluster. Because the
project-rule forbids back-compat, this is the accepted rollback
trade-off: prefer rolling forward with a fix.

**Per-commit rollback** (mid-stack abort): for commits 1–2, plain
`git reset --hard HEAD~1` is safe (additive backend, no on-disk
side effect until a session is appended). For commits 3–7, the
documented mid-stack typecheck gap means a rollback to commit 3
leaves a non-compiling web tree; revert to before commit 3 in that
case. Commit 8 is test-only and trivially reversible. The user
memory note `do NOT bypass with cat > file / sed / Python patch
scripts` applies to any post-rollback redo — use the VS Code edit
tools, restart VS Code if a stale buffer reverts edits.

---

## 7. Risks and mitigations

1. **Mid-stack typecheck gap (commits 3–6).** The web typecheck
   intentionally fails between commits 3 and 7 because the wire
   types are renamed before the store is rewritten. **Mitigation:**
   document the gap explicitly in §4 and §5; require branch-tip
   CI (not per-commit CI) for the web subtree; reviewer guidance
   in the PR description.
2. **Producer / consumer disagreement on `round_id` grammar.**
   The web parser and the server parser must stay in lock-step. **Mitigation:** `src/agents/round-id.ts` is the **only** allowed producer of `round_id` strings on the server; `web/src/utils/agent-timeline/round-id.ts` is the **only** allowed parser on the client; both are byte-equivalent ports of v2; the schema canary (`agentMessageSchema.superRefine`) rejects any third producer at write time.
3. **`tool_call_id` regression.** If a future change re-stamps the
   `tool_call` loop and forgets `tool_call_id: tc.id`, every chip
   for that turn becomes orphan. **Mitigation:** the schema
   canary (design §4.1 `superRefine`) rejects the JSONL write
   before it reaches disk; the test
   `agent-adapter.tool-call-id.test.ts` is the per-PR gate.
4. **Vue-SFC corruption after edits.** Per user-memory note,
   `replace_string_in_file` can append duplicate `<script setup>`
   blocks on Vue SFCs after a long edit session. **Mitigation:**
   the per-commit validation step runs `grep -c '<script'` on
   every modified `.vue` file; build is not attempted until the
   guard passes.
5. **Stale VS Code buffer reverts edits silently.** Per user
   memory, edits can appear committed in the editor but never
   reach disk on long TS files. **Mitigation:** verify every
   modification with `grep -n <new-token>` from the terminal
   before running `tsc` / `npm build`; do not use `cat >` / `sed`
   / Python patch shortcuts; restart VS Code if a buffer keeps
   reverting; `git checkout <file>` and redo with `multi_replace_string_in_file`.
6. **Producer authority drift on resume.** After a restart,
   `rebuildSessionRoundState` must reconstruct counters from
   on-disk JSONL exactly. **Mitigation:**
   `session-persistence.round-stamp.test.ts` covers the resume
   path; the schema's `superRefine` is the canary if drift slips
   through.
7. **F04 / F05 binding skew.** F04 design r2 §1.10 defines the
   adapter contract; F05 r3 defines `InlinePart`, `<InlineParts>`,
   `<FormattedContent>`. If either lands later in a different
   shape, the chip contract diverges. **Mitigation:** the
   `ToolChip.test.ts` chip-contract gates assert the F05 field
   names (`value` / `path,root` / `url`) explicitly; the
   `tool-chip-adapter.test.ts` cases assert the eight-prop bag.
8. **Round bucketing across `r007` vs `r7`.** The leading-zero
   case is a known sharp edge. **Mitigation:** bucketing is by
   raw `round_id` string (timeline.ts), so the two are distinct
   buckets; they only share a sort key. Test
   `round-id.test.ts > parseRoundId > parses r007 to tier 2 round
   index 7` and `timeline.test.ts > raw-string bucketing keeps
   r007 and r7 distinct` cover both halves.
9. **Activity-status event-bus subscription order.** If
   `ActiveRuntime` subscribes after the first session_started
   event, the first session's activity will not be tracked.
   **Mitigation:** the event-bus subscription happens in the
   constructor (commit 1); `ActiveRuntime` is instantiated before
   any session is started in the existing bootstrap path.
10. **PendingCallFooter `now` clock drift.** A 1-second `setInterval`
    can drift in background tabs. **Mitigation:** `now` is used
    only for display strings (`durationSince` / `durationUntil`);
    pending status lifecycle is event-driven via the activity
    pipeline, not clock-driven.
11. **Schema canary blocks legitimate development sessions.** If
    a hand-written test fixture or manual JSONL edit omits
    `round_id`, `agentMessageSchema.parse` throws and the
    conversation route returns 500. **Mitigation:** test fixtures
    are regenerated against the new schema as part of commit 2;
    `conversation.test.ts` includes a malformed-input case that
    asserts the 500 (this is the canary working as designed).

---

## 8. Out of scope

Inherited from analysis §11 and design §13:

- No port of v2's 692-line `toolFormatters.ts` (F05 owns
  presenters; only the `ToolCallPresentation` /
  `ToolResultPresentation` shape is consumed).
- No new `InlinePart` kinds beyond F05 r3's four (`text`,
  `code`, `file`, `url`).
- No new WS event type — `thinking` and `activity` are widened in
  place; no `entry_appended` or similar.
- No streaming-delta protocol; entries are appended whole.
- No JSONL migration tool — old session files with the pre-F03
  shape are not consumed by this branch (the producer rewrites
  every line through the new schema; existing dev sessions are
  regenerated or discarded).
- No analyst-chat composer / layout changes — `MessageList.vue` /
  `MessageItem.vue` extraction, `useStickToBottom`,
  jump-to-latest, and the on-screen-children card are **F04**'s
  scope. F03 only swaps the chip markup in `AnalystChatPanel.vue`
  (§8.2 commit 6).
- No virtualization for very long conversations.
- No router changes beyond `navigateToLink` consumed inside
  `FormattedContent` (F05's scope).
- No theming / token additions — F01 r2's `--tone-accent`,
  `--tone-warn`, `--tone-danger`, `--tone-muted` are sufficient.
- No public CLI / debug-tool changes; the canonical `{ session,
  entries, activity_status }` is structured so external readers
  can pick it up later without further work.

---

Absolute path of this plan: `/home/salva/g/ml/saivage-v3/SPEC/2026-05/review-ui-port-from-v2/F03-conversation-rounds/03-plan-r1.md`.
