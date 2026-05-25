# Stage 003 Phase A inventory — ordered children + bounded move

Date: 2026-05-25
Task: `t1-phase-a-inventory`
Stage: `003-ordered-children-and-bounded-move`

## Executive summary

Phase A inventory was performed against the published immutable Stage 003 plan/design and current working tree. Key implementation starting points are confirmed:

- `move_card` is live but currently open-ended: it accepts `newParent: string | null` and delegates to `store.mutateCard(... { parent: params.newParent })` rather than a bounded `CardStore.moveCard`.
- `reorder_child` is still the S02 placeholder returning `{ reason: 'not_yet_available', stage_owner: 'S03' }`.
- `runAuditedAnalystTool` exists and records `actor`, `surface`, `action`, `target_kind`, `target_id`, authz outcome, and mutation result.
- Backend child readers currently flow through insertion-order `_childrenByParent` / `childrenOf` and must become position-ordered in Phase B/C.
- S03-owned frontend tree pipeline currently loses backend order in two places: upstream `filteredCards.sort(sortCards)` before `cardTree` construction, and local sorting in `CardsTreeView.vue`.
- The required pre-S03 gate snapshot was run and saved to `tmp/s03-pre-baseline.txt` (scratch, not committed). It exited 0 with no `NEW` diffs and two `web-vitest` `REPAIRED` entries.
- Blocking issue: `SPEC/analyst-as-control-surface/PLAN/drafts/003-ordered-children-and-bounded-move/` is missing. The drafts directory exists, but only a `003-ordered-children-and-bounded-move.REVIEW.md` file is present for S03, not the required draft directory.

## A.1 SPEC phrase for cross-tree refusal

Source: `SPEC/analyst-as-control-surface/SPEC-r7.md`, section `Mutate cards — Bounded card move`.

SPEC-aligned phrase to use in `move_refused_cross_tree` responses:

> Cross-tree moves — moving a card under an unrelated card that is not a current sibling and not the current grandparent — are not supported, and the Analyst refuses such requests with a clear explanation of the parent-child-axis restriction.

Short implementation-friendly message preserving the SPEC wording:

> Cross-tree moves are not supported; moves are restricted to the parent-child axis: into a current sibling, or out to the current grandparent.

Related normative details:

- Move down: card X can move into a current sibling S.
- Move up: card X can move out to the current grandparent, becoming a sibling of its parent.
- Root cards cannot be moved out.

## A.2 S02 stubs and starting analyst tool state

### `src/agents/analyst-tools.ts`

Observed via `tmp/s03-phase-a-targeted-analyst-grep.txt`:

- Line 22 imports `runAuditedAnalystTool`.
- Line 104 defines `move_card(ctx, params: { id: string; newParent: string | null })`.
  - Current behavior: audit-wrapped with `action: 'card.move'`, `safety_class: 'high'`.
  - It performs local self/descendant checks, then calls `store.mutateCard(params.id, { parent: params.newParent }, ...)`.
  - This is the open-ended parent mutation path Stage 003 must replace.
- Line 133 defines `reorder_child(_ctx, params: { parentId: string; orderedChildIds: string[] })`.
  - Current behavior: returns `{ success: false, data: { reason: 'not_yet_available', stage_owner: 'S03', parent_id: params.parentId } }`.
  - This is the S02 stub Stage 003 must replace.

### `src/agents/analyst-tool-schemas.ts`

Observed via `tmp/s03-phase-a-targeted-analyst-grep.txt`:

- Line 25: `move_card` schema is still `Re-parent a card in the tree` and describes `newParent` as allowing `null` to move to root level.
- Line 46: `reorder_child` schema is present but explicitly says S03 owns ordered children and S02 reports not-yet-available.

### `src/agents/analyst-llm-resolver.ts`

Observed via grep:

- Line 48 maps `move_card` into the tool dispatch table.
- Line 77 already maps `reorder_child` into the tool dispatch table.

## A.3 Audited analyst tool runner signature

Source: `src/agents/analyst-tool-runner.ts`, lines 36–62.

```ts
export interface MutatingSpec<P> {
  action: string;
  safety_class: SafetyClass;
  target_kind: 'card' | 'note' | 'process' | 'runtime' | 'config' | 'session' | null;
  getTargetId: (params: P) => string | null;
  preview?: (ctx: ToolContext, params: P) => ActionPreview | null;
  run: (ctx: ToolContext, params: P) => Promise<ToolResult>;
}

export async function runAuditedAnalystTool<P extends Record<string, unknown>>(
  ctx: ToolContext,
  params: P,
  spec: MutatingSpec<P>,
): Promise<ToolResult>
```

Important behavior for Phase C rewrites:

- Authz input uses `ctx.actor`, `ctx.surface`, and `spec.safety_class`.
- Audit base records `actor`, `surface`, `action`, `target_kind`, `target_id`, `confirmed`, and `params_summary`.
- On success it records `outcome: 'ok'`, `outcome_summary: 'mutation applied'`.
- On failure it records `outcome: 'error'` and `error`.

## A.4 Backend child reader inventory

### `src/cards/state.ts`

Observed in `tmp/s03-phase-a-card-store.txt`:

- Lines 64–67: `CardStoreState` has `_cards`, `_childrenByParent`, `_blocksInverse`, `_depthCache`.
- Lines 95–96: `childrenOf(parentId)` returns a copy of `_childrenByParent.get(parentId) ?? []`.
- Lines 99–112: `descendantsOf(parentId)` walks `childrenOf` order.
- Lines 154–159: `addChildEdge` pushes child ids into `_childrenByParent` without position sorting.
- Lines 161–167: `removeChildEdge` filters child ids without position sorting.

### `src/cards/card-store.ts`

