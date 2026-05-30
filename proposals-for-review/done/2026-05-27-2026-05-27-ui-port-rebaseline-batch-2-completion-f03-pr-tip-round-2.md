# Design: F03 PR-tip completion — round 2 (mandatory ActiveRuntime, no fallbacks)

This is a **Branch B (design-included)** **delta proposal**
following the rejection of mailbox-015
([2026-05-27-2026-05-27-ui-port-rebaseline-batch-2-completion-f03-pr-tip-fixes.decision.md](rejected/2026-05-27-2026-05-27-ui-port-rebaseline-batch-2-completion-f03-pr-tip-fixes.decision.md))
and the consequential mailbox-016 precondition rejection of the
F04 R3 resubmit.

The harness has now twice attempted to close the F03 contract
and twice failed because it used the same anti-pattern:
`this.activeRuntime?.stampX(sessionId) ?? { round_id: 'r-…', message_index: …, block_index: … }`.
That construct simultaneously:

- **violates the producer-audit grep** (the `?? { round_id: '…' }`
  branch is a hard-coded stamp literal); and
- **throws at runtime** when `this.activeRuntime` is non-null
  but lacks the stamp method (test mocks do exactly this:
  `{ runtime: { eventBus } } as never`), because `?.` does not
  guard a non-null object whose method is undefined.

This proposal makes the architecture explicit: every producer
that needs stamps MUST receive a real `ActiveRuntime` (or a
test double that conforms to the full interface); no `?.`
guards on stamp methods, no `??` literal fallbacks. The
harness MUST NOT introduce any optional-stamp pattern. The
operator's intermediate-CI-red authorization still applies;
only the PR tip must be green.

The harness MUST produce `stage-plan.md` covering all 9 items
below as binding deliverables.

## Problem (verbatim from mailbox-015 + mailbox-016)

From
[architecture-audit/mailbox-015-f03-pr-tip-completion/validation/final-f03-grep-gates.stdout.log](../architecture-audit/mailbox-015-f03-pr-tip-completion/validation/final-f03-grep-gates.stdout.log):

- `src/agents/analyst-handler.ts` lines 226, 232, 241, 254, 261, 334, 340, 348, 352, 387, 391 all emit
  `this.activeRuntime?.stampX(sessionId) ?? { round_id: 'r-…', message_index: …, block_index: … }`.
  Each `??` branch is a hard-coded fallback that the
  producer-audit grep flags.
- `src/agents/fake-agent.ts` line 76–78 defines local
  `private openAssistantRound`, `private stampInRound`,
  `private closeAssistantRound` on the `FakeAgent` class; line 88
  invokes `this.stampInRound(persistedSessionId)` directly.
  These are not routed through `ActiveRuntime`.
- `src/runtime/runtime.ts` line 261 emits
  `appendActivateCardToolResultOnce(…, { round_id: 'r-diagnostic-1', message_index: 0, block_index: 0 })`;
  line 412 emits
  `appendMessage(…, { role: 'user', kind: 'text', content: … }, { round_id: 'r-user-1', message_index: 0, block_index: 0 })`.
  Both are hard-coded literals inside the runtime that owns
  ActiveRuntime.
- `src/server/routes/runtime-config-notes.ts` line 24 defines
  `legacyConversationEntry(raw, sessionId, index)` and uses it
  as a fallback inside `readConversationEntries` when
  `agentMessageSchema.safeParse` fails. This is "legacy
  conversation compatibility parsing" and violates the
  architecture-first / no-backcompat rule at the PR tip.

From
[architecture-audit/mailbox-015-f03-pr-tip-completion/validation/final-root-jest-rerun.stderr.log](../architecture-audit/mailbox-015-f03-pr-tip-completion/validation/final-root-jest-rerun.stderr.log):

- `tests/server/analyst-tool-invoked-broadcast.test.ts` throws
  `TypeError: this.activeRuntime?.stampUserMessage is not a function`
  at `src/agents/analyst-handler.ts:226`, because the test
  constructs `AnalystHandler` with `{ runtime: { eventBus } } as never`.

