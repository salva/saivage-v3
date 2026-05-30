# F03 — Rebaseline against HEAD `eb98caf` (r1)

This is a **binding addendum** to the F03 approved artifacts:

- analysis: [01-analysis-r2.md](01-analysis-r2.md)
- design:   [02-design-r3.md](02-design-r3.md)
- plan:     [03-plan-r2.md](03-plan-r2.md)

The approved analysis, design, and plan are unchanged and remain
the binding contract for F03. This rebaseline records the small
number of HEAD-side facts the implementer needs in order to
execute the plan without re-deriving them from prior review
rounds. A reader who has never seen earlier review rounds can
implement F03 by combining the approved design + plan + this
rebaseline.

The implementer MUST NOT silently descope any plan row, MUST NOT
introduce alias re-exports of the legacy ToolChip API or the
pre-round message shapes, and MUST follow the nothing-lost
invariant in §5.

---

## 1. HEAD reference

- Commit: `eb98caf` (`master`).
- F03 landing status at HEAD: **nothing landed.** Specifically:
  - `git grep -nE 'roundId|round_id|RoundId' src/ web/src/types/`
    returns 0 hits — no schema stamps anywhere.
  - `web/src/components/conversation/` contains only `ToolChip.vue`
    (which is on the wrong contract; see F02 rebaseline §4.2).
    No `RoundCard.vue`, `DiagnosticRow.vue`, `PendingCallFooter.vue`,
    `CompactedCluster.vue`, or `ContextBlock.vue`.
  - `web/src/components/chat/analyst-timeline.ts` is missing.
  - `web/src/components/chat/tool-chip-adapter.ts` is missing.
  - No `ConversationRound` / `ConversationBlock` / `MessageId` /
    `BlockId` / `RoundId` types exist in `src/types/` or
    `web/src/types/`.
  - `web/src/components/agents/AgentConversationView.vue` is
    still the flat single-pass renderer it was before F03 was
    designed.
  - `web/src/components/chat/AnalystChatPanel.vue` is the
    349-line monolith it was before F03 was designed.

---

## 2. Cross-batch precondition: F02 rebaseline R1 has landed

The F03 plan was written assuming the cross-batch C5 commit
(MessageBubble, ThinkingDots, eight-prop ToolChip,
`tool-chip-adapter.ts`, `analyst-timeline.ts`, chip swap on both
surfaces) lands as one unit owned jointly by F02 and F03.

In the current sequencing those C5 items are landed by the F02
rebaseline R1 (Stage S1). F03 starts from a HEAD in which:

- `web/src/components/conversation/MessageBubble.vue` exists on
  the design-§1.3 contract.
- `web/src/components/conversation/ThinkingDots.vue` exists on
  the design-§1.3 contract.
