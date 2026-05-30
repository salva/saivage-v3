# S03 — Cards: ordered children + bounded move (plan)

## Pre-conditions

- S00, S01, S02 are published under `SPEC/analyst-as-control-surface/PLAN/stages/`.
- `SPEC/analyst-as-control-surface/PLAN/baseline-gates.json` exists and matches the four-gate schema (`tsc-build`, `web-vite-build`, `web-vitest`, `analyst-e2e`).
- `SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md` exists with a `## Open entries` section. The section may be empty when S03 starts; S03 does not require any specific H3 to pre-exist. If the cumulative ledger happens to contain `### analyst-e2e:scenario-reorder-child:step-1` whose `Target fix stage` line reads `S03`, S03's Phase G close-out is allowed to remove it (conditional on the gate diff); otherwise S03 leaves the ledger untouched on that id.
- `SPEC/analyst-as-control-surface/PLAN/forbidden-anchors.txt` exists and contains the writer-autonomy anchor list.
- `SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh` exists and supports `--diff <baseline.json>`.
- Local working tree: `saivage-v3/.saivage/` is owned by `init`; S03 work runs against a clean tree or one reproducible via `init`.
- Node toolchain matches `saivage-v3/package.json` `engines.node` (`>=22.12.0`).

## Phase A — Prep and inventory

A.1 — Read `SPEC/analyst-as-control-surface/SPEC-r7.md` sections "Mutate cards — Child ordering within a parent", "Mutate cards — Bounded card move", "UI Behavior — ordered-child rendering", and "Acceptance Criteria — Cards"; copy the SPEC-aligned phrase for cross-tree refusal into a private note for use as the `message` field in `move_refused_cross_tree` responses.

A.2 — Confirm the S02 stubs are live in the working tree by reading `saivage-v3/src/agents/analyst-tools.ts` for `reorder_child` and `move_card` and `saivage-v3/src/agents/analyst-tool-schemas.ts` line 25 area; treat both as the starting point.

A.3 — Confirm `saivage-v3/src/agents/analyst-tool-runner.ts` exports `runAuditedAnalystTool` (added in S02) and note its signature for the call-site rewrites in Phase C.

A.4 — Inventory current readers of card children: `saivage-v3/src/cards/card-store.ts` line 279 (`listChildren`), `saivage-v3/src/cards/state.ts` lines 65–67 (`_childrenByParent`) and 95–96 (`childrenOf`), `saivage-v3/src/server/routes/operator-contracts.ts` line 119 (`cards.get`), `saivage-v3/src/agents/analyst-tools.ts` `get_card`/`get_tree`/`list_cards`. Record line numbers for the Phase F test plan.

A.5 — Inventory S03-owned frontend sort sites: `saivage-v3/web/src/components/cards/CardsTreeView.vue` lines 95–115 (`children.sort` + `sortedRoots`), `saivage-v3/web/src/components/cards/CardDetailView.vue` line 96 area (`currentChildren`), `saivage-v3/web/src/components/cards/CardHistoryPanel.vue` (any child-reference render), `saivage-v3/web/src/views/CardsView.vue` (tree prop pipeline).

A.6 — Confirm the draft dir `SPEC/analyst-as-control-surface/PLAN/drafts/003-ordered-children-and-bounded-move/` exists alongside this `plan.md`.

A.7 — Snapshot the current baseline by running `bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --diff SPEC/analyst-as-control-surface/PLAN/baseline-gates.json` from `saivage-v3/` and record the pre-S03 state in `tmp/s03-pre-baseline.txt` (host-side scratch only; not committed).

## Phase B — Schema and persistence

B.1 — Edit `saivage-v3/src/schemas/types.ts`, `CardRecord` (around lines 25–42): add required `position: number;` field after `parent: string | null; depth: number;`.

B.2 — Edit `saivage-v3/src/schemas/validators.ts` `cardRecordSchema` (around line 25): add `position: z.number().int().nonnegative()` as a required property; no `.optional()`, no default. Keep alphabetical position next to `depth`.

B.3 — Edit `saivage-v3/src/cards/state.ts` `CardStoreState` (lines 65–170): replace `_childrenByParent` insertion-order semantics with position-sorted semantics. `addChildEdge` inserts the id and re-sorts the parent's array by reading `this._cards.get(childId).position`. `removeChildEdge` removes and re-sorts. Document the invariant inline that the array is always position-sorted.

B.4 — Edit `saivage-v3/src/cards/state.ts` `childrenOf` (line 95–96): still returns a fresh copy of the position-sorted array. No callers change.

B.5 — Edit `saivage-v3/src/cards/state.ts` `descendantsOf` (lines 99–112): no logic change; the BFS now walks in position order because `childrenOf` is sorted.

B.6 — Add a new method `reorderChildren(parentId: string, orderedChildIds: string[]): { changed: string[]; nextPositions: Map<string, number> }` to `CardStoreState`. It validates set-equality between `orderedChildIds` and the current `childrenOf(parentId)`. On mismatch it throws a typed `ReorderSetMismatchError` carrying `missing` and `extra` arrays. On success it returns the set of ids whose `position` must change and the target `position` for each.

B.7 — Edit `saivage-v3/src/cards/state.ts` `loadCardStoreState` (lines ~360–438): after the depth-ordered upsert loop, assert per-parent that the set of `position` values equals `{0..N-1}`; on violation, throw `CardStoreInvariantError(`Parent '${parentId}' has non-contiguous child positions: [${positions.join(',')}]; recovery hint: 'saivage init'.`)`. No legacy-shape fallback.

B.8 — Edit `saivage-v3/src/cards/card-store.ts` `create()` (lines 376–448 area): after computing `depth`, compute `position`. For `parent === null` set `position = 0`. For `parent !== null` set `position = this.state.childrenOf(parent).length`. Include `position` in the constructed `CardRecord` literal so the schema parse on line ~430 succeeds.

B.9 — Edit `saivage-v3/src/cards/card-store.ts` `validateMutablePatch` (lines 595–625 area): remove the `changes.parent !== undefined` branch entirely. Add an explicit rejection at the top: `if (changes.parent !== undefined && changes.parent !== existing.parent) throw new Error("Field 'parent' cannot be changed via update/mutateCard; use moveCard().");`.

B.10 — Edit `saivage-v3/src/cards/card-store.ts`: add `moveCard(id: string, newParent: string, ctx: CardMutationContext): { ok: true; data: CardRecord } | { ok: false; reason: 'move_refused_root' | 'move_refused_cross_tree' | 'move_refused_self' | 'move_refused_descendant'; message: string; currentParent: string | null; attemptedParent: string }`. Internal flow: validate per `design.md` `## Approach > Bounded move` steps 1–5; on accept, compute the `(id, newPosition)` updates plus the old-parent hole-closing updates; issue one `applyMutationGroupSync` with one `persist` op per affected card. The moved card's `position` is `store.listChildren(newParent).length` (computed BEFORE the move). Each old-sibling whose `position > moved.position` gets `position - 1`.

B.11 — Edit `saivage-v3/src/cards/card-store.ts`: add `reorderChildren(parentId: string, orderedChildIds: string[], ctx: CardMutationContext): { ok: true; changed: number } | { ok: false; reason: 'reorder_set_mismatch'; missing: string[]; extra: string[] }`. On accept, call `state.reorderChildren` to compute the diff and issue one `applyMutationGroupSync` containing one `persist` op per id whose `position` actually changes. Skip no-op writes.

B.12 — Verify `saivage-v3/src/cards/apply-mutation.ts` `persist` op (lines ~50–80) accepts position-only field changes; no op-kind change required because `changedFields: ['position']` is a normal `mutate` history kind.

B.13 — Run `cd saivage-v3 && npx tsc --noEmit` and fix any type errors introduced by B.1–B.11. Expect cascade compile errors at every `CardRecord` literal in tests and seed fixtures; fix each by adding `position: <value>` per the parent's child list at construction time.

## Phase C — Backend tool surfaces

C.1 — Edit `saivage-v3/src/agents/analyst-tools.ts` `move_card` (around line 121): replace the existing body with a call into `runAuditedAnalystTool({ actor: 'analyst', surface: ctx.surface, action: 'card.move', target_kind: 'card', target_id: params.id, run: async () => { const r = store.moveCard(params.id, params.newParent, { actor: 'analyst', surface: ctx.surface, reason: 'analyst move_card' }); if (r.ok) return { success: true, data: r.data }; return { success: false, data: { reason: r.reason, message: r.message, current_parent: r.currentParent, attempted_parent: r.attemptedParent } }; } })`.

