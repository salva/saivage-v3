# F04 — Rebaseline against HEAD `eb98caf` (r1)

This is a **binding addendum** to the F04 approved artifacts:

- analysis: [01-analysis-r3.md](01-analysis-r3.md)
- design:   [02-design-r2.md](02-design-r2.md)
- plan:     [03-plan-r2.md](03-plan-r2.md)

The approved analysis, design, and plan are unchanged. F04 has
nothing landed at HEAD. This rebaseline records the upstream
preconditions F04 now depends on (F02 rebaseline R1 + F03
rebaseline R2) and the small set of HEAD facts the implementer
needs.

The implementer MUST NOT silently descope any plan row, MUST NOT
introduce alias re-exports of the monolithic AnalystChatPanel
surface, and MUST follow the nothing-lost invariant in §5.

---

## 1. HEAD reference

- Commit: `eb98caf` (`master`).
- F04 landing status at HEAD: **nothing landed.**
- `web/src/components/chat/AnalystChatPanel.vue` is the 349-line
  monolith (verified by `wc -l`).
- `web/src/components/chat/` siblings at HEAD: only
  `AnalystChatPanel.vue` and `AnalystToaster.vue`. No
  `ChatHeader.vue`, `MessageList.vue`, `MessageItem.vue`,
  `ChatComposer.vue`, `JumpToLatest.vue`, no composables
  (`useChatScroll.ts`, `useChatMessages.ts`), no utility
  (`format-relative-time.ts` or equivalent named in plan §1.2).

---

## 2. Cross-batch preconditions

The F04 plan was written assuming:

1. **F02 rebaseline R1 has landed** — i.e. `Card`, `Button`,
   `Pill`, `Overlay`, `MessageBubble`, `ThinkingDots`, and the
   eight-prop `ToolChip` are present on the design-§1.3
   contract; `tool-chip-adapter.ts` and `analyst-timeline.ts`
   are present.
2. **F03 rebaseline R2 has landed** — i.e. the analyst chat
   surface already renders the round-timeline shape via
   `analyst-timeline.ts`. F04's `MessageList.vue` /
   `MessageItem.vue` decomposition extracts that round-timeline
   render into per-role / per-message components without
   reverting it to a flat list.

If either precondition is missing at the moment the harness
picks up the F04 mailbox entry, the harness MUST file a delta
proposal naming the missing precondition, OR reject the F04
batch via `.decision.md`. F04 MUST NOT be implemented on a flat
non-round chat surface; doing so would lose the F03 round-timeline
guarantee.

---

## 3. Remaining deliverables (IN SCOPE)

The F04 plan §1 + §2 sequence applies verbatim. Restated compactly:

### 3.1 Chat surface decomposition — plan §1.1 component rows

| Deliverable | Path | Binding contract |
| --- | --- | --- |
| `ChatHeader.vue` | `web/src/components/chat/ChatHeader.vue` | design [§3.1](02-design-r2.md#31-chatheader) |
| `MessageList.vue` (round-aware list; consumes the F03 timeline) | `web/src/components/chat/MessageList.vue` | design [§3.2](02-design-r2.md#32-messagelist) |
| `MessageItem.vue` (per-message, role-tone, embeds chip via adapter) | `web/src/components/chat/MessageItem.vue` | design [§3.3](02-design-r2.md#33-messageitem) |
| `ChatComposer.vue` (input + send + paste handling) | `web/src/components/chat/ChatComposer.vue` | design [§3.4](02-design-r2.md#34-chatcomposer) |
| `JumpToLatest.vue` (scroll-anchor reveal pill) | `web/src/components/chat/JumpToLatest.vue` | design [§3.5](02-design-r2.md#35-jumptolatest) |
| Composable `useChatScroll.ts` | `web/src/composables/useChatScroll.ts` | design [§4.1](02-design-r2.md#41-usechatscroll) |
| Composable `useChatMessages.ts` | `web/src/composables/useChatMessages.ts` | design [§4.2](02-design-r2.md#42-usechatmessages) |
| Utility `format-relative-time.ts` (or plan-named equivalent) | per plan §1.2 | design §4.3 |

### 3.2 AnalystChatPanel rewrite — plan §1.2 surface row

Rewrite `web/src/components/chat/AnalystChatPanel.vue` from a
349-line monolith into the design-§2 orchestrator shell that
composes the components in §3.1. The rewrite:

- Deletes every bespoke selector listed in plan analysis §4 for
  this file (`.message-bubble`, `.pending-tool-*`,
  `.tool-chip-*` chrome, `.chat-*` scaffolding).
- Retains the surface's external API (events emitted to the
  parent route view) on the exact contract recorded in
  design §2.5; no widening.
- Co-committed with the F02 plan C13 non-chip rewrite row
  (F02 rebaseline §3.5 row C13) AND the F03 plan
  `AnalystChatPanel` round-rewrite row (F03 rebaseline §3.3).
  These three rows describe the same file at three layers
  (primitives, round-timeline, decomposition). The order is:
  F02 R1 → F03 R2 → F04 R3. Each consecutive batch sees its
  predecessor's work already on HEAD.

### 3.3 Tests — plan §1.3 test rows + §3 full-suite gates

- Per-component tests for each row in §3.1, on the analysis §5
  cases.
- Selector-migration test rewrite for
  `web/src/__tests__/components/chat/analyst-chat-panel.test.ts`
  to query the decomposed `data-testid` set (analysis §5 final
  table).
- Composable unit tests for `useChatScroll` and
  `useChatMessages` (analysis §5.x).

### 3.4 Grep gates — plan §3 full-suite gates

The full-suite gates in F04 plan §3 apply verbatim:

```
git grep -nE '\.message-bubble|\.pending-tool-|\.chat-(header|composer|jump)' \
  web/src/ | wc -l   # MUST be 0
git grep -nE '<AnalystChatPanel' web/src/ | wc -l   # MUST be 1 (route mount)
git grep -nE 'wc -l.*AnalystChatPanel.vue'  # informational only
```

---

## 4. Reconciliation deliverables

None. F04 has not shipped any partial work. The chip-API and
round-timeline reconciliations are owned by F02 and F03
respectively.

---

## 5. Nothing-lost invariant (binding)

The harness MUST:

1. Read this rebaseline plus [02-design-r2.md](02-design-r2.md)
   and [03-plan-r2.md](03-plan-r2.md).
2. Produce a stage-plan that covers every row in §3.
3. Hard-check §2 preconditions before starting: if F02 R1 or F03
   R2 has not landed, file a delta proposal or reject — do not
   decompose the chat surface on a non-round substrate.
4. No "minimal decomposition" subset (e.g. only extracting
   `ChatHeader` and leaving the body monolithic). Every row in
   §3.1 lands in the batch, on the design-fixed prop bags.

---

## 6. Stage-mapping suggestion (non-binding)

- Stage F4-S1 — Composables and utility (`useChatScroll`,
  `useChatMessages`, time util) with unit tests; no surface
  change yet.
- Stage F4-S2 — Leaf components (`ChatHeader`, `MessageItem`,
  `ChatComposer`, `JumpToLatest`) with per-component tests; no
  surface change yet.
- Stage F4-S3 — `MessageList.vue` consuming the F03 round
  timeline; component tests.
- Stage F4-S4 — `AnalystChatPanel.vue` rewrite as the design-§2
  orchestrator shell. Selector-migration test rewrite. Full-suite
  gates.

After Stage F4-S4: open PR.