From
[architecture-audit/mailbox-015-f03-pr-tip-completion/validation/final-web-test.stdout.log](../architecture-audit/mailbox-015-f03-pr-tip-completion/validation/final-web-test.stdout.log):

- `web/src/__tests__/read-only-positive-checklist.test.ts` fails
  (reasons reported by the final reviewer).

From
[rejected/2026-05-27-2026-05-27-ui-port-rebaseline-batch-3-resubmit-f04-chat-surface-style.decision.md](rejected/2026-05-27-2026-05-27-ui-port-rebaseline-batch-3-resubmit-f04-chat-surface-style.decision.md):

- `web/src/components/chat/tool-chip-adapter.ts` exports
  `adaptChatMessageToToolChip(message: ChatMessage, expanded: boolean)`
  but the F04 / F03 contract requires
  `adaptChatMessageToToolChip(call: ChatMessage, result: ChatMessage | null, expanded: boolean)`
  — paired-message adaptation, one `<ToolChip>` per
  tool_call/tool_result pair.
- `web/src/components/chat/AnalystChatPanel.vue` still contains
  monolithic v2 markers `state-panel`, `on-screen-section`,
  `message-bubble`, `message-badges`, `pending-tool`,
  `chat-composer`, `composer-input`, `primary-btn` and renders
  a flat message list at L40, L42, L50; the F03 substrate
  requires the panel to render through the same RoundCard
  timeline used by `AgentConversationView.vue`.

## Decision (binding contract)

The implementation contract is the union of:

- All previously-binding contracts: F03 analysis r2, design r3,
  plan r2, rebaseline r2, the prior F03 completion delta
  (mailbox-015), and the entire ActiveRuntime / round_id /
  stamp design.
- The hard prohibitions in §"Forbidden patterns" below.
- The nine remediation items below.

Already-landed F03 work in commits `24f7b2d`, `755cc43`,
`7a6c49d`, `124cc69`, `fc33970` is preserved EXCEPT where this
proposal mandates deletion of the fallback / legacy
constructs.

## Forbidden patterns (hard prohibitions at the PR tip)

The harness MUST NOT introduce or preserve any of:

1. `?.stampUserMessage(`, `?.stampInRound(`, `?.stampPre(`,
   `?.stampCompacted(`, `?.stampDiagnosticInCurrentRound(`,
   `?.openAssistantRound(`, `?.closeRound(`,
   `?.closeAssistantRound(` — optional-chained stamp calls.
   Every call site MUST be unconditional (`this.activeRuntime.stampX(…)`)
   on a NON-OPTIONAL field.
2. `?? { round_id:` literal-fallback expressions of any shape
   (with or without subsequent `message_index`/`block_index`).
3. `RoundStamp`-shaped object literals (`{ round_id: '…', message_index: …, block_index: … }`)
   appearing **outside** `src/runtime/active-runtime.ts` and
   `src/agents/session-persistence.ts`. The only producers of
   `RoundStamp` literals are these two files (and test
   helpers explicitly named in Item 4).
4. Local `private stampInRound`, `private stampUserMessage`,
   `private openAssistantRound`, `private closeAssistantRound`,
   `private stampDiagnosticInCurrentRound` methods on any
   class outside `ActiveRuntime` itself.
5. `legacyConversationEntry`, `legacyAgentMessage`, or any
   other helper that synthesizes a stamped message from an
   un-stamped on-disk row at read time.
6. `safeParse`-then-fallback patterns where the fallback
   constructs a synthetic stamped row. `agentMessageSchema.parse(…)`
   only; legacy rows are read errors at the PR tip.

The verification grep at the PR tip (§"Validation gate") fails
the PR if any of the above patterns appears.

## Remediation items

### Item 1 — `AnalystHandler.activeRuntime` becomes required

**Files**: `src/agents/analyst-handler.ts`, every test file that
constructs `AnalystHandler` directly or via `getAnalystHandler`.

