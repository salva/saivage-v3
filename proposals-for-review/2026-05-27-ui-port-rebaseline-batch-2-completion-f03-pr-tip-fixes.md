# Design: UI port rebaseline batch 2 completion — F03 PR-tip fixes

This is a **Branch B (design-included)** **delta proposal**
following the rejection of mailbox-013
([2026-05-27-2026-05-27-ui-port-rebaseline-batch-2-resubmit-f03-conversation-rounds.decision.md](rejected/2026-05-27-2026-05-27-ui-port-rebaseline-batch-2-resubmit-f03-conversation-rounds.decision.md)).

The harness implemented the bulk of the F03 contract in
commits `24f7b2d`, `755cc43`, `7a6c49d`; that work is on `master`
at HEAD `27db4e0`. The mailbox cycle was rejected because **six
specific PR-tip validations failed**. This delta closes those
six gaps; it does **not** restate the rest of the F03 contract —
the already-landed work stays.

The harness MUST NOT run a dual-proposal review, MUST produce a
`stage-plan.md` mapping each numbered item below to a stage, and
MUST treat each item as a binding deliverable. The
intermediate-broken-state authorization from the prior resubmit
still applies (per-stage commits MAY be CI-red; the PR tip MUST
be green).

## Problem

Six PR-tip validation failures from mailbox-013 (verbatim from
[rejected/2026-05-27-2026-05-27-ui-port-rebaseline-batch-2-resubmit-f03-conversation-rounds.decision.md](rejected/2026-05-27-2026-05-27-ui-port-rebaseline-batch-2-resubmit-f03-conversation-rounds.decision.md)):

1. Producer audit: local `appendMessage` + `readMessages` still
   present in `src/agents/analyst-handler.ts` at L72 + L91.
2. Producer audit: manual `AgentMessage` literals still present
   in `src/agents/compaction.ts` at L143 (`summaryMsg`) and
   L216 (`truncationMsg`).
3. `web/src/components/conversation/ToolChip.vue` nests
   interactive `<a>` markup inside `<button class="tool-chip-toggle">`,
   violating the one-button / sibling-link contract.
4. `tests/server/agents-detail-route.test.ts` returns HTTP 500
   (handler now parses on-disk JSONL through the widened
   `agentMessageSchema`; test fixtures still write the
   pre-stamp shape).
5. Web tests fail in `ToolChip`, `AnalystChatPanel`, and
   `AgentConversationView` with stale checklist assertions
   targeting the pre-rewrite DOM.
6. Playwright smoke cannot find the expected synthetic-agent
   transcript: `fake-agent` either emits unstamped fixture
   messages (rejected by the new schema parse) or the smoke
   selectors target the pre-`RoundCard` DOM.

## Decision (binding contract)

The implementation contract is the union of:

- The original F03 analysis r2, design r3, plan r2 (still
  binding for any work not yet landed).
- The rebaseline addendum
  [F03-conversation-rounds/04-rebaseline-against-HEAD-r2.md](../SPEC/2026-05/review-ui-port-from-v2/F03-conversation-rounds/04-rebaseline-against-HEAD-r2.md).
- The six numbered remediations below.

Already-landed F03 work in commits `24f7b2d`, `755cc43`,
`7a6c49d` is preserved; the harness MUST NOT revert the
schema widening, the `agent-timeline/*` utilities, the new
conversation components, the `tool-chip-adapter.ts`, the
`AnalystChatPanel.vue` chip swap, or the `AgentConversationView.vue`
template rewrite. The harness MUST extend that work to close
the six gaps.

## Remediation items

### Item 1 — `analyst-handler.ts` legacy producers

**Files**: `src/agents/analyst-handler.ts`.

Delete the local `readMessages` (L72) and local `appendMessage`
(L91) functions. Every callsite that previously routed through
those locals must route through
`src/agents/session-persistence.ts` `appendMessage(...)` (the
stamped arity introduced by F03) and the shared read helper
used by the rest of the runtime. Constructor must accept
`activeRuntime: ActiveRuntime` (required; no default) and call
`activeRuntime.stamp*(...)` for each emission per rebaseline
§4 rows R-AN-1..R-AN-12.

