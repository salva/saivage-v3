# Design: UI port rebaseline batch 2 — F03 conversation rounds against HEAD `eb98caf`

This is a **Branch B (design-included)** proposal under the
mailbox classification objective. The harness MUST NOT run a
dual-proposal review, MUST NOT vary the scope, MUST produce a
`stage-plan.md` with a deliverable→stage coverage table, and
MUST honour the nothing-lost invariant.

## Problem

The conversation-round timeline, schema stamping, and shared
`ToolChip` migration (F03) have not landed. Without them, the
conversation surfaces (`AgentConversationView`,
`AnalystChatPanel`) still render the flat `MessageStep` shape,
the producer-side `AgentMessage` schema is missing `round_id` /
`message_index` / `block_index` stamps, and the chat panel still
hosts the inline `<button class="tool-chip">` markup. The R3
(F04) batch cannot land without this layer.

## Precondition

The R1 batch
([2026-05-27-ui-port-rebaseline-batch-1-f02-f05-completion.md](2026-05-27-ui-port-rebaseline-batch-1-f02-f05-completion.md))
must be merged before R2 starts. R2 hard-checks the following at
HEAD when picked up:

- `web/src/components/conversation/MessageBubble.vue` exists.
- `web/src/components/conversation/ThinkingDots.vue` exists.
- F02 `ui/` primitives + `content/` components exist (already on
  HEAD `eb98caf` prior to R1).