Change the field declaration at L186 from
`private activeRuntime?: ActiveRuntime;` to
`private readonly activeRuntime: ActiveRuntime;`. Change the
constructor signature at L193 to make `activeRuntime` the
second parameter (after `projectRoot`) and **required**, with
no `?`. Update `getAnalystHandler` (L434) and its options bag
(L426) so that `activeRuntime` is required, not optional.
Adjust every caller in `src/server/routes/`, `src/runtime/`,
and tests accordingly.

Every callsite L226, L232, L241, L254, L261, L334, L340, L348,
L352, L387, L391 MUST become an **unconditional** stamp call:

```ts
appendMessage(
  saivageDir(this.projectRoot),
  sessionId,
  { role: 'user', kind: 'text', content: userContent },
  this.activeRuntime.stampUserMessage(sessionId),
  this.activeRuntime,
);
```

No `?.`, no `??` fallback. The `RoundStamp` source is
`active-runtime.ts` exclusively.

**Acceptance**:

```
git grep -nE 'activeRuntime\?\.stamp|activeRuntime\?\.openAssistantRound|activeRuntime\?\.closeRound|activeRuntime\?\.closeAssistantRound' src/ | wc -l   # → 0
git grep -nE '\?\?\s*\{\s*round_id' src/ web/src/ | wc -l                                                                                       # → 0
```

### Item 2 — `compaction.ts` activeRuntime is required

**Files**: `src/agents/compaction.ts`.

