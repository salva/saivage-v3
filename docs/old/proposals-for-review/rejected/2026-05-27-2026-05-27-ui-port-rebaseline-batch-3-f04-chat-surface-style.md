# Design: UI port rebaseline batch 3 — F04 chat surface style against HEAD `eb98caf`

This is a **Branch B (design-included)** proposal under the
mailbox classification objective. The harness MUST NOT run a
dual-proposal review, MUST NOT vary the scope, MUST produce a
`stage-plan.md` with a deliverable→stage coverage table, and
MUST honour the nothing-lost invariant.

## Problem

The analyst chat surface (`web/src/components/chat/AnalystChatPanel.vue`)
is a 349-line monolith. F04 decomposes it into six SFCs + two
composables + one utility, on top of the F02 primitive layer and
the F03 round-timeline pipeline. Without this batch, the chat
surface cannot be restyled to the v2 visual language and the
forbidden-family selectors stay alive.

## Preconditions

R1
([2026-05-27-ui-port-rebaseline-batch-1-f02-f05-completion.md](2026-05-27-ui-port-rebaseline-batch-1-f02-f05-completion.md))
and R2
([2026-05-27-ui-port-rebaseline-batch-2-f03-conversation-rounds.md](2026-05-27-ui-port-rebaseline-batch-2-f03-conversation-rounds.md))
must be merged before R3 starts. R3 hard-checks the following at
HEAD when picked up:

- `web/src/components/ui/*` primitives exist (Card, Button, Pill,
  Overlay, Spinner, StatusDot, PanelHeading) — from F02 partial
  or R1.
- `web/src/components/conversation/MessageBubble.vue` +
  `ThinkingDots.vue` exist (from R1).
- `web/src/components/conversation/ToolChip.vue` exposes the
  **eight-prop bag** with `callContent` AND `resultContent`
  (from R2). A 6- or 7-prop adapter does NOT satisfy this
  precondition.
- `web/src/components/chat/tool-chip-adapter.ts` exports
  `adaptChatMessageToToolChip(call, result, expanded)` AND
  `adaptPendingInvocationToToolChip(p, expanded)` (from R2).
- `web/src/utils/agent-timeline/*` + `useAgentTimeline.ts` exist
  (from R2).
- `AnalystChatPanel.vue` has had its inline `<button class="tool-chip">`
  markup deleted (from R2's chip swap; F03 plan §2.2 row 16 +
  commit 6).

If any precondition is missing, file a delta proposal or reject
via `<basename>.decision.md` — do not decompose a flat
(non-round) panel or one that still hosts inline chip markup.

## Decision (binding contract)

The implementation contract is:

- F04 analysis r3, design r2, plan r2 under
  [SPEC/2026-05/review-ui-port-from-v2/F04-chat-surface-style/](../SPEC/2026-05/review-ui-port-from-v2/F04-chat-surface-style/).
- The rebaseline addendum:
  [F04-chat-surface-style/04-rebaseline-against-HEAD-r2.md](../SPEC/2026-05/review-ui-port-from-v2/F04-chat-surface-style/04-rebaseline-against-HEAD-r2.md)
  (APPROVED — see sibling `REBASELINE-APPROVED.md`).

The R3 batch implements §3 (Type surface / Consumer audit /
Composables / Utility / SFCs / Rewrite / Tests / Merge gate) of
the rebaseline addendum. The class-rename table in F04 plan r2
§0.1 is binding and applies verbatim to the design r2 §1.3–§1.8
SFC sketches.

## Files to change

The full inventory is the rebaseline addendum §3. Compact
summary:

- **Type surface (B0)**:
  - `web/src/api/types.ts` — add `export interface PendingToolInvocation { … }`
    verbatim from design r2 §1.1.1; extend `ChatMessage` with
    optional `provider?`, `model?`, `modelSpec?`,
    `requestedModelSpec?`.
  - `web/src/stores/analystChat.ts` — delete local
    `PendingToolInvocation` declaration; add
    `import type { PendingToolInvocation } from '../api/types';`.
- **Consumer audit (B1)**: grep verification (no code change
  expected — analysis r3 §2 says zero external consumers).
- **Composables (B2)**:
  - `web/src/composables/useDebouncedConnectionState.ts`
    (signature accepts `Readonly<Ref<…>> | Ref<…>`;
    `TO_OPEN_IMMEDIATE = ['connected'] as const`;
    `DEBOUNCE_MS = 400`).
  - `web/src/composables/useStickToBottom.ts` (`thresholdPx = 60`;
    `markIncoming()`; `jumpToLatest()`).
- **Utility (B3)**:
  - `web/src/utils/model-label.ts` exporting `modelLabel(msg, defaultModelSpec)`
    and `shortModelLabel(msg)`. Header comment states the B2
    gate contract.
