# F04 — Rebaseline against HEAD `eb98caf` (r2)

Writer round 2. Addresses the reviewer findings on r1
(fabricated composable / utility names, missing
`UnauthorizedNotice.vue`, missing B0/B1 type-surface edits,
weakened merge-gate regex). This document supersedes
[04-rebaseline-against-HEAD-r1.md](04-rebaseline-against-HEAD-r1.md).

This is a **binding addendum** to the F04 approved artifacts:

- analysis: [01-analysis-r3.md](01-analysis-r3.md)
- design:   [02-design-r2.md](02-design-r2.md)
- plan:     [03-plan-r2.md](03-plan-r2.md)

The approved analysis, design, and plan are unchanged. F04 has
shipped nothing at HEAD. A reader who has never seen earlier
review rounds can implement F04 by combining the approved design
+ plan + this rebaseline.

The implementer MUST NOT silently descope any plan row, MUST NOT
re-introduce any of the eight forbidden selector families, and
MUST follow the nothing-lost invariant in §6.

---

## 1. HEAD reference

- Commit: `eb98caf` (`master`).
- F04 landing status at HEAD: **nothing landed.** Verified:
  - `wc -l web/src/components/chat/AnalystChatPanel.vue` reports
    349 lines (monolithic).
  - `ls web/src/components/chat/` returns only
    `AnalystChatPanel.vue` and `AnalystToaster.vue`. No
    `ChatHeader.vue`, `MessageList.vue`, `MessageItem.vue`,
    `ChatComposer.vue`, `JumpToLatest.vue`, `UnauthorizedNotice.vue`.
  - `test ! -e web/src/composables/useDebouncedConnectionState.ts`
    passes. `test ! -e web/src/composables/useStickToBottom.ts`
    passes.
  - `test ! -e web/src/utils/model-label.ts` passes.
  - `git grep -n 'export.*PendingToolInvocation' web/src/api/types.ts`
    returns 0 hits (the type is still private to the analyst
    store per plan B0).
  - `git grep -n "provider?:\|modelSpec?:\|requestedModelSpec?:" web/src/api/types.ts`
    returns 0 hits on `ChatMessage` (plan B0 extension missing).

---

## 2. Cross-batch preconditions

The F04 plan was written assuming:

1. **F02 rebaseline R1 has landed** — `Card`, `Button`, `Pill`,
   `Overlay`, `Spinner`, `StatusDot`, `PanelHeading`,
   `MessageBubble`, `ThinkingDots` exist on the F02 design §1.3
   contract.
2. **F03 rebaseline R2 has landed** — the eight-prop `ToolChip`
   (with `callContent` / `resultContent`) is shipped per F03
   plan §2.1 + design §7.2; `tool-chip-adapter.ts` exports
   `adaptChatMessageToToolChip(call, result, expanded)` and
   `adaptPendingInvocationToToolChip(p, expanded)` (F03 plan
   §2.1 binds F04 design r2 §1.10); the round-timeline pipeline
   (`web/src/utils/agent-timeline/*`, `useAgentTimeline`) exists;
   `AnalystChatPanel.vue` has had its inline `<button class="tool-chip">`
   markup and local `ChipParts` deleted in F03 commit 6.

The F02 R1 + F03 R2 PRs land before F04 R3 begins. The chip-swap
inside `AnalystChatPanel.vue` is owned by F03 (plan §2.2 row 16 +
§3 commit 6), not F02; F04 inherits a chip-swapped panel.

If either precondition is missing at the moment the harness
picks up F04, the harness MUST file a delta proposal or reject
via `.decision.md`. F04 MUST NOT decompose a flat (non-round)
chat surface or a panel that still hosts the inline tool-chip
markup.

---

## 3. Remaining deliverables (IN SCOPE)

The F04 plan §3 file inventory + §4 batch sequence apply
verbatim. Restated:

### 3.1 Type surface (plan batch B0)