- F02 R1 has NOT touched
  `web/src/components/agents/AgentConversationView.vue`,
  `web/src/components/chat/AnalystChatPanel.vue`, or
  `web/src/components/conversation/ToolChip.vue` (those are
  R2's territory).

If any of these is wrong, file a delta proposal or reject via
`<basename>.decision.md`.

## Decision (binding contract)

The implementation contract is:

- F03 analysis r2, design r3, plan r2 under
  [SPEC/2026-05/review-ui-port-from-v2/F03-conversation-rounds/](../SPEC/2026-05/review-ui-port-from-v2/F03-conversation-rounds/).
- The rebaseline addendum:
  [F03-conversation-rounds/04-rebaseline-against-HEAD-r2.md](../SPEC/2026-05/review-ui-port-from-v2/F03-conversation-rounds/04-rebaseline-against-HEAD-r2.md)
  (APPROVED — see sibling `REBASELINE-APPROVED.md`).

The R2 batch implements §3 (Added / Modified / Deleted /
Compaction policy) + §4 (Producer audit) + §5 (Reconciliation)
of the rebaseline addendum. Each row is a binding deliverable;
no row may be silently dropped.

## Files to change

The full inventory is the rebaseline addendum §3.1 (Added — 33
files), §3.2 (Modified — 18 files), §3.3 (Deleted — 9 items),
and §4 (Producer audit — every callsite enumerated R-SP-1,
R-SP-2, R-RT-1..R-RT-3, R-S6-1, R-FK-1, R-CP-1, R-AD-1..R-AD-18,
R-AN-1..R-AN-12). Compact summary:

- **Schema**: `src/schemas/types.ts` widens `AgentMessage` with
  `round_id`, `message_index`, `block_index`, and the three
  optional model fields. `src/schemas/validators.ts` adds
  `roundIdGrammar` + `superRefine`.
- **Runtime**: `src/runtime/active-runtime.ts` adds
  `SessionRoundState`, `RoundStamp`, `PendingCall`,
  `ActivityStatus`, `SessionActivity`, and the round-stamp
  method surface. `src/agents/round-id.ts` is new.
- **Producers**: every `appendMessage(...)` callsite migrates to
  the new stamped arity (see §4 of the rebaseline). Duplicate
  analyst writer at `analyst-handler.ts` L72–L90 is deleted.
  Manual `AgentMessage` literal at `compaction.ts` L141–L156 is
  deleted.
- **Server**: `src/server/routes/runtime-config-notes.ts`
  conversation handler rewritten; `src/server/websocket.ts`
  envelopes carry `entry` + `activity_status` (legacy
  `content.message` key removed, no alias).
- **Web types/store**: `web/src/api/types.ts` renames
  `AgentMessage` → `ConversationEntry`, drops
  `AgentConversationResponse.messages`, adds `ActivityStatus`
  and `PendingCall`. `web/src/stores/agents.ts` deletes
  `MessageStep` / `groupIntoSteps` / flat-step refs and adds
  `entries` / `activityStatus` / `appendEntry` /
  `setActivityStatus` / `refreshConversation` / `bindWs`.
- **Timeline**: `web/src/utils/agent-timeline/{types,round-id,timeline,index}.ts`
  new; `web/src/composables/useAgentTimeline.ts` new.
- **Conversation components**: `web/src/components/conversation/ToolChip.vue`
  rewritten to the eight-prop bag
  (`call`, `result`, `callContent`, `resultContent`, `status`,
  `expanded`, `detailsId`, `timestamp?`). New:
  `RoundCard.vue`, `DiagnosticRow.vue`, `PendingCallFooter.vue`,
  `CompactedCluster.vue`, `ContextBlock.vue`.
- **Chat surface chip swap**: `web/src/components/chat/tool-chip-adapter.ts`
  new (exports `adaptChatMessageToToolChip`,
  `adaptPendingInvocationToToolChip`).
  `web/src/components/chat/AnalystChatPanel.vue` deletes inline
  chip markup, local `ChipParts`, scoped `.tool-chip*` rules,
  and consumes `<ToolChip v-bind="adapt…">`.
- **Agent surface rewrite**: `web/src/components/agents/AgentConversationView.vue`
  template fully rewritten to consume
  `useAgentTimeline(store.entries, store.activityStatus, ...)`
  and render the `RoundCard`-driven timeline.
- **Tests**: ~15 new test files per rebaseline §3.1 (every
  producer in §4 has a stamping test; web-side timeline /
  composable / store / component tests).

## Files / tests / docs to DELETE

Per rebaseline §3.3:

- `web/src/__tests__/agents-store.test.ts` (flat-step shape;
  replaced by `web/src/__tests__/stores/agents-conversation.test.ts`).
- Inline `<button class="tool-chip*">` markup, local `ChipParts`,
  scoped `.tool-chip*` rules in `AnalystChatPanel.vue`.
- `MessageStep` interface, `groupIntoSteps()`, `messages`,
  `steps`, `expandedToolCalls` in `web/src/stores/agents.ts`
  (L30–L76).
- Legacy template body of `AgentConversationView.vue`.
- Legacy `appendMessage(...)` arity (without round-stamp fields)
  in `session-persistence.ts`.
- Legacy WS envelope key `content.message` in
  `src/server/websocket.ts`.
- `AgentConversationResponse.messages` field and the
  `AgentMessage` alias in `web/src/api/types.ts`.
- Local `function appendMessage(...)` at
  `analyst-handler.ts` L81–L90 and local `function readMessages(...)`
  at L72–L80.
- Manual `AgentMessage` literal at `compaction.ts` L141–L156
  (`summaryMsg` inline).

No alias period, no `@deprecated` re-export, no migration shim.

## Validation gate

The R2 PR tip must satisfy:

- Producer-audit grep at end of plan commit 2b AND at PR tip:
  ```
  rg -n "appendMessage\(|AgentMessage =|agentMessageSchema.parse|replaceSessionMessages\(|appendActivateCardToolResultOnce" src/
  ```
  must return zero hits outside the §4 inventory.
- Root: `npx tsc -p . --noEmit && npm test -- --run`.
- Web: `npm --prefix web run typecheck && npm --prefix web run test -- --run && npm --prefix web run build`.
- F03 plan r2 §5 acceptance gates (schema-stamp canary,
  no-flat-renderer assertion, exhaustiveness on
  `ConversationEntry`, R4 chip-test cases).
- Forbidden-shape grep: `git grep -n 'formatToolPair\|FormattedToolPair' web/src/ | wc -l` MUST be 0.
- Live conversation probe on the `saivage-v3` LXC container
  (10.0.3.112:8080): start a real planner session, drive one
  round, confirm `RoundCard` renders head + bodies; `ToolChip`
  pairs correctly; diagnostics fold into the active round;
  forced compaction produces a `CompactedCluster`.

## Risks / accepted residuals

- The legacy `AgentMessage` JSONL on disk (sessions written by
  any pre-F03 binary) is incompatible with the widened schema.
  If a revert is taken, those session files must be moved out
  of `.saivage/sessions/` before restarting the pre-F03 binary.
  Documented in METAPLAN §3 Batch 4 rollback caveat.
- The chip swap inside `AnalystChatPanel.vue` is part of R2 (not
  R3). R3 inherits a chip-swapped panel and decomposes it into
  six SFCs; if R2 ships only a partial chip swap, R3 will reject
  via `.decision.md`.

## Sequencing note

This is the second of three mailbox batches. R3 (F04) follows
and hard-checks both R1 + R2 preconditions.

The harness MUST produce
`architecture-audit/mailbox-<NNN>-ui-port-rebaseline-batch-2/classification.md`
identifying this as Branch B, and
`architecture-audit/mailbox-<NNN>-ui-port-rebaseline-batch-2/stage-plan.md`
with a deliverable→stage coverage table whose union equals §3 +
§4 + §5 of the F03 rebaseline. The plan §3 commit sequence (1,
2a, 2b, 3, 4, 5, 6, 7, 8) is a reasonable decomposition but the
harness MAY choose another, provided every row is covered.

## Out of scope

- F04 chat surface decomposition (R3's territory).
- Backend producer changes outside the §4 inventory.
- Streaming protocol changes; richer markdown / new highlighter;
  streaming JSON tokeniser (all listed under METAPLAN §10
  out-of-scope).
- Analyst-handler option B (`SessionRoundState` injection); the
  binding choice is option A (route every analyst writer through
  the shared persistence API), per F03 plan r2 §0 row 1c.