C.2 — Edit `saivage-v3/src/agents/analyst-tools.ts`: add `reorder_child(ctx, params: { parentId: string; orderedChildIds: string[] })` implementation. Body parallels C.1 but calls `store.reorderChildren(params.parentId, params.orderedChildIds, ...)` and returns either `{ success: true, data: { parent_id: params.parentId, changed: r.changed } }` or `{ success: false, data: { reason: 'reorder_set_mismatch', missing: r.missing, extra: r.extra, parent_id: params.parentId } }`. Audit-wrap with `action: 'card.reorder_child'`, `target_kind: 'card'`, `target_id: params.parentId`.

C.3 — Edit `saivage-v3/src/agents/analyst-tool-schemas.ts` line 25 area: rewrite the `move_card` schema entry. New parameter contract: `id: str('The ID of the card to move.')` and `newParent: str('The ID of the new parent card. Must be either a current sibling or the current grandparent; root moves are refused.')`. Required: `['id','newParent']`. Drop the `newParent: nullable` semantics.

C.4 — Edit `saivage-v3/src/agents/analyst-tool-schemas.ts`: replace the `reorder_child` S02 placeholder schema (the one returning `{success:false, data:{reason:'not_yet_available', stage_owner:'S03', parent_id: params.parentId}}`) with the real schema: `parentId: str('Parent whose children to reorder.')`, `orderedChildIds: { type: 'array', items: { type: 'string' }, description: 'New child id order; must be a permutation of the current child set.' }`. Required: `['parentId','orderedChildIds']`.

C.5 — Edit `saivage-v3/src/agents/analyst-llm-resolver.ts` (line 7 imports and the tool dispatch table around line 44): confirm `move_card` still maps to `move_card as unknown as ToolFn` and add `reorder_child: reorder_child as unknown as ToolFn` to the dispatch table. Add the corresponding import.

C.6 — Edit `saivage-v3/src/agents/analyst-handler.ts`: leave the file untouched. The deterministic-intent parsing path at line 166 onward (`parseIntent`) and the `move`-keyword shortcut at line 174 are S01-deleted constructs; treat them as absent per the user prompt scope.

C.7 — Edit `saivage-v3/src/tools/planner-tools.ts`: add a `moveCard(id, newParent, ctx)` service method that calls `CardStore.moveCard` and an audit emission step that records `recordControlAction({actor: 'planner', surface: 'runtime', action: 'card.move', target_kind: 'card', target_id: id})`. Returns the same response shape as the analyst path (typed `move_refused_*` reasons) so planner-control and analyst surfaces produce identical typed errors.

C.8 — Edit `saivage-v3/src/tools/planner-tools.ts`: add a `reorderChildren(parentId, orderedChildIds, ctx)` service method that calls `CardStore.reorderChildren` and audit-emits with `actor: 'planner'`, `surface: 'runtime'`, `action: 'card.reorder_child'`, `target_kind: 'card'`, `target_id: parentId`.

C.8a — Edit `saivage-v3/src/agents/agent-adapter.ts` around lines 69-103 (the `PLANNER_TOOL_DEFINITIONS` array): append two new `tool(...)` entries following the existing pattern (`tool(name, description, paramsObject, requiredArray)`):
- `tool('move_card', 'Move a card to a current sibling or to the current grandparent. Root moves and cross-tree moves are refused.', { id: str('The ID of the card to move.'), newParent: str('The ID of the new parent card. Must be either a current sibling or the current grandparent.') }, ['id', 'newParent'])`.
- `tool('reorder_child', 'Reorder the children of a parent card. orderedChildIds must be a permutation of the current child set.', { parentId: str('The parent whose children to reorder.'), orderedChildIds: arr(str('A child card ID in the new order.'), 'New child id order; must be a permutation of the current child set.') }, ['parentId', 'orderedChildIds'])`.
Both entries are appended before the trailing `.filter(...)` de-dup line so the de-dup pass continues to enforce uniqueness across the merged list.

C.8b — Edit `saivage-v3/src/agents/agent-adapter.ts` around lines 80-90 (the `PLANNER_CONTROL_TOOL_NAMES` Set literal): add `'move_card'` and `'reorder_child'` so the planner-control dispatcher treats them as control-surface tools rather than read-only or workspace tools.