- **Six SFCs (B4)** under `web/src/components/chat/`:
  - `UnauthorizedNotice.vue` (design r2 §1.8).
  - `JumpToLatest.vue` (design r2 §1.6).
  - `ChatHeader.vue` (design r2 §1.3; P1: no `unauthorized` prop).
  - `ChatComposer.vue` (design r2 §1.7; **§0.1 renames**:
    `composer-form` NOT `chat-composer`; `composer-textarea` NOT
    `composer-input`).
  - `MessageItem.vue` (design r2 §1.5; **§0.1 rename**:
    `badge-stack` NOT `message-badges`).
  - `MessageList.vue` (design r2 §1.4; **§0.1 rename**:
    `pending-invocations` NOT `pending-tool-list`; the
    `data-testid="pending-tool-list"` attribute is preserved as
    a TEST identifier; B3 resize-emit invariant binding; C1:
    `on-screen-children` class kept + testid added).
- **Rewrite (B5)**:
  - `web/src/components/chat/AnalystChatPanel.vue` —
    rewrite the 349-line monolith to the design r2 §1.2
    container script + template verbatim. Local
    `thinking = computed(...)` derivation (B1 resolution; no
    `thinking` field on the store). `expandedIds` set,
    `pendingFooterEl` ref proxy, `useDebouncedConnectionState`
    wire, `<UnauthorizedNotice v-if="unauthorized">` on the
    `#state` slot of `<MessageList>` (P1).
- **Tests (B6)**: ~12 new test files per rebaseline §3.7,
  including `MessageList.resize.test.ts` for the B3 invariant
  cases and `AnalystChatPanel.children.test.ts` for the C1 +
  raw-source guard cases. Existing
  `web/src/__tests__/analyst-chat-panel.test.ts` rewritten to
  query the decomposed `data-testid` set per design r2 §1.13.

## Files / tests / docs to DELETE

- The 349-line monolithic body of
  `web/src/components/chat/AnalystChatPanel.vue` (replaced by
  the design r2 §1.2 container script + template in B5).
- All hex literals and all eight forbidden selector families in
  the rewritten chat-surface SFCs (`tool-chip`, `message-bubble`,
  `primary-btn`, `chat-composer`, `composer-input`,
  `pending-tool-` (any suffix), `message-badges`, `state-panel`,
  `on-screen-section`).
- Local `PendingToolInvocation` declaration in
  `web/src/stores/analystChat.ts` (replaced by the
  `api/types.ts` export).

No alias period, no parallel old+new class names at any HEAD.

## Validation gate

The R3 PR tip must satisfy:

- F04 plan r2 §5 + §9 merge-gate (full nine-family regex):
  ```
  rg -n "(tool-chip|message-bubble|primary-btn|chat-composer|composer-input|pending-tool-|message-badges|state-panel|on-screen-section)" web/src/components/chat/
  ```
  returns zero matches.
- `npm --prefix web run typecheck && npm --prefix web run test -- --run && npm --prefix web run build`.
- Per-batch (B0–B7) acceptance commands per F04 plan r2 §5.
- Hex-literal scan in `web/src/components/chat/` returns zero
  hits.
- Live UI probe of the analyst chat surface on
  `saivage-v3-getrich-v2` (10.0.3.170:8080): open the analyst
  view, confirm `ChatHeader` chip cluster + `MessageList` scroll
  body + `JumpToLatest` reveal + `ChatComposer` resize-to-content
  + send + `UnauthorizedNotice` (when token entry pending) all
  render via the new SFCs; resize the viewport to narrow
  (≤360px) and confirm `min-width: 0` containers don't blow out
  the layout (design r2 §1.12).

## Risks / accepted residuals

- The §0.1 class renames are NEW non-legacy identifiers, not
  aliases. The old classes (`chat-composer`, `composer-input`,
  `pending-tool-list`, `message-badges`) are deleted in the
  same commit (B5) that introduces the renamed classes
  (B4/B5); at no point in the PR's history do both the old and
  the new selector exist in the same HEAD.
- The `data-testid="pending-tool-list"` attribute is preserved
  even though the CSS class is renamed to `pending-invocations`.
  This keeps the test surface stable across the rename. The
  testid is a test identifier, not a CSS class, and is not
  subject to the §0.1 rename table.

## Sequencing note

This is the third of three mailbox batches. After R3 lands, the
UI port from v2 to v3 is complete per the metaplan §10 scope
boundary.

The harness MUST produce
`architecture-audit/mailbox-<NNN>-ui-port-rebaseline-batch-3/classification.md`
identifying this as Branch B, and
`architecture-audit/mailbox-<NNN>-ui-port-rebaseline-batch-3/stage-plan.md`
with a deliverable→stage coverage table whose union equals §3 of
the F04 rebaseline. The plan §4 batch sequence (B0–B7) is the
canonical decomposition.

## Out of scope

- Any backend change (R3 is web-only).
- Any modification of conversation primitives (`MessageBubble`,
  `ThinkingDots`, `ToolChip`, `RoundCard`, etc.) — those belong
  to F02 R1 / F03 R2.
- Any change to the F03 round-timeline pipeline.
- Adding a `useChatSurface` wrapper or any helper not listed in
  the F04 design r2 (Proposal A is the binding choice; no
  improvements, no extra abstractions).
- Storybook / component gallery; theming system; per-user
  palette (all under METAPLAN §10 out-of-scope).