| Edit | Path | Contract |
| --- | --- | --- |
| Add `export interface PendingToolInvocation { … }` verbatim | `web/src/api/types.ts` | design r2 §1.1.1 |
| Extend `ChatMessage` with optional `provider?`, `model?`, `modelSpec?`, `requestedModelSpec?` | `web/src/api/types.ts` | design r2 §1.11 |
| Delete local `PendingToolInvocation` declaration | `web/src/stores/analystChat.ts` | design r2 §1.1.1 |
| Add `import type { PendingToolInvocation } from '../api/types';` | `web/src/stores/analystChat.ts` | design r2 §1.1.1 |

### 3.2 Consumer audit (plan batch B1)

A grep verification, not a code change. Confirm no consumer
outside `analystChat.ts` imports the (now-removed) local
`PendingToolInvocation`. If any consumer exists, rewrite its
import to `api/types` in this batch. Per analysis r3 §2 and
design r2 §1.1.1 the expected count is zero.

### 3.3 Composables (plan batch B2)

| Path | Contract |
| --- | --- |
| `web/src/composables/useDebouncedConnectionState.ts` | design r2 §1.9; signature accepts `Readonly<Ref<WsConnectionState>> \| Ref<WsConnectionState>` (P2 fix); `TO_OPEN_IMMEDIATE = ['connected'] as const`; `DEBOUNCE_MS = 400`; `onUnmounted(clear)` clears timer |
| `web/src/composables/useStickToBottom.ts` | design r2 §1.9; `thresholdPx = 60` default; `markIncoming()` schedules `scrollTop = scrollHeight` on `nextTick` when stuck or bumps `unseen` otherwise; `jumpToLatest()` async, resets `unseen = 0` and `stuck = true` before scroll write |

### 3.4 Utility (plan batch B3)

| Path | Contract |
| --- | --- |
| `web/src/utils/model-label.ts` exporting `modelLabel(msg, defaultModelSpec)` and `shortModelLabel(msg)` | design r2 §1.11 |

`modelLabel` returns `null` when the message is not an assistant
message, when no spec is available, or when the spec equals the
default AND no `requestedModelSpec` is set. `shortModelLabel`
returns the substring after the last `/` (or the whole spec when
no `/`), or `null` for non-assistant. Header comment states the
B2 gate contract (callers gate on `modelLabel(...)` first).

### 3.5 Six chat-surface SFCs (plan batch B4)

Implementation order per plan §4 batch B4. Bodies are design r2
§1.3–§1.8 verbatim with the §0.1 identifier substitutions
applied.

| Path | Contract |
| --- | --- |
| `web/src/components/chat/UnauthorizedNotice.vue` | design r2 §1.8; emits `openTokenEntry` |
| `web/src/components/chat/JumpToLatest.vue` | design r2 §1.6; props `unseen`, `bottomOffsetPx`; emits `jump` |
| `web/src/components/chat/ChatHeader.vue` | design r2 §1.3; props `sessionId`, `connectionState`, `sessionsLoading`, `sessionsError` (P1: no `unauthorized` prop); composes `PanelHeading`, `Pill`, `StatusDot`, `Card`, `Spinner` |
| `web/src/components/chat/ChatComposer.vue` | design r2 §1.7; owns textarea + `resizeInput()` + keydown matrix + Send button (`<Button variant="primary" data-testid="analyst-send">`); exposes `focus()` via `defineExpose`; emits `update:draft`, `submit`, `resize`. **§0.1 renames**: `<form>` root class `composer-form` (NOT `chat-composer`); `<textarea>` class `composer-textarea` (NOT `composer-input`); scoped CSS rules renamed to match |
| `web/src/components/chat/MessageItem.vue` | design r2 §1.5; branches on `item.kind` ('tool_pair' → `<ToolChip v-bind="adaptChatMessageToToolChip(item.call, item.result, expanded)" @toggle="…" />`; 'message' → `<MessageBubble>` + role-conditional content; model-pill `<Pill data-testid="model-pill">` gated on `modelLabel(...) !== null` (B2 gate); visible text is `shortModelLabel(...)`, `title` is `modelLabel(...)`). **§0.1 rename**: badge `<ul>` class `badge-stack` (NOT `message-badges`); scoped CSS renamed |
| `web/src/components/chat/MessageList.vue` | design r2 §1.4; owns scroll body, `<section class="on-screen-children" data-testid="on-screen-children">` (C1: class kept + testid added), state Cards (loading/unauthorized/other-error/empty), `<MessageItem v-for>`, `<ThinkingDots data-testid="thinking-dots">` footer when `thinking === true`, pending-tool footer with one `<ToolChip>` per pending invocation via `adaptPendingInvocationToToolChip(p, expandedIds.has(p.id))`, `useStickToBottom(scrollEl)` integration, lazy `ResizeObserver` on the pending footer. **B3 invariant** binding: a `watch` on `pendingTools.length === 0` synchronously emits `resize: 0` on transition-to-empty AND on mount when already empty; element watcher emits `resize: 0` on element unmount. **§0.1 rename**: pending-footer `<section>` class `pending-invocations` (NOT `pending-tool-list`); scoped CSS renamed; the `data-testid="pending-tool-list"` attribute is preserved (testid stable across class rename). `defineExpose({ jumpToLatest: stick.jumpToLatest })` |

