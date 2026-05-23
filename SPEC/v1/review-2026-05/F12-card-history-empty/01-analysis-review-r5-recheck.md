## Analysis

1. The F12 r5 analysis remains closure-ready. It narrows the user-visible symptom to empty card history despite a mutated card, preserves the orchestrator-binding pre-mutation history semantics, and no longer overclaims reproducibility of the reset live-audit state.
2. The r4 Appendix A defect remains fixed: the destructive recipe now seeds `card.version_seq = 2` and an orphan row at `history.version_seq = 3`, so the current `reconcileCardHistory` predicate is guaranteed to drop the row and demonstrate the F12 invariant violation.
3. The binding acceptance shape explicitly requires `entry_id` and `kind` on history list rows, per-seq history headers, and the `card_history_appended` websocket payload.

## Design

1. The design correctly has no independent F12 implementation and delegates the rewrite to F13, matching the umbrella ownership decision.
2. The F12-specific non-regression surfaces are sufficiently enumerated: HTTP routes, wire schemas, websocket event, history round-trip tests, untracked-update coverage, and silent-truncation removal.
3. The acceptance test enumeration requires `entry_id` and `kind` assertions across backend, websocket, agent-tool, utility, and web fixture/test coverage, so F13 implementers cannot satisfy F12 with numeric history assertions alone.

## Plan

1. The plan correctly points to the F13 r4 implementation trio as the owner while retaining only the F12 closure contract.
2. F12 §(b) states the eight required acceptance test items with the needed per-test `entry_id` and `kind` checks, including UUID shape, allowed literal set, pairwise uniqueness where relevant, header/list equality, event/list equality, agent/HTTP parity, and web fixture preservation.
3. The live-probe success criterion covers both numeric invariants and envelope invariants, including matching the latest list row's `entry_id` and `kind` against the `GET history/<seq>` response.

## Cross-check

1. The prior r5 blocker is resolved. The F13 r5 plan's absorbed section header now cites F12 r5: `Absorbed F12 acceptance shape (copied VERBATIM from F12 r5 §(b))`, and it links to `../F12-card-history-empty/03-plan-r5.md` §(b).
2. F13 r5 absorbed items 1 through 8 now include the required `entry_id` and `kind` assertions. Item 1 covers single-PATCH rows, two-PATCH rows, pairwise distinct entry IDs, and `GET history/1` header equality; item 2 covers final-list UUID/kind assertions and pairwise uniqueness; item 3 covers websocket payload UUID/kind and list-row matching; item 4 covers agent-tool row/header parity with HTTP; item 5 covers fresh UUID/correct kind and loud orphan errors naming `entry_id` or `version_seq`; items 6 through 8 cover web fixture and preservation assertions.
3. F13 adds a few F13-specific strengthening clauses around the copied F12 list, but they are additive and do not remove, weaken, or redirect any F12 r5 assertion. The stale F12 r4 provenance and missing per-test envelope assertions that caused the prior CHANGES_REQUESTED verdict are gone.

VERDICT: APPROVED