`compactSession(...)` MUST take `activeRuntime: ActiveRuntime`
as a required argument and call
`activeRuntime.stampCompacted(sessionId)` for the summary row,
and whatever `activeRuntime.stamp…` method best fits the
truncation row (either `stampCompacted` reused, or a new
`stampTruncated(sessionId)` added to `ActiveRuntime` —
harness's choice). The compaction module MUST NOT carry an
optional activeRuntime; callers plumb it in.

Update every caller of `compactSession` to forward
`activeRuntime` from their own constructor / receiver.

**Acceptance**: `git grep -nE 'activeRuntime\?' src/agents/compaction.ts | wc -l` → 0.

### Item 3 — `FakeAgent` routes through ActiveRuntime

**Files**: `src/agents/fake-agent.ts`, `src/agents/fake-agent.test.ts`
(or wherever FakeAgent is constructed in tests + fixtures).

Delete `private openAssistantRound` (L76),
`private stampInRound` (L77), `private closeAssistantRound`
(L78), and `fixtureRoundCounters` / `fixtureBlockCounters`
fields. Add `activeRuntime: ActiveRuntime` to `FakeAgent`'s
constructor (required), store it as
`private readonly activeRuntime`. Every previous call to
`this.stampInRound(sid)` becomes
`this.activeRuntime.stampInRound(sid)`; ditto
`openAssistantRound` / `closeAssistantRound` →
`this.activeRuntime.openAssistantRound(sid)` /
`this.activeRuntime.closeRound(sid)` (note: `ActiveRuntime`
already exposes `closeRound` at `active-runtime.ts:186`, not
`closeAssistantRound` — use the existing name).

FakeAgent test fixtures must construct a real `ActiveRuntime`
(see Item 4) and pass it in.

**Acceptance**:

```
git grep -nE 'private (stampInRound|openAssistantRound|closeAssistantRound|stampUserMessage|stampPre|stampCompacted|stampDiagnosticInCurrentRound)' src/ | grep -v 'src/runtime/active-runtime\.ts' | wc -l   # → 0
git grep -nE 'this\.stampInRound|this\.openAssistantRound|this\.closeAssistantRound' src/agents/fake-agent.ts | wc -l   # → 0
```

### Item 4 — Test infrastructure: `createTestActiveRuntime`

**Files**: NEW `tests/helpers/test-active-runtime.ts` (Jest
suite) and NEW `web/src/__tests__/helpers/test-active-runtime.ts`
if the web suite ever needs one (it should not — web tests do
not exercise the server-side ActiveRuntime).

The Jest helper exports a single factory:

```ts
export function createTestActiveRuntime(opts?: {
  projectRoot?: string;
  eventBus?: EventBus;
}): ActiveRuntime;
```

**Preferred** implementation: return a real `ActiveRuntime`
instance constructed via the same code path the production
runtime uses (this avoids interface drift the next time
ActiveRuntime gains a method). A `class TestActiveRuntime implements ActiveRuntime`
fallback is permitted ONLY if the real constructor cannot be
driven from a Jest test (file an ADR if so). Whichever path,
the returned object MUST satisfy
`activeRuntime.stampUserMessage(sid)`,
`activeRuntime.stampInRound(sid)`,
`activeRuntime.stampPre(sid)`,
`activeRuntime.stampCompacted(sid)`,
`activeRuntime.stampDiagnosticInCurrentRound(sid)`,
`activeRuntime.openAssistantRound(sid)`,
`activeRuntime.closeRound(sid)`, and the `runtime.eventBus`
field used by `broadcastToolInvocation`.

Migrate every test file that currently passes
`{ runtime: { eventBus } } as never` (or any partial mock) to
the new helper. The known site is
`tests/server/analyst-tool-invoked-broadcast.test.ts` lines 77,
93, 107, 122, 135; the harness MUST grep
`git grep -nE '\{ runtime: \{ eventBus \} \} as never' tests/`
and migrate ALL hits.

**Acceptance**:

```
git grep -nE '\{ runtime: \{ eventBus \} \} as never' tests/ | wc -l   # → 0
npx jest tests/server/analyst-tool-invoked-broadcast.test.ts            # → exit 0
```

### Item 5 — `runtime.ts` internal stamp calls

**Files**: `src/runtime/runtime.ts`.

Lines 261 and 412 emit hard-coded `RoundStamp` literals. Both
sites are inside the `Runtime` class which owns the
`ActiveRuntime` instance.

- L261 (`synthesizeTerminalActivationResult` →
  `appendActivateCardToolResultOnce`): replace the literal
  `{ round_id: 'r-diagnostic-1', message_index: 0, block_index: 0 }`
  with `this.activeRuntime.stampDiagnosticInCurrentRound(sessionId)`.
- L412 (`appendPlannerResumeContext` → `appendMessage`):
  replace the literal
  `{ round_id: 'r-user-1', message_index: 0, block_index: 0 }`
  with `this.activeRuntime.stampUserMessage(plannerSessionId)`,
  and pass `this.activeRuntime` as the final argument to
  `appendMessage`.

If `Runtime` does not currently hold an `activeRuntime` field
(the runtime constructs the ActiveRuntime but may not store
it), add a private `readonly activeRuntime: ActiveRuntime`
field set during construction and use it at both sites.

**Acceptance**:

```
git grep -nE "\{\s*round_id:\s*'r-(diagnostic|user|assistant|pre|compacted|truncated)" src/ web/src/ | grep -v 'src/runtime/active-runtime\.ts\|src/agents/session-persistence\.ts\|tests/helpers/' | wc -l   # → 0
```

### Item 6 — `runtime-config-notes.ts` legacy parsing dies

**Files**: `src/server/routes/runtime-config-notes.ts`.

Delete `legacyConversationEntry` (L24). Replace
`readConversationEntries` (L24+) with:

```ts
function readConversationEntries(projectRoot: string, sessionId: string): AgentMessage[] {
  const messagesPath = join(projectRoot, '.saivage', 'agents', 'messages', `${sessionId}.jsonl`);
  if (!existsSync(messagesPath)) return [];
  const out: AgentMessage[] = [];
  for (const line of readFileSync(messagesPath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    out.push(agentMessageSchema.parse(JSON.parse(line)));
  }
  return out;
}
```

A malformed on-disk line at the PR tip is a 500. The
architecture-first rule overrides the "tolerate legacy"
instinct: there is no legacy on-disk format at the PR tip.

**Acceptance**:

```
git grep -nE 'legacyConversationEntry|legacyAgentMessage' src/ | wc -l                              # → 0
git grep -nE '\.safeParse\(' src/server/routes/runtime-config-notes.ts | wc -l                  # → 0 (renamed helper still fails this gate)
```

### Item 7 — Adapter signature: paired tool messages

**Files**: `web/src/components/chat/tool-chip-adapter.ts`,
`web/src/components/chat/AnalystChatPanel.vue`, all
`__tests__/chat/` that exercise the adapter.

Change the adapter signature to:

```ts
export function adaptChatMessageToToolChip(
  call: ChatMessage,
  result: ChatMessage | null,
  expanded: boolean,
): ToolChipPropsBag;
```

The function preconditions: `call.kind === 'tool_call'`;
if `result !== null` then
`result.kind === 'tool_result' || result.kind === 'tool_error'`
and `result.tool_call_id === call.tool_call_id` (or whatever
the existing pairing key is). Throw on violation.

Body:

```ts
const callPres = presentToolCall(call.content, call.tool);
const resultPres = result
  ? presentToolResult(result.content, { tool: result.tool, kind: result.kind })
  : null;
return {
  call: callPres,
  result: resultPres,
  callContent: call.content,
  resultContent: result?.content ?? null,
  status: result ? resultPres!.status : 'pending',
  expanded,
  detailsId: `chat-tool-${call.id}`,
  timestamp: call.timestamp,
};
```

`adaptPendingInvocationToToolChip` keeps its current signature.

In `AnalystChatPanel.vue`, pre-pair the on-screen chat messages
into `{ call, result }` tuples (a computed property
`pairedToolMessages`) and feed
`<ToolChip v-bind="adaptChatMessageToToolChip(pair.call, pair.result, expandedIds.has(pair.call.id))" />`.
Loose `tool_result` messages without a matching `tool_call`
(should not happen at the F03 PR tip) are an assertion failure
in the computed, not silently rendered.

**Acceptance**:

```
git grep -nE 'adaptChatMessageToToolChip\(' web/src/ | grep -vE 'adaptChatMessageToToolChip\([^,]+,[^,]+,[^)]+\)' | wc -l   # → 0 (every call has 3 args)
```

### Item 8 — `AnalystChatPanel.vue` adopts RoundCard timeline

**Files**: `web/src/components/chat/AnalystChatPanel.vue`,
`web/src/__tests__/chat/AnalystChatPanel*.test.ts`,
`web/src/__tests__/read-only-positive-checklist.test.ts`.

Migrate the panel from flat-message rendering to the same
RoundCard timeline used by `AgentConversationView.vue`. Use
`useAgentTimeline.ts` to derive `rounds` from
`chatStore.messages`, then render
`<RoundCard v-for="round in rounds" :round="round" … />` in
place of the flat `<div class="message-row">` loop at L40–L50.

Delete the v2 monolithic marker classes from the panel
template: `state-panel`, `on-screen-section`,
`message-bubble`, `message-badges`, `pending-tool`,
`chat-composer`, `composer-input`, `primary-btn`. Use the
post-F03 token-driven utility classes that AgentConversationView
uses (RoundCard already styles itself; the composer becomes a
small composer component or inlined with new utility classes
named per design tokens — harness picks names; they MUST NOT
collide with the v2 marker set above).

Update the checklist test `read-only-positive-checklist.test.ts`
so its `agentConversationSource`-based assertions match the
new structure. Specifically, every assertion that checks for
`state-panel`, `message-bubble`, etc. inside chat / agents
sources MUST be replaced with assertions against THE SAME
markers `AgentConversationView.vue` exposes (`round-card`,
`tool-chip-toggle`, plus whatever the post-F03
AgentConversationView already asserts via its own component
tests). The checklist and the AgentConversationView suite
MUST agree on a single source-of-truth marker set so both
panels stay in sync.

Pending-call rendering uses
`<PendingCallFooter>` (per design §7.4) inside the appropriate
round, with chips built via
`adaptPendingInvocationToToolChip(pending, expanded)`.

**Acceptance**:

```
git grep -nE 'class="(state-panel|on-screen-section|message-bubble|message-badges|pending-tool|chat-composer|composer-input|primary-btn)"' web/src/components/chat/AnalystChatPanel.vue | wc -l   # → 0
git grep -nE 'RoundCard\b' web/src/components/chat/AnalystChatPanel.vue | wc -l   # ≥ 1
npm --prefix web run test -- --run                                                  # → exit 0
```

### Item 9 — Producer-audit grep gate is the merge gate

**Files**: NEW `scripts/check-stamp-producers.sh` (bash) wired
into `npm run check:stamp-producers` (root `package.json`)
and called from the existing root `npm test` pre-step or
`npm run lint` (harness chooses; the script MUST run as part
of the merge gate).

The script runs the verification greps from §"Validation gate"
below and exits non-zero on any hit. This locks the
architecture: future regressions to `?.stampX` or
hard-coded RoundStamp literals fail CI.

**Acceptance**: `npm run check:stamp-producers` exits 0 at the
PR tip; exits non-zero if any forbidden pattern is reintroduced.

## Files / tests / docs to DELETE

- All `?? { round_id: 'r-…', message_index: …, block_index: … }`
  fallback literals in `src/agents/analyst-handler.ts` (11
  callsites enumerated in mailbox-015 grep output).
- All `?.` chains on stamp methods (same 11 sites + any
  callsite elsewhere matched by the grep).
- `FakeAgent.openAssistantRound`, `FakeAgent.stampInRound`,
  `FakeAgent.closeAssistantRound`, plus their counter fields.
- `legacyConversationEntry` and its callsite in
  `runtime-config-notes.ts`.
- Hard-coded `{ round_id: 'r-diagnostic-1', … }` at
  `runtime.ts:261`; hard-coded `{ round_id: 'r-user-1', … }`
  at `runtime.ts:412`.
- All `{ runtime: { eventBus } } as never` mocks in `tests/`.
- All `state-panel|on-screen-section|message-bubble|message-badges|pending-tool|chat-composer|composer-input|primary-btn`
  markers in `web/src/components/chat/AnalystChatPanel.vue`.
- Singular-argument call sites of
  `adaptChatMessageToToolChip(message, expanded)` — every call
  becomes paired.

No alias period; no `@deprecated` re-export; no migration shim.
This applies to source AND tests AND fixtures.

## Validation gate (PR tip)

The PR tip MUST pass ALL of:

### Static (greps)

```bash
# Forbidden patterns
git grep -nE 'activeRuntime\?\.stamp|activeRuntime\?\.openAssistantRound|activeRuntime\?\.closeRound|activeRuntime\?\.closeAssistantRound' src/ web/src/ tests/ | tee /dev/stderr | wc -l   # → 0
git grep -nE '\?\?\s*\{\s*round_id' src/ web/src/ tests/                                                                                                       | tee /dev/stderr | wc -l   # → 0
git grep -nE "\{\s*round_id:\s*'r-(diagnostic|user|assistant|pre|compacted|truncated)" src/ web/src/ \
  | grep -vE 'src/runtime/active-runtime\.ts|src/agents/session-persistence\.ts|tests/helpers/'                                                                | tee /dev/stderr | wc -l   # → 0
git grep -nE 'private (stampInRound|openAssistantRound|closeAssistantRound|stampUserMessage|stampPre|stampCompacted|stampDiagnosticInCurrentRound)' src/ \
  | grep -v 'src/runtime/active-runtime\.ts'                                                                                                                   | tee /dev/stderr | wc -l   # → 0
git grep -nE 'legacyConversationEntry|legacyAgentMessage'                                            src/ web/src/ tests/                                     | tee /dev/stderr | wc -l   # → 0
git grep -nE '\.safeParse\(' src/server/routes/runtime-config-notes.ts                                                                                       | tee /dev/stderr | wc -l   # → 0
git grep -nE '\{ runtime: \{ eventBus \} \} as never'                                                tests/                                                   | tee /dev/stderr | wc -l   # → 0
git grep -nE 'class="(state-panel|on-screen-section|message-bubble|message-badges|pending-tool|chat-composer|composer-input|primary-btn)"' web/src/components/chat/AnalystChatPanel.vue | tee /dev/stderr | wc -l   # → 0
git grep -nE 'RoundCard\b'                                                                           web/src/components/chat/AnalystChatPanel.vue    | tee /dev/stderr | wc -l   # ≥ 1
# Adapter arity
git grep -nE 'adaptChatMessageToToolChip\(' web/src/                                                                                                  | grep -vE 'adaptChatMessageToToolChip\([^,]+,[^,]+,[^)]+\)' | wc -l   # → 0
```

### Build + tests

- `npx tsc -p . --noEmit` (root) → exit 0.
- `npm --prefix web run typecheck` → exit 0.
- `npm test` (root, full Jest, NOT a focused subset) → exit 0.
  Includes `tests/server/analyst-tool-invoked-broadcast.test.ts`.
- `npm --prefix web run test -- --run` → exit 0. Includes
  `read-only-positive-checklist.test.ts`, the `ToolChip` /
  `AnalystChatPanel` / `AgentConversationView` suites.
- `npm --prefix web run build` → exit 0.
- `npm run docs:verify` → exit 0.
- `npm run check:stamp-producers` → exit 0.
- Playwright smoke (per prior delta §Item 6) → exit 0.

### Runtime probe (LXC saivage-v3 @ 10.0.3.112:8080)

After `systemctl restart saivage.service`:

- `curl -fsS http://10.0.3.112:8080/health` → 200.
- Drive one real planner round end-to-end; confirm:
  - JSONL on disk has stamped `round_id` / `message_index` /
    `block_index` for every row (no `r-assistant-1` /
    `r-user-1` fallback markers from this proposal's
    forbidden set).
  - `AgentConversationView` renders RoundCard timeline.
  - `AnalystChatPanel` renders RoundCard timeline (NEW vs.
    prior PR-tip).
  - ToolChip shows interactive parts as siblings of the
    toggle button, not nested.

Per-stage commits MAY be CI-red. Only the PR tip MUST be green.

## Implementation latitude (preserved)

The operator explicitly authorizes intermediate CI-red states
between stages inside this single mailbox cycle. The
all-or-nothing contract applies to the PR tip only. The
harness MUST NOT open the PR before reaching a green tip, and
MUST NOT archive this proposal to `done/` on a partial / red
landing. The Manager MUST NOT attempt a direct-correction
"shortcut" patch that bypasses the staged-implementation
sequence; if a stage fails, the harness re-plans the stage
within this proposal's scope and continues.

## Risks / accepted residuals

- The `compactSession` and `FakeAgent` constructors gain
  required arguments. Every caller must be updated. The
  harness MUST grep `git grep -nE 'new FakeAgent\(|compactSession\(' src/ tests/`
  and update every call.
- `Runtime` may need to hold its `activeRuntime` as a stored
  field for Items 5 to work. The harness MUST verify the
  field exists and is populated before either appendMessage
  site fires; if not, add it.
- The checklist test `read-only-positive-checklist.test.ts`
  asserts source-text substrings of view files. Removing the
  v2 markers WILL break those assertions; the harness MUST
  also update the test to assert the new markers, otherwise
  the gate stays red.
- The `RoundCard` integration in `AnalystChatPanel` may
  surface bugs in `useAgentTimeline.ts` not exposed by
  `AgentConversationView` (e.g., handling of pending
  invocations, sticky composer behavior). The harness MUST
  fix any such bugs inside the same PR; deferring is not
  allowed.

## Out of scope

- F04 chat-surface STYLE refinements beyond removing the v2
  marker set and adopting RoundCard. (F04 owns visual polish
  AFTER this PR lands.)
- The unrelated `2026-05-27-ci-fix-typescript-build-and-audit.md`
  mailbox entry continues independently.
- Any non-chat / non-agent feature work.

## Sequencing note

After this delta closes:

- F04 R3 becomes processable (eight-prop ToolChip + paired
  adapter + RoundCard panel + RoundCard timeline + producer
  audit all satisfied at HEAD).
- The producer-audit grep is locked behind
  `npm run check:stamp-producers`, preventing regression in
  future waves.

The harness MUST produce
`architecture-audit/mailbox-<NNN>-f03-pr-tip-round-2/classification.md`
identifying this as Branch B + delta, and
`stage-plan.md` with a 9-row coverage table (one row per
remediation item above).
