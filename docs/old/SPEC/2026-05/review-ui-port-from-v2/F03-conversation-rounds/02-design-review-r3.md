# F03 - Conversation rounds / diagnostics / pairing - Design review (r3)

Reviewer round 3. Reviewed:

- [F03 design r3](02-design-r3.md)
- [F03 design review r2](02-design-review-r2.md)
- [F03 design r2](02-design-r2.md)
- [F03 approved analysis r2](01-analysis-r2.md)
- [F04 design r2](../F04-chat-surface-style/02-design-r2.md) and [F04 design approval](../F04-chat-surface-style/DESIGN-APPROVED.md)
- [F05 design r3](../F05-tool-detail-rendering/02-design-r3.md), with r2 continuity checked where F03 still cites F05 r2

## Findings

No blocking findings.

F03 r3 resolves the only r2 blocker by taking the reviewer-approved option B: it stops treating stale F04 analysis r3 sections 4.0/4.1 as the chip-adapter contract and instead makes approved F04 design r2 section 1.10 the authoritative sibling for the eight-prop `ToolChip` bag. The remaining mentions of "F04 r3" in F03 r3 are historical descriptions of the prior mismatch or quotations of the r2 required change, not normative implementation references.

One non-blocking editorial nit: F03 r3 section 12 says the F04 design r2 cross-reference appears in sections "7.2, 8.2, 10". Section 10 is the deletion list; the substantive cross-reference set is section 7.2, section 8.2, and section 12 itself. This does not create a contract ambiguity because section 10 only inherits the deletion commitments from r2.

## Required-items check

| Item | Status | Review notes |
| --- | --- | --- |
| R1-followup - reconcile F04 r3 chip-contract reference with the eight-prop raw-content contract. | PASS | F03 r3 explicitly cites approved F04 design r2 section 1.10 as the chip-adapter source. Sections 7.2 and 8.2 bind `adaptChatMessageToToolChip` / `adaptPendingInvocationToToolChip` to the eight props `{ call, result, callContent, resultContent, status, expanded, detailsId, timestamp? }`, including raw `callContent` and `resultContent`. |
| R2 - schema-level digit grammar with `Number.MAX_SAFE_INTEGER` bound. | PASS | F03 r3 carries forward F03 r2 section 4.1 by reference. The r2 text contains the regex plus `superRefine` bound check and required `tool_call_id` scalar for tool entries. |
| R3 - leading-zero wording. | PASS | F03 r3 carries forward F03 r2 sections 3.2 and 11.1. The design says `r007` and `r7` are distinct raw buckets and only share a numeric sort key. |
| R4 - chip contract tests. | PASS | F03 r3 carries forward the named `ToolChip.test.ts` cases: one button per chip, F05 `InlinePart` field rendering, raw expanded bodies through `FormattedContent`, raw `callContent` / `resultContent` flow, status-to-tone mapping, no nested interactive controls, sibling expanded body, and `aria-controls` to `detailsId`. |
| Accepted architecture axes. | PASS | Producer-stamped rounds, schema canary, pure `entriesToTimeline`, no legacy `messages` / `steps` compatibility path, backend round counters, activity-status pipeline, canonical `{ session, entries, activity_status }`, and piggybacked `thinking` / `activity` WS envelopes are all carried forward from the approved r2 design. |

## Cross-document alignment

F04 alignment now passes. F04 design r2 section 1.10 defines both analyst adapters returning the same eight-prop bag consumed by F03 `ToolChip`, with `callContent: call.content`, `resultContent: result ? result.content : null`, and synthetic pending-call content for pending invocations. F03 r3 correctly treats that approved design document as the design-layer source of truth for the adapter contract.

F05 alignment also passes. F05 design r3 republishes the canonical eight-prop chip bag in its section 4.1, keeps raw producer payloads off the presentation objects, and rejects the stale `callContentRaw` / `resultContentRaw` names. F03 r3's continued F05 r2 citations are not a problem because F05 r3 carries those contracts forward while adding cross-document errata for F02.

## Recommendation

Approve F03 design r3. The prior blocking mismatch is resolved, the inherited r2 requirements remain covered, and the remaining editorial nit is not implementation-significant.

VERDICT: APPROVED