Per-file checklist (binding for every SFC):

- No hex literals; all colours flow from F01 tokens.
- No class matches the §0.1 / §5 / §9 forbidden-family regex
  (after §0.1 renames applied).
- Every flex/grid container with potentially wide content
  declares `min-width: 0` (design r2 §1.12).
- All `data-testid` values match design r2 §1.13 verbatim,
  including `pending-tool-list` on the renamed
  `.pending-invocations` section.
- `<script setup lang="ts">` only.

### 3.6 `AnalystChatPanel.vue` rewrite (plan batch B5)

Replace the monolithic file body (349 lines at HEAD) with the
design r2 §1.2 container script + template verbatim. The
container:

- Imports the six SFCs from §3.5 and the two composables from
  §3.3 and the utility from §3.4.
- Derives `thinking = computed(() => sending.value || pendingToolInvocationsForActiveSession.value.length > 0)`
  locally (B1 resolution; the store does NOT carry a `thinking`
  field).
- Owns the `expandedIds` set, the `pendingFooterEl` ref proxy,
  the `useDebouncedConnectionState(connectionState)` wire, and
  the `<UnauthorizedNotice>` mount guarded by `v-if="unauthorized"`
  on the `#state` slot of `MessageList` (P1: the unauthorized
  state is rendered by the container, not by `ChatHeader`).
- Composes the children: `<ChatHeader>`, `<MessageList ref="listEl">`,
  `<JumpToLatest v-if="…">`, `<ChatComposer ref="composerEl">`.
- Retains the existing import path (consumers under
  `AppShell.vue` and `cards/CardDetailView.vue#L491` keep their
  imports unchanged); the rewrite is in-place.
- Deletes every hex literal and every forbidden-family class in
  the same commit. The eight forbidden families are: `tool-chip`,
  `message-bubble`, `primary-btn`, `chat-composer`,
  `composer-input`, `pending-tool-` (any suffix), `message-badges`,
  `state-panel`, `on-screen-section` (the design r2 §1.2 deletion
  list, plus the `chat-composer` family added by R1 of plan r2).

### 3.7 Tests (plan batch B6)

The full test inventory in design r2 §1.13 + plan §6 applies.
Listed compactly:

- `web/src/__tests__/composables/useDebouncedConnectionState.test.ts` — new.
- `web/src/__tests__/composables/useStickToBottom.test.ts` — new.
- `web/src/__tests__/utils/model-label.test.ts` — new.
- `web/src/__tests__/components/chat/ChatHeader.test.ts` — new.
- `web/src/__tests__/components/chat/ChatComposer.test.ts` — new.
- `web/src/__tests__/components/chat/MessageItem.test.ts` — new.
- `web/src/__tests__/components/chat/MessageList.test.ts` — new.
- `web/src/__tests__/components/chat/MessageList.resize.test.ts` — new (B3 invariant cases).
- `web/src/__tests__/components/chat/JumpToLatest.test.ts` — new.
- `web/src/__tests__/components/chat/UnauthorizedNotice.test.ts` — new.
- `web/src/__tests__/components/chat/AnalystChatPanel.children.test.ts` — new (C1 testid + raw-source guard cases).
- `web/src/__tests__/analyst-chat-panel.test.ts` — rewritten to query the decomposed `data-testid` set per design r2 §1.13 final table; the `.on-screen-children li` selector continues to work because the layout class is preserved (C1).

