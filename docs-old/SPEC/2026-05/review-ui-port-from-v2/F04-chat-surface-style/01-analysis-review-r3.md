# F04 Chat Surface Style Analysis Review r3

Review target: [01-analysis-r3.md](01-analysis-r3.md)
Prior review: [01-analysis-review-r2.md](01-analysis-review-r2.md)
Canonical chip contract checked against: [../F03-conversation-rounds/01-analysis-r2.md](../F03-conversation-rounds/01-analysis-r2.md)

## Summary

The single required r2 change is fully addressed. F04 r3 now consumes
F03 r2's shared `ToolChip` boundary instead of defining a chat-local
`view` API, and its cross-issue ordering now matches the F03 r2
landing decision.

## Required Change Verification

1. `ToolChip` props match F03 r2 exactly.

   F04 r3 §4.0 reproduces the canonical prop bag as `call`, `result`,
   `status`, `expanded`, `detailsId`, and optional `timestamp`, with
   no `view` prop and no chat-local replacement contract.

2. Adapters return the exact prop shape.

   F04 r3 §4.1 defines `ToolChipProps` with exactly the same six
   fields and both adapter paths return that shape: persisted
   `tool_call` plus optional sibling result maps to `call/result/status`,
   and pending invocation maps to `result: null` plus
   `status: 'pending'`.

3. No composite `:view` binding remains.

   The render sketches in §3.3, §3.4, §4.3, and §4.4 bind the adapter
   result via `v-bind="adaptChatMessageToToolChip(...)"` or
   `v-bind="adaptPendingInvocationToToolChip(...)"`. I found no live
   `:view` binding in the r3 draft.

4. Cross-issue ordering matches F03 r2.

   F04 r3 §11.1-§11.3 adopts strict order
   `F01 -> F02 -> F05 -> F03 -> F04` and explicitly states that the
   `AnalystChatPanel.vue` chip swap lands inside the F03 PR, together
   with the shared `ToolChip` renderer.

5. F03 citations target F03 r2.

   The binding companion link and all operative F03 references point
   to F03 r2. The lone `F03 r1` text is only a quoted description of
   the withdrawn r2 ordering language, not a live citation or dependency.

## Residual Risk

No blocking issues found. The remaining implementation details are
normal execution work for the future PRs, not analysis blockers.

VERDICT: APPROVED