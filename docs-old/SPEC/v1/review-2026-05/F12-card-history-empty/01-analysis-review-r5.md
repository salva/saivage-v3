## Analysis

1. The r4 Appendix A blocker is addressed. The r5 recipe seeds `card.version_seq = 2`, clears the history file, and appends an orphan row at `history.version_seq = 3`, so the current `reconcileCardHistory` predicate (`history.version_seq >= card.version_seq`) is mechanically true and the injected row is dropped on the next store construction. The recipe now proves the intended F12 invariant violation rather than preserving the row as r4 did.
2. The r4 acceptance-envelope blocker is addressed in F12 itself. [01-analysis-r5.md](./01-analysis-r5.md) §4 now requires `entry_id` and `kind` on every returned history row, every per-seq header/envelope, and the `card_history_appended` websocket payload.
3. The audit-scope wording is acceptable for closure mode: the document no longer claims to reproduce the original live `project.version_seq = 4` observation after reset, and it keeps the destructive recipe clearly separated from the safe operator diagnostic.

## Design

1. The implementation-owner and architecture decisions are aligned with the binding orchestration decisions: F13 is the umbrella, derived files are deleted, the mutex is project-wide, `transitionCard` is async, and history rows use the pre-mutation `V - 1` math.
2. The r4 design ask is addressed inside F12: the acceptance enumeration explicitly adds `entry_id` and `kind` assertions to backend, websocket, agent, utility, and web fixture/test items.
3. Links in the F12 design target F13 r4 rather than F13 r3, and the out-of-scope note preserves the workspace rule against adding docstrings/comments in untouched code.

## Plan

1. The F12 plan now points to the F13 r4 trio and states that F13 r4 supersedes r3; no stale F13-r3 implementation pointer remains in the r5 plan.
2. The targeted test enumeration carries the numeric history invariants and the new `entry_id`/`kind` checks, including header equality for `GET history/<seq>`, websocket payload matching, agent response parity with HTTP, pairwise unique entry IDs, and web fixture preservation.
3. The live probe now checks both numeric invariants and envelope invariants, including matching `entry_id` and `kind` between the latest list row and the per-seq header response.

## Cross-check

1. Blocking cross-check issue: F13 r5 does not yet absorb the F12 r5 acceptance verbatim. [../F13-canonical-index-drift/01-analysis-r5.md](../F13-canonical-index-drift/01-analysis-r5.md) still says the full F12 closure list is cross-linked from F12 r4, and [../F13-canonical-index-drift/03-plan-r5.md](../F13-canonical-index-drift/03-plan-r5.md) says the absorbed list is copied verbatim from F12 r4. That conflicts with the F12 r5 closure contract, which adds required `entry_id`/`kind` assertions to the list rows, per-seq headers, websocket payload, agent responses, utility assertions, web fixtures, and live probe.
2. The mismatch is substantive because an implementer following F13 r5's explicit absorbed F12 section could satisfy the older F12 r4 list while missing parts of F12 r5, especially the `GET history/<seq>` header envelope equality and several per-test `entry_id`/`kind` assertions. F13 r5 has broad schema and mutation-matrix coverage, but the requested verbatim F12 acceptance cross-check is still not true.
3. Required closure fix: update F13 r5's F12 closure pointer and absorbed acceptance section to F12 r5 §(b) verbatim, or explicitly map every F12 r5 assertion one-for-one, including the live-probe header equality. The F12 r5 documents themselves do not need further changes for the r4 asks.

VERDICT: CHANGES_REQUESTED