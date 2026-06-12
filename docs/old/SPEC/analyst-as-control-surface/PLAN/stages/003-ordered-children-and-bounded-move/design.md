# S03 — Cards: ordered children + bounded move

## Goal

Make child order an explicit, persisted property of every card and make every
backend reader honour that order without re-sorting. Replace the open-ended
`move_card` re-parent operation with the two SPEC-allowed transitions only
(sibling-descent and grandparent-ascent), and expose a real `reorder_child`
mutation to both the analyst and the planner-control surface. The S03-owned
UI views (cards tree, card detail, card history) consume the backend order
verbatim. Stages S06 and S08 own the remaining UI surfaces; this stage
declares ledger forecast entries for them rather than touching their files.

## Scope

In scope:

- New persisted field `position: number` on `CardRecord`.
- Rewrite of every on-disk card record under `.saivage/cards/by-id/*.json` to
  carry `position`; no legacy-shape reader, no migration shim.
- Replacement of the adjacency cache `CardStoreState._childrenByParent` so
  `childrenOf(parentId)` returns ids sorted by `position`.
- Append-on-create semantics in `CardStore.create()`.
- Bounded `move_card` validator (server side) accepting only sibling-descent
  and grandparent-ascent; cross-tree and root moves return a typed error.
- New `reorder_child(parentId, orderedChildIds)` implementation replacing the
  S02 `not_yet_available` stub.
- Audit-wrap both `move_card` and `reorder_child` through
  `runAuditedAnalystTool`.
- Add `move_card` and `reorder_child` to the planner-control tool surface
  with the same bounded semantics.
- Update every backend read path that returns a card's children: `CardStore`
  public API, `analyst-tools.ts` (`get_card`, `get_tree`, `list_cards` with
  `parent`), `src/server/routes/operator-contracts.ts` (`cards.get`), every
  projection in `src/projections/` that surfaces child collections.
- Update S03-owned UI views to render in backend order:
  - `web/src/components/cards/CardsTreeView.vue`
  - `web/src/views/CardsView.vue`
  - `web/src/components/cards/CardDetailView.vue`
  - `web/src/components/cards/CardHistoryPanel.vue`

Out of scope (declared as ledger forecast for the owning later stage):

- UI ordering of `DashboardView.vue`, `FilesView.vue`, `DebugView.vue` (owner
  S06 per MASTER-PLAN §4.1).
- `AnalystChatPanel` and its descendants in `web/src/components` (owner S08
  per MASTER-PLAN §4.1).
- End-to-end coverage across every surface (owner S10).
- Notification primitive refactor (owner S04).
- Schema field deprecations not affecting child order.
- Planner activation policy (the planner treats user-visible child order as
  a soft hint, not a hard schedule, per MASTER-PLAN §S03 goal).

## Dependencies

- S00 (breakage-detection harness). `PLAN/baseline-gates.json` and
  `PLAN/scripts/run-gates.sh` are the only gate inputs S03 reads or refreshes.
- S02 (tool-surface alignment). S03 reuses:
  - `runAuditedAnalystTool` from `src/agents/analyst-tool-runner.ts` for
    audit wrapping with `actor='analyst'` plus surface field.
  - `analyst-tool-schemas.ts` slot for `reorder_child` and `move_card` whose
    placeholder schemas were declared `not_yet_available` with
    `stage_owner: 'S03'`.
  - `ActiveRuntime` accessors and shared analyst tool plumbing.

S01 is a transitive dependency through S02; S03 reads no S01-only construct.

## Approach

### Data model

`CardRecord` gains one new required field:

- `position: number` — non-negative integer. Within a single parent, the
  set of `position` values across that parent's children is exactly
  `{0, 1, ..., N-1}` where `N` is the child count. Root cards (parent
  `null`) carry `position: 0`; the project card is the only root, so this
  is a constant.

The zod schema `cardRecordSchema` in `src/schemas/validators.ts` adds
`position: z.number().int().nonnegative()` as required (no `.optional()`,
no default). There is no legacy reader: any on-disk card record missing
`position` triggers a `CardStoreInvariantError` from
`loadCardStoreState` and the operator is told to run `init`.

### Persistence

`CardStore.create()` (currently `src/cards/card-store.ts` line 376
onward) computes the new card's `position` as
`store.listChildren(parent).length` when `parent !== null`, else `0`. The
field is included in the validated record passed to `applyMutationSync`.