Observed in `tmp/s03-phase-a-card-store.txt`:

- Lines 274–276: `list()` returns `this.state.list()` after refresh; currently map insertion order, not child-position order.
- Lines 279–281: `listChildren(parentId)` returns `this.state.childrenOf(parentId)` after refresh.
- Lines 298–300: `getDescendantIds(id)` returns `this.state.descendantsOf(id)`.
- Lines 402–438: `create()` constructs `CardRecord` without `position`.
- Lines 604–628: `validateMutablePatch` currently allows parent changes and computes new depth; Stage 003 must replace this with refusal for `parent` changes through update/mutate paths.

### `src/server/routes/operator-contracts.ts`

Observed in `tmp/s03-phase-a-backend-readers.txt`:

- Line 118: `cards.list` returns `store.list().map(...)`.
- Line 119: `cards.get` builds `children` by `store.listChildren(id).map((childId) => store.read(childId))...`.

### `src/agents/analyst-tools.ts`

Relevant current reader functions from the line-numbered output:

- `get_card` is in the inspect section and should be audited in Phase C for child order if it materializes children.
- `get_tree` uses the analyst tree builder path and must rely on backend order after `childrenOf` changes.
- `list_cards` supports parent-scoped listing and must preserve backend order when listing a parent’s children.

### `src/projections/`

Grep command:

```sh
grep -RIn "children\|child\|listChildren\|childrenOf" src/projections || true
```

Result: no matches. Current inventory found no projection that materializes card child collections.

## A.5 S03-owned frontend sort-site inventory

### `web/src/components/cards/CardsTreeView.vue`

Observed in `tmp/s03-phase-a-targeted-frontend-grep.txt`:

- Line 108: `children.sort((a, b) => ...)` local child sort exists.
- Line 126: `sortedRoots = [...props.tree].sort(...)` root sort exists.
- Line 130: traversal walks `sortedRoots`.

Phase D must delete both sorts so tree rendering preserves incoming backend order.

### `web/src/stores/cards.ts`

Observed lines 136–154:

- Lines 136–150: `filteredCards` applies status/type/tag/search/parent filters.
- Line 151: `filteredCards` returns `[...result].sort(sortCards)`.
- Line 154: `cardTree = computed(() => buildTree(filteredCards.value))`.

This upstream sort means deleting only component-local sorts is insufficient. Phase D must add `orderedFilteredCards` and `orderedCardTree` as specified by the design.

### `web/src/views/CardsView.vue`

Observed lines 70–73 and 219–227:

- The `<CardsTreeView>` invocation currently binds `:cards="filteredCards"` and `:tree="cardTree"`.
- `storeToRefs` currently destructures `cardTree` and `filteredCards`.

Phase D must switch only the tree view props to ordered computed values, leaving board/leaderboard/timeline bindings on the existing sorted pipeline.

### `web/src/components/cards/CardDetailView.vue`

Observed lines 96–97 and 286–289:

- Template renders `v-for="child in currentChildren"`.
- Script uses `currentChildren` from the cards Pinia store.
- No local sort was found in `CardDetailView.vue` itself; backend/store order is the effective order.

### `web/src/components/cards/CardHistoryPanel.vue`

Grep for `child`, `children`, `snapshot`, and `parent` found:

- Line 78 renders `cardHistoryEntry.snapshot` through `CodeBlock`.
- No child-reference list or local child sort was found in the current file.

## A.6 Draft directory confirmation

Required path checked:

`SPEC/analyst-as-control-surface/PLAN/drafts/003-ordered-children-and-bounded-move/`

Result: **missing**.

`SPEC/analyst-as-control-surface/PLAN/drafts/` exists and contains `003-ordered-children-and-bounded-move.REVIEW.md`, but not the required stage draft directory. This conflicts with Phase A.6 of the published plan.

## A.7 Pre-S03 baseline snapshot

Command run from `/work/saivage-v3`:

```sh
bash SPEC/analyst-as-control-surface/PLAN/scripts/run-gates.sh --diff SPEC/analyst-as-control-surface/PLAN/baseline-gates.json > tmp/s03-pre-baseline.txt 2>&1
```

Wrapper status: `run-gates exit status: 0`.

Diff summary from `tmp/s03-pre-baseline.txt` tail:

```text
## tsc-build
NEW
REPAIRED
## web-vite-build
NEW
REPAIRED
## web-vitest
NEW
REPAIRED
web-vitest:saivage-v3/web/src/__tests__/api-client-contracts.test.ts::web API contract parser boundary parses migrated runtime responses and rejects malformed JSON payloads
web-vitest:saivage-v3/web/src/__tests__/runtime-store.test.ts::useRuntimeStore setupWsListener — WebSocket events handles runtime-state event and updates runtime + cardIndex
## analyst-e2e
NEW
REPAIRED
```

Interpretation:

- No `NEW` gate diffs were observed.
- Two previously recorded `web-vitest` failures are now `REPAIRED` at the pre-S03 snapshot.
- The scratch file is intentionally under `tmp/` and not committed.

## Actionable notes for coder tasks

1. Use the SPEC phrase above for `move_refused_cross_tree.message`.
2. Replace analyst `move_card` line 104 path; do not continue using `mutateCard(... parent ...)`.
3. Replace analyst `reorder_child` line 133 placeholder.
4. Update `analyst-tool-schemas.ts` line 25 so `newParent` is string-only and root/null move language is removed.
5. Backend child ordering should be fixed centrally in `CardStoreState.childrenOf` semantics so `CardStore.listChildren`, descendants, `cards.get`, and analyst tree readers inherit persisted order.
6. Frontend tree order requires both store-level ordered computeds and component-local sort removal.
7. Treat the missing draft directory as a stage-spec/environment issue before close-out tasks that grep the draft directory.