- `web/src/components/conversation/ToolChip.vue` exposes the
  eight-prop bag described in [F02 rebaseline §4.2](../F02-component-hierarchy/04-rebaseline-against-HEAD-r1.md#42-toolchipvue-prop-bag--eight-prop-contract-design-13--f03-r3-32--f04-r2-41).
- `web/src/components/chat/tool-chip-adapter.ts` exists and
  exports `adaptChatMessageToToolChip` and
  `adaptPendingInvocationToToolChip`.
- `web/src/components/chat/analyst-timeline.ts` exists.

If F02 rebaseline R1 has NOT landed at the moment the harness
picks up the F03 mailbox entry, the harness MUST file a delta
proposal pointing at the missing precondition, OR reject the F03
batch via `.decision.md` rather than implementing a subset.

This means: F03 plan §1.1 row "C5 cross-batch commit" is
**already done** by the F02 rebaseline. F03's remaining work
starts at the round-timeline plumbing and the surface rewrites
that consume it.

---

## 3. Remaining deliverables (IN SCOPE)

The F03 plan §1 + §2 commit sequence applies verbatim, minus the
cross-batch C5 row (now owned by F02 rebaseline R1). Restated as
a compact deliverable matrix:

### 3.1 Runtime schema stamping — plan §1.1 backend rows

| Deliverable | Path | Binding contract |
| --- | --- | --- |
| `RoundId`, `MessageId`, `BlockId` branded types | `src/types/conversation.ts` (or wherever the plan locates them — plan §1.1 row "schema") | design [§2.1](02-design-r3.md#21-id-shapes) |
| `ConversationRound`, `ConversationBlock` discriminated union | `src/types/conversation.ts` | design [§2.2](02-design-r3.md#22-round-and-block-shapes) |
| Producer stamping (runtime emits `roundId` / `messageId` / `blockId` on every event the conversation views consume) | per plan §1.1 row "producer" — usually `src/runtime/conversation/*` | design [§2.3](02-design-r3.md#23-producer-contract) |
| Consumer adapters in web/src parsing the stamped events | `web/src/composables/useConversationStream.ts` (or whatever the plan §1.1 names) | design §2.4 |
| Schema migration tests | per plan analysis §6.1 | analysis §6.1 |

### 3.2 Conversation round composites — plan §1.2 frontend rows

| Deliverable | Path |
| --- | --- |
| `RoundCard.vue` | `web/src/components/conversation/RoundCard.vue` |
| `DiagnosticRow.vue` | `web/src/components/conversation/DiagnosticRow.vue` |
| `PendingCallFooter.vue` | `web/src/components/conversation/PendingCallFooter.vue` |
| `CompactedCluster.vue` | `web/src/components/conversation/CompactedCluster.vue` |
| `ContextBlock.vue` | `web/src/components/conversation/ContextBlock.vue` |
| Component tests per analysis §5 | `web/src/__tests__/conversation/*.test.ts` |

Each component's prop bag is fixed by design §3.3–§3.7 row by
row. The implementer MUST NOT widen, narrow, or rename props.

### 3.3 Surface rewrites — plan §2 frontend rows

| Surface | Action |
| --- | --- |
| `web/src/components/agents/AgentConversationView.vue` | Replace the flat-message render with a `RoundCard` per round; pending footer per active call; compaction cluster per compaction event. Co-committed with the F02 plan C11 surface rewrite of the non-round chrome (see F02 rebaseline §3.5 row C11). |
| `web/src/components/chat/AnalystChatPanel.vue` | Replace the flat message list with the round-timeline render (uses `analyst-timeline.ts`). Co-committed with the F02 plan C13 non-chip rewrite (F02 rebaseline §3.5 row C13). |

The chip-swap inside these two surfaces has already been done by
F02 rebaseline R1 Stage S1. F03 must not re-do the chip migration;
F03's surface rewrites consume the eight-prop chip via the
adapter that already exists.

### 3.4 Cross-cutting tests — plan §3 full-suite gates

The F03 plan §3 gate list applies unchanged: schema-stamp grep
gates, round-vs-block invariant tests, no-flat-renderer assertion
on the two surfaces, and the `ConversationRound` exhaustiveness
test.

---

## 4. Reconciliation deliverables

None at HEAD. F03 has not shipped any partial work that needs to
be reconciled. The chip API reconciliation is owned by F02
rebaseline §4.2.

If F02 rebaseline R1 has NOT landed by the time the harness
processes this batch, the chip-API reconciliation is escalated to
F03 (it cannot be skipped). The harness MUST file a delta
proposal flagging this rather than starting F03 surface rewrites
on a wrong-API chip.

---

## 5. Nothing-lost invariant (binding)

The harness MUST:

1. Read this rebaseline plus [02-design-r3.md](02-design-r3.md)
   and [03-plan-r2.md](03-plan-r2.md).
2. Produce a stage-plan whose stages cover every row in §3.
3. Treat §2 (precondition) as a hard check before any stage
   runs: if the cross-batch C5 items are not at HEAD, file a
   delta proposal or reject; do not start F03.
4. Honour the design's discriminated-union exhaustiveness — no
   "string" fallback for `RoundId | MessageId | BlockId`, no
   `as any` casts, no alias re-exports of pre-stamp event types.

---

## 6. Stage-mapping suggestion (non-binding)

- Stage F3-S1 — Schema stamping (types + producer + consumer
  adapter + migration tests; plan §1.1 backend rows).
- Stage F3-S2 — Round composites (`RoundCard`, `DiagnosticRow`,
  `PendingCallFooter`, `CompactedCluster`, `ContextBlock`) with
  component tests; plan §1.2 frontend rows.
- Stage F3-S3 — `AgentConversationView` round rewrite +
  selector-migration test rewrite; co-committed with F02 plan C11.
- Stage F3-S4 — `AnalystChatPanel` round rewrite +
  selector-migration test rewrite; co-committed with F02 plan C13.

After Stage F3-S4: full-suite gates per F03 plan §3. Open PR.