`CardStoreState._childrenByParent` (`src/cards/state.ts` line 66) is
replaced by a sort-on-read implementation: the cache stores child id
arrays in `position` order, and `addChildEdge` / `removeChildEdge`
(`src/cards/state.ts` lines 155–167) re-sort after every mutation. The
sort key is the persisted `position` on each card record.

A new method on `CardStoreState`:

- `reorderChildren(parentId: string, orderedChildIds: string[]): CardRecord[]`
  — validates `orderedChildIds` is a permutation of the current child set
  of `parentId`, builds a list of `(id, newPosition)` updates, and
  returns the updated card records (still in memory; persistence is the
  caller's responsibility).

`CardStore.reorderChildren(parentId, orderedChildIds, ctx)` calls
`reorderChildren` on the in-memory state, then issues one
`applyMutationGroupSync` (`src/cards/apply-mutation.ts`) containing one
`persist` op per child whose `position` actually changed.
`changeSummary` is `'reorder_child'`; `historyKind` is `'mutate'`;
`changedFields` is `['position']`.

`CardStore.create()` and the `position`-only mutations triggered by
`reorderChildren` and `moveCard` both flow through the existing
`apply-mutation.ts` machinery, so the on-disk write sequence,
commit-marker recovery, and per-card history contiguity invariant in
`src/cards/state.ts` `validateCardHistoryInvariant` are preserved.

### Bounded move

The new `CardStore.moveCard(id, newParent, ctx)` enforces:

1. `id !== 'project'` — root card moves refused with code
   `move_refused_root`.
2. `newParent !== null` — moves to root refused (same code).
3. `id !== newParent` — self-parent refused (existing check in
   `card-store.ts` lines 281–284, kept).
4. The candidate target must be either:
   - a current sibling of `id` (`store.getParent(id) ===
     store.getParent(newParent)` AND `store.getParent(newParent) !==
     null`), or
   - the current grandparent of `id` (`store.getParent(id) !== null`
     AND `store.getParent(store.getParent(id)!) === newParent`).
5. Any other target returns
   `{success:false, data:{reason:'move_refused_cross_tree',
   message:'<SPEC-aligned phrase>', current_parent, attempted_parent}}`.
   The SPEC-aligned phrase is sourced verbatim from the SPEC-r7 section
   "Mutate cards — Bounded card move" so the analyst can surface it
   without paraphrase.
6. On accept, `moveCard` rewrites the card's `parent` field, sets its
   `position` to the new tail of the target parent's children list,
   and shifts the old siblings' `position` values down to close the
   hole. Both updates are issued as one `applyMutationGroupSync`.

The existing `validateMutablePatch` parent-change branch in
`src/cards/card-store.ts` (lines 595–625) is narrowed: it no longer
performs re-parent validation through `update()`; `parent` becomes a
field the public `update`/`mutateCard` API refuses to touch. All
re-parenting must go through `moveCard`.

### Reorder algorithm

`reorder_child(parentId, orderedChildIds)` validates:

- `parentId` exists.
- `orderedChildIds` is a string array (analyst tool schema).
- `set(orderedChildIds) === set(currentChildIds(parentId))`. On mismatch
  the response is `{success:false, data:{reason:'reorder_set_mismatch',
  missing:[...], extra:[...]}}`.

On accept, the new `position` for each id is its index in
`orderedChildIds`. Only ids whose `position` actually changes are
persisted (no-op writes are skipped to keep `version_seq` stable).

### Audit and surfaces

Both `move_card` and `reorder_child` are wrapped via
`runAuditedAnalystTool` with `actor='analyst'` and the calling surface.
`safety_class` is `'low'`. Move and reorder are bounded, reversible card
mutations; SPEC-r7 reserves confirmation for delete-class operations
(SPEC-r7 lines 230-237), and the move/reorder semantics live in a
separate normative section (SPEC-r7 lines 76-89). The current authz
matrix (`src/agents/authz.ts` lines 39-42 and 63-66) denies
planner/runtime execution of `high`, so `low` is also the only class
that lets the planner-control surface dispatch these tools without an
authz amendment.

The planner-control surface gets matching tools in
`src/tools/planner-tools.ts` named `move_card` and `reorder_child`, but
the service-layer methods are not sufficient on their own: the planner
tool registry in `src/agents/agent-adapter.ts` (around lines 69-103)
must also declare the two tool definitions and add their names to the
`PLANNER_CONTROL_TOOL_NAMES` set, and the dispatch switch in
`src/agents/planner-control-executor.ts` (around lines 131-139) must
add explicit `case 'move_card':` and `case 'reorder_child':` branches
that call into the new service methods. The dispatch site is also
where the audit envelope is finalised, so the literal
`surface: 'runtime'` is set there (not only asserted in prose) when
the executor calls `recordControlAction({actor: 'planner', surface:
'runtime'})`.

### UI consumption

The cards Pinia store in `web/src/stores/cards.ts` (around lines
136-156) currently builds `cardTree` from `filteredCards`, and
`filteredCards` applies `sortCards` (priority desc, then `updated_at`
desc) before tree construction. That re-sort happens upstream of any
view component, so deleting the local sorts in `CardsTreeView.vue`
alone would still leave the tree in priority order. S03 adds two new
computed properties to the store that preserve backend insertion
order:

- `orderedFilteredCards` — same filter predicates as `filteredCards`
  (status / type / parent / tag / search), but no `sortCards` call.
  The result is a filtered slice of `cards.value` in the order the
  backend returned, which is the persisted-position order for siblings
  once S03's Phase B changes have the operator `cards.list` and
  `cards.get` paths reading through the position-sorted `listChildren`
  cache.
- `orderedCardTree` — `buildTree(orderedFilteredCards)`. This is the
  tree surface consumed by `CardsTreeView`.

The existing `filteredCards` and `cardTree` remain available for views
that are explicitly sorted and are not child-order surfaces (board,
leaderboard, timeline flat lists). The tree pipeline switches to the
new ordered pair; the other view bindings in `CardsView.vue` are
unchanged.

The S03-owned UI surfaces stop applying client-side sort keys to
children:

- `CardsView.vue` passes `orderedFilteredCards` and `orderedCardTree`
  to `CardsTreeView`; `CardsBoardView`, `CardsLeaderboardView`, and
  `CardsTimelineView` continue to receive `filteredCards` and `board`.
- `CardsTreeView.vue` deletes the `children.sort((a,b) => priority ||
  title)` block and the `sortedRoots` re-sort; the backend tree payload
  is rendered in the order it arrives.
- `CardDetailView.vue` `currentChildren` (line 288) is fed from the
  backend `children` array verbatim.
- `CardHistoryPanel.vue` renders child references in the order the
  history entry's `snapshot.parent`-derived sibling list arrives from
  the backend.

Vitest gates for these surfaces live under
`saivage-v3/web/src/__tests__/` (alongside `tool-presenters.test.ts`,
`raw-llm-exchange-panel.test.ts`, and the existing
`card-store.test.ts`), which is the established Vue/Vitest convention
for this repo. A new store test asserts `orderedCardTree` exposes
backend-order children for a shuffled fixture; per-component tests
assert each of `CardsTreeView`, `CardDetailView`, and
`CardHistoryPanel` renders that backend order without resorting.
Backend Vitest helpers under `saivage-v3/tests/utils/` are unrelated
to these Vue rendering gates, and S03 does not place Vue tests there.

## Surfaces touched

Backend:

- `src/schemas/types.ts` — `CardRecord` gains `position: number`.
- `src/schemas/validators.ts` — `cardRecordSchema` requires `position`.
- `src/cards/state.ts` — `_childrenByParent` becomes position-sorted;
  add `reorderChildren` method.
- `src/cards/card-store.ts` — `create()` appends; new `moveCard`,
  `reorderChildren`; `validateMutablePatch` refuses `parent` mutations.
- `src/cards/apply-mutation.ts` — accepts position-only persist ops
  (existing `persist` op kind is sufficient; no new op kind).
- `src/agents/analyst-tools.ts` — `move_card` rewritten to call
  `CardStore.moveCard` and return typed errors; new `reorder_child`
  implementation replacing the S02 `not_yet_available` stub; both
  audit-wrapped via `runAuditedAnalystTool`.
- `src/agents/analyst-tool-schemas.ts` — `move_card` schema gains the
  bounded-target contract documentation; `reorder_child` schema is
  emitted as a real schema (the `not_yet_available` marker is removed).
- `src/tools/planner-tools.ts` — new `move_card` and `reorder_child`
  planner-control tools.
- `src/server/routes/operator-contracts.ts` line 119 — `cards.get`
  emits children in `position` order (already the case once
  `listChildren` returns position-sorted ids).
- `src/projections/` — any projection that surfaces card children
  emits them in `position` order.

Frontend (S03-owned only):

- `web/src/stores/cards.ts` — add `orderedFilteredCards` and
  `orderedCardTree` computeds; existing `filteredCards` / `cardTree` /
  `board` are kept unchanged for non-tree views.
- `web/src/components/cards/CardsTreeView.vue`
- `web/src/views/CardsView.vue`
- `web/src/components/cards/CardDetailView.vue`
- `web/src/components/cards/CardHistoryPanel.vue`

Tests:

- New unit tests in `tests/utils/card-store.test.ts` and a new file
  `tests/utils/card-reorder-and-move.test.ts`.
- New analyst tool tests in `tests/analyst.test.ts` covering audit
  entries for `move_card` and `reorder_child`.
- New integration test in `tests/integration/` asserting shuffled
  subtree round-trip (write shuffled positions to disk, reload, assert
  every backend reader returns the shuffled order).
- New Pinia store test (vitest under `saivage-v3/web/src/__tests__/`)
  asserting `orderedCardTree` preserves backend-position order over a
  shuffled fixture.
- New Vue component tests (vitest under `saivage-v3/web/src/__tests__/`)
  for the three S03-owned rendering surfaces.

## Test plan

Unit:

- `position` is appended on `create()` (parent with N existing children
  receives a new child at `position === N`).
- `reorderChildren` rejects set-mismatched input with
  `reason: 'reorder_set_mismatch'` plus `missing`/`extra` arrays.
- `reorderChildren` writes only the records whose `position` actually
  changed (assert `version_seq` of an unchanged sibling stays stable).
- `moveCard` accepts sibling-descent; new `position` is the tail of
  the new parent; old siblings close the hole.
- `moveCard` accepts grandparent-ascent.
- `moveCard` refuses cross-tree with `reason:
  'move_refused_cross_tree'` and the SPEC phrase verbatim.
- `moveCard` refuses root moves with `reason: 'move_refused_root'`.
- `moveCard` refuses self-parent and descendant-parent (existing
  rules, preserved).
- `update()` / `mutateCard()` refuse a `parent` change.

Integration:

- Shuffled-subtree round-trip: create a 3-level subtree (depth 0..2,
  ~6 cards), shuffle persisted `position` values on disk, reload the
  store, assert `listChildren` plus `cards.get` route and
  `get_card` / `get_tree` analyst tools all return the same shuffled
  order.
- Audit: invoking `move_card` and `reorder_child` from the analyst
  surface appends a `ControlActionAuditEntry` with `actor='analyst'`
  and `surface` matching the call site.

E2E:

- The S02-forecast `analyst-e2e:scenario-reorder-child:step-1` flips
  green: the analyst issues `reorder_child` on a real shuffled subtree
  and the backend persists the new order.

UI (vitest):

- For each S03-owned component, render a shuffled fixture and assert
  the DOM order matches the input order without resorting.

Gates:

- The four S00 gates (`tsc-build`, `web-vite-build`, `web-vitest`,
  `analyst-e2e`) run via `PLAN/scripts/run-gates.sh --diff
  PLAN/baseline-gates.json`. Expected diffs are limited to the
  ledger-forecasted entries below; everything else stays at the
  baseline.

## Expected breakage forecast

Each H3 below is the verbatim block S03's close-out will append to
`PLAN/expected-breakage-ledger.md` for any gate failure that S03
intentionally does not fix.

### web-vitest:scenario-dashboard-child-order:step-1

Failure mode: vitest mount of `DashboardView.vue` against a shuffled child-of-goal panel fixture renders in client-sorted order (priority then title) instead of backend `position` order.
Reason acceptable now: the dashboard view is owned by S06 per MASTER-PLAN §4.1; S03 ships the backend contract and waits for S06 to flip the consumer.
Target fix stage: S06
Recorded by: S03 / <YYYY-MM-DD>

### web-vitest:scenario-files-view-child-order:step-1

Failure mode: vitest mount of `FilesView.vue` against a card group whose card has shuffled children renders children in client-sorted order instead of backend `position` order.
Reason acceptable now: the files view is owned by S06 per MASTER-PLAN §4.1; S03 ships the backend contract and waits for S06 to flip the consumer.
Target fix stage: S06
Recorded by: S03 / <YYYY-MM-DD>

### web-vitest:scenario-debug-view-child-order:step-1

Failure mode: vitest mount of `DebugView.vue` against a card with shuffled children renders in client-sorted order instead of backend `position` order.
Reason acceptable now: the debug view is owned by S06 per MASTER-PLAN §4.1; S03 ships the backend contract and waits for S06 to flip the consumer.
Target fix stage: S06
Recorded by: S03 / <YYYY-MM-DD>

### analyst-e2e:scenario-analyst-chat-context-child-order:step-1

Failure mode: the analyst chat panel renders the current card's children in client-sorted order; an e2e checker that shuffles the backend order observes a mismatch.
Reason acceptable now: `AnalystChatPanel` and its descendants are owned by S08 per MASTER-PLAN §4.1; S03 ships the backend contract and waits for S08 to flip the consumer.
Target fix stage: S08
Recorded by: S03 / <YYYY-MM-DD>

## Downstream impact

Per MASTER-PLAN §6.1, the following consumers are affected by S03's
contract changes; S03 either fixes the consumer in this stage or
records the gap as a forecast entry above.

- Card schema validators (`src/schemas/validators.ts`): fixed in S03.
- Card stores and on-disk readers (`src/cards/state.ts`,
  `src/cards/card-store.ts`, `src/cards/apply-mutation.ts`): fixed in
  S03.
- Card history / audit format (`src/cards/state.ts`
  `validateCardHistoryInvariant`): the schema change is backward-
  incompatible at the file level; S03 emits the new shape only, and
  any pre-S03 `.saivage/` state is invalidated and rebuilt by `init`.
- Card-tree builders (`src/agents/analyst-tools.ts` `buildNode`,
  `get_tree`, `get_card`): fixed in S03.
- Planner activation rules: planner treats user-visible child order
  as a soft hint per MASTER-PLAN §S03 goal; no planner logic change.
- UI rendering across cards tree, board lanes, detail-view child
  list, dashboard child panels, files tree, debug-view child lists,
  leaderboard, timeline, analyst chat context:
  - Cards tree, detail view, history panel: fixed in S03.
  - Board lanes, leaderboard, timeline: not child-ordering surfaces
    per MASTER-PLAN §4.1 matrix; no change.
  - Dashboard, files view, debug view: forecasted to S06.
  - Analyst chat context: forecasted to S08.

## Done-definition cross-reference to S00 V.1–V.11

S00's validation cookbook V.1–V.11 are the canonical close-out
checklist. S03's close-out runs them in this mapping:

- V.1 (baseline present): unchanged; S03 reads
  `PLAN/baseline-gates.json` without modifying it.
- V.2 (gates green or forecasted): four gates run via
  `PLAN/scripts/run-gates.sh --diff PLAN/baseline-gates.json`; the
  only allowed diff entries are the four H3 forecasts above.
- V.3 (autonomy anchors absent): S03's close-out runs the writer
  autonomy grep against this stage's `design.md` and `plan.md` using
  `PLAN/forbidden-anchors.txt`; zero hits required.
- V.4 (host-path guard): `grep -REn '/wo''rk/'
  drafts/003-ordered-children-and-bounded-move/` returns zero hits;
  every host-relative path is rooted at `saivage-v3/...`.
- V.5 (emoji absent): zero unicode emoji codepoints in either drafted
  file.
- V.6 (cumulative ledger format): the four H3 entries follow the
  shape declared in `PLAN/expected-breakage-ledger.md` `## Entry
  shape` (`### <failing-id>` + four named lines), with `Target fix
  stage` strictly in `{S04..S10}`.
- V.7 (ledger entry closure): the S03 close-out deletes the H3 block
  `### analyst-e2e:scenario-reorder-child:step-1` from
  `PLAN/expected-breakage-ledger.md` only if all three conditions hold
  at close-out time: (1) the cumulative ledger currently contains that
  exact H3, (2) its `Target fix stage` line reads `S03`, and (3) the
  fresh gate diff under `--diff PLAN/baseline-gates.json` no longer
  observes that failure. If any condition fails, S03 proceeds without
  closing the entry and does not fabricate it. The cumulative ledger
  may be empty when S03 starts.
- V.8 (stage dir name): the publish step uses the literal stage dir
  name `003-ordered-children-and-bounded-move` matching the protocol
  regex.
- V.9 (atomic publication): per PROTOCOL-r4, the directory rename
  from `drafts/` to `stages/` is the publication act; no in-place
  edits to a published stage.
- V.10 (singular baseline path): no per-stage baseline file is
  created; the only baseline is `PLAN/baseline-gates.json`.
- V.11 (immutability of predecessors): S03 reads S00, S01, S02 stage
  artifacts but never modifies them.