C.8c — Edit `saivage-v3/src/agents/planner-control-executor.ts` around lines 131-139 (the `execute()` switch statement, after the `case 'restart_card':` arm and before the `report_goal_*` arms): add two new dispatch arms:
- `case 'move_card': { const r = plannerTools.moveCard(String(args.id ?? ''), String(args.newParent ?? ''), { actor: 'planner', surface: 'runtime', toolCallId: invocation.toolCallId, sessionId: invocation.sessionId }); result = r; break; }`.
- `case 'reorder_child': { const r = plannerTools.reorderChildren(String(args.parentId ?? ''), Array.isArray(args.orderedChildIds) ? args.orderedChildIds.map((v) => String(v)) : [], { actor: 'planner', surface: 'runtime', toolCallId: invocation.toolCallId, sessionId: invocation.sessionId }); result = r; break; }`.
The `surface: 'runtime'` literal is set at this dispatch site (matching the existing executor pattern), so the recorded `ControlActionAuditEntry` for both tools carries the correct surface in the persisted audit log.

C.8d — Verify the wiring end-to-end by reading the patched `saivage-v3/src/agents/agent-adapter.ts` and `saivage-v3/src/agents/planner-control-executor.ts`: confirm both tool names appear in `PLANNER_TOOL_DEFINITIONS`, in `PLANNER_CONTROL_TOOL_NAMES`, and in the executor `switch`; confirm the executor branches reach `recordControlAction({surface: 'runtime'})` via the new service methods from C.7 and C.8.

C.9 — Edit `saivage-v3/src/agents/role-tool-policy.ts` if needed: grant `planner` role access to `move_card` and `reorder_child`, matching the existing `analyst` grants.

C.10 — Edit `saivage-v3/src/server/routes/operator-contracts.ts` line 119 (`cards.get`): no code change required because the `children` array is built from `store.listChildren(id)` which is now position-sorted. Add a comment line: `// children are emitted in persisted position order (S03).` to the inline body so the contract is self-documenting.

C.11 — Audit every projection in `saivage-v3/src/projections/`: open `index.ts` and `ledger-projections.ts`, search for any code that materialises a card's children, and if found apply the same comment-and-verify pattern as C.10. (Current inventory finds none, but the audit step is required by MASTER-PLAN §S03 acceptance.)

C.12 — Run `cd saivage-v3 && npx tsc --noEmit`; iterate until clean.

## Phase D — Frontend (S03-owned views)

D.1 — Edit `saivage-v3/web/src/components/cards/CardsTreeView.vue` lines 95–115: delete the `children.sort((a, b) => { if (a.priority !== b.priority) return b.priority - a.priority; return a.title.localeCompare(b.title); });` block. The `childrenMap` accumulator now preserves the order in which children appear in `props.cards`, which the parent passes in backend `position` order.

D.2 — Edit `saivage-v3/web/src/components/cards/CardsTreeView.vue` lines ~125: delete the `sortedRoots` sort. Roots are a single project card, so the local sort was dead; remove it for clarity.

D.3 — Edit `saivage-v3/web/src/views/CardsView.vue`: confirm `props.cards` is sourced from the backend tree payload (operator `cards.get` or analyst `get_tree`) and is passed to `CardsTreeView` without any client-side reorder. If a local sort step exists, delete it.

D.3a — Read `saivage-v3/web/src/stores/cards.ts` lines ~130-160 and confirm the `filteredCards` computed (around lines 136-154) applies `sortCards` (priority desc, then `updated_at` desc) and that `cardTree = computed(() => buildTree(filteredCards.value))` (around line 156) consumes that sorted output. These are the upstream cause of the tree losing backend-position order before any component renders.

D.3b — Edit `saivage-v3/web/src/stores/cards.ts`: immediately after the `filteredCards` computed, add `const orderedFilteredCards = computed<CardRecord[]>(() => { ... })` that applies the same `filterStatus` / `filterType` / `filterTag` / `searchQuery` / `filterParent` predicates against `cards.value` but does NOT call `sortCards`; it returns the filtered slice in `cards.value` order. Immediately after the existing `cardTree` computed, add `const orderedCardTree = computed<CardRecord[]>(() => buildTree(orderedFilteredCards.value))`. Add both `orderedFilteredCards` and `orderedCardTree` to the store's return object so views can destructure them via `storeToRefs`. Do NOT change `filteredCards`, `cardTree`, or `board`; those remain for the board / leaderboard / timeline flat-list views that intentionally sort by priority.

