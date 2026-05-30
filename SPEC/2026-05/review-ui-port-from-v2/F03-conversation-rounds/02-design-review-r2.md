# F03 — Conversation rounds / diagnostics / pairing — Design review (r2)

Reviewer round 2. Reviewed:

- [F03 design r2](02-design-r2.md)
- [F03 design review r1](02-design-review-r1.md)
- [F03 design r1](02-design-r1.md)
- [F03 approved analysis r2](01-analysis-r2.md)
- [F04 analysis r3](../F04-chat-surface-style/01-analysis-r3.md)
- [F04 design r2](../F04-chat-surface-style/02-design-r2.md) as the current design-side chip-adapter draft
- [F05 design r2](../F05-tool-detail-rendering/02-design-r2.md)

## Summary

The r2 draft fixes the local F03 design problems from r1: the shared
`ToolChip` skeleton now uses F05 `InlinePart` fields through
`<InlineParts>`, it uses a non-nested interactive DOM shape, it chooses
the raw `callContent` / `resultContent` contract for expanded bodies,
schema validation now enforces the numeric-tail bound, the leading-zero
test wording is clear, and the chip-contract tests are named.

However, I cannot approve yet because the binding cross-issue chip
contract is still inconsistent when checked against **F04 r3**, which
the brief explicitly asked me to verify. F03 r2 and F05 design r2 now
agree on the eight-prop contract, and F04 design r2 has also been
updated to that contract. The actual F04 r3 analysis file still
reproduces the older six-prop `ToolChip` API and adapter return shape,
with no `callContent` or `resultContent`. Since r1 required F03/F04/F05
to agree, an implementer following F04 r3 would still build adapters
that do not typecheck against the F03/F05 chip.

## Required change

1. Reconcile the F04 r3 chip contract reference with the eight-prop
   raw-content contract.

   F03 r2 §7.2 defines the fixed prop bag as
   `{ call, result, callContent, resultContent, status, expanded, detailsId, timestamp? }`,
   renders summaries through `<InlineParts>`, and renders expanded
   payloads through `<FormattedContent :content="callContent" />` and
   `<FormattedContent :content="resultContent" />` when present. F05
   design r2 §4.1 repeats that same contract and says the raw producer
   payloads come from the F04 adapter and the F03 `toolChipPropsFor(pair)`
   helper.

   F04 design r2 §1.10 now matches this and has the correct adapter
   fields (`callContent: call.content`, `resultContent: result ? result.content : null`,
   plus synthetic pending-call content). But F04 analysis r3 §4.0 and
   §4.1 still reproduce the old six-prop contract and implementation
   outline:
   `{ call, result, status, expanded, detailsId, timestamp? }` only.
   That is the stale contract r1 asked the writer to eliminate.

   Required resolution: either update the binding F04 r3 analysis so
   §4.0/§4.1 include `callContent` / `resultContent`, or change the
   F03/F05 cross-references so they no longer claim F04 r3 is the
   aligned eight-prop source and instead cite the accepted F04 design
   document that owns that correction. As written, the documents still
   disagree on the required prop bag.

## Required-items check

- **R1 — ToolChip / F04 / F05 contract:** partially addressed, but
  still blocking. F03 r2 and F05 design r2 align; F04 design r2 aligns;
  F04 r3 does not. The DOM shape, F05 field names, and raw-body choice
  are otherwise fixed in F03 r2.
- **R2 — schema-level digit grammar and `Number.MAX_SAFE_INTEGER`:**
  addressed. F03 r2 §4.1 adds the regex plus `superRefine` bound check,
  with parser-side `unknown` retained as defence in depth.
- **R3 — leading-zero wording:** addressed. F03 r2 §3.2 and §11.1 now
  say `r007` and `r7` remain distinct raw buckets and only share a sort
  key.
- **R4 — chip contract tests:** addressed. F03 r2 §11.1 names tests for
  no nested interactive controls, F05 `InlinePart` field names, and raw
  expanded bodies through `FormattedContent`.
- **Accepted axis review:** still good. Proposal A remains the right
  architectural direction: producer-stamped rounds, schema canary,
  canonical `{ session, entries, activity_status }` wire shape, pure
  timeline utility, no legacy `messages`/`steps` compatibility path,
  and the AnalystChatPanel chip swap in the F03 batch.

## Recommendation

Approve after the F04 r3 cross-reference mismatch is resolved. I do not
see another blocker in the F03 r2 design itself; the remaining failure
is that the binding documents still leave two incompatible chip prop
contracts in play.

VERDICT: CHANGES_REQUESTED