### 3.8 Forbidden-family merge gate (plan §0.1 + §5 / §9)

The PR merge gate runs:

```sh
rg -n "(tool-chip|message-bubble|primary-btn|chat-composer|composer-input|pending-tool-|message-badges|state-panel|on-screen-section)" web/src/components/chat/
```

and must return zero matches at the F04 PR tip. After the §0.1
renames are applied to design r2's verbatim sketches, no chat-surface
SFC class collides with this regex.

---

## 4. Reconciliation deliverables

None. F04 has not shipped any partial work.

---

## 5. Nothing-lost invariant (binding)

The harness MUST:

1. Read this rebaseline plus [02-design-r2.md](02-design-r2.md)
   and [03-plan-r2.md](03-plan-r2.md).
2. Produce a stage-plan whose stages cover every row in §3.1
   (B0), §3.2 (B1 audit), §3.3 (B2 composables), §3.4 (B3
   utility), §3.5 (B4 SFCs — all six, including
   `UnauthorizedNotice.vue`), §3.6 (B5 rewrite), and §3.7 (B6
   tests).
3. Hard-check §2 preconditions before starting. If F02 R1 or F03
   R2 has not landed (including the chip swap inside
   `AnalystChatPanel.vue` and the round-timeline pipeline), file
   a delta proposal or reject — do not decompose a flat or
   pre-chip-swap panel.
4. Apply §0.1 of the plan (renamed-class table) over every
   design r2 sketch. The implementer MUST NOT ship any of the
   forbidden-family classes under any layout root.
5. Run the §3.8 merge gate at PR tip; zero matches.
6. Verify the eight-prop `ToolChip` bag (with `callContent` /
   `resultContent`) exists at HEAD before B4 — a 6-prop or
   7-prop adapter does NOT satisfy the §2 precondition.

---

## 6. Stage-mapping suggestion (non-binding shape)

The plan §4 batch sequence is the canonical decomposition:

- Stage F4-S1 = batch B0 (type surface: `api/types.ts` + `analystChat.ts` edits).
- Stage F4-S2 = batch B1 (consumer audit; grep checkpoint).
- Stage F4-S3 = batch B2 (composables: `useDebouncedConnectionState.ts`, `useStickToBottom.ts`).
- Stage F4-S4 = batch B3 (utility: `model-label.ts`).
- Stage F4-S5 = batch B4 (six SFCs: `UnauthorizedNotice`, `JumpToLatest`, `ChatHeader`, `ChatComposer`, `MessageItem`, `MessageList`, in that order; §0.1 renames applied).
- Stage F4-S6 = batch B5 (`AnalystChatPanel.vue` rewrite to design r2 §1.2 verbatim).
- Stage F4-S7 = batch B6 (tests per §3.7).
- Stage F4-S8 = batch B7 (final-checklist verification: §3.8 merge gate, design r2 §1.12 narrow-rail layout assertions, hex-literal scan).

After Stage F4-S8: open PR.

If the harness picks a different decomposition, the entire §3
inventory must still be covered and the §3.8 gate must pass at
PR tip.

Note: the three-layer sequencing of `AnalystChatPanel.vue` (F02
R1 contributes nothing to this file; F03 R2 commits the chip swap
in commit 6; F04 R3 rewrites it wholesale in batch B5) is the
ordered chain F02 R1 → F03 R2 → F04 R3. F02 R1 and F03 R2 land as
two separate PRs (one per mailbox batch) before F04 R3 begins;
they are NOT interleaved.