**Acceptance**: `git grep -nE '^function (appendMessage|readMessages)\(' src/agents/analyst-handler.ts`
returns zero matches; producer audit grep at PR tip is clean.

### Item 2 — `compaction.ts` manual literals

**Files**: `src/agents/compaction.ts`.

Delete both manual `AgentMessage` literals:

- `summaryMsg` at L143 (already covered by rebaseline §3.3
  row "Manual `AgentMessage` literal at `compaction.ts`
  L141–L156"): replace with a call to
  `session-persistence.appendMessage(...)` stamped via
  `activeRuntime.stampCompacted(sessionId)` →
  `r-compacted-${state.count + 1}`.
- `truncationMsg` at L216 (NEW item not in original §3.3):
  same treatment. Stamp via the same `stampCompacted` source
  (or, if the operator prefers, introduce a parallel
  `stampTruncated(sessionId)` method on `ActiveRuntime` that
  yields `r-truncated-${n}`; the choice is the harness's,
  but the literal must be deleted and the resulting message
  must satisfy `agentMessageSchema.parse`).

`compactSession(...)` must accept `activeRuntime` (already
specified in rebaseline §3.2 row for `compaction.ts`); apply
the same to whatever truncation helper owns L216.

**Acceptance**:
`git grep -nE 'const (summaryMsg|truncationMsg)\b' src/agents/compaction.ts`
returns zero matches; both messages round-trip through
`agentMessageSchema.parse`.

### Item 3 — ToolChip one-button / sibling-link contract

**Files**: `web/src/components/conversation/ToolChip.vue` and
`web/src/__tests__/conversation/ToolChip.test.ts`.

The current template (HEAD `27db4e0`) renders headline + detail
`<InlineParts>` **inside** the `<button class="tool-chip-toggle">`.
`InlineParts` can emit `<a>` elements for `file` and `url`
kinds; nesting `<a>` inside `<button>` is invalid HTML and
breaks the design §7.2 contract.

The contract:

- The chip's `<button class="tool-chip-toggle">` MUST contain
  ONLY non-interactive content: the icon, name, plain-text
  parts (`kind: 'text' | 'number' | 'code' | 'mono'` —
  whatever `InlineParts` renders as non-anchor spans),
  timestamp, and caret.
- All interactive parts (`kind: 'file' | 'url'`) MUST render
  as a SIBLING of the button, inside the existing
  `<InlineParts class="tool-chip-links">` slot (already
  present in the current template).
- The button-internal `headline` and `detail` computeds MUST
  be filtered to exclude interactive parts. Introduce
  `nonInteractiveHeadline` and `nonInteractiveDetail`
  computeds; the existing `interactiveParts` already supplies
  the sibling link list.

**Acceptance**:
- `<a>` does not appear as a descendant of
  `button.tool-chip-toggle` in any rendered test case (assert
  via `wrapper.find('button.tool-chip-toggle a').exists()`
  being `false`).
- The pre-existing `ToolChip.test.ts` cases for file links and
  URL links assert the anchor renders inside
  `.tool-chip-links` (sibling of the button), not as a button
  descendant.

### Item 4 — `agents-detail-route.test.ts` HTTP 500

**Files**: `tests/server/agents-detail-route.test.ts`.

The handler now parses on-disk JSONL through the widened
`agentMessageSchema` (per F03 plan §2.2 row 11). The test
fixtures at L13 `writeMessages(...)` and the individual test
cases write messages without `round_id` / `message_index` /
`block_index` → schema parse throws → handler returns 500.

Migrate every fixture row in the test file to the stamped
shape. Minimum stamp set for a test fixture row:

```ts
{
  role: 'assistant' | 'user' | 'tool',
  kind: 'text' | 'tool_call' | 'tool_result' | 'tool_error',
  content: '<string>',
  round_id: 'r-1',          // any value matching roundIdGrammar
  message_index: 0,         // monotonically increasing per round
  block_index: 0,
  // tool_call_id required iff kind ∈ {'tool_call','tool_result','tool_error'}
  // model_spec / requested_model_spec optional
  timestamp: '2026-01-01T00:00:00.000Z', // existing field
}
```

The route's response shape change (`{ messages }` → `{ session, entries, activity_status }`)
applies to the conversation endpoint, NOT to this list/detail
summary endpoint — the existing assertions on
`body.session['message_count']` etc. remain correct.

**Acceptance**: `npx jest tests/server/agents-detail-route.test.ts`
exits zero; all 8 numbered cases pass.

### Item 5 — Web unit-test refresh

**Files** (failure surfaces named in the rejection log):

- `web/src/__tests__/conversation/ToolChip.test.ts`
- `web/src/__tests__/chat/AnalystChatPanel.children.test.ts`
  (or whichever existing AnalystChatPanel test file fails;
  may need creation per F04 design r2 §1.13 even though F04
  is a future batch — only the chip-swap-affected cases are
  in scope here).
- `web/src/__tests__/agents/AgentConversationView.test.ts`
  (the rejection log mentioned "stale AgentConversationView
  checklist assertions" — the file is whichever the existing
  vitest suite for this view points at).

Every assertion that targets the pre-F03 DOM (flat
`MessageStep` list, four-prop `ToolChip`, inline
`<button class="tool-chip">` markup inside `AnalystChatPanel`)
must migrate to the post-F03 DOM:

- `ToolChip` consumes the eight-prop bag verbatim; tests
  pass `call`, `result`, `callContent`, `resultContent`,
  `status`, `expanded`, `detailsId`, `timestamp?`.
- `AnalystChatPanel` renders `<ToolChip v-bind="adapt…">` for
  paired messages and for pending invocations; the test
  fixture seeds `chatStore.messages` + `chatStore.pendingInvocations`
  in the shapes the adapters expect.
- `AgentConversationView` renders `<RoundCard>` per round;
  the test asserts the round-driven DOM via
  `wrapper.findAllComponents(RoundCard)` (or equivalent).

**Acceptance**: `npm --prefix web run test -- --run` exits
zero with no remaining stale-DOM assertions.

### Item 6 — Playwright synthetic-agent transcript

**Files**: `src/agents/fake-agent.ts`, the Playwright spec
that drives the synthetic agent (the rejection log refers to
the e2e smoke; identify the file by `git grep -l 'fake-agent\|synthetic agent\|FakeAgent' tests/ e2e/ web/ 2>/dev/null`).

Two-side fix:

- **Producer side**: confirm `fake-agent.ts` emits stamped
  messages via `session-persistence.appendMessage(...)`,
  opening a round with `activeRuntime.openAssistantRound(...)`
  at the start of each fixture turn and closing it via
  `activeRuntime.closeRound(...)` at the end (per rebaseline
  §3.2 row for `fake-agent.ts`). Every emitted message must
  carry `round_id` / `message_index` / `block_index`.
- **Consumer side**: the Playwright selectors must target the
  new `RoundCard`-driven DOM. The original v2 spec likely
  asserted `text=<some tool name>` or
  `[data-testid="tool-chip-..."]`. Update to:
  - `[data-testid="round-card"]` for each round head.
  - The chip's `<button class="tool-chip-toggle">` for click
    targets (its `aria-controls` matches `detailsId`).
  - `[role="group"][aria-label^="tool "]` for the chip
    container if a role-based selector is preferred.

**Acceptance**: the previously-failing
`e2e/<smoke-spec>.spec.ts` (named in
`architecture-audit/mailbox-013-…/validation/t3-e2e-smoke.stdout.log`)
exits zero against the local saivage-v3 LXC container.

## Files / tests / docs to DELETE

Net deletions in this delta (in addition to all deletions
already specified in the rebaseline §3.3 that the prior cycle
honoured):

- Local `function readMessages(...)` at
  `src/agents/analyst-handler.ts` L72–L80.
- Local `function appendMessage(...)` at
  `src/agents/analyst-handler.ts` L91–L… (whatever its end
  line is at HEAD `27db4e0`).
- `const summaryMsg: AgentMessage = { … }` at
  `src/agents/compaction.ts` L143.
- `const truncationMsg: AgentMessage = { … }` at
  `src/agents/compaction.ts` L216.
- All test assertions targeting the pre-F03 DOM in
  `ToolChip.test.ts`, `AnalystChatPanel*.test.ts`,
  `AgentConversationView*.test.ts`.

No alias period; no `@deprecated` re-export; no migration shim.

## Validation gate (PR tip)

The PR tip MUST pass all of:

- `git grep -nE '^function (appendMessage|readMessages)\(' src/agents/analyst-handler.ts | wc -l` → `0`.
- `git grep -nE 'const (summaryMsg|truncationMsg)\b' src/agents/compaction.ts | wc -l` → `0`.
- Producer-audit grep from rebaseline §4 → zero hits outside
  the §4 inventory.
- `npx tsc -p . --noEmit && npm test -- --run` (root).
- `npm --prefix web run typecheck && npm --prefix web run test -- --run && npm --prefix web run build`.
- `npx jest tests/server/agents-detail-route.test.ts` → green.
- F03 plan r2 §5 full-suite acceptance gates (schema-stamp
  canary, no-flat-renderer assertion, exhaustiveness on
  `ConversationEntry`, R4 chip-test cases — INCLUDING the new
  anchor-not-inside-button assertion from Item 3).
- Playwright smoke: the previously-failing spec named in
  `t3-e2e-smoke.stdout.log` exits zero.
- Live conversation probe on the saivage-v3 LXC container
  (10.0.3.112:8080): start a real planner session, drive one
  round, confirm `RoundCard` renders head + bodies; `ToolChip`
  shows the file/URL links as siblings of the toggle button
  (NOT nested inside); forced compaction produces a
  `CompactedCluster`.

Per-stage commits inside this batch do NOT have to pass the
gate; only the merge tip does. The "no alias period, no
backward-compat shim" rule applies to the PR tip.

## Implementation latitude (preserved from prior resubmit)

The operator explicitly authorizes intermediate CI-red states
between stages inside this single mailbox cycle. The
all-or-nothing contract applies to the PR tip only. The
harness MUST NOT open the PR before reaching a green tip, and
MUST NOT archive this proposal to `done/` on a partial /
red landing.

## Risks / accepted residuals

- The `truncationMsg` literal at L216 was NOT enumerated in
  the original rebaseline §3.3; the harness reasonably
  preserved it. This delta explicitly adds it to scope.
- The Playwright smoke selectors are not enumerated by file +
  line in the underlying plan; the harness identifies the
  failing spec via the mailbox-013 validation log and
  migrates its selectors.
- Intermediate per-stage commits will be CI-red by design.

## Sequencing note

After this delta closes, the F04 R3 resubmit
([2026-05-27-ui-port-rebaseline-batch-3-resubmit-f04-chat-surface-style.md](2026-05-27-ui-port-rebaseline-batch-3-resubmit-f04-chat-surface-style.md))
becomes processable — its preconditions (eight-prop ToolChip
with `callContent`/`resultContent`, `tool-chip-adapter.ts`,
`agent-timeline/*`, `useAgentTimeline.ts`, AnalystChatPanel
chip swap) will all be satisfied at HEAD.

The harness MUST produce
`architecture-audit/mailbox-<NNN>-ui-port-rebaseline-batch-2-completion/classification.md`
identifying this as Branch B + delta, and
`architecture-audit/mailbox-<NNN>-ui-port-rebaseline-batch-2-completion/stage-plan.md`
with a 6-row coverage table (one row per remediation item
above).

## Out of scope

- Re-implementing any F03 work already landed in commits
  `24f7b2d`, `755cc43`, `7a6c49d`.
- F04 chat surface decomposition (still owned by the queued
  R3 resubmit).
- Any backend feature, route, or schema change beyond the six
  items above.
- The `ci-fix-typescript-build-and-audit` work
  ([2026-05-27-ci-fix-typescript-build-and-audit.md](2026-05-27-ci-fix-typescript-build-and-audit.md))
  remains its own mailbox entry.