D.3c — Edit `saivage-v3/web/src/views/CardsView.vue` around lines 70-73 (the `<CardsTreeView .../>` invocation): change the props to `:cards="orderedFilteredCards"` and `:tree="orderedCardTree"`. Update the `useCardStore()` / `storeToRefs(...)` destructure (or computed wrappers) earlier in the `<script setup>` block to expose `orderedFilteredCards` and `orderedCardTree`. The `CardsBoardView`, `CardsLeaderboardView`, and `CardsTimelineView` invocations continue to bind to `filteredCards` / `board` unchanged.

D.3d — Add new vitest `saivage-v3/web/src/__tests__/cards-store-ordered-tree.test.ts`: using the same Pinia setup as `card-store.test.ts`, seed `cardStore.cards.value` with a project root and three children whose backend-insertion order disagrees with priority/title sort (e.g., the array's first child has lowest priority, the last has highest). Assert `cardStore.orderedCardTree.value[0].children.map(c => c.id)` equals the seeded backend insertion order, and assert it does NOT equal the priority-sorted order. Also assert `cardStore.cardTree.value[0].children.map(c => c.id)` matches the priority-sorted order, to lock in that the legacy sorted pipeline is left intact for non-tree views.

D.3e — Re-read `design.md` `## Expected breakage forecast`. The four H3 forecasts target `DashboardView`, `FilesView`, `DebugView`, and `AnalystChatPanel`, none of which consume `cardStore.cardTree` or `cardStore.orderedCardTree` (the dashboard reads `cardStore.cards` directly and applies its own panel-local sort; files/debug views and the analyst chat panel each have their own client-side sort outside the cards store). The new `orderedCardTree` therefore does NOT satisfy any of the four existing forecasts. The forecast count remains 4; do NOT drop any forecast in this stage.

D.4 — Edit `saivage-v3/web/src/components/cards/CardDetailView.vue` (line 96 area `currentChildren`): replace any local sort over `card.children` with a direct render of the backend-provided array.

D.5 — Edit `saivage-v3/web/src/components/cards/CardHistoryPanel.vue`: find any child-of-card rendering inside a history entry and bind it directly to the backend-supplied order.

D.6 — Save all Vue SFC buffers via the VS Code `workbench.action.files.saveAll` command before any frontend build (per user memory `vue-sfc-corruption.md`).

D.7 — Verify each touched `.vue` file contains exactly one `<script setup>` block: `for f in web/src/components/cards/*.vue web/src/views/CardsView.vue; do echo "$(grep -c '<script setup' "$f") $f"; done` from `saivage-v3/`; all counts must equal `1`.

## Phase E — Tests

E.1 — Add new file `saivage-v3/tests/utils/card-reorder-and-move.test.ts`: cover the unit cases from `design.md` `## Test plan > Unit` (append-on-create, reorder set-mismatch, reorder no-op write skip, move sibling-descent, move grandparent-ascent, move cross-tree refusal, move root refusal, move self/descendant refusal, `update()` refusal of `parent`).

E.2 — Extend `saivage-v3/tests/utils/card-store.test.ts`: add a case asserting that `version_seq` of an unchanged sibling remains stable after a `reorderChildren` call that leaves its position fixed.

E.3 — Add a new file `saivage-v3/tests/integration/cards-shuffled-subtree.test.ts`: build a 3-level subtree, shuffle persisted `position` values on disk via `writeFileAtomic`, reload the store, then assert `store.listChildren`, the operator `cards.get` route handler, `get_card`, and `get_tree` all return the shuffled order.

E.4 — Extend `saivage-v3/tests/analyst.test.ts`: assert that invoking `move_card` and `reorder_child` from the analyst surface appends a `ControlActionAuditEntry` (via `recordControlAction`) with `actor='analyst'` and the calling `surface`.

E.5 — Add new vitest files under `saivage-v3/web/src/__tests__/` (the existing web/vitest convention, alongside `tool-presenters.test.ts`, `raw-llm-exchange-panel.test.ts`, etc.) for each of `CardsTreeView.vue`, `CardDetailView.vue`, `CardHistoryPanel.vue`. Each test mounts the component with a shuffled fixture and asserts the DOM order matches the input order without resorting. Do NOT place these tests under the backend `saivage-v3/tests/utils/` tree.

E.6 — Update the e2e checker referenced by `analyst-e2e:scenario-reorder-child:step-1` to assert the post-call backend order matches the supplied `orderedChildIds`. The S02 forecast entry will be removed in Phase H once this turns green.

E.7 — Run the focused subset: `cd saivage-v3 && npm test -- card-reorder-and-move card-store cards-shuffled-subtree analyst`; iterate until green.

## Phase F — Gate runs

F.1 — Run `cd saivage-v3 && bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --diff SPEC/analyst-as-control-surface/PLAN/baseline-gates.json` and capture stdout.

F.2 — Triage every diff entry against MASTER-PLAN §6.2 (Breakage triage). Allowed diffs at the end of S03: zero net new failures except the four entries forecasted under `design.md` `## Expected breakage forecast`; the S02-recorded `analyst-e2e:scenario-reorder-child:step-1` must transition from FAILING to PASSING.

F.3 — If F.2 surfaces an unexpected new failure, return to Phase B / C / D / E and fix before proceeding. Do not extend the forecast list to launder a regression.

## Phase G — Ledger updates

G.1 — Conditional close-out of the S02-targeted entry in `SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`. Apply the close-out only if all three conditions hold at S03 close-out time:
  1. The cumulative ledger currently contains an H3 with the exact text `### analyst-e2e:scenario-reorder-child:step-1`.
  2. That H3's `Target fix stage` line reads exactly `Target fix stage: S03`.
  3. The fresh gate diff (`bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --diff SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`, run from `saivage-v3/`) no longer observes the `analyst-e2e:scenario-reorder-child:step-1` failure.
If all three hold, delete the entire H3 block (the `### ...` heading plus its four named lines `Failure mode`, `Reason acceptable now`, `Target fix stage`, `Recorded by`) and no other lines. If any condition fails, S03 proceeds without closing the entry and does NOT fabricate, rewrite, or insert it. The cumulative ledger may be empty at S03 start.

G.2 — Edit `SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md`: append the four H3 entries from `design.md` `## Expected breakage forecast` verbatim under `## Open entries`. Each block must contain exactly four content lines after the `### <failing-id>` heading, each label on a single physical line (no wrapped continuations): `Failure mode: ...`, `Reason acceptable now: ...`, `Target fix stage: S06` (or `S08` for the analyst-chat entry), `Recorded by: S03 / <actual-close-date>`. The `<YYYY-MM-DD>` placeholder in `design.md` is replaced with the actual S03 close-out date (the date Phase H runs) at append time; it is NOT pre-populated in `design.md`.

G.3 — Verify the ledger still parses by visual inspection: every `### <failing-id>` is followed by exactly four single-line entries in the canonical order (`Failure mode`, `Reason acceptable now`, `Target fix stage`, `Recorded by`); no orphan headings; `Target fix stage` values for the four newly appended entries are all in `{S04..S10}`; and (if G.1 ran) the S02-recorded entry whose `Target fix stage` was `S03` is no longer present.

## Phase H — Close-out

H.1 — Writer autonomy grep: from `saivage-v3/`, run `grep -REn -i -f SPEC/analyst-as-control-surface/PLAN/forbidden-anchors.txt SPEC/analyst-as-control-surface/PLAN/drafts/003-ordered-children-and-bounded-move/`. Required: zero hits.

H.2 — Host-path guard: from `saivage-v3/`, run `grep -REn '/wo''rk/' SPEC/analyst-as-control-surface/PLAN/drafts/003-ordered-children-and-bounded-move/`. Required: zero hits. Every host-relative path in both drafted files is rooted at `saivage-v3/...`.

H.3 — Emoji absence: from `saivage-v3/`, run `grep -RnP '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' SPEC/analyst-as-control-surface/PLAN/drafts/003-ordered-children-and-bounded-move/`. Required: zero hits. (GNU grep treats `-E` and `-P` as conflicting matchers, so `-E` must NOT be combined with `-P`.)

H.4 — Re-run the gate driver one final time: `cd saivage-v3 && bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --diff SPEC/analyst-as-control-surface/PLAN/baseline-gates.json`. Confirm the only diff entries are the four S06 / S08 forecasts and the S02-closer that just turned green; nothing else.

H.5 — Stage-publication handoff: leave both drafted files in `SPEC/analyst-as-control-surface/PLAN/drafts/003-ordered-children-and-bounded-move/`. Per PROTOCOL-r4, publication is the atomic directory rename from `drafts/` to `stages/`; that rename is the publisher's act, not the writer's. The writer's deliverable is the validated draft pair.

H.6 — Operator-facing summary in the writer's final report: two file paths, total substep count, the four forecast entries (one-line each as `<failing-id> -> <target stage>`), the autonomy grep exit status, and any open questions left for the reviewer.
