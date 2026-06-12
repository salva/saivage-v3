# S03 Third-Pass Review

Verdict: APPROVED

Finding counts: 0 BLOCKER, 0 MAJOR, 0 NIT

Single most important issue: none

## Findings

No findings. The third-pass draft resolves the store-level ordering blocker and the Vue test-location major while preserving the earlier carry-over requirements.

## Targeted Re-checks

- R-BLOCKER store-level path: PASS. [design.md](design.md#L193-L244) now documents the Pinia store split: add `orderedFilteredCards` and `orderedCardTree`, keep `filteredCards` / `cardTree` / `board` intact for non-tree sorted surfaces, and send only the tree surface through the ordered pipeline. [plan.md](plan.md#L105-L113) adds concrete D.3a-D.3e steps with file edits, source line regions, return-object exposure, a new store Vitest, and a forecast re-read guard.
- CardsView consumer: PASS. The actual baseline still binds [CardsView.vue](../../../../../../web/src/views/CardsView.vue#L70-L98) tree props to `filteredCards` / `cardTree`, while board, leaderboard, and timeline bind to `filteredCards` / `board`. [plan.md](plan.md#L109) changes only the `<CardsTreeView>` props to `orderedFilteredCards` / `orderedCardTree` and explicitly leaves the board, leaderboard, and timeline bindings unchanged.
- Store source spot-check: PASS. [cards.ts](../../../../../../web/src/stores/cards.ts#L136-L154) currently sorts `filteredCards` before building `cardTree`, which validates the draft's upstream-fix diagnosis. [cards.ts](../../../../../../web/src/stores/cards.ts#L523-L525) currently returns `filteredCards`, `cardTree`, and `board`; D.3b requires adding the ordered pair to that return object without removing the existing sorted pair.
- New ordered-tree unit test: PASS. [plan.md](plan.md#L111) adds `saivage-v3/web/src/__tests__/cards-store-ordered-tree.test.ts` and requires assertions that `orderedCardTree` preserves backend order while `cardTree` keeps the legacy priority-sorted order.
- Existing sorted computeds left intact: PASS. [design.md](design.md#L214-L218) and [plan.md](plan.md#L107-L113) make this a coherent explicit choice: tree rendering gets backend order; board, leaderboard, and timeline retain sorted flat-list behavior.
- R-MAJOR test location: PASS. [design.md](design.md#L235-L244) now says Vue/Vitest gates live under `saivage-v3/web/src/__tests__/`, and the only `tests/utils/` mention is explicitly backend Vitest helpers unrelated to Vue rendering gates. [plan.md](plan.md#L133) also forbids placing the SFC tests under backend `tests/utils/`.

## Carry-overs

- Substep count: PASS. `grep -cE '^[A-H]\.[0-9]+[a-z]? — ' plan.md` returned 67.
- Forecast shape: PASS. The `## Expected breakage forecast` section contains exactly 4 H3 entries: dashboard -> S06, files view -> S06, debug view -> S06, analyst chat context -> S08. Each block has the four single-line labeled fields and keeps `Recorded by: S03 / <YYYY-MM-DD>` as a placeholder in the draft.
- Safety class: PASS. The only `safety_class` assignment is `safety_class` `'low'` in [design.md](design.md#L168-L176). The only relevant `high` reference is the authz justification that planner/runtime denies `high`; no tool is assigned `high`.
- G.1 close-out conditional: PASS. [plan.md](plan.md#L149-L153) requires the cumulative ledger entry to exist, have `Target fix stage: S03`, and have a clean fresh gate diff before removal; otherwise it forbids fabrication or rewrite.
- Planner-control wiring: PASS. [plan.md](plan.md#L75-L87) keeps C.8a-C.8d intact: registry definitions, `PLANNER_CONTROL_TOOL_NAMES`, executor switch arms, and verification that the service path records `surface: 'runtime'`.
- C2 partial-success: PASS. `move_card` remains a single-id atomic operation; the draft does not introduce a C2 partial-success response shape.
- Cumulative ledger path only: PASS. Design and plan reference the cumulative `SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md` / `PLAN/expected-breakage-ledger.md` path only; no stage-local ledger path appears.

## Grep Re-runs

- Autonomy grep: PASS. `grep -E -in 'SPEC-r[1-6]|PROTOCOL-r[1-3]|MASTER-PLAN-r[1-6]|REVIEW-r|prior round|earlier round|previous version|previous draft|before the refactor|was superseded|older revision' design.md plan.md` returned zero matches (`exit 1`).
- Emoji grep: PASS. `grep -RnP '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' design.md plan.md` returned zero matches (`exit 1`).
- Host-path grep: PASS. `grep -REn '/work/' design.md plan.md` returned zero matches (`exit 1`).

## Ledger Forecast Confirmation

Confirmed 4 ledger forecasts:

- `web-vitest:scenario-dashboard-child-order:step-1` -> S06
- `web-vitest:scenario-files-view-child-order:step-1` -> S06
- `web-vitest:scenario-debug-view-child-order:step-1` -> S06
- `analyst-e2e:scenario-analyst-chat-context-child-order:step-1` -